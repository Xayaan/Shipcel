import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import {
  advanceDeployment,
  inspectRepository,
  scheduledDeployments,
} from '../worker/deployments';
import { deploymentCommand, previewCommand } from '../worker/repository-plan';
import { now } from '../worker/types';
import { providerJSON } from '../worker/providers';

let db: ReturnType<typeof database>;
const account = 'a'.repeat(32),
  sha = 'b'.repeat(40),
  buildToken = '10000000-0000-4000-8000-000000000001';
const repo = {
  id: 50,
  name: 'sample',
  full_name: 'alice/sample',
  default_branch: 'main',
  private: true,
  archived: false,
  permissions: { push: true },
  owner: { id: 1, login: 'alice' },
};
const calls: { url: string; method: string; body?: BodyInit | null }[] = [];
const previewTrigger = '30000000-0000-4000-8000-000000000007';
let outcome: string | null,
  health: number,
  config: Record<string, unknown>,
  repoAccess: boolean,
  interruptPath: string,
  head: string,
  bindings: Record<string, unknown>[],
  manifest: Record<string, unknown>,
  scripts: Record<string, unknown>[],
  triggers: Record<string, unknown>[],
  buildList: Record<string, unknown>[],
  openNext: string | null,
  pyproject: string | null,
  uvLock: boolean,
  noPackageJson: boolean,
  // The name the repository's Wrangler configuration is committed under.
  configFile: 'wrangler.json' | 'wrangler.jsonc',
  repoFiles: Record<string, string>,
  subdomain: string | null,
  missingSubdomainStatus: number,
  // Staging copies, the production Worker's route, and its Worker Previews.
  d1List: { uuid: string; name: string }[],
  kvList: { id: string; title: string }[],
  r2Buckets: string[],
  scriptRoute: { enabled: boolean; previews_enabled: boolean },
  previewList: Record<string, unknown>[],
  previewDeployments: Record<string, Record<string, unknown>>,
  // The provider completes this request, then the response is lost.
  lostResponse: string,
  // Build tokens registered through the Builds API, and the status of a pasted user token.
  registered: Record<string, unknown>[],
  userTokenStatus: string,
  // An HTTP status Cloudflare answers token checks with, instead of checking the token.
  verifyFailure: number,
  // Shipcel's GitHub App installations and their repositories; the repositories Cloudflare's
  // own GitHub app can read, the Authorization it was asked with, and an outage's status.
  installations: {
    id: number;
    account: { id: number; login: string; type: string };
  }[],
  installationRepos: Record<number, (typeof repo)[]>,
  cloudflareReads: Set<number>,
  autofillAuth: (string | null)[],
  autofillStatus: number,
  // Cloudflare's reason for refusing to connect the repository, when it does.
  connectionRefusal: string;
