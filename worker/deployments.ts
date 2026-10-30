import { Hono } from 'hono';
import { z } from 'zod';
import {
  activeGrant,
  cannotCreateWorkers,
  createsWorkers,
  grantToken,
  requireIdentity,
  type Grant,
} from './auth';
import { repoSchema } from './connections';
import { cloudflare, github, providerPath } from './providers';
import { AppError, now, type AppEnv, type Env } from './types';
import { hasImportAdapter, usesContainers } from '../shared/catalog';
import { probeHomepage, workersSubdomain } from './health';
import {
  appName,
  bucketNameIssues,
  detectFramework,
  repositoryPlan,
  siteFiles,
  skipInstall,
  containerDockerfiles,
  deploymentCommand,
  generatedWorkerName,
  type Site,
} from './repository-plan';
import type { ResourceRequest } from '../shared/deployment-plan';
import { freeOnlyIssues } from './free-only';
import { hyperdriveCreated } from './hyperdrive';
import { notify } from './notifications';
import { refuseWhilePaused } from './budgets';

export const deployments = new Hono<AppEnv>();
const uuid = z.string().uuid();
const fullName = z.string().regex(/^[\w-]+\/[\w.-]+$/);
export type Job = {
  id: string;
  workspace_id: string;
  project_id: string;
  created_by: string;
  cf_grant_id: string;
  gh_grant_id: string;
  account_id: string;
  repository_id: string;
  repository_name: string;
  branch: string;
  commit_sha: string;
  build_token_uuid: string;
  worker_name: string;
  build_command: string;
  deploy_command: string | null;
  // Sites without a Wrangler configuration: the reviewed Site, as JSON.
  site_json: string | null;
  adapter: string;
  resources_json: string;
  observed_resources_json: string;
  status: string;
  step: string;
  error: string | null;
  worker_tag: string | null;
  repo_connection_uuid: string | null;
  trigger_uuid: string | null;
  build_uuid: string | null;
  live_url: string | null;
  lease_until: number;
  monitor_started_at: number | null;
  recovery_note: string | null;
  environment: string;
  health_since: number | null;
  // An app Wrangler deploys from a computer: the adapter it was reviewed with.
  local_adapter?: string | null;
  created_at: number;
  updated_at: number;
};
export const publicJob = (j: Job) => ({
  id: j.id,
  project_id: j.project_id,
  repository_name: j.repository_name,
  branch: j.branch,
  adapter: j.adapter,
  localAdapter: j.local_adapter ?? null,
  resources: JSON.parse(j.resources_json || '[]') as ResourceRequest[],
  observedResources: JSON.parse(j.observed_resources_json || '[]'),
  commit_sha: j.commit_sha,
  worker_name: j.worker_name,
  status: j.status,
  step: j.step,
  error: j.error,
  account_id: j.account_id,
  trigger_uuid: j.trigger_uuid,
  build_uuid: j.build_uuid,
  live_url: j.live_url,
  recovery_note: j.recovery_note,
  environment: j.environment,
  created_at: j.created_at,
  updated_at: j.updated_at,
});
async function content(
  token: string,
  repo: string,
  path: string,
  ref: string,
  metadataOnly = false,
): Promise<string | null> {
  try {
    const response = await github(
      token,
      `/repos/${repo}/contents/${path}?ref=${providerPath(ref)}`,
    );
    if (metadataOnly) {
      z.object({
        type: z.literal('file'),
        size: z.number().nonnegative(),
      }).parse(response);
      return 'present';
    }
    const file = z
      .object({
        type: z.literal('file'),
        encoding: z.literal('base64'),
        size: z.number().max(131072),
        content: z.string().max(180000),
      })
      .parse(response);
    return new TextDecoder().decode(
      Uint8Array.from(atob(file.content.replace(/\s/g, '')), (c) =>
        c.charCodeAt(0),
      ),
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return null;
    throw error;
  }
}
export async function inspectRepository(
  token: string,
  name: string,
  ref?: string,
  framework?: string,
) {
  fullName.parse(name);
  const repo = repoSchema.parse(await github(token, `/repos/${name}`));
  if (!repo.permissions?.push && !repo.permissions?.admin)
    throw new AppError(403, 'You need write access to deploy this repository.');
  if (repo.archived)
    throw new AppError(409, 'Archived repositories cannot be deployed.');
  // Branches are used as exact native trigger patterns; reject glob metacharacters.
  if (
    !/^[a-zA-Z0-9_./-]{1,200}$/.test(repo.default_branch) ||
    repo.default_branch.includes('..')
  )
    throw new AppError(
      400,
      'This branch name is not supported by the current deployment adapter.',
    );
  const commit = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(
      await github(
        token,
        `/repos/${name}/commits/${providerPath(ref || repo.default_branch)}`,
      ),
    );
  const names = [
    'package.json',
    'wrangler.json',
    'wrangler.jsonc',
    'package-lock.json',
    'wrangler.toml',
    'wrangler.config.ts',
    'cloudflare.config.ts',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
  ];
  // Next.js imports also need the OpenNext configuration file; Python imports their
  // project file and, for packages, the uv lockfile.
  if (framework === 'nextjs') names.push('open-next.config.ts');
  if (framework === 'python') names.push('pyproject.toml', 'uv.lock');
  // A site without a Wrangler configuration: its root page and where its build goes.
  names.push(...siteFiles);
  const entries = await Promise.all(
    names.map(
      async (path) =>
        [
          path,
          await content(
            token,
            name,
            path,
            commit.sha,
            ![
              'package.json',
              'wrangler.json',
              'wrangler.jsonc',
              'open-next.config.ts',
              'pyproject.toml',
              ...siteFiles.filter((f) => f !== 'index.html'),
            ].includes(path),
          ),
        ] as const,
    ),
  );
  const files: Record<string, string | null> = Object.fromEntries(entries);
  // Container images build from Dockerfiles named in the configuration: check each exists.
  if (usesContainers(framework))
    for (const path of containerDockerfiles(
      files['wrangler.jsonc'] ?? files['wrangler.json'],
    ))
      files[path] = await content(token, name, path, commit.sha, true);
  const plan = repositoryPlan(files, framework);
  if (framework && !hasImportAdapter(framework))
    plan.issues.push(
      'This runtime does not yet have a verified repository deployment adapter.',
    );
  return { repository: repo, commit: commit.sha, ...plan };
}
async function project(c: Parameters<typeof requireIdentity>[0]) {
  const who = requireIdentity(c, 'deploy');
  const p = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<{
      id: string;
      name: string;
      framework: string;
      repository: string;
      database_enabled: number;
      storage_enabled: number;
      free_only: number;
    }>();
  if (!p) throw new AppError(404, 'Project not found.');
  return { who, p };
}
const directUploadOnly =
  'This project deploys by direct upload. Create another project to deploy from Git.';
// The New project dialog starts a GitHub project with the runtime its repository uses.
// Advisory only: the repository is inspected again, at a pinned commit, before deploying.
deployments.get('/repositories/detect', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const name = fullName.parse(c.req.query('repository'));
  const grant = await activeGrant(c.env, who.workspaceId, 'github');
  if (!grant) throw new AppError(409, 'Connect GitHub first.');
  const token = await grantToken(c.env, grant);
  const repo = repoSchema.parse(await github(token, `/repos/${name}`));
  if (!repo.permissions?.push && !repo.permissions?.admin)
    throw new AppError(403, 'You need write access to deploy this repository.');
  const files = Object.fromEntries(
    await Promise.all(
      [
        'package.json',
        'wrangler.json',
        'wrangler.jsonc',
        'pyproject.toml',
        'index.html',
      ].map(
        async (path) =>
          [
            path,
            // A file too large to read says nothing about the runtime.
            await content(
              token,
              repo.full_name,
              path,
              repo.default_branch,
              path === 'index.html',
            ).catch(() => null),
          ] as const,
      ),
    ),
  );
  return c.json({
    repository: repo.full_name,
    branch: repo.default_branch,
    framework: detectFramework(files),
  });
});
deployments.post('/projects/:id/repository', async (c) => {
  const { who, p } = await project(c);
  const { repository } = z
    .object({ repository: fullName })
    .strict()
    .parse(await c.req.json());
  const grant = await activeGrant(c.env, who.workspaceId, 'github');
  if (!grant) throw new AppError(409, 'Connect GitHub first.');
  const existing = await c.env.DB.prepare(
    "SELECT id, adapter FROM deployment_jobs WHERE project_id=? AND environment='production' LIMIT 1",
  )
    .bind(p.id)
    .first<{ adapter: string }>();
  if (existing)
    throw new AppError(
      409,
      existing.adapter === 'direct-upload'
        ? directUploadOnly
        : 'This project already has a deployment pipeline. Create another project to change its repository.',
    );
  const inspected = await inspectRepository(
    await grantToken(c.env, grant),
    repository,
    undefined,
    p.framework,
  );
  await c.env.DB.prepare(
    'UPDATE projects SET repository=? WHERE id=? AND workspace_id=?',
  )
    .bind(
      `https://github.com/${inspected.repository.full_name}`,
      p.id,
      who.workspaceId,
    )
    .run();
  return c.json({
    repository: inspected.repository.full_name,
    branch: inspected.repository.default_branch,
    commit: inspected.commit,
    adapter: inspected.adapter,
    buildCommand: inspected.buildCommand,
    resources: inspected.resources,
    containers: inspected.containers,
    workerName: inspected.workerName,
    site: inspected.site,
    warnings: inspected.warnings,
    ...(() => {
      const issues = [
        ...inspected.issues,
        ...(p.free_only ? freeOnlyIssues(inspected) : []),
      ];
      return { issues, ready: issues.length === 0 };
    })(),
  });
});
deployments.get('/projects/:id/deployments', async (c) => {
  const { who, p } = await project(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM deployment_jobs WHERE project_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 30',
  )
    .bind(p.id, who.workspaceId)
    .all<Job>();
  return c.json(results.map(publicJob));
});
// The newest non-preview deployment of each project in the workspace, newest first: the
// Overview's last deploy, and each project's status (Not deployed, Building, Live, Failed).
deployments.get('/deployments/recent', async (c) => {
  const who = requireIdentity(c);
  const { results } = await c.env.DB.prepare(
    "SELECT j.* FROM deployment_jobs j WHERE j.workspace_id=? AND j.environment!='preview' AND j.created_at=(SELECT MAX(created_at) FROM deployment_jobs WHERE workspace_id=j.workspace_id AND project_id=j.project_id AND environment!='preview') ORDER BY j.created_at DESC LIMIT 100",
  )
    .bind(who.workspaceId)
    .all<Job>();
  return c.json(results.map(publicJob));
});
deployments.post('/projects/:id/deployments', async (c) => {
  const { who, p } = await project(c);
  await refuseWhilePaused(c.env, p.id);
  if (c.env.NATIVE_BUILDS_ENABLED !== 'true')
    throw new AppError(
      503,
      'Native deployments are disabled until provider setup and a test-account validation are complete.',
    );
  if (!who.sessionHash)
    throw new AppError(
      401,
      'Sign in with GitHub before creating cloud resources.',
    );
  const input = z
    .object({
      buildTokenId: uuid,
      idempotencyKey: uuid,
      confirmCharges: z.literal(true),
      inspectedCommit: z.string().regex(/^[a-f0-9]{40}$/),
      confirmResources: z.boolean().default(false),
      confirmContainers: z.boolean().default(false),
      // The app's free address is <workerName>.<account subdomain>.workers.dev.
      workerName: appName.optional(),
    })
    .strict()
    .parse(await c.req.json());
  const repeated = await c.env.DB.prepare(
    'SELECT * FROM deployment_jobs WHERE workspace_id=? AND idempotency_key=?',
  )
    .bind(who.workspaceId, input.idempotencyKey)
    .first<Job>();
  if (repeated) {
    if (repeated.project_id !== p.id)
      throw new AppError(
        409,
        'Request key was already used for another project.',
      );
    return c.json(publicJob(repeated));
  }
  if (!hasImportAdapter(p.framework))
    throw new AppError(
      409,
      'This runtime does not yet have a verified repository deployment adapter.',
    );
  const prior = await c.env.DB.prepare(
    "SELECT id, adapter FROM deployment_jobs WHERE project_id=? AND environment='production' LIMIT 1",
  )
    .bind(p.id)
    .first<{ adapter: string }>();
  if (prior)
    throw new AppError(
      409,
      prior.adapter === 'direct-upload'
        ? directUploadOnly
        : 'A pipeline already exists or needs reconciliation. Future branch pushes are handled by Cloudflare; review its dashboard before creating another pipeline.',
    );
  const [gh, cf] = await Promise.all([
    activeGrant(c.env, who.workspaceId, 'github'),
    activeGrant(c.env, who.workspaceId, 'cloudflare'),
  ]);
  if (!gh || !cf?.account_id)
    throw new AppError(
      409,
      'Connect GitHub and select a Cloudflare account first.',
    );
  // The pipeline's first step creates the Worker.
  if (!(await createsWorkers(c.env, cf)))
    throw new AppError(409, cannotCreateWorkers);
  const repository = p.repository
    .replace(/^https:\/\/github.com\//, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '');
  const inspected = await inspectRepository(
    await grantToken(c.env, gh),
    repository,
    undefined,
    p.framework,
  );
  if (inspected.issues.length)
    throw new AppError(409, inspected.issues.join(' '));
  if (inspected.commit !== input.inspectedCommit)
    throw new AppError(
      409,
      'The production branch changed since inspection. Inspect it again and review the updated plan.',
    );
  if (p.free_only && freeOnlyIssues(inspected).length)
    throw new AppError(409, freeOnlyIssues(inspected).join(' '));
  if (inspected.resources.length && !input.confirmResources)
    throw new AppError(
      400,
      'Review and confirm the resource creation plan before deploying.',
    );
  // A Hyperdrive binding names a database added to this project, never another one.
  const ownHyperdrive = await hyperdriveCreated(c.env, p.id);
  const foreign = inspected.resources.filter(
    (r) => r.type === 'hyperdrive' && !ownHyperdrive.some((h) => h.id === r.id),
  );
  if (foreign.length)
    throw new AppError(
      409,
      `${foreign.map((r) => r.binding).join(', ')} names a Hyperdrive configuration that isn’t this project’s. Add the Postgres or MySQL database under Manage → Database, and put the id it shows in the Wrangler configuration.`,
    );
  if (inspected.containers.length && !input.confirmContainers)
    throw new AppError(
      400,
      'Review and confirm the container plan before deploying: containers need the Workers Paid plan, and Cloudflare bills their usage to your account.',
    );
  if (
    (p.database_enabled && !inspected.resources.some((r) => r.type === 'd1')) ||
    (p.storage_enabled && !inspected.resources.some((r) => r.type === 'r2'))
  )
    throw new AppError(
      409,
      'Your project requests D1/R2. Declare the corresponding draft bindings in the repository, then inspect again.',
    );
  if (
    input.workerName &&
    inspected.workerName &&
    input.workerName !== inspected.workerName
  )
    throw new AppError(
      409,
      `This repository deploys under the name in its Wrangler configuration (${inspected.workerName}).`,
    );
  if (input.workerName) {
    const issues = bucketNameIssues(input.workerName, inspected.resources);
    if (issues.length) throw new AppError(400, issues.join(' '));
  }
  const cfToken = await grantToken(c.env, cf);
  const tokens = await cloudflare<{ build_token_uuid: string }[]>(
    cfToken,
    `/accounts/${cf.account_id}/builds/tokens`,
  );
  if (!tokens.some((t) => t.build_token_uuid === input.buildTokenId))
    throw new AppError(
      403,
      'Select a build token from this Cloudflare account.',
    );
  // Workers Builds cannot register a subdomain, so a deploy without one would fail.
  if (!(await workersSubdomain(cfToken, cf.account_id)))
    throw new AppError(
      409,
      'Claim a free workers.dev subdomain for this Cloudflare account first. Every app gets its address under it.',
    );
  const id = crypto.randomUUID();
  // Chosen and configured names never adopt an existing Worker: the queued step checks
  // the account before anything is created.
  const workerName =
    inspected.workerName ??
    input.workerName ??
    generatedWorkerName(p.name, id, inspected.resources);
  // Names of Shipcel's own sign-in & realtime services in the account are taken too.
  const taken = await c.env.DB.prepare(
    'SELECT 1 FROM deployment_jobs WHERE account_id=? AND worker_name=? UNION ALL SELECT 1 FROM project_backends WHERE account_id=? AND worker_name=?',
  )
    .bind(cf.account_id, workerName, cf.account_id, workerName)
    .first();
  if (taken)
    throw new AppError(
      409,
      `The Worker name ${workerName} is already used by another Shipcel deployment in this account. ${inspected.workerName ? 'Change name in the Wrangler configuration, then inspect again.' : 'Choose another app name.'}`,
    );
  await c.env.DB.prepare(
    "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,deploy_command,adapter,resources_json,site_json,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)",
  )
    .bind(
      id,
      who.workspaceId,
      p.id,
      who.userId,
      cf.id,
      gh.id,
      cf.account_id,
      String(inspected.repository.id),
      inspected.repository.full_name,
      inspected.repository.default_branch,
      inspected.commit,
      input.buildTokenId,
      workerName,
      inspected.buildCommand,
      deploymentCommand(inspected.adapter, workerName, inspected.site),
      inspected.adapter,
      JSON.stringify(inspected.resources),
      inspected.site ? JSON.stringify(inspected.site) : null,
      input.idempotencyKey,
      now(),
      now(),
    )
    .run();
  return c.json(
    publicJob(
      (await c.env.DB.prepare('SELECT * FROM deployment_jobs WHERE id=?')
        .bind(id)
        .first<Job>())!,
    ),
    202,
  );
});
deployments.post('/deployments/:id/refresh', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const job = await c.env.DB.prepare(
    'SELECT * FROM deployment_jobs WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<Job>();
  if (!job) throw new AppError(404, 'Deployment not found.');
  await advanceDeployment(c.env, job.id);
  return c.json(
    publicJob(
      (await c.env.DB.prepare(
        'SELECT * FROM deployment_jobs WHERE id=? AND workspace_id=?',
      )
        .bind(job.id, who.workspaceId)
        .first<Job>())!,
    ),
  );
});

async function assertJobAccess(env: Env, job: Job) {
  const member = await env.DB.prepare(
    "SELECT 1 FROM memberships m JOIN projects p ON p.workspace_id=m.workspace_id WHERE m.workspace_id=? AND m.user_id=? AND m.role IN ('owner','developer') AND p.id=?",
  )
    .bind(job.workspace_id, job.created_by, job.project_id)
    .first();
  const [cf, gh] = await Promise.all([
    activeGrant(env, job.workspace_id, 'cloudflare'),
    activeGrant(env, job.workspace_id, 'github'),
  ]);
  if (
    !member ||
    cf?.id !== job.cf_grant_id ||
    gh?.id !== job.gh_grant_id ||
    cf.account_id !== job.account_id
  )
    throw new AppError(
      403,
      'Workspace membership or provider access changed. No further Shipcel operations will run.',
    );
  return { cf, gh };
}
const idResponse = (data: unknown, key: string) =>
  z
    .record(z.string(), z.unknown())
    .refine(
      (value) =>
        typeof value[key] === 'string' &&
        /^[a-f0-9-]{16,64}$/i.test(String(value[key])),
      `Missing provider ${key}`,
    )
    .parse(data)[key] as string;
const bindingType = {
  d1: 'd1',
  r2: 'r2_bucket',
  kv: 'kv_namespace',
  hyperdrive: 'hyperdrive',
} as const;
const bindingKey = {
  d1: 'id',
  r2: 'bucket_name',
  kv: 'namespace_id',
  hyperdrive: 'id',
} as const;
// Worker settings binding types that refer to separately created account resources.
const accountResourceTypes = [
  'd1',
  'r2_bucket',
  'kv_namespace',
  'queue',
  'dispatch_namespace',
  'vectorize',
  'hyperdrive',
];
export async function advanceDeployment(env: Env, id: string) {
  if (env.NATIVE_BUILDS_ENABLED !== 'true') return;
  const job = await env.DB.prepare(
    "UPDATE deployment_jobs SET lease_until=?, updated_at=? WHERE id=? AND status IN ('queued','provisioning','building') AND lease_until<=? RETURNING *",
  )
    .bind(now() + 90, now(), id, now())
    .first<Job>();
  if (!job) return;
  async function update(
    step: string,
    fields: Partial<
      Pick<
        Job,
        | 'worker_tag'
        | 'repo_connection_uuid'
        | 'trigger_uuid'
        | 'build_uuid'
        | 'status'
        | 'error'
        | 'live_url'
        | 'observed_resources_json'
        | 'health_since'
      >
    > = {},
  ) {
    const entries = Object.entries(fields);
    const changed = await env.DB.prepare(
      `UPDATE deployment_jobs SET step=?,updated_at=?${entries.map(([key]) => `,${key}=?`).join('')} WHERE id=? AND lease_until=? AND lease_until>? AND status IN ('queued','provisioning','building') RETURNING id`,
    )
      .bind(
        step,
        now(),
        ...entries.map(([, value]) => value),
        id,
        job!.lease_until,
        now(),
      )
      .first();
    if (!changed)
      throw new AppError(
        409,
        'Deployment access or processing lease changed. No further operations will run.',
      );
  }
  try {
    if (now() - (job.monitor_started_at ?? job.created_at) > 2700)
      throw new AppError(
        409,
        'Deployment monitoring exceeded 45 minutes. Check Cloudflare for the final build status.',
      );
    const { cf, gh } = await assertJobAccess(env, job);
    const cfToken = await grantToken(env, cf);
    const root = `/accounts/${job.account_id}`;
    // Validate current repository access even after queue delay or installation removal.
    const repo = repoSchema.parse(
      await github(await grantToken(env, gh), `/repos/${job.repository_name}`),
    );
    if (
      String(repo.id) !== job.repository_id ||
      (!repo.permissions?.push && !repo.permissions?.admin) ||
      repo.archived
    )
      throw new AppError(
        403,
        'Repository access changed. Reconnect the selected installation.',
      );
    // Recheck immediately before each provider mutation; never follow stale grants after disconnect.
    await assertJobAccess(env, job);
    if (job.step.startsWith('intent_'))
      throw new AppError(
        409,
        'A provider request was interrupted before Shipcel recorded its result. Use Check Cloudflare and resume; Shipcel adopts what was created and will not create duplicates.',
      );
    if (job.step === 'queued') {
      const workers = await cloudflare<{ id: string }[]>(
        cfToken,
        `${root}/workers/scripts`,
      );
      if (workers.some((w) => w.id === job.worker_name))
        throw new AppError(
          409,
          'A Worker with this name already exists in the account. No existing Worker was overwritten; choose an unused name.',
        );
      await update('create_worker', { status: 'provisioning' });
    } else if (job.step === 'create_worker') {
      await update('intent_create_worker');
      const body = new FormData();
      body.set(
        'metadata',
        JSON.stringify({
          main_module: 'index.js',
          compatibility_date: '2026-10-07',
        }),
      );
      body.set(
        'index.js',
        new Blob(
          [
            'export default { fetch() { return new Response("Deployment is being prepared.", {status:503}); } };',
          ],
          { type: 'application/javascript+module' },
        ),
        'index.js',
      );
      const tag = idResponse(
        await cloudflare(
          cfToken,
          `${root}/workers/scripts/${job.worker_name}`,
          { method: 'PUT', body },
        ),
        'tag',
      );
      await update('connect_repository', { worker_tag: tag });
    } else if (job.step === 'connect_repository') {
      await update('intent_connect_repository');
      const connection = idResponse(
        await cloudflare(
          cfToken,
          `${root}/builds/repos/connections`,
          {
            method: 'PUT',
            body: JSON.stringify({
              provider_type: 'github',
              provider_account_id: String(repo.owner.id),
              provider_account_name: repo.owner.login,
              repo_id: String(repo.id),
              repo_name: repo.name,
            }),
          },
          { errorDetail: true },
        ).catch((error: unknown) => {
          // Most often Cloudflare's own GitHub app can't read the repository yet.
          if (
            error instanceof AppError &&
            error.message.startsWith('Cloudflare reported')
          )
            throw new AppError(
              error.status,
              `${error.message} Cloudflare builds with its own GitHub app: let it read ${repo.full_name} (Connections shows how), then check Cloudflare and resume.`,
            );
          throw error;
        }),
        'repo_connection_uuid',
      );
      await update('create_trigger', { repo_connection_uuid: connection });
    } else if (job.step === 'create_trigger') {
      await update('intent_create_trigger');
      const trigger = idResponse(
        await cloudflare(cfToken, `${root}/builds/triggers`, {
          method: 'POST',
          body: JSON.stringify({
            external_script_id: job.worker_tag,
            repo_connection_uuid: job.repo_connection_uuid,
            build_token_uuid: job.build_token_uuid,
            trigger_name: `Shipcel ${job.worker_name}`,
            build_command: job.build_command,
            deploy_command:
              job.deploy_command ||
              deploymentCommand('configured-worker', job.worker_name),
            root_directory: '/',
            branch_includes: [job.branch],
            branch_excludes: [],
            path_includes: ['*'],
            path_excludes: [],
          }),
        }),
        'trigger_uuid',
      );
      await update('start_build', { trigger_uuid: trigger });
    } else if (job.step === 'start_build') {
      // A site that installs with npm itself turns Cloudflare's install off first. Setting a
      // variable again is harmless, so a repeated step needs no intent.
      if (
        job.site_json &&
        (JSON.parse(job.site_json) as Site).install === 'npm'
      )
        await cloudflare(
          cfToken,
          `${root}/builds/triggers/${job.trigger_uuid}/environment_variables`,
          { method: 'PATCH', body: JSON.stringify(skipInstall) },
          { errorDetail: true },
        );
      await update('intent_start_build');
      const build = idResponse(
        await cloudflare(
          cfToken,
          `${root}/builds/triggers/${job.trigger_uuid}/builds`,
          {
            method: 'POST',
            body: JSON.stringify({
              branch: job.branch,
              commit_hash: job.commit_sha,
            }),
          },
        ),
        'build_uuid',
      );
      await update('building', { build_uuid: build, status: 'building' });
    } else if (job.step === 'building') {
      const build = await cloudflare<{ build_outcome?: string }>(
        cfToken,
        `${root}/builds/builds/${job.build_uuid}`,
      );
      if (build.build_outcome === 'success') await update('health_check');
      else if (build.build_outcome) {
        await update('finished', {
          status: 'failed',
          error:
            'Cloudflare did not complete the build successfully. Open its build logs to diagnose the failure. The native trigger remains configured.',
        });
        await notify(env, {
          workspaceId: job.workspace_id,
          projectId: job.project_id,
          event: 'deployment.failed',
          text: (name) =>
            `The first build of ${name} failed. Open its build logs in Cloudflare.`,
          data: { worker: job.worker_name, status: 'failed' },
        });
      }
    } else if (job.step === 'health_check') {
      const resources = JSON.parse(
        job.resources_json || '[]',
      ) as ResourceRequest[];
      const settings = z
        .object({
          bindings: z.array(
            z
              .object({ name: z.string(), type: z.string() })
              .catchall(z.unknown()),
          ),
        })
        .parse(
          await cloudflare(
            cfToken,
            `${root}/workers/scripts/${job.worker_name}/settings`,
          ),
        );
      // Every account resource bound by the build must be one the user reviewed.
      const unreviewed = settings.bindings.filter(
        (b) =>
          accountResourceTypes.includes(b.type) &&
          !resources.some(
            (r) => r.binding === b.name && bindingType[r.type] === b.type,
          ),
      );
      if (unreviewed.length)
        throw new AppError(
          409,
          `Build succeeded, but it bound resources that were not in the reviewed plan: ${unreviewed.map((b) => (/^\w{1,64}$/.test(b.name) ? b.name : 'unnamed')).join(', ')}. Review them in Cloudflare before using this deployment.`,
        );
      const observed = resources.flatMap((resource) => {
        const found = settings.bindings.find(
          (b) =>
            b.name === resource.binding &&
            b.type === bindingType[resource.type],
        );
        const id = found?.[bindingKey[resource.type]];
        // D1 UUIDs, KV namespace IDs and R2 bucket names share this character set.
        if (typeof id === 'string' && /^[a-z0-9-]{1,64}$/i.test(id))
          return [{ ...resource, id }];
        if (resource.source === 'adapter') return [];
        throw new AppError(
          409,
          'Build succeeded but a requested resource binding was not observed. Inspect Cloudflare before retrying.',
        );
      });
      if (observed.length)
        await update('health_check', {
          observed_resources_json: JSON.stringify(observed),
        });
      const probe = await probeHomepage(
        cfToken,
        job.account_id,
        job.worker_name,
      );
      const since = job.health_since ?? now();
      if (probe.ok) {
        await update('finished', { status: 'deployed', live_url: probe.url });
        await notify(env, {
          workspaceId: job.workspace_id,
          projectId: job.project_id,
          event: 'deployment.ready',
          text: (name) => `${name} is live at ${probe.url}`,
          data: { worker: job.worker_name, url: probe.url },
        });
      }
      // Cloudflare provisions a first container image for several minutes after the build.
      else if (job.adapter === 'container' && now() - since < 900)
        await update('health_check', { health_since: since });
      else {
        await notify(env, {
          workspaceId: job.workspace_id,
          projectId: job.project_id,
          event: 'deployment.failed',
          text: (name) =>
            `${name} was built, but its homepage did not respond with HTTP 2xx. Check it in Shipcel.`,
          data: { worker: job.worker_name, status: 'needs_attention' },
        });
        await update('finished', {
          status: 'needs_attention',
          error:
            job.adapter === 'container'
              ? 'Cloudflare reports a successful build, but the homepage did not return HTTP 2xx within 15 minutes. Check the container and its logs in Cloudflare (Workers & Pages → Containers).'
              : 'Cloudflare reports a successful build, but the homepage health check did not return HTTP 2xx. Check routing or application authentication in Cloudflare.',
        });
      }
    }
  } catch (error) {
    await env.DB.prepare(
      "UPDATE deployment_jobs SET status='needs_attention',error=?,updated_at=? WHERE id=? AND lease_until=? AND status IN ('queued','provisioning','building')",
    )
      .bind(
        error instanceof AppError
          ? error.message
          : 'The deployment could not continue. Use Check Cloudflare and resume after the cause is fixed; Shipcel adopts what was created and will not create duplicates.',
        now(),
        id,
        job.lease_until,
      )
      .run();
    await notify(env, {
      workspaceId: job.workspace_id,
      projectId: job.project_id,
      event: 'deployment.failed',
      text: (name) =>
        `The deployment of ${name} needs attention. Open it in Shipcel to check Cloudflare and resume.`,
      data: { worker: job.worker_name, status: 'needs_attention' },
    });
  } finally {
    await env.DB.prepare(
      'UPDATE deployment_jobs SET lease_until=0 WHERE id=? AND lease_until=?',
    )
      .bind(id, job.lease_until)
      .run();
  }
}

export async function scheduledDeployments(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM deployment_jobs WHERE status IN ('queued','provisioning','building') AND lease_until<=? ORDER BY updated_at LIMIT 5",
  )
    .bind(now())
    .all<{ id: string }>();
  await Promise.allSettled(
    results.map((job) => advanceDeployment(env, job.id)),
  );
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now()),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<=?').bind(now()),
    env.DB.prepare('DELETE FROM request_limits WHERE expires_at<=?').bind(
      now(),
    ),
  ]);
}
