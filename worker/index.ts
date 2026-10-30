import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import {
  AppError,
  appOrigin,
  LOCAL_HOSTS,
  localMode,
  type AppEnv,
} from './types';
import { auth, identity, requireIdentity, limit, activeGrant } from './auth';
import { connections } from './connections';
import { deployments, scheduledDeployments } from './deployments';
import { plans } from './plans';
import { operations } from './operations';
import { recovery } from './recovery';
import { migrations } from './migrations';
import { operationRecovery } from './operation-recovery';
import { previews } from './previews';
import { backends } from './backend';
import { uploads } from './uploads';
import { localDeploys } from './local-deploys';
import { wranglerApi, wranglerGate } from './wrangler-api';
import { observability } from './observability';
import { webAnalytics } from './web-analytics';
import { deliverNotifications, notifications } from './notifications';
import { notificationPages } from './notification-pages';
import { sharedVariables } from './shared-variables';
import { budgets } from './budget-routes';
import { usage } from './usage';
import { dns } from './dns';
import { firewall } from './firewall';
import { scheduledBudgets } from './budgets';
import { backups, scheduledBackups } from './backups';
import { teams } from './teams';
import { MAX_KV_TEXT, MAX_R2_UPLOAD, storage } from './storage';
import { access } from './access';
import { setup } from './provider-apps';
import { mcp, MCP_MAX_BYTES } from './mcp';
import { MAX_REQUEST_BYTES } from '../shared/assets';
import {
  bearerToken,
  cliLogin,
  runTokenAllows,
  tokenForbidden,
  tokenIdentity,
  tokens,
} from './tokens';
import { actionsToken, githubActions } from './github-actions';
import { gitSources, gitSourceToken } from './git-sources';
import { analytics } from './analytics';
import { hyperdrive, hyperdriveCreated } from './hyperdrive';
import { oauthApprovals, oauthServer } from './oauth-server';

// The Hyperdrive databases a kit project has, so its configuration and export carry their ids.
const kitExtras = async (
  env: Parameters<typeof hyperdriveCreated>[0],
  projectId: string,
) => ({
  hyperdrive: (await hyperdriveCreated(env, projectId)).map(({ name, id }) => ({
    binding: name,
    id,
  })),
});
import { scheduledBuildScans, scheduledHealthChecks } from './health';
import { zipSync, strToU8 } from 'fflate';
import { projectSchema } from '../shared/validation';
import {
  frameworks,
  hasKit,
  usesContainers,
  type Project,
} from '../shared/catalog';
import { generateConfig, generateKit } from './kits';