const cf = (result: unknown) => Response.json({ success: true, result });
const file = (value: unknown) => {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  return Response.json({
    type: 'file',
    encoding: 'base64',
    size: source.length,
    content: btoa(source),
  });
};
beforeEach(() => {
  db = database();
  calls.length = 0;
  outcome = 'success';
  health = 200;
  config = {
    name: 'sample',
    main: 'src/index.js',
    compatibility_date: '2026-10-07',
  };
  repoAccess = true;
  interruptPath = '';
  head = sha;
  bindings = [];
  manifest = { scripts: { build: 'vite build' } };
  scripts = [];
  triggers = [];
  buildList = [];
  openNext = null;
  pyproject = null;
  uvLock = false;
  noPackageJson = false;
  configFile = 'wrangler.json';
  repoFiles = {};
  subdomain = 'test-account';
  missingSubdomainStatus = 404;
  d1List = [];
  kvList = [];
  r2Buckets = [];
  scriptRoute = { enabled: true, previews_enabled: false };
  previewList = [];
  previewDeployments = {};
  lostResponse = '';
  registered = [];
  userTokenStatus = 'active';
  verifyFailure = 0;
  installations = [{ id: 7, account: { id: 1, login: 'alice', type: 'User' } }];
  installationRepos = { 7: [repo] };
  cloudflareReads = new Set();
  autofillAuth = [];
  autofillStatus = 0;
  connectionRefusal = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input),
        path = new URL(url).pathname;
      calls.push({ url, method: init.method || 'GET', body: init.body });
      if (interruptPath && path.endsWith(interruptPath))
        throw new Error('Simulated provider timeout');
      const done = (response: Response) => {
        if (lostResponse && path.endsWith(lostResponse) && init.method)
          throw new Error('Simulated timeout after the provider acted');
        return response;
      };
      const accountPath = `/client/v4/accounts/${account}`;
      const autofill = path.match(
        /\/builds\/repos\/github\/(\d+)\/(\d+)\/config_autofill$/,
      );
      if (autofill) {
        autofillAuth.push(new Headers(init.headers).get('Authorization'));
        if (autofillStatus)
          return autofillStatus === 400
            ? Response.json(
                {
                  success: false,
                  errors: [{ code: 10001, message: 'Invalid repository id' }],
                },
                { status: 400 },
              )
            : new Response('', { status: autofillStatus });
        // Cloudflare reads the repository with its own GitHub app; one it can't see is not found.
        return cloudflareReads.has(Number(autofill[2]))
          ? cf({ build_command: 'npm run build', deploy_command: '' })
          : Response.json(
              {
                success: false,
                errors: [{ code: 12000, message: 'Not found' }],
              },
              { status: 404 },
            );
      }
      if (url === 'https://api.github.com/user/installations?per_page=100')
        return Response.json({
          installations,
          total_count: installations.length,
        });
      const listed = url.match(
        /^https:\/\/api\.github\.com\/user\/installations\/(\d+)\/repositories\?per_page=(\d+)$/,
      );
      if (listed) {
        const repositories = installationRepos[Number(listed[1])] ?? [];
        return Response.json({
          repositories: repositories.slice(0, Number(listed[2])),
          total_count: repositories.length,
        });
      }
      if (url === 'https://api.github.com/repos/alice/missing')
        return Response.json({ message: 'Not Found' }, { status: 404 });
      if (path === `${accountPath}/d1/database`) {
        if (init.method === 'POST') {
          const created = {
            uuid: `60000000-0000-4000-8000-${String(d1List.length + 1).padStart(12, '0')}`,
            name: JSON.parse(String(init.body)).name as string,
          };
          d1List.push(created);
          return done(cf(created));
        }
        // Cloudflare's name filter is a search: only Shipcel's exact-name check decides.
        return cf(d1List);
      }
      if (path === `${accountPath}/storage/kv/namespaces`) {
        if (init.method === 'POST') {
          const created = {
            id: (kvList.length + 1).toString(16).padStart(32, '0'),
            title: JSON.parse(String(init.body)).title as string,
          };
          kvList.push(created);
          return done(cf(created));
        }
        return cf(kvList);
      }
      if (path === `${accountPath}/r2/buckets` && init.method === 'POST') {
        const { name } = JSON.parse(String(init.body)) as { name: string };
        r2Buckets.push(name);
        return done(cf({ name }));
      }
      const bucket = path.match(/\/r2\/buckets\/([^/]+)$/)?.[1];
      if (bucket)
        return r2Buckets.includes(bucket)
          ? cf({ name: bucket })
          : Response.json(
              {
                success: false,
                errors: [
                  { code: 10006, message: 'The bucket does not exist.' },
                ],
              },
              { status: 404 },
            );
      if (/\/workers\/scripts\/[^/]+\/subdomain$/.test(path)) {
        if (init.method === 'POST') scriptRoute = JSON.parse(String(init.body));
        return cf(scriptRoute);
      }
      const preview = path.match(
        /\/workers\/workers\/[^/]+\/previews(?:\/([^/]+))?(\/deployments\/latest)?$/,
      );
      if (preview) {
        const [, id, latest] = preview;
        if (!id) return cf(previewList);
        if (init.method === 'DELETE') {
          previewList = previewList.filter((p) => p.id !== id);
          return cf(null);
        }
        if (latest && previewDeployments[id]) return cf(previewDeployments[id]);
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      if (url === 'https://api.github.com/repos/alice/sample')
        return Response.json({ ...repo, permissions: { push: repoAccess } });
      if (url === 'https://api.github.com/repos/alice/sample/commits/main')
        return Response.json({ sha: head });
      if (path.endsWith('/contents/package.json'))
        return noPackageJson
          ? new Response('', { status: 404 })
          : file(manifest);
      if (path.endsWith('/contents/pyproject.toml') && pyproject !== null)
        return file(pyproject);
      if (path.endsWith('/contents/uv.lock') && uvLock)
        return file('version = 1');
      if (path.endsWith(`/contents/${configFile}`)) return file(config);
      if (/\/contents\/wrangler\.jsonc?$/.test(path))
        return new Response('', { status: 404 });
      if (path.endsWith('/contents/package-lock.json'))
        return noPackageJson
          ? new Response('', { status: 404 })
          : file({ lockfileVersion: 3 });
      if (path.endsWith('/contents/open-next.config.ts') && openNext !== null)
        return file(openNext);
      const repoFile = path.split('/contents/')[1];
      if (repoFile && repoFiles[repoFile] !== undefined)
        return file(repoFiles[repoFile]);
      if (path.includes('/contents/')) return new Response('', { status: 404 });
      if (path.endsWith('/builds/tokens') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        registered.push({
          ...body,
          authorization: new Headers(init.headers).get('Authorization'),
        });
        return cf({
          build_token_uuid: '10000000-0000-4000-8000-000000000009',
          build_token_name: body.build_token_name,
          cloudflare_token_id: body.cloudflare_token_id,
          owner_type: 'user',
        });
      }
      if (path.endsWith('/builds/tokens'))
        return cf([
          { build_token_uuid: buildToken, build_token_name: 'Test builds' },
        ]);
      if (path === '/client/v4/user/tokens/verify') {
        if (verifyFailure) return new Response('', { status: verifyFailure });
        const auth = new Headers(init.headers).get('Authorization');
        if (auth === 'Bearer user-api-token-0123456789abcdef')
          return cf({ id: 'f'.repeat(32), status: userTokenStatus });
        return Response.json(
          {
            success: false,
            errors: [{ code: 1000, message: 'Invalid API Token' }],
          },
          { status: 401 },
        );
      }
      if (path.endsWith('/workers/scripts')) return cf(scripts);
      if (/\/builds\/workers\/[^/]+\/triggers$/.test(path)) return cf(triggers);
      if (/\/builds\/workers\/[^/]+\/builds$/.test(path)) return cf(buildList);
      if (path.endsWith('/settings')) return cf({ bindings });
      // Preview Workers (named cc-…-pv-…) get their own immutable tag.
      if (path.includes('/workers/scripts/'))
        return cf({ tag: (path.includes('-pv-') ? 'e' : 'c').repeat(32) });
      if (path.endsWith('/builds/repos/connections') && connectionRefusal)
        return Response.json(
          {
            success: false,
            errors: [{ code: 12004, message: connectionRefusal }],
          },
          { status: 400 },
        );
      if (path.endsWith('/builds/repos/connections'))
        return cf({
          repo_connection_uuid: '20000000-0000-4000-8000-000000000002',
        });
      if (path.endsWith('/builds/triggers')) {
        const name = JSON.parse(String(init.body)).trigger_name as string;
        if (!name.startsWith('Shipcel previews'))
          return cf({ trigger_uuid: '30000000-0000-4000-8000-000000000003' });
        triggers.push({ trigger_uuid: previewTrigger, trigger_name: name });
        return done(cf({ trigger_uuid: previewTrigger }));
      }
      if (/\/builds\/triggers\/[^/]+$/.test(path)) {
        if (init.method === 'DELETE')
          triggers = triggers.filter(
            (t) => !path.endsWith(String(t.trigger_uuid)),
          );
        return cf(
          init.method === 'DELETE' ? null : { trigger_uuid: previewTrigger },
        );
      }
      if (path.endsWith('/environment_variables') && init.method === 'PATCH')
        return cf(null);
      if (path.endsWith('/builds') && path.includes('/triggers/'))
        return cf({ build_uuid: '40000000-0000-4000-8000-000000000004' });
      if (path.includes('/builds/builds/'))
        return cf({ build_outcome: outcome });
      if (path.endsWith('/workers/subdomain')) {
        if (init.method === 'PUT')
          subdomain = JSON.parse(String(init.body)).subdomain;
        // Cloudflare reports an unregistered workers.dev subdomain as error 10007.
        return subdomain
          ? cf({ subdomain })
          : Response.json(
              {
                success: false,
                errors: [
                  { code: 10007, message: 'workers.api.error.not_found' },
                ],
              },
              { status: missingSubdomainStatus },
            );
      }
      if (new URL(url).hostname.endsWith('.test-account.workers.dev'))
        return new Response('App content', { status: health });
      throw new Error(`Unexpected URL: ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

async function createProject(name = 'test-app', options = {}) {
  const who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  return addProject(who, name, options);
}
async function addProject(
  who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  name: string,
  options = {},
) {
  const created = await db.request(
    '/projects',
    {
      method: 'POST',
      body: JSON.stringify({
        ...projectInput(name),
        repository: 'https://github.com/alice/sample',
        // These tests cover R2 and containers; Free-only projects have their own tests.
        freeOnly: false,
        ...options,
      }),
    },
    who.cookie,
  );
  expect(created.status).toBe(201);
  const p = (await created.json()) as { id: string };
  return { who, p };
}
async function deploy(
  { who, p }: Awaited<ReturnType<typeof createProject>>,
  overrides: Record<string, unknown> = {},
) {
  const input = {
    buildTokenId: buildToken,
    idempotencyKey: crypto.randomUUID(),
    confirmCharges: true,
    inspectedCommit: sha,
    ...overrides,
  };
  const response = await db.request(
    `/projects/${p.id}/deployments`,
    { method: 'POST', body: JSON.stringify(input) },
    who.cookie,
  );
  return { input, response };
}
async function setup(name = 'test-app', overrides = {}, options = {}) {
  const { who, p } = await createProject(name, options);
  const { input, response } = await deploy({ who, p }, overrides);
  expect(response.status).toBe(202);
  const job = (await response.json()) as { id: string; worker_name: string };
  return { who, p, input, job };
}
const jobCount = () =>
  (
    db.sqlite.prepare('SELECT COUNT(*) AS n FROM deployment_jobs').get() as {
      n: number;
    }
  ).n;
function stored(id: string) {
  return db.sqlite.prepare('SELECT * FROM deployment_jobs WHERE id=?').get(id)!;
}
async function steps(id: string, count = 7) {
  for (let i = 0; i < count; i++) await advanceDeployment(db.env, id);
}

describe('connections that can’t create Workers', () => {
  it('refuses a deployment that would create a Worker, before queuing it', async () => {
    const created = await createProject();
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET scopes=? WHERE provider='cloudflare'",
      )
      .run('account-settings.read workers-scripts.edit offline_access');
    const { response } = await deploy(created);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      'Update Cloudflare sign-in in Connections',
    );
    expect(jobCount()).toBe(0);
  });
});

describe('repository inspection', () => {
  it('pins configuration reads to a commit and blocks unsupported bindings', async () => {
    config = {
      ...config,
      d1_databases: [{ binding: 'DB', database_id: 'existing' }],
    };
    const inspected = await inspectRepository('test-token', 'alice/sample');
    expect(inspected.commit).toBe(sha);
    expect(inspected.issues.join(' ')).toContain('draft D1 bindings');
    expect(
      calls
        .filter((c) => c.url.includes('/contents/'))
        .every((c) => new URL(c.url).searchParams.get('ref') === sha),
    ).toBe(true);
  });
  it('refuses revoked repository write access before reading code', async () => {
    repoAccess = false;
    await expect(
      inspectRepository('test-token', 'alice/sample'),
    ).rejects.toThrow('write access');
    expect(calls.length).toBe(1);
  });
  it('rejects glob branch names so a production trigger cannot expand to other branches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ...repo, default_branch: 'feature/*' }),
      ),
    );
    await expect(
      inspectRepository('test-token', 'alice/sample'),
    ).rejects.toThrow('branch name');
  });
});

// The New project dialog reads a repository's runtime before the project exists.
describe('runtime detection', () => {
  const detect = (
    who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
    repository = 'alice/sample',
  ) =>
    db.request(
      `/repositories/detect?repository=${encodeURIComponent(repository)}`,
      {},
      who.cookie,
    );
  it('suggests the runtime from the default branch of a repository the person can push to', async () => {
    const who = await db.user(1);
    await db.grant(who, 'github');
    manifest = { dependencies: { astro: '7.3.6' } };
    const response = await detect(who);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repository: 'alice/sample',
      branch: 'main',
      framework: 'astro',
    });
    const reads = calls.filter((c) => c.url.includes('/contents/'));
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every((c) => new URL(c.url).searchParams.get('ref') === 'main'),
    ).toBe(true);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('needs GitHub, write access, a valid name, and a role that creates projects', async () => {
    const who = await db.user(1);
    expect((await detect(who)).status).toBe(409);
    await db.grant(who, 'github');
    expect((await detect(who, 'alice/../secret')).status).toBe(400);
    repoAccess = false;
    const refused = await detect(who);
    expect(refused.status).toBe(403);
    expect(calls.some((c) => c.url.includes('/contents/'))).toBe(false);
    repoAccess = true;
    const viewer = await db.user(2, 'viewer');
    await db.grant(viewer, 'github');
    expect((await detect(viewer)).status).toBe(403);
  });
  it('takes a repository of plain HTML files for a static site', async () => {
    const who = await db.user(1);
    await db.grant(who, 'github');
    noPackageJson = true;
    configFile = 'wrangler.none' as typeof configFile;
    repoFiles = { 'index.html': '<!doctype html><h1>Hello</h1>' };
    const response = await detect(who);
    expect(((await response.json()) as { framework: string }).framework).toBe(
      'static',
    );
  });
  it('reads the runtime from the other files when one is too large to read', async () => {
    const who = await db.user(1);
    await db.grant(who, 'github');
    manifest = { description: 'x'.repeat(140000) };
    const response = await detect(who);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { framework: string }).framework).toBe(
      'worker',
    );
  });
});

describe('reviewed resource plans', () => {
  beforeEach(() => {
    config = {
      ...config,
      d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
      r2_buckets: [{ binding: 'FILES' }],
    };
  });
  it('lists draft D1 and R2 bindings for review without adopting existing resources', async () => {
    const inspected = await inspectRepository('test-token', 'alice/sample');
    expect(inspected.issues).toEqual([]);
    expect(inspected.resources).toEqual([
      { type: 'd1', binding: 'DB' },
      { type: 'r2', binding: 'FILES' },
    ]);
  });
  it('rejects binding names that differ only by letter case', async () => {
    config = { ...config, r2_buckets: [{ binding: 'db' }] };
    const inspected = await inspectRepository('test-token', 'alice/sample');
    expect(inspected.issues.join(' ')).toContain('unique');
  });
  it('requires explicit consent before creating databases or buckets', async () => {
    const created = await createProject();
    const { response } = await deploy(created);
    expect(response.status).toBe(400);
    expect(jobCount()).toBe(0);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('keeps a Free-only project from creating R2 buckets, at review and at deploy', async () => {
    const created = await createProject('test-app', { freeOnly: true });
    const review = await db.request(
      `/projects/${created.p.id}/repository`,
      { method: 'POST', body: JSON.stringify({ repository: 'alice/sample' }) },
      created.who.cookie,
    );
    const plan = (await review.json()) as { issues: string[]; ready: boolean };
    expect(plan.ready).toBe(false);
    expect(plan.issues.join(' ')).toContain('Free-only');
    expect(plan.issues.join(' ')).toContain('FILES');
    const { response } = await deploy(created, { confirmResources: true });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain(
      'Free-only',
    );
    expect(jobCount()).toBe(0);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('deploys D1 in a Free-only project, because it stops at its free limits', async () => {
    config = { ...config, r2_buckets: [] };
    const created = await createProject('test-app', { freeOnly: true });
    const { response } = await deploy(created, { confirmResources: true });
    expect(response.status).toBe(202);
  });
  it('refuses a plan that was reviewed at an older commit', async () => {
    const created = await createProject();
    head = 'c'.repeat(40);
    const { response } = await deploy(created, { confirmResources: true });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('changed since inspection');
    expect(jobCount()).toBe(0);
  });
  it('requires a D1 binding when the project requested a database', async () => {
    config = { ...config, d1_databases: [] };
    const created = await createProject('test-app', { database: true });
    const { response } = await deploy(created, { confirmResources: true });
    expect(response.status).toBe(409);
    expect(jobCount()).toBe(0);
  });
  it('records observed resource bindings before publishing the URL', async () => {
    const { job, who, p } = await setup('test-app', { confirmResources: true });
    bindings = [
      { name: 'DB', type: 'd1', id: '50000000-0000-4000-8000-000000000005' },
      {
        name: 'FILES',
        type: 'r2_bucket',
        bucket_name: `${job.worker_name}-files`,
      },
      { name: 'API_KEY', type: 'secret_text' },
    ];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'deployed',
      live_url: `https://${job.worker_name}.test-account.workers.dev/`,
    });
    const [record] = (await (
      await db.request(`/projects/${p.id}/deployments`, {}, who.cookie)
    ).json()) as { resources: unknown[]; observedResources: unknown[] }[];
    expect(record.resources).toHaveLength(2);
    expect(record.observedResources).toEqual([
      { type: 'd1', binding: 'DB', id: '50000000-0000-4000-8000-000000000005' },
      { type: 'r2', binding: 'FILES', id: `${job.worker_name}-files` },
    ]);
  });
  it('stops without a live URL when a reviewed binding is missing after the build', async () => {
    const { job } = await setup('test-app', { confirmResources: true });
    bindings = [
      { name: 'DB', type: 'd1', id: '50000000-0000-4000-8000-000000000005' },
    ];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      live_url: null,
    });
    expect(stored(job.id).error).toContain('binding was not observed');
    expect(calls.some((c) => c.url.includes('.workers.dev'))).toBe(false);
  });
  it.each(['FILES_', 'F'.repeat(31)])(
    'rejects R2 binding %s because its automatic bucket name would be invalid',
    async (binding) => {
      config = { ...config, r2_buckets: [{ binding }] };
      const inspected = await inspectRepository('test-token', 'alice/sample');
      expect(inspected.issues.join(' ')).toContain('bucket name');
    },
  );
  it('does not record malformed provider resource identifiers', async () => {
    const { job } = await setup('test-app', { confirmResources: true });
    bindings = [
      { name: 'DB', type: 'd1', id: '<img src=x onerror=alert(1)>' },
      {
        name: 'FILES',
        type: 'r2_bucket',
        bucket_name: `${job.worker_name}-files`,
      },
    ];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      live_url: null,
      observed_resources_json: '[]',
    });
  });
  it('binds a Hyperdrive configuration the project has, and refuses one it hasn’t', async () => {
    const id = 'f'.repeat(32);
    config = { ...config, hyperdrive: [{ binding: 'PG', id }] };
    const created = await createProject();
    const refused = await deploy(created, { confirmResources: true });
    expect(refused.response.status).toBe(409);
    expect(
      ((await refused.response.json()) as { error: string }).error,
    ).toContain('Hyperdrive');
    expect(jobCount()).toBe(0);
    db.sqlite
      .prepare(
        'INSERT INTO hyperdrive_configs(id,project_id,workspace_id,binding,scheme,host,database,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        created.p.id,
        created.who.workspaceId,
        'PG',
        'postgres',
        'db.neon.tech',
        'shop',
        created.who.userId,
        now(),
      );
    const { response } = await deploy(created, { confirmResources: true });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; worker_name: string };
    // Nothing is created for it; the built Worker's binding is checked against the plan,
    // beside the D1 and R2 resources the build created.
    bindings = [
      { name: 'DB', type: 'd1', id: 'd'.repeat(32) },
      {
        name: 'FILES',
        type: 'r2_bucket',
        bucket_name: `${job.worker_name}-files`,
      },
      { name: 'PG', type: 'hyperdrive', id },
    ];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'deployed' });
    expect(
      JSON.parse(stored(job.id).observed_resources_json as string),
    ).toContainEqual({ type: 'hyperdrive', binding: 'PG', id });
  });
  it('keeps automatically created bucket names within R2 limits', async () => {
    config = { ...config, r2_buckets: [{ binding: 'UPLOADED_FILES' }] };
    const { job } = await setup('a'.repeat(48), { confirmResources: true });
    const bucket = `${job.worker_name}-uploaded-files`;
    expect(bucket.length).toBeLessThanOrEqual(63);
    expect(bucket).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  });
});

describe('Astro import adapter', () => {
  const astroConfig = {
    name: 'sample',
    main: '@astrojs/cloudflare/entrypoints/server',
    compatibility_date: '2026-10-06',
    compatibility_flags: ['global_fetch_strictly_public'],
    assets: { directory: './dist', binding: 'ASSETS' },
    observability: { enabled: true },
  };
  beforeEach(() => {
    manifest = {
      scripts: { build: 'astro build' },
      dependencies: { astro: '7.3.6', '@astrojs/cloudflare': '^14.3.4' },
    };
    config = astroConfig;
  });
  it('accepts a committed Cloudflare adapter configuration and lists adapter defaults for review', async () => {
    const inspected = await inspectRepository(
      'test-token',
      'alice/sample',
      undefined,
      'astro',
    );
    expect(inspected.issues).toEqual([]);
    expect(inspected.adapter).toBe('astro');
    expect(inspected.buildCommand).toBe('npm run build');
    expect(inspected.resources).toEqual([
      { type: 'kv', binding: 'SESSION', source: 'adapter' },
    ]);
    expect(inspected.warnings.join(' ')).toContain('Cloudflare Images');
  });
  it('explains the one-time adapter setup when the repository is not configured', async () => {
    manifest = {
      scripts: { build: 'astro build' },
      dependencies: { astro: '7.3.6' },
    };
    const inspected = await inspectRepository(
      'test-token',
      'alice/sample',
      undefined,
      'astro',
    );
    expect(inspected.issues.join(' ')).toContain('npx wrangler setup');
  });
  it('accepts package entry points only for the matching framework adapter', async () => {
    const inspected = await inspectRepository(
      'test-token',
      'alice/sample',
      undefined,
      'worker',
    );
    expect(inspected.issues.join(' ')).toContain('relative Worker entry point');
  });
  it('deploys the reviewed Astro plan and records the adapter session namespace', async () => {
    const created = await createProject('astro-app', { framework: 'astro' });
    const { response } = await deploy(created, { confirmResources: true });
    expect(response.status).toBe(202);
    const job = (await response.json()) as {
      id: string;
      worker_name: string;
      adapter: string;
    };
    expect(job.adapter).toBe('astro');
    bindings = [
      { name: 'ASSETS', type: 'assets' },
      { name: 'IMAGES', type: 'images' },
      {
        name: 'SESSION',
        type: 'kv_namespace',
        namespace_id: 'd'.repeat(32),
      },
    ];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'deployed' });
    expect(JSON.parse(String(stored(job.id).observed_resources_json))).toEqual([
      { type: 'kv', binding: 'SESSION', source: 'adapter', id: 'd'.repeat(32) },
    ]);
  });
  it('allows an adapter default that the repository disabled', async () => {
    const { job } = await setup(
      'astro-app',
      { confirmResources: true },
      { framework: 'astro' },
    );
    bindings = [{ name: 'ASSETS', type: 'assets' }];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'deployed' });
    expect(stored(job.id).observed_resources_json).toBe('[]');
  });
});

