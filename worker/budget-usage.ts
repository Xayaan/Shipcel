import { z } from 'zod';
import { cloudflare, providerJSON } from './providers';
import { AppError } from './types';

// What a project costs in Cloudflare, estimated from Cloudflare's own analytics, for the
// budget guard (worker/budgets.ts). Cloudflare offers no spending cap on Workers Paid, so
// Shipcel reads usage every few minutes and compares it with each project's budget.

// The meters a runaway app can run up, with Cloudflare's prices, checked on 14 Oct 2026 on
// its pricing pages (Workers and KV updated 2 Oct 2026, Durable Objects 30 Sep 2026, D1 21 Apr
// 2026, R2 1 Oct 2026). `included`: what Workers Paid includes for the whole account each
// month; `perMillion`: the price in dollars of a million beyond it; `freeDaily`: what Workers
// Free allows a day, past which Cloudflare fails the operation instead of billing.
export const METERS = {
  'workers.requests': {
    label: 'Worker requests',
    included: 10_000_000,
    perMillion: 0.3,
    freeDaily: 100_000,
  },
  'do.requests': {
    label: 'Durable Object requests and alarms',
    included: 1_000_000,
    perMillion: 0.15,
    freeDaily: 100_000,
  },
  'do.rowsRead': {
    label: 'Durable Object rows read',
    included: 25_000_000_000,
    perMillion: 0.001,
    freeDaily: 5_000_000,
  },
  'do.rowsWritten': {
    label: 'Durable Object rows written',
    included: 50_000_000,
    perMillion: 1,
    freeDaily: 100_000,
  },
  // Running time, in GB-seconds: Cloudflare bills an active object's wall-clock time at 128 MB.
  'do.duration': {
    label: 'Durable Object running time (GB-s)',
    included: 400_000,
    perMillion: 12.5,
    freeDaily: 13_000,
  },
  // Durable Objects on the key-value storage backend (Workers Paid only, so any use of them
  // shows the account is on Workers Paid: no free daily allowance).
  'do.readUnits': {
    label: 'Durable Object storage reads (key-value, 4 KB units)',
    included: 1_000_000,
    perMillion: 0.2,
    freeDaily: 0,
  },
  'do.writeUnits': {
    label: 'Durable Object storage writes (key-value, 4 KB units)',
    included: 1_000_000,
    perMillion: 1,
    freeDaily: 0,
  },
  'do.deletes': {
    label: 'Durable Object storage deletes (key-value)',
    included: 1_000_000,
    perMillion: 1,
    freeDaily: 0,
  },
  'd1.rowsRead': {
    label: 'D1 rows read',
    included: 25_000_000_000,
    perMillion: 0.001,
    freeDaily: 5_000_000,
  },
  'd1.rowsWritten': {
    label: 'D1 rows written',
    included: 50_000_000,
    perMillion: 1,
    freeDaily: 100_000,
  },
  'kv.reads': {
    label: 'KV reads',
    included: 10_000_000,
    perMillion: 0.5,
    freeDaily: 100_000,
  },
  'kv.writes': {
    label: 'KV writes',
    included: 1_000_000,
    perMillion: 5,
    freeDaily: 1_000,
  },
  'kv.deletes': {
    label: 'KV deletes',
    included: 1_000_000,
    perMillion: 5,
    freeDaily: 1_000,
  },
  'kv.lists': {
    label: 'KV lists',
    included: 1_000_000,
    perMillion: 5,
    freeDaily: 1_000,
  },
  'r2.classA': {
    label: 'R2 writes and lists (Class A)',
    included: 1_000_000,
    perMillion: 4.5,
    freeDaily: null,
  },
  'r2.classB': {
    label: 'R2 reads (Class B)',
    included: 10_000_000,
    perMillion: 0.36,
    freeDaily: null,
  },
  // Containers, Workers Paid only (checked on 29 Oct 2026, pricing page updated 5 Oct 2026):
  // CPU while busy, and the memory and disk of the instance type while it runs.
  'containers.cpu': {
    label: 'Container CPU time (vCPU-s)',
    included: 375 * 60,
    perMillion: 20,
    freeDaily: 0,
  },
  'containers.memory': {
    label: 'Container memory (GiB-s)',
    included: 25 * 3600,
    perMillion: 2.5,
    freeDaily: 0,
  },
  'containers.disk': {
    label: 'Container disk (GB-s)',
    included: 200 * 3600,
    perMillion: 0.07,
    freeDaily: 0,
  },
} as const;
export type Meter = keyof typeof METERS;
// Not in the estimate: stored data (small next to a runaway loop's operations), Workers CPU
// time and containers' network egress.
export const notEstimated =
  'Stored data, Workers CPU time, container egress and emails sent aren’t in the estimate.';

