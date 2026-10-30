import { Hono } from 'hono';
import { z } from 'zod';
import { cloudflare, providerJSON } from './providers';
import { AppError, type AppEnv } from './types';
import { target } from './operations';

// Manage → Observability: request analytics from Cloudflare's GraphQL Analytics API and
// recent logs from Workers Logs, for the project's production Worker. Read-only.
export const observability = new Hono<AppEnv>();

// Each range and the buckets it is drawn in: hours up to a week, days for a month.
const ranges = {
  '24h': { hours: 24, bucket: 'datetimeHour' },
  '7d': { hours: 24 * 7, bucket: 'datetimeHour' },
  '30d': { hours: 24 * 30, bucket: 'date' },
} as const;
type Range = keyof typeof ranges;
const rangeSchema = z.enum(Object.keys(ranges) as [Range, ...Range[]]);
// Cloudflare's percentiles of CPU time and wall time (from the request to the response,
// waiting included), in microseconds.
const usageQuery = (
  bucket: 'datetimeHour' | 'date',
) => `query Usage($account: string!, $script: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }
        orderBy: [${bucket}_ASC]
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
        dimensions { ${bucket} status }
      }
    }
  }
}`;
const groupSchema = z.object({
  sum: z.object({
    requests: z.number(),
    errors: z.number(),
    subrequests: z.number(),
  }),
  quantiles: z.object({
    cpuTimeP50: z.number(),
    cpuTimeP99: z.number(),
    wallTimeP50: z.number(),
    wallTimeP99: z.number(),
  }),
  dimensions: z.object({
    datetimeHour: z.string().optional(),
    date: z.string().optional(),
    status: z.string(),
  }),
});
type Group = z.infer<typeof groupSchema>;
const usageSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        accounts: z.array(
          z.object({ workersInvocationsAdaptive: z.array(groupSchema) }),
        ),
      }),
    })
    .nullable(),
  errors: z
    .array(z.object({ message: z.string() }))
    .nullable()
    .optional(),
});
const round = (n: number) => Math.round(n * 100) / 100;
// Microseconds to milliseconds.
const ms = (us: number) => round(us / 1000);
const shortText = (text: string, max = 2000) =>
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max);

observability.get('/projects/:id/analytics', async (c) => {
  const range = rangeSchema.parse(c.req.query('range') ?? '24h');
  const { hours: span, bucket } = ranges[range];
  const t = await target(c);
  const until = new Date();
  const since = new Date(until.getTime() - span * 3600 * 1000);
  let response: z.infer<typeof usageSchema>;
  try {
    response = usageSchema.parse(
      await providerJSON('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${t.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: usageQuery(bucket),
          variables: {
            account: t.job.account_id,
            script: t.job.worker_name,
            since: since.toISOString(),
            until: until.toISOString(),
          },
        }),
      }),
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      throw new AppError(
        403,
        'Cloudflare denied access to analytics. Reconnect Cloudflare so Shipcel can read Account Analytics.',
      );
    throw error;
  }
  if (response.errors?.length || !response.data)
    throw new AppError(
      502,
      `Cloudflare analytics: ${shortText(response.errors?.[0]?.message ?? 'no data', 300)}`,
    );
  const groups =
    response.data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
  const statuses: Record<string, number> = {};
  for (const g of groups)
    statuses[g.dimensions.status] =
      (statuses[g.dimensions.status] ?? 0) + g.sum.requests;
  const series = summarise(groups, (g) => g.dimensions[bucket] ?? '');
  const [whole] = summarise(groups, () => 'all');
  return c.json({
    range,
    bucket: bucket === 'date' ? 'day' : 'hour',
    totals: {
      requests: whole?.requests ?? 0,
      errors: whole?.errors ?? 0,
      subrequests: whole?.subrequests ?? 0,
      cpuP50: whole?.cpuP50 ?? 0,
      cpuP99: whole?.cpuP99 ?? 0,
      wallP50: whole?.wallP50 ?? 0,
      wallP99: whole?.wallP99 ?? 0,
    },
    series: series.map(({ subrequests: _, ...point }) => point),
    // As before series existed: requests and errors by hour (or day).
    hours: series.map((p) => ({
      hour: p.at,
      requests: p.requests,
      errors: p.errors,
    })),
    statuses,
  });
});