describe('SvelteKit import adapter', () => {
  beforeEach(() => {
    manifest = {
      scripts: { build: 'vite build' },
      dependencies: {
        '@sveltejs/kit': '3.0.1',
        '@sveltejs/adapter-cloudflare': '8.0.0',
      },
    };
    config = {
      name: 'sample',
      main: '.svelte-kit/cloudflare/_worker.js',
      compatibility_date: '2026-10-06',
      assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
      d1_databases: [{ binding: 'DB' }],
    };
  });
  it('accepts a committed Cloudflare adapter configuration without adapter resources', async () => {
    const inspected = await inspectRepository(
      'test-token',
      'alice/sample',
      undefined,
      'sveltekit',
    );
    expect(inspected.issues).toEqual([]);
    expect(inspected.adapter).toBe('sveltekit');
    expect(inspected.resources).toEqual([{ type: 'd1', binding: 'DB' }]);
  });
  it('explains the adapter setup when the repository is not configured', async () => {
    manifest = {
      scripts: { build: 'vite build' },
      dependencies: { '@sveltejs/kit': '3.0.1' },
    };
    const inspected = await inspectRepository(
      'test-token',
      'alice/sample',
      undefined,
      'sveltekit',
    );
    expect(inspected.issues.join(' ')).toContain(
      '@sveltejs/adapter-cloudflare',
    );
  });
  it('creates a pipeline for a reviewed SvelteKit repository', async () => {
    const { job } = await setup(
      'svelte-app',
      { confirmResources: true },
      { framework: 'sveltekit' },
    );
    expect(stored(job.id).adapter).toBe('sveltekit');
  });
});

describe('unverified runtimes', () => {
  it('keeps repository imports gated until an adapter is verified', async () => {
    // A runtime without an adapter (every one in the catalog has one now).
    const inspected = await inspectRepository(
      'test-token',
      'alice/sample',
      undefined,
      'rails',
    );
    expect(inspected.issues.join(' ')).toContain(
      'does not yet have a verified repository deployment adapter',
    );
  });
});

describe('Next.js import adapter', () => {
  // The committed configuration `wrangler setup` writes with @opennextjs/cloudflare 1.20.
  const nextConfig = {
    $schema: 'node_modules/wrangler/config-schema.json',
    main: '.open-next/worker.js',
    name: 'shipcel-next',
    compatibility_date: '2026-10-06',
    compatibility_flags: ['global_fetch_strictly_public'],
    assets: { directory: '.open-next/assets', binding: 'ASSETS' },
    services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shipcel-next' }],
    images: { binding: 'IMAGES' },
    observability: { enabled: true },
  };
  const defaultOpenNext = `// default open-next.config.ts file created by @opennextjs/cloudflare
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
// import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
	// For best results consider enabling R2 caching
	// incrementalCache: r2IncrementalCache
});
`;
  beforeEach(() => {
    manifest = {
      scripts: { build: 'next build' },
      dependencies: {
        next: '16.4.0',
        '@opennextjs/cloudflare': '^1.20.9',
      },
      devDependencies: { wrangler: '^4.148.0' },
    };
    config = nextConfig;
    openNext = defaultOpenNext;
  });
  const inspectNext = () =>
    inspectRepository('test-token', 'alice/sample', undefined, 'nextjs');
  it('accepts a committed OpenNext configuration and keeps its Worker name', async () => {
    const inspected = await inspectNext();
    expect(inspected.issues).toEqual([]);
    expect(inspected).toMatchObject({
      adapter: 'nextjs',
      buildCommand: 'npx opennextjs-cloudflare build',
      workerName: 'shipcel-next',
      resources: [],
    });
    expect(inspected.warnings.join(' ')).toContain('Cloudflare Images');
  });
  it('deploys under the configured name so the self-reference reaches the same Worker', async () => {
    const { job } = await setup('next-app', {}, { framework: 'nextjs' });
    expect(job.worker_name).toBe('shipcel-next');
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'deployed',
      build_command: 'npx opennextjs-cloudflare build',
    });
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.deploy_command).toContain('--name shipcel-next');
  });
  it('never adopts an existing Worker that already has the configured name', async () => {
    const { job } = await setup('next-app', {}, { framework: 'nextjs' });
    scripts = [{ id: 'shipcel-next', tag: 'f'.repeat(32) }];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'needs_attention' });
    expect(stored(job.id).error).toContain('already exists');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('refuses a configured name that another Shipcel deployment uses in the same account', async () => {
    const first = await setup('next-app', {}, { framework: 'nextjs' });
    db.sqlite
      .prepare("UPDATE deployment_jobs SET status='deployed' WHERE id=?")
      .run(first.job.id);
    const second = await addProject(first.who, 'next-two', {
      framework: 'nextjs',
    });
    const { response } = await deploy(second);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('already used');
  });
  it('refuses a different app name because the adapter deploys under the configured name', async () => {
    const { who, p } = await createProject('next-app', {
      framework: 'nextjs',
    });
    const { response } = await deploy({ who, p }, { workerName: 'other-name' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('shipcel-next');
  });
  it('refuses a self-reference that points at another Worker', async () => {
    config = {
      ...nextConfig,
      services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'other-worker' }],
    };
    expect((await inspectNext()).issues.join(' ')).toContain(
      'WORKER_SELF_REFERENCE',
    );
  });
  // OpenNext's caches as its docs set them up (https://opennext.js.org/cloudflare/caching):
  // entries in R2 behind a regional cache, revalidation through a Durable Object queue, tags
  // in sharded Durable Objects, each with the binding OpenNext reads.
  const cachedConfig = {
    ...nextConfig,
    r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET' }],
    durable_objects: {
      bindings: [
        { name: 'NEXT_CACHE_DO_QUEUE', class_name: 'DOQueueHandler' },
        { name: 'NEXT_TAG_CACHE_DO_SHARDED', class_name: 'DOShardedTagCache' },
      ],
    },
    migrations: [
      {
        tag: 'v1',
        new_sqlite_classes: ['DOQueueHandler', 'DOShardedTagCache'],
      },
    ],
  };
  const cachedOpenNext = `import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
import doShardedTagCache from "@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache";

export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: "long-lived" }),
  queue: doQueue,
  tagCache: doShardedTagCache({ baseShardSize: 12 }),
});
`;
  it('accepts OpenNext’s R2 cache, queue and tag cache with their bindings', async () => {
    config = cachedConfig;
    openNext = cachedOpenNext;
    const inspected = await inspectNext();
    expect(inspected.issues).toEqual([]);
    expect(inspected.openNextCache).toBe('r2');
    expect(inspected.resources).toContainEqual(
      expect.objectContaining({
        type: 'r2',
        binding: 'NEXT_INC_CACHE_R2_BUCKET',
      }),
    );
    // Cloudflare's builds deploy it without filling the cache: each page's first request does.
    const warnings = inspected.warnings.join(' ');
    expect(warnings).toContain('first request');
    expect(warnings).not.toContain('not configured');
  });
  it('names the binding each OpenNext cache needs when the configuration lacks it', async () => {
    openNext = cachedOpenNext;
    const issues = (await inspectNext()).issues.join(' ');
    for (const binding of [
      'NEXT_INC_CACHE_R2_BUCKET',
      'NEXT_CACHE_DO_QUEUE',
      'NEXT_TAG_CACHE_DO_SHARDED',
    ])
      expect(issues).toContain(binding);
  });
  it('refuses the OpenNext caches that need setting up at deploy, and ones it doesn’t know', async () => {
    openNext = `import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";
export default defineCloudflareConfig({ tagCache: d1NextTagCache });`;
    expect((await inspectNext()).issues.join(' ')).toContain(
      'doShardedTagCache',
    );
    openNext = `import { purgeCache } from "@opennextjs/cloudflare/overrides/cache-purge/index";
export default defineCloudflareConfig({ cachePurge: purgeCache({ type: "direct" }) });`;
    expect((await inspectNext()).issues.join(' ')).toContain('cachePurge');
    openNext =
      'export default defineCloudflareConfig({ incrementalCache: myCache });';
    expect((await inspectNext()).issues.join(' ')).toContain(
      'r2IncrementalCache',
    );
  });
  it('builds a static-assets cache into the files Cloudflare’s builds upload', async () => {
    openNext = `import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";
export default defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache });`;
    const inspected = await inspectNext();
    expect(inspected.issues).toEqual([]);
    expect(inspected.openNextCache).toBe('static-assets');
    // What `opennextjs-cloudflare populateCache` does for this cache: the prerendered
    // entries go into the app's static files, under the path OpenNext reads them from.
    expect(inspected.buildCommand).toBe(
      'npx opennextjs-cloudflare build && mkdir -p .open-next/assets/cdn-cgi/_next_cache && cp -R .open-next/cache/. .open-next/assets/cdn-cgi/_next_cache/',
    );
  });
  it('explains the one-time OpenNext setup when the adapter is not configured', async () => {
    manifest = {
      scripts: { build: 'next build' },
      dependencies: { next: '16.4.0' },
    };
    expect((await inspectNext()).issues.join(' ')).toContain(
      'npx wrangler setup',
    );
  });
});

describe('Python import adapters', () => {
  const pythonConfig = {
    name: 'sample',
    main: 'src/entry.py',
    compatibility_date: '2026-10-07',
    compatibility_flags: ['python_workers'],
  };
  const fastapi = `[project]
name = "sample"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi",
]

[dependency-groups]
dev = ["workers-py", "workers-runtime-sdk"]
`;
  // Package-free, with workers-py providing the `workers` module through pywrangler.
  const sdkOnly = fastapi.replace(
    'dependencies = [\n  "fastapi",\n]',
    'dependencies = []',
  );
  const inspectPython = () =>
    inspectRepository('test-token', 'alice/sample', undefined, 'python');
  beforeEach(() => {
    config = pythonConfig;
    noPackageJson = true;
  });
  it('accepts a package-free Python Worker for plain Wrangler before 2026-04-21', async () => {
    config = { ...pythonConfig, compatibility_date: '2026-04-20' };
    const inspected = await inspectPython();
    expect(inspected.issues).toEqual([]);
    expect(inspected).toMatchObject({ adapter: 'python', buildCommand: '' });
    // Or later, when the Worker keeps the runtime's own SDK.
    config = {
      ...pythonConfig,
      compatibility_flags: ['python_workers', 'disable_python_external_sdk'],
    };
    expect((await inspectPython()).issues).toEqual([]);
  });
  it('sends Python Workers from 2026-04-21 to pywrangler, which provides the workers module', async () => {
    const issues = (await inspectPython()).issues.join(' ');
    expect(issues).toContain('2026-04-21');
    expect(issues).toContain('workers-py');
    expect(issues).toContain('pywrangler');
  });
  it('deploys a package-free Python Worker that declares workers-py with pywrangler', async () => {
    pyproject = sdkOnly;
    uvLock = true;
    noPackageJson = false;
    configFile = 'wrangler.jsonc';
    manifest = { devDependencies: { wrangler: '4.154.0' } };
    const inspected = await inspectPython();
    expect(inspected.issues).toEqual([]);
    expect(inspected).toMatchObject({
      adapter: 'python-packages',
      buildCommand: '',
    });
    // Also with a version specifier, as workers-py >= 1.9 is what provides the module.
    pyproject = sdkOnly.replace('"workers-py"', '"workers-py>=1.9"');
    expect(await inspectPython()).toMatchObject({
      issues: [],
      adapter: 'python-packages',
    });
    // Python packages were verified with Wrangler 4.154.0: another pinned one is untested.
    expect(inspected.warnings.join(' ')).not.toContain('untested');
    manifest = { devDependencies: { wrangler: '4.148.0' } };
    expect((await inspectPython()).warnings).toContain(
      'Shipcel verified Python packages with Wrangler 4.154.0; other versions are untested.',
    );
  });
  it('needs wrangler.jsonc for pywrangler, which doesn’t read wrangler.json', async () => {
    pyproject = sdkOnly;
    uvLock = true;
    noPackageJson = false;
    manifest = { devDependencies: { wrangler: '4.148.0' } };
    expect((await inspectPython()).issues.join(' ')).toContain(
      'wrangler.jsonc',
    );
  });
  it('requires a Python entry point and the python_workers flag', async () => {
    config = { ...pythonConfig, main: 'src/index.js', compatibility_flags: [] };
    const issues = (await inspectPython()).issues.join(' ');
    expect(issues).toContain('.py');
    expect(issues).toContain('python_workers');
  });
  it('deploys Python packages with pywrangler, a pinned uv, and pinned Wrangler', async () => {
    pyproject = fastapi;
    uvLock = true;
    noPackageJson = false;
    configFile = 'wrangler.jsonc';
    manifest = { devDependencies: { wrangler: '4.148.0' } };
    const inspected = await inspectPython();
    expect(inspected.issues).toEqual([]);
    expect(inspected.adapter).toBe('python-packages');
    const { job } = await setup('py-app', {}, { framework: 'python' });
    await steps(job.id, 4);
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.deploy_command).toBe(
      `pipx run --spec uv==0.13.6 uv run pywrangler deploy --no-autoconfig --x-provision --x-auto-create --name ${job.worker_name}`,
    );
    expect(trigger.build_command).toBe('');
  });
  it('requires uv.lock, workers-py, and a package.json that pins Wrangler for Python packages', async () => {
    pyproject = fastapi.replace('"workers-py", ', '');
    const issues = (await inspectPython()).issues.join(' ');
    expect(issues).toContain('uv.lock');
    expect(issues).toContain('workers-py');
    expect(issues).toContain('package.json');
  });
});

