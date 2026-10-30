import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  cloudflare,
  cloudflareBody,
  cloudflarePage,
  providerPath,
} from './providers';
import { change, replay, target, type Target } from './operations';
import { stagedResources } from './previews';
import { AppError, now, type AppEnv } from './types';

// Manage → Storage: the KV namespaces and R2 buckets the app's Worker binds, or for previews
// their staging copies. Reads go straight to Cloudflare. Changes are confirmed and journaled
// with the key, never the value. Downloads are attachments that never render in Shipcel.
export const storage = new Hono<AppEnv>();
export const MAX_KV_TEXT = 1048576;
export const MAX_R2_UPLOAD = 25 * 1048576;
const SHOWN = 65536,
  PAGE = 100;
const bindingName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const environmentSchema = z
  .enum(['production', 'preview'])
  .default('production');
type Environment = z.infer<typeof environmentSchema>;
const bytes = (text: string) => new TextEncoder().encode(text).length;
// KV keys are up to 512 bytes and never "." or "..". R2 keys are up to 1,024 bytes; Shipcel
// opens those whose path parts are not empty, "." or "..", so a key names exactly one object
// in the provider's request path (where slashes stay literal).
const kvKey = z
  .string()
  .min(1)
  .refine((k) => bytes(k) <= 512 && k !== '.' && k !== '..', {
    message: 'KV keys are up to 512 bytes and can’t be . or ..',
  });
const r2Key = z
  .string()
  .min(1)
  .refine(
    (k) =>
      bytes(k) <= 1024 &&
      k.split('/').every((part) => part && part !== '.' && part !== '..'),
    {
      message:
        'Shipcel opens keys of up to 1,024 bytes without empty, . or .. path parts. Use Wrangler for others.',
    },
  );
const listQuery = (c: Context<AppEnv>) => ({
  environment: environmentSchema.parse(c.req.query('environment') || undefined),
  binding: bindingName.parse(c.req.param('binding')),
  prefix: z
    .string()
    .max(1024)
    .parse(c.req.query('prefix') ?? ''),
  cursor: z
    .string()
    .max(2048)
    .optional()
    .parse(c.req.query('cursor') || undefined),
});
const confirmation = { requestId: z.string().uuid(), confirm: z.literal(true) };
const kindFor = (action: string, binding: string, environment: Environment) =>
  `${action}:${binding}${environment === 'preview' ? '@preview' : ''}`;
const objectPath = (key: string) => key.split('/').map(providerPath).join('/');
// Writes and deletes are refused for buckets R2 Data Catalog manages, as Wrangler does.
const catalogCheck = { 'cf-r2-data-catalog-check': 'true' };

type Bound = {
  kv: { binding: string; id: string }[];
  r2: { binding: string; bucket: string; jurisdiction?: string }[];
};
// What the deployed Worker binds (from its settings), or the previews' staging copies.
async function bound(
  c: Context<AppEnv>,
  t: Target,
  environment: Environment,
): Promise<Bound> {
  if (environment === 'preview') {
    const staged = await stagedResources(c, t.p.id);
    return {
      kv: staged
        .filter((s) => s.type === 'kv')
        .map((s) => ({ binding: s.binding, id: s.id })),
      r2: staged
        .filter((s) => s.type === 'r2')
        .map((s) => ({ binding: s.binding, bucket: s.id })),
    };
  }
  const { bindings = [] } = z
    .object({
      bindings: z
        .array(
          z.object({
            name: z.string(),
            type: z.string(),
            namespace_id: z.string().optional(),
            bucket_name: z.string().optional(),
            jurisdiction: z.string().optional(),
          }),
        )
        .optional(),
    })
    .parse(await cloudflare(t.token, `${t.script}/settings`));
  return {
    kv: bindings
      .filter(
        (b) =>
          b.type === 'kv_namespace' &&
          /^[a-f0-9]{32}$/.test(b.namespace_id ?? ''),
      )
      .map((b) => ({ binding: b.name, id: b.namespace_id! })),
    r2: bindings
      .filter(
        (b) =>
          b.type === 'r2_bucket' &&
          /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b.bucket_name ?? ''),
      )
      .map((b) => ({
        binding: b.name,
        bucket: b.bucket_name!,
        ...(b.jurisdiction && /^[a-z-]{2,16}$/.test(b.jurisdiction)
          ? { jurisdiction: b.jurisdiction }
          : {}),
      })),
  };
}
async function namespace(
  c: Context<AppEnv>,
  t: Target,
  binding: string,
  environment: Environment,
) {
  const found = (await bound(c, t, environment)).kv.find(
    (k) => k.binding === binding,
  );
  if (!found)
    throw new AppError(404, `The app has no KV namespace bound as ${binding}.`);
  return { id: found.id, path: `${t.root}/storage/kv/namespaces/${found.id}` };
}
async function bucket(
  c: Context<AppEnv>,
  t: Target,
  binding: string,
  environment: Environment,
) {
  const found = (await bound(c, t, environment)).r2.find(
    (b) => b.binding === binding,
  );
  if (!found)
    throw new AppError(404, `The app has no R2 bucket bound as ${binding}.`);
  return {
    ...found,
    path: `${t.root}/r2/buckets/${found.bucket}`,
    headers: found.jurisdiction
      ? { 'cf-r2-jurisdiction': found.jurisdiction }
      : ({} as Record<string, string>),
  };
}