// One reading: how much of a meter one resource (a Worker, Durable Object namespace,
// database, namespace or bucket) used on one day.
export type UsageRow = {
  meter: Meter;
  resource: string;
  date: string;
  count: number;
};
export type Missing = { meters: Meter[]; reason: string };

// R2 operations Cloudflare bills as Class A; the rest of the billed ones are Class B.
const CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);
const CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
const KV_ACTIONS: Record<string, Meter> = {
  read: 'kv.reads',
  write: 'kv.writes',
  delete: 'kv.deletes',
  list: 'kv.lists',
};

// One GraphQL query per product, so that a field Cloudflare doesn't offer an account (its
// documentation names some of them only in its schema) costs that product's meters, not
// the whole reading. Each turns a group into readings.
type Group = {
  sum?: Record<string, unknown>;
  dimensions?: Record<string, unknown>;
};
const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const text = (value: unknown) =>
  typeof value === 'string' && value.length <= 200 ? value : '';
const QUERIES: {
  dataset: string;
  meters: Meter[];
  fields: string;
  read: (g: Group) => UsageRow[];
}[] = [
  {
    dataset: 'workersInvocationsAdaptive',
    meters: ['workers.requests'],
    fields: 'sum { requests } dimensions { scriptName date }',
    read: (g) => [
      {
        meter: 'workers.requests',
        resource: text(g.dimensions?.scriptName),
        date: text(g.dimensions?.date),
        count: num(g.sum?.requests),
      },
    ],
  },
  {
    dataset: 'durableObjectsInvocationsAdaptiveGroups',
    meters: ['do.requests'],
    fields: 'sum { requests } dimensions { namespaceId date }',
    read: (g) => [
      {
        meter: 'do.requests',
        resource: text(g.dimensions?.namespaceId),
        date: text(g.dimensions?.date),
        count: num(g.sum?.requests),
      },
    ],
  },
  {
    dataset: 'durableObjectsPeriodicGroups',
    meters: ['do.rowsRead', 'do.rowsWritten'],
    fields: 'sum { rowsRead rowsWritten } dimensions { namespaceId date }',
    read: (g) =>
      (['rowsRead', 'rowsWritten'] as const).map((field) => ({
        meter: field === 'rowsRead' ? 'do.rowsRead' : 'do.rowsWritten',
        resource: text(g.dimensions?.namespaceId),
        date: text(g.dimensions?.date),
        count: num(g.sum?.[field]),
      })),
  },
  {
    dataset: 'durableObjectsPeriodicGroups',
    meters: ['do.duration', 'do.readUnits', 'do.writeUnits', 'do.deletes'],
    // Running time as Cloudflare bills it, in GB-s; and the key-value backend's operations.
    fields:
      'sum { duration storageReadUnits storageWriteUnits storageDeletes } dimensions { namespaceId date }',
    read: (g) =>
      (
        [
          ['do.duration', 'duration'],
          ['do.readUnits', 'storageReadUnits'],
          ['do.writeUnits', 'storageWriteUnits'],
          ['do.deletes', 'storageDeletes'],
        ] as const
      ).map(([meter, field]) => ({
        meter,
        resource: text(g.dimensions?.namespaceId),
        date: text(g.dimensions?.date),
        count: num(g.sum?.[field]),
      })),
  },
  {
    dataset: 'd1AnalyticsAdaptiveGroups',
    meters: ['d1.rowsRead', 'd1.rowsWritten'],
    fields: 'sum { rowsRead rowsWritten } dimensions { databaseId date }',
    read: (g) =>
      (['rowsRead', 'rowsWritten'] as const).map((field) => ({
        meter: field === 'rowsRead' ? 'd1.rowsRead' : 'd1.rowsWritten',
        resource: text(g.dimensions?.databaseId),
        date: text(g.dimensions?.date),
        count: num(g.sum?.[field]),
      })),
  },
  {
    dataset: 'kvOperationsAdaptiveGroups',
    meters: ['kv.reads', 'kv.writes', 'kv.deletes', 'kv.lists'],
    fields: 'sum { requests } dimensions { namespaceId actionType date }',
    read: (g) => {
      const meter = KV_ACTIONS[text(g.dimensions?.actionType)];
      return meter
        ? [
            {
              meter,
              resource: text(g.dimensions?.namespaceId),
              date: text(g.dimensions?.date),
              count: num(g.sum?.requests),
            },
          ]
        : [];
    },
  },
  // The values Cloudflare's dashboard estimates container bills from: CPU seconds, and the
  // memory and disk allocated, in byte-seconds, per container application.
  {
    dataset: 'containersUsageAdaptiveGroups',
    meters: ['containers.cpu', 'containers.memory', 'containers.disk'],
    fields:
      'sum { cpuTimeSec allocatedMemory allocatedDisk } dimensions { applicationId date }',
    read: (g) =>
      (
        [
          ['containers.cpu', 'cpuTimeSec', 1],
          ['containers.memory', 'allocatedMemory', 1024 ** 3],
          ['containers.disk', 'allocatedDisk', 1e9],
        ] as const
      ).map(([meter, field, unit]) => ({
        meter,
        resource: text(g.dimensions?.applicationId),
        date: text(g.dimensions?.date),
        count: num(g.sum?.[field]) / unit,
      })),
  },
  {
    dataset: 'r2OperationsAdaptiveGroups',
    meters: ['r2.classA', 'r2.classB'],
    fields: 'sum { requests } dimensions { bucketName actionType date }',
    read: (g) => {
      const action = text(g.dimensions?.actionType);
      const meter = CLASS_A.has(action)
        ? 'r2.classA'
        : CLASS_B.has(action)
          ? 'r2.classB'
          : null;
      return meter
        ? [
            {
              meter,
              resource: text(g.dimensions?.bucketName),
              date: text(g.dimensions?.date),
              count: num(g.sum?.requests),
            },
          ]
        : [];
    },
  },
];
const answerSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        accounts: z.array(z.record(z.string(), z.unknown())),
      }),
    })
    .nullable()
    .optional(),
  errors: z
    .array(z.object({ message: z.string() }))
    .nullable()
    .optional(),
});