describe('Container import adapter', () => {
  const containerConfig = {
    name: 'shipcel-containers',
    main: 'src/index.js',
    compatibility_date: '2026-10-07',
    containers: [
      {
        class_name: 'Site',
        image: './Dockerfile',
        max_instances: 3,
        instance_type: 'basic',
      },
    ],
    durable_objects: { bindings: [{ name: 'SITE', class_name: 'Site' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Site'] }],
  };
  // Cloudflare's containers template: the Durable Object starts its own container (beta).
  const managedConfig = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: 'containers-template',
    main: 'src/index.ts',
    compatibility_date: '2025-10-08',
    compatibility_flags: ['nodejs_compat'],
    observability: { enabled: true },
    containers: [
      {
        class_name: 'MyContainer',
        scheduling_policy: 'durable_object',
        images: { base: { dockerfile: './Dockerfile' } },
      },
    ],
    durable_objects: {
      bindings: [{ class_name: 'MyContainer', name: 'MY_CONTAINER' }],
    },
    upload_source_maps: true,
    exports: { MyContainer: { type: 'durable-object', storage: 'sqlite' } },
  };
  const inspectContainer = () =>
    inspectRepository('test-token', 'alice/sample', undefined, 'docker');
  async function containerJob() {
    const { who, p } = await createProject('box-app', { framework: 'docker' });
    const { response } = await deploy({ who, p }, { confirmContainers: true });
    expect(response.status).toBe(202);
    return {
      who,
      p,
      job: (await response.json()) as { id: string; worker_name: string },
    };
  }
  beforeEach(() => {
    manifest = {
      dependencies: { '@cloudflare/containers': '0.3.7' },
      devDependencies: { wrangler: '4.148.0' },
    };
    config = containerConfig;
    repoFiles = { Dockerfile: 'FROM busybox:1.37.0\n' };
  });
  it('accepts a Container Worker whose Dockerfile is in the repository and keeps its Worker name', async () => {
    const inspected = await inspectContainer();
    expect(inspected.issues).toEqual([]);
    expect(inspected).toMatchObject({
      adapter: 'container',
      buildCommand: '',
      workerName: 'shipcel-containers',
      containers: [
        {
          className: 'Site',
          policy: 'default',
          images: ['./Dockerfile'],
          instanceType: 'basic',
          maxInstances: 3,
        },
      ],
    });
    expect(inspected.warnings.join(' ')).toContain('Workers Paid');
    const read = calls.find((c) => c.url.includes('/contents/Dockerfile'));
    expect(new URL(read!.url).searchParams.get('ref')).toBe(sha);
  });
  it("accepts the Durable Object-managed layout of Cloudflare's containers template", async () => {
    config = managedConfig;
    const inspected = await inspectContainer();
    expect(inspected.issues).toEqual([]);
    expect(inspected).toMatchObject({
      workerName: 'containers-template',
      containers: [
        {
          className: 'MyContainer',
          policy: 'durable_object',
          images: ['./Dockerfile'],
          instanceType: null,
          maxInstances: null,
        },
      ],
    });
    expect(inspected.warnings.join(' ')).toContain('beta');
  });
  it('points a container repository imported as another runtime to the Docker runtime', async () => {
    const inspected = await inspectRepository('test-token', 'alice/sample');
    expect(inspected.issues.join(' ')).toContain('Docker / custom runtime');
  });
  it('requires each Dockerfile to exist at the inspected commit', async () => {
    repoFiles = {};
    expect((await inspectContainer()).issues.join(' ')).toContain(
      './Dockerfile',
    );
  });
  it('lists registry images for review without pulling them', async () => {
    config = {
      ...containerConfig,
      containers: [
        { class_name: 'Site', image: 'docker.io/library/nginx:1.27' },
      ],
    };
    const inspected = await inspectContainer();
    expect(inspected.issues).toEqual([]);
    expect(inspected.containers[0]).toMatchObject({
      images: ['docker.io/library/nginx:1.27'],
      instanceType: 'lite',
      maxInstances: 20,
    });
    expect(inspected.warnings.join(' ')).toContain('registry');
    expect(calls.some((c) => c.url.includes('nginx'))).toBe(false);
  });
  it('describes a custom instance size with Wrangler defaults for unset limits', async () => {
    config = {
      ...containerConfig,
      containers: [
        {
          class_name: 'Site',
          image: './Dockerfile',
          instance_type: { vcpu: 0.5, memory_mib: 1024 },
        },
      ],
    };
    expect((await inspectContainer()).containers[0].instanceType).toBe(
      'custom (0.5 vCPU, 1024 MiB memory, 2000 MB disk)',
    );
  });
  it('requires a valid name because container applications are named after it', async () => {
    const { name: _, ...unnamed } = containerConfig;
    config = unnamed;
    expect((await inspectContainer()).issues.join(' ')).toContain(
      'Set name in the Wrangler configuration',
    );
  });
  it.each([
    [
      'a Durable Object in another Worker',
      {
        durable_objects: {
          bindings: [
            { name: 'SITE', class_name: 'Site', script_name: 'other' },
          ],
        },
      },
      'another Worker',
    ],
    [
      'a container without a Durable Object binding',
      { durable_objects: { bindings: [] } },
      'Bind each container class',
    ],
    [
      'Durable Object data transferred from another Worker',
      {
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['Site'] },
          {
            tag: 'v2',
            transferred_classes: [
              { from: 'Old', from_script: 'other', to: 'Site' },
            ],
          },
        ],
      },
      'transfer',
    ],
    [
      'an export that expects data from another Worker',
      {
        migrations: undefined,
        exports: {
          Site: {
            type: 'durable-object',
            state: 'expecting-transfer',
            storage: 'sqlite',
            transfer_from: 'other',
          },
        },
      },
      'transfer',
    ],
    [
      'SSH access to containers',
      {
        containers: [
          { class_name: 'Site', image: './Dockerfile', ssh: { enabled: true } },
        ],
      },
      'ssh',
    ],
    [
      'a registry image without a registry host',
      { containers: [{ class_name: 'Site', image: 'nginx:latest' }] },
      'registry image with a tag',
    ],
    [
      'a Dockerfile outside the repository',
      { containers: [{ class_name: 'Site', image: '../Dockerfile' }] },
      'Dockerfile',
    ],
  ])('refuses %s', async (_, change, message) => {
    config = { ...containerConfig, ...change };
    expect((await inspectContainer()).issues.join(' ')).toContain(message);
  });
  it('deploys under the configured name only after consent to container charges', async () => {
    const { who, p } = await createProject('box-app', { framework: 'docker' });
    const refused = await deploy({ who, p });
    expect(refused.response.status).toBe(400);
    expect(await refused.response.text()).toContain('Workers Paid');
    const { response } = await deploy({ who, p }, { confirmContainers: true });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string };
    expect(job).toMatchObject({
      adapter: 'container',
      worker_name: 'shipcel-containers',
    });
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'deployed' });
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.deploy_command).toBe(
      'npx wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name shipcel-containers',
    );
    expect(trigger.build_command).toBe('');
  });
  it('keeps checking the homepage while a first container deployment starts', async () => {
    const { job } = await containerJob();
    health = 503;
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'building',
      step: 'health_check',
      live_url: null,
      error: null,
    });
    health = 200;
    await steps(job.id, 1);
    expect(stored(job.id)).toMatchObject({
      status: 'deployed',
      live_url: 'https://shipcel-containers.test-account.workers.dev/',
    });
  });
  it('reports a container that is still not serving after 15 minutes', async () => {
    const { job } = await containerJob();
    health = 503;
    await steps(job.id);
    db.sqlite
      .prepare('UPDATE deployment_jobs SET health_since=? WHERE id=?')
      .run(now() - 901, job.id);
    await steps(job.id, 1);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      live_url: null,
    });
    expect(stored(job.id).error).toContain('15 minutes');
  });
  it('gives a resumed container deployment a fresh startup window', async () => {
    const { who, job } = await containerJob();
    health = 503;
    await steps(job.id);
    db.sqlite
      .prepare('UPDATE deployment_jobs SET health_since=? WHERE id=?')
      .run(now() - 901, job.id);
    await steps(job.id, 1);
    expect(stored(job.id).status).toBe('needs_attention');
    const resumed = await db.request(
      `/deployments/${job.id}/reconcile`,
      { method: 'POST', body: JSON.stringify({ confirm: true }) },
      who.cookie,
    );
    expect(resumed.status).toBe(200);
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'building',
      step: 'health_check',
      error: null,
    });
  });
  it('keeps branch previews off until container Previews are verified', async () => {
    const { who, p, job } = await containerJob();
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
    scripts = [{ id: job.worker_name, tag: 'c'.repeat(32) }];
    const plan = await db.request(
      `/projects/${p.id}/previews/plan`,
      {},
      who.cookie,
    );
    expect(plan.status).toBe(409);
    expect(await plan.text()).toContain('container');
    const response = await db.request(
      `/projects/${p.id}/previews`,
      {
        method: 'POST',
        body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
      },
      who.cookie,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('container application');
  });
});

// Like a Vercel framework preset: no Wrangler configuration in the repository.
describe('sites without a Wrangler configuration', () => {
  // Read from vite.config at the pinned commit.
  const site = { preset: 'Vite', directory: 'web', spa: true };
  beforeEach(() => {
    configFile = 'wrangler.none' as typeof configFile;
    manifest = {
      scripts: { build: 'vite build' },
      dependencies: { react: '19.3.0' },
      devDependencies: { vite: '8.3.3' },
    };
    repoFiles = {
      'index.html': '<!doctype html><div id="root"></div>',
      'vite.config.ts':
        "export default defineConfig({ plugins: [react()], build: { outDir: 'web' } })",
    };
  });
  it('inspects the build folder and deploys it with a configuration written during the build', async () => {
    const created = await createProject('landing', { framework: 'react' });
    const inspected = await db.request(
      `/projects/${created.p.id}/repository`,
      { method: 'POST', body: JSON.stringify({ repository: 'alice/sample' }) },
      created.who.cookie,
    );
    expect(await inspected.json()).toMatchObject({
      adapter: 'static-assets',
      buildCommand: 'npm run build',
      site,
      resources: [],
      issues: [],
      ready: true,
    });
    const { response } = await deploy(created, { workerName: 'landing' });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; worker_name: string };
    expect(stored(job.id)).toMatchObject({
      adapter: 'static-assets',
      site_json: JSON.stringify(site),
    });
    await steps(job.id, 4);
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.build_command).toBe('npm run build');
    expect(trigger.deploy_command).toBe(
      deploymentCommand('static-assets', 'landing', site),
    );
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'deployed' });
  });
  it('installs with npm itself when the repository also has another lockfile', async () => {
    repoFiles = { ...repoFiles, 'yarn.lock': '# yarn lockfile v1' };
    const created = await createProject('landing', { framework: 'react' });
    const { response } = await deploy(created, { workerName: 'landing' });
    const job = (await response.json()) as { id: string };
    await steps(job.id, 5);
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.build_command).toBe(
      'npm install --no-audit --no-fund && npm run build',
    );
    // Cloudflare's own install is off before the first build starts.
    const order = calls
      .filter((c) => c.method !== 'GET')
      .map((c) => new URL(c.url).pathname.split('/builds/')[1] ?? '');
    const variables = order.findIndex((p) =>
      p.endsWith('/environment_variables'),
    );
    const build = order.findIndex((p) => /^triggers\/[^/]+\/builds$/.test(p));
    expect(variables).toBeGreaterThan(-1);
    expect(variables).toBeLessThan(build);
    const patch = calls.find((c) => c.url.endsWith('/environment_variables'))!;
    expect(JSON.parse(String(patch.body))).toEqual({
      SKIP_DEPENDENCY_INSTALL: { value: '1', is_secret: false },
    });
  });
  it('turns on branch previews without a previews block to commit', async () => {
    const created = await setup(
      'landing',
      { workerName: 'landing' },
      { framework: 'react' },
    );
    await steps(created.job.id);
    expect(stored(created.job.id).status).toBe('deployed');
    scripts = [{ id: created.job.worker_name, tag: 'c'.repeat(32) }];
    calls.length = 0;
    const enabled = (await (
      await db.request(
        `/projects/${created.p.id}/previews`,
        {
          method: 'POST',
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            confirm: true,
          }),
        },
        created.who.cookie,
      )
    ).json()) as { result: { status: string } };
    expect(enabled.result.status).toBe('active');
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.deploy_command).toBe(
      previewCommand('static-assets', 'landing', site),
    );
    expect(calls.some((c) => c.url.endsWith('/environment_variables'))).toBe(
      false,
    );
  });
  it('turns off Cloudflare’s install for previews too, when Shipcel installs with npm', async () => {
    repoFiles = { ...repoFiles, 'yarn.lock': '# yarn lockfile v1' };
    const created = await setup(
      'landing',
      { workerName: 'landing' },
      { framework: 'react' },
    );
    await steps(created.job.id);
    scripts = [{ id: created.job.worker_name, tag: 'c'.repeat(32) }];
    calls.length = 0;
    await db.request(
      `/projects/${created.p.id}/previews`,
      {
        method: 'POST',
        body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
      },
      created.who.cookie,
    );
    const patch = calls.find((c) => c.url.endsWith('/environment_variables'))!;
    expect(patch.url).toContain(`/builds/triggers/${previewTrigger}/`);
    expect(JSON.parse(String(patch.body))).toEqual({
      SKIP_DEPENDENCY_INSTALL: { value: '1', is_secret: false },
    });
  });
});