type Row = {
  id: string;
  name: string;
  framework: Project['framework'];
  repository: string;
  database_enabled: number;
  storage_enabled: number;
  free_only: number;
  created_at: string;
  source: Project['source'];
  budget_state?: string | null;
};
const projectFromRow = (p: Row): Project => ({
  id: p.id,
  name: p.name,
  framework: p.framework,
  source: p.source,
  repository: p.repository,
  database: !!p.database_enabled,
  storage: !!p.storage_enabled,
  freeOnly: !!p.free_only,
  createdAt: p.created_at,
  budget:
    p.budget_state === 'over' || p.budget_state === 'paused'
      ? p.budget_state
      : null,
});
const app = new Hono<AppEnv>();
app.use('/api/*', async (c, next) => {
  if (!c.env) c.env = {} as AppEnv['Bindings'];
  const url = new URL(c.req.url);
  if (
    !LOCAL_HOSTS.has(url.hostname) &&
    (c.env.AUTH_MODE !== 'github' || !c.env.APP_ORIGIN)
  )
    return c.json(
      { error: 'Public hosting requires configured authentication.' },
      403,
    );
  const expected = appOrigin(c.env, c.req.raw);
  if (url.origin !== expected)
    return c.json({ error: 'Unexpected request origin.' }, 403);
  // Wrangler, run by the shipcel CLI for one deploy, presents that deploy's own token,
  // which the route checks itself (worker/local-deploys.ts).
  if (/^\/api\/wrangler\/[0-9a-f-]{36}\/client\/v4\//.test(url.pathname)) {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.set('identity', null);
    await next();
    return;
  }
  const token = bearerToken(c);
  if (token !== null) {
    // An API token (CLI, AI agent, script). Cookies and the browser checks below don't
    // apply: a token is never sent by a browser on its own.
    const who = await tokenIdentity(c.env, token);
    if (!who)
      return c.json(
        { error: 'This API token is not valid. Create a new one in Shipcel.' },
        401,
      );
    if (
      who.actionsRun
        ? !runTokenAllows(who.actionsRun.projectId, url.pathname, c.req.method)
        : tokenForbidden(url.pathname, c.req.method)
    )
      return c.json(
        {
          error: who.actionsRun
            ? 'This token deploys one project from GitHub Actions, and can’t do this.'
            : 'API tokens can’t do this. Use the Shipcel dashboard.',
        },
        403,
      );
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.set('identity', who);
    await next();
    return;
  }
  // Providers send the browser back here from their own sites, and an email notification's
  // confirm and stop links open from people's mail (their pages post back same-origin).
  const callback =
    /^\/api\/(auth\/(github|cloudflare)\/callback|setup\/github\/created|notifications\/email\/(confirm|stop))$/.test(
      url.pathname,
    ) && c.req.method === 'GET';
  const origin = c.req.header('Origin');
  if (
    !callback &&
    ((origin && origin !== expected) ||
      c.req.header('Sec-Fetch-Site') === 'cross-site')
  )
    return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !localMode(c.env, c.req.raw) &&
    origin !== expected &&
    c.req.header('X-Shipcel-Request') !== '1' &&
    // Its name before Cloudcel became Shipcel, which CLIs installed earlier still send.
    c.req.header('X-Cloudcel-Request') !== '1'
  )
    return c.json(
      { error: 'Same-origin request verification is required.' },
      403,
    );
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.set('identity', await identity(c));
  await next();
});
// Small JSON everywhere, except direct uploads: a manifest of up to 20,000 files, file
// batches, and the deploy request with an optional Worker module.
const tooLarge = (c: Context<AppEnv>) =>
  c.json({ error: 'Request too large.' }, 413);
const smallBody = bodyLimit({ maxSize: 8192, onError: tooLarge });
const uploadBody = bodyLimit({
  maxSize: MAX_REQUEST_BYTES + 65536,
  onError: tooLarge,
});
// Storage: a KV text value up to 1 MB (as JSON), or an R2 upload up to 25 MB.
const kvBody = bodyLimit({
  maxSize: 2 * MAX_KV_TEXT + 8192,
  onError: tooLarge,
});
const r2Body = bodyLimit({ maxSize: MAX_R2_UPLOAD + 65536, onError: tooLarge });
// A deploy from a computer: the files a review reads. What Wrangler sends through Shipcel
// (the app's code, batches of its files) is sized by wranglerGate from the length each
// request declares: it is never read into memory before the deploy's token is checked.
const planBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
const limitFor = (path: string) =>
  path.startsWith('/api/wrangler/')
    ? wranglerGate
    : /^\/api\/(projects\/[^/]+\/)?local-(plan|deploys)$/.test(path)
      ? planBody
      : /^\/api\/projects\/[^/]+\/uploads(\/[^/]+\/(files|deploy))?$/.test(path)
        ? uploadBody
        : /^\/api\/projects\/[^/]+\/storage\/kv\/[^/]+\/value$/.test(path)
          ? kvBody
          : /^\/api\/projects\/[^/]+\/storage\/r2\/[^/]+\/object$/.test(path)
            ? r2Body
            : smallBody;
