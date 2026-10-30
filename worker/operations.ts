import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, requireIdentity } from './auth';
import { cloudflare, github, providerPath } from './providers';
import { repoSchema } from './connections';
import { refuseWhilePaused } from './budgets';
import { AppError, now, type AppEnv } from './types';
import { cronExpression } from './repository-plan';
import {
  advanceHealth,
  buildSource,
  productionBuild,
  registerBuilds,
  trackHealth,
} from './health';

export const operations = new Hono<AppEnv>();
const cfId = z.string().regex(/^[a-f0-9]{32}$/);
const resourceId = z.string().regex(/^[a-f0-9-]{16,64}$/i);
export const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const confirmation = {
  requestId: z.string().uuid(),
  confirm: z.literal(true),
};
const jobSchema = z.object({
  id: z.string(),
  account_id: cfId,
  worker_name: z.string().regex(/^[a-z0-9-]{1,63}$/),
  worker_tag: resourceId,
  trigger_uuid: resourceId.nullable(),
  repository_id: z.string(),
  // Empty for Workers deployed by direct upload.
  repository_name: z
    .string()
    .regex(/^[\w-]+\/[\w.-]+$/)
    .or(z.literal('')),
  branch: z.string(),
  status: z.string(),
  live_url: z.string().nullable().optional(),
});
// A Workers Domain's id is "immutable" and no longer 32 hex characters (seen live, 28 Oct 2026).
const domainIdSchema = z.string().min(1).max(128);
const domainSchema = z.object({
  id: domainIdSchema,
  hostname: z.string(),
  service: z.string(),
  environment: z.string().optional(),
  zone_id: cfId,
});
const versionSchema = z.object({
  id: z.string().uuid(),
  number: z.number().optional(),
  metadata: z.object({ created_on: z.string().optional() }).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
});

