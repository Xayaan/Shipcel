import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { database, projectInput } from './helpers/database';

// The workspace at a glance (worker/usage.ts): this month's cost per app from the budget
// guard's readings, and what needs attention. Read-only, from Shipcel's own records.
let db: ReturnType<typeof database>;
type Who = Awaited<ReturnType<ReturnType<typeof database>['user']>>;
const now = () => Math.floor(Date.now() / 1000);
const month = () => new Date().toISOString().slice(0, 7);
const get = async (path: string, who: Who) =>
  (await db.request(path, {}, who.cookie)).json();

async function project(who: Who, name: string) {
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput(name)) },
    who.cookie,
  );
  return ((await created.json()) as { id: string }).id;
}
function check(who: Who, projectId: string, row: Record<string, unknown> = {}) {
  const values = {
    project_id: projectId,
    workspace_id: who.workspaceId,
    account_id: 'a'.repeat(32),
    worker_name: `w-${projectId.slice(0, 8)}`,
    month: month(),
    plan: 'paid',
    estimate_cents: 0,
    projected_cents: 0,
    account_cents: 0,
    level: 0,
    state: 'ok',
    checked_at: now() - 60,
    read_at: now() - 60,
    ...row,
  };
  db.sqlite
    .prepare(
      `INSERT INTO budget_checks(${Object.keys(values).join(',')}) VALUES (${Object.keys(
        values,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(values));
}
function budget(
  who: Who,
  projectId: string,
  cents: number,
  onExceed = 'alert',
) {
  db.sqlite
    .prepare(
      'INSERT INTO project_budgets(project_id,workspace_id,monthly_cents,on_exceed,updated_by,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(projectId, who.workspaceId, cents, onExceed, who.userId, now());
}
function health(
  who: Who,
  projectId: string,
  status: string,
  startedAt: number,
) {
  db.sqlite
    .prepare(
      "INSERT INTO operation_health(operation_id,workspace_id,project_id,account_id,kind,target,status,step,detail,started_at,checked_at) VALUES (?,?,?,?,'build','b',?,'probe',?,?,?)",
    )
    .run(
      crypto.randomUUID(),
      who.workspaceId,
      projectId,
      'a'.repeat(32),
      status,
      status === 'healthy' ? 'HTTP 200' : 'Check 3 of 3 got HTTP 503.',
      startedAt,
      startedAt + 30,
    );
}
function deploy(who: Who, projectId: string, status: string, at: number) {
  const row = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: 'a'.repeat(32),
    repository_id: '1',
    repository_name: 'ada/app',
    branch: 'main',
    commit_sha: 'c'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: `w-${crypto.randomUUID().slice(0, 8)}`,
    build_command: '',
    status,
    error:
      status === 'failed' ? 'The build failed: npm run build exited 1.' : null,
    idempotency_key: crypto.randomUUID(),
    created_at: at,
    updated_at: at,
  };
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${Object.keys(row).join(',')}) VALUES (${Object.keys(
        row,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(row));
}

beforeEach(() => {
  db = database();
});
afterEach(() => db.close());

describe('usage', () => {
  it('sums up this month per app from the guard’s readings, with the account’s figure', async () => {
    const who = await db.user(1);
    const shop = await project(who, 'shop');
    const blog = await project(who, 'blog');
    const old = await project(who, 'old-app');
    check(who, shop, {
      estimate_cents: 150,
      projected_cents: 630,
      account_cents: 410,
      read_at: now() - 30,
    });
    budget(who, shop, 1000, 'pause');
    check(who, blog, { account_cents: 400, read_at: now() - 600 });
    // Read last month only: nothing known about this one yet.
    check(who, old, { month: '2026-01', estimate_cents: 9999 });
    // Another workspace's readings never show.
    const other = await db.user(2);
    check(other, await project(other, 'theirs'), { estimate_cents: 5 });
    const u = (await get('/usage', who)) as Record<string, unknown>;
    expect(u).toMatchObject({
      month: month(),
      plan: 'paid',
      // The latest reading's account figure.
      account: { cents: 410 },
      notEstimated: expect.stringContaining('aren’t in the estimate'),
    });
    expect(u.projects).toEqual([
      expect.objectContaining({
        name: 'blog',
        estimateCents: 0,
        budgetCents: 0,
        onExceed: 'alert',
      }),
      expect.objectContaining({
        name: 'old-app',
        estimateCents: 0,
        readAt: null,
      }),
      expect.objectContaining({
        name: 'shop',
        estimateCents: 150,
        projectedCents: 630,
        budgetCents: 1000,
        onExceed: 'pause',
        state: 'ok',
      }),
    ]);
    expect(JSON.stringify(u)).not.toContain('theirs');
    // A workspace with nothing read yet.
    const fresh = await db.user(3);
    expect(await get('/usage', fresh)).toMatchObject({
      plan: null,
      account: null,
      projects: [],
    });
    // A new month before its first reading: last month's figures aren't this month's.
    const early = await db.user(4);
    check(early, await project(early, 'early'), {
      month: '2026-01',
      account_cents: 9999,
      read_at: now() - 5,
    });
    expect(await get('/usage', early)).toMatchObject({
      plan: null,
      account: null,
      projects: [expect.objectContaining({ name: 'early', readAt: null })],
    });
  });
});

describe('alerts', () => {
  it('lists what needs attention, newest first: budgets, health checks, failed deploys', async () => {
    const who = await db.user(1);
    const ids: Record<string, string> = {};
    for (const name of [
      'paused',
      'over',
      'half',
      'course',
      'blind',
      'calm',
      'sick',
      'broken',
      'recovered',
    ])
      ids[name] = await project(who, name);
    check(who, ids.paused, {
      state: 'paused',
      paused_at: now() - 100,
      estimate_cents: 2000,
      level: 100,
    });
    budget(who, ids.paused, 1000, 'pause');
    check(who, ids.over, {
      state: 'over',
      estimate_cents: 1200,
      level: 100,
      read_at: now() - 200,
    });
    budget(who, ids.over, 1000);
    check(who, ids.half, {
      estimate_cents: 600,
      level: 50,
      read_at: now() - 300,
    });
    budget(who, ids.half, 1000);
    check(who, ids.course, {
      estimate_cents: 100,
      projected_cents: 1500,
      read_at: now() - 400,
    });
    budget(who, ids.course, 1000);
    // Two hours without a good reading.
    check(who, ids.blind, {
      error: 'Cloudflare answered 403.',
      read_at: now() - 7200,
      checked_at: now() - 500,
    });
    // A failed attempt right after a good reading isn't an alert yet.
    check(who, ids.calm, {
      estimate_cents: 100,
      projected_cents: 200,
      error: 'Cloudflare timed out.',
    });
    budget(who, ids.calm, 1000);
    health(who, ids.sick, 'unhealthy', now() - 600);
    // Only the latest health check counts: this one recovered.
    health(who, ids.recovered, 'unhealthy', now() - 3000);
    health(who, ids.recovered, 'healthy', now() - 700);
    deploy(who, ids.broken, 'failed', now() - 800);
    // A failure from two weeks ago isn't news.
    deploy(who, ids.calm, 'failed', now() - 14 * 86400);
    const { alerts } = (await get('/alerts', who)) as {
      alerts: {
        project: string;
        kind: string;
        severity: string;
        message: string;
      }[];
    };
    expect(alerts.map((a) => [a.project, a.kind, a.severity])).toEqual([
      ['paused', 'budget.paused', 'error'],
      ['over', 'budget.over', 'error'],
      ['half', 'budget.level', 'warning'],
      ['course', 'budget.projected', 'warning'],
      ['blind', 'budget.unreadable', 'warning'],
      ['sick', 'health.unhealthy', 'error'],
      ['broken', 'deployment.failed', 'error'],
    ]);
    const text = (kind: string) => alerts.find((a) => a.kind === kind)!.message;
    expect(text('budget.paused')).toBe(
      'Paused for going over its budget: $20.00 this month beyond what Cloudflare includes, against a $10.00 budget. An owner resumes it in the dashboard.',
    );
    expect(text('budget.over')).toContain(
      'It keeps running: it only sends alerts.',
    );
    expect(text('budget.level')).toBe(
      'Has used 50% of its budget: $6.00 this month beyond what Cloudflare includes, against a $10.00 budget.',
    );
    expect(text('budget.projected')).toContain('$15.00');
    expect(text('budget.unreadable')).toContain('Cloudflare answered 403.');
    expect(text('health.unhealthy')).toContain('Check 3 of 3 got HTTP 503.');
    expect(text('deployment.failed')).toContain('npm run build exited 1');
    // One project's, and never another workspace's.
    const one = (await get(`/alerts?project=${ids.half}`, who)) as {
      alerts: unknown[];
    };
    expect(one.alerts).toHaveLength(1);
    const other = await db.user(2);
    expect(await get('/alerts', other)).toEqual({ alerts: [] });
    expect(
      (await db.request(`/alerts?project=${ids.half}`, {}, other.cookie))
        .status,
    ).toBe(404);
  });
});
