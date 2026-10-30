import { Hono } from 'hono';
import { z } from 'zod';
import { requireIdentity } from './auth';
import { dollars, thisMonth, UNREADABLE_ALERT_AFTER } from './budgets';
import { notEstimated } from './budget-usage';
import { AppError, now, type AppEnv, type Env } from './types';

// The workspace at a glance, for `shipcel usage` and `shipcel alerts`: what each deployed
// project costs this month beyond what Cloudflare includes (the budget guard's latest
// readings, worker/budgets.ts), and what needs attention now. Read-only, for anyone in the
// workspace; it asks Cloudflare nothing.
export const usage = new Hono<AppEnv>();

// Health checks and deploys older than this aren't news any more.
const RECENT = 7 * 86400;

type CheckRow = {
  project_id: string;
  name: string;
  month: string;
  plan: 'free' | 'paid' | 'unknown';
  estimate_cents: number;
  projected_cents: number;
  account_cents: number;
  level: number;
  state: 'ok' | 'over' | 'paused';
  paused_at: number | null;
  checked_at: number;
  read_at: number | null;
  error: string | null;
  monthly_cents: number | null;
  on_exceed: 'alert' | 'pause' | null;
};

async function checks(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare(
    'SELECT b.project_id, p.name, b.month, b.plan, b.estimate_cents, b.projected_cents, b.account_cents, b.level, b.state, b.paused_at, b.checked_at, b.read_at, b.error, g.monthly_cents, g.on_exceed FROM budget_checks b JOIN projects p ON p.id=b.project_id AND p.workspace_id=b.workspace_id LEFT JOIN project_budgets g ON g.project_id=b.project_id WHERE b.workspace_id=? ORDER BY p.name, p.id',
  )
    .bind(workspaceId)
    .all<CheckRow>();
  return results;
}

usage.get('/usage', async (c) => {
  const who = requireIdentity(c);
  const month = thisMonth();
  const rows = await checks(c.env, who.workspaceId);
  // A reading from an earlier month says nothing about this one yet.
  const current = rows.filter((r) => r.month === month);
  const latest = current
    .filter((r) => r.read_at)
    .sort((a, b) => b.read_at! - a.read_at!)[0];
  return c.json({
    month,
    plan: latest?.plan ?? null,
    // The whole Cloudflare account, Workers Shipcel doesn't manage included, as the latest
    // reading found it.
    account: latest
      ? { cents: latest.account_cents, readAt: latest.read_at }
      : null,
    notEstimated,
    projects: rows.map((r) => {
      const fresh = r.month === month;
      return {
        id: r.project_id,
        name: r.name,
        estimateCents: fresh ? r.estimate_cents : 0,
        projectedCents: fresh ? r.projected_cents : 0,
        // No row: the default, $0 beyond what Cloudflare includes, alerts only.
        budgetCents: r.monthly_cents ?? 0,
        onExceed: r.on_exceed ?? 'alert',
        state: r.state,
        readAt: fresh ? r.read_at : null,
        error: r.error,
      };
    }),
  });
});

type Alert = {
  projectId: string;
  project: string;
  kind:
    | 'budget.paused'
    | 'budget.over'
    | 'budget.level'
    | 'budget.projected'
    | 'budget.unreadable'
    | 'health.unhealthy'
    | 'health.build_failed'
    | 'deployment.failed';
  severity: 'error' | 'warning';
  message: string;
  at: number;
};