app.use('/api/*', (c, next) => limitFor(c.req.path)(c, next));
app.route('/api/auth', auth);
app.get('/api/status', async (c) => {
  const who = c.get('identity');
  const cf = who?.sessionHash
    ? await activeGrant(c.env, who.workspaceId, 'cloudflare')
    : null;
  const gh = who?.sessionHash
    ? await activeGrant(c.env, who.workspaceId, 'github')
    : null;
  return c.json({
    mode: localMode(c.env, c.req.raw) ? 'local-alpha' : 'authenticated',
    cloudflareConnected: !!cf,
    githubConnected: !!gh,
    deploymentEnabled: !!(
      cf?.account_id &&
      gh &&
      c.env.NATIVE_BUILDS_ENABLED === 'true'
    ),
    frameworks,
  });
});
// OAuth for the MCP server (worker/oauth-server.ts): the metadata, registration, the
// authorization request and the token endpoint live at the root, like /mcp.
app.route('/', oauthServer);
// The CLI signs in before it has a token, and so does a GitHub Actions run.
app.route('/api', cliLogin);
app.route('/api', actionsToken);
app.route('/api', gitSourceToken);
app.route('/api', wranglerApi);
// An email notification's confirm and stop links open for whoever has the email.
app.route('/api', notificationPages);
app.use('/api/*', async (c, next) => {
  const who = requireIdentity(c);
  if (who.sessionHash)
    await limit(
      c.env,
      `api:${who.userId}:${c.req.method === 'GET' ? 'read' : 'write'}`,
      c.req.method === 'GET' ? 240 : 30,
    );
  await next();
});
app.route('/api/connections', connections);
app.route('/api/plan', plans);
app.route('/api', deployments);
app.route('/api', operations);
app.route('/api', recovery);
app.route('/api', migrations);
app.route('/api', operationRecovery);
app.route('/api', previews);
// Postgres and MySQL through Hyperdrive (worker/hyperdrive.ts).
app.route('/api', hyperdrive);
// Scheduled database backups to R2 (worker/backups.ts).
app.route('/api', backups);
app.route('/api', backends);
app.route('/api', tokens);
// The approval page's side of an AI agent's OAuth sign-in.
app.route('/api', oauthApprovals);
app.route('/api', uploads);
app.route('/api', localDeploys);
app.route('/api', observability);
app.route('/api', webAnalytics);
app.route('/api', notifications);
app.route('/api', budgets);
app.route('/api', usage);
app.route('/api', dns);
app.route('/api', firewall);
app.route('/api', githubActions);
// Repositories on GitLab, Bitbucket and Gitea (worker/git-sources.ts).
app.route('/api', gitSources);
// Secrets set on several of a workspace's projects at once (worker/shared-variables.ts).
app.route('/api', sharedVariables);
app.route('/api', teams);
app.route('/api', storage);
app.route('/api', access);
app.route('/api', setup);

app.get('/api/projects', async (c) => {
  const who = requireIdentity(c);
  // A GitHub Actions run's token sees its own project only.
  const only = who.actionsRun?.projectId ?? null;
  const { results } = await c.env.DB.prepare(
    'SELECT p.*, b.state AS budget_state FROM projects p LEFT JOIN budget_checks b ON b.project_id=p.id WHERE p.workspace_id=? AND (? IS NULL OR p.id=?) ORDER BY p.created_at DESC, p.id DESC',
  )
    .bind(who.workspaceId, only, only)
    .all<Row>();
  return c.json(results.map(projectFromRow));
});

app.post('/api/projects', async (c) => {
  // Viewers read; developers and owners create projects.
  requireIdentity(c, 'deploy');
  if (!c.req.header('Content-Type')?.startsWith('application/json'))
    return c.json({ error: 'Content-Type must be application/json.' }, 415);
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON.' }, 400);
  }
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues[0].message }, 400);
  const p = parsed.data;
  const existing = await c.env.DB.prepare(
    'SELECT id FROM projects WHERE name = ? AND workspace_id=?',
  )
    .bind(p.name, requireIdentity(c).workspaceId)
    .first();
  if (existing)
    return c.json({ error: 'A project with that name already exists.' }, 409);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO projects (id, name, framework, source, repository, database_enabled, storage_enabled, free_only, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        id,
        p.name,
        p.framework,
        p.source,
        p.repository,
        Number(p.database),
        Number(p.storage),
        Number(p.freeOnly),
        now,
        requireIdentity(c).workspaceId,
      ),
      c.env.DB.prepare(
        'INSERT INTO events (id, project_id, project_name, kind, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        crypto.randomUUID(),
        id,
        p.name,
        'project.created',
        now,
        requireIdentity(c).workspaceId,
      ),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: projects\.(workspace_id|name)/.test(
        error.message,
      )
    )
      return c.json({ error: 'A project with that name already exists.' }, 409);
    throw error;
  }
  return c.json({ id, ...p, createdAt: now }, 201);
});

