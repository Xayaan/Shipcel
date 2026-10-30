import { Hono, type Context } from 'hono';
import { parse } from 'jsonc-parser';
import { z } from 'zod';
import { cannotCreateWorkers, createsWorkers, requireIdentity } from './auth';
import { digest, randomToken } from './crypto';
import { freeOnlyIssues } from './free-only';
import { pausedForBudget } from './budgets';
import { workersSubdomain } from './health';
import { hyperdriveCreated } from './hyperdrive';
import { notify } from './notifications';
import { cloudflare } from './providers';
import { previewOnlyRun } from './tokens';
import {
  appName,
  bucketNameIssues,
  detectFramework,
  repositoryPlan,
} from './repository-plan';
import {
  addresses,
  cloudflareAccess,
  productionJob,
  workerState,
} from './uploads';
import { AppError, now, type AppEnv, type Env } from './types';
import type { ResourceRequest } from '../shared/deployment-plan';
import {
  LOCAL_PLAN_FILE_BYTES,
  NEXT_CACHE_BINDING,
  NEXT_CACHE_PREFIX,
  localPlanFiles,
  localPlanLimit,
  type LocalPlan,
} from '../shared/local-deploy';
import type { Created } from './wrangler-policy';

// Deploys of apps with code and bindings from a person's computer. The shipcel CLI builds
// the app there and runs Wrangler; Wrangler needs Cloudflare's API, and the workspace's
// Cloudflare connection stays in Shipcel. So for one deploy Shipcel opens a session and
// Wrangler talks to Cloudflare through it (CLOUDFLARE_API_BASE_URL points here, with the
// session's own token): every call is checked against what that deploy may do, and only then
// sent on with the connection's token. A deploy can reach one Worker, create only the
// resources that were reviewed, and bind only those. Cloudflare's upload tokens never leave
// Shipcel. This file reviews a folder and opens and closes the sessions;
// worker/wrangler-api.ts answers Wrangler's calls.
export const localDeploys = new Hono<AppEnv>();

const SESSION_LIFETIME = 3600;
// A session with a call in the last two minutes is still deploying.
const ACTIVE_SECONDS = 120;
const confirmation = { requestId: z.string().uuid(), confirm: z.literal(true) };
const filesSchema = z
  .record(z.string(), z.string().max(LOCAL_PLAN_FILE_BYTES).nullable())
  .refine((files) =>
    Object.entries(files).every(
      ([name, text]) =>
        localPlanFiles.includes(name) &&
        (text?.length ?? 0) <= localPlanLimit(name),
    ),
  );

export type Session = {
  id: string;
  workspace_id: string;
  project_id: string;
  user_id: string;
  grant_id: string;
  account_id: string;
  worker_name: string;
  adapter: string;
  production: number;
  first: number;
  status: 'open' | 'deployed' | 'failed';
  secret_hash: string;
  opened_with: string | null;
  operation_id: string;
  worker_tag: string | null;
  resources_json: string;
  create_json: string;
  created_json: string;
  upload_token: string | null;
  completion_token: string | null;
  files: number;
  bytes: number;
  version_id: string | null;
  live: number;
  published: number | null;
  keep_logs: number;
  created_at: number;
  expires_at: number;
};
export const sealContext = (s: { workspace_id: string; id: string }) =>
  `local:${s.workspace_id}:${s.id}`;
// The name Wrangler gives a resource it creates for a binding.
export const resourceName = (worker: string, binding: string) =>
  `${worker}-${binding.toLowerCase().replaceAll('_', '-')}`;

// Review -------------------------------------------------------------------------------

// What a folder's files say: the same review as a GitHub repository gets, for an app that
// is built on the person's computer.
function localPlan(files: Record<string, string | null>): LocalPlan {
  const framework = detectFramework(files);
  const plan = repositoryPlan(files, framework ?? undefined, { local: true });
  const issues =
    plan.adapter === 'container'
      ? [
          'Cloudflare’s builds make and push container images, so this app deploys from GitHub with them: push it, then run shipcel git connect.',
        ]
      : plan.adapter === 'python-packages'
        ? [
            'Python Workers with packages deploy from GitHub for now: run shipcel git connect. Shipcel hasn’t verified pywrangler from a computer yet.',
          ]
        : plan.adapter === 'static-assets'
          ? [
              'This folder is a site without a Wrangler configuration. Shipcel uploads those directly: run shipcel in it.',
            ]
          : plan.issues;
  return {
    framework,
    adapter: plan.adapter,
    buildCommand: plan.buildCommand,
    // What Cloudflare creates on deploy; a Hyperdrive database is bound, not created.
    resources: plan.resources.flatMap(({ type, binding }) =>
      type === 'hyperdrive' ? [] : [{ type, binding }],
    ),
    hyperdrive: plan.resources.flatMap((r) =>
      r.type === 'hyperdrive' && r.id ? [{ binding: r.binding, id: r.id }] : [],
    ),
    warnings: plan.warnings,
    issues,
    ...(plan.workerName ? { workerName: plan.workerName } : {}),
    ...(plan.openNextCache ? { openNextCache: plan.openNextCache } : {}),
  };
}

