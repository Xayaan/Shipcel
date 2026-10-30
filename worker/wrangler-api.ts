import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, limit } from './auth';
import { digest, seal, unseal } from './crypto';
import { workersSubdomain } from './health';
import {
  createdBy,
  resourceName,
  sealContext,
  type Session,
} from './local-deploys';
import { cloudflare } from './providers';
import { cronExpression } from './repository-plan';
import { bearerToken } from './tokens';
import { AppError, now, type AppEnv, type Env } from './types';
import { workerState } from './uploads';
import {
  observabilitySettings,
  uploadProblems,
  type Created,
} from './wrangler-policy';
import { hyperdriveCreated } from './hyperdrive';
import type { ResourceRequest } from '../shared/deployment-plan';
import {
  NEXT_CACHE_BINDING,
  NEXT_CACHE_ENTRIES,
  NEXT_CACHE_PREFIX,
} from '../shared/local-deploy';

// Wrangler's own requests during a deploy from a person's computer (worker/local-deploys.ts
// opens the session). CLOUDFLARE_API_BASE_URL points here and the session's token is
// Wrangler's API token: each call is checked against what that deploy may do, and only then
// sent on to Cloudflare with the workspace's connection. The calls allowed are the ones
// Wrangler 4.148 makes for `deploy` and `versions upload`, recorded against a stand-in API;
// tests/local-deploys.test.ts runs the real Wrangler through this file.
export const wranglerApi = new Hono<AppEnv>();

const API = 'https://api.cloudflare.com/client/v4';
type Envelope = {
  success: boolean;
  errors: { code: number; message: string }[];
  messages: unknown[];
  result: unknown;
  result_info?: unknown;
};

// Answers in Cloudflare's own envelope, which is what Wrangler reads.
const answer = (c: Context<AppEnv>, body: Envelope, status = 200) =>
  c.json(body, status as 200);
const ok = (result: unknown): Envelope => ({
  success: true,
  errors: [],
  messages: [],
  result,
});
// A code Wrangler gives no meaning of its own.
const refusal = (message: string, code = 97001): Envelope => ({
  success: false,
  errors: [{ code, message }],
  messages: [],
  result: null,
});
const refuse = (c: Context<AppEnv>, message: string, status = 403) =>
  answer(c, refusal(`Shipcel: ${message}`), status);
// Whatever goes wrong here, Wrangler gets an answer in that shape, and prints it.
wranglerApi.onError((error, c) =>
  error instanceof AppError
    ? refuse(c, error.message, error.status)
    : refuse(
        c,
        'something went wrong on Shipcel’s side. Try the deploy again.',
        500,
      ),
);

// Sends a call on to Cloudflare with the workspace's connection. Redirects are never
// followed; an answer that isn't Cloudflare's JSON becomes a refusal.
async function forward(
  token: string,
  path: string,
  init: RequestInit = {},
  timeout = 30000,
): Promise<{ status: number; body: Envelope }> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return {
      status: 502,
      body: refusal(
        'Shipcel could not reach Cloudflare. Try the deploy again.',
      ),
    };
  }
  let body: Envelope | null = null;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (parsed && typeof parsed === 'object' && 'success' in parsed)
      body = parsed as Envelope;
  } catch {
    /* Not Cloudflare's JSON: refused below. */
  }
  if (!body || (response.status >= 300 && response.status < 400))
    return {
      status: 502,
      body: refusal('Cloudflare gave an answer Shipcel could not read.'),
    };
  return { status: response.status, body };
}
// Cloudflare notes which tool made a deploy. Seen live on 13 Oct 2026: an upload sent on
// without Wrangler's own name was filed as made "via the script API", and Wrangler warned
// about that on every later deploy of the app. It is Wrangler deploying, so its name goes
// on with the upload, in the one form Wrangler writes it and no other.
const wranglerAgent = (c: Context<AppEnv>): Record<string, string> => {
  const agent = c.req.header('User-Agent') ?? '';
  return /^wrangler\/\d{1,3}\.\d{1,4}\.\d{1,4}$/.test(agent)
    ? { 'User-Agent': agent }
    : {};
};
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...headers },
});