// Workers Builds accepts only user API tokens, which OAuth can't create (Cloudflare's docs, 9
// Oct 2026): the owner pastes one, and Shipcel registers it without keeping it.
describe('build tokens', () => {
  const token = 'user-api-token-0123456789abcdef';
  const add = (who: { cookie: string }, body: unknown) =>
    db.request(
      '/connections/cloudflare/build-tokens',
      { method: 'POST', body: JSON.stringify(body) },
      who.cookie,
    );
  it('registers a pasted user token as a build token, and keeps no copy', async () => {
    const who = await db.user(1);
    await db.grant(who, 'cloudflare');
    const response = await add(who, { token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: '10000000-0000-4000-8000-000000000009',
      name: 'Shipcel builds',
    });
    expect(registered).toEqual([
      {
        build_token_name: 'Shipcel builds',
        build_token_secret: token,
        cloudflare_token_id: 'f'.repeat(32),
        // Registered with the owner's Cloudflare connection, not the pasted token.
        authorization: 'Bearer cloudflare-access-secret',
      },
    ]);
    const stored = JSON.stringify(
      db.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map(({ name }) =>
          db.sqlite.prepare(`SELECT * FROM "${name as string}"`).all(),
        ),
    );
    expect(stored).not.toContain(token);
  });
  it('explains a token Cloudflare won’t accept, and refuses inactive ones', async () => {
    const who = await db.user(1);
    await db.grant(who, 'cloudflare');
    const wrong = await add(who, { token: 'not-the-token-0123456789abcdef' });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toContain(
      'user API token',
    );
    userTokenStatus = 'disabled';
    expect((await add(who, { token })).status).toBe(400);
    expect(registered).toEqual([]);
  });
  it('refuses a malformed token before asking Cloudflare', async () => {
    const who = await db.user(1);
    await db.grant(who, 'cloudflare');
    for (const bad of ['short-token', `${token} extra`, `${token}\n${token}`]) {
      const response = await add(who, { token: bad });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Paste the API token exactly as Cloudflare showed it.',
      });
    }
    expect(calls.some((c) => c.url.includes('/tokens/verify'))).toBe(false);
    expect(registered).toEqual([]);
  });
  it('reports a rate limit or an outage as such, not as a refused token', async () => {
    const who = await db.user(1);
    await db.grant(who, 'cloudflare');
    for (const [status, expected] of [
      [429, 429],
      [503, 502],
    ]) {
      verifyFailure = status;
      const response = await add(who, { token });
      expect(response.status).toBe(expected);
      expect(await response.text()).not.toContain('didn’t accept');
    }
    expect(registered).toEqual([]);
  });
  it('needs cloud operations on and a selected Cloudflare account', async () => {
    const who = await db.user(1);
    expect((await add(who, { token })).status).toBe(409);
    await db.grant(who, 'cloudflare');
    db.env.NATIVE_BUILDS_ENABLED = 'false';
    expect((await add(who, { token })).status).toBe(503);
    expect(calls.some((c) => c.url.includes('/tokens/verify'))).toBe(false);
  });
  it('is for workspace owners in the dashboard', async () => {
    const owner = await db.user(1);
    await db.grant(owner, 'cloudflare');
    const developer = await db.user(2);
    db.sqlite
      .prepare(
        'INSERT INTO memberships(workspace_id,user_id,role) VALUES (?,?,?)',
      )
      .run(owner.workspaceId, developer.userId, 'developer');
    db.sqlite
      .prepare('UPDATE sessions SET workspace_id=? WHERE user_id=?')
      .run(owner.workspaceId, developer.userId);
    expect((await add(developer, { token })).status).toBe(403);
    expect(registered).toEqual([]);
  });
});

