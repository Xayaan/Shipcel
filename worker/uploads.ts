import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  activeGrant,
  cannotCreateWorkers,
  createsWorkers,
  grantToken,
  requireIdentity,
} from './auth';
import { cloudflare } from './providers';
import { seal, unseal } from './crypto';
import { change, replay, target, type Target } from './operations';
import { workersSubdomain } from './health';
import { appName } from './repository-plan';
import { notify } from './notifications';
import { refuseWhilePaused } from './budgets';
import { previewOnlyRun } from './tokens';
import { AppError, now, type AppEnv } from './types';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_REQUEST_BYTES,
  MAX_RULES_BYTES,
  MAX_WORKER_BYTES,
  SPECIAL_FILES,
  assetHash,
  assetPathProblem,
  contentTypeOf,
} from '../shared/assets';

// Direct uploads: deploy a folder of static files (and optionally one Worker module) into
// the project's own Cloudflare account, without Git. Used by the dashboard's drag and drop,
// the shipcel CLI and the MCP server. Contract: docs/contracts/direct-deploy-and-tokens.md.
//
// Cloudflare's flow (Workers static assets direct upload): an upload session with the
// manifest returns a short-lived upload token and the files it still needs; files are sent
// base64-encoded in multipart batches; the last batch returns a completion token that the
// script upload uses. A project's direct-upload Worker is recorded in deployment_jobs with
// adapter "direct-upload", so Manage (secrets, domains, versions and rollback, sign-in &
// realtime) works for it unchanged.
export const uploads = new Hono<AppEnv>();