// The session a call belongs to: its token, still open, and the person who opened it still
// a developer of the workspace, with the same Cloudflare connection. Filling OpenNext's
// cache is counted on its own: an entry per page, which a deploy's few dozen calls aren't.
async function sessionFor(c: Context<AppEnv>, cacheFill = false) {
  if (c.env.NATIVE_BUILDS_ENABLED !== 'true') return null;
  const presented = bearerToken(c);
  const id = c.req.param('session');
  if (!presented || !z.string().uuid().safeParse(id).success) return null;
  const s = await c.env.DB.prepare(
    "SELECT d.* FROM local_deploys d JOIN memberships m ON m.workspace_id=d.workspace_id AND m.user_id=d.user_id AND m.role IN ('owner','developer') JOIN projects p ON p.id=d.project_id AND p.workspace_id=d.workspace_id WHERE d.id=? AND d.status='open' AND d.expires_at>?",
  )
    .bind(id, now())
    .first<Session>();
  if (!s || (await digest(presented)) !== s.secret_hash) return null;
  // The sign-in that opened the deploy still stands: an API token that isn't revoked or
  // expired, or a browser session that hasn't signed out.
  const signedIn = s.opened_with?.startsWith('pat:')
    ? c.env.DB.prepare(
        'SELECT 1 FROM api_tokens WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
      ).bind(s.opened_with.slice(4), now())
    : c.env.DB.prepare(
        'SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?',
      ).bind(s.opened_with, now());
  if (!(await signedIn.first())) return null;
  const grant = await activeGrant(c.env, s.workspace_id, 'cloudflare');
  if (!grant || grant.id !== s.grant_id || grant.account_id !== s.account_id)
    return null;
  // A deploy makes a few dozen calls. The workspace's limit keeps one deploy from using
  // up the calls Cloudflare allows the whole connection (1,200 every five minutes), which
  // is also why a deploy fills at most NEXT_CACHE_ENTRIES cache entries, at a steady pace.
  if (cacheFill) {
    await limit(c.env, `local-deploy-cache:${s.id}`, CACHE_FILLS_PER_MINUTE);
    await limit(
      c.env,
      `local-deploy-cache-all:${s.id}`,
      NEXT_CACHE_ENTRIES,
      3600,
    );
  } else {
    await limit(c.env, `local-deploy:${s.id}`, 240);
    await limit(c.env, `local-deploys:${s.workspace_id}`, 600);
  }
  // Shows the deploy is still going (see ACTIVE_SECONDS).
  await c.env.DB.prepare(
    "UPDATE project_operations SET updated_at=? WHERE id=? AND status='running' AND updated_at<?",
  )
    .bind(now(), s.operation_id, now() - 10)
    .run();
  return { s, grant, secret: presented };
}

// What a call may carry, by its declared length: a deploy's settings are small, its code
// is read into memory to be checked, and only its files are streamed.
const KIB = 1024;
export const WRANGLER_MAX_BYTES = 100 * KIB * KIB;
const CODE_MAX_BYTES = 32 * KIB * KIB;
const MAX_PARTS = 2000;
// One cache entry is one page's HTML and data.
const CACHE_ENTRY_BYTES = 25 * KIB * KIB;
export const CACHE_FILLS_PER_MINUTE = 100;
// OpenNext's R2 cache entry: `<prefix>/<build id>/<SHA-256 of the key>.cache`, or `.fetch`
// for a fetch() Next.js cached (computeCacheKey in @opennextjs/cloudflare 1.20.14).
const cacheKey = new RegExp(
  `^${NEXT_CACHE_PREFIX}/[\\w-]{1,128}/[0-9a-f]{64}\\.(?:cache|fetch)$`,
);
// `<account>/r2/buckets/<bucket>/objects/<key>`: the bucket and key of an object call.
function objectCall(path: string, root: string) {
  const start = `${root}/r2/buckets/`;
  if (!path.startsWith(start)) return null;
  const [bucket, objects, ...key] = path.slice(start.length).split('/');
  return objects === 'objects' ? { bucket, key: key.join('/') } : null;
}
// Whether one of this project's deploys (this one or an earlier one) created the bucket.
async function madeForProject(env: Env, s: Session, bucket: string) {
  const { results } = await env.DB.prepare(
    'SELECT created_json FROM local_deploys WHERE project_id=? AND workspace_id=? AND account_id=? AND worker_name=? ORDER BY created_at DESC LIMIT 30',
  )
    .bind(s.project_id, s.workspace_id, s.account_id, s.worker_name)
    .all<{ created_json: string }>();
  return results.some((row) =>
    (JSON.parse(row.created_json) as Created[]).some(
      (r) => r.type === 'r2' && r.id === bucket,
    ),
  );
}