describe('free workers.dev addresses', () => {
  it('deploys under the chosen app name at its free workers.dev address', async () => {
    const { who, p } = await createProject('my-app');
    const { response } = await deploy({ who, p }, { workerName: 'my-app' });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string; worker_name: string };
    expect(job.worker_name).toBe('my-app');
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'deployed',
      live_url: 'https://my-app.test-account.workers.dev/',
    });
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.deploy_command).toBe(
      'npx wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name my-app',
    );
  });
  it.each(['My-App', '-app', 'app-', 'my_app', 'my app', 'a'.repeat(64)])(
    'refuses the app name %s',
    async (workerName) => {
      const { who, p } = await createProject();
      const { response } = await deploy({ who, p }, { workerName });
      expect(response.status).toBe(400);
      expect(jobCount()).toBe(0);
    },
  );
  it('refuses an app name that another Shipcel deployment uses in the account', async () => {
    const first = await createProject('first-app');
    expect(
      (await deploy(first, { workerName: 'shared-name' })).response.status,
    ).toBe(202);
    const second = await addProject(first.who, 'second-app');
    const { response } = await deploy(second, { workerName: 'shared-name' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('Choose another app name');
  });
  it("refuses an app name that a project's sign-in & realtime service uses in the account", async () => {
    const created = await createProject('first-app');
    db.sqlite
      .prepare(
        "INSERT INTO project_backends(project_id,workspace_id,account_id,worker_name,client_id,status,started_at,updated_at) VALUES ('other-project',?,?,'shop-backend','cc_x','active',1,1)",
      )
      .run(created.who.workspaceId, account);
    const { response } = await deploy(created, { workerName: 'shop-backend' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('Choose another app name');
  });
  it('never adopts an existing Worker that already has the chosen name', async () => {
    const { who, p } = await createProject('my-app');
    const job = (await (
      await deploy({ who, p }, { workerName: 'my-app' })
    ).response.json()) as { id: string };
    scripts = [{ id: 'my-app', tag: 'f'.repeat(32) }];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'needs_attention' });
    expect(stored(job.id).error).toContain('already exists');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('refuses an app name whose created bucket names would exceed R2 limits', async () => {
    config = { ...config, r2_buckets: [{ binding: 'UPLOADS_ARCHIVE' }] };
    const { who, p } = await createProject();
    const { response } = await deploy(
      { who, p },
      { workerName: 'a'.repeat(50), confirmResources: true },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('R2');
  });
  it('needs a workers.dev subdomain before deploying, because Workers Builds cannot register one', async () => {
    subdomain = null;
    const { who, p } = await createProject();
    const { response } = await deploy({ who, p }, { workerName: 'my-app' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('workers.dev subdomain');
    expect(jobCount()).toBe(0);
  });
  it("reads the account's workers.dev subdomain, including when none is registered", async () => {
    const { who } = await createProject();
    const read = async () =>
      (await (
        await db.request('/connections/cloudflare/subdomain', {}, who.cookie)
      ).json()) as { subdomain: string | null };
    expect(await read()).toEqual({ subdomain: 'test-account' });
    subdomain = null;
    expect(await read()).toEqual({ subdomain: null });
    // Recognized by Cloudflare's error code, not only the HTTP status.
    missingSubdomainStatus = 400;
    expect(await read()).toEqual({ subdomain: null });
    missingSubdomainStatus = 200;
    expect(await read()).toEqual({ subdomain: null });
  });
  it('claims a free workers.dev subdomain only for an account without one', async () => {
    const { who } = await createProject();
    const claim = (body: Record<string, unknown>) =>
      db.request(
        '/connections/cloudflare/subdomain',
        { method: 'POST', body: JSON.stringify(body) },
        who.cookie,
      );
    const existing = await claim({ subdomain: 'alice', confirm: true });
    expect(existing.status).toBe(409);
    expect(await existing.text()).toContain('test-account');
    subdomain = null;
    expect((await claim({ subdomain: 'Alice!', confirm: true })).status).toBe(
      400,
    );
    expect((await claim({ subdomain: 'alice' })).status).toBe(400);
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
    const claimed = await claim({ subdomain: 'alice', confirm: true });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({ subdomain: 'alice' });
    const put = calls.filter((c) => c.method === 'PUT');
    expect(put).toHaveLength(1);
    expect(put[0].url).toContain(`/accounts/${account}/workers/subdomain`);
    expect(JSON.parse(String(put[0].body))).toEqual({ subdomain: 'alice' });
  });
});

describe('Worker name uniqueness', () => {
  it('rebuilds deployment_jobs without losing rows, indexes, or the plan-limit trigger', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { readFileSync, readdirSync } = await import('node:fs');
    const sqlite = new DatabaseSync(':memory:');
    const files = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const rebuild = files.indexOf('0009_worker_name_per_account.sql');
    expect(rebuild).toBeGreaterThan(0);
    for (const f of files.slice(0, rebuild))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    const row = {
      id: 'job-1',
      workspace_id: 'w',
      project_id: 'p',
      created_by: 'u',
      cf_grant_id: 'cf',
      gh_grant_id: 'gh',
      account_id: account,
      repository_id: '50',
      repository_name: 'alice/sample',
      branch: 'main',
      commit_sha: sha,
      build_token_uuid: buildToken,
      worker_name: 'cc-kept-0123456789ab',
      build_command: 'npm run build',
      status: 'deployed',
      step: 'finished',
      error: null,
      worker_tag: 'c'.repeat(32),
      repo_connection_uuid: 'r',
      trigger_uuid: 't',
      build_uuid: 'b',
      live_url: 'https://cc-kept-0123456789ab.example.workers.dev/',
      lease_until: 0,
      idempotency_key: 'k',
      created_at: now(),
      updated_at: now(),
      deploy_command: 'npx wrangler@4.156.0 deploy',
      adapter: 'astro',
      resources_json: '[{"type":"d1","binding":"DB"}]',
      observed_resources_json: '[{"type":"d1","binding":"DB","id":"x"}]',
      monitor_started_at: now(),
      recovery_note: 'note',
    };
    sqlite
      .prepare(
        `INSERT INTO deployment_jobs (${Object.keys(row).join(',')}) VALUES (${Object.keys(
          row,
        )
          .map(() => '?')
          .join(',')})`,
      )
      .run(...(Object.values(row) as (string | number | null)[]));
    sqlite.exec(readFileSync(`migrations/${files[rebuild]}`, 'utf8'));
    expect(sqlite.prepare('SELECT * FROM deployment_jobs').get()).toMatchObject(
      row,
    );
    sqlite
      .prepare(
        'INSERT INTO workspace_limits(workspace_id,monthly_pipeline_limit) VALUES (?,1)',
      )
      .run('w');
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO deployment_jobs (${Object.keys(row).join(',')}) VALUES (${Object.keys(
            row,
          )
            .map(() => '?')
            .join(',')})`,
        )
        .run(
          ...(Object.values({
            ...row,
            id: 'job-2',
            idempotency_key: 'k2',
            worker_name: 'other',
          }) as (string | number | null)[]),
        ),
    ).toThrow('CLOUDCEL_PIPELINE_LIMIT');
    // Later migrations (including 0014, which drops the monthly cap) keep the row.
    for (const f of files.slice(rebuild + 1))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    expect(sqlite.prepare('SELECT * FROM deployment_jobs').get()).toMatchObject(
      row,
    );
    sqlite.close();
  });
  it('allows the same Worker name in different Cloudflare accounts but not twice in one', async () => {
    const { job } = await setup();
    const original = stored(job.id);
    const fields = Object.keys(original);
    const insert = (account_id: string) => {
      const row = {
        ...original,
        id: crypto.randomUUID(),
        project_id: crypto.randomUUID(),
        idempotency_key: crypto.randomUUID(),
        status: 'deployed',
        account_id,
      };
      db.sqlite
        .prepare(
          `INSERT INTO deployment_jobs (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
        )
        .run(
          ...fields.map(
            (f) => row[f as keyof typeof row] as string | number | null,
          ),
        );
    };
    expect(() => insert('e'.repeat(32))).not.toThrow();
    expect(() => insert(account)).toThrow('UNIQUE');
  });
});

describe('post-build binding review', () => {
  it('flags a created resource binding that was not in the reviewed plan', async () => {
    const { job } = await setup();
    bindings = [
      { name: 'CACHE', type: 'kv_namespace', namespace_id: 'e'.repeat(32) },
    ];
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      live_url: null,
    });
    expect(stored(job.id).error).toContain('not in the reviewed plan');
    expect(stored(job.id).error).toContain('CACHE');
  });
});

describe('deployment recovery', () => {
  const trigger = '30000000-0000-4000-8000-000000000003',
    build = '40000000-0000-4000-8000-000000000004';
  const recover = (
    who: { cookie: string },
    id: string,
    body: unknown = { confirm: true },
  ) =>
    db.request(
      `/deployments/${id}/reconcile`,
      { method: 'POST', body: JSON.stringify(body) },
      who.cookie,
    );
  const mutations = (method: string, suffix: string) =>
    calls.filter(
      (c) => c.method === method && new URL(c.url).pathname.endsWith(suffix),
    ).length;
  const workerPath = (j: { worker_name: string }) =>
    `/workers/scripts/${j.worker_name}`;
  // Runs `before` steps, then loses the provider response of the next mutation.
  async function interrupted(
    before: number,
    path: (j: { worker_name: string }) => string,
  ) {
    const created = await setup();
    await steps(created.job.id, before);
    interruptPath = path(created.job);
    await steps(created.job.id, 1);
    interruptPath = '';
    expect(stored(created.job.id).status).toBe('needs_attention');
    expect(String(stored(created.job.id).step)).toMatch(/^intent_/);
    return created;
  }
  it('adopts a Worker created before the response was lost and does not recreate it', async () => {
    const { job, who } = await interrupted(1, workerPath);
    scripts = [
      {
        id: job.worker_name,
        tag: 'f'.repeat(32),
        created_on: new Date().toISOString(),
      },
    ];
    expect((await recover(who, job.id)).status).toBe(200);
    expect(stored(job.id)).toMatchObject({
      worker_tag: 'f'.repeat(32),
      error: null,
    });
    expect(stored(job.id).recovery_note).toContain('Found the Worker');
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
    expect(mutations('PUT', workerPath(job))).toBe(1);
  });
  it('creates the Worker when the interrupted request did not', async () => {
    const { job, who } = await interrupted(1, workerPath);
    expect((await recover(who, job.id)).status).toBe(200);
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
    expect(mutations('PUT', workerPath(job))).toBe(2);
  });
  it('refuses to adopt a Worker that existed before the deployment request', async () => {
    const { job, who } = await interrupted(1, workerPath);
    scripts = [
      {
        id: job.worker_name,
        tag: 'f'.repeat(32),
        created_on: new Date((now() - 3600) * 1000).toISOString(),
      },
    ];
    calls.length = 0;
    expect((await recover(who, job.id)).status).toBe(409);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      worker_tag: null,
    });
    expect(stored(job.id).recovery_note).toContain('existed before');
    await scheduledDeployments(db.env);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('repeats the idempotent repository connection request', async () => {
    const { job, who } = await interrupted(
      2,
      () => '/builds/repos/connections',
    );
    expect((await recover(who, job.id)).status).toBe(200);
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
    expect(mutations('PUT', '/builds/repos/connections')).toBe(2);
  });
  it('adopts the build trigger created before the interruption', async () => {
    const { job, who } = await interrupted(3, () => '/builds/triggers');
    triggers = [
      {
        trigger_uuid: '30000000-0000-4000-8000-000000000009',
        trigger_name: 'Another pipeline',
      },
      { trigger_uuid: trigger, trigger_name: `Shipcel ${job.worker_name}` },
    ];
    expect((await recover(who, job.id)).status).toBe(200);
    expect(stored(job.id).trigger_uuid).toBe(trigger);
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
    expect(mutations('POST', '/builds/triggers')).toBe(1);
  });
  it('stops when more than one Shipcel trigger exists for the Worker', async () => {
    const { job, who } = await interrupted(3, () => '/builds/triggers');
    triggers = [trigger, '30000000-0000-4000-8000-000000000009'].map(
      (trigger_uuid) => ({
        trigger_uuid,
        trigger_name: `Shipcel ${job.worker_name}`,
      }),
    );
    calls.length = 0;
    expect((await recover(who, job.id)).status).toBe(409);
    expect(stored(job.id).status).toBe('needs_attention');
    expect(stored(job.id).recovery_note).toContain('more than one');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('adopts the initial build for the reviewed commit', async () => {
    const { job, who } = await interrupted(
      4,
      () => `/builds/triggers/${trigger}/builds`,
    );
    buildList = [
      {
        build_uuid: '40000000-0000-4000-8000-000000000009',
        trigger: { trigger_uuid: trigger },
        build_trigger_metadata: { commit_hash: 'c'.repeat(40) },
      },
      {
        build_uuid: build,
        trigger: { trigger_uuid: trigger },
        build_trigger_metadata: { commit_hash: sha, branch: 'main' },
      },
    ];
    expect((await recover(who, job.id)).status).toBe(200);
    expect(stored(job.id).build_uuid).toBe(build);
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
    expect(mutations('POST', `/builds/triggers/${trigger}/builds`)).toBe(1);
  });
  it('gives an expired build a fresh monitoring window', async () => {
    const { job, who } = await setup();
    outcome = null;
    await steps(job.id, 6);
    db.sqlite
      .prepare('UPDATE deployment_jobs SET created_at=? WHERE id=?')
      .run(now() - 2701, job.id);
    await steps(job.id, 1);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      step: 'building',
    });
    outcome = 'success';
    expect((await recover(who, job.id)).status).toBe(200);
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
  });
  it('repeats the binding review and health check after a failed homepage check', async () => {
    const { job, who } = await setup();
    health = 503;
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      step: 'finished',
    });
    health = 200;
    expect((await recover(who, job.id)).status).toBe(200);
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'deployed',
      live_url: `https://${job.worker_name}.test-account.workers.dev/`,
    });
  });
  it('requires explicit confirmation and leaves healthy deployments alone', async () => {
    const { job, who } = await setup();
    await steps(job.id);
    expect((await recover(who, job.id, {})).status).toBe(400);
    calls.length = 0;
    expect((await recover(who, job.id)).status).toBe(409);
    expect(calls).toEqual([]);
    expect(stored(job.id).status).toBe('deployed');
  });
  it('is invisible to other workspaces', async () => {
    const { job } = await interrupted(1, workerPath);
    const other = await db.user(2);
    expect((await recover(other, job.id)).status).toBe(404);
  });
  it('continues with reconnected grants for the same Cloudflare account', async () => {
    const { job, who } = await interrupted(1, workerPath);
    db.sqlite.prepare("UPDATE provider_grants SET status='revoked'").run();
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    expect((await recover(who, job.id)).status).toBe(200);
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
  });
  it('refuses recovery after switching to another Cloudflare account', async () => {
    const { job, who } = await interrupted(1, workerPath);
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET account_id=? WHERE provider='cloudflare'",
      )
      .run('e'.repeat(32));
    calls.length = 0;
    expect((await recover(who, job.id)).status).toBe(409);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(stored(job.id).status).toBe('needs_attention');
  });
  it('does not resume while another setup is active in the workspace', async () => {
    const { job, who } = await interrupted(1, workerPath);
    const original = stored(job.id);
    const fields = Object.keys(original);
    const row = {
      ...original,
      id: crypto.randomUUID(),
      project_id: 'other-project',
      worker_name: 'other-worker',
      idempotency_key: crypto.randomUUID(),
      status: 'queued',
    };
    db.sqlite
      .prepare(
        `INSERT INTO deployment_jobs (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
      )
      .run(
        ...fields.map(
          (f) => row[f as keyof typeof row] as string | number | null,
        ),
      );
    expect((await recover(who, job.id)).status).toBe(409);
    expect(stored(job.id).status).toBe('needs_attention');
    expect(stored(job.id).recovery_note).toContain('Another pipeline');
  });
});

describe('branch previews (Worker Previews)', () => {
  async function deployed(overrides = {}, options = {}) {
    const created = await setup('test-app', overrides, options);
    await steps(created.job.id);
    expect(stored(created.job.id).status).toBe('deployed');
    // Cloudflare now lists the production Worker with the tag Shipcel recorded.
    scripts = [{ id: created.job.worker_name, tag: 'c'.repeat(32) }];
    calls.length = 0;
    return created;
  }
  const enable = (
    who: { cookie: string },
    projectId: string,
    body: Record<string, unknown> = {},
  ) =>
    db.request(
      `/projects/${projectId}/previews`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          confirm: true,
          ...body,
        }),
      },
      who.cookie,
    );
  type Enabled = {
    status: string;
    result?: {
      status: string;
      snippet?: string;
      issues?: string[];
      resources?: { type: string; binding: string; name: string; id: string }[];
    };
    error?: string;
  };
  const previewRow = (projectId: string) =>
    db.sqlite
      .prepare('SELECT * FROM project_previews WHERE project_id=?')
      .get(projectId) as Record<string, string> | undefined;
  const mutations = () =>
    calls
      .filter((c) => c.method !== 'GET')
      .map(
        (c) =>
          `${c.method} ${new URL(c.url).pathname.split(`/accounts/${account}`)[1]}`,
      );
  // The block Shipcel asked for, as the owner would commit it.
  const commit = (snippet: string) => {
    config = { ...config, ...JSON.parse(`{${snippet}}`) };
  };
  const resources = {
    d1_databases: [{ binding: 'DB' }],
    kv_namespaces: [{ binding: 'CACHE' }],
    r2_buckets: [{ binding: 'FILES' }],
  };
  const productionBindings = [
    { name: 'DB', type: 'd1', id: '50000000-0000-4000-8000-000000000005' },
    { name: 'CACHE', type: 'kv_namespace', namespace_id: 'c'.repeat(32) },
    { name: 'FILES', type: 'r2_bucket', bucket_name: 'test-app-files' },
  ];

  it('asks for a previews block, then adds a preview trigger on the production Worker', async () => {
    const { who, p, job } = await deployed();
    // An owner who turned the workers.dev address off keeps it off.
    scriptRoute = { enabled: false, previews_enabled: false };
    const first = (await (await enable(who, p.id)).json()) as Enabled;
    expect(first.status).toBe('succeeded');
    expect(first.result).toMatchObject({
      status: 'waiting_for_config',
      snippet: '"preview_urls": true,\n"previews": {}',
    });
    expect(first.result!.issues!.join(' ')).toContain('Add a previews block');
    // Nothing is created in Cloudflare until the repository is ready.
    expect(mutations()).toEqual([]);
    expect(previewRow(p.id)).toMatchObject({ status: 'waiting_for_config' });

    commit(first.result!.snippet!);
    const second = (await (await enable(who, p.id)).json()) as Enabled;
    expect(second.result).toMatchObject({
      status: 'active',
      triggerUuid: previewTrigger,
    });
    expect(mutations()).toEqual([
      'POST /builds/triggers',
      `POST /workers/scripts/${job.worker_name}/subdomain`,
    ]);
    const trigger = JSON.parse(
      String(calls.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger).toEqual({
      external_script_id: 'c'.repeat(32),
      repo_connection_uuid: '20000000-0000-4000-8000-000000000002',
      build_token_uuid: buildToken,
      trigger_name: `Shipcel previews ${job.worker_name}`,
      build_command: 'npm run build',
      root_directory: '/',
      path_includes: ['*'],
      path_excludes: [],
      deploy_command: `npx wrangler@4.156.0 preview --worker-name ${job.worker_name}`,
      branch_includes: ['*'],
      branch_excludes: ['main'],
    });
    // Preview addresses on; the production address stays as it was.
    expect(scriptRoute).toEqual({ enabled: false, previews_enabled: true });
    const routeCall = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/subdomain'),
    )!;
    expect(routeCall).toBeTruthy();
    expect(previewRow(p.id)).toMatchObject({
      status: 'active',
      trigger_uuid: previewTrigger,
    });
    expect((await enable(who, p.id)).status).toBe(409);
  });

  it('creates staging copies with consent and turns previews on only when the block binds them', async () => {
    config = { ...config, ...resources };
    bindings = productionBindings;
    const { who, p, job } = await deployed({ confirmResources: true });
    const plan = (await (
      await db.request(`/projects/${p.id}/previews/plan`, {}, who.cookie)
    ).json()) as { resources: { name: string }[]; ready: boolean };
    expect(plan.ready).toBe(true);
    expect(plan.resources.map((r) => r.name)).toEqual([
      `${job.worker_name}-pv-…-db`,
      `${job.worker_name}-pv-…-files`,
      `${job.worker_name}-pv-…-cache`,
    ]);
    expect(mutations()).toEqual([]);
    // Staging copies are new resources: the owner confirms them.
    expect((await enable(who, p.id)).status).toBe(400);
    const waiting = (await (
      await enable(who, p.id, { confirmResources: true })
    ).json()) as Enabled;
    expect(waiting.result!.status).toBe('waiting_for_config');
    const suffix = String(previewRow(p.id)!.resource_suffix);
    expect(suffix).toMatch(/^[a-f0-9]{8}$/);
    expect(d1List.map((d) => d.name)).toEqual([
      `${job.worker_name}-pv-${suffix}-db`,
    ]);
    expect(kvList.map((k) => k.title)).toEqual([
      `${job.worker_name}-pv-${suffix}-cache`,
    ]);
    expect(r2Buckets).toEqual([`${job.worker_name}-pv-${suffix}-files`]);
    expect(waiting.result!.snippet).toContain(d1List[0].uuid);
    expect(waiting.result!.snippet).toContain(kvList[0].id);
    // A block that binds production's database instead is refused.
    config = {
      ...config,
      previews: {
        d1_databases: [
          {
            binding: 'DB',
            database_id: '50000000-0000-4000-8000-000000000005',
          },
        ],
      },
    };
    calls.length = 0;
    const refused = (await (await enable(who, p.id)).json()) as Enabled;
    expect(refused.result!.status).toBe('waiting_for_config');
    expect(refused.result!.issues!.join(' ')).toContain(
      'previews binds DB to a resource Shipcel did not create',
    );
    expect(mutations()).toEqual([]);
    commit(waiting.result!.snippet!);
    const active = (await (await enable(who, p.id)).json()) as Enabled;
    expect(active.result!.status).toBe('active');
    // The staging copies were made once.
    expect(mutations()).toEqual([
      'POST /builds/triggers',
      `POST /workers/scripts/${job.worker_name}/subdomain`,
    ]);
  });

  it('adopts what an interrupted attempt created instead of making duplicates', async () => {
    config = { ...config, d1_databases: [{ binding: 'DB' }] };
    bindings = [productionBindings[0]];
    const { who, p } = await deployed({ confirmResources: true });
    lostResponse = '/d1/database';
    const lost = await enable(who, p.id, { confirmResources: true });
    expect(lost.status).toBe(502);
    expect(previewRow(p.id)).toMatchObject({
      status: 'needs_attention',
      resources_json: '[]',
    });
    lostResponse = '';
    // Nothing was recorded, so the retry asks for consent again; the database is adopted.
    expect((await enable(who, p.id)).status).toBe(400);
    const waiting = (await (
      await enable(who, p.id, { confirmResources: true })
    ).json()) as Enabled;
    expect(waiting.result!.status).toBe('waiting_for_config');
    expect(d1List).toHaveLength(1);
    expect(waiting.result!.resources![0].id).toBe(d1List[0].uuid);
    commit(waiting.result!.snippet!);
    lostResponse = '/builds/triggers';
    expect((await enable(who, p.id)).status).toBe(502);
    lostResponse = '';
    calls.length = 0;
    const active = (await (await enable(who, p.id)).json()) as Enabled;
    expect(active.result!.status).toBe('active');
    expect(triggers).toHaveLength(1);
    expect(mutations()).toEqual([
      `PATCH /builds/triggers/${previewTrigger}`,
      expect.stringMatching(/subdomain$/),
    ]);
  });

  it('never adopts a staging-looking database or namespace without this project’s suffix', async () => {
    config = {
      ...config,
      d1_databases: [{ binding: 'DB' }],
      kv_namespaces: [{ binding: 'CACHE' }],
    };
    bindings = productionBindings.slice(0, 2);
    const { who, p, job } = await deployed({ confirmResources: true });
    d1List.push({
      uuid: '70000000-0000-4000-8000-000000000001',
      name: `${job.worker_name}-pv-00000000-db`,
    });
    kvList.push({
      id: 'f'.repeat(32),
      title: `${job.worker_name}-pv-00000000-cache`,
    });
    const waiting = (await (
      await enable(who, p.id, { confirmResources: true })
    ).json()) as Enabled;
    expect(waiting.result!.resources!.map((r) => r.id)).not.toContain(
      '70000000-0000-4000-8000-000000000001',
    );
    expect(waiting.result!.resources!.map((r) => r.id)).not.toContain(
      'f'.repeat(32),
    );
    expect(d1List).toHaveLength(2);
    expect(kvList).toHaveLength(2);
  });

  it('lists Previews with their addresses, commits and pull requests', async () => {
    const { who, p, job } = await deployed();
    config = { ...config, preview_urls: true, previews: {} };
    await enable(who, p.id);
    previewList = [
      {
        id: 'preview-1',
        name: 'feature/login',
        slug: 'feature-login',
        urls: [
          `https://feature-login-${job.worker_name}.test-account.workers.dev`,
        ],
        deployed_on: '2026-10-08T10:00:00Z',
      },
      { id: 'preview-2', name: 'old', urls: ['javascript:alert(1)'] },
    ];
    previewDeployments = {
      'preview-1': {
        id: 'deployment-1',
        number: 3,
        urls: [`https://1a2b3c4d-${job.worker_name}.test-account.workers.dev`],
        created_on: '2026-10-08T10:00:00Z',
        annotations: {
          'workers/commit_sha': 'd'.repeat(40),
          'workers/pull_request_url': 'https://github.com/alice/sample/pull/7',
        },
      },
    };
    buildList = [
      {
        build_uuid: '40000000-0000-4000-8000-000000000008',
        build_outcome: 'fail',
        trigger: { trigger_uuid: previewTrigger },
        build_trigger_metadata: { branch: 'feature/login' },
        created_at: '2026-10-08T09:00:00Z',
      },
      {
        build_uuid: '40000000-0000-4000-8000-000000000009',
        build_outcome: 'success',
        trigger: { trigger_uuid: '30000000-0000-4000-8000-000000000003' },
        build_trigger_metadata: { branch: 'main' },
      },
    ];
    const list = (await (
      await db.request(`/projects/${p.id}/previews`, {}, who.cookie)
    ).json()) as Record<string, unknown>;
    expect(list).toMatchObject({
      status: 'active',
      branch: 'main',
      previewsError: null,
      previews: [
        {
          id: 'preview-1',
          name: 'feature/login',
          urls: [
            `https://feature-login-${job.worker_name}.test-account.workers.dev`,
          ],
          latest: {
            number: 3,
            commit: 'd'.repeat(40),
            pullRequest: 'https://github.com/alice/sample/pull/7',
          },
        },
        // Only plain https addresses are passed on.
        { id: 'preview-2', urls: [], latest: null },
      ],
      builds: [
        {
          id: '40000000-0000-4000-8000-000000000008',
          branch: 'feature/login',
          outcome: 'fail',
        },
      ],
    });
  });

  it('deletes a Preview, and turns previews off by deleting only the preview trigger', async () => {
    config = { ...config, d1_databases: [{ binding: 'DB' }] };
    bindings = [productionBindings[0]];
    const { who, p, job } = await deployed({ confirmResources: true });
    const waiting = (await (
      await enable(who, p.id, { confirmResources: true })
    ).json()) as Enabled;
    commit(waiting.result!.snippet!);
    await enable(who, p.id);
    previewList = [{ id: 'preview-1', name: 'feature/login', urls: [] }];
    calls.length = 0;
    const deleted = await db.request(
      `/projects/${p.id}/previews/preview-1`,
      {
        method: 'DELETE',
        body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
      },
      who.cookie,
    );
    expect(deleted.status).toBe(200);
    expect(mutations()).toEqual([
      `DELETE /workers/workers/${job.worker_name}/previews/preview-1`,
    ]);
    calls.length = 0;
    const off = await db.request(
      `/projects/${p.id}/previews`,
      {
        method: 'DELETE',
        body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
      },
      who.cookie,
    );
    expect(off.status).toBe(200);
    expect(mutations()).toEqual([`DELETE /builds/triggers/${previewTrigger}`]);
    expect(previewRow(p.id)).toMatchObject({
      status: 'disabled',
      trigger_uuid: null,
    });
    // Turning previews back on reuses the staging copies.
    calls.length = 0;
    const again = (await (await enable(who, p.id)).json()) as Enabled;
    expect(again.result!.status).toBe('active');
    expect(d1List).toHaveLength(1);
    expect(mutations()).toEqual([
      'POST /builds/triggers',
      // The route already has preview addresses on.
    ]);
  });

  it('waits for a deployed production pipeline', async () => {
    // A failed initial build has a trigger but no healthy production deployment.
    const { who, p, job } = await setup();
    outcome = 'fail';
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'failed' });
    expect(stored(job.id).trigger_uuid).toBeTruthy();
    scripts = [{ id: job.worker_name, tag: 'c'.repeat(32) }];
    expect((await enable(who, p.id)).status).toBe(409);
  });

  it('keeps Free-only previews from creating R2 buckets added after production', async () => {
    config = { ...config, d1_databases: [{ binding: 'DB' }] };
    bindings = [productionBindings[0]];
    const { who, p } = await deployed(
      { confirmResources: true },
      { freeOnly: true },
    );
    config = { ...config, r2_buckets: [{ binding: 'FILES' }] };
    const refused = await enable(who, p.id, { confirmResources: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'Free-only',
    );
    expect(mutations()).toEqual([]);
  });

  it('keeps previews off for Next.js because the self-reference would reach production', async () => {
    manifest = {
      scripts: { build: 'next build' },
      dependencies: { next: '16.4.0', '@opennextjs/cloudflare': '^1.20.9' },
    };
    config = {
      name: 'shipcel-next',
      main: '.open-next/worker.js',
      compatibility_date: '2026-10-06',
      assets: { directory: '.open-next/assets', binding: 'ASSETS' },
      services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shipcel-next' }],
    };
    openNext = 'export default {};';
    const { who, p } = await deployed({}, { framework: 'nextjs' });
    const response = await enable(who, p.id);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('WORKER_SELF_REFERENCE');
  });

  it('retires second-Worker preview pipelines when migrating', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { readFileSync, readdirSync } = await import('node:fs');
    const sqlite = new DatabaseSync(':memory:');
    const files = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const change = files.indexOf('0020_worker_previews.sql');
    expect(change).toBeGreaterThan(0);
    for (const f of files.slice(0, change))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    const insert = sqlite.prepare(
      "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,idempotency_key,created_at,updated_at,environment,lease_until) VALUES (?,'w','p','u','cf','gh','acct','1','a/b','main',?,'t',?,'',?,?,1,1,?,99)",
    );
    insert.run('prod', 'b'.repeat(40), 'app', 'deployed', 'k1', 'production');
    insert.run('old', 'b'.repeat(40), 'app-pv', 'building', 'k2', 'preview');
    for (const f of files.slice(change))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    expect(
      sqlite
        .prepare(
          'SELECT id, status, lease_until FROM deployment_jobs ORDER BY id',
        )
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([
      { id: 'old', status: 'disabled', lease_until: 0 },
      { id: 'prod', status: 'deployed', lease_until: 99 },
    ]);
    sqlite.close();
  });

  it('marks preview builds in Manage and gives them no production health check', async () => {
    const { who, p } = await deployed();
    config = { ...config, preview_urls: true, previews: {} };
    await enable(who, p.id);
    buildList = [
      {
        build_uuid: '40000000-0000-4000-8000-000000000011',
        build_outcome: 'success',
        trigger: { trigger_uuid: previewTrigger },
        build_trigger_metadata: { branch: 'feature/login' },
        created_at: new Date().toISOString(),
      },
      {
        build_uuid: '40000000-0000-4000-8000-000000000012',
        build_outcome: 'success',
        trigger: { trigger_uuid: '30000000-0000-4000-8000-000000000003' },
        build_trigger_metadata: { branch: 'main' },
        created_at: new Date().toISOString(),
      },
    ];
    const builds = (await (
      await db.request(`/projects/${p.id}/builds`, {}, who.cookie)
    ).json()) as { builds: { branch: string; preview: boolean }[] };
    expect(builds.builds.map((b) => [b.branch, b.preview])).toEqual([
      ['feature/login', true],
      ['main', false],
    ]);
    expect(
      db.sqlite
        .prepare('SELECT build_uuid FROM observed_builds')
        .all()
        .map((r) => (r as { build_uuid: string }).build_uuid),
    ).toEqual(['40000000-0000-4000-8000-000000000012']);
  });
});