// The first `limit` bytes of a body, and whether that was all of it.
async function head(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const chunk = await reader.read();
    if (chunk.done) break;
    chunks.push(chunk.value);
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      break;
    }
  }
  const data = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, data.length - offset);
    data.set(part, offset);
    offset += part.length;
  }
  return { data, complete: size <= limit };
}
// Text a person can read: UTF-8 without control characters other than tabs and line breaks.
function readable(data: Uint8Array, complete: boolean) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data, {
      stream: !complete,
    });
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
      ? null
      : text;
  } catch {
    return null;
  }
}
// A download that never renders or runs in Shipcel's origin.
function attachment(response: Response, key: string) {
  const name = key.split('/').pop() || 'download';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition':
      ascii === name
        ? `attachment; filename="${ascii}"`
        : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'no-store',
  });
  const length = response.headers.get('Content-Length');
  if (length && /^\d+$/.test(length)) headers.set('Content-Length', length);
  return new Response(response.body, { headers });
}
const missingValue = (error: unknown) => {
  if (error instanceof AppError && error.status === 404)
    throw new AppError(404, 'Nothing is stored under this key.');
  throw error;
};

storage.get('/projects/:id/storage', async (c) => {
  const environment = environmentSchema.parse(
    c.req.query('environment') || undefined,
  );
  const t = await target(c);
  return c.json(await bound(c, t, environment));
});

storage.get('/projects/:id/storage/kv/:binding/keys', async (c) => {
  const input = listQuery(c);
  const t = await target(c);
  const ns = await namespace(c, t, input.binding, input.environment);
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (input.prefix) query.set('prefix', input.prefix);
  if (input.cursor) query.set('cursor', input.cursor);
  const { result, info } = await cloudflarePage<unknown>(
    t.token,
    `${ns.path}/keys?${query}`,
  );
  const keys = z
    .array(z.object({ name: z.string(), expiration: z.number().optional() }))
    .parse(result);
  return c.json({
    keys: keys.map((k) => ({ name: k.name, expiration: k.expiration ?? null })),
    cursor: typeof info.cursor === 'string' && info.cursor ? info.cursor : null,
  });
});

storage.get('/projects/:id/storage/kv/:binding/value', async (c) => {
  const { environment, binding } = listQuery(c);
  const key = kvKey.parse(c.req.query('key'));
  const t = await target(c);
  const ns = await namespace(c, t, binding, environment);
  const response = await cloudflareBody(
    t.token,
    `${ns.path}/values/${providerPath(key)}`,
  ).catch(missingValue);
  const { data, complete } = await head(response, SHOWN);
  const length = Number(response.headers.get('Content-Length'));
  return c.json({
    key,
    text: readable(data, complete),
    size: complete ? data.length : length > 0 ? length : null,
    truncated: !complete,
  });
});

storage.get('/projects/:id/storage/kv/:binding/download', async (c) => {
  const { environment, binding } = listQuery(c);
  const key = kvKey.parse(c.req.query('key'));
  const t = await target(c);
  const ns = await namespace(c, t, binding, environment);
  return attachment(
    await cloudflareBody(
      t.token,
      `${ns.path}/values/${providerPath(key)}`,
    ).catch(missingValue),
    key,
  );
});

// Text values only. A key's expiration and metadata are kept: Cloudflare replaces both on
// every write, so Shipcel sends them again.
storage.put('/projects/:id/storage/kv/:binding/value', async (c) => {
  const input = z
    .object({
      key: kvKey,
      value: z
        .string()
        .refine((v) => bytes(v) <= MAX_KV_TEXT, 'Values are up to 1 MB here.'),
      environment: environmentSchema,
      ...confirmation,
    })
    .strict()
    .parse(await c.req.json());
  const binding = bindingName.parse(c.req.param('binding'));
  const t = await target(c, true),
    kind = kindFor('kv.put', binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const ns = await namespace(c, t, binding, input.environment);
  const existing = z
    .array(
      z.object({
        name: z.string(),
        expiration: z.number().optional(),
        metadata: z.unknown().optional(),
      }),
    )
    .parse(
      await cloudflare(
        t.token,
        `${ns.path}/keys?${new URLSearchParams({ prefix: input.key, limit: '10' })}`,
      ),
    )
    .find((k) => k.name === input.key);
  if (existing?.expiration && existing.expiration < now() + 60)
    throw new AppError(
      409,
      'This key expires within a minute. Wait until it has expired, then add it again.',
    );
  let body: BodyInit = input.value,
    headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
    };
  if (existing?.metadata !== undefined) {
    const form = new FormData();
    form.set('value', input.value);
    form.set('metadata', JSON.stringify(existing.metadata));
    body = form;
    headers = {};
  }
  const expiration = existing?.expiration
    ? `?expiration=${existing.expiration}`
    : '';
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      await cloudflare(
        t.token,
        `${ns.path}/values/${providerPath(input.key)}${expiration}`,
        { method: 'PUT', body, headers },
      );
      return { key: input.key };
    },
    { intent: { namespaceId: ns.id, key: input.key } },
  );
});