// Runs before anyone is identified, so it never reads a body: a request says how long it
// is, or is refused. (A limit that counts bytes as they arrive would hold up to that many
// in memory for a caller who has shown no token yet.)
export const wranglerGate: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const length = c.req.header('Content-Length');
    if (
      c.req.header('Transfer-Encoding') ||
      !length ||
      !/^\d{1,10}$/.test(length)
    )
      return c.json(
        refusal('Shipcel: a request has to say how long it is.'),
        411,
      );
    if (Number(length) > WRANGLER_MAX_BYTES)
      return c.json(
        refusal('Shipcel: that is more than a deploy sends at once.'),
        413,
      );
  }
  await next();
};

// The first production upload creates the project's Worker record; later ones keep it.
async function recordUpload(
  env: Env,
  s: Session,
  token: string,
  result: Record<string, unknown>,
) {
  const hex =
    typeof result.deployment_id === 'string'
      ? result.deployment_id.replace(/-/g, '')
      : '';
  const versionId = /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : null;
  let tag =
    typeof result.tag === 'string' && /^[a-f0-9]{32}$/.test(result.tag)
      ? result.tag
      : null;
  if (!tag)
    tag =
      z
        .array(z.object({ id: z.string(), tag: z.string() }))
        .parse(
          await cloudflare(token, `/accounts/${s.account_id}/workers/scripts`),
        )
        .find((w) => w.id === s.worker_name)?.tag ?? null;
  const job = await env.DB.prepare(
    "SELECT id, worker_tag FROM deployment_jobs WHERE project_id=? AND environment='production' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(s.project_id)
    .first<{ id: string; worker_tag: string | null }>();
  const statements = [
    env.DB.prepare(
      'UPDATE local_deploys SET version_id=COALESCE(?, version_id), live=1 WHERE id=?',
    ).bind(versionId, s.id),
  ];
  if (!job)
    statements.push(
      env.DB.prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,worker_tag,live_url,idempotency_key,created_at,updated_at,adapter,environment,resources_json,local_adapter) VALUES (?,?,?,?,?,'',?,'','','','','',?,'','deployed','finished',?,NULL,?,?,?,'direct-upload','production',?,?)",
      ).bind(
        crypto.randomUUID(),
        s.workspace_id,
        s.project_id,
        s.user_id,
        s.grant_id,
        s.account_id,
        s.worker_name,
        tag,
        `local:${s.id}`,
        now(),
        now(),
        s.resources_json,
        s.adapter,
      ),
    );
  else
    statements.push(
      env.DB.prepare(
        'UPDATE deployment_jobs SET local_adapter=?, resources_json=?, worker_tag=COALESCE(worker_tag, ?), updated_at=? WHERE id=?',
      ).bind(s.adapter, s.resources_json, tag, now(), job.id),
    );
  await env.DB.batch(statements);
}

// A resource this project's earlier deploy created and never bound, if Cloudflare still has
// it: Wrangler never adopts a resource by name, so without this a deploy that stopped
// half-way could not be repeated.
async function earlier(
  env: Env,
  s: Session,
  token: string,
  type: Created['type'],
  name: string,
) {
  const { results } = await env.DB.prepare(
    'SELECT created_json FROM local_deploys WHERE project_id=? AND workspace_id=? AND account_id=? AND worker_name=? AND id<>? ORDER BY created_at DESC LIMIT 30',
  )
    .bind(s.project_id, s.workspace_id, s.account_id, s.worker_name, s.id)
    .all<{ created_json: string }>();
  const found = results
    .flatMap((row) => JSON.parse(row.created_json) as Created[])
    .find((r) => r.type === type && r.name === name);
  if (!found) return null;
  const root = `/accounts/${s.account_id}`;
  const path =
    type === 'd1'
      ? `${root}/d1/database/${found.id}`
      : type === 'kv'
        ? `${root}/storage/kv/namespaces/${found.id}`
        : `${root}/r2/buckets/${found.id}`;
  const { status, body } = await forward(token, path);
  return status === 200 && body.success ? found : null;
}