// Cloudflare's groups (one per bucket and outcome) added up by a key. Medians are an
// approximation: each group's, weighted by its requests; 99th percentiles are the highest
// group's. Times in milliseconds.
function summarise(groups: Group[], key: (g: Group) => string) {
  const points = new Map<
    string,
    {
      requests: number;
      errors: number;
      subrequests: number;
      cpu: number;
      wall: number;
      cpuP99: number;
      wallP99: number;
    }
  >();
  for (const g of groups) {
    const at = key(g);
    const p = points.get(at) ?? {
      requests: 0,
      errors: 0,
      subrequests: 0,
      cpu: 0,
      wall: 0,
      cpuP99: 0,
      wallP99: 0,
    };
    points.set(at, {
      requests: p.requests + g.sum.requests,
      errors: p.errors + g.sum.errors,
      subrequests: p.subrequests + g.sum.subrequests,
      cpu: p.cpu + g.quantiles.cpuTimeP50 * g.sum.requests,
      wall: p.wall + g.quantiles.wallTimeP50 * g.sum.requests,
      cpuP99: Math.max(p.cpuP99, g.quantiles.cpuTimeP99),
      wallP99: Math.max(p.wallP99, g.quantiles.wallTimeP99),
    });
  }
  return [...points].map(([at, p]) => ({
    at,
    requests: p.requests,
    errors: p.errors,
    subrequests: p.subrequests,
    cpuP50: p.requests ? ms(p.cpu / p.requests) : 0,
    cpuP99: ms(p.cpuP99),
    wallP50: p.requests ? ms(p.wall / p.requests) : 0,
    wallP99: ms(p.wallP99),
  }));
}