storage.delete('/projects/:id/storage/kv/:binding/value', async (c) => {
  const input = z
    .object({ key: kvKey, environment: environmentSchema, ...confirmation })
    .strict()
    .parse(await c.req.json());
  const binding = bindingName.parse(c.req.param('binding'));
  const t = await target(c, true),
    kind = kindFor('kv.delete', binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const ns = await namespace(c, t, binding, input.environment);
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      await cloudflare(
        t.token,
        `${ns.path}/values/${providerPath(input.key)}`,
        {
          method: 'DELETE',
        },
      );
      return { key: input.key };
    },
    { intent: { namespaceId: ns.id, key: input.key } },
  );
});

// One folder at a time: objects directly under the prefix, and the folders below it.
storage.get('/projects/:id/storage/r2/:binding/objects', async (c) => {
  const input = listQuery(c);
  const t = await target(c);
  const b = await bucket(c, t, input.binding, input.environment);
  const query = new URLSearchParams({ delimiter: '/', per_page: String(PAGE) });
  if (input.prefix) query.set('prefix', input.prefix);
  if (input.cursor) query.set('cursor', input.cursor);
  const { result, info } = await cloudflarePage<unknown>(
    t.token,
    `${b.path}/objects?${query}`,
    { headers: b.headers },
  );
  const objects = z
    .array(
      z.object({
        key: z.string(),
        size: z
          .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
          .optional(),
        last_modified: z.string().optional(),
        http_metadata: z
          .object({ contentType: z.string().optional() })
          .optional(),
      }),
    )
    .parse(result);
  return c.json({
    objects: objects.map((o) => ({
      key: o.key,
      size: o.size ?? null,
      lastModified: o.last_modified ?? null,
      contentType: o.http_metadata?.contentType ?? null,
    })),
    folders: z.array(z.string()).catch([]).parse(info.delimited),
    cursor:
      info.is_truncated === true &&
      typeof info.cursor === 'string' &&
      info.cursor
        ? info.cursor
        : null,
  });
});

storage.get('/projects/:id/storage/r2/:binding/object', async (c) => {
  const { environment, binding } = listQuery(c);
  const key = r2Key.parse(c.req.query('key'));
  const t = await target(c);
  const b = await bucket(c, t, binding, environment);
  return attachment(
    await cloudflareBody(
      t.token,
      `${b.path}/objects/${objectPath(key)}`,
      b.headers,
    ).catch(missingValue),
    key,
  );
});

// Uploads up to 25 MB (multipart: file, key, requestId, confirm). An object with the same key
// is replaced.
storage.put('/projects/:id/storage/r2/:binding/object', async (c) => {
  const form = await c.req.formData();
  const field = (name: string) => form.get(name) ?? undefined;
  const input = z
    .object({
      key: r2Key,
      environment: environmentSchema,
      requestId: z.string().uuid(),
      confirm: z.literal('true'),
    })
    .parse({
      key: field('key'),
      environment: field('environment'),
      requestId: field('requestId'),
      confirm: field('confirm'),
    });
  const file = form.get('file');
  if (!(file instanceof File))
    throw new AppError(400, 'Choose a file to upload.');
  if (file.size > MAX_R2_UPLOAD)
    throw new AppError(
      413,
      'Files up to 25 MB can be uploaded here. Use Wrangler for larger ones.',
    );
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.type)
    ? file.type
    : 'application/octet-stream';
  const binding = bindingName.parse(c.req.param('binding'));
  const t = await target(c, true),
    kind = kindFor('r2.put', binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const b = await bucket(c, t, binding, input.environment);
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      await cloudflare(t.token, `${b.path}/objects/${objectPath(input.key)}`, {
        method: 'PUT',
        body: await file.arrayBuffer(),
        headers: { ...b.headers, ...catalogCheck, 'Content-Type': type },
      });
      return { key: input.key, size: file.size };
    },
    {
      intent: {
        bucket: b.bucket,
        key: input.key,
        ...(b.jurisdiction ? { jurisdiction: b.jurisdiction } : {}),
      },
    },
  );
});

storage.delete('/projects/:id/storage/r2/:binding/object', async (c) => {
  const input = z
    .object({ key: r2Key, environment: environmentSchema, ...confirmation })
    .strict()
    .parse(await c.req.json());
  const binding = bindingName.parse(c.req.param('binding'));
  const t = await target(c, true),
    kind = kindFor('r2.delete', binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const b = await bucket(c, t, binding, input.environment);
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      await cloudflare(t.token, `${b.path}/objects/${objectPath(input.key)}`, {
        method: 'DELETE',
        headers: { ...b.headers, ...catalogCheck },
      });
      return { key: input.key };
    },
    {
      intent: {
        bucket: b.bucket,
        key: input.key,
        ...(b.jurisdiction ? { jurisdiction: b.jurisdiction } : {}),
      },
    },
  );
});