// Everything the account used between two days (inclusive, YYYY-MM-DD, UTC), by meter,
// resource and day: one reading for the whole account, shared by all its projects.
export async function readUsage(
  token: string,
  accountId: string,
  since: string,
  until: string,
): Promise<{ rows: UsageRow[]; missing: Missing[] }> {
  const rows: UsageRow[] = [];
  const missing: Missing[] = [];
  await Promise.all(
    QUERIES.map(async (q) => {
      const query = `query Usage($account: string!, $since: Date!, $until: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      ${q.dataset}(limit: 10000, filter: { date_geq: $since, date_leq: $until }) {
        ${q.fields}
      }
    }
  }
}`;
      try {
        const answer = answerSchema.parse(
          await providerJSON('https://api.cloudflare.com/client/v4/graphql', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query,
              variables: { account: accountId, since, until },
            }),
          }),
        );
        const groups = answer.data?.viewer.accounts[0]?.[q.dataset];
        if (answer.errors?.length || !Array.isArray(groups))
          throw new Error(
            answer.errors?.[0]?.message ?? 'Cloudflare reported no data',
          );
        for (const group of groups as Group[])
          for (const row of q.read(group))
            if (row.resource && row.date && row.count) rows.push(row);
      } catch (error) {
        missing.push({
          meters: q.meters,
          reason: (error instanceof Error ? error.message : String(error))
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .slice(0, 300),
        });
      }
    }),
  );
  return { rows, missing };
}

export type MeterCost = {
  meter: Meter;
  label: string;
  // This project's use this month, the whole account's, and what Workers Paid includes.
  mine: number;
  account: number;
  included: number;
  // This project's share of what the account owes for the meter beyond what is included.
  cents: number;
};

// Cloudflare's analytics are sampled, so a day's count a little past a free limit doesn't
// prove the account went past it.
const SAMPLING_MARGIN = 1.25;