async function ownedProject(c: Context<AppEnv>) {
  const who = requireIdentity(c, 'deploy');
  if (!who.sessionHash)
    throw new AppError(401, 'Sign in with GitHub to deploy to Cloudflare.');
  const p = await c.env.DB.prepare(
    'SELECT id, name, free_only FROM projects WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<{ id: string; name: string; free_only: number }>();
  if (!p) throw new AppError(404, 'Project not found.');
  return { who, p };
}

// The review with the project it deploys to: its Worker, whether this deploy creates it,
// and what Cloudflare would create now. Problems the person can fix are `issues`.
async function review(
  c: Context<AppEnv>,
  files: Record<string, string | null>,
  wanted: { workerName?: string; production?: boolean },
) {
  const { who, p } = await ownedProject(c);
  const access = await cloudflareAccess(c, who.workspaceId);
  const job = await productionJob(c, p.id);
  if (job && job.adapter !== 'direct-upload')
    throw new AppError(
      409,
      'This project deploys from GitHub: push to deploy it, or run shipcel redeploy.',
    );
  if (job && job.account_id !== access.accountId)
    throw new AppError(
      409,
      'Reconnect the Cloudflare account that owns this project.',
    );
  const plan = localPlan(files);
  const issues = [...plan.issues];
  // A Hyperdrive binding names a database added to this project, never another one.
  if (plan.hyperdrive?.length) {
    const own = await hyperdriveCreated(c.env, p.id);
    for (const h of plan.hyperdrive)
      if (!own.some((o) => o.id === h.id))
        issues.push(
          `${h.binding} names a Hyperdrive configuration that isn’t this project’s. Add the database with shipcel hyperdrive add ${h.binding} (it asks for the connection string), then put the id it prints in the Wrangler configuration.`,
        );
  }
  if (p.free_only)
    issues.push(
      ...freeOnlyIssues({ resources: plan.resources, containers: [] }),
    );
  const first = !job?.worker_tag;
  const paused = await pausedForBudget(c.env, p.id);
  if (paused && (first || wanted.production)) issues.push(paused);
  if (who.actionsRun?.previewOnly && (first || wanted.production))
    issues.push(previewOnlyRun);
  const workerName =
    job?.worker_name ?? plan.workerName ?? wanted.workerName ?? p.name;
  let existing: { name: string; type: string }[] = [];
  if (job && plan.workerName && plan.workerName !== job.worker_name)
    issues.push(
      `This app deploys under the name in its Wrangler configuration, which is now ${plan.workerName}; this project’s Worker is ${job.worker_name}. Change the name back, or deploy it as a new project.`,
    );
  if (
    !job &&
    plan.workerName &&
    wanted.workerName &&
    wanted.workerName !== plan.workerName
  )
    issues.push(
      `This app deploys under the name in its Wrangler configuration (${plan.workerName}).`,
    );
  if (!appName.safeParse(workerName).success)
    issues.push(
      `${workerName} can’t be an app name: use 1 to 63 lowercase letters, numbers and hyphens (--name <app name>).`,
    );
  else if (first) {
    issues.push(...bucketNameIssues(workerName, plan.resources));
    if (!(await createsWorkers(c.env, access.grant)))
      throw new AppError(409, cannotCreateWorkers);
    // A new Worker: never adopt one that exists, in Shipcel's records or in Cloudflare.
    // An empty one is Shipcel's own only when this project's earlier deploy started it.
    const taken = job
      ? null
      : await c.env.DB.prepare(
          'SELECT 1 FROM deployment_jobs WHERE account_id=? AND worker_name=? UNION ALL SELECT 1 FROM project_backends WHERE account_id=? AND worker_name=?',
        )
          .bind(access.accountId, workerName, access.accountId, workerName)
          .first();
    const state = await workerState(access.token, access.root, workerName);
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
      issues.push(
        `A Worker named ${workerName} already exists in this Cloudflare account. ${plan.workerName ? 'Change name in the Wrangler configuration.' : 'Choose another app name: --name <app name>.'}`,
      );
    if (!(await workersSubdomain(access.token, access.accountId)))
      throw new AppError(
        409,
        'Claim a free workers.dev subdomain for this Cloudflare account first. Every app gets its address under it.',
      );
  } else {
    // The recorded Worker, unchanged since Shipcel last saw it; its bindings are reused.
    const workers = z
      .array(z.object({ id: z.string(), tag: z.string() }))
      .parse(await cloudflare(access.token, `${access.root}/workers/scripts`));
    if (!workers.some((w) => w.id === workerName && w.tag === job!.worker_tag))
      throw new AppError(
        409,
        'The Worker identity changed or is no longer accessible. No operation was performed.',
      );
    existing =
      z
        .object({
          bindings: z
            .array(z.object({ name: z.string(), type: z.string() }))
            .optional(),
        })
        .parse(
          await cloudflare(
            access.token,
            `${access.root}/workers/scripts/${workerName}/settings`,
          ),
        ).bindings ?? [];
  }
  // Wrangler turns Workers Logs off on every deploy of a configuration that doesn't mention
  // observability. Logs are what `shipcel logs` and the dashboard read, so they stay on
  // unless the configuration decides.
  const config: unknown = parse(
    files['wrangler.jsonc'] ?? files['wrangler.json'] ?? '{}',
    [],
    { allowTrailingComma: true },
  );
  const keepLogs =
    (config as { observability?: unknown } | null)?.observability === undefined;
  const bound = { d1: 'd1', kv: 'kv_namespace', r2: 'r2_bucket' } as const;
  const create = plan.resources
    .filter(
      (r) =>
        !existing.some((b) => b.name === r.binding && b.type === bound[r.type]),
    )
    .map((r) => ({ ...r, name: resourceName(workerName, r.binding) }));
  return {
    who,
    p,
    access,
    job,
    plan,
    issues,
    first,
    // A new app's first deploy is its production deploy; a preview needs the Worker.
    production: first || Boolean(wanted.production),
    workerName,
    create,
    keepLogs,
  };
}

const planInput = z
  .object({
    files: filesSchema,
    workerName: z.string().max(100).optional(),
    production: z.boolean().optional(),
  })
  .strict();

// Before a project exists: what the folder is, so the CLI can name its runtime.
localDeploys.post('/local-plan', async (c) => {
  requireIdentity(c, 'deploy');
  const { files } = planInput.parse(await c.req.json());
  return c.json(localPlan(files));
});

localDeploys.post('/projects/:id/local-plan', async (c) => {
  const input = planInput.parse(await c.req.json());
  const r = await review(c, input.files, input);
  return c.json({
    ...r.plan,
    issues: r.issues,
    workerName: r.workerName,
    first: r.first,
    production: r.production,
    create: r.create,
  } satisfies LocalPlan);
});

// Sessions -----------------------------------------------------------------------------

const closeSession = (
  env: Env,
  s: Pick<Session, 'id' | 'operation_id'>,
  status: 'deployed' | 'failed',
  operation: { status: string; error?: string; result?: unknown },
) =>
  env.DB.batch([
    env.DB.prepare(
      'UPDATE local_deploys SET status=?, upload_token=NULL, completion_token=NULL WHERE id=?',
    ).bind(status, s.id),
    env.DB.prepare(
      "UPDATE project_operations SET status=?, error=?, result_json=?, updated_at=? WHERE id=? AND status<>'succeeded'",
    ).bind(
      operation.status,
      operation.error ?? null,
      operation.result === undefined ? null : JSON.stringify(operation.result),
      now(),
      s.operation_id,
    ),
  ]);

export const createdBy = (s: Pick<Session, 'created_json'>) =>
  JSON.parse(s.created_json) as Created[];
// What a deploy that never reported its outcome left in Cloudflare, in words; and whether
// someone should look.
type Left = Pick<
  Session,
  'created_json' | 'version_id' | 'production' | 'live'
>;
const unfinished = (s: Left) => {
  const version = s.version_id?.slice(0, 8);
  if (version && s.production && !s.live)
    return `Wrangler uploaded version ${version}, but production still serves the previous one. Deploy again, or make it production: shipcel promote ${version}.`;
  if (version)
    return `The deploy from a computer uploaded version ${version} and then stopped reporting back, so this project’s history doesn’t list it. ${s.production ? 'Production serves it.' : 'It serves no traffic.'}`;
  const made = createdBy(s);
  return made.length
    ? `The deploy from a computer stopped before the app was uploaded. It had created ${made.map((r) => r.name).join(', ')} in Cloudflare; the next deploy of this project uses them.`
    : 'The deploy from a computer stopped before anything changed in Cloudflare.';
};
const left = (s: Left) => ({
  status: s.version_id || createdBy(s).length ? 'needs_attention' : 'failed',
  error: unfinished(s),
});

localDeploys.post('/projects/:id/local-deploys', async (c) => {
  const input = z
    .object({
      ...confirmation,
      files: filesSchema,
      workerName: z.string().max(100).optional(),
      production: z.boolean().optional(),
      confirmResources: z.boolean().optional(),
    })
    .strict()
    .parse(await c.req.json());
  const r = await review(c, input.files, input);
  if (r.issues.length) throw new AppError(409, r.issues.join(' '));
  if (r.create.length && !input.confirmResources)
    return c.json(
      {
        error: `Confirm that Cloudflare may create ${r.create.map((x) => x.name).join(', ')} in your account.`,
        create: r.create,
      },
      400,
    );
  const { who, p, access } = r;
  const repeated = await c.env.DB.prepare(
    'SELECT 1 FROM project_operations WHERE workspace_id=? AND request_key=?',
  )
    .bind(who.workspaceId, input.requestId)
    .first();
  if (repeated)
    throw new AppError(
      409,
      'This deploy was already started. Start a new one.',
    );
  // One deploy of a project at a time. A session nothing has used for two minutes was
  // abandoned (the computer went away): it is closed, and this one takes over. So are the
  // workspace's sessions whose hour is up, each with its operation and with Cloudflare's
  // sealed upload tokens. This project's come first.
  const { results: open } = await c.env.DB.prepare(
    "SELECT d.id, d.operation_id, d.created_json, d.version_id, d.production, d.live, d.expires_at, o.updated_at FROM local_deploys d JOIN project_operations o ON o.id=d.operation_id WHERE d.workspace_id=? AND d.status='open' AND (d.project_id=? OR d.expires_at<=?) ORDER BY d.project_id=? DESC LIMIT 10",
  )
    .bind(who.workspaceId, p.id, now(), p.id)
    .all<
      Left &
        Pick<Session, 'id' | 'operation_id' | 'expires_at'> & {
          updated_at: number;
        }
    >();
  for (const earlier of open) {
    if (
      earlier.expires_at > now() &&
      earlier.updated_at > now() - ACTIVE_SECONDS
    )
      throw new AppError(
        409,
        'Another deploy of this project is in progress. Wait for it to finish, or try again in two minutes.',
      );
    await closeSession(c.env, earlier, 'failed', left(earlier));
  }
  const id = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const secret = randomToken();
  const kind = r.production ? 'local.deploy' : 'local.preview';
  try {
    await c.env.DB.prepare(
      "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'running',?,?,?)",
    )
      .bind(
        operationId,
        who.workspaceId,
        p.id,
        who.userId,
        access.accountId,
        kind,
        input.requestId,
        JSON.stringify({ workerName: r.workerName, localDeployId: id }),
        now(),
        now(),
      )
      .run();
  } catch {
    throw new AppError(
      409,
      'An operation is already running for this project. Refresh its history before trying again.',
    );
  }
  await c.env.DB.prepare(
    "INSERT INTO local_deploys(id,workspace_id,project_id,user_id,grant_id,account_id,worker_name,adapter,production,first,status,secret_hash,opened_with,operation_id,worker_tag,resources_json,create_json,keep_logs,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      who.workspaceId,
      p.id,
      who.userId,
      access.grant.id,
      access.accountId,
      r.workerName,
      r.plan.adapter,
      Number(r.production),
      Number(r.first),
      await digest(secret),
      who.sessionHash,
      operationId,
      r.job?.worker_tag ?? null,
      JSON.stringify(r.plan.resources),
      // Only what the person agreed to may be created; what the app already has is reused.
      JSON.stringify(r.create.map(({ type, binding }) => ({ type, binding }))),
      Number(r.keepLogs),
      now(),
      now() + SESSION_LIFETIME,
    )
    .run();
  return c.json(
    {
      id,
      // Wrangler's CLOUDFLARE_API_TOKEN for this deploy only.
      token: secret,
      // CLOUDFLARE_API_BASE_URL, relative to this Shipcel.
      apiPath: `/api/wrangler/${id}/client/v4`,
      accountId: access.accountId,
      workerName: r.workerName,
      adapter: r.plan.adapter,
      production: r.production,
      first: r.first,
      expiresAt: now() + SESSION_LIFETIME,
      // OpenNext's R2 cache, which the CLI fills once production serves the new version
      // (worker/wrangler-api.ts lets that bucket's entries through, and nothing else).
      ...(r.production && r.plan.openNextCache === 'r2'
        ? {
            cache: {
              bucket: resourceName(r.workerName, NEXT_CACHE_BINDING),
              prefix: NEXT_CACHE_PREFIX,
            },
          }
        : {}),
    },
    201,
  );
});

// The recorded outcome of a deploy; closes the session. `failed`: Wrangler stopped.
localDeploys.post('/projects/:id/local-deploys/:deployId/finish', async (c) => {
  const { who, p } = await ownedProject(c);
  const input = z
    .object({ failed: z.boolean().optional() })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const s = await c.env.DB.prepare(
    'SELECT * FROM local_deploys WHERE id=? AND project_id=? AND workspace_id=?',
  )
    .bind(c.req.param('deployId'), p.id, who.workspaceId)
    .first<Session>();
  if (!s) throw new AppError(404, 'Deploy not found.');
  const job = await productionJob(c, p.id);
  // Cloudflare names the new version in its answer to the upload; if it didn't, the
  // version production serves now is the one this deploy made.
  if (s.status === 'open' && s.production && s.live && !s.version_id && job) {
    const access = await cloudflareAccess(c, who.workspaceId);
    const latest = z
      .object({
        deployments: z
          .array(
            z.object({
              versions: z.array(z.object({ version_id: z.string().uuid() })),
            }),
          )
          .min(1),
      })
      .safeParse(
        await cloudflare(
          access.token,
          `${access.root}/workers/scripts/${s.worker_name}/deployments`,
        ).catch(() => null),
      );
    s.version_id = latest.success
      ? (latest.data.deployments[0].versions[0]?.version_id ?? null)
      : null;
    if (s.version_id)
      await c.env.DB.prepare('UPDATE local_deploys SET version_id=? WHERE id=?')
        .bind(s.version_id, s.id)
        .run();
  }
  // What Wrangler's calls left recorded: the uploaded version, and for production that it
  // serves traffic.
  const done = Boolean(s.version_id && (!s.production || s.live) && job);
  if (s.status === 'failed' || !done) {
    if (s.status === 'open') await closeSession(c.env, s, 'failed', left(s));
    throw new AppError(409, unfinished(s));
  }
  const access = await cloudflareAccess(c, who.workspaceId);
  const where = await addresses(access.token, s.account_id, s.worker_name);
  const previewUrl = where.suffix
    ? `https://${s.version_id!.slice(0, 8)}${where.suffix}`
    : null;
  const url = s.production ? (job!.live_url ?? null) : null;
  const result = {
    workerName: s.worker_name,
    versionId: s.version_id!,
    previewUrl,
    url,
    published: Boolean(url),
    preview: !s.production,
    productionUrl: job!.live_url ?? null,
    created: createdBy(s),
    ...(where.previewNote ? { previewNote: where.previewNote } : {}),
  };
  if (s.status === 'open') {
    await c.env.DB.prepare(
      "INSERT INTO direct_uploads (id,workspace_id,project_id,account_id,worker_name,status,missing_json,files,bytes,version_id,preview_url,url,published,created_by,created_at,expires_at) VALUES (?,?,?,?,?,'deployed','{}',?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        who.workspaceId,
        p.id,
        s.account_id,
        s.worker_name,
        s.files,
        s.bytes,
        s.version_id,
        previewUrl,
        url,
        Number(Boolean(url)),
        s.user_id,
        now(),
        now(),
      )
      .run();
    await closeSession(
      c.env,
      s,
      'deployed',
      input.failed
        ? {
            status: 'needs_attention',
            error:
              'Wrangler uploaded the new version and then stopped. Check its output, and the app’s address and schedules in Cloudflare.',
            result,
          }
        : { status: 'succeeded', result },
    );
    await notify(c.env, {
      workspaceId: who.workspaceId,
      projectId: p.id,
      event: 'upload.deployed',
      text: (name) =>
        s.production
          ? `${name}: a new version was deployed.${url ? ` Live: ${url}` : ' It is not published.'}`
          : `${name}: a preview version was uploaded.${previewUrl ? ` Preview: ${previewUrl}` : ''} Production is unchanged.`,
      data: {
        versionId: s.version_id,
        previewUrl,
        url,
        preview: !s.production,
      },
    });
  }
  return c.json({ result });
});
