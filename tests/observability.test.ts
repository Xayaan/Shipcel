import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';

// Manage → Observability: request analytics from Cloudflare's GraphQL Analytics API
// (workersInvocationsAdaptive) and recent logs from Workers Logs (telemetry/query).
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const account = 'a'.repeat(32),
  tag = 'c'.repeat(32),
  worker = 'cc-test-app-worker';
const calls: { url: string; method: string; body: unknown }[] = [];
let graphql: unknown, telemetry: unknown, telemetryStatus: number;
// Workers Builds: the Worker's builds, one build's outcome, and its log by cursor.
let builds: { build_uuid: string }[],
  buildOutcome: string | null,
  logPages: Record<string, unknown>;
const build = '0123abcd-0123-4567-89ab-0123456789ab';
const cf = (result: unknown) => Response.json({ success: true, result });
const request = (path: string, cookie = who.cookie) =>
  db.request(`/projects/${projectId}${path}`, {}, cookie);

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput()) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const row = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: account,
    repository_id: '50',
    repository_name: 'alice/sample',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: worker,
    build_command: '',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: tag,
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
  calls.length = 0;
  telemetryStatus = 200;
  builds = [{ build_uuid: build }];
  buildOutcome = null;
  logPages = {};
  graphql = {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: [
              // Cloudflare's percentiles are in microseconds.
              {
                sum: { requests: 90, errors: 0, subrequests: 12 },
                quantiles: {
                  cpuTimeP50: 1200,
                  cpuTimeP99: 4500,
                  wallTimeP50: 20_000,
                  wallTimeP99: 60_000,
                },
                dimensions: {
                  datetimeHour: '2026-10-08T09:00:00Z',
                  status: 'success',
                },
              },
              {
                sum: { requests: 10, errors: 10, subrequests: 0 },
                quantiles: {
                  cpuTimeP50: 2000,
                  cpuTimeP99: 9500,
                  wallTimeP50: 150_000,
                  wallTimeP99: 300_000,
                },
                dimensions: {
                  datetimeHour: '2026-10-08T09:00:00Z',
                  status: 'scriptThrewException',
                },
              },
              {
                sum: { requests: 40, errors: 0, subrequests: 3 },
                quantiles: {
                  cpuTimeP50: 1000,
                  cpuTimeP99: 3000,
                  wallTimeP50: 10_000,
                  wallTimeP99: 25_000,
                },
                dimensions: {
                  datetimeHour: '2026-10-08T10:00:00Z',
                  status: 'success',
                },
              },
            ],
          },
        ],
      },
    },
    errors: null,
  };
  telemetry = {
    events: {
      events: [
        {
          dataset: 'cloudflare-workers',
          timestamp: 1791450000000,
          source: {
            exception: { name: 'TypeError', message: 'x is undefined' },
          },
          $workers: {
            event: {
              request: { url: 'https://app.example/api', method: 'GET' },
              response: { status: 500 },
            },
            scriptName: worker,
            outcome: 'exception',
            eventType: 'fetch',
            requestId: 'req-1',
          },
          $metadata: {
            id: 'event-1',
            requestId: 'req-1',
            level: 'error',
            error: 'TypeError: x is undefined',
            trigger: 'GET /api',
            statusCode: 500,
            service: worker,
          },
        },
        {
          dataset: 'cloudflare-workers',
          timestamp: 1791449000000,
          source: 'hello from the app',
          $metadata: {
            id: 'event-2',
            level: 'log',
            message: 'hello from the app',
            service: worker,
          },
        },
      ],
      count: 2,
    },
    statistics: { elapsed: 0.01, rows_read: 10, bytes_read: 100 },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = String(raw),
        path = new URL(url).pathname;
      calls.push({
        url,
        method: init.method || 'GET',
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer cloudflare-access-secret',
      );
      if (path.endsWith('/workers/scripts')) return cf([{ id: worker, tag }]);
      if (path.endsWith(`/builds/workers/${tag}/builds`)) return cf(builds);
      const logs = /\/builds\/builds\/([^/]+)\/logs$/.exec(path);
      if (logs)
        return cf(logPages[new URL(url).searchParams.get('cursor') ?? '']);
      if (path.endsWith(`/builds/builds/${build}`))
        return cf({ build_uuid: build, build_outcome: buildOutcome });
      if (path === '/client/v4/graphql') return Response.json(graphql);
      if (path.endsWith('/workers/observability/telemetry/query'))
        return telemetryStatus === 200
          ? cf(telemetry)
          : Response.json(
              {
                success: false,
                errors: [{ code: 10000, message: 'Authentication error' }],
              },
              { status: telemetryStatus },
            );
      throw new Error(`Unexpected ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('analytics', () => {
  it('sums requests, errors, response and CPU time by hour for the app’s Worker', async () => {
    const response = await request('/analytics?range=24h');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Times in milliseconds. Medians: request-weighted across groups; 99th percentiles:
    // the highest group's.
    expect(body).toEqual({
      range: '24h',
      bucket: 'hour',
      totals: {
        requests: 140,
        errors: 10,
        subrequests: 15,
        cpuP50: 1.2,
        cpuP99: 9.5,
        wallP50: 26.43,
        wallP99: 300,
      },
      series: [
        {
          at: '2026-10-08T09:00:00Z',
          requests: 100,
          errors: 10,
          cpuP50: 1.28,
          cpuP99: 9.5,
          wallP50: 33,
          wallP99: 300,
        },
        {
          at: '2026-10-08T10:00:00Z',
          requests: 40,
          errors: 0,
          cpuP50: 1,
          cpuP99: 3,
          wallP50: 10,
          wallP99: 25,
        },
      ],
      hours: [
        { hour: '2026-10-08T09:00:00Z', requests: 100, errors: 10 },
        { hour: '2026-10-08T10:00:00Z', requests: 40, errors: 0 },
      ],
      statuses: { success: 130, scriptThrewException: 10 },
    });
    const sent = calls.find((c) => c.url.endsWith('/graphql'))!;
    expect(sent.method).toBe('POST');
    const { query, variables } = sent.body as {
      query: string;
      variables: Record<string, string>;
    };
    expect(query).toContain('workersInvocationsAdaptive');
    expect(variables).toMatchObject({ account, script: worker });
    const span = Date.parse(variables.until) - Date.parse(variables.since);
    expect(span).toBe(24 * 3600 * 1000);
  });

  it('offers seven days by hour and thirty by day, and refuses other ranges', async () => {
    expect((await request('/analytics?range=7d')).status).toBe(200);
    let sent = calls.filter((c) => c.url.endsWith('/graphql')).at(-1)!;
    let { query, variables } = sent.body as {
      query: string;
      variables: Record<string, string>;
    };
    expect(Date.parse(variables.until) - Date.parse(variables.since)).toBe(
      7 * 24 * 3600 * 1000,
    );
    expect(query).toContain('dimensions { datetimeHour status }');
    graphql = {
      data: {
        viewer: {
          accounts: [
            {
              workersInvocationsAdaptive: [
                {
                  sum: { requests: 5, errors: 1, subrequests: 0 },
                  quantiles: {
                    cpuTimeP50: 500,
                    cpuTimeP99: 700,
                    wallTimeP50: 4000,
                    wallTimeP99: 9000,
                  },
                  dimensions: { date: '2026-10-01', status: 'success' },
                },
              ],
            },
          ],
        },
      },
      errors: null,
    };
    const month = await request('/analytics?range=30d');
    expect(month.status).toBe(200);
    expect(await month.json()).toMatchObject({
      range: '30d',
      bucket: 'day',
      series: [{ at: '2026-10-01', requests: 5, cpuP50: 0.5, wallP99: 9 }],
    });
    sent = calls.filter((c) => c.url.endsWith('/graphql')).at(-1)!;
    ({ query, variables } = sent.body as {
      query: string;
      variables: Record<string, string>;
    });
    expect(query).toContain('dimensions { date status }');
    expect(query).toContain('orderBy: [date_ASC]');
    expect(Date.parse(variables.until) - Date.parse(variables.since)).toBe(
      30 * 24 * 3600 * 1000,
    );
    expect((await request('/analytics?range=1y')).status).toBe(400);
  });

  it('passes on what Cloudflare says when a query fails', async () => {
    graphql = {
      data: null,
      errors: [{ message: 'not authorized for that account' }],
    };
    const response = await request('/analytics?range=24h');
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('not authorized for that account');
    // Partial data with errors is not a result either.
    graphql = {
      data: { viewer: { accounts: [] } },
      errors: [{ message: 'query limit exceeded' }],
    };
    const partial = await request('/analytics?range=24h');
    expect(partial.status).toBe(502);
    expect(await partial.text()).toContain('query limit exceeded');
  });

  it('keeps analytics inside the workspace', async () => {
    const other = await db.user(2);
    expect((await request('/analytics?range=24h', other.cookie)).status).toBe(
      404,
    );
  });
});

describe('HTTP status codes', () => {
  const calculation = {
    calculations: [
      {
        alias: 'requests',
        calculation: 'uniq($workers.requestId)',
        aggregates: [
          {
            count: 300,
            value: 180,
            groups: [{ key: '$workers.event.response.status', value: 200 }],
          },
          {
            count: 30,
            value: 12,
            groups: [{ key: '$workers.event.response.status', value: 404 }],
          },
          {
            count: 9,
            value: 3,
            groups: [{ key: '$workers.event.response.status', value: 500 }],
          },
          // Nothing a status could be.
          {
            count: 1,
            value: 1,
            groups: [{ key: '$workers.event.response.status', value: 'x' }],
          },
        ],
        series: [
          {
            time: '2026-10-15T09:00:00Z',
            data: [
              {
                count: 200,
                value: 120,
                groups: [{ key: '$workers.event.response.status', value: 200 }],
              },
              {
                count: 9,
                value: 3,
                groups: [{ key: '$workers.event.response.status', value: 500 }],
              },
            ],
          },
          {
            time: '2026-10-15T10:00:00Z',
            data: [
              {
                count: 30,
                value: 12,
                groups: [{ key: '$workers.event.response.status', value: 404 }],
              },
            ],
          },
        ],
      },
    ],
  };

  it('counts requests by the status the app answered, from Workers Logs', async () => {
    telemetry = calculation;
    const response = await request('/status-codes?range=24h');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      hours: 24,
      codes: [
        { status: 200, requests: 180 },
        { status: 404, requests: 12 },
        { status: 500, requests: 3 },
      ],
      series: [
        { at: '2026-10-15T09:00:00Z', requests: 123, errors: 3 },
        { at: '2026-10-15T10:00:00Z', requests: 12, errors: 12 },
      ],
    });
    const sent = calls.find((c) => c.url.endsWith('/telemetry/query'))!
      .body as Record<string, any>;
    expect(sent).toMatchObject({
      view: 'calculations',
      dry: true,
      granularity: 24,
      parameters: {
        calculations: [
          {
            operator: 'uniq',
            key: '$workers.requestId',
            keyType: 'string',
          },
        ],
        groupBys: [{ type: 'number', value: '$workers.event.response.status' }],
        filterCombination: 'and',
      },
    });
    expect(sent.parameters.filters).toEqual([
      {
        key: '$metadata.service',
        operation: 'eq',
        value: worker,
        type: 'string',
      },
      {
        key: '$workers.event.response.status',
        operation: 'exists',
        type: 'number',
      },
    ]);
    expect(sent.timeframe.to - sent.timeframe.from).toBe(24 * 3600 * 1000);
  });

  it('reads at most the week Workers Logs keeps', async () => {
    telemetry = calculation;
    const month = await request('/status-codes?range=30d');
    expect(month.status).toBe(200);
    expect(((await month.json()) as { hours: number }).hours).toBe(168);
    const sent = calls.find((c) => c.url.endsWith('/telemetry/query'))!
      .body as Record<string, any>;
    expect(sent.timeframe.to - sent.timeframe.from).toBe(7 * 24 * 3600 * 1000);
    expect(sent.granularity).toBe(28);
    telemetryStatus = 403;
    expect((await request('/status-codes?range=24h')).status).toBe(403);
    expect((await request('/status-codes?range=1y')).status).toBe(400);
  });
});

describe('build logs', () => {
  it('reads a build’s log a page at a time, and says when the build is done', async () => {
    logPages = {
      '': {
        lines: [
          [1000, 'Cloning repository'],
          [2000, 'Installing dependencies'],
        ],
        cursor: 'c1',
        truncated: true,
      },
      c1: { lines: [[3000, 'Building']], cursor: 'c2', truncated: false },
      c2: { lines: [[4000, 'Deployed']], cursor: 'c3', truncated: false },
    };
    const running = await request(`/builds/${build}/logs`);
    expect(running.status).toBe(200);
    expect(await running.json()).toEqual({
      lines: [
        { at: 1000, text: 'Cloning repository' },
        { at: 2000, text: 'Installing dependencies' },
        { at: 3000, text: 'Building' },
      ],
      cursor: 'c2',
      done: false,
      outcome: null,
    });
    // Asked again from where it stopped, once the build has finished.
    buildOutcome = 'success';
    const finished = await request(`/builds/${build}/logs?cursor=c2`);
    expect(await finished.json()).toEqual({
      lines: [{ at: 4000, text: 'Deployed' }],
      cursor: 'c3',
      done: true,
      outcome: 'success',
    });
  });

  it('reads only this app’s builds', async () => {
    builds = [{ build_uuid: 'ffff0000-0000-4000-8000-000000000000' }];
    const other = await request(`/builds/${build}/logs`);
    expect(other.status).toBe(404);
    expect(calls.some((c) => c.url.includes('/logs'))).toBe(false);
    expect((await request('/builds/not-a-build/logs')).status).toBe(400);
    expect(
      (
        await request(
          `/builds/${build}/logs?cursor=${encodeURIComponent('a b')}`,
        )
      ).status,
    ).toBe(400);
  });
});

describe('logs', () => {
  it('lists recent log lines and errors of the app’s Worker', async () => {
    const response = await request('/logs?minutes=60');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [
        {
          id: 'event-1',
          timestamp: 1791450000000,
          level: 'error',
          message: 'TypeError: x is undefined',
          trigger: 'GET /api',
          status: 500,
          outcome: 'exception',
          requestId: 'req-1',
        },
        {
          id: 'event-2',
          timestamp: 1791449000000,
          level: 'log',
          message: 'hello from the app',
          trigger: null,
          status: null,
          outcome: null,
          requestId: null,
        },
      ],
    });
    const sent = calls.find((c) => c.url.endsWith('/telemetry/query'))!
      .body as {
      view: string;
      dry: boolean;
      limit: number;
      timeframe: { from: number; to: number };
      parameters: { filters: Record<string, unknown>[] };
    };
    expect(sent).toMatchObject({ view: 'events', dry: true, limit: 100 });
    expect(sent.timeframe.to - sent.timeframe.from).toBe(60 * 60 * 1000);
    expect(sent.parameters.filters).toEqual([
      {
        key: '$metadata.service',
        operation: 'eq',
        value: worker,
        type: 'string',
      },
    ]);
  });

  it('searches the events for words', async () => {
    await request(`/logs?minutes=60&q=${encodeURIComponent(' TypeError ')}`);
    const sent = calls.find((c) => c.url.endsWith('/telemetry/query'))!
      .body as { parameters: Record<string, unknown> };
    expect(sent.parameters.needle).toEqual({
      value: 'TypeError',
      isRegex: false,
    });
    expect(
      (await request(`/logs?minutes=60&q=${'x'.repeat(201)}`)).status,
    ).toBe(400);
  });

  it('can show only errors', async () => {
    await request('/logs?minutes=1440&errors=1');
    const sent = calls.find((c) => c.url.endsWith('/telemetry/query'))!
      .body as {
      parameters: {
        filters: Record<string, unknown>[];
        filterCombination: string;
      };
      timeframe: { from: number; to: number };
    };
    expect(sent.parameters.filters).toContainEqual({
      key: '$metadata.error',
      operation: 'exists',
      type: 'string',
    });
    expect(sent.parameters.filterCombination).toBe('and');
    expect(sent.timeframe.to - sent.timeframe.from).toBe(1440 * 60 * 1000);
    expect((await request('/logs?minutes=100000')).status).toBe(400);
  });

  it('explains what to check when Cloudflare refuses the query', async () => {
    telemetryStatus = 403;
    const response = await request('/logs?minutes=60');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('denied');
  });
});