describe('deploy notifications from the pipeline', () => {
  const queued = () =>
    (
      db.sqlite
        .prepare('SELECT event, payload_json FROM webhook_deliveries')
        .all() as { event: string; payload_json: string }[]
    ).map((d) => ({ event: d.event, text: JSON.parse(d.payload_json).text }));
  async function watched() {
    const created = await setup();
    const response = await db.request(
      `/projects/${created.p.id}/notifications`,
      {
        method: 'PUT',
        body: JSON.stringify({
          url: 'https://hooks.example.com/services/x',
          events: ['deployment.ready', 'deployment.failed'],
        }),
      },
      created.who.cookie,
    );
    expect(response.status).toBe(200);
    return created;
  }
  it('tells the webhook when the app is live', async () => {
    const { job } = await watched();
    await steps(job.id);
    expect(stored(job.id).status).toBe('deployed');
    expect(queued()).toEqual([
      {
        event: 'deployment.ready',
        text: expect.stringMatching(
          /^test-app is live at https:\/\/.+\.test-account\.workers\.dev\//,
        ),
      },
    ]);
  });
  it('tells the webhook when the first build fails', async () => {
    const { job } = await watched();
    outcome = 'fail';
    await steps(job.id);
    expect(stored(job.id).status).toBe('failed');
    expect(queued()).toEqual([
      {
        event: 'deployment.failed',
        text: 'The first build of test-app failed. Open its build logs in Cloudflare.',
      },
    ]);
  });
});