// Turning Free-only off is a billing decision for an owner; turning it back on is allowed
// only while the project uses nothing billable.
app.put('/api/projects/:id/free-only', async (c) => {
  const who = requireIdentity(c, 'owner');
  const input = z
    .object({ freeOnly: z.boolean(), confirm: z.literal(true).optional() })
    .strict()
    .parse(await c.req.json());
  const row = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<Row>();
  if (!row) return c.json({ error: 'Project not found.' }, 404);
  if (!input.freeOnly && !input.confirm)
    return c.json(
      {
        error:
          'Confirm that Cloudflare may bill this project for R2 storage and containers.',
      },
      400,
    );
  if (input.freeOnly) {
    const billable =
      row.storage_enabled === 1 ||
      usesContainers(row.framework) ||
      !!(await c.env.DB.prepare(
        `SELECT 1 FROM deployment_jobs WHERE project_id=? AND workspace_id=? AND (adapter='container' OR resources_json LIKE '%"type":"r2"%') LIMIT 1`,
      )
        .bind(row.id, who.workspaceId)
        .first());
    if (billable)
      return c.json(
        {
          error:
            'This project uses R2 storage or containers, which can bill. Remove them in Cloudflare and from its configuration first, or keep Free-only off.',
        },
        409,
      );
    const backingUp = await c.env.DB.prepare(
      'SELECT 1 FROM backup_schedules WHERE project_id=? AND next_at IS NOT NULL',
    )
      .bind(row.id)
      .first();
    if (backingUp)
      return c.json(
        {
          error:
            'Scheduled backups go to R2, which can bill. Stop them under Manage → Database first, or keep Free-only off.',
        },
        409,
      );
  }
  await c.env.DB.prepare(
    'UPDATE projects SET free_only=? WHERE id=? AND workspace_id=?',
  )
    .bind(Number(input.freeOnly), row.id, who.workspaceId)
    .run();
  return c.json(projectFromRow({ ...row, free_only: Number(input.freeOnly) }));
});

// Its configuration lives in the repository; the kit generator never applied.
const fromGitHub =
  'This project deploys its GitHub repository, so it has no starter kit to export.';
app.get('/api/projects/:id/config', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND workspace_id=?',
  )
    .bind(c.req.param('id'), requireIdentity(c).workspaceId)
    .first<Row>();
  if (!row) return c.json({ error: 'Project not found.' }, 404);
  if (row.source === 'github') return c.json({ error: fromGitHub }, 409);
  if (!hasKit(row.framework))
    return c.json(
      {
        error:
          'This adapter is planned. Configuration export is not available yet.',
      },
      409,
    );
  return c.json(
    generateConfig(projectFromRow(row), await kitExtras(c.env, row.id)),
  );
});

app.post('/api/projects/:id/export', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND workspace_id=?',
  )
    .bind(c.req.param('id'), requireIdentity(c).workspaceId)
    .first<Row>();
  if (!row) return c.json({ error: 'Project not found.' }, 404);
  if (row.source === 'github') return c.json({ error: fromGitHub }, 409);
  if (!hasKit(row.framework))
    return c.json(
      {
        error:
          'This adapter is planned. Starter-kit export is not available yet.',
      },
      409,
    );
  const files = generateKit(
    projectFromRow(row),
    await kitExtras(c.env, row.id),
  );
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, contents]) => [
        `${row.name}/${path}`,
        strToU8(contents),
      ]),
    ),
  );
  await c.env.DB.prepare(
    'INSERT INTO events (id, project_id, project_name, kind, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      crypto.randomUUID(),
      row.id,
      row.name,
      'kit.exported',
      new Date().toISOString(),
      requireIdentity(c).workspaceId,
    )
    .run();
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${row.name}-shipcel.zip"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

app.delete('/api/projects/:id', async (c) => {
  requireIdentity(c, 'deploy');
  const row = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE id = ? AND workspace_id=?',
  )
    .bind(c.req.param('id'), requireIdentity(c).workspaceId)
    .first<Row>();
  if (!row) return c.json({ error: 'Project not found.' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM projects WHERE id = ? AND workspace_id=?',
    ).bind(row.id, requireIdentity(c).workspaceId),
    // Its repository can deploy another project then, and its runs' tokens stop working.
    c.env.DB.prepare('DELETE FROM github_actions WHERE project_id=?').bind(
      row.id,
    ),
    c.env.DB.prepare('DELETE FROM git_sources WHERE project_id=?').bind(row.id),
    // Its backups stop; the copies already made stay in the account's bucket.
    c.env.DB.prepare('DELETE FROM backup_schedules WHERE project_id=?').bind(
      row.id,
    ),
    c.env.DB.prepare('DELETE FROM backups WHERE project_id=?').bind(row.id),
    c.env.DB.prepare(
      'DELETE FROM notification_channels WHERE project_id=?',
    ).bind(row.id),
    c.env.DB.prepare(
      'DELETE FROM shared_variable_projects WHERE project_id=?',
    ).bind(row.id),
    c.env.DB.prepare(
      'UPDATE api_tokens SET revoked_at=? WHERE project_id=? AND revoked_at IS NULL',
    ).bind(Math.floor(Date.now() / 1000), row.id),
    c.env.DB.prepare(
      'INSERT INTO events (id, project_id, project_name, kind, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(
      crypto.randomUUID(),
      row.id,
      row.name,
      'project.deleted',
      new Date().toISOString(),
      requireIdentity(c).workspaceId,
    ),
  ]);
  return c.json({ ok: true });
});

