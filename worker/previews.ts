import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken } from './auth';
import { cloudflare, providerPath } from './providers';
import { AppError, now, type AppEnv } from './types';
import { inspectRepository, type Job } from './deployments';
import { change, replay, target, type Target } from './operations';
import {
  previewCommand,
  previewRefusal,
  previewsBlockIssues,
  skipInstall,
  type Site,
  previewsSnippet,
  stagingName,
  type HyperdriveBinding,
  type PreviewBindings,
  type StagingResource,
} from './repository-plan';
import { freeOnlyIssues } from './free-only';
import type { ResourceRequest } from '../shared/deployment-plan';

// Branch and pull request previews with Cloudflare's Worker Previews: a second build trigger
// on the production Worker runs `wrangler preview` for every other branch, so each branch
// gets a Preview with its own address (Workers Builds comments it on the pull request).
// Previews inherit no bindings: Shipcel creates staging copies of the app's databases,
// namespaces and buckets, and the repository's `previews` block binds them.

export const previews = new Hono<AppEnv>();
const confirmation = { requestId: z.string().uuid(), confirm: z.literal(true) };
const SCRIPT_API_DATE = { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' };
const providerId = z.string().regex(/^[a-f0-9-]{16,64}$/i);

type Previews = {
  project_id: string;
  workspace_id: string;
  account_id: string;
  worker_name: string;
  resource_suffix: string;
  resources_json: string;
  // PreviewBindings from the last check of the repository.
  config_json: string;
  trigger_uuid: string | null;
  status:
    | 'setting_up'
    | 'waiting_for_config'
    | 'active'
    | 'needs_attention'
    | 'disabled';
  error: string | null;
};
const current = (c: Context<AppEnv>, projectId: string) =>
  c.env.DB.prepare('SELECT * FROM project_previews WHERE project_id=?')
    .bind(projectId)
    .first<Previews>();
const staged = (row: Previews | null) =>
  JSON.parse(row?.resources_json ?? '[]') as StagingResource[];
const carried = (row: Previews | null) =>
  JSON.parse(row?.config_json ?? '{}') as PreviewBindings;
async function record(
  c: Context<AppEnv>,
  projectId: string,
  fields: Partial<Previews>,
) {
  const entries = Object.entries(fields);
  await c.env.DB.prepare(
    `UPDATE project_previews SET ${entries.map(([k]) => `${k}=?`).join(',')},updated_at=? WHERE project_id=?`,
  )
    .bind(...entries.map(([, v]) => v ?? null), now(), projectId)
    .run();
}
const newSuffix = () =>
  [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const triggerName = (worker: string) => `Shipcel previews ${worker}`;

// The deployed production pipeline previews belong to, with the fields target() leaves out.
async function production(c: Context<AppEnv>, write = false) {
  const t = await target(c, write);
  const job = (await c.env.DB.prepare(
    'SELECT * FROM deployment_jobs WHERE id=?',
  )
    .bind(t.job.id)
    .first<Job>())!;
  const refusal = previewRefusal(job.adapter);
  if (refusal) throw new AppError(409, refusal);
  if (
    job.status !== 'deployed' ||
    !job.trigger_uuid ||
    !job.repo_connection_uuid
  )
    throw new AppError(
      409,
      'Deploy the production pipeline before turning on branch previews.',
    );
  const project = (await c.env.DB.prepare(
    'SELECT framework, free_only FROM projects WHERE id=?',
  )
    .bind(t.p.id)
    .first<{ framework: string; free_only: number }>())!;
  return { t, job, project };
}

// The repository at the production-branch head, as Cloudflare will build it.
async function inspect(
  c: Context<AppEnv>,
  t: Target,
  job: Job,
  project: { framework: string; free_only: number },
) {
  const gh = await activeGrant(c.env, t.who.workspaceId, 'github');
  if (!gh) throw new AppError(409, 'Connect GitHub first.');
  const inspected = await inspectRepository(
    await grantToken(c.env, gh),
    job.repository_name,
    undefined,
    project.framework,
  );
  if (String(inspected.repository.id) !== job.repository_id)
    throw new AppError(
      409,
      'The repository changed. Create a new project for it.',
    );
  const issues = [
    ...inspected.issues,
    ...(project.free_only ? freeOnlyIssues(inspected) : []),
  ];
  return { inspected, issues };
}

// Staging copies are made for D1, KV and R2; a Postgres or MySQL database hosted elsewhere
// has no copy: previews bind the same Hyperdrive configurations as production.
const copied = (resources: ResourceRequest[]) =>
  resources.filter((r) => r.type !== 'hyperdrive');
const hyperdriveOf = (resources: ResourceRequest[]): HyperdriveBinding[] =>
  resources.flatMap((r) =>
    r.type === 'hyperdrive' && r.id ? [{ binding: r.binding, id: r.id }] : [],
  );
// What Previews bind besides the staging copies: the platform bindings, and production's
// Hyperdrive databases.
const previewBindingsOf = (inspected: {
  previewBindings: PreviewBindings;
  resources: ResourceRequest[];
}): PreviewBindings => {
  const hyperdrive = hyperdriveOf(inspected.resources);
  return {
    ...inspected.previewBindings,
    ...(hyperdrive.length ? { hyperdrive } : {}),
  };
};

const configIssues = (
  inspected: Awaited<ReturnType<typeof inspect>>['inspected'],
  resources: StagingResource[],
) => [
  // A site without a Wrangler configuration gets its previews block from Shipcel's.
  ...(inspected.adapter === 'static-assets'
    ? []
    : previewsBlockIssues(
        inspected.previews,
        resources,
        hyperdriveOf(inspected.resources),
      )),
  ...(inspected.previewUrls === false
    ? [
        'preview_urls is false in the Wrangler configuration, so Previews would have no addresses. Set it to true.',
      ]
    : []),
];

// A staging copy: created, or adopted when an interrupted attempt created it before
// Shipcel recorded it. Only the exact name with this project's recorded suffix is adopted.
async function stagingResource(
  t: Target,
  row: Previews,
  resource: ResourceRequest,
): Promise<StagingResource> {
  const name = stagingName(
    row.worker_name,
    row.resource_suffix,
    resource.binding,
  );
  const base = { type: resource.type, binding: resource.binding, name };
  if (resource.type === 'd1') {
    const found = z
      .array(z.object({ uuid: z.string(), name: z.string() }))
      .parse(
        await cloudflare(
          t.token,
          `${t.root}/d1/database?name=${providerPath(name)}`,
        ),
      )
      .find((d) => d.name === name);
    const id =
      found?.uuid ??
      z.object({ uuid: z.string().uuid() }).parse(
        await cloudflare(t.token, `${t.root}/d1/database`, {
          method: 'POST',
          body: JSON.stringify({ name }),
        }),
      ).uuid;
    return { ...base, id };
  }
  if (resource.type === 'kv') {
    const namespaces = z.array(z.object({ id: z.string(), title: z.string() }));
    let found: { id: string } | undefined;
    for (let page = 1; page <= 10 && !found; page++) {
      const list = namespaces.parse(
        await cloudflare(
          t.token,
          `${t.root}/storage/kv/namespaces?per_page=100&page=${page}`,
        ),
      );
      found = list.find((n) => n.title === name);
      if (list.length < 100) break;
    }
    const id =
      found?.id ??
      z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).parse(
        await cloudflare(t.token, `${t.root}/storage/kv/namespaces`, {
          method: 'POST',
          body: JSON.stringify({ title: name }),
        }),
      ).id;
    return { ...base, id };
  }
  try {
    await cloudflare(t.token, `${t.root}/r2/buckets/${name}`);
  } catch (error) {
    if (!(error instanceof AppError && error.status === 404)) throw error;
    await cloudflare(t.token, `${t.root}/r2/buckets`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }
  return { ...base, id: name };
}

// The preview trigger on the production Worker: adopted when an interrupted attempt
// created it (exactly one trigger with Shipcel's name), then set to the preview command.
async function previewTrigger(t: Target, job: Job, row: Previews) {
  const body = {
    deploy_command: previewCommand(
      job.adapter,
      job.worker_name,
      job.site_json ? (JSON.parse(job.site_json) as Site) : undefined,
    ),
    branch_includes: ['*'],
    branch_excludes: [job.branch],
  };
  const ours = z
    .array(
      z.object({
        trigger_uuid: providerId,
        trigger_name: z.string().optional(),
      }),
    )
    .parse(
      await cloudflare(
        t.token,
        `${t.root}/builds/workers/${job.worker_tag}/triggers`,
      ),
    )
    .filter(
      (trigger) =>
        trigger.trigger_uuid === row.trigger_uuid ||
        trigger.trigger_name === triggerName(job.worker_name),
    );
  if (ours.length > 1)
    throw new AppError(
      409,
      'There is more than one Shipcel preview trigger for this Worker. Remove the duplicate in Cloudflare, then try again.',
    );
  if (ours.length) {
    await cloudflare(
      t.token,
      `${t.root}/builds/triggers/${ours[0].trigger_uuid}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return ours[0].trigger_uuid;
  }
  return z.object({ trigger_uuid: providerId }).parse(
    await cloudflare(t.token, `${t.root}/builds/triggers`, {
      method: 'POST',
      body: JSON.stringify({
        external_script_id: job.worker_tag,
        repo_connection_uuid: job.repo_connection_uuid,
        build_token_uuid: job.build_token_uuid,
        trigger_name: triggerName(job.worker_name),
        build_command: job.build_command,
        root_directory: '/',
        path_includes: ['*'],
        path_excludes: [],
        ...body,
      }),
    }),
  ).trigger_uuid;
}

// Turns on workers.dev Preview addresses, keeping the production address as it is.
async function previewUrls(t: Target, worker: string) {
  const path = `${t.root}/workers/scripts/${worker}/subdomain`;
  const route = z
    .object({ enabled: z.boolean(), previews_enabled: z.boolean().optional() })
    .parse(await cloudflare(t.token, path, { headers: SCRIPT_API_DATE }));
  if (!route.previews_enabled)
    await cloudflare(t.token, path, {
      method: 'POST',
      headers: SCRIPT_API_DATE,
      body: JSON.stringify({ enabled: route.enabled, previews_enabled: true }),
    });
}

// Read-only: what turning previews on creates and what the repository needs.
previews.get('/projects/:id/previews/plan', async (c) => {
  const { t, job, project } = await production(c);
  const { inspected, issues } = await inspect(c, t, job, project);
  const row = await current(c, t.p.id);
  const resources = staged(row);
  return c.json({
    commit: inspected.commit,
    branch: job.branch,
    resources: copied(inspected.resources).map((r) => ({
      type: r.type,
      binding: r.binding,
      // Before setup the random suffix isn't chosen yet, so it shows as "…".
      name:
        resources.find((s) => s.type === r.type && s.binding === r.binding)
          ?.name ??
        stagingName(job.worker_name, 'xxxxxxxx', r.binding).replace(
          '-pv-xxxxxxxx-',
          '-pv-…-',
        ),
    })),
    warnings: [
      ...inspected.warnings.filter((w) => !w.startsWith('Wrangler creates')),
      'Previews build every branch other than the production branch with your build token, so only trusted collaborators should push branches. Builds from forks are not trusted previews.',
    ],
    issues,
    ready: issues.length === 0,
  });
});

// Turns previews on, or continues an attempt that stopped part-way. Staging copies are
// created first; the preview trigger is added only once the repository's previews block
// binds exactly those copies, so a preview build never reaches production data.
previews.post('/projects/:id/previews', async (c) => {
  const input = z
    .object({ ...confirmation, confirmResources: z.boolean().default(false) })
    .strict()
    .parse(await c.req.json());
  const { t, job, project } = await production(c, true);
  const kind = 'previews.enable';
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  if ((await current(c, t.p.id))?.status === 'active')
    throw new AppError(409, 'Branch previews are already on.');
  const { inspected, issues } = await inspect(c, t, job, project);
  if (issues.length) throw new AppError(409, issues.join(' '));
  const known = staged(await current(c, t.p.id));
  const toCreate = copied(inspected.resources).filter(
    (r) => !known.some((s) => s.type === r.type && s.binding === r.binding),
  );
  if (toCreate.length && !input.confirmResources)
    throw new AppError(
      400,
      'Review and confirm the staging copies before turning on previews.',
    );
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      const existing = await current(c, t.p.id);
      // The suffix is recorded before anything is created in Cloudflare.
      if (!existing)
        await c.env.DB.prepare(
          "INSERT INTO project_previews(project_id,workspace_id,account_id,worker_name,resource_suffix,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'setting_up',?,?,?)",
        )
          .bind(
            t.p.id,
            t.who.workspaceId,
            job.account_id,
            job.worker_name,
            newSuffix(),
            t.who.userId,
            now(),
            now(),
          )
          .run();
      else await record(c, t.p.id, { status: 'setting_up', error: null });
      const row = (await current(c, t.p.id))!;
      try {
        const resources = staged(row);
        for (const resource of copied(inspected.resources)) {
          if (
            resources.some(
              (s) => s.type === resource.type && s.binding === resource.binding,
            )
          )
            continue;
          resources.push(await stagingResource(t, row, resource));
          await record(c, t.p.id, {
            resources_json: JSON.stringify(resources),
          });
        }
        await record(c, t.p.id, {
          config_json: JSON.stringify(previewBindingsOf(inspected)),
        });
        const waiting = configIssues(inspected, resources);
        if (waiting.length) {
          await record(c, t.p.id, { status: 'waiting_for_config' });
          return {
            status: 'waiting_for_config',
            issues: waiting,
            snippet: previewsSnippet(
              resources,
              job.adapter,
              previewBindingsOf(inspected),
            ),
            resources,
          };
        }
        const trigger = await previewTrigger(t, job, row);
        // A site that installs with npm itself turns Cloudflare's install off here too.
        if (
          job.site_json &&
          (JSON.parse(job.site_json) as Site).install === 'npm'
        )
          await cloudflare(
            t.token,
            `${t.root}/builds/triggers/${trigger}/environment_variables`,
            { method: 'PATCH', body: JSON.stringify(skipInstall) },
            { errorDetail: true },
          );
        await record(c, t.p.id, { trigger_uuid: trigger });
        await previewUrls(t, job.worker_name);
        await record(c, t.p.id, { status: 'active', error: null });
        return { status: 'active', triggerUuid: trigger, resources };
      } catch (error) {
        await record(c, t.p.id, {
          status: 'needs_attention',
          error:
            error instanceof AppError
              ? error.message
              : 'Setup stopped part-way. Try again: Shipcel continues where it stopped.',
        });
        throw error;
      }
    },
    { intent: { workerName: job.worker_name } },
  );
});

const previewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().optional(),
    urls: z.array(z.string()).nullable().optional(),
    deployed_on: z.string().nullable().optional(),
    created_on: z.string().nullable().optional(),
  })
  .passthrough();
const deploymentSchema = z
  .object({
    id: z.string(),
    number: z.number().optional(),
    urls: z.array(z.string()).nullable().optional(),
    created_on: z.string().nullable().optional(),
    annotations: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();
// Addresses and links come from builds of repository code: only plain https links are shown.
const https = (value: unknown) =>
  typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/.test(value)
    ? value
    : null;

previews.get('/projects/:id/previews', async (c) => {
  const t = await target(c);
  const row = await current(c, t.p.id);
  if (!row) return c.json({ status: 'off' });
  const job = (await c.env.DB.prepare(
    'SELECT * FROM deployment_jobs WHERE id=?',
  )
    .bind(t.job.id)
    .first<Job>())!;
  const resources = staged(row);
  let list: unknown[] | null = null,
    listError: string | null = null,
    builds: unknown[] = [];
  // details=0: only the status and staging copies (Manage's Database tab asks this way).
  const details = c.req.query('details') !== '0';
  if (details && (row.status === 'active' || row.status === 'disabled')) {
    try {
      const found = z
        .array(previewSchema)
        .parse(
          await cloudflare(
            t.token,
            `${t.root}/workers/workers/${job.worker_name}/previews?per_page=100&order_by=deployed_on&order=desc`,
            {},
            { errorDetail: true },
          ),
        );
      list = await Promise.all(
        found.map(async (p, index) => {
          // The latest deployment of the ten most recent Previews: its commit and pull request.
          let latest: z.infer<typeof deploymentSchema> | null = null;
          if (index < 10)
            try {
              latest = deploymentSchema.parse(
                await cloudflare(
                  t.token,
                  `${t.root}/workers/workers/${job.worker_name}/previews/${providerPath(p.id)}/deployments/latest`,
                ),
              );
            } catch {
              latest = null;
            }
          const annotations = latest?.annotations ?? {};
          return {
            id: p.id,
            name: p.name,
            urls: (p.urls ?? []).map(https).filter(Boolean),
            deployedOn: p.deployed_on ?? null,
            latest: latest && {
              id: latest.id,
              number: latest.number ?? null,
              urls: (latest.urls ?? []).map(https).filter(Boolean),
              createdOn: latest.created_on ?? null,
              commit:
                typeof annotations['workers/commit_sha'] === 'string'
                  ? (annotations['workers/commit_sha'] as string).slice(0, 40)
                  : null,
              pullRequest: https(annotations['workers/pull_request_url']),
            },
          };
        }),
      );
    } catch (error) {
      listError =
        error instanceof AppError
          ? error.message
          : 'Cloudflare did not list the previews.';
    }
    if (row.trigger_uuid)
      try {
        builds = z
          .array(
            z
              .object({
                build_uuid: z.string(),
                build_outcome: z.string().nullable().optional(),
                status: z.string().optional(),
                created_at: z.string().optional(),
                trigger_uuid: z.string().optional(),
                trigger: z
                  .object({ trigger_uuid: z.string() })
                  .partial()
                  .optional(),
                build_trigger_metadata: z
                  .object({ branch: z.string() })
                  .partial()
                  .optional(),
              })
              .passthrough(),
          )
          .parse(
            await cloudflare(
              t.token,
              `${t.root}/builds/workers/${job.worker_tag}/builds?per_page=20`,
            ),
          )
          .filter(
            (b) =>
              (b.trigger?.trigger_uuid ?? b.trigger_uuid) === row.trigger_uuid,
          )
          .slice(0, 10)
          .map((b) => ({
            id: b.build_uuid,
            branch: b.build_trigger_metadata?.branch ?? null,
            outcome: b.build_outcome ?? null,
            status: b.status ?? null,
            createdAt: b.created_at ?? null,
          }));
      } catch {
        builds = [];
      }
  }
  return c.json({
    status: row.status,
    error: row.error,
    branch: job.branch,
    resources,
    snippet: previewsSnippet(resources, job.adapter, carried(row)),
    previews: list,
    previewsError: listError,
    builds,
  });
});

// Stops new previews by deleting the preview trigger. Existing Previews keep their
// addresses until deleted here or replaced by Cloudflare's limits; the staging copies stay
// in the account and are used again if previews are turned back on.
previews.delete('/projects/:id/previews', async (c) => {
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true);
  const kind = 'previews.disable';
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const row = await current(c, t.p.id);
  if (!row || row.status === 'disabled')
    throw new AppError(404, 'Branch previews are not on for this project.');
  return change(c, t, kind, input.requestId, async () => {
    if (row.trigger_uuid)
      try {
        await cloudflare(
          t.token,
          `${t.root}/builds/triggers/${row.trigger_uuid}`,
          { method: 'DELETE' },
        );
      } catch (error) {
        // Already deleted in Cloudflare counts as off.
        if (!(error instanceof AppError && error.status === 404)) throw error;
      }
    await record(c, t.p.id, {
      status: 'disabled',
      trigger_uuid: null,
      error: null,
    });
    return { status: 'disabled' };
  });
});

previews.delete('/projects/:id/previews/:previewId', async (c) => {
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const previewId = z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .parse(c.req.param('previewId'));
  const t = await target(c, true);
  const kind = `preview.delete:${previewId}`;
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  if (!(await current(c, t.p.id)))
    throw new AppError(404, 'Branch previews are not on for this project.');
  return change(c, t, kind, input.requestId, async () => {
    await cloudflare(
      t.token,
      `${t.root}/workers/workers/${t.job.worker_name}/previews/${previewId}`,
      { method: 'DELETE' },
      { errorDetail: true },
    );
    return { deleted: previewId };
  });
});

// The staging database previews bind under `binding`, for the Database tab.
export async function stagingDatabase(
  c: Context<AppEnv>,
  projectId: string,
  binding: string,
) {
  const found = staged(await current(c, projectId)).find(
    (s) => s.type === 'd1' && s.binding === binding,
  );
  if (!found)
    throw new AppError(
      409,
      'Previews have no staging database under this name. Turn on branch previews first.',
    );
  return found.id;
}
export const hasPreviews = async (c: Context<AppEnv>, projectId: string) =>
  Boolean(await current(c, projectId));
// Every staging copy previews bind, for the Storage tab.
export const stagedResources = async (c: Context<AppEnv>, projectId: string) =>
  staged(await current(c, projectId));
