import { z } from 'zod';
import { activeGrant, grantToken, type Grant } from './auth';
import {
  pauseWorker,
  servingVersions,
  type Paused,
  type Serving,
} from './budget-pause';
import {
  METERS,
  dailySeries,
  detectPlan,
  estimate,
  monthDays,
  readUsage,
  type Daily,
  type Meter,
  type MeterCost,
  type Missing,
} from './budget-usage';
import { notify } from './notifications';
import { cloudflare, cloudflarePage } from './providers';
import { AppError, now, type Env } from './types';

// The budget guard. Cloudflare bills Workers Paid usage with no cap, so a bug (a Durable
// Object alarm that keeps setting itself again, say) can run up thousands of dollars in a
// day. Every few minutes Shipcel estimates what each deployed project costs this month
// beyond what Cloudflare includes (worker/budget-usage.ts), compares it with the project's
// budget ($0 unless an owner sets one), and alerts at 50, 80 and 100% and when the rate
// since the last reading would take it over by the end of the month. If an owner chose it,
// the guard also pauses the app (worker/budget-pause.ts) until an owner resumes it. Its
// routes are in worker/budget-routes.ts.

const CHECK_EVERY = 300;
const BATCH = 25;
const PLAN_CHECK_EVERY = 86400;
const PROJECTED_ALERT_EVERY = 6 * 3600;
// A guard that can't read a project's usage says so, at most once a day.
export const UNREADABLE_ALERT_AFTER = 3600;
const UNREADABLE_ALERT_EVERY = 86400;
// Who the guard's own pauses are journaled as.
const GUARD_USER = 'budget-guard';

type Plan = 'free' | 'paid' | 'unknown';
export type Budget = { monthlyCents: number; onExceed: 'alert' | 'pause' };
export type CheckRow = {
  project_id: string;
  workspace_id: string;
  account_id: string;
  worker_name: string;
  month: string;
  plan: Plan;
  estimate_cents: number;
  projected_cents: number;
  account_cents: number;
  meters_json: string;
  missing_json: string;
  daily_json: string;
  level: number;
  projected_alerted_at: number | null;
  state: 'ok' | 'over' | 'paused';
  paused_at: number | null;
  paused_from_json: string | null;
  paused_schedules_json: string | null;
  paused_version: string | null;
  checked_at: number;
  read_at: number | null;
  error: string | null;
  error_alerted_at: number | null;
};
// A deployed project: its production Worker, by name and Cloudflare's immutable tag.
export type Target = {
  projectId: string;
  workspaceId: string;
  accountId: string;
  workerName: string;
  workerTag: string;
  // It deploys containers (adapter `container`).
  containers?: boolean;
};
type Reading = {
  plan: Plan;
  cents: number;
  accountCents: number;
  meters: MeterCost[];
  missing: Missing[];
  daily: Daily;
};
type Actor = { userId: string; requestKey: string };

export const thisMonth = () => new Date().toISOString().slice(0, 7);
export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const secondsLeftInMonth = () => {
  const time = new Date();
  return Math.max(
    0,
    Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 1) / 1000 - now(),
  );
};
const failure = (error: unknown, fallback: string) =>
  error instanceof AppError ? error.message : fallback;

// How far an estimate has come towards a budget: 0, 50, 80, or 100 for over it. With a $0
// budget, anything Cloudflare would bill is over.
export function levelFor(cents: number, budgetCents: number) {
  if (cents <= 0) return 0;
  if (cents > budgetCents) return 100;
  const share = cents / budgetCents;
  return share >= 0.8 ? 80 : share >= 0.5 ? 50 : 0;
}

export async function budgetOf(env: Env, projectId: string): Promise<Budget> {
  const row = await env.DB.prepare(
    'SELECT monthly_cents, on_exceed FROM project_budgets WHERE project_id=?',
  )
    .bind(projectId)
    .first<{ monthly_cents: number; on_exceed: Budget['onExceed'] }>();
  return {
    monthlyCents: row?.monthly_cents ?? 0,
    onExceed: row?.on_exceed ?? 'alert',
  };
}

// Readings ------------------------------------------------------------------------------

