import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../worker/index';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';
import { levelFor, scheduledBudgets } from '../worker/budgets';
import { pausedModule } from '../worker/budget-pause';
import {
  dailySeries,
  detectPlan,
  estimate,
  monthDays,
  readUsage,
  type UsageRow,
} from '../worker/budget-usage';

// The budget guard: Shipcel reads each deployed project's usage from Cloudflare's
// analytics every few minutes, estimates its cost this month beyond what Cloudflare
// includes, alerts against the project's budget ($0 by default), and pauses the app when an
// owner chose that. Cloudflare is faked here: analytics by dataset, billing, Durable Object
// namespaces, and the Worker's settings, deployments, versions and schedules.

const ACCOUNT = 'a'.repeat(32);
const WORKER = 'loop-app';
const TAG = 'f'.repeat(32);
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

type Group = {
  sum?: Record<string, number>;
  dimensions?: Record<string, string>;
};

function fakeCloudflare() {
  const cf = {
    datasets: {} as Record<string, Group[] | { error: string }>,
    analyticsStatus: 200,
    subscriptions: { status: 403, result: [] as unknown[] },
    subscriptionCalls: 0,
    namespaces: [
      { id: 'ns-loop', script: WORKER, class: 'Ticker' },
      { id: 'ns-other', script: 'someone-else', class: 'Other' },
    ],
    bindings: [
      {
        type: 'durable_object_namespace',
        name: 'TICKER',
        class_name: 'Ticker',
      },
      {
        type: 'durable_object_namespace',
        name: 'ROOMS',
        class_name: 'Room',
      },
      { type: 'd1', name: 'DB', id: 'db-mine' },
      { type: 'r2_bucket', name: 'FILES', bucket_name: 'bucket-mine' },
    ] as Record<string, string>[],
    workers: [{ id: WORKER, tag: TAG }],
    serving: [{ version_id: 'v-live', percentage: 100 }],
    schedules: [{ cron: '*/5 * * * *' }],
    uploads: [] as { metadata: Record<string, unknown>; module: string }[],
    deploys: [] as {
      versions: unknown[];
      annotations: Record<string, string>;
      force: string | null;
    }[],
    scheduleWrites: [] as unknown[],
    queries: [] as { dataset: string; variables: Record<string, string> }[],
  };
  const ok = (result: unknown, info?: Record<string, unknown>) =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result,
      ...(info ? { result_info: info } : {}),
    });
  const refused = (status: number) =>
    Response.json(
      {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      },
      { status },
    );
  async function handler(raw: string | URL | Request, init: RequestInit = {}) {
    const url = new URL(String(raw));
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/client/v4', '');
    if (path === '/graphql') {
      const { query, variables } = JSON.parse(String(init.body));
      const dataset = /(\w+)\(limit/.exec(query)![1];
      cf.queries.push({ dataset, variables });
      if (cf.analyticsStatus !== 200) return refused(cf.analyticsStatus);
      const answer = cf.datasets[dataset] ?? [];
      if (!Array.isArray(answer))
        return Response.json({
          data: null,
          errors: [{ message: answer.error }],
        });
      return Response.json({
        data: { viewer: { accounts: [{ [dataset]: answer }] } },
        errors: null,
      });
    }
    const script = `/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
    if (method === 'GET' && path === `/accounts/${ACCOUNT}/subscriptions`)
      return ++cf.subscriptionCalls && cf.subscriptions.status === 200
        ? ok(cf.subscriptions.result)
        : refused(cf.subscriptions.status);
    if (
      method === 'GET' &&
      path === `/accounts/${ACCOUNT}/workers/durable_objects/namespaces`
    )
      return ok(cf.namespaces, { total_count: cf.namespaces.length });
    if (method === 'GET' && path === `/accounts/${ACCOUNT}/workers/scripts`)
      return ok(cf.workers);
    if (method === 'GET' && path === `${script}/settings`)
      return ok({ bindings: cf.bindings });
    if (method === 'GET' && path === `${script}/deployments`)
      return ok({ deployments: [{ id: 'd-1', versions: cf.serving }] });
    if (method === 'GET' && path === `${script}/schedules`)
      return ok({ schedules: cf.schedules });
    if (method === 'POST' && path === `${script}/versions`) {
      const form = init.body as FormData;
      cf.uploads.push({
        metadata: JSON.parse(String(form.get('metadata'))),
        module: await (form.get('paused.js') as Blob).text(),
      });
      return ok({ id: `v-paused-${cf.uploads.length}` });
    }
    if (method === 'POST' && path === `${script}/deployments`) {
      const body = JSON.parse(String(init.body));
      cf.deploys.push({ ...body, force: url.searchParams.get('force') });
      cf.serving = body.versions;
      return ok({ id: crypto.randomUUID() });
    }
    if (method === 'PUT' && path === `${script}/schedules`) {
      const body = JSON.parse(String(init.body));
      cf.scheduleWrites.push(body);
      cf.schedules = body;
      return ok({ schedules: body });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }
  return { cf, handler };
}

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let projectId: string;
let fake: ReturnType<typeof fakeCloudflare>;

const call = async (
  path: string,
  init: RequestInit = {},
  cookie: string | undefined = who.cookie,
) => {
  const response = await db.request(
    `/projects/${projectId}${path}`,
    init,
    cookie,
  );
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (await response.json()) as Record<string, any>,
  };
};
const setBudget = (
  monthlyCents: number,
  onExceed: 'alert' | 'pause',
  cookie?: string,
) =>
  call(
    '/budget',
    { method: 'PUT', body: JSON.stringify({ monthlyCents, onExceed }) },
    cookie,
  );
const confirmed = (path: string, cookie?: string) =>
  call(
    path,
    {
      method: 'POST',
      body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
    },
    cookie,
  );
const check = () =>
  db.sqlite
    .prepare('SELECT * FROM budget_checks WHERE project_id=?')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .get(projectId) as Record<string, any>;
// What the project's webhook was sent, in order.
const sent = () =>
  (
    db.sqlite
      .prepare(
        'SELECT event, payload_json FROM webhook_deliveries ORDER BY created_at, rowid',
      )
      .all() as { event: string; payload_json: string }[]
  ).map((d) => ({ event: d.event, text: JSON.parse(d.payload_json).text }));
// Moves the last reading back in time, so the next scheduled run reads again.
const later = (seconds = 301) =>
  db.sqlite
    .prepare(
      'UPDATE budget_checks SET checked_at=checked_at-?, read_at=read_at-?',
    )
    .run(seconds, seconds);

// A runaway Durable Object: 41 million requests and alarms (40 million past what Workers
// Paid includes, $6.00) and 150 million rows written (100 million past it, $100.00).
function runaway(requests = 41_000_000, rowsWritten = 150_000_000) {
  fake.cf.datasets.durableObjectsInvocationsAdaptiveGroups = [
    {
      sum: { requests },
      dimensions: { namespaceId: 'ns-loop', date: TODAY },
    },
  ];
  fake.cf.datasets.durableObjectsPeriodicGroups = [
    {
      sum: { rowsRead: 1000, rowsWritten },
      dimensions: { namespaceId: 'ns-loop', date: TODAY },
    },
  ];
}

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput(WORKER)) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  db.sqlite
    .prepare(
      "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,worker_tag,idempotency_key,created_at,updated_at,adapter,environment) VALUES ('job-1',?,?,?,'','',?,'','','','','',?,'','deployed','finished',?,'upload:1',?,?,'direct-upload','production')",
    )
    .run(
      who.workspaceId,
      projectId,
      who.userId,
      ACCOUNT,
      WORKER,
      TAG,
      now(),
      now(),
    );
  fake = fakeCloudflare();
  vi.stubGlobal('fetch', vi.fn(fake.handler));
  // The webhook asked only for deployments: budget events go to it anyway.
  await call('/notifications', {
    method: 'PUT',
    body: JSON.stringify({
      url: 'https://hooks.example.com/budget',
      events: ['deployment.ready'],
    }),
  });
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('estimates', () => {
  const row = (
    meter: UsageRow['meter'],
    resource: string,
    count: number,
    date = TODAY,
  ): UsageRow => ({ meter, resource, date, count });

  it('prices what the account used beyond what Workers Paid includes, shared by use', () => {
    const rows = [
      row('do.requests', 'ns-loop', 31_000_000),
      row('do.requests', 'ns-other', 10_000_000),
      row('workers.requests', WORKER, 5_000_000),
      // Another app's KV reads: the account pays for them, this project doesn't.
      row('kv.reads', 'kv-not-mine', 20_000_000),
    ];
    const mine = (_meter: string, resource: string) =>
      resource === 'ns-loop' || resource === WORKER;
    const result = estimate('paid', rows, mine);
    // 40 million requests past the 1 million included, at $0.15 a million: $6.00, three
    // quarters of it this project's. Worker requests stay within the 10 million included.
    // The account also pays $5.00 for 10 million KV reads past those included.
    expect(result.accountCents).toBe(1100);
    expect(result.cents).toBe(454);
    expect(result.meters).toEqual([
      expect.objectContaining({
        meter: 'workers.requests',
        mine: 5_000_000,
        cents: 0,
      }),
      expect.objectContaining({
        meter: 'do.requests',
        mine: 31_000_000,
        account: 41_000_000,
        included: 1_000_000,
        cents: 454,
      }),
    ]);
    // An unknown plan is estimated as Workers Paid.
    expect(estimate('unknown', rows, mine).cents).toBe(454);
  });

  it('prices containers beyond what Workers Paid includes: CPU time, memory and disk', () => {
    // A basic instance (1/4 vCPU, 1 GiB, 4 GB) awake all of a 31-day month, busy a tenth of it.
    const month = 31 * 24 * 3600;
    const rows = [
      row('containers.cpu', 'app-1', 0.25 * month * 0.1),
      row('containers.memory', 'app-1', month),
      row('containers.disk', 'app-1', 4 * month),
    ];
    const result = estimate('paid', rows, () => true);
    // Past 375 vCPU-minutes at $0.000020 a vCPU-second: $0.89; past 25 GiB-hours at
    // $0.0000025 a GiB-second: $6.47; past 200 GB-hours at $0.00000007 a GB-second: $0.70.
    expect(result.meters.map((m) => [m.meter, m.included, m.cents])).toEqual([
      ['containers.cpu', 22_500, 89],
      ['containers.memory', 90_000, 647],
      ['containers.disk', 720_000, 70],
    ]);
    expect(result.cents).toBe(806);
    // Workers Free has no containers: any use of them shows the account is on Workers Paid.
    expect(estimate('free', rows, () => true)).toMatchObject({
      overFree: true,
      cents: 806,
    });
  });

  it('charges nothing on Workers Free except R2, which bills beyond its own free tier', () => {
    const rows = [
      row('do.rowsWritten', 'ns-loop', 99_000),
      row('kv.writes', 'kv-1', 1_000),
      row('r2.classA', 'bucket-mine', 3_000_000),
    ];
    const result = estimate('free', rows, () => true);
    expect(result.overFree).toBe(false);
    // 2 million Class A operations past the 1 million free, at $4.50 a million.
    expect(result.cents).toBe(900);
    expect(result.meters.map((m) => [m.meter, m.cents])).toEqual([
      ['do.rowsWritten', 0],
      ['kv.writes', 0],
      ['r2.classA', 900],
    ]);
  });

  it('takes a day clearly past a Workers Free limit as proof of Workers Paid', () => {
    // Sampled analytics: up to a quarter past the limit isn't proof.
    expect(
      estimate('free', [row('workers.requests', WORKER, 125_000)], () => true)
        .overFree,
    ).toBe(false);
    expect(
      estimate('free', [row('workers.requests', WORKER, 125_001)], () => true)
        .overFree,
    ).toBe(true);
    // Two days under the limit don't add up to one over it.
    expect(
      estimate(
        'free',
        [
          row('workers.requests', WORKER, 90_000, '2026-10-01'),
          row('workers.requests', WORKER, 90_000, '2026-10-02'),
        ],
        () => true,
      ).overFree,
    ).toBe(false);
    // A free account past a limit is charged as if on Workers Paid.
    const past = estimate(
      'free',
      [row('do.requests', 'ns-loop', 2_000_000)],
      () => true,
    );
    expect(past).toMatchObject({ overFree: true, cents: 15 });
  });

  it('prices the key-value backend’s operations, which only Workers Paid has', () => {
    const result = estimate(
      'free',
      [row('do.writeUnits', 'ns-loop', 3_000_000)],
      () => true,
    );
    // Any of them shows the account is on Workers Paid: 2 million past the 1 million included.
    expect(result).toMatchObject({ overFree: true, cents: 200 });
  });

  it('follows the month day by day: this project’s use, and what it had cost by each day', () => {
    expect(monthDays('2026-10-03')).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    const rows = [
      row('do.requests', 'ns-loop', 600_000, '2026-10-01'),
      row('do.requests', 'ns-other', 400_000, '2026-10-01'),
      row('do.requests', 'ns-loop', 3_000_000, '2026-10-03'),
      row('kv.reads', 'kv-not-mine', 5, '2026-10-02'),
      // Outside the days asked for.
      row('do.requests', 'ns-loop', 9, '2026-09-30'),
    ];
    const daily = dailySeries(
      'paid',
      rows,
      (_meter, resource) => resource === 'ns-loop',
      monthDays('2026-10-03'),
    );
    expect(daily.meters).toEqual({
      'do.requests': [600_000, 0, 3_000_000],
    });
    // Within the 1 million included until the third, then 3 million past it at $0.15, this
    // project's share 3.6 of 4 million.
    expect(daily.cents).toEqual([0, 0, 41]);
    expect(daily.days).toHaveLength(3);
  });

  it('alerts on levels of the budget', () => {
    expect(levelFor(0, 0)).toBe(0);
    expect(levelFor(1, 0)).toBe(100);
    expect(levelFor(49, 100)).toBe(0);
    expect(levelFor(50, 100)).toBe(50);
    expect(levelFor(79, 100)).toBe(50);
    expect(levelFor(80, 100)).toBe(80);
    expect(levelFor(100, 100)).toBe(80);
    expect(levelFor(101, 100)).toBe(100);
  });
});

describe('reading usage', () => {
  it('asks once per product for the month so far, and keeps what one failing product costs', async () => {
    fake.cf.datasets.workersInvocationsAdaptive = [
      { sum: { requests: 7 }, dimensions: { scriptName: WORKER, date: TODAY } },
      // Nothing to price: no name, no day, nothing counted.
      { sum: { requests: 3 }, dimensions: { date: TODAY } },
      { sum: { requests: 3 }, dimensions: { scriptName: WORKER } },
      { sum: { requests: 0 }, dimensions: { scriptName: 'idle', date: TODAY } },
    ];
    // Running time as Cloudflare bills it (GB-s), and the key-value backend's operations.
    fake.cf.datasets.durableObjectsPeriodicGroups = [
      {
        sum: {
          rowsRead: 5,
          rowsWritten: 6,
          duration: 1000,
          storageReadUnits: 7,
          storageWriteUnits: 8,
          storageDeletes: 9,
        },
        dimensions: { namespaceId: 'ns-loop', date: TODAY },
      },
    ];
    fake.cf.datasets.kvOperationsAdaptiveGroups = [
      {
        sum: { requests: 3 },
        dimensions: { namespaceId: 'kv-1', actionType: 'write', date: TODAY },
      },
      {
        sum: { requests: 4 },
        dimensions: {
          namespaceId: 'kv-1',
          actionType: 'mystery',
          date: TODAY,
        },
      },
    ];
    fake.cf.datasets.r2OperationsAdaptiveGroups = [
      {
        sum: { requests: 2 },
        dimensions: {
          bucketName: 'bucket-mine',
          actionType: 'PutObject',
          date: TODAY,
        },
      },
      {
        sum: { requests: 9 },
        dimensions: {
          bucketName: 'bucket-mine',
          actionType: 'GetObject',
          date: TODAY,
        },
      },
    ];
    fake.cf.datasets.d1AnalyticsAdaptiveGroups = {
      error: 'unknown field "rowsWritten"',
    };
    // Containers as Cloudflare bills them: CPU seconds, and memory and disk allocated, in
    // byte-seconds (3 GiB and 4 GB for an hour).
    fake.cf.datasets.containersUsageAdaptiveGroups = [
      {
        sum: {
          cpuTimeSec: 120,
          allocatedMemory: 3 * 1024 ** 3 * 3600,
          allocatedDisk: 4e9 * 3600,
        },
        dimensions: { applicationId: 'app-1', date: TODAY },
      },
    ];
    const usage = await readUsage('token', ACCOUNT, MONTH_START, TODAY);
    expect(fake.cf.queries.map((q) => q.dataset).sort()).toEqual([
      'containersUsageAdaptiveGroups',
      'd1AnalyticsAdaptiveGroups',
      'durableObjectsInvocationsAdaptiveGroups',
      'durableObjectsPeriodicGroups',
      'durableObjectsPeriodicGroups',
      'kvOperationsAdaptiveGroups',
      'r2OperationsAdaptiveGroups',
      'workersInvocationsAdaptive',
    ]);
    for (const q of fake.cf.queries)
      expect(q.variables).toEqual({
        account: ACCOUNT,
        since: MONTH_START,
        until: TODAY,
      });
    expect(usage.missing).toEqual([
      {
        meters: ['d1.rowsRead', 'd1.rowsWritten'],
        reason: 'unknown field "rowsWritten"',
      },
    ]);
    expect(
      usage.rows.map((r) => [r.meter, r.resource, r.count]).sort(),
    ).toEqual(
      [
        ['workers.requests', WORKER, 7],
        ['do.rowsRead', 'ns-loop', 5],
        ['do.rowsWritten', 'ns-loop', 6],
        ['do.duration', 'ns-loop', 1000],
        ['do.readUnits', 'ns-loop', 7],
        ['do.writeUnits', 'ns-loop', 8],
        ['do.deletes', 'ns-loop', 9],
        ['kv.writes', 'kv-1', 3],
        ['r2.classA', 'bucket-mine', 2],
        ['r2.classB', 'bucket-mine', 9],
        ['containers.cpu', 'app-1', 120],
        ['containers.memory', 'app-1', 10_800],
        ['containers.disk', 'app-1', 14_400],
      ].sort(),
    );
  });

  it('reads the plan from billing, and says when it may not', async () => {
    expect(await detectPlan('token', ACCOUNT)).toMatchObject({
      plan: 'unknown',
      source: 'no-permission',
    });
    fake.cf.subscriptions = {
      status: 200,
      result: [
        {
          state: 'Paid',
          price: 20,
          rate_plan: { id: 'pro', public_name: 'Pro Plan' },
        },
      ],
    };
    expect(await detectPlan('token', ACCOUNT)).toMatchObject({
      plan: 'free',
      source: 'subscriptions',
    });
    fake.cf.subscriptions.result.push({
      state: 'Paid',
      price: 5,
      rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' },
    });
    expect(await detectPlan('token', ACCOUNT)).toEqual({
      plan: 'paid',
      source: 'subscriptions',
      detail: 'Workers Paid',
    });
  });
});

describe('the stand-in a paused app serves', () => {
  it('keeps every Durable Object class, ends alarms, answers 503 and puts off queue messages', () => {
    const module = pausedModule(['Room', 'Ticker', 'Room']);
    expect(module.match(/export class (\w+) extends DurableObject/g)).toEqual([
      'export class Room extends DurableObject',
      'export class Ticker extends DurableObject',
    ]);
    expect(module).toContain('alarm() {}');
    expect(module).toContain('status: 503');
    expect(module).toContain("'Retry-After': '3600'");
    expect(module).toContain('scheduled() {}');
    expect(module).toContain('batch.retryAll({ delaySeconds: 43200 })');
    expect(() => pausedModule(['Bad name'])).toThrow(/class name/);
    expect(() => pausedModule(['x(){}};fetch("evil")//'])).toThrow(
      /class name/,
    );
  });
});

describe('the guard', () => {
  it('alerts by default, with a $0 budget, and leaves the app running', async () => {
    runaway();
    await scheduledBudgets(db.env);
    // Without Billing Read the plan is unknown; a day of 41 million requests shows it's Paid.
    expect(check()).toMatchObject({
      state: 'over',
      level: 100,
      plan: 'paid',
      estimate_cents: 10600,
      account_cents: 10600,
      error: null,
    });
    expect(sent()).toEqual([
      {
        event: 'budget.alert',
        text: `${WORKER} is over its budget: an estimated $106.00 this month beyond what Cloudflare includes, against a $0.00 budget. It keeps running: this project only sends alerts.`,
      },
    ]);
    expect(fake.cf.uploads).toEqual([]);
    expect(fake.cf.deploys).toEqual([]);
    // Read every five minutes, and an alert once per level.
    const queries = fake.cf.queries.length;
    await scheduledBudgets(db.env);
    expect(fake.cf.queries.length).toBe(queries);
    later();
    await scheduledBudgets(db.env);
    expect(fake.cf.queries.length).toBeGreaterThan(queries);
    expect(sent()).toHaveLength(1);
    const view = await call('/budget');
    // Day by day: today holds the month so far.
    const days = monthDays(TODAY);
    expect(view.body.check.daily).toEqual({
      days,
      meters: {
        'do.requests': days.map((d) => (d === TODAY ? 41_000_000 : 0)),
        'do.rowsRead': days.map((d) => (d === TODAY ? 1000 : 0)),
        'do.rowsWritten': days.map((d) => (d === TODAY ? 150_000_000 : 0)),
      },
      cents: days.map((d) => (d === TODAY ? 10600 : 0)),
    });
    expect(view.body.limits['do.requests']).toEqual({
      included: 1_000_000,
      freeDaily: 100_000,
    });
    expect(view.body).toMatchObject({
      budget: { monthlyCents: 0, onExceed: 'alert' },
      deployed: true,
      webhook: true,
      check: {
        state: 'over',
        estimateCents: 10600,
        meters: [
          expect.objectContaining({ meter: 'do.requests', cents: 600 }),
          expect.objectContaining({ meter: 'do.rowsRead', cents: 0 }),
          expect.objectContaining({
            meter: 'do.rowsWritten',
            label: 'Durable Object rows written',
            mine: 150_000_000,
            account: 150_000_000,
            included: 50_000_000,
            cents: 10000,
          }),
        ],
      },
    });
    const listed = (await (
      await db.request('/projects', {}, who.cookie)
    ).json()) as { budget: string | null }[];
    expect(listed[0].budget).toBe('over');
  });

  it('counts the account’s containers toward the projects that deploy containers', async () => {
    // A basic instance's memory for a 31-day month: $6.47 past what Workers Paid includes.
    fake.cf.datasets.containersUsageAdaptiveGroups = [
      {
        sum: {
          cpuTimeSec: 0,
          allocatedMemory: 31 * 24 * 3600 * 1024 ** 3,
          allocatedDisk: 0,
        },
        dimensions: { applicationId: 'app-1', date: TODAY },
      },
    ];
    await scheduledBudgets(db.env);
    // This project is a direct upload, which runs no containers: the account pays, it doesn't.
    expect(check()).toMatchObject({ estimate_cents: 0, account_cents: 647 });
    // Cloudflare's analytics don't say which app a container belongs to, so a project that
    // deploys containers counts all of the account's: it is alerted early, never late.
    db.sqlite.prepare("UPDATE deployment_jobs SET adapter='container'").run();
    later();
    await scheduledBudgets(db.env);
    expect(check()).toMatchObject({ estimate_cents: 647, state: 'over' });
  });

  it('pauses an app over a budget whose owner chose that, keeping what it needs to resume', async () => {
    expect((await setBudget(5000, 'pause')).status).toBe(200);
    runaway();
    await scheduledBudgets(db.env);
    expect(fake.cf.uploads).toHaveLength(1);
    const [upload] = fake.cf.uploads;
    expect(upload.metadata).toEqual({
      main_module: 'paused.js',
      compatibility_date: '2025-09-01',
      bindings: [],
      keep_bindings: ['secret_text', 'secret_key'],
      annotations: { 'workers/message': 'Paused by Shipcel: over budget' },
    });
    // The namespace's class and the bound one; not another Worker's.
    expect(upload.module).toContain('export class Room extends DurableObject');
    expect(upload.module).toContain(
      'export class Ticker extends DurableObject',
    );
    expect(upload.module).not.toContain('class Other');
    expect(fake.cf.deploys).toEqual([
      {
        strategy: 'percentage',
        versions: [{ version_id: 'v-paused-1', percentage: 100 }],
        annotations: { 'workers/message': 'Paused by Shipcel: over budget' },
        force: 'false',
      },
    ]);
    expect(fake.cf.scheduleWrites).toEqual([[]]);
    expect(check()).toMatchObject({
      state: 'paused',
      paused_version: 'v-paused-1',
      paused_from_json: JSON.stringify([
        { version_id: 'v-live', percentage: 100 },
      ]),
      paused_schedules_json: JSON.stringify([{ cron: '*/5 * * * *' }]),
    });
    expect(
      db.sqlite
        .prepare('SELECT kind, status, user_id FROM project_operations')
        .all(),
    ).toEqual([
      { kind: 'budget.pause', status: 'succeeded', user_id: 'budget-guard' },
    ]);
    expect(sent().map((s) => s.event)).toEqual([
      'budget.alert',
      'budget.paused',
    ]);
    expect(sent()[0].text).toContain('Shipcel is pausing it.');
    expect(sent()[1].text).toContain(
      'Its data is kept and its schedules are off',
    );
    const listed = (await (
      await db.request('/projects', {}, who.cookie)
    ).json()) as { budget: string | null }[];
    expect(listed[0].budget).toBe('paused');
    // Still paused at the next reading: nothing more is changed.
    later();
    await scheduledBudgets(db.env);
    expect(fake.cf.uploads).toHaveLength(1);
    expect(fake.cf.deploys).toHaveLength(1);
  });

  it('refuses production changes while paused, and resumes once the budget allows', async () => {
    await setBudget(5000, 'pause');
    runaway();
    await scheduledBudgets(db.env);
    const rollback = await call('/rollback', {
      method: 'POST',
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        confirm: true,
        versionId: crypto.randomUUID(),
      }),
    });
    expect(rollback.status).toBe(409);
    expect(rollback.body.error).toMatch(/paused for going over its budget/);
    // Over a budget that pauses: resuming would only pause it again.
    const early = await confirmed('/budget/resume');
    expect(early.status).toBe(409);
    expect(early.body.error).toContain(
      'estimate ($106.00) is over the budget ($50.00)',
    );
    expect(fake.cf.deploys).toHaveLength(1);
    await setBudget(5000, 'alert');
    const resumed = await confirmed('/budget/resume');
    expect(resumed.status).toBe(200);
    expect(fake.cf.deploys.at(-1)).toEqual({
      strategy: 'percentage',
      versions: [{ version_id: 'v-live', percentage: 100 }],
      annotations: { 'workers/message': 'Resumed in Shipcel' },
      force: 'false',
    });
    expect(fake.cf.scheduleWrites.at(-1)).toEqual([{ cron: '*/5 * * * *' }]);
    expect(check()).toMatchObject({
      state: 'over',
      paused_version: null,
      paused_from_json: null,
    });
    expect(resumed.body.check.state).toBe('over');
    expect(sent().at(-1)).toEqual({
      event: 'budget.resumed',
      text: `${WORKER} was resumed by user-1.`,
    });
    // Alerts only now: the next reading leaves it running.
    later();
    await scheduledBudgets(db.env);
    expect(fake.cf.uploads).toHaveLength(1);
    expect((await confirmed('/budget/resume')).status).toBe(409);
  });

  it('refuses every change to what production serves while paused, not previews', async () => {
    expect((await confirmed('/budget/pause')).status).toBe(200);
    const body = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        requestId: crypto.randomUUID(),
        confirm: true,
        ...extra,
      });
    const attempts: [string, RequestInit][] = [
      ['/redeploy', { method: 'POST', body: body() }],
      [
        '/rollback',
        { method: 'POST', body: body({ versionId: crypto.randomUUID() }) },
      ],
      [
        '/traffic',
        {
          method: 'POST',
          body: body({
            versions: [
              { versionId: crypto.randomUUID(), percentage: 10 },
              { versionId: crypto.randomUUID(), percentage: 90 },
            ],
          }),
        },
      ],
      ['/secrets', { method: 'PUT', body: body({ name: 'KEY', value: 'x' }) }],
      ['/secrets/KEY', { method: 'DELETE', body: body() }],
      ['/schedules', { method: 'PUT', body: body({ crons: [] }) }],
      ['/uploads/upload-1/deploy', { method: 'POST', body: body() }],
      ['/deployments', { method: 'POST', body: '{}' }],
    ];
    for (const [path, init] of attempts) {
      const refused = await call(path, init);
      expect(refused.status, path).toBe(409);
      expect(refused.body.error, path).toContain(
        'paused for going over its budget',
      );
    }
    // A local deploy's review lists it for production, not for a preview.
    const files = {
      'package.json': '{"name":"app"}',
      'wrangler.jsonc': JSON.stringify({
        name: WORKER,
        main: 'src/index.js',
        compatibility_date: '2026-10-07',
      }),
    };
    const review = async (production: boolean) =>
      (
        await call('/local-plan', {
          method: 'POST',
          body: JSON.stringify({ files, production }),
        })
      ).body.issues as string[];
    expect(await review(true)).toContainEqual(
      expect.stringContaining('paused for going over its budget'),
    );
    expect(await review(false)).not.toContainEqual(
      expect.stringContaining('paused for going over its budget'),
    );
    const preview = await call('/uploads/upload-1/deploy', {
      method: 'POST',
      body: body({ preview: true }),
    });
    expect(preview.body.error ?? '').not.toContain('paused for going over');
  });

  it('pauses again an app deployed while paused, or notes one that may run again', async () => {
    await setBudget(5000, 'pause');
    runaway();
    await scheduledBudgets(db.env);
    // A push build or a Wrangler deploy outside Shipcel.
    fake.cf.serving = [{ version_id: 'v-new', percentage: 100 }];
    later();
    await scheduledBudgets(db.env);
    expect(fake.cf.uploads).toHaveLength(2);
    expect(check()).toMatchObject({
      state: 'paused',
      paused_version: 'v-paused-2',
      paused_from_json: JSON.stringify([
        { version_id: 'v-new', percentage: 100 },
      ]),
    });
    expect(sent().at(-1)?.text).toContain(
      'It had been deployed again while paused.',
    );
    await setBudget(5000, 'alert');
    fake.cf.serving = [{ version_id: 'v-newer', percentage: 100 }];
    later();
    await scheduledBudgets(db.env);
    expect(fake.cf.uploads).toHaveLength(2);
    expect(check()).toMatchObject({ state: 'over', paused_version: null });
    expect(sent().at(-1)).toEqual({
      event: 'budget.resumed',
      text: `${WORKER} is running again: a new version was deployed while it was paused.`,
    });
  });

  it('never pauses a Worker that isn’t the one Shipcel deployed, and says so once', async () => {
    await setBudget(0, 'pause');
    runaway();
    fake.cf.workers = [{ id: WORKER, tag: 'e'.repeat(32) }];
    await scheduledBudgets(db.env);
    expect(fake.cf.uploads).toEqual([]);
    expect(check()).toMatchObject({ state: 'over' });
    expect(check().error).toContain(
      'Couldn’t pause the app: The Worker identity changed',
    );
    expect(sent().map((s) => s.text)).toEqual([
      expect.stringContaining('Shipcel is pausing it.'),
      expect.stringContaining(
        'is over its budget and still running. Couldn’t pause the app',
      ),
    ]);
    later();
    await scheduledBudgets(db.env);
    expect(sent()).toHaveLength(2);
  });

  it('alerts when it can’t read usage, at most once a day', async () => {
    fake.cf.analyticsStatus = 403;
    await scheduledBudgets(db.env);
    expect(check().error).toContain('Account Analytics Read');
    expect(sent()).toEqual([
      {
        event: 'budget.alert',
        text: expect.stringContaining(
          `The budget guard can’t read ${WORKER}’s usage from Cloudflare, so it can’t alert or pause`,
        ),
      },
    ]);
    later();
    await scheduledBudgets(db.env);
    expect(sent()).toHaveLength(1);
    db.sqlite
      .prepare(
        'UPDATE budget_checks SET error_alerted_at=error_alerted_at-86401',
      )
      .run();
    later();
    await scheduledBudgets(db.env);
    expect(sent()).toHaveLength(2);
    // Readable again: the error goes.
    fake.cf.analyticsStatus = 200;
    later();
    await scheduledBudgets(db.env);
    expect(check()).toMatchObject({ error: null, state: 'ok' });
  });

  it('knows Workers Free stops at its limits, but R2 bills on any plan', async () => {
    fake.cf.subscriptions = { status: 200, result: [] };
    fake.cf.datasets.workersInvocationsAdaptive = [
      {
        sum: { requests: 90_000 },
        dimensions: { scriptName: WORKER, date: TODAY },
      },
    ];
    await scheduledBudgets(db.env);
    expect(check()).toMatchObject({
      plan: 'free',
      estimate_cents: 0,
      state: 'ok',
    });
    expect(sent()).toEqual([]);
    fake.cf.datasets.r2OperationsAdaptiveGroups = [
      {
        sum: { requests: 3_000_000 },
        dimensions: {
          bucketName: 'bucket-mine',
          actionType: 'PutObject',
          date: TODAY,
        },
      },
    ];
    later();
    await scheduledBudgets(db.env);
    expect(check()).toMatchObject({
      plan: 'free',
      estimate_cents: 900,
      state: 'over',
    });
    // A day far past a free limit: the account is on Workers Paid after all.
    fake.cf.datasets.workersInvocationsAdaptive = [
      {
        sum: { requests: 200_000 },
        dimensions: { scriptName: WORKER, date: TODAY },
      },
    ];
    later();
    await scheduledBudgets(db.env);
    expect(
      db.sqlite.prepare('SELECT plan, source FROM account_plans').get(),
    ).toEqual({ plan: 'paid', source: 'usage' });
    expect(check().plan).toBe('paid');
    // Billing is read once a day, not at every reading.
    expect(fake.cf.subscriptionCalls).toBe(1);
  });

  it('reads the plan only with the Billing Read permission', async () => {
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET scopes='account-settings.read workers-scripts.write account-analytics.read'",
      )
      .run();
    await scheduledBudgets(db.env);
    expect(
      db.sqlite.prepare('SELECT plan, source FROM account_plans').get(),
    ).toEqual({ plan: 'unknown', source: 'no-permission' });
    expect(fake.cf.subscriptionCalls).toBe(0);
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET scopes='account-settings.read billing.read'",
      )
      .run();
    db.sqlite.prepare('UPDATE account_plans SET checked_at=0').run();
    fake.cf.subscriptions = { status: 200, result: [] };
    later();
    await scheduledBudgets(db.env);
    expect(fake.cf.subscriptionCalls).toBe(1);
    expect(check().plan).toBe('free');
  });

  it('keeps an account on Workers Paid once its usage showed it, whatever billing says', async () => {
    db.sqlite
      .prepare(
        "INSERT INTO account_plans(workspace_id,account_id,plan,source,detail,checked_at) VALUES (?,?,'paid','usage',NULL,0)",
      )
      .run(who.workspaceId, ACCOUNT);
    fake.cf.subscriptions = { status: 200, result: [] };
    await scheduledBudgets(db.env);
    expect(fake.cf.subscriptionCalls).toBe(1);
    expect(check().plan).toBe('paid');
  });

  it('reads nothing with a connection to another Cloudflare account', async () => {
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET account_id=? WHERE provider='cloudflare'",
      )
      .run('b'.repeat(32));
    runaway();
    await scheduledBudgets(db.env);
    expect(fake.cf.queries).toEqual([]);
    expect(check().error).toBe(
      'Cloudflare isn’t connected to this project’s account in Shipcel. Reconnect it in Connections.',
    );
    expect(sent().map((s) => s.event)).toEqual(['budget.alert']);
  });

  it('says nothing of a short outage after a good reading', async () => {
    await scheduledBudgets(db.env);
    expect(check()).toMatchObject({ error: null, state: 'ok' });
    fake.cf.analyticsStatus = 403;
    later();
    await scheduledBudgets(db.env);
    expect(check().error).toContain('Account Analytics Read');
    expect(sent()).toEqual([]);
    later(3600);
    await scheduledBudgets(db.env);
    expect(sent()).toHaveLength(1);
  });

  it('warns when the rate of the last few minutes would go over by the end of the month', async () => {
    // The projection runs to the end of the month, so this is pinned to the month's 10th: in
    // its last days, no rate of the last few minutes would go over (it failed on 28 Oct).
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${MONTH_START.slice(0, 8)}10T12:00:00Z`));
    await setBudget(1_000_000, 'alert');
    runaway(1_000_000, 51_000_000);
    await scheduledBudgets(db.env);
    expect(check()).toMatchObject({ estimate_cents: 100, level: 0 });
    expect(sent()).toEqual([]);
    runaway(1_000_000, 60_000_000);
    later();
    await scheduledBudgets(db.env);
    expect(check().estimate_cents).toBe(1000);
    expect(check().projected_cents).toBeGreaterThan(1_000_000);
    expect(sent()).toEqual([
      {
        event: 'budget.alert',
        text: expect.stringContaining(
          `${WORKER} is on course to go over its budget: at the rate of the last few minutes`,
        ),
      },
    ]);
    runaway(1_000_000, 70_000_000);
    later();
    await scheduledBudgets(db.env);
    expect(sent()).toHaveLength(1);
  });

  it('alerts at half the budget and four fifths of it, then over it', async () => {
    await setBudget(10_000, 'alert');
    runaway(1_000_000, 101_000_000);
    await scheduledBudgets(db.env);
    runaway(1_000_000, 131_000_000);
    later(3600);
    await scheduledBudgets(db.env);
    runaway(1_000_000, 151_000_000);
    later(3600);
    await scheduledBudgets(db.env);
    expect(
      sent()
        .filter((s) => !s.text.includes('on course'))
        .map((s) => s.text.replace(/: an estimated.*/, '')),
    ).toEqual([
      `${WORKER} has used 50% of its budget`,
      `${WORKER} has used 80% of its budget`,
      `${WORKER} is over its budget`,
    ]);
    // A higher budget: alerts start again from where the estimate stands against it.
    await setBudget(20_000, 'alert');
    expect(check()).toMatchObject({ level: 50, state: 'ok' });
  });
});

