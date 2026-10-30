import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, limit, requireIdentity } from './auth';
import { resumeWorker, type Serving } from './budget-pause';
import {
  METERS,
  notEstimated,
  type Daily,
  type MeterCost,
  type Missing,
} from './budget-usage';
import {
  budgetOf,
  checkAccount,
  dollars,
  emptyCheck,
  journal,
  levelFor,
  pauseNow,
  pausedFields,
  previousCheck,
  sameWorker,
  saveCheck,
  type Target,
} from './budgets';
import { notify } from './notifications';
import { AppError, now, type AppEnv, type Env } from './types';

// The budget guard's routes (the guard is worker/budgets.ts): a project's budget and the
// guard's last reading, a reading now, and an owner's pause and resume.
export const budgets = new Hono<AppEnv>();

async function projectOf(c: Context<AppEnv>, workspaceId: string) {
  const row = await c.env.DB.prepare(
    "SELECT p.id, j.account_id, j.worker_name, j.worker_tag, j.adapter FROM projects p LEFT JOIN deployment_jobs j ON j.project_id=p.id AND j.environment='production' AND j.worker_tag IS NOT NULL WHERE p.id=? AND p.workspace_id=? ORDER BY j.created_at DESC LIMIT 1",
  )
    .bind(c.req.param('id'), workspaceId)
    .first<{
      id: string;
      account_id: string | null;
      worker_name: string | null;
      worker_tag: string | null;
      adapter: string | null;
    }>();
  if (!row) throw new AppError(404, 'Project not found.');
  const target: Target | null =
    row.account_id && row.worker_name && row.worker_tag
      ? {
          projectId: row.id,
          workspaceId,
          accountId: row.account_id,
          workerName: row.worker_name,
          workerTag: row.worker_tag,
          containers: row.adapter === 'container',
        }
      : null;
  return { id: row.id, target };
}

async function view(
  env: Env,
  workspaceId: string,
  projectId: string,
  target: Target | null,
) {
  const [budget, check, plan, webhook] = await Promise.all([
    budgetOf(env, projectId),
    previousCheck(env, projectId),
    target
      ? env.DB.prepare(
          'SELECT plan, source, detail, checked_at AS checkedAt FROM account_plans WHERE workspace_id=? AND account_id=?',
        )
          .bind(workspaceId, target.accountId)
          .first()
      : null,
    env.DB.prepare('SELECT 1 FROM project_webhooks WHERE project_id=?')
      .bind(projectId)
      .first(),
  ]);
  return {
    budget,
    deployed: Boolean(target),
    webhook: Boolean(webhook),
    plan,
    notEstimated,
    labels: Object.fromEntries(
      Object.entries(METERS).map(([meter, m]) => [meter, m.label]),
    ),
    // What each meter's chart is drawn against: Workers Paid's monthly allowance, and
    // Workers Free's daily limit (null where the free plan has none).
    limits: Object.fromEntries(
      Object.entries(METERS).map(([meter, m]) => [
        meter,
        { included: m.included, freeDaily: m.freeDaily },
      ]),
    ),
    check: check && {
      month: check.month,
      plan: check.plan,
      estimateCents: check.estimate_cents,
      projectedCents: check.projected_cents,
      accountCents: check.account_cents,
      meters: JSON.parse(check.meters_json) as MeterCost[],
      missing: JSON.parse(check.missing_json) as Missing[],
      daily: JSON.parse(check.daily_json) as Partial<Daily>,
      level: check.level,
      state: check.state,
      pausedAt: check.paused_at,
      checkedAt: check.checked_at,
      readAt: check.read_at,
      error: check.error,
    },
  };
}

// A billing decision: a workspace owner's. API tokens can't make it (worker/tokens.ts), so an
// agent can't raise a budget or resume an app to get past the guard.
const owner = (c: Context<AppEnv>) => requireIdentity(c, 'owner');
const confirmation = z
  .object({ requestId: z.string().uuid(), confirm: z.literal(true) })
  .strict();

budgets.get('/projects/:id/budget', async (c) => {
  const who = requireIdentity(c);
  const p = await projectOf(c, who.workspaceId);
  return c.json(await view(c.env, who.workspaceId, p.id, p.target));
});