const resourceRoutes = {
  kv: { path: 'storage/kv/namespaces', key: 'title', id: 'id' },
  d1: { path: 'd1/database', key: 'name', id: 'uuid' },
  r2: { path: 'r2/buckets', key: 'name', id: 'name' },
} as const;

wranglerApi.all('/wrangler/:session/client/v4/*', async (c) => {
  const fillsCache =
    c.req.method === 'PUT' &&
    /\/r2\/buckets\/[^/]+\/objects\//.test(new URL(c.req.url).pathname);
  const found = await sessionFor(c, fillsCache);
  if (!found)
    return refuse(
      c,
      'this deploy session is no longer open. Run shipcel again to start a new deploy.',
      401,
    );
  const { s, grant, secret } = found;
  const url = new URL(c.req.url);
  const path = url.pathname.slice(url.pathname.indexOf('/client/v4') + 10);
  const method = c.req.method;
  const root = `/accounts/${s.account_id}`;
  const script = `${root}/workers/scripts/${s.worker_name}`;
  // Query strings Wrangler adds are short lists of flags.
  const search = /^\?[\w=&.%-]{0,300}$/.test(url.search) ? url.search : '';
  const uploadsCode =
    (method === 'PUT' && path === script) ||
    (method === 'POST' && path === `${script}/versions`);
  const most =
    method === 'POST' && path === `${root}/workers/assets/upload`
      ? WRANGLER_MAX_BYTES
      : uploadsCode
        ? CODE_MAX_BYTES
        : method === 'POST' && path === `${script}/assets-upload-session`
          ? 8 * KIB * KIB
          : fillsCache
            ? CACHE_ENTRY_BYTES
            : 64 * KIB;
  if (Number(c.req.header('Content-Length') ?? 0) > most)
    return refuse(
      c,
      uploadsCode
        ? 'the app’s code is larger than 32 MB, which is more than Shipcel passes on.'
        : 'that request is larger than this part of a deploy sends.',
      413,
    );

  // Answered here, without asking Cloudflare anything.
  if (method === 'GET') {
    // Wrangler asks who it is only to explain an error.
    if (path === '/user/tokens/verify')
      return answer(c, ok({ id: s.id.replace(/-/g, ''), status: 'active' }));
    if (path === '/user')
      return answer(c, ok({ id: 'shipcel', email: 'Shipcel' }));
    if (path === '/accounts' || path === '/memberships') {
      const account = { id: s.account_id, name: 'Cloudflare account' };
      return answer(c, ok(path === '/accounts' ? [account] : [{ account }]));
    }
    // Wrangler lists the account's resources to offer them in a prompt. It creates new
    // ones here without asking, so the lists stay empty and nothing of the account leaks.
    if (path === `${root}/${resourceRoutes.kv.path}`)
      return answer(c, {
        ...ok([]),
        result_info: { page: 1, per_page: 100, count: 0, total_count: 0 },
      });
    if (path === `${root}/${resourceRoutes.d1.path}`) return answer(c, ok([]));
    if (path === `${root}/${resourceRoutes.r2.path}`)
      return answer(c, ok({ buckets: [] }));
  }
  const token = await grantToken(c.env, grant);
  // A new app's Worker doesn't exist until this deploy's own upload makes it. Until then
  // nothing else may touch a Worker of that name: one that appeared since isn't this app.
  const exists = !s.first || s.live === 1;
  const notYet = () =>
    refuse(c, 'the app has to be uploaded before this can change.', 409);
  // A read goes on with its query (paging, filters); a change goes on without one.
  const pass = async (init?: RequestInit, timeout?: number) => {
    const { status, body } = await forward(
      token,
      `${path}${init ? '' : search}`,
      init,
      timeout,
    );
    return { status, body, done: answer(c, body, status) };
  };
  const body = async <T>(schema: z.ZodType<T>) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? parsed.data : null;
  };
  const update = (sql: string, ...values: (string | number | null)[]) =>
    c.env.DB.prepare(`UPDATE local_deploys SET ${sql} WHERE id=?`)
      .bind(...values, s.id)
      .run();

  if (method === 'GET') {
    // What the Worker is and has: only this deploy's own Worker.
    if (
      path === `${root}/workers/services/${s.worker_name}` ||
      path === `${root}/workers/workers/${s.worker_name}` ||
      path === `${root}/workers/subdomain` ||
      (path.startsWith(`${script}/`) &&
        /^(?:secrets|script-settings|subdomain|schedules)$/.test(
          path.slice(script.length + 1),
        ))
    )
      return (await pass()).done;
    // Which versions production serves. Who deployed them, their messages and their
    // settings stay in Cloudflare (a version's details would carry variable values).
    if (path === `${script}/deployments`) {
      const { status, body: listed } = await forward(token, `${path}${search}`);
      if (status !== 200 || !listed.success) return answer(c, listed, status);
      const deployments = z
        .object({
          deployments: z.array(
            z.object({
              id: z.string().optional(),
              source: z.string().optional(),
              strategy: z.string().optional(),
              created_on: z.string().optional(),
              versions: z.array(
                z.object({ version_id: z.string(), percentage: z.number() }),
              ),
            }),
          ),
        })
        .safeParse(listed.result);
      return answer(
        c,
        ok({
          deployments: deployments.success ? deployments.data.deployments : [],
        }),
      );
    }
    // Bindings by name and kind, which is what decides whether one is reused. Values of
    // variables and the IDs of resources stay in Cloudflare.
    if (path === `${script}/settings`) {
      const { status, body: settings } = await forward(token, path);
      if (status !== 200 || !settings.success)
        return answer(c, settings, status);
      const bindings = z
        .array(
          z
            .object({
              name: z.string(),
              type: z.string(),
              jurisdiction: z.string().optional(),
            })
            .transform(({ name, type, jurisdiction }) => ({
              name,
              type,
              ...(jurisdiction ? { jurisdiction } : {}),
            })),
        )
        .safeParse(
          (settings.result as { bindings?: unknown } | null)?.bindings ?? [],
        );
      return answer(c, ok({ bindings: bindings.success ? bindings.data : [] }));
    }
    // Other Workers of the account are none of this deploy's business.
    if (path === `${root}/workers/scripts`) {
      const { status, body: list } = await forward(token, path);
      if (status !== 200 || !list.success) return answer(c, list, status);
      return answer(
        c,
        ok(
          (Array.isArray(list.result) ? list.result : []).filter(
            (w: { id?: unknown }) => w?.id === s.worker_name,
          ),
        ),
      );
    }
  }

  // Files: Cloudflare's upload session. Its tokens stay here, sealed; Wrangler gets this
  // session's own token in their place and presents it with the files.
  if (method === 'POST' && path === `${script}/assets-upload-session`) {
    const manifest = await body(
      z
        .object({
          manifest: z.record(
            z.string(),
            z.object({ hash: z.string(), size: z.number() }).strict(),
          ),
        })
        .strict(),
    );
    if (!manifest)
      return refuse(c, 'the list of files could not be read.', 400);
    const { status, body: started } = await forward(
      token,
      path,
      { method, ...json(manifest) },
      60000,
    );
    const result = z
      .object({
        jwt: z.string(),
        buckets: z.array(z.array(z.string())).default([]),
      })
      .safeParse(started.result);
    if (status >= 300 || !started.success)
      return answer(
        c,
        { ...started, result: null },
        status >= 300 ? status : 502,
      );
    if (!result.success)
      return refuse(
        c,
        'Cloudflare’s answer about the app’s files could not be read.',
        502,
      );
    const sealed = await seal(
      result.data.jwt,
      c.env.TOKEN_ENCRYPTION_KEY,
      sealContext(s),
    );
    const files = Object.values(manifest.manifest);
    const complete = result.data.buckets.flat().length === 0;
    await update(
      'upload_token=?, completion_token=?, files=?, bytes=?',
      complete ? null : sealed,
      complete ? sealed : null,
      files.length,
      files.reduce((sum, f) => sum + f.size, 0),
    );
    return answer(c, ok({ ...result.data, jwt: secret }), status);
  }
  if (method === 'POST' && path === `${root}/workers/assets/upload`) {
    if (!s.upload_token)
      return refuse(
        c,
        'there is no file upload in progress for this deploy.',
        409,
      );
    const { status, body: uploaded } = await forward(
      await unseal<string>(
        s.upload_token,
        c.env.TOKEN_ENCRYPTION_KEY,
        sealContext(s),
      ),
      `${path}?base64=true`,
      {
        method,
        headers: { 'Content-Type': c.req.header('Content-Type') ?? '' },
        body: c.req.raw.body,
        // Node needs this to send a stream; Workers streams without it.
        ...({ duplex: 'half' } as RequestInit),
      },
      300000,
    );
    const completion = (uploaded.result as { jwt?: unknown } | null)?.jwt;
    if (uploaded.success && typeof completion === 'string') {
      await update(
        'completion_token=?',
        await seal(completion, c.env.TOKEN_ENCRYPTION_KEY, sealContext(s)),
      );
      return answer(
        c,
        ok({ ...(uploaded.result as object), jwt: secret }),
        status,
      );
    }
    return answer(
      c,
      uploaded.success ? uploaded : { ...uploaded, result: null },
      status,
    );
  }

  // Resources: only the reviewed ones, under the name Wrangler gives them.
  for (const type of ['kv', 'd1', 'r2'] as const) {
    const route = resourceRoutes[type];
    if (method !== 'POST' || path !== `${root}/${route.path}`) continue;
    const named = await body(
      z.object({ [route.key]: z.string() }).passthrough(),
    );
    const name = named ? String(named[route.key]) : '';
    const reviewed = (JSON.parse(s.create_json) as ResourceRequest[]).some(
      (r) => r.type === type && resourceName(s.worker_name, r.binding) === name,
    );
    if (!reviewed)
      return refuse(
        c,
        `this deploy wasn’t reviewed to create ${name || 'that resource'}. Declare the binding in your Wrangler configuration with only its name, then run shipcel again.`,
      );
    const made = createdBy(s);
    const remember = async (id: string) => {
      // Appended in one statement, so two creations at once both stay recorded.
      if (!made.some((r) => r.type === type && r.id === id))
        await update(
          "created_json=json_insert(created_json,'$[#]',json(?))",
          JSON.stringify({ type, name, id }),
        );
    };
    const before = await earlier(c.env, s, token, type, name);
    if (before) {
      await remember(before.id);
      return answer(c, ok({ [route.key]: name, [route.id]: before.id }));
    }
    const { status, body: created } = await forward(token, path, {
      method,
      ...json({ [route.key]: name }),
    });
    const id =
      type === 'r2'
        ? name
        : (created.result as Record<string, unknown> | null)?.[route.id];
    if (status < 300 && created.success && typeof id === 'string')
      await remember(id);
    return answer(c, created, status);
  }

  // Code: the Worker itself, as a production deploy or a version that serves no traffic.
  const deploys = method === 'PUT' && path === script;
  if (deploys || (method === 'POST' && path === `${script}/versions`)) {
    if (deploys && !s.production)
      return refuse(
        c,
        'this deploy uploads a preview; it can’t replace production.',
      );
    if (!deploys && !exists) return notYet();
    // The Worker this deploy was reviewed against is still the one in Cloudflare.
    if (!s.first && s.worker_tag) {
      const workers = z
        .array(z.object({ id: z.string(), tag: z.string() }))
        .safeParse(
          await cloudflare(token, `${root}/workers/scripts`).catch(() => null),
        );
      if (
        !workers.success ||
        !workers.data.some(
          (w) => w.id === s.worker_name && w.tag === s.worker_tag,
        )
      )
        return refuse(
          c,
          `the Worker ${s.worker_name} changed in Cloudflare since this deploy was reviewed. Run shipcel again.`,
          409,
        );
    }
    let form: FormData;
    let metadata: Record<string, unknown>;
    try {
      form = await c.req.raw.formData();
      metadata = JSON.parse(String(form.get('metadata')));
    } catch {
      return refuse(c, 'the upload could not be read.', 400);
    }
    if ([...form.keys()].length > MAX_PARTS)
      return refuse(c, 'the upload has more parts than a Worker can.', 413);
    const problems = uploadProblems(metadata, s.worker_name, [
      ...createdBy(s),
      ...(await hyperdriveCreated(c.env, s.project_id)),
    ]);
    if (problems.length)
      return refuse(
        c,
        `this app can’t deploy from a computer yet: ${problems.join('; ')}.`,
      );
    // A new app's Worker must be new: its name was free when the deploy was reviewed.
    if (
      deploys &&
      s.first &&
      !s.live &&
      (await workerState(token, root, s.worker_name)) === 'existing'
    )
      return refuse(
        c,
        `a Worker named ${s.worker_name} already exists in this Cloudflare account. Choose another app name.`,
        409,
      );
    const assets = metadata.assets as { jwt?: unknown } | undefined;
    if (assets && typeof assets === 'object' && 'jwt' in assets) {
      if (!s.completion_token)
        return refuse(c, 'the app’s files haven’t finished uploading.', 409);
      assets.jwt = await unseal<string>(
        s.completion_token,
        c.env.TOKEN_ENCRYPTION_KEY,
        sealContext(s),
      );
    }
    if (deploys && s.keep_logs && metadata.observability === undefined)
      metadata.observability = { enabled: true };
    const sent = new FormData();
    sent.set('metadata', JSON.stringify(metadata));
    for (const [key, value] of form.entries())
      if (key !== 'metadata')
        if (typeof value === 'string') sent.append(key, value);
        else sent.append(key, value, value.name);
    // Only the flags Wrangler sends with an upload go on: nothing that would make the
    // call do something else (Cloudflare's API can roll back from a query, for one).
    const flags = new URLSearchParams();
    for (const key of [
      'excludeScript',
      'bindings_inherit',
      'include_subdomain_availability',
    ]) {
      const value = url.searchParams.get(key);
      if (value !== null && /^[\w-]{1,20}$/.test(value)) flags.set(key, value);
    }
    const { status, body: uploaded } = await forward(
      token,
      `${path}${flags.size ? `?${flags}` : ''}`,
      { method, body: sent, headers: wranglerAgent(c) },
      120000,
    );
    if (status < 300 && uploaded.success) {
      const result = (uploaded.result ?? {}) as Record<string, unknown>;
      if (deploys) await recordUpload(c.env, s, token, result);
      else if (typeof result.id === 'string')
        await update('version_id=?, live=0', result.id);
    }
    return answer(c, uploaded, status);
  }

  // Everything below changes what production serves.
  const production = (message: string) =>
    s.production
      ? null
      : refuse(c, `this deploy uploads a preview; ${message}`);
  if (method === 'POST' && path === `${script}/deployments`) {
    const deployment = await body(
      z
        .object({
          strategy: z.literal('percentage'),
          versions: z
            .array(
              z
                .object({ version_id: z.string(), percentage: z.literal(100) })
                .strict(),
            )
            .length(1),
          annotations: z.record(z.string(), z.string()).optional(),
          code_update_strategy: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    );
    const stopped = production('it can’t change production.');
    if (stopped) return stopped;
    if (!exists) return notYet();
    if (!deployment || deployment.versions[0].version_id !== s.version_id)
      return refuse(
        c,
        'a deploy sends production to the version it just uploaded, and nothing else.',
      );
    const { status, body: deployed } = await forward(token, path, {
      method,
      ...json(deployment, wranglerAgent(c)),
    });
    if (status < 300 && deployed.success) {
      await update('live=1');
      await c.env.DB.prepare(
        "UPDATE deployment_jobs SET local_adapter=?, resources_json=?, updated_at=? WHERE project_id=? AND environment='production'",
      )
        .bind(s.adapter, s.resources_json, now(), s.project_id)
        .run();
    }
    return answer(c, deployed, status);
  }
  if (method === 'PATCH' && path === `${script}/script-settings`) {
    const settings = await body(
      z
        .object({
          observability: observabilitySettings.nullable().optional(),
          tags: z.array(z.string().max(200)).max(20).nullable().optional(),
          logpush: z.literal(false).nullable().optional(),
          tail_consumers: z.array(z.unknown()).max(0).nullable().optional(),
          streaming_tail_consumers: z
            .array(z.unknown())
            .max(0)
            .nullable()
            .optional(),
        })
        .strict(),
    );
    if (!settings)
      return refuse(
        c,
        'these Worker settings aren’t deployed from a computer (only observability and tags are).',
      );
    return (
      production('it can’t change the Worker’s settings.') ??
      (exists ? null : notYet()) ??
      (
        await pass({
          method,
          ...json(
            s.keep_logs
              ? { ...settings, observability: { enabled: true } }
              : settings,
          ),
        })
      ).done
    );
  }
  if (method === 'POST' && path === `${script}/subdomain`) {
    const route = await body(
      z
        .object({
          enabled: z.boolean(),
          previews_enabled: z.boolean().optional(),
        })
        .strict(),
    );
    if (!route)
      return refuse(c, 'the address settings could not be read.', 400);
    const stopped = production('it can’t change the app’s address.');
    if (stopped) return stopped;
    if (!exists) return notYet();
    const apiDate = c.req.header('Cloudflare-Workers-Script-Api-Date');
    // Previews keep their own addresses unless the configuration turns them off.
    const { status, body: set } = await forward(token, path, {
      method,
      ...json(
        {
          enabled: route.enabled,
          previews_enabled: route.previews_enabled ?? true,
        },
        apiDate && /^\d{4}-\d{2}-\d{2}$/.test(apiDate)
          ? { 'Cloudflare-Workers-Script-Api-Date': apiDate }
          : {},
      ),
    });
    if (status < 300 && set.success) {
      const subdomain = route.enabled
        ? await workersSubdomain(token, s.account_id)
        : null;
      await update('published=?', Number(route.enabled));
      await c.env.DB.prepare(
        "UPDATE deployment_jobs SET live_url=?, updated_at=? WHERE project_id=? AND environment='production'",
      )
        .bind(
          subdomain
            ? `https://${s.worker_name}.${subdomain}.workers.dev/`
            : null,
          now(),
          s.project_id,
        )
        .run();
    }
    return answer(c, set, status);
  }
  if (method === 'PUT' && path === `${script}/schedules`) {
    const schedules = await body(
      z.array(z.object({ cron: cronExpression }).strict()).max(5),
    );
    if (!schedules)
      return refuse(
        c,
        'use up to five cron expressions of five fields (minute hour day month weekday).',
        400,
      );
    return (
      production('it can’t change the app’s schedules.') ??
      (exists ? null : notYet()) ??
      (await pass({ method, ...json(schedules) })).done
    );
  }
  // OpenNext's incremental cache: once production serves this deploy's version of a Next.js
  // app, the CLI fills the app's own cache bucket with what Next.js prerendered, one object
  // per entry, at the keys OpenNext reads (packages/cli/src/opennext.ts). Only that bucket,
  // made by Shipcel for this project, and only entries of OpenNext's shape.
  const object = method === 'PUT' ? objectCall(path, root) : null;
  if (object) {
    if (s.adapter !== 'nextjs')
      return refuse(c, 'only a Next.js app’s deploy fills OpenNext’s cache.');
    if (!s.production)
      return refuse(
        c,
        'a preview shares production’s cache, so it fills nothing.',
      );
    const bucket = resourceName(s.worker_name, NEXT_CACHE_BINDING);
    const reviewed = (JSON.parse(s.resources_json) as ResourceRequest[]).some(
      (r) => r.type === 'r2' && r.binding === NEXT_CACHE_BINDING,
    );
    if (!reviewed || object.bucket !== bucket || !cacheKey.test(object.key))
      return refuse(
        c,
        `a deploy fills only OpenNext’s cache entries, in the app’s own bucket (${bucket}).`,
      );
    if (!s.live)
      return refuse(
        c,
        'the app has to be uploaded before its cache is filled.',
        409,
      );
    if (!(await madeForProject(c.env, s, bucket)))
      return refuse(
        c,
        `Shipcel didn’t create ${bucket} for this app, so it leaves the bucket alone.`,
      );
    return (
      await pass(
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': c.req.header('Content-Length') ?? '0',
          },
          body: c.req.raw.body,
          // Node needs this to send a stream; Workers streams without it.
          ...({ duplex: 'half' } as RequestInit),
        },
        60000,
      )
    ).done;
  }
  return refuse(
    c,
    `Wrangler asked for ${method} ${path.replace(root, '').slice(0, 120)}, which a deploy from a computer doesn’t include. Settings such as routes, queues and other products deploy from GitHub (shipcel git connect).`,
  );
});
