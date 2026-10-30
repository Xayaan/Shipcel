import { z } from 'zod';
import type { ResourceRequest } from '../shared/deployment-plan';

// What an upload from a person's computer may contain (worker/wrangler-api.ts sends it on
// only when this finds nothing). The fields are the ones Wrangler 4.148 puts in a Worker
// upload's metadata.

// A database, namespace or bucket created for the app during a deploy, or a Hyperdrive
// configuration Shipcel added to the project (worker/hyperdrive.ts). `id` is the D1 UUID,
// the KV namespace ID, the R2 bucket's name, or the Hyperdrive configuration's id.
export type Created = {
  type: ResourceRequest['type'];
  name: string;
  id: string;
};

// Turning logs and traces on or off, and how much is sampled. Not where they are sent:
// `destinations` would route an app's logs to another place.
const sampling = z.number().min(0).max(1).optional();
export const observabilitySettings = z
  .object({
    enabled: z.boolean().optional(),
    head_sampling_rate: sampling,
    logs: z
      .object({
        enabled: z.boolean().optional(),
        head_sampling_rate: sampling,
        invocation_logs: z.boolean().optional(),
        persist: z.boolean().optional(),
      })
      .strict()
      .optional(),
    traces: z
      .object({
        enabled: z.boolean().optional(),
        head_sampling_rate: sampling,
        persist: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const metadataKeys = new Set([
  'main_module',
  'bindings',
  'compatibility_date',
  'compatibility_flags',
  'migrations',
  'code_update_strategy',
  'keep_bindings',
  'keep_assets',
  'placement',
  'limits',
  'annotations',
  'assets',
  'observability',
  'cache_options',
  'package_dependencies',
  'logpush',
  'tail_consumers',
  'streaming_tail_consumers',
  'containers',
  'exports',
]);
const only = (value: object, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const empty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === false ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && Object.keys(value as object).length === 0);

// Workers' rate limiter, as Wrangler declares one: counters in the app's own account, keyed by a
// number the app chooses, over 10 or 60 seconds.
const rateLimit = z
  .object({
    limit: z.number().int().positive(),
    period: z.union([z.literal(10), z.literal(60)]),
  })
  .strict();

// Why an upload isn't allowed, or nothing. A deploy may bind only what touches no one else's
// data: its own files and classes, variables, Cloudflare's stateless services and its rate
// limiter, the resources created for it in this deploy, and whatever the Worker already has
// (`inherit`).
export function uploadProblems(
  metadata: unknown,
  workerName: string,
  created: Created[],
): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return ['the upload has no settings Shipcel can read'];
  const m = metadata as Record<string, unknown>;
  const problems: string[] = [];
  if ('body_part' in m)
    problems.push(
      'the Worker uses the old service-worker format; export a default handler (ES module) instead',
    );
  const unknown = Object.keys(m).filter(
    (key) => !metadataKeys.has(key) && key !== 'body_part',
  );
  if (unknown.length)
    problems.push(
      `it sets ${unknown.join(', ')}, which Shipcel doesn’t deploy`,
    );
  if (
    m.observability !== undefined &&
    !observabilitySettings.safeParse(m.observability).success
  )
    problems.push(
      'observability settings beyond turning logs and traces on or off (destinations send them elsewhere)',
    );
  if (m.logpush !== undefined && m.logpush !== false)
    problems.push('Logpush sends the app’s logs elsewhere (logpush)');
  for (const key of ['tail_consumers', 'streaming_tail_consumers'])
    if (!empty(m[key]))
      problems.push(`it sends its logs to another Worker (${key})`);
  if (!empty(m.containers)) problems.push('it declares containers');
  if (!empty(m.exports)) problems.push('it declares exports');
  if (
    m.keep_bindings !== undefined &&
    !(
      Array.isArray(m.keep_bindings) &&
      m.keep_bindings.every((k) =>
        ['plain_text', 'json', 'secret_text', 'secret_key'].includes(k),
      )
    )
  )
    problems.push('it keeps bindings other than variables and secrets');
  if (
    m.placement !== undefined &&
    !z
      .object({ mode: z.literal('smart') })
      .strict()
      .safeParse(m.placement).success
  )
    problems.push('placement other than Smart Placement');
  if (m.migrations !== undefined) {
    const migrations = z
      .object({
        old_tag: z.string().optional(),
        new_tag: z.string().optional(),
        steps: z
          .array(
            z
              .object({
                new_sqlite_classes: z.array(z.string()).optional(),
                renamed_classes: z
                  .array(
                    z.object({ from: z.string(), to: z.string() }).strict(),
                  )
                  .optional(),
                deleted_classes: z.array(z.string()).optional(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .safeParse(m.migrations);
    if (!migrations.success)
      problems.push(
        'Durable Object migrations may only create (new_sqlite_classes), rename or delete classes of this Worker',
      );
  }
  const bindings = m.bindings ?? [];
  if (!Array.isArray(bindings) || bindings.length > 200)
    return [...problems, 'its bindings can’t be read'];
  const ids = (type: Created['type']) =>
    created.filter((r) => r.type === type).map((r) => r.id);
  for (const raw of bindings as unknown[]) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name : 'a binding';
    const fine =
      typeof b.name === 'string' &&
      (() => {
        switch (b.type) {
          case 'plain_text':
            return only(b, ['name', 'type', 'text']);
          case 'json':
            return only(b, ['name', 'type', 'json']);
          case 'assets':
          case 'ai':
          case 'browser':
          case 'images':
          case 'version_metadata':
          case 'inherit':
          // Cloudflare's Email Service, from the account's onboarded domains.
          case 'send_email':
            return only(b, ['name', 'type']);
          case 'durable_object_namespace':
            return (
              only(b, ['name', 'type', 'class_name']) &&
              typeof b.class_name === 'string'
            );
          case 'ratelimit':
            return (
              only(b, ['name', 'type', 'namespace_id', 'simple']) &&
              typeof b.namespace_id === 'string' &&
              /^\d{1,10}$/.test(b.namespace_id) &&
              rateLimit.safeParse(b.simple).success
            );
          case 'service':
            return (
              only(b, ['name', 'type', 'service', 'entrypoint']) &&
              b.service === workerName
            );
          case 'd1':
            return (
              only(b, ['name', 'type', 'id']) &&
              ids('d1').includes(b.id as string)
            );
          case 'kv_namespace':
            return (
              only(b, ['name', 'type', 'namespace_id']) &&
              ids('kv').includes(b.namespace_id as string)
            );
          case 'r2_bucket':
            return (
              only(b, ['name', 'type', 'bucket_name']) &&
              ids('r2').includes(b.bucket_name as string)
            );
          case 'hyperdrive':
            return (
              only(b, ['name', 'type', 'id']) &&
              ids('hyperdrive').includes(b.id as string)
            );
          default:
            return false;
        }
      })();
    if (!fine)
      problems.push(
        ['d1', 'kv_namespace', 'r2_bucket', 'hyperdrive'].includes(
          b.type as string,
        )
          ? `${name} names a database, namespace, bucket or Hyperdrive configuration that Shipcel didn’t create for this app; give the binding only its name, and Cloudflare creates one (a Hyperdrive database is added to the project in the dashboard first)`
          : b.type === 'service'
            ? `${name} binds another Worker; an app may only bind itself`
            : `${name} is a ${typeof b.type === 'string' ? b.type : 'unknown'} binding, which Shipcel doesn’t deploy from a computer yet`,
      );
  }
  return problems;
}