const UPLOAD_LIFETIME = 3600;
const COMPAT_DATE = '2026-10-07';
const SCRIPT_API_DATE = { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' };
const hash = z.string().regex(/^[0-9a-f]{32}$/);
const confirmation = { requestId: z.string().uuid(), confirm: z.literal(true) };

type Upload = {
  id: string;
  workspace_id: string;
  project_id: string;
  account_id: string;
  worker_name: string;
  status: 'uploading' | 'deployed' | 'failed';
  missing_json: string;
  upload_token: string | null;
  completion_token: string | null;
  files: number;
  bytes: number;
  has_404: number;
  has_index: number;
  version_id: string | null;
  preview_url: string | null;
  url: string | null;
  published: number;
  created_at: number;
  expires_at: number;
};
type Missing = Record<string, [size: number, path: string]>;

async function ownedProject(c: Context<AppEnv>) {
  const who = requireIdentity(c, 'deploy');
  if (!who.sessionHash)
    throw new AppError(401, 'Sign in with GitHub to deploy to Cloudflare.');
  const p = await c.env.DB.prepare(
    'SELECT id, name FROM projects WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<{ id: string; name: string }>();
  if (!p) throw new AppError(404, 'Project not found.');
  return { who, p };
}

// The project's production job: none yet, a direct-upload Worker, or a Git pipeline.
// `local_adapter` is set when the Worker is an app Wrangler deploys from a computer
// (worker/local-deploys.ts) rather than a folder of files.
export async function productionJob(c: Context<AppEnv>, projectId: string) {
  return c.env.DB.prepare(
    "SELECT id, adapter, local_adapter, worker_name, worker_tag, account_id, live_url FROM deployment_jobs WHERE project_id=? AND environment='production' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(projectId)
    .first<{
      id: string;
      adapter: string;
      local_adapter: string | null;
      worker_name: string;
      worker_tag: string | null;
      account_id: string;
      live_url: string | null;
    }>();
}
// Uploading a folder of files to such a Worker would replace its code and drop its bindings.
export const deploysWithWrangler =
  'This project is an app with code or bindings that Wrangler deploys: run shipcel in its folder to deploy it. A folder of files can’t replace it.';

export async function cloudflareAccess(
  c: Context<AppEnv>,
  workspaceId: string,
) {
  if (c.env.NATIVE_BUILDS_ENABLED !== 'true')
    throw new AppError(
      503,
      'Cloud operations are disabled until provider setup is verified.',
    );
  const grant = await activeGrant(c.env, workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  const token = await grantToken(c.env, grant);
  const accountId: string = grant.account_id;
  return { grant, accountId, token, root: `/accounts/${accountId}` };
}

// What Cloudflare has under a name: nothing; the empty Worker an upload session creates for a
// new name (no code, no files, never deployed: seen live on 9 Oct 2026); or a real Worker.
export async function workerState(
  token: string,
  root: string,
  name: string,
): Promise<'none' | 'empty' | 'existing'> {
  let service: unknown;
  try {
    service = await cloudflare(token, `${root}/workers/services/${name}`);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return 'none';
    throw error;
  }
  const script = z
    .object({
      default_environment: z
        .object({
          script: z
            .object({
              deployment_id: z.string().nullable().optional(),
              has_modules: z.boolean().optional(),
              has_assets: z.boolean().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(service).default_environment?.script;
  return script &&
    !script.deployment_id &&
    !script.has_modules &&
    !script.has_assets
    ? 'empty'
    : 'existing';
}

// The Worker's Workers Logs setting (`observability`), or undefined when logs are off.
async function logSettings(token: string, root: string, name: string) {
  return (
    z
      .object({
        observability: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .parse(
        await cloudflare(
          token,
          `${root}/workers/scripts/${name}/script-settings`,
        ),
      ).observability ?? undefined
  );
}

const sealContext = (u: { workspace_id: string; id: string }) =>
  `upload:${u.workspace_id}:${u.id}`;

uploads.post('/projects/:id/uploads', async (c) => {
  const { who, p } = await ownedProject(c);
  const input = z
    .object({
      files: z
        .array(
          z
            .object({
              path: z.string(),
              hash,
              size: z.number().int().min(0).max(MAX_FILE_BYTES),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_FILES),
      workerName: appName.optional(),
    })
    .strict()
    .parse(await c.req.json());
  const paths = new Set<string>();
  for (const f of input.files) {
    const problem = assetPathProblem(f.path);
    if (problem) throw new AppError(400, `${f.path.slice(0, 200)} ${problem}.`);
    if (SPECIAL_FILES.includes(f.path))
      throw new AppError(
        400,
        `${f.path} configures the deployment: send it with the deploy request, not as a file.`,
      );
    if (paths.has(f.path))
      throw new AppError(400, `${f.path} is listed twice.`);
    paths.add(f.path);
  }
  const { grant, accountId, token, root } = await cloudflareAccess(
    c,
    who.workspaceId,
  );
  const job = await productionJob(c, p.id);
  if (job && job.adapter !== 'direct-upload')
    throw new AppError(
      409,
      'This project deploys from Git. Create another project to deploy by direct upload.',
    );
  if (job?.local_adapter) throw new AppError(409, deploysWithWrangler);
  if (who.actionsRun?.previewOnly && !job?.worker_tag)
    throw new AppError(403, previewOnlyRun);
  if (job && job.account_id !== accountId)
    throw new AppError(
      409,
      'Reconnect the Cloudflare account that owns this project.',
    );
  let workerName = job?.worker_name;
  if (!workerName) {
    if (!(await createsWorkers(c.env, grant)))
      throw new AppError(409, cannotCreateWorkers);
    // A new Worker: never adopt one that exists, in Shipcel's records or in Cloudflare.
    workerName = input.workerName ?? p.name;
    const taken = await c.env.DB.prepare(
      'SELECT 1 FROM deployment_jobs WHERE account_id=? AND worker_name=? UNION ALL SELECT 1 FROM project_backends WHERE account_id=? AND worker_name=?',
    )
      .bind(accountId, workerName, accountId, workerName)
      .first();
    // An empty Worker is Shipcel's own only when this project's earlier upload started it.
    const state = await workerState(token, root, workerName);
    const ours =
      state === 'empty' &&
      !!(await c.env.DB.prepare(
        'SELECT 1 FROM direct_uploads WHERE project_id=? AND workspace_id=? AND worker_name=? UNION ALL SELECT 1 FROM local_deploys WHERE project_id=? AND workspace_id=? AND worker_name=? LIMIT 1',
      )
        .bind(
          p.id,
          who.workspaceId,
          workerName,
          p.id,
          who.workspaceId,
          workerName,
        )
        .first());
    if (taken || state === 'existing' || (state === 'empty' && !ours))
      throw new AppError(
        409,
        `A Worker named ${workerName} already exists in this Cloudflare account. Choose another app name.`,
      );
  }
  if (!(await workersSubdomain(token, accountId)))
    throw new AppError(
      409,
      'Claim a free workers.dev subdomain for this Cloudflare account first. Every upload gets its preview address under it.',
    );
  const manifest = Object.fromEntries(
    input.files.map((f) => [f.path, { hash: f.hash, size: f.size }]),
  );
  const session = z
    .object({ jwt: z.string(), buckets: z.array(z.array(hash)).default([]) })
    .parse(
      await cloudflare(
        token,
        `${root}/workers/scripts/${workerName}/assets-upload-session`,
        { method: 'POST', body: JSON.stringify({ manifest }) },
        { errorDetail: true, timeout: 30000 },
      ),
    );
  const needed = new Set(session.buckets.flat());
  const missing: Missing = {};
  for (const f of input.files)
    if (needed.has(f.hash)) missing[f.hash] = [f.size, f.path];
  const id = crypto.randomUUID();
  const row = { workspace_id: who.workspaceId, id };
  const complete = needed.size === 0;
  const sealed = await seal(
    session.jwt,
    c.env.TOKEN_ENCRYPTION_KEY,
    sealContext(row),
  );
  await c.env.DB.prepare(
    "INSERT INTO direct_uploads (id,workspace_id,project_id,account_id,worker_name,status,missing_json,upload_token,completion_token,files,bytes,has_404,has_index,created_by,created_at,expires_at) VALUES (?,?,?,?,?,'uploading',?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      who.workspaceId,
      p.id,
      accountId,
      workerName,
      JSON.stringify(missing),
      complete ? null : sealed,
      complete ? sealed : null,
      input.files.length,
      input.files.reduce((sum, f) => sum + f.size, 0),
      Number(paths.has('/404.html')),
      Number(paths.has('/index.html')),
      who.userId,
      now(),
      now() + UPLOAD_LIFETIME - 60,
    )
    .run();
  return c.json(
    {
      uploadId: id,
      workerName,
      missing: Object.keys(missing),
      buckets: session.buckets,
      maxRequestBytes: MAX_REQUEST_BYTES,
      expiresAt: now() + UPLOAD_LIFETIME - 60,
    },
    201,
  );
});

async function openUpload(
  c: Context<AppEnv>,
  workspaceId: string,
  projectId: string,
) {
  const upload = await c.env.DB.prepare(
    'SELECT * FROM direct_uploads WHERE id=? AND project_id=? AND workspace_id=?',
  )
    .bind(c.req.param('uploadId'), projectId, workspaceId)
    .first<Upload>();
  if (!upload) throw new AppError(404, 'Upload not found.');
  if (upload.status !== 'uploading')
    throw new AppError(
      409,
      'This upload was already deployed. Start a new upload.',
    );
  if (upload.expires_at <= now())
    throw new AppError(
      410,
      'This upload expired after an hour. Start a new upload.',
    );
  return upload;
}

uploads.post('/projects/:id/uploads/:uploadId/files', async (c) => {
  const { who, p } = await ownedProject(c);
  const input = z
    .object({
      files: z
        .array(z.object({ hash, content: z.string() }).strict())
        .min(1)
        .max(MAX_FILES),
    })
    .strict()
    .parse(await c.req.json());
  const upload = await openUpload(c, who.workspaceId, p.id);
  const missing = JSON.parse(upload.missing_json) as Missing;
  if (!upload.upload_token) return c.json({ received: 0, missing: [] });
  const form = new FormData();
  for (const f of input.files) {
    const expected = missing[f.hash];
    if (!expected)
      throw new AppError(400, `File ${f.hash} is not needed for this upload.`);
    const [size, path] = expected;
    let bytes: number;
    try {
      bytes = atob(f.content).length;
    } catch {
      throw new AppError(400, `File ${f.hash} is not valid base64.`);
    }
    // Recomputed here so a file can't be stored under another file's name.
    if (bytes !== size || assetHash(f.content, path) !== f.hash)
      throw new AppError(400, `${path} does not match its hash or size.`);
    form.append(
      f.hash,
      new File([f.content], f.hash, { type: contentTypeOf(path) }),
      f.hash,
    );
  }
  const uploadJwt = await unseal<string>(
    upload.upload_token,
    c.env.TOKEN_ENCRYPTION_KEY,
    sealContext(upload),
  );
  const result = z
    .object({ jwt: z.string().optional() })
    .passthrough()
    .nullable()
    .parse(
      await cloudflare(
        uploadJwt,
        `/accounts/${upload.account_id}/workers/assets/upload?base64=true`,
        { method: 'POST', body: form },
        { errorDetail: true, timeout: 60000 },
      ),
    );
  for (const f of input.files) delete missing[f.hash];
  const remaining = Object.keys(missing);
  // Cloudflare returns the completion token with the last file it needed.
  const completion = result?.jwt && !remaining.length ? result.jwt : null;
  await c.env.DB.prepare(
    'UPDATE direct_uploads SET missing_json=?, completion_token=COALESCE(?, completion_token) WHERE id=?',
  )
    .bind(
      JSON.stringify(missing),
      completion
        ? await seal(
            completion,
            c.env.TOKEN_ENCRYPTION_KEY,
            sealContext(upload),
          )
        : null,
      upload.id,
    )
    .run();
  return c.json({ received: input.files.length, missing: remaining });
});

// The Worker's address and preview-address suffix, as Wrangler reads them.
export async function addresses(
  token: string,
  accountId: string,
  workerName: string,
) {
  const worker = z
    .object({
      subdomain: z
        .object({ preview_url_suffix: z.string().optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(
      await cloudflare(
        token,
        `/accounts/${accountId}/workers/workers/${workerName}`,
      ),
    );
  const subdomain = await workersSubdomain(token, accountId);
  // Cloudflare gives a Worker that has a Durable Object no preview addresses. Its API still
  // returns the suffix (seen live, 13 Oct 2026: the address answers Cloudflare's own 404),
  // so the Worker's bindings decide. An answer that can't be read leaves the suffix as is.
  const durable = z
    .object({ bindings: z.array(z.object({ type: z.string() }).passthrough()) })
    .passthrough()
    .safeParse(
      await cloudflare(
        token,
        `/accounts/${accountId}/workers/scripts/${workerName}/settings`,
      ).catch(() => null),
    );
  const noPreviews =
    durable.success &&
    durable.data.bindings.some((b) => b.type === 'durable_object_namespace');
  return {
    suffix: noPreviews ? null : (worker.subdomain?.preview_url_suffix ?? null),
    // Why a version has no address of its own, when Cloudflare is the reason.
    previewNote: noPreviews ? noPreviewAddresses : null,
    live: subdomain ? `https://${workerName}.${subdomain}.workers.dev/` : null,
  };
}
export const noPreviewAddresses =
  'Cloudflare gives a Worker with a Durable Object no preview addresses, so this version has none of its own.';

const setRoute = (
  t: { token: string; root: string },
  name: string,
  enabled: boolean,
) =>
  cloudflare(t.token, `${t.root}/workers/scripts/${name}/subdomain`, {
    method: 'POST',
    headers: SCRIPT_API_DATE,
    body: JSON.stringify({ enabled, previews_enabled: true }),
  });

uploads.post('/projects/:id/uploads/:uploadId/deploy', async (c) => {
  const { who, p } = await ownedProject(c);
  const input = z
    .object({
      ...confirmation,
      publish: z.boolean().optional(),
      // Upload a new version with its own preview address while production keeps serving
      // the current one. A new app's first deploy creates it unpublished instead.
      preview: z.boolean().optional(),
      // Send unknown paths to /index.html (a single-page app).
      spa: z.boolean().optional(),
      // Optional ES module that handles requests no file matches (base64).
      workerModule: z
        .string()
        .max(Math.ceil((MAX_WORKER_BYTES * 4) / 3) + 4)
        .optional(),
      redirects: z.string().max(MAX_RULES_BYTES).optional(),
      headers: z.string().max(MAX_RULES_BYTES).optional(),
    })
    .strict()
    .refine((v) => !(v.preview && v.publish), {
      message: 'A preview is never public. Deploy to production to publish.',
    })
    .parse(await c.req.json());
  const job = await productionJob(c, p.id);
  const preview = Boolean(input.preview && job?.worker_tag);
  if (who.actionsRun?.previewOnly && !preview)
    throw new AppError(403, previewOnlyRun);
  if (!preview) await refuseWhilePaused(c.env, p.id);
  // The first upload creates the Worker; later uploads go through the usual checks of the
  // recorded Worker name and tag.
  let t: Target;
  if (job?.worker_tag) t = await target(c, true);
  else {
    const access = await cloudflareAccess(c, who.workspaceId);
    t = {
      who,
      p,
      job: { account_id: access.grant.account_id } as Target['job'],
      grant: access.grant,
      token: access.token,
      root: access.root,
      script: '',
    } as Target;
  }
  const kind = preview ? 'upload.preview' : 'upload.deploy';
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const upload = await openUpload(c, who.workspaceId, p.id);
  if (!upload.completion_token)
    throw new AppError(
      409,
      'Some files have not been uploaded yet. Send every missing file, then deploy.',
    );
  if (upload.account_id !== t.grant.account_id)
    throw new AppError(
      409,
      'Reconnect the Cloudflare account that owns this project.',
    );
  let moduleText: string | null = null;
  if (input.workerModule !== undefined) {
    try {
      moduleText = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(input.workerModule), (ch) => ch.charCodeAt(0)),
      );
    } catch {
      throw new AppError(
        400,
        'The Worker module must be UTF-8 JavaScript, base64-encoded.',
      );
    }
    if (moduleText.length > MAX_WORKER_BYTES)
      throw new AppError(400, 'The Worker module is limited to 1 MiB.');
  }
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      const first = !job?.worker_tag;
      // This upload's session made the Worker it finds empty.
      if (
        first &&
        (await workerState(t.token, t.root, upload.worker_name)) === 'existing'
      )
        throw new AppError(
          409,
          `A Worker named ${upload.worker_name} already exists in this Cloudflare account. Choose another app name.`,
        );
      const completion = await unseal<string>(
        upload.completion_token!,
        c.env.TOKEN_ENCRYPTION_KEY,
        sealContext(upload),
      );
      const config = {
        html_handling: 'auto-trailing-slash',
        not_found_handling: upload.has_404
          ? '404-page'
          : input.spa && upload.has_index
            ? 'single-page-application'
            : 'none',
        ...(input.redirects ? { _redirects: input.redirects } : {}),
        ...(input.headers ? { _headers: input.headers } : {}),
      };
      const annotations = {
        'workers/message': preview
          ? 'Preview from Shipcel'
          : 'Direct upload from Shipcel',
      };
      // Workers Logs, which `shipcel logs` and Manage read. A script upload replaces the
      // setting, so one without it turns logs off (seen live on 9 Oct 2026): the first deploy
      // turns them on, as Cloudflare's dashboard does for every Worker it creates, and later
      // ones carry the Worker's own setting, so logs turned off in Cloudflare stay off.
      // Previews, promotions and secrets leave it as it is.
      const observability = preview
        ? undefined
        : first
          ? { enabled: true }
          : await logSettings(t.token, t.root, upload.worker_name);
      const form = new FormData();
      // With a module, requests no file matches run it; without one the Worker serves only
      // files, so those requests never run code.
      form.set(
        'metadata',
        JSON.stringify(
          moduleText === null
            ? {
                assets: { jwt: completion, config },
                compatibility_date: COMPAT_DATE,
                annotations,
                observability,
              }
            : {
                main_module: '_worker.js',
                bindings: [{ type: 'assets', name: 'ASSETS' }],
                // Secrets set in Manage (and sign-in & realtime's) stay, as with Wrangler.
                keep_bindings: ['secret_text', 'secret_key'],
                assets: { jwt: completion, config },
                compatibility_date: COMPAT_DATE,
                annotations,
                observability,
              },
        ),
      );
      if (moduleText !== null)
        form.set(
          '_worker.js',
          new Blob([moduleText], { type: 'application/javascript+module' }),
          '_worker.js',
        );
      if (preview) {
        // Cloudflare's version upload: a version that serves no traffic until deployed.
        const version = z
          .object({ id: z.string().uuid() })
          .passthrough()
          .parse(
            await cloudflare(
              t.token,
              `${t.root}/workers/scripts/${upload.worker_name}/versions?bindings_inherit=strict`,
              { method: 'POST', body: form },
            ),
          );
        const where = await addresses(
          t.token,
          upload.account_id,
          upload.worker_name,
        );
        const previewUrl = where.suffix
          ? `https://${version.id.slice(0, 8)}${where.suffix}`
          : null;
        await c.env.DB.prepare(
          "UPDATE direct_uploads SET status='deployed', upload_token=NULL, completion_token=NULL, version_id=?, preview_url=?, url=NULL, published=0 WHERE id=?",
        )
          .bind(version.id, previewUrl, upload.id)
          .run();
        await notify(c.env, {
          workspaceId: who.workspaceId,
          projectId: p.id,
          event: 'upload.deployed',
          text: (name) =>
            `${name}: a preview version was uploaded.${previewUrl ? ` Preview: ${previewUrl}` : ''} Production is unchanged.`,
          data: { versionId: version.id, previewUrl, url: null, preview: true },
        });
        return {
          workerName: upload.worker_name,
          versionId: version.id,
          previewUrl,
          url: null,
          published: false,
          preview: true,
          productionUrl: job!.live_url,
        };
      }
      const result = z
        .object({
          tag: z.string().regex(/^[a-f0-9]{32}$/),
          deployment_id: z.string().regex(/^[0-9a-f-]{32,36}$/),
        })
        .passthrough()
        .parse(
          await cloudflare(
            t.token,
            `${t.root}/workers/scripts/${upload.worker_name}`,
            {
              method: 'PUT',
              body: form,
            },
          ),
        );
      if (job?.worker_tag && result.tag !== job.worker_tag)
        throw new AppError(
          409,
          `The ${upload.worker_name} Worker was replaced outside Shipcel.`,
        );
      const hex = result.deployment_id.replace(/-/g, '');
      const versionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const publish = input.publish ?? (first ? false : Boolean(job?.live_url));
      if (first || input.publish !== undefined)
        await setRoute(t, upload.worker_name, publish);
      const where = await addresses(
        t.token,
        upload.account_id,
        upload.worker_name,
      );
      const previewUrl = where.suffix
        ? `https://${versionId.slice(0, 8)}${where.suffix}`
        : null;
      const url = publish ? where.live : null;
      if (first)
        await c.env.DB.prepare(
          "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,worker_tag,live_url,idempotency_key,created_at,updated_at,adapter,environment) VALUES (?,?,?,?,?,'',?,'','','','','',?,'','deployed','finished',?,?,?,?,?,'direct-upload','production')",
        )
          .bind(
            crypto.randomUUID(),
            who.workspaceId,
            p.id,
            who.userId,
            t.grant.id,
            upload.account_id,
            upload.worker_name,
            result.tag,
            url,
            `upload:${upload.id}`,
            now(),
            now(),
          )
          .run();
      else
        await c.env.DB.prepare(
          'UPDATE deployment_jobs SET live_url=?, updated_at=? WHERE id=?',
        )
          .bind(url, now(), job!.id)
          .run();
      await c.env.DB.prepare(
        "UPDATE direct_uploads SET status='deployed', upload_token=NULL, completion_token=NULL, version_id=?, preview_url=?, url=?, published=? WHERE id=?",
      )
        .bind(versionId, previewUrl, url, Number(publish), upload.id)
        .run();
      await notify(c.env, {
        workspaceId: who.workspaceId,
        projectId: p.id,
        event: 'upload.deployed',
        text: (name) =>
          `${name}: a new version was deployed.${previewUrl ? ` Preview: ${previewUrl}` : ''}${url ? ` Live: ${url}` : ' It is not published.'}`,
        data: { versionId, previewUrl, url, published: publish },
      });
      return {
        workerName: upload.worker_name,
        versionId,
        previewUrl,
        url,
        published: publish,
        // A new app's first preview deploy creates it unpublished.
        preview: Boolean(input.preview),
        productionUrl: url,
      };
    },
    { intent: { workerName: upload.worker_name, uploadId: upload.id } },
  );
});

for (const [route, enabled] of [
  ['publish', true],
  ['unpublish', false],
] as const)
  uploads.post(`/projects/:id/${route}`, async (c) => {
    const input = z
      .object(confirmation)
      .strict()
      .parse(await c.req.json());
    const t = await target(c, true);
    const job = await productionJob(c, t.p.id);
    if (job?.adapter !== 'direct-upload')
      throw new AppError(
        409,
        'Only projects deployed by direct upload can be published here.',
      );
    return change(c, t, `upload.${route}`, input.requestId, async () => {
      await setRoute(t, t.job.worker_name, enabled);
      const url = enabled
        ? (await addresses(t.token, t.job.account_id, t.job.worker_name)).live
        : null;
      await c.env.DB.prepare(
        'UPDATE deployment_jobs SET live_url=?, updated_at=? WHERE id=?',
      )
        .bind(url, now(), job.id)
        .run();
      return { published: enabled, url };
    });
  });

uploads.get('/projects/:id/uploads', async (c) => {
  const { who, p } = await ownedProject(c);
  const { results } = await c.env.DB.prepare(
    'SELECT id, status, files, bytes, created_at AS createdAt, version_id AS versionId, url, preview_url AS previewUrl, published FROM direct_uploads WHERE project_id=? AND workspace_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30',
  )
    .bind(p.id, who.workspaceId)
    .all<{ published: number }>();
  return c.json(
    results.map((r) => ({ ...r, published: Boolean(r.published) })),
  );
});