app.get('/api/activity', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, project_id AS projectId, project_name AS projectName, kind, created_at AS createdAt FROM events WHERE workspace_id=? ORDER BY created_at DESC, id DESC LIMIT 100',
  )
    .bind(requireIdentity(c).workspaceId)
    .all();
  return c.json(results);
});
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.onError((error, c) => {
  if (error.message.includes('CLOUDCEL_PROJECT_LIMIT'))
    return c.json(
      {
        error:
          'Your Free plan includes 100 projects, as many Workers as Cloudflare’s free plan allows in one account. Remove an unused project to create another.',
      },
      409,
    );
  if (
    error.message.includes(
      'UNIQUE constraint failed: deployment_jobs.workspace_id',
    )
  )
    return c.json(
      {
        error:
          'Another pipeline setup is active, or this request was already submitted. Refresh the deployment before trying again.',
      },
      409,
    );
  if (error instanceof AppError)
    return c.json({ error: error.message }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError) {
    // The fields at fault, by path only, so a provider's drift can be read from the answer
    // and the logs without their values.
    const fields =
      error instanceof ZodError
        ? [...new Set(error.issues.map((i) => i.path.join('.') || '(root)'))]
        : [];
    console.warn(
      `Unexpected shape at ${c.req.method} ${new URL(c.req.url).pathname}: ${fields.join(', ') || error.message}`,
    );
    return c.json(
      { error: 'Invalid request or provider response.', fields },
      400,
    );
  }
  return c.json(
    {
      error:
        'The workspace could not complete the request. Check server configuration and local migrations.',
    },
    500,
  );
});
// The MCP server for AI agents. It authenticates API tokens only and calls the API above
// as the token's owner, so it can do nothing the token couldn't do directly.
app.use(
  '/mcp',
  bodyLimit({
    maxSize: MCP_MAX_BYTES,
    onError: (c) =>
      c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request too large.' },
        },
        413,
      ),
  }),
);
app.all('/mcp', async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  if (
    !LOCAL_HOSTS.has(url.hostname) &&
    (env.AUTH_MODE !== 'github' || !env.APP_ORIGIN)
  )
    return c.json(
      { error: 'Public hosting requires configured authentication.' },
      403,
    );
  const origin = appOrigin(env, c.req.raw);
  if (url.origin !== origin)
    return c.json({ error: 'Unexpected request origin.' }, 403);
  return mcp(c.req.raw, {
    origin,
    authenticate: async (token) => (await tokenIdentity(env, token)) !== null,
    api:
      (token) =>
      async (path, init = {}) => {
        const response = await app.fetch(
          new Request(`${origin}/api${path}`, {
            method: init.method ?? 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              ...(init.body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
            },
            body:
              init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
          env,
        );
        return {
          status: response.status,
          data: await response.json().catch(() => null),
        };
      },
  });
});
// Shipcel's own visitor analytics: /analytics.js and /ingest/* (worker/analytics.ts).
app.route('/', analytics);
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default Object.assign(app, {
  scheduled: (
    _event: ScheduledController,
    env: AppEnv['Bindings'],
    ctx: ExecutionContext,
  ) => {
    ctx.waitUntil(
      Promise.allSettled([
        scheduledDeployments(env),
        // New push builds are registered first so their first check can run at once.
        scheduledBuildScans(env).then(() => scheduledHealthChecks(env)),
        scheduledBudgets(env),
        scheduledBackups(env),
        deliverNotifications(env),
      ]),
    );
  },
});