describe('native deployment lifecycle', () => {
  it('keeps generated Worker names within 63 characters for the longest valid project name', async () => {
    const { job } = await setup('a'.repeat(48));
    expect(job.worker_name.length).toBe(63);
    expect(job.worker_name).toMatch(/^cc-[a-z0-9-]+$/);
  });

  it('creates one pipeline, pins the first build, and publishes a URL only after an HTTP health check', async () => {
    const { job, who, p, input } = await setup();
    expect(stored(job.id).live_url).toBeNull();
    const replay = await db.request(
      `/projects/${p.id}/deployments`,
      { method: 'POST', body: JSON.stringify(input) },
      who.cookie,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: job.id });
    await steps(job.id, 6);
    expect(stored(job.id)).toMatchObject({
      step: 'health_check',
      status: 'building',
      live_url: null,
    });
    await steps(job.id, 1);
    expect(stored(job.id)).toMatchObject({
      step: 'finished',
      status: 'deployed',
      live_url: `https://${job.worker_name}.test-account.workers.dev/`,
    });
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(4);
    const trigger = JSON.parse(
      String(writes.find((c) => c.url.endsWith('/builds/triggers'))!.body),
    );
    expect(trigger.branch_includes).toEqual(['main']);
    expect(trigger.branch_excludes).toEqual([]);
    expect(trigger.build_token_uuid).toBe(buildToken);
    expect(trigger.deploy_command).toBe(
      `npx wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name ${job.worker_name}`,
    );
    expect(JSON.parse(String(writes.at(-1)!.body))).toEqual({
      branch: 'main',
      commit_hash: sha,
    });
    await steps(job.id);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(4);
    const publicRecord = await (
      await db.request(`/projects/${p.id}/deployments`, {}, who.cookie)
    ).text();
    expect(publicRecord).not.toMatch(
      /access-secret|encrypted_tokens|cf_grant_id|gh_grant_id|build_token_uuid/,
    );
  });
  it('does not let a successful provider build override a failed live health check', async () => {
    const { job } = await setup();
    health = 503;
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      live_url: null,
    });
    expect(stored(job.id).error).toContain('HTTP 2xx');
  });
  it('records a failed build without publishing a URL', async () => {
    const { job } = await setup();
    outcome = 'fail';
    await steps(job.id);
    expect(stored(job.id)).toMatchObject({ status: 'failed', live_url: null });
    expect(calls.some((c) => c.url.includes('.workers.dev'))).toBe(false);
  });
  it('stops expired monitoring so queued jobs cannot hold a workspace forever', async () => {
    const { job } = await setup();
    db.sqlite
      .prepare('UPDATE deployment_jobs SET created_at=? WHERE id=?')
      .run(now() - 2701, job.id);
    calls.length = 0;
    await steps(job.id, 1);
    expect(stored(job.id).status).toBe('needs_attention');
    expect(calls).toHaveLength(0);
  });
  it.each(['membership', 'repository', 'grant', 'project'])(
    'rechecks %s authorization after enqueue',
    async (change) => {
      const { job, who, p } = await setup();
      calls.length = 0;
      if (change === 'membership')
        db.sqlite
          .prepare('DELETE FROM memberships WHERE user_id=?')
          .run(who.userId);
      if (change === 'repository') repoAccess = false;
      if (change === 'grant')
        await db.request(
          '/connections/cloudflare',
          { method: 'DELETE' },
          who.cookie,
        );
      if (change === 'project')
        await db.request(`/projects/${p.id}`, { method: 'DELETE' }, who.cookie);
      await steps(job.id);
      expect(stored(job.id).status).toBe('needs_attention');
      expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    },
  );
  it('does not retry an ambiguous provider mutation after a timeout', async () => {
    const { job } = await setup();
    await steps(job.id, 1);
    interruptPath = `/workers/scripts/${job.worker_name}`;
    await steps(job.id, 1);
    expect(stored(job.id)).toMatchObject({
      status: 'needs_attention',
      step: 'intent_create_worker',
      live_url: null,
    });
    interruptPath = '';
    await steps(job.id, 3);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
  it('recognizes a process crash between mutation and recording its provider ID', async () => {
    const { job } = await setup();
    db.sqlite
      .prepare(
        "UPDATE deployment_jobs SET step='intent_create_worker' WHERE id=?",
      )
      .run(job.id);
    calls.length = 0;
    await steps(job.id, 1);
    expect(stored(job.id).status).toBe('needs_attention');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
  it('leases jobs so competing refreshes do not duplicate mutations', async () => {
    const { job } = await setup();
    await steps(job.id, 1);
    await Promise.all([
      advanceDeployment(db.env, job.id),
      advanceDeployment(db.env, job.id),
    ]);
    expect(
      calls.filter(
        (c) => c.method === 'PUT' && c.url.includes('/workers/scripts/'),
      ),
    ).toHaveLength(1);
    expect(stored(job.id).step).toBe('connect_repository');
  });
  it('enforces one active pipeline per workspace, without a monthly setup cap, at the database boundary', async () => {
    const { job, who } = await setup();
    const original = stored(job.id);
    function insert(n: number) {
      const fields = Object.keys(original);
      const row = {
        ...original,
        id: crypto.randomUUID(),
        project_id: `other-${n}`,
        worker_name: `other-${n}`,
        idempotency_key: crypto.randomUUID(),
        status: 'queued',
      };
      db.sqlite
        .prepare(
          `INSERT INTO deployment_jobs (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
        )
        .run(
          ...fields.map(
            (f) => row[f as keyof typeof row] as string | number | null,
          ),
        );
    }
    expect(() => insert(1)).toThrow('UNIQUE');
    db.sqlite.prepare("UPDATE deployment_jobs SET status='failed'").run();
    // A legacy per-workspace monthly limit no longer applies: Cloudflare's build minutes do.
    db.sqlite
      .prepare(
        'INSERT INTO workspace_limits(workspace_id,monthly_pipeline_limit) VALUES (?,1)',
      )
      .run(who.workspaceId);
    for (let n = 2; n <= 13; n++) {
      insert(n);
      db.sqlite.prepare("UPDATE deployment_jobs SET status='failed'").run();
    }
    expect(jobCount()).toBe(13);
  });
  it('scheduled processing progresses active jobs and expires session metadata', async () => {
    const { job } = await setup();
    db.sqlite.prepare('UPDATE sessions SET expires_at=?').run(now() - 1);
    await scheduledDeployments(db.env);
    expect(stored(job.id).step).toBe('create_worker');
    expect(db.sqlite.prepare('SELECT * FROM sessions').all()).toEqual([]);
  });
});

describe('provider transport', () => {
  it('does not disclose provider error bodies or follow redirects with credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('private-provider-token', { status: 403 }),
      ),
    );
    await expect(providerJSON('https://api.github.com/user')).rejects.toThrow(
      'denied access',
    );
    // The Workers runtime only accepts "follow" or "manual" (tests/runtime.test.ts).
    expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe('manual');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://elsewhere.example/' },
          }),
      ),
    );
    await expect(providerJSON('https://api.github.com/user')).rejects.toThrow(
      'rejected this operation',
    );
  });
  it('says why access was denied, from the provider’s own structured error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 10000, message: 'Authentication error\u0007' }],
          },
          { status: 403 },
        ),
      ),
    );
    const denied = providerJSON(
      'https://api.cloudflare.com/client/v4/accounts/a/workers/scripts/x/assets-upload-session?secret=1',
      { method: 'POST' },
    );
    await expect(denied).rejects.toThrow(
      'The provider denied access (Authentication error). Check the app installation and granted permissions.',
    );
    // The log names the request without its query string.
    expect(warn).toHaveBeenCalledWith(
      'Provider denied POST /client/v4/accounts/a/workers/scripts/x/assets-upload-session: Authentication error',
    );
    warn.mockRestore();
  });
  it('bounds streamed provider responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(2_000_001))),
    );
    await expect(providerJSON('https://api.github.com/user')).rejects.toThrow(
      'exceeded',
    );
  });
});

describe('Cloudflare’s GitHub app', () => {
  it('explains a repository connection Cloudflare refused, with its reason', async () => {
    connectionRefusal = 'The GitHub repository is not accessible';
    const created = await createProject();
    const { response } = await deploy(created);
    const job = (await response.json()) as { id: string };
    await steps(job.id, 3);
    expect(stored(job.id)).toMatchObject({ status: 'needs_attention' });
    const error = String(stored(job.id).error);
    expect(error).toContain(
      'Cloudflare reported: The GitHub repository is not accessible',
    );
    expect(error).toContain('alice/sample');
    expect(error).toContain('Connections');
  });
  // Cloudflare links its GitHub app through its dashboard; repository access is changed on GitHub.
  const connectUrl = `https://dash.cloudflare.com/${account}/workers-and-pages/create`;
  const personal = 'https://github.com/settings/installations',
    organization =
      'https://github.com/organizations/acme/settings/installations';
  const site = {
    ...repo,
    id: 51,
    name: 'site',
    full_name: 'acme/site',
    default_branch: 'release/v2',
    owner: { id: 2, login: 'acme', type: 'Organization' },
  };
  const access = (who: { cookie: string }, query = '') =>
    db.request(`/connections/cloudflare/github${query}`, {}, who.cookie);
  async function owner() {
    const who = await db.user(1);
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    return who;
  }
  it('says, for each GitHub account, whether Cloudflare can read its repositories', async () => {
    installations = [
      { id: 7, account: { id: 1, login: 'alice', type: 'User' } },
      { id: 8, account: { id: 2, login: 'acme', type: 'Organization' } },
    ];
    installationRepos = { 7: [repo], 8: [site] };
    cloudflareReads = new Set([50]);
    const response = await access(await owner());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connectUrl,
      accounts: [
        {
          login: 'alice',
          repository: 'alice/sample',
          readable: true,
          checked: [{ repository: 'alice/sample', readable: true }],
          repositoriesUrl: personal,
        },
        {
          login: 'acme',
          repository: 'acme/site',
          readable: false,
          checked: [{ repository: 'acme/site', readable: false }],
          repositoriesUrl: organization,
        },
      ],
    });
    // Asked through the Builds API, as Cloudflare documents it, with the Cloudflare connection.
    expect(
      calls
        .filter((c) => c.url.includes('/config_autofill'))
        .map((c) => c.url.replace('https://api.cloudflare.com/client/v4', '')),
    ).toEqual([
      `/accounts/${account}/builds/repos/github/1/50/config_autofill`,
      `/accounts/${account}/builds/repos/github/2/51/config_autofill`,
    ]);
    expect(autofillAuth).toEqual([
      'Bearer cloudflare-access-secret',
      'Bearer cloudflare-access-secret',
    ]);
  });
  it('checks the repository a project deploys', async () => {
    cloudflareReads = new Set([50]);
    const who = await owner();
    expect(
      await (await access(who, '?repository=alice/sample')).json(),
    ).toEqual({
      connectUrl,
      accounts: [
        {
          login: 'alice',
          repository: 'alice/sample',
          readable: true,
          checked: [{ repository: 'alice/sample', readable: true }],
          repositoriesUrl: personal,
        },
      ],
    });
    expect((await access(who, '?repository=alice/missing')).status).toBe(404);
    expect((await access(who, '?repository=../etc')).status).toBe(400);
  });
  it('has nothing to check for an account without repositories', async () => {
    installationRepos = { 7: [] };
    expect(await (await access(await owner())).json()).toEqual({
      connectUrl,
      accounts: [
        {
          login: 'alice',
          repository: null,
          readable: null,
          checked: [],
          repositoriesUrl: personal,
        },
      ],
    });
  });
  it('counts an account as connected when Cloudflare reads any of its repositories, and lists them', async () => {
    const second = { ...repo, id: 52, name: 'blog', full_name: 'alice/blog' };
    installationRepos = { 7: [repo, second] };
    cloudflareReads = new Set([52]);
    const answer = (await (await access(await owner())).json()) as {
      accounts: unknown[];
    };
    expect(answer.accounts).toEqual([
      {
        login: 'alice',
        repository: 'alice/sample',
        readable: true,
        checked: [
          { repository: 'alice/sample', readable: false },
          { repository: 'alice/blog', readable: true },
        ],
        repositoriesUrl: personal,
      },
    ]);
    // Five at most, from GitHub's first page.
    expect(calls.map((c) => c.url)).toContain(
      'https://api.github.com/user/installations/7/repositories?per_page=5',
    );
  });
  it('passes on Cloudflare’s own reason when it refuses for another reason', async () => {
    autofillStatus = 400;
    const response = await access(await owner());
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Cloudflare reported: Invalid repository id',
    );
  });
  it('reports a Cloudflare outage as an error, not as a missing app', async () => {
    autofillStatus = 503;
    const response = await access(await owner());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('readable');
  });
  it('needs GitHub and a selected Cloudflare account', async () => {
    const who = await db.user(1);
    expect((await access(who)).status).toBe(409);
    await db.grant(who, 'cloudflare');
    expect((await access(who)).status).toBe(409);
    expect(autofillAuth).toEqual([]);
  });
});