budgets.put('/projects/:id/budget', async (c) => {
  const who = owner(c);
  const input = z
    .object({
      monthlyCents: z.number().int().min(0).max(10_000_000),
      onExceed: z.enum(['alert', 'pause']),
    })
    .strict()
    .parse(await c.req.json());
  const p = await projectOf(c, who.workspaceId);
  const last = await previousCheck(c.env, p.id);
  const level = last ? levelFor(last.estimate_cents, input.monthlyCents) : 0;
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO project_budgets(project_id,workspace_id,monthly_cents,on_exceed,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET monthly_cents=excluded.monthly_cents, on_exceed=excluded.on_exceed, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
    ).bind(
      p.id,
      who.workspaceId,
      input.monthlyCents,
      input.onExceed,
      who.userId,
      now(),
    ),
    // Alerts start again from where the estimate stands against the new budget.
    c.env.DB.prepare(
      "UPDATE budget_checks SET level=?, state=CASE WHEN state='paused' THEN 'paused' ELSE ? END, projected_alerted_at=NULL WHERE project_id=?",
    ).bind(level, level === 100 ? 'over' : 'ok', p.id),
  ]);
  return c.json(await view(c.env, who.workspaceId, p.id, p.target));
});

// A reading now, instead of at the next scheduled one.
budgets.post('/projects/:id/budget/check', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const p = await projectOf(c, who.workspaceId);
  if (!p.target)
    throw new AppError(
      409,
      'This project has nothing deployed yet, so there is no usage to check.',
    );
  await limit(c.env, `budget-check:${who.workspaceId}`, 3);
  await checkAccount(c.env, who.workspaceId, p.target.accountId, [p.target]);
  return c.json(await view(c.env, who.workspaceId, p.id, p.target));
});

// Connected and deployed: the token an owner's pause or resume acts with.
async function access(c: Context<AppEnv>, workspaceId: string) {
  const p = await projectOf(c, workspaceId);
  if (!p.target)
    throw new AppError(409, 'This project has nothing deployed to pause.');
  const grant = await activeGrant(c.env, workspaceId, 'cloudflare');
  if (!grant || grant.account_id !== p.target.accountId)
    throw new AppError(
      409,
      'Reconnect the Cloudflare account that owns this project.',
    );
  return { target: p.target, token: await grantToken(c.env, grant) };
}

// An owner's emergency stop, whatever the estimate says.
budgets.post('/projects/:id/budget/pause', async (c) => {
  const who = owner(c);
  const input = confirmation.parse(await c.req.json());
  const { target, token } = await access(c, who.workspaceId);
  const before =
    (await previousCheck(c.env, target.projectId)) ?? emptyCheck(target);
  if (before.state === 'paused')
    throw new AppError(409, 'This project is already paused.');
  await saveCheck(
    c.env,
    await pauseNow(c.env, target, token, before, {
      userId: who.userId,
      requestKey: input.requestId,
    }),
  );
  await notify(c.env, {
    workspaceId: who.workspaceId,
    projectId: target.projectId,
    event: 'budget.paused',
    text: (name) => `${name} was paused by ${who.login}.`,
    data: {},
  });
  return c.json(await view(c.env, who.workspaceId, target.projectId, target));
});

budgets.post('/projects/:id/budget/resume', async (c) => {
  const who = owner(c);
  const input = confirmation.parse(await c.req.json());
  const { target, token } = await access(c, who.workspaceId);
  const check = await previousCheck(c.env, target.projectId);
  if (!check || check.state !== 'paused')
    throw new AppError(409, 'This project isn’t paused.');
  const budget = await budgetOf(c.env, target.projectId);
  const over = levelFor(check.estimate_cents, budget.monthlyCents) === 100;
  if (over && budget.onExceed === 'pause')
    throw new AppError(
      409,
      `This month’s estimate (${dollars(check.estimate_cents)}) is over the budget (${dollars(budget.monthlyCents)}), so the guard would pause it again. Raise the budget or switch it to alerts only, then resume.`,
    );
  await sameWorker(token, target);
  await journal(
    c.env,
    target,
    { userId: who.userId, requestKey: input.requestId },
    'budget.resume',
    () =>
      resumeWorker(token, target, {
        from: JSON.parse(check.paused_from_json ?? '[]') as Serving,
        schedules: JSON.parse(check.paused_schedules_json ?? '[]') as {
          cron: string;
        }[],
      }),
  );
  await saveCheck(c.env, {
    ...check,
    state: over ? 'over' : 'ok',
    ...pausedFields(null),
  });
  await notify(c.env, {
    workspaceId: who.workspaceId,
    projectId: target.projectId,
    event: 'budget.resumed',
    text: (name) => `${name} was resumed by ${who.login}.`,
    data: {},
  });
  return c.json(await view(c.env, who.workspaceId, target.projectId, target));
});