// HTTP status codes come from Workers Logs, since Workers analytics has none: distinct
// requests by the status the app answered, over the range and in buckets. Workers Logs keeps
// 3 days on Workers Free and 7 on Workers Paid, so longer ranges show the last 7 days.
const STATUS = '$workers.event.response.status';
const LOGS_KEPT_HOURS = 24 * 7;
const groupsSchema = z
  .array(
    z.object({
      key: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
  )
  .optional();
const codesSchema = z
  .object({
    calculations: z
      .array(
        z
          .object({
            aggregates: z
              .array(
                z
                  .object({ value: z.number(), groups: groupsSchema })
                  .passthrough(),
              )
              .optional(),
            series: z
              .array(
                z
                  .object({
                    time: z.string(),
                    data: z.array(
                      z
                        .object({ value: z.number(), groups: groupsSchema })
                        .passthrough(),
                    ),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const statusOf = (groups: z.infer<typeof groupsSchema>) => {
  const value = Number(groups?.find((g) => g.key === STATUS)?.value);
  return Number.isInteger(value) && value >= 100 && value < 600 ? value : null;
};

observability.get('/projects/:id/status-codes', async (c) => {
  const range = rangeSchema.parse(c.req.query('range') ?? '24h');
  const t = await target(c);
  const hours = Math.min(ranges[range].hours, LOGS_KEPT_HOURS);
  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  let result: unknown;
  try {
    result = await cloudflare(
      t.token,
      `${t.root}/workers/observability/telemetry/query`,
      {
        method: 'POST',
        body: JSON.stringify({
          queryId: 'shipcel-status-codes',
          view: 'calculations',
          dry: true,
          timeframe: { from, to },
          // Hourly for a day, every six hours for a week.
          granularity: hours <= 24 ? hours : hours / 6,
          parameters: {
            filters: [
              {
                key: '$metadata.service',
                operation: 'eq',
                value: t.job.worker_name,
                type: 'string',
              },
              { key: STATUS, operation: 'exists', type: 'number' },
            ],
            filterCombination: 'and',
            // Requests, not log lines: one request can log many.
            calculations: [
              {
                operator: 'uniq',
                key: '$workers.requestId',
                keyType: 'string',
                alias: 'requests',
              },
            ],
            groupBys: [{ type: 'number', value: STATUS }],
            limit: 50,
          },
        }),
      },
      { errorDetail: true },
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      throw new AppError(
        403,
        'Cloudflare denied access to Workers Logs. Reconnect Cloudflare so Shipcel can query Workers Observability.',
      );
    throw error;
  }
  const [calculation] = codesSchema.parse(result).calculations ?? [];
  const codes = (calculation?.aggregates ?? [])
    .map((a) => ({ status: statusOf(a.groups), requests: Math.round(a.value) }))
    .filter(
      (code): code is { status: number; requests: number } =>
        code.status !== null && code.requests > 0,
    )
    .sort((a, b) => b.requests - a.requests);
  const series = (calculation?.series ?? []).map((point) => {
    const counted = point.data.map((d) => ({
      status: statusOf(d.groups),
      requests: d.value,
    }));
    return {
      at: point.time,
      requests: Math.round(counted.reduce((n, d) => n + d.requests, 0)),
      errors: Math.round(
        counted
          .filter((d) => (d.status ?? 0) >= 400)
          .reduce((n, d) => n + d.requests, 0),
      ),
    };
  });
  return c.json({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    hours,
    codes,
    series,
  });
});

const eventSchema = z
  .object({
    timestamp: z.number(),
    source: z.unknown().optional(),
    $workers: z
      .object({
        outcome: z.string().optional(),
        requestId: z.string().optional(),
        event: z
          .object({
            response: z.object({ status: z.number() }).partial().optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
    $metadata: z
      .object({
        id: z.string(),
        requestId: z.string().optional(),
        level: z.string().optional(),
        error: z.string().optional(),
        message: z.string().optional(),
        trigger: z.string().optional(),
        statusCode: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

observability.get('/projects/:id/logs', async (c) => {
  const minutes = z.coerce
    .number()
    .int()
    .min(5)
    .max(3 * 24 * 60)
    .parse(c.req.query('minutes') ?? '60');
  const errorsOnly = c.req.query('errors') === '1';
  // Words to look for in the events, as Workers Logs' full-text search does.
  const search = z
    .string()
    .trim()
    .max(200)
    .parse(c.req.query('q') ?? '');
  const t = await target(c);
  const to = Date.now();
  let result: unknown;
  try {
    result = await cloudflare(
      t.token,
      `${t.root}/workers/observability/telemetry/query`,
      {
        method: 'POST',
        body: JSON.stringify({
          queryId: 'shipcel-logs',
          view: 'events',
          dry: true,
          limit: 100,
          timeframe: { from: to - minutes * 60 * 1000, to },
          parameters: {
            filters: [
              {
                key: '$metadata.service',
                operation: 'eq',
                value: t.job.worker_name,
                type: 'string',
              },
              ...(errorsOnly
                ? [
                    {
                      key: '$metadata.error',
                      operation: 'exists',
                      type: 'string',
                    },
                  ]
                : []),
            ],
            filterCombination: 'and',
            ...(search ? { needle: { value: search, isRegex: false } } : {}),
          },
        }),
      },
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      throw new AppError(
        403,
        'Cloudflare denied access to Workers Logs. Reconnect Cloudflare so Shipcel can query Workers Observability.',
      );
    throw error;
  }
  const events = z
    .object({
      events: z
        .object({ events: z.array(eventSchema).optional() })
        .partial()
        .optional(),
    })
    .passthrough()
    .parse(result).events?.events;
  return c.json({
    events: (events ?? []).map((e) => {
      const m = e.$metadata;
      const source = e.source as
        string | { exception?: { message?: string } } | undefined;
      const message =
        m.error ??
        m.message ??
        (typeof source === 'string' ? source : source?.exception?.message) ??
        '';
      return {
        id: m.id,
        timestamp: e.timestamp,
        level: m.level ?? (m.error ? 'error' : 'log'),
        message: shortText(message),
        trigger: m.trigger ?? null,
        status: m.statusCode ?? e.$workers?.event?.response?.status ?? null,
        outcome: e.$workers?.outcome ?? null,
        requestId: m.requestId ?? e.$workers?.requestId ?? null,
      };
    }),
  });
});

// A build's log, from Cloudflare's Workers Builds API: one of this Worker's recent builds,
// read a page at a time with Cloudflare's cursor. `done` tells the dashboard to stop asking
// for more lines.
const BUILD_PAGES = 3;
const LOG_PAGES = 20;
const buildId = z.string().regex(/^[a-f0-9-]{16,64}$/i);
const logSchema = z
  .object({
    cursor: z.string().nullable().optional(),
    lines: z
      .array(z.tuple([z.number(), z.string()]).rest(z.unknown()))
      .nullable()
      .optional(),
    truncated: z.boolean().nullable().optional(),
  })
  .passthrough();

observability.get('/projects/:id/builds/:build/logs', async (c) => {
  const build = buildId.parse(c.req.param('build'));
  const after = z
    .string()
    .max(1000)
    .regex(/^[\w.:=+/-]*$/)
    .parse(c.req.query('cursor') ?? '');
  const t = await target(c);
  // Only a build of this project's Worker.
  let ours = false;
  for (let page = 1; page <= BUILD_PAGES && !ours; page++) {
    const list = z
      .array(z.object({ build_uuid: z.string() }).passthrough())
      .parse(
        await cloudflare(
          t.token,
          `${t.root}/builds/workers/${t.job.worker_tag}/builds?page=${page}&per_page=50`,
        ),
      );
    ours = list.some((b) => b.build_uuid === build);
    if (list.length < 50) break;
  }
  if (!ours)
    throw new AppError(
      404,
      'That build isn’t one of this app’s recent builds.',
    );
  const status = z
    .object({ build_outcome: z.string().nullable().optional() })
    .passthrough()
    .parse(await cloudflare(t.token, `${t.root}/builds/builds/${build}`));
  const lines: { at: number; text: string }[] = [];
  let cursor = after || null;
  // Every page there is now, up to a limit; the dashboard asks again with the last cursor.
  for (let page = 0; page < LOG_PAGES; page++) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const log = logSchema.parse(
      await cloudflare(
        t.token,
        `${t.root}/builds/builds/${build}/logs${query}`,
      ),
    );
    for (const [at, text] of log.lines ?? [])
      lines.push({ at, text: shortText(text, 4000) });
    const next = log.cursor || null;
    if (!log.truncated || !next || next === cursor) {
      cursor = next ?? cursor;
      break;
    }
    cursor = next;
  }
  return c.json({
    lines,
    cursor,
    done: Boolean(status.build_outcome),
    outcome: status.build_outcome ?? null,
  });
});
