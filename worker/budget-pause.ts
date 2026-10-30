import { z } from 'zod';
import { cloudflare, cloudflarePage } from './providers';
import { AppError } from './types';

// Pausing an app that went over its budget, and resuming it (worker/budgets.ts decides
// when). A pause switches production to a stand-in version: every Durable Object class the
// Worker has, under the same name so its objects and their data stay, with an alarm handler
// that does nothing (an alarm that fires once more ends there and isn't set again), a 503
// for every request, queue deliveries put off, and the Worker's secrets kept for its next
// deploy. Its cron schedules are removed. Resuming deploys the versions that served before
// and puts the schedules back.

export type Serving = { version_id: string; percentage: number }[];
export type Paused = {
  from: Serving;
  schedules: { cron: string }[];
  version: string;
};
type Where = { accountId: string; workerName: string };

const STAND_IN_DATE = '2025-09-01';
const PAUSED_MESSAGE = 'Paused by Shipcel: over budget';
// The longest Cloudflare Queues lets a message wait before its next delivery: 12 hours.
const QUEUE_DELAY = 43_200;
const identifier = /^[A-Za-z_$][\w$]{0,99}$/;
const script = (w: Where) =>
  `/accounts/${w.accountId}/workers/scripts/${w.workerName}`;

const servingSchema = z.array(
  z.object({ version_id: z.string().min(1), percentage: z.number() }),
);
const deploymentsSchema = z.object({
  deployments: z.array(z.object({ versions: servingSchema }).passthrough()),
});
const schedulesSchema = z.object({
  schedules: z.array(z.object({ cron: z.string() }).passthrough()),
});
const settingsSchema = z
  .object({
    bindings: z
      .array(z.object({ type: z.string(), name: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

// The versions production serves now, and their shares of traffic.
export async function servingVersions(token: string, w: Where) {
  return (
    deploymentsSchema.parse(await cloudflare(token, `${script(w)}/deployments`))
      .deployments[0]?.versions ?? []
  );
}

export function pausedModule(classes: string[]) {
  const names = [...new Set(classes)].sort();
  if (names.some((name) => !identifier.test(name)))
    throw new AppError(
      409,
      'A Durable Object class name can’t be written in a stand-in.',
    );
  return `import { DurableObject } from 'cloudflare:workers';

const paused = () =>
  new Response(
    'This app is paused: it went over its budget in Shipcel. Its owner can resume it there.',
    {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': '3600',
      },
    },
  );

${names
  .map(
    (name) => `export class ${name} extends DurableObject {
  fetch() {
    return paused();
  }
  alarm() {}
}

`,
  )
  .join('')}export default {
  fetch: paused,
  scheduled() {},
  queue(batch) {
    batch.retryAll({ delaySeconds: ${QUEUE_DELAY} });
  },
};
`;
}

// The Durable Object classes the Worker defines: the namespaces Cloudflare lists for it, and
// its bindings to classes in the Worker itself.
async function classesOf(token: string, w: Where) {
  const classes: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const { result, info } = await cloudflarePage<unknown>(
      token,
      `/accounts/${w.accountId}/workers/durable_objects/namespaces?per_page=100&page=${page}`,
    );
    const list = z
      .array(
        z
          .object({
            script: z.string().nullable().optional(),
            class: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .parse(result);
    for (const n of list)
      if (n.script === w.workerName && n.class) classes.push(n.class);
    if (list.length < 100 || page * 100 >= Number(info.total_count ?? 0)) break;
  }
  const settings = settingsSchema.parse(
    await cloudflare(token, `${script(w)}/settings`),
  );
  for (const b of settings.bindings ?? [])
    if (
      b.type === 'durable_object_namespace' &&
      typeof b.class_name === 'string' &&
      (!b.script_name || b.script_name === w.workerName)
    )
      classes.push(b.class_name);
  return classes;
}

// Switches production to the stand-in and removes the cron schedules, returning what is
// needed to put both back.
export async function pauseWorker(token: string, w: Where): Promise<Paused> {
  const [from, scheduled, classes] = await Promise.all([
    servingVersions(token, w),
    cloudflare(token, `${script(w)}/schedules`),
    classesOf(token, w),
  ]);
  if (!from.length)
    throw new AppError(
      409,
      'Cloudflare reports no version in production to pause.',
    );
  const schedules = schedulesSchema
    .parse(scheduled)
    .schedules.map((s) => ({ cron: s.cron }));
  const form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      main_module: 'paused.js',
      compatibility_date: STAND_IN_DATE,
      bindings: [],
      // The next deploy takes its secrets from the latest version, which is this one.
      keep_bindings: ['secret_text', 'secret_key'],
      annotations: { 'workers/message': PAUSED_MESSAGE },
    }),
  );
  form.set(
    'paused.js',
    new Blob([pausedModule(classes)], {
      type: 'application/javascript+module',
    }),
    'paused.js',
  );
  const version = z
    .object({ id: z.string().min(1) })
    .passthrough()
    .parse(
      await cloudflare(token, `${script(w)}/versions`, {
        method: 'POST',
        body: form,
      }),
    );
  await cloudflare(token, `${script(w)}/deployments?force=false`, {
    method: 'POST',
    body: JSON.stringify({
      strategy: 'percentage',
      versions: [{ version_id: version.id, percentage: 100 }],
      annotations: { 'workers/message': PAUSED_MESSAGE },
    }),
  });
  if (schedules.length)
    await cloudflare(token, `${script(w)}/schedules`, {
      method: 'PUT',
      body: JSON.stringify([]),
    });
  return { from, schedules, version: version.id };
}

// Puts back the versions production served before the pause, and the schedules.
export async function resumeWorker(
  token: string,
  w: Where,
  paused: { from: Serving; schedules: { cron: string }[] },
) {
  const from = servingSchema.min(1).parse(paused.from);
  await cloudflare(token, `${script(w)}/deployments?force=false`, {
    method: 'POST',
    body: JSON.stringify({
      strategy: 'percentage',
      versions: from,
      annotations: { 'workers/message': 'Resumed in Shipcel' },
    }),
  });
  if (paused.schedules.length)
    await cloudflare(token, `${script(w)}/schedules`, {
      method: 'PUT',
      body: JSON.stringify(paused.schedules),
    });
}