// The project's cost this month beyond what Cloudflare includes: each meter's charge for
// the whole account (what goes past the included amount, at Cloudflare's price), shared in
// proportion to the project's use. On Workers Free only R2 is charged (it bills beyond its
// own free tier on either plan); the rest stops at the free limits. `overFree`: on some day
// the account used clearly more of a meter than Workers Free allows, so it isn't on Workers
// Free. `accountCents`: the whole account's charge, Workers Shipcel doesn't manage included.
export function estimate(
  plan: 'free' | 'paid' | 'unknown',
  rows: UsageRow[],
  mine: (meter: Meter, resource: string) => boolean,
) {
  const meters: MeterCost[] = [];
  const daily = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.meter} ${row.date}`;
    daily.set(key, (daily.get(key) ?? 0) + row.count);
  }
  const overFree = [...daily].some(([key, count]) => {
    const limit = METERS[key.split(' ')[0] as Meter].freeDaily;
    return limit !== null && count > limit * SAMPLING_MARGIN;
  });
  let cents = 0;
  let accountCents = 0;
  for (const meter of Object.keys(METERS) as Meter[]) {
    const own = rows.filter((r) => r.meter === meter);
    const account = own.reduce((sum, r) => sum + r.count, 0);
    const project = own
      .filter((r) => mine(meter, r.resource))
      .reduce((sum, r) => sum + r.count, 0);
    if (!account) continue;
    const { label, included, perMillion, freeDaily } = METERS[meter];
    const charged = plan !== 'free' || overFree || freeDaily === null;
    const owed = charged
      ? (Math.max(0, account - included) / 1_000_000) * perMillion * 100
      : 0;
    const share = owed * (project / account);
    cents += share;
    accountCents += owed;
    if (project)
      meters.push({
        meter,
        label,
        mine: project,
        account,
        included,
        cents: Math.round(share),
      });
  }
  return {
    cents: Math.round(cents),
    accountCents: Math.round(accountCents),
    meters,
    overFree,
  };
}

// The month so far, day by day, for the Billing panel's charts: this project's use of each
// meter on each day, and the estimate at the end of each day (what the month had cost by
// then). Days are UTC dates, YYYY-MM-DD, from the first of the month to today.
export type Daily = {
  days: string[];
  meters: Partial<Record<Meter, number[]>>;
  cents: number[];
};
export function dailySeries(
  plan: 'free' | 'paid' | 'unknown',
  rows: UsageRow[],
  mine: (meter: Meter, resource: string) => boolean,
  days: string[],
): Daily {
  const position = new Map(days.map((day, i) => [day, i]));
  const meters: Partial<Record<Meter, number[]>> = {};
  for (const row of rows) {
    const i = position.get(row.date);
    if (i === undefined || !mine(row.meter, row.resource)) continue;
    const series = meters[row.meter] ?? days.map(() => 0);
    meters[row.meter] = series.map((n, j) => (j === i ? n + row.count : n));
  }
  return {
    days,
    meters,
    cents: days.map(
      (day) =>
        estimate(
          plan,
          rows.filter((r) => r.date <= day),
          mine,
        ).cents,
    ),
  };
}

// The days of the month up to the given day: YYYY-MM-01 … YYYY-MM-DD.
export function monthDays(today: string) {
  const last = Number(today.slice(8, 10));
  return Array.from(
    { length: last },
    (_, i) => `${today.slice(0, 8)}${String(i + 1).padStart(2, '0')}`,
  );
}

// Which Workers plan the account is on, from its billing subscriptions (Billing Read).
// Workers Free has no subscription; a Workers plan with a price, or named paid, is paid.
export async function detectPlan(
  token: string,
  accountId: string,
): Promise<{
  plan: 'free' | 'paid' | 'unknown';
  source: 'subscriptions' | 'no-permission' | 'error';
  detail: string | null;
}> {
  let result: unknown;
  try {
    result = await cloudflare(token, `/accounts/${accountId}/subscriptions`);
  } catch (error) {
    return error instanceof AppError &&
      (error.status === 403 || error.status === 401)
      ? { plan: 'unknown', source: 'no-permission', detail: null }
      : {
          plan: 'unknown',
          source: 'error',
          detail: error instanceof Error ? error.message.slice(0, 200) : null,
        };
  }
  const subscriptions = z
    .array(
      z
        .object({
          state: z.string().nullable().optional(),
          price: z.number().nullable().optional(),
          rate_plan: z
            .object({
              id: z.string().nullable().optional(),
              public_name: z.string().nullable().optional(),
            })
            .passthrough()
            .nullable()
            .optional(),
        })
        .passthrough(),
    )
    .safeParse(result);
  if (!subscriptions.success)
    return {
      plan: 'unknown',
      source: 'error',
      detail: 'unreadable subscriptions',
    };
  const workers = subscriptions.data.filter(
    (s) =>
      /worker/i.test(
        `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`,
      ) && !/cancel|expired/i.test(s.state ?? ''),
  );
  const paid = workers.find(
    (s) =>
      (s.price ?? 0) > 0 ||
      /paid|standard|bundled|unbound/i.test(
        `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`,
      ),
  );
  return paid
    ? {
        plan: 'paid',
        source: 'subscriptions',
        detail: (
          paid.rate_plan?.public_name ??
          paid.rate_plan?.id ??
          'Workers'
        ).slice(0, 100),
      }
    : { plan: 'free', source: 'subscriptions', detail: null };
}