export const previousCheck = (env: Env, projectId: string) =>
  env.DB.prepare('SELECT * FROM budget_checks WHERE project_id=?')
    .bind(projectId)
    .first<CheckRow>();
const COLUMNS = [
  'project_id',
  'workspace_id',
  'account_id',
  'worker_name',
  'month',
  'plan',
  'estimate_cents',
  'projected_cents',
  'account_cents',
  'meters_json',
  'missing_json',
  'daily_json',
  'level',
  'projected_alerted_at',
  'state',
  'paused_at',
  'paused_from_json',
  'paused_schedules_json',
  'paused_version',
  'checked_at',
  'read_at',
  'error',
  'error_alerted_at',
] as const;
export const saveCheck = (env: Env, row: CheckRow) =>
  env.DB.prepare(
    `INSERT INTO budget_checks(${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')}) ON CONFLICT(project_id) DO UPDATE SET ${COLUMNS.slice(
      1,
    )
      .map((column) => `${column}=excluded.${column}`)
      .join(', ')}`,
  )
    .bind(...COLUMNS.map((column) => row[column]))
    .run();
export const emptyCheck = (t: Target): CheckRow => ({
  project_id: t.projectId,
  workspace_id: t.workspaceId,
  account_id: t.accountId,
  worker_name: t.workerName,
  month: thisMonth(),
  plan: 'unknown',
  estimate_cents: 0,
  projected_cents: 0,
  account_cents: 0,
  meters_json: '[]',
  missing_json: '[]',
  daily_json: '{}',
  level: 0,
  projected_alerted_at: null,
  state: 'ok',
  paused_at: null,
  paused_from_json: null,
  paused_schedules_json: null,
  paused_version: null,
  checked_at: now(),
  read_at: null,
  error: null,
  error_alerted_at: null,
});

// A reading that couldn't be made: what was known stays, with why. One that has failed for
// an hour (or never worked) is sent as an alert, at most once a day.
async function failCheck(env: Env, t: Target, error: unknown) {
  const before = (await previousCheck(env, t.projectId)) ?? emptyCheck(t);
  const reason = failure(
    error,
    'Shipcel couldn’t read this project’s usage from Cloudflare.',
  );
  const alert =
    (!before.read_at || before.read_at < now() - UNREADABLE_ALERT_AFTER) &&
    (!before.error_alerted_at ||
      before.error_alerted_at < now() - UNREADABLE_ALERT_EVERY);
  if (alert)
    await notify(env, {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      event: 'budget.alert',
      text: (name) =>
        `The budget guard can’t read ${name}’s usage from Cloudflare, so it can’t alert or pause: ${reason}`,
      data: { unreadable: reason },
    });
  await saveCheck(env, {
    ...before,
    checked_at: now(),
    error: reason,
    error_alerted_at: alert ? now() : before.error_alerted_at,
  });
}

// Cloudflare reads ----------------------------------------------------------------------

type Namespace = { id: string; script: string | null };
// The account's Durable Object namespaces and the Worker each belongs to.
async function namespacesOf(token: string, accountId: string) {
  const found: Namespace[] = [];
  for (let page = 1; page <= 20; page++) {
    const { result, info } = await cloudflarePage<unknown>(
      token,
      `/accounts/${accountId}/workers/durable_objects/namespaces?per_page=100&page=${page}`,
    );
    const list = z
      .array(
        z
          .object({ id: z.string(), script: z.string().nullable().optional() })
          .passthrough(),
      )
      .parse(result);
    found.push(...list.map((n) => ({ id: n.id, script: n.script ?? null })));
    if (list.length < 100 || found.length >= Number(info.total_count ?? 0))
      break;
  }
  return found;
}