describe('budget settings', () => {
  it('defaults to $0 beyond what Cloudflare includes, alerts only', async () => {
    const view = await call('/budget');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      budget: { monthlyCents: 0, onExceed: 'alert' },
      deployed: true,
      check: null,
    });
  });

  it('takes whole cents up to $100,000 and a known action', async () => {
    for (const body of [
      { monthlyCents: -1, onExceed: 'alert' },
      { monthlyCents: 10_000_001, onExceed: 'alert' },
      { monthlyCents: 1.5, onExceed: 'alert' },
      { monthlyCents: 100, onExceed: 'shutdown' },
      { monthlyCents: 100 },
      { monthlyCents: 100, onExceed: 'alert', extra: true },
    ])
      expect(
        (await call('/budget', { method: 'PUT', body: JSON.stringify(body) }))
          .status,
        JSON.stringify(body),
      ).toBe(400);
    const saved = await setBudget(2500, 'pause');
    expect(saved.status).toBe(200);
    expect(saved.body.budget).toEqual({
      monthlyCents: 2500,
      onExceed: 'pause',
    });
  });

  it('leaves budgets, pauses and resumes to owners in the dashboard', async () => {
    const developer = await db.user(2, 'developer');
    db.sqlite
      .prepare('INSERT INTO memberships VALUES (?,?,?)')
      .run(who.workspaceId, developer.userId, 'developer');
    db.sqlite
      .prepare('UPDATE sessions SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, developer.userId);
    expect((await setBudget(9900, 'alert', developer.cookie)).status).toBe(403);
    expect((await confirmed('/budget/pause', developer.cookie)).status).toBe(
      403,
    );
    expect((await call('/budget', {}, developer.cookie)).status).toBe(200);
    // An API token, even an owner's (an agent's, a script's), can read and check, not change.
    const token = (
      (await (
        await db.request(
          '/tokens',
          { method: 'POST', body: JSON.stringify({ name: 'Agent' }) },
          who.cookie,
        )
      ).json()) as { token: string }
    ).token;
    const bearer = (path: string, init: RequestInit = {}) =>
      app.request(
        `https://shipcel.test/api/projects/${projectId}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          },
        },
        db.env,
      );
    const raised = await bearer('/budget', {
      method: 'PUT',
      body: JSON.stringify({ monthlyCents: 10_000_000, onExceed: 'alert' }),
    });
    expect(raised.status).toBe(403);
    expect(((await raised.json()) as { error: string }).error).toBe(
      'API tokens can’t do this. Use the Shipcel dashboard.',
    );
    for (const action of ['/budget/pause', '/budget/resume'])
      expect(
        (
          await bearer(action, {
            method: 'POST',
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              confirm: true,
            }),
          })
        ).status,
      ).toBe(403);
    expect((await bearer('/budget')).status).toBe(200);
    runaway();
    expect((await bearer('/budget/check', { method: 'POST' })).status).toBe(
      200,
    );
    expect(check().estimate_cents).toBe(10600);
    expect(db.sqlite.prepare('SELECT * FROM project_budgets').all()).toEqual(
      [],
    );
  });

  it('lets an owner pause an app at once, whatever the estimate', async () => {
    const paused = await confirmed('/budget/pause');
    expect(paused.status).toBe(200);
    expect(paused.body.check.state).toBe('paused');
    expect(fake.cf.uploads).toHaveLength(1);
    expect(sent().at(-1)).toEqual({
      event: 'budget.paused',
      text: `${WORKER} was paused by user-1.`,
    });
    expect((await confirmed('/budget/pause')).status).toBe(409);
    // $0 this month: it can be resumed even with the default budget.
    const resumed = await confirmed('/budget/resume');
    expect(resumed.status).toBe(200);
    expect(fake.cf.serving).toEqual([
      { version_id: 'v-live', percentage: 100 },
    ]);
  });

  it('checks now on request, a few times a minute', async () => {
    runaway();
    const first = await call('/budget/check', { method: 'POST' });
    expect(first.status).toBe(200);
    expect(first.body.check.estimateCents).toBe(10600);
    await call('/budget/check', { method: 'POST' });
    await call('/budget/check', { method: 'POST' });
    expect((await call('/budget/check', { method: 'POST' })).status).toBe(429);
  });

  it('has nothing to check or pause before the first deploy', async () => {
    db.sqlite.prepare('DELETE FROM deployment_jobs').run();
    expect((await call('/budget')).body.deployed).toBe(false);
    expect((await call('/budget/check', { method: 'POST' })).status).toBe(409);
    expect((await confirmed('/budget/pause')).status).toBe(409);
    await scheduledBudgets(db.env);
    expect(fake.cf.queries).toEqual([]);
  });
});