async function ownedProject(c: Context<AppEnv>, id = c.req.param('id')) {
  const who = requireIdentity(c, 'deploy');
  const p = await c.env.DB.prepare(
    'SELECT id,name FROM projects WHERE workspace_id=? AND id=?',
  )
    .bind(who.workspaceId, id)
    .first<{ id: string; name: string }>();
  if (!p) throw new AppError(404, 'Project not found.');
  return { who, p };
}
// The production Worker of a project (the route's, unless another is named): its recorded
// name and immutable tag, in the account the workspace is connected to. Branch previews
// belong to this Worker too.
export async function target(
  c: Context<AppEnv>,
  write = false,
  projectId?: string,
) {
  const { who, p } = await ownedProject(c, projectId);
  if (!who.sessionHash)
    throw new AppError(
      401,
      'Connect your accounts and deploy this project first.',
    );
  if (write && c.env.NATIVE_BUILDS_ENABLED !== 'true')
    throw new AppError(
      503,
      'Cloud operations are disabled until provider setup is verified.',
    );
  const row = await c.env.DB.prepare(
    "SELECT * FROM deployment_jobs WHERE workspace_id=? AND project_id=? AND environment='production' AND worker_tag IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(who.workspaceId, p.id)
    .first();
  if (!row)
    throw new AppError(
      409,
      'Deploy this project to create its Cloudflare Worker first.',
    );
  const job = jobSchema.parse(row);
  if (write && ['queued', 'provisioning', 'building'].includes(job.status))
    throw new AppError(409, 'Wait for the initial pipeline setup to finish.');
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant || grant.account_id !== job.account_id)
    throw new AppError(
      409,
      'Reconnect the Cloudflare account that owns this project.',
    );
  const token = await grantToken(c.env, grant),
    root = `/accounts/${job.account_id}`;
  const workers = z
    .array(z.object({ id: z.string(), tag: z.string() }))
    .parse(await cloudflare(token, `${root}/workers/scripts`));
  if (
    !workers.some((w) => w.id === job.worker_name && w.tag === job.worker_tag)
  )
    throw new AppError(
      409,
      'The Worker identity changed or is no longer accessible. No operation was performed.',
    );
  return {
    who,
    p,
    job,
    grant,
    token,
    root,
    script: `${root}/workers/scripts/${job.worker_name}`,
  };
}
export type Target = Awaited<ReturnType<typeof target>>;
export async function replay(
  c: Context<AppEnv>,
  t: Target,
  kind: string,
  key: string,
) {
  const previous = await c.env.DB.prepare(
    'SELECT * FROM project_operations WHERE workspace_id=? AND request_key=?',
  )
    .bind(t.who.workspaceId, key)
    .first<{
      id: string;
      project_id: string;
      kind: string;
      status: string;
      result_json: string | null;
      error: string | null;
    }>();
  if (previous) {
    if (previous.project_id !== t.p.id || previous.kind !== kind)
      throw new AppError(409, 'This request key belongs to another operation.');
    return c.json({
      id: previous.id,
      status: previous.status,
      result: previous.result_json ? JSON.parse(previous.result_json) : null,
      error: previous.error,
    });
  }
  return null;
}
export async function change(
  c: Context<AppEnv>,
  t: Target,
  kind: string,
  key: string,
  work: (operationId: string) => Promise<Record<string, unknown>>,
  options: {
    // Changes to what is serving get a follow-up health check recorded with the result.
    track?: (result: Record<string, unknown>) => {
      kind: 'build' | 'promotion';
      target: string;
    };
    // Parameters needed to check an interrupted operation later. Never secret values.
    intent?: Record<string, unknown>;
  } = {},
) {
  const { track, intent } = options;
  const previous = await replay(c, t, kind, key);
  if (previous) return previous;
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'running',?,?,?)",
    )
      .bind(
        id,
        t.who.workspaceId,
        t.p.id,
        t.who.userId,
        t.job.account_id,
        kind,
        key,
        JSON.stringify(intent ?? {}),
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
  try {
    const access = await activeGrant(c.env, t.who.workspaceId, 'cloudflare');
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM memberships m JOIN projects p ON p.workspace_id=m.workspace_id WHERE p.id=? AND m.user_id=? AND m.role IN ('owner','developer')",
    )
      .bind(t.p.id, t.who.userId)
      .first();
    if (
      !member ||
      access?.id !== t.grant.id ||
      access.account_id !== t.job.account_id
    )
      throw new AppError(403, 'Workspace or account access changed.');
    const result = await work(id);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE project_operations SET status='succeeded',result_json=?,updated_at=? WHERE id=? AND status='running'",
      ).bind(JSON.stringify(result), now(), id),
      ...(track
        ? [
            trackHealth(c.env, {
              operationId: id,
              workspaceId: t.who.workspaceId,
              projectId: t.p.id,
              accountId: t.job.account_id,
              ...track(result),
            }),
          ]
        : []),
    ]);
    return c.json({ id, status: 'succeeded', result });
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.message
        : 'The provider operation did not complete cleanly. Inspect Cloudflare before retrying.';
    await c.env.DB.prepare(
      "UPDATE project_operations SET status='needs_attention',error=?,updated_at=? WHERE id=? AND status='running'",
    )
      .bind(message, now(), id)
      .run();
    return c.json({ id, status: 'needs_attention', error: message }, 502);
  }
}
operations.get('/projects/:id/operations', async (c) => {
  const { who, p } = await ownedProject(c);
  // A process may have stopped between the provider mutation and recording its result.
  await c.env.DB.prepare(
    "UPDATE project_operations SET status='needs_attention',error='Operation monitoring was interrupted. Inspect Cloudflare before retrying.',updated_at=? WHERE project_id=? AND workspace_id=? AND status='running' AND updated_at<?",
  )
    .bind(now(), p.id, who.workspaceId, now() - 120)
    .run();
  const { results } = await c.env.DB.prepare(
    'SELECT o.id,o.kind,o.status,o.error,o.created_at,o.updated_at,h.status AS health,h.detail AS health_detail,h.checked_at AS health_checked_at FROM project_operations o LEFT JOIN operation_health h ON h.operation_id=o.id WHERE o.workspace_id=? AND o.project_id=? ORDER BY o.created_at DESC LIMIT 50',
  )
    .bind(who.workspaceId, p.id)
    .all();
  return c.json(results);
});
operations.post('/projects/:id/operations/:operationId/health', async (c) => {
  const { who, p } = await ownedProject(c);
  if (!who.sessionHash)
    throw new AppError(401, 'Sign in with GitHub to check deployment health.');
  const query = c.env.DB.prepare(
    'SELECT status AS health,detail AS health_detail,checked_at AS health_checked_at FROM operation_health WHERE operation_id=? AND workspace_id=? AND project_id=?',
  ).bind(c.req.param('operationId'), who.workspaceId, p.id);
  if (!(await query.first()))
    throw new AppError(404, 'No health check is recorded for this operation.');
  await advanceHealth(c.env, c.req.param('operationId'));
  return c.json(await query.first());
});
operations.get('/projects/:id/cloud', async (c) => {
  const t = await target(c);
  const settings = z
    .object({
      bindings: z
        .array(
          z.object({
            name: z.string(),
            type: z.string(),
            id: z.string().optional(),
            bucket_name: z.string().optional(),
            namespace_id: z.string().optional(),
          }),
        )
        .optional(),
    })
    .parse(await cloudflare(t.token, `${t.script}/settings`));
  // Never return plain-text variables or secret values from Worker settings.
  return c.json({
    worker: t.job.worker_name,
    accountId: t.job.account_id,
    bindings: settings.bindings || [],
    dashboardUrl: `https://dash.cloudflare.com/${t.job.account_id}/workers/services/view/${t.job.worker_name}/production`,
  });
});
operations.get('/projects/:id/secrets', async (c) => {
  const t = await target(c);
  const values = z
    .array(z.object({ name: z.string(), type: z.string() }))
    .parse(await cloudflare(t.token, `${t.script}/secrets`));
  return c.json(values);
});
operations.put('/projects/:id/secrets', async (c) => {
  const input = z
    .object({
      ...confirmation,
      name: secretName,
      value: z.string().min(1).max(4096),
    })
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true);
  await refuseWhilePaused(c.env, t.p.id);
  return change(
    c,
    t,
    `secret.set:${input.name}`,
    input.requestId,
    async () => {
      await cloudflare(t.token, `${t.script}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({
          name: input.name,
          text: input.value,
          type: 'secret_text',
        }),
      });
      return { name: input.name };
    },
    { intent: { name: input.name } },
  );
});
operations.delete('/projects/:id/secrets/:name', async (c) => {
  const input = z
      .object(confirmation)
      .strict()
      .parse(await c.req.json()),
    name = secretName.parse(c.req.param('name')),
    t = await target(c, true);
  await refuseWhilePaused(c.env, t.p.id);
  return change(
    c,
    t,
    `secret.remove:${name}`,
    input.requestId,
    async () => {
      await cloudflare(t.token, `${t.script}/secrets/${providerPath(name)}`, {
        method: 'DELETE',
      });
      return { name };
    },
    { intent: { name } },
  );
});
type Deployments = z.infer<typeof deploymentsSchema>['deployments'];
const deploymentsSchema = z.object({
  deployments: z.array(
    z
      .object({
        id: z.string(),
        created_on: z.string().optional(),
        versions: z.array(
          z.object({ version_id: z.string(), percentage: z.number() }),
        ),
      })
      .passthrough(),
  ),
});
// Cloudflare's recent deployments of the Worker, newest first.
const recentDeployments = async (t: Target) =>
  deploymentsSchema.parse(await cloudflare(t.token, `${t.script}/deployments`))
    .deployments;
// The deployment serving traffic now.
async function activeDeployment(t: Target, listed?: Deployments) {
  const active = (listed ?? (await recentDeployments(t)))[0];
  return active
    ? {
        id: active.id,
        createdOn: active.created_on ?? null,
        versions: active.versions.map((v) => ({
          versionId: v.version_id,
          percentage: v.percentage,
        })),
      }
    : null;
}
operations.get('/projects/:id/deployment', async (c) =>
  c.json(await activeDeployment(await target(c))),
);
operations.get('/projects/:id/versions', async (c) => {
  const t = await target(c);
  const [data, deployments] = await Promise.all([
    cloudflare(t.token, `${t.script}/versions?per_page=25`).then((r) =>
      z.object({ items: z.array(versionSchema) }).parse(r),
    ),
    recentDeployments(t),
  ]);
  const active = await activeDeployment(t, deployments);
  // live: the share of traffic the version serves now, or null. production: it served
  // traffic in one of the recent deployments; previews never did.
  const live = new Map(
    (active?.versions ?? []).map((v) => [v.versionId, v.percentage]),
  );
  const served = new Set(
    deployments.flatMap((d) => d.versions.map((v) => v.version_id)),
  );
  return c.json(
    data.items.map((v) => ({
      id: v.id,
      number: v.number,
      createdAt: v.metadata?.created_on,
      message: v.annotations?.['workers/message'] || '',
      live: live.get(v.id) ?? null,
      production: served.has(v.id),
    })),
  );
});
operations.post('/projects/:id/rollback', async (c) => {
  const input = z
      .object({ ...confirmation, versionId: z.string().uuid() })
      .strict()
      .parse(await c.req.json()),
    t = await target(c, true);
  await refuseWhilePaused(c.env, t.p.id);
  // Fetch the exact version through this owned Worker; never trust a version ID alone.
  const version = versionSchema.parse(
    await cloudflare(t.token, `${t.script}/versions/${input.versionId}`),
  );
  if (version.id !== input.versionId)
    throw new AppError(409, 'The provider returned a different version.');
  return change(
    c,
    t,
    `version.promote:${input.versionId}`,
    input.requestId,
    async () => {
      const deployed = z.object({ id: z.string().uuid() }).parse(
        await cloudflare(t.token, `${t.script}/deployments?force=false`, {
          method: 'POST',
          body: JSON.stringify({
            strategy: 'percentage',
            versions: [{ version_id: input.versionId, percentage: 100 }],
            annotations: { 'workers/message': 'Promoted from Shipcel' },
          }),
        }),
      );
      return { deploymentId: deployed.id, versionId: input.versionId };
    },
    {
      track: () => ({ kind: 'promotion', target: input.versionId }),
      intent: { versionId: input.versionId },
    },
  );
});
// Build variables: Workers Builds environment variables on the trigger that builds an
// environment (production's, or branch previews'). They apply from the next build. Values
// go only to Cloudflare, which never returns secret ones.
const buildVariableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const buildEnvironment = z
  .enum(['production', 'preview'])
  .default('production');
async function buildTrigger(
  c: Context<AppEnv>,
  t: Target,
  environment: 'production' | 'preview',
) {
  if (environment === 'production') {
    if (!t.job.trigger_uuid)
      throw new AppError(
        409,
        'Build variables apply to apps deployed from Git. This app has no build trigger.',
      );
    return t.job.trigger_uuid;
  }
  const previews = await c.env.DB.prepare(
    "SELECT trigger_uuid FROM project_previews WHERE project_id=? AND status='active'",
  )
    .bind(t.p.id)
    .first<{ trigger_uuid: string | null }>();
  if (!previews?.trigger_uuid)
    throw new AppError(409, 'Turn on branch previews first.');
  return previews.trigger_uuid;
}
const buildVariablesPath = (t: Target, trigger: string) =>
  `${t.root}/builds/triggers/${trigger}/environment_variables`;
const kindSuffix = (environment: 'production' | 'preview') =>
  environment === 'preview' ? '@preview' : '';
operations.get('/projects/:id/build-variables', async (c) => {
  const environment = buildEnvironment.parse(
    c.req.query('environment') ?? undefined,
  );
  const t = await target(c);
  const trigger = await buildTrigger(c, t, environment);
  const variables = z
    .record(
      z.string(),
      z
        .object({
          is_secret: z.boolean(),
          value: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .parse((await cloudflare(t.token, buildVariablesPath(t, trigger))) ?? {});
  return c.json({
    variables: Object.entries(variables)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => ({
        name,
        secret: v.is_secret,
        value: v.is_secret ? null : (v.value ?? null),
      })),
  });
});
operations.put('/projects/:id/build-variables', async (c) => {
  const input = z
    .object({
      ...confirmation,
      environment: buildEnvironment,
      name: buildVariableName,
      value: z.string().min(1).max(5000),
      secret: z.boolean(),
    })
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true);
  const trigger = await buildTrigger(c, t, input.environment);
  return change(
    c,
    t,
    `buildvar.set:${input.name}${kindSuffix(input.environment)}`,
    input.requestId,
    async () => {
      await cloudflare(
        t.token,
        buildVariablesPath(t, trigger),
        {
          method: 'PATCH',
          body: JSON.stringify({
            [input.name]: { value: input.value, is_secret: input.secret },
          }),
        },
        { errorDetail: true },
      );
      return {
        name: input.name,
        secret: input.secret,
        environment: input.environment,
      };
    },
    { intent: { name: input.name, trigger } },
  );
});
operations.delete('/projects/:id/build-variables/:name', async (c) => {
  const input = z
      .object({ ...confirmation, environment: buildEnvironment })
      .strict()
      .parse(await c.req.json()),
    name = buildVariableName.parse(c.req.param('name')),
    t = await target(c, true);
  const trigger = await buildTrigger(c, t, input.environment);
  return change(
    c,
    t,
    `buildvar.remove:${name}${kindSuffix(input.environment)}`,
    input.requestId,
    async () => {
      await cloudflare(
        t.token,
        `${buildVariablesPath(t, trigger)}/${providerPath(name)}`,
        { method: 'DELETE' },
      );
      return { name, environment: input.environment };
    },
    { intent: { name, trigger } },
  );
});
// Cron schedules: Cloudflare runs the Worker's scheduled() handler on them, in UTC. A
// repository whose Wrangler configuration lists triggers.crons replaces them on each deploy.
operations.get('/projects/:id/schedules', async (c) => {
  const t = await target(c);
  const { schedules } = z
    .object({
      schedules: z.array(
        z.object({
          cron: z.string(),
          created_on: z.string().nullable().optional(),
          modified_on: z.string().nullable().optional(),
        }),
      ),
    })
    .parse(await cloudflare(t.token, `${t.script}/schedules`));
  return c.json(
    schedules.map((s) => ({
      cron: s.cron,
      createdOn: s.created_on ?? null,
      modifiedOn: s.modified_on ?? null,
    })),
  );
});
operations.put('/projects/:id/schedules', async (c) => {
  const input = z
    .object({ ...confirmation, crons: z.array(cronExpression).max(5) })
    .strict()
    .parse(await c.req.json());
  if (new Set(input.crons).size !== input.crons.length)
    throw new AppError(400, 'List each schedule once.');
  const t = await target(c, true);
  await refuseWhilePaused(c.env, t.p.id);
  return change(
    c,
    t,
    'schedules.set',
    input.requestId,
    async () => {
      await cloudflare(
        t.token,
        `${t.script}/schedules`,
        {
          method: 'PUT',
          body: JSON.stringify(input.crons.map((cron) => ({ cron }))),
        },
        { errorDetail: true },
      );
      return { crons: input.crons };
    },
    { intent: { crons: input.crons } },
  );
});
// A gradual deployment: two versions share traffic (Cloudflare allows two). The first
// version is the one being rolled out; its share is what the health check confirms.
operations.post('/projects/:id/traffic', async (c) => {
  const input = z
      .object({
        ...confirmation,
        versions: z
          .array(
            z
              .object({
                versionId: z.string().uuid(),
                percentage: z.number().int(),
              })
              .strict(),
          )
          .max(2),
      })
      .strict()
      .parse(await c.req.json()),
    [rollout, current] = input.versions;
  if (
    input.versions.length !== 2 ||
    rollout.versionId === current.versionId ||
    input.versions.some((v) => v.percentage < 1 || v.percentage > 99) ||
    rollout.percentage + current.percentage !== 100
  )
    throw new AppError(
      400,
      'Split traffic between two different versions, with shares from 1% to 99% that add up to 100%.',
    );
  const t = await target(c, true);
  await refuseWhilePaused(c.env, t.p.id);
  // Fetch both versions through this owned Worker; never trust version IDs alone.
  for (const v of input.versions) {
    const version = versionSchema.parse(
      await cloudflare(t.token, `${t.script}/versions/${v.versionId}`),
    );
    if (version.id !== v.versionId)
      throw new AppError(409, 'The provider returned a different version.');
  }
  return change(
    c,
    t,
    `version.split:${input.versions.map((v) => `${v.versionId}@${v.percentage}`).join(',')}`,
    input.requestId,
    async () => {
      const deployed = z.object({ id: z.string().uuid() }).parse(
        await cloudflare(t.token, `${t.script}/deployments?force=false`, {
          method: 'POST',
          body: JSON.stringify({
            strategy: 'percentage',
            versions: input.versions.map((v) => ({
              version_id: v.versionId,
              percentage: v.percentage,
            })),
            annotations: { 'workers/message': 'Traffic split from Shipcel' },
          }),
        }),
      );
      return { deploymentId: deployed.id, versions: input.versions };
    },
    {
      track: () => ({
        kind: 'promotion',
        target: `${rollout.versionId}@${rollout.percentage}`,
      }),
      intent: { versions: input.versions },
    },
  );
});
operations.get('/projects/:id/builds', async (c) => {
  const t = await target(c);
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(c.req.query('page') || '1');
  const values = z
    .array(
      z.object({
        build_uuid: z.string(),
        build_outcome: z.string().nullable().optional(),
        status: z.string().optional(),
        created_at: z.string().optional(),
        ...buildSource,
        build_start_time: z.string().nullable().optional(),
        build_end_time: z.string().nullable().optional(),
      }),
    )
    .parse(
      await cloudflare(
        t.token,
        `${t.root}/builds/workers/${t.job.worker_tag}/builds?page=${page}&per_page=20`,
      ),
    );
  // The latest page also registers new push builds for a follow-up health check. Preview
  // builds of other branches don't change production, so they get no health check.
  if (page === 1)
    await registerBuilds(
      c.env,
      {
        workspace_id: t.who.workspaceId,
        project_id: t.p.id,
        account_id: t.job.account_id,
      },
      values.filter((v) => productionBuild(v, t.job)),
    );
  const { results: health } = await c.env.DB.prepare(
    `SELECT operation_id,target,status,detail FROM operation_health WHERE project_id=? AND target IN (${values.map(() => '?').join(',') || "''"})`,
  )
    .bind(t.p.id, ...values.map((v) => v.build_uuid))
    .all<{
      operation_id: string;
      target: string;
      status: string;
      detail: string | null;
    }>();
  return c.json({
    builds: values.map((v) => {
      const h = health.find((x) => x.target === v.build_uuid);
      const build = {
        ...v,
        branch: v.build_trigger_metadata?.branch ?? v.branch,
        preview: !productionBuild(v, t.job),
      };
      return h
        ? {
            ...build,
            health: h.status,
            health_detail: h.detail,
            health_operation: h.operation_id,
          }
        : build;
    }),
    nextPage: values.length === 20 ? page + 1 : null,
  });
});
operations.post('/projects/:id/redeploy', async (c) => {
  const input = z
      .object(confirmation)
      .strict()
      .parse(await c.req.json()),
    t = await target(c, true);
  await refuseWhilePaused(c.env, t.p.id);
  if (!t.job.trigger_uuid)
    throw new AppError(409, 'No production build trigger has been recorded.');
  const gh = await activeGrant(c.env, t.who.workspaceId, 'github');
  if (!gh) throw new AppError(409, 'Reconnect GitHub before starting a build.');
  const token = await grantToken(c.env, gh),
    repo = repoSchema.parse(
      await github(token, `/repos/${t.job.repository_name}`),
    );
  if (
    String(repo.id) !== t.job.repository_id ||
    repo.archived ||
    (!repo.permissions?.push && !repo.permissions?.admin)
  )
    throw new AppError(403, 'Repository write access is required.');
  const commit = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(
      await github(
        token,
        `/repos/${t.job.repository_name}/commits/${providerPath(t.job.branch)}`,
      ),
    );
  return change(
    c,
    t,
    'build.redeploy',
    input.requestId,
    async () => {
      const build = z.object({ build_uuid: resourceId }).parse(
        await cloudflare(
          t.token,
          `${t.root}/builds/triggers/${t.job.trigger_uuid}/builds`,
          {
            method: 'POST',
            body: JSON.stringify({
              branch: t.job.branch,
              commit_hash: commit.sha,
            }),
          },
        ),
      );
      return { buildId: build.build_uuid, commit: commit.sha };
    },
    {
      track: (result) => ({ kind: 'build', target: String(result.buildId) }),
      intent: { commit: commit.sha },
    },
  );
});
operations.get('/projects/:id/domains', async (c) => {
  const t = await target(c);
  const values = z
    .array(domainSchema)
    .parse(await cloudflare(t.token, `${t.root}/workers/domains`));
  return c.json(
    values.filter(
      (d) =>
        d.service === t.job.worker_name &&
        (!d.environment || d.environment === 'production'),
    ),
  );
});
operations.get('/projects/:id/zones', async (c) => {
  const t = await target(c),
    page = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(c.req.query('page') || '1');
  const zones = z
    .array(
      z.object({
        id: cfId,
        name: z.string(),
        status: z.string(),
        account: z.object({ id: cfId }),
      }),
    )
    .parse(
      await cloudflare(
        t.token,
        `/zones?account.id=${t.job.account_id}&status=active&per_page=50&page=${page}`,
      ),
    );
  return c.json({
    zones: zones
      .filter((z) => z.account.id === t.job.account_id && z.status === 'active')
      .map((z) => ({ id: z.id, name: z.name })),
    nextPage: zones.length === 50 ? page + 1 : null,
  });
});
operations.post('/projects/:id/domains', async (c) => {
  const input = z
      .object({
        ...confirmation,
        hostname: z
          .string()
          .trim()
          .toLowerCase()
          .max(253)
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
        zoneId: cfId,
      })
      .strict()
      .parse(await c.req.json()),
    t = await target(c, true);
  // A successful attach creates the very binding the preflight rejects.
  // Return the recorded outcome before inspecting mutable domain state.
  const previous = await replay(
    c,
    t,
    `domain.attach:${input.hostname}`,
    input.requestId,
  );
  if (previous) return previous;
  const zone = z
    .object({
      id: cfId,
      name: z.string(),
      status: z.literal('active'),
      account: z.object({ id: cfId }),
    })
    .parse(await cloudflare(t.token, `/zones/${input.zoneId}`));
  if (
    zone.id !== input.zoneId ||
    zone.account.id !== t.job.account_id ||
    !(input.hostname === zone.name || input.hostname.endsWith(`.${zone.name}`))
  )
    throw new AppError(
      403,
      'Choose an active zone in this project’s Cloudflare account.',
    );
  const domains = z
    .array(domainSchema)
    .parse(await cloudflare(t.token, `${t.root}/workers/domains`));
  const existing = domains.find((d) => d.hostname === input.hostname);
  if (existing)
    throw new AppError(
      409,
      'This hostname is already attached to a Worker. Existing domain bindings are never overwritten.',
    );
  const dns = z
    .array(z.object({ id: z.string() }))
    .parse(
      await cloudflare(
        t.token,
        `/zones/${zone.id}/dns_records?name=${providerPath(input.hostname)}&per_page=1`,
      ),
    );
  if (dns.length)
    throw new AppError(
      409,
      'This hostname already has DNS records. Choose an unused hostname or review those records in Cloudflare first.',
    );
  return change(
    c,
    t,
    `domain.attach:${input.hostname}`,
    input.requestId,
    async () => {
      const domain = domainSchema.parse(
        await cloudflare(t.token, `${t.root}/workers/domains`, {
          method: 'PUT',
          body: JSON.stringify({
            hostname: input.hostname,
            service: t.job.worker_name,
            environment: 'production',
            zone_id: zone.id,
            zone_name: zone.name,
          }),
        }),
      );
      if (
        domain.hostname !== input.hostname ||
        domain.service !== t.job.worker_name
      )
        throw new AppError(
          502,
          'The provider returned an unexpected domain binding. Inspect Cloudflare.',
        );
      return { id: domain.id, hostname: domain.hostname };
    },
    { intent: { hostname: input.hostname, zoneId: zone.id } },
  );
});
operations.delete('/projects/:id/domains/:domainId', async (c) => {
  const input = z
      .object(confirmation)
      .strict()
      .parse(await c.req.json()),
    domainId = domainIdSchema.parse(c.req.param('domainId')),
    t = await target(c, true);
  const previous = await replay(
    c,
    t,
    `domain.detach:${domainId}`,
    input.requestId,
  );
  if (previous) return previous;
  const domains = z
    .array(domainSchema)
    .parse(await cloudflare(t.token, `${t.root}/workers/domains`));
  if (
    !domains.some(
      (d) =>
        d.id === domainId &&
        d.service === t.job.worker_name &&
        (!d.environment || d.environment === 'production'),
    )
  )
    throw new AppError(404, 'Domain binding not found on this project.');
  return change(
    c,
    t,
    `domain.detach:${domainId}`,
    input.requestId,
    async () => {
      await cloudflare(
        t.token,
        `${t.root}/workers/domains/${encodeURIComponent(domainId)}`,
        { method: 'DELETE' },
      );
      return { id: domainId };
    },
    { intent: { domainId } },
  );
});