const settingsSchema = z
  .object({
    bindings: z
      .array(z.object({ type: z.string(), name: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();
// Which of the account's resources are the project's: its Worker, its Durable Object
// namespaces, and the databases, namespaces and buckets the Worker is bound to.
async function ownerOf(token: string, t: Target, namespaces: Namespace[]) {
  const { bindings = [] } = settingsSchema.parse(
    await cloudflare(
      token,
      `/accounts/${t.accountId}/workers/scripts/${t.workerName}/settings`,
    ),
  );
  const bound = (type: string, key: string) =>
    new Set(
      bindings
        .filter((b) => b.type === type && typeof b[key] === 'string')
        .map((b) => b[key] as string),
    );
  const own: Record<string, Set<string>> = {
    workers: new Set([t.workerName]),
    do: new Set(
      namespaces.filter((n) => n.script === t.workerName).map((n) => n.id),
    ),
    d1: bound('d1', 'id'),
    kv: bound('kv_namespace', 'namespace_id'),
    r2: bound('r2_bucket', 'bucket_name'),
  };
  // Cloudflare's analytics name a container's application, and Shipcel's sign-in can't read
  // which Worker an application belongs to. So a project that deploys containers counts all of
  // the account's: its alerts come early when another app runs containers, never late.
  return (meter: Meter, resource: string) =>
    meter.startsWith('containers.')
      ? Boolean(t.containers)
      : (own[meter.split('.')[0]]?.has(resource) ?? false);
}

// The account's plan, from its billing at most once a day. Without the Billing Read
// permission it is unknown, and estimated as Workers Paid.
const BILLING_SCOPES = ['billingread', 'billingwrite', 'billingedit'];
type PlanFound = { plan: Plan; source: string; detail: string | null };
async function planFor(
  env: Env,
  workspaceId: string,
  accountId: string,
  grant: Grant,
  token: string,
): Promise<PlanFound> {
  const cached = await env.DB.prepare(
    'SELECT plan, source, detail, checked_at FROM account_plans WHERE workspace_id=? AND account_id=?',
  )
    .bind(workspaceId, accountId)
    .first<PlanFound & { checked_at: number }>();
  if (cached && cached.checked_at > now() - PLAN_CHECK_EVERY) return cached;
  const scopes = grant.scopes
    ?.split(/\s+/)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const found: PlanFound =
    scopes && !scopes.some((s) => BILLING_SCOPES.includes(s))
      ? { plan: 'unknown', source: 'no-permission', detail: null }
      : await detectPlan(token, accountId);
  // Usage past Workers Free's limits already showed the account is on Workers Paid.
  const plan =
    cached?.source === 'usage' && found.plan !== 'paid' ? cached : found;
  await savePlan(env, workspaceId, accountId, plan);
  return plan;
}
const savePlan = (
  env: Env,
  workspaceId: string,
  accountId: string,
  plan: PlanFound,
) =>
  env.DB.prepare(
    'INSERT INTO account_plans(workspace_id,account_id,plan,source,detail,checked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET plan=excluded.plan, source=excluded.source, detail=excluded.detail, checked_at=excluded.checked_at',
  )
    .bind(workspaceId, accountId, plan.plan, plan.source, plan.detail, now())
    .run();

// The guard only ever changes the Worker Shipcel deployed: same name, same tag.
export async function sameWorker(token: string, t: Target) {
  const workers = z
    .array(z.object({ id: z.string(), tag: z.string() }).passthrough())
    .parse(await cloudflare(token, `/accounts/${t.accountId}/workers/scripts`));
  if (!workers.some((w) => w.id === t.workerName && w.tag === t.workerTag))
    throw new AppError(
      409,
      'The Worker identity changed or is no longer accessible. Nothing was changed.',
    );
}

// Pauses and resumes ----------------------------------------------------------------------

// A pause or resume in the project's operations journal. A request repeated with the same
// key gets the first one's outcome: null when it succeeded.
export async function journal<T>(
  env: Env,
  t: Target,
  who: Actor,
  kind: 'budget.pause' | 'budget.resume',
  work: () => Promise<T>,
): Promise<T | null> {
  const previous = await env.DB.prepare(
    'SELECT project_id, kind, status, error FROM project_operations WHERE workspace_id=? AND request_key=?',
  )
    .bind(t.workspaceId, who.requestKey)
    .first<{
      project_id: string;
      kind: string;
      status: string;
      error: string | null;
    }>();
  if (previous) {
    if (previous.project_id !== t.projectId || previous.kind !== kind)
      throw new AppError(409, 'This request key belongs to another operation.');
    if (previous.status === 'succeeded') return null;
    throw new AppError(
      409,
      previous.error ?? 'This request is still running. Refresh in a moment.',
    );
  }
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'running',?,?)",
    )
      .bind(
        id,
        t.workspaceId,
        t.projectId,
        who.userId,
        t.accountId,
        kind,
        who.requestKey,
        now(),
        now(),
      )
      .run();
  } catch {
    throw new AppError(
      409,
      'Another operation is running for this project. Try again when it finishes.',
    );
  }
  try {
    const result = await work();
    await env.DB.prepare(
      "UPDATE project_operations SET status='succeeded', result_json=?, updated_at=? WHERE id=?",
    )
      .bind(JSON.stringify(result ?? {}), now(), id)
      .run();
    return result;
  } catch (error) {
    await env.DB.prepare(
      "UPDATE project_operations SET status='needs_attention', error=?, updated_at=? WHERE id=?",
    )
      .bind(
        failure(
          error,
          'Cloudflare didn’t complete the change. Check the Worker in Cloudflare.',
        ),
        now(),
        id,
      )
      .run();
    throw error;
  }
}

export const pausedFields = (paused: Paused | null) => ({
  paused_at: paused ? now() : null,
  paused_from_json: paused ? JSON.stringify(paused.from) : null,
  paused_schedules_json: paused ? JSON.stringify(paused.schedules) : null,
  paused_version: paused?.version ?? null,
});

// Pauses the app now and returns the reading with the pause. Throws when Cloudflare refuses.
export async function pauseNow(
  env: Env,
  t: Target,
  token: string,
  row: CheckRow,
  who: Actor,
): Promise<CheckRow> {
  await sameWorker(token, t);
  const paused = await journal(env, t, who, 'budget.pause', () =>
    pauseWorker(token, t),
  );
  if (!paused) return (await previousCheck(env, t.projectId)) ?? row;
  return { ...row, state: 'paused', ...pausedFields(paused) };
}

// Whether production still serves only the stand-in: someone may have deployed since.
const stillPaused = (serving: Serving, version: string | null) => {
  const live = serving.filter((v) => v.percentage > 0);
  return live.length > 0 && live.every((v) => v.version_id === version);
};

// What the guard does about a reading: pauses an app over a budget whose owner chose that,
// pauses again one deployed while paused, and notes one that runs again.
async function enforce(
  env: Env,
  t: Target,
  token: string,
  budget: Budget,
  row: CheckRow,
  before: CheckRow | null,
): Promise<CheckRow> {
  const over = levelFor(row.estimate_cents, budget.monthlyCents) === 100;
  const pause = over && budget.onExceed === 'pause';
  if (row.state === 'paused') {
    if (stillPaused(await servingVersions(token, t), row.paused_version))
      return row;
    if (!pause) {
      await notify(env, {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        event: 'budget.resumed',
        text: (name) =>
          `${name} is running again: a new version was deployed while it was paused.`,
        data: {},
      });
      return { ...row, state: over ? 'over' : 'ok', ...pausedFields(null) };
    }
  } else if (!pause) return row;
  try {
    const paused = await pauseNow(env, t, token, row, {
      userId: GUARD_USER,
      requestKey: `budget.pause:${crypto.randomUUID()}`,
    });
    await notify(env, {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      event: 'budget.paused',
      text: (name) =>
        `${name} was paused: an estimated ${dollars(row.estimate_cents)} this month beyond what Cloudflare includes, over its ${dollars(budget.monthlyCents)} budget.${row.state === 'paused' ? ' It had been deployed again while paused.' : ''} Its data is kept and its schedules are off. Fix the cause, raise the budget or switch it to alerts only, then resume it in Shipcel.`,
      data: {
        estimateCents: row.estimate_cents,
        budgetCents: budget.monthlyCents,
      },
    });
    return paused;
  } catch (error) {
    const reason = `Couldn’t pause the app: ${failure(error, 'Cloudflare didn’t complete the change.')}`;
    // Said once, not at every reading while it keeps failing.
    if (!before?.error?.startsWith('Couldn’t pause'))
      await notify(env, {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        event: 'budget.alert',
        text: (name) =>
          `${name} is over its budget and still running. ${reason} Pause or stop it in Cloudflare.`,
        data: { pauseFailed: reason },
      });
    return { ...row, error: reason };
  }
}

// The alerts a reading calls for: each new level of the budget, then (below it) a rate that
// would go over by the end of the month, at most every few hours.
async function alerts(
  env: Env,
  t: Target,
  budget: Budget,
  row: CheckRow,
): Promise<CheckRow> {
  const level = levelFor(row.estimate_cents, budget.monthlyCents);
  const of = `an estimated ${dollars(row.estimate_cents)} this month beyond what Cloudflare includes, against a ${dollars(budget.monthlyCents)} budget`;
  if (level > row.level) {
    await notify(env, {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      event: 'budget.alert',
      text: (name) =>
        level === 100
          ? `${name} is over its budget: ${of}.${budget.onExceed === 'pause' ? ' Shipcel is pausing it.' : ' It keeps running: this project only sends alerts.'}`
          : `${name} has used ${level}% of its budget: ${of}.`,
      data: {
        level,
        estimateCents: row.estimate_cents,
        budgetCents: budget.monthlyCents,
        onExceed: budget.onExceed,
      },
    });
    return { ...row, level };
  }
  const due =
    !row.projected_alerted_at ||
    row.projected_alerted_at < now() - PROJECTED_ALERT_EVERY;
  if (level === 100 || row.projected_cents <= budget.monthlyCents || !due)
    return row;
  await notify(env, {
    workspaceId: t.workspaceId,
    projectId: t.projectId,
    event: 'budget.alert',
    text: (name) =>
      `${name} is on course to go over its budget: at the rate of the last few minutes it would cost ${dollars(row.projected_cents)} beyond what Cloudflare includes by the end of the month, against a ${dollars(budget.monthlyCents)} budget.`,
    data: {
      projectedCents: row.projected_cents,
      budgetCents: budget.monthlyCents,
    },
  });
  return { ...row, projected_alerted_at: now() };
}

// Saves a reading of one project, sends the alerts it calls for, and pauses the app if its
// owner chose that.
async function record(env: Env, t: Target, token: string, reading: Reading) {
  const before = await previousCheck(env, t.projectId);
  const budget = await budgetOf(env, t.projectId);
  const month = thisMonth();
  const last = before?.month === month ? before : null;
  // The rate since the last reading this month, carried on to the end of the month.
  const elapsed = last?.read_at ? now() - last.read_at : 0;
  const rate =
    last && elapsed > 0
      ? Math.max(0, reading.cents - last.estimate_cents) / elapsed
      : 0;
  const base: CheckRow = {
    ...(before ?? emptyCheck(t)),
    account_id: t.accountId,
    worker_name: t.workerName,
    month,
    plan: reading.plan,
    estimate_cents: reading.cents,
    projected_cents: Math.round(reading.cents + rate * secondsLeftInMonth()),
    account_cents: reading.accountCents,
    meters_json: JSON.stringify(reading.meters),
    missing_json: JSON.stringify(reading.missing),
    daily_json: JSON.stringify(reading.daily),
    level: last?.level ?? 0,
    projected_alerted_at: last?.projected_alerted_at ?? null,
    state:
      before?.state === 'paused'
        ? 'paused'
        : levelFor(reading.cents, budget.monthlyCents) === 100
          ? 'over'
          : 'ok',
    checked_at: now(),
    read_at: now(),
    error: null,
  };
  const alerted = await alerts(env, t, budget, base);
  const row = await enforce(env, t, token, budget, alerted, before);
  await saveCheck(env, row);
}

// One reading of the given projects of one workspace's Cloudflare account: the account's
// usage is read once, then shared out.
export async function checkAccount(
  env: Env,
  workspaceId: string,
  accountId: string,
  targets: Target[],
) {
  const grant = await activeGrant(env, workspaceId, 'cloudflare');
  let token: string;
  try {
    if (!grant || grant.account_id !== accountId)
      throw new AppError(
        409,
        'Cloudflare isn’t connected to this project’s account in Shipcel. Reconnect it in Connections.',
      );
    token = await grantToken(env, grant);
  } catch (error) {
    for (const t of targets) await failCheck(env, t, error);
    return;
  }
  const until = new Date().toISOString().slice(0, 10);
  const [usage, namespaces] = await Promise.all([
    readUsage(token, accountId, `${thisMonth()}-01`, until),
    namespacesOf(token, accountId).catch(() => [] as Namespace[]),
  ]);
  const unread = new Set(usage.missing.flatMap((m) => m.meters));
  if (unread.size === Object.keys(METERS).length) {
    const reason = `Cloudflare’s analytics answered: ${usage.missing[0]?.reason ?? 'nothing'}. Shipcel needs the Account Analytics Read permission: update the Cloudflare sign-in in Connections, then reconnect.`;
    for (const t of targets) await failCheck(env, t, new AppError(502, reason));
    return;
  }
  let plan = await planFor(env, workspaceId, accountId, grant, token);
  if (
    plan.plan !== 'paid' &&
    estimate('free', usage.rows, () => false).overFree
  ) {
    plan = {
      plan: 'paid',
      source: 'usage',
      detail: 'More than Workers Free allows in a day',
    };
    await savePlan(env, workspaceId, accountId, plan);
  }
  for (const t of targets) {
    try {
      const mine = await ownerOf(token, t, namespaces);
      const result = estimate(plan.plan, usage.rows, mine);
      await record(env, t, token, {
        plan: plan.plan,
        cents: result.cents,
        accountCents: result.accountCents,
        meters: result.meters,
        missing: usage.missing,
        daily: dailySeries(plan.plan, usage.rows, mine, monthDays(until)),
      });
    } catch (error) {
      await failCheck(env, t, error);
    }
  }
}

// Every minute: the deployed projects whose last reading is older than CHECK_EVERY, oldest
// first, a batch at a time, grouped by account so each account's usage is read once.
export async function scheduledBudgets(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT j.project_id, j.workspace_id, j.account_id, j.worker_name, j.worker_tag, j.adapter FROM deployment_jobs j
     LEFT JOIN budget_checks b ON b.project_id=j.project_id
     WHERE j.environment='production' AND j.worker_tag IS NOT NULL
       AND j.created_at=(SELECT MAX(created_at) FROM deployment_jobs WHERE project_id=j.project_id AND environment='production' AND worker_tag IS NOT NULL)
       AND (b.checked_at IS NULL OR b.checked_at<=?)
     ORDER BY COALESCE(b.checked_at, 0) LIMIT ?`,
  )
    .bind(now() - CHECK_EVERY, BATCH)
    .all<{
      project_id: string;
      workspace_id: string;
      account_id: string;
      worker_name: string;
      worker_tag: string;
      adapter: string | null;
    }>();
  const accounts = new Map<string, Target[]>();
  for (const r of results) {
    const key = `${r.workspace_id} ${r.account_id}`;
    accounts.set(key, [
      ...(accounts.get(key) ?? []),
      {
        projectId: r.project_id,
        workspaceId: r.workspace_id,
        accountId: r.account_id,
        workerName: r.worker_name,
        workerTag: r.worker_tag,
        containers: r.adapter === 'container',
      },
    ]);
  }
  await Promise.allSettled(
    [...accounts].map(([key, targets]) => {
      const [workspaceId, accountId] = key.split(' ');
      return checkAccount(env, workspaceId, accountId, targets);
    }),
  );
}

// Production deploys of a paused project wait for its owner to resume it: the guard would
// pause a new version again while the month's estimate stays over the budget.
export async function pausedForBudget(env: Env, projectId: string) {
  const row = await env.DB.prepare(
    "SELECT 1 FROM budget_checks WHERE project_id=? AND state='paused'",
  )
    .bind(projectId)
    .first();
  return row
    ? 'This project is paused for going over its budget. An owner can resume it in the project’s Billing panel in the dashboard; deploy the fix after that.'
    : null;
}

export async function refuseWhilePaused(env: Env, projectId: string) {
  const paused = await pausedForBudget(env, projectId);
  if (paused) throw new AppError(409, paused);
}