function budgetAlerts(r: CheckRow, month: string): Alert[] {
  const base = { projectId: r.project_id, project: r.name };
  const budget = r.monthly_cents ?? 0;
  const of = `${dollars(r.estimate_cents)} this month beyond what Cloudflare includes, against a ${dollars(budget)} budget`;
  const found: Alert[] = [];
  if (r.state === 'paused')
    found.push({
      ...base,
      kind: 'budget.paused',
      severity: 'error',
      message: `Paused for going over its budget: ${of}. An owner resumes it in the dashboard.`,
      at: r.paused_at ?? r.checked_at,
    });
  else if (r.month === month && r.state === 'over')
    found.push({
      ...base,
      kind: 'budget.over',
      severity: 'error',
      message: `Over its budget: ${of}.${(r.on_exceed ?? 'alert') === 'alert' ? ' It keeps running: it only sends alerts.' : ''}`,
      at: r.read_at ?? r.checked_at,
    });
  else if (r.month === month && r.level >= 50)
    found.push({
      ...base,
      kind: 'budget.level',
      severity: 'warning',
      message: `Has used ${r.level}% of its budget: ${of}.`,
      at: r.read_at ?? r.checked_at,
    });
  if (
    r.month === month &&
    r.state === 'ok' &&
    r.projected_cents > budget &&
    r.level < 100
  )
    found.push({
      ...base,
      kind: 'budget.projected',
      severity: 'warning',
      message: `On course to go over its budget: at the latest rate it would cost ${dollars(r.projected_cents)} beyond what Cloudflare includes by the end of the month, against a ${dollars(budget)} budget.`,
      at: r.read_at ?? r.checked_at,
    });
  if (r.error && (!r.read_at || r.read_at < now() - UNREADABLE_ALERT_AFTER))
    found.push({
      ...base,
      kind: 'budget.unreadable',
      severity: 'warning',
      message: `The budget guard can't read its usage: ${r.error}`,
      at: r.checked_at,
    });
  return found;
}

usage.get('/alerts', async (c) => {
  const who = requireIdentity(c);
  const project = z
    .string()
    .min(1)
    .max(100)
    .optional()
    .parse(c.req.query('project'));
  if (project) {
    const exists = await c.env.DB.prepare(
      'SELECT 1 FROM projects WHERE id=? AND workspace_id=?',
    )
      .bind(project, who.workspaceId)
      .first();
    if (!exists) throw new AppError(404, 'Project not found.');
  }
  const month = thisMonth();
  const since = now() - RECENT;
  const alerts: Alert[] = (await checks(c.env, who.workspaceId)).flatMap((r) =>
    budgetAlerts(r, month),
  );
  // The latest health check of each project, when it failed.
  const { results: health } = await c.env.DB.prepare(
    "SELECT h.project_id, p.name, h.kind, h.status, h.detail, COALESCE(h.checked_at, h.started_at) AS at FROM operation_health h JOIN projects p ON p.id=h.project_id AND p.workspace_id=h.workspace_id WHERE h.workspace_id=? AND h.started_at=(SELECT MAX(started_at) FROM operation_health WHERE project_id=h.project_id) AND h.status IN ('unhealthy','build_failed') AND h.started_at>?",
  )
    .bind(who.workspaceId, since)
    .all<{
      project_id: string;
      name: string;
      kind: string;
      status: 'unhealthy' | 'build_failed';
      detail: string | null;
      at: number;
    }>();
  for (const h of health)
    alerts.push({
      projectId: h.project_id,
      project: h.name,
      kind:
        h.status === 'unhealthy' ? 'health.unhealthy' : 'health.build_failed',
      severity: 'error',
      message:
        h.status === 'unhealthy'
          ? `Unhealthy after a ${h.kind === 'promotion' ? 'promotion' : 'deploy'}: ${h.detail ?? 'its homepage stopped answering.'}`
          : `The last build failed: ${h.detail ?? 'Cloudflare kept serving the previous version.'}`,
      at: h.at,
    });
  // The latest production deploy of each project, when it failed or needs attention.
  const { results: deploys } = await c.env.DB.prepare(
    "SELECT j.project_id, p.name, j.status, j.error, j.updated_at FROM deployment_jobs j JOIN projects p ON p.id=j.project_id AND p.workspace_id=j.workspace_id WHERE j.workspace_id=? AND j.environment='production' AND j.created_at=(SELECT MAX(created_at) FROM deployment_jobs WHERE project_id=j.project_id AND environment='production') AND j.status IN ('failed','needs_attention') AND j.updated_at>?",
  )
    .bind(who.workspaceId, since)
    .all<{
      project_id: string;
      name: string;
      status: string;
      error: string | null;
      updated_at: number;
    }>();
  for (const d of deploys)
    alerts.push({
      projectId: d.project_id,
      project: d.name,
      kind: 'deployment.failed',
      severity: 'error',
      message: `The last deploy ${d.status === 'failed' ? 'failed' : 'needs attention'}${d.error ? `: ${d.error}` : '.'}`,
      at: d.updated_at,
    });
  return c.json({
    alerts: alerts
      .filter((a) => !project || a.projectId === project)
      .sort((a, b) => b.at - a.at || a.project.localeCompare(b.project)),
  });
});
