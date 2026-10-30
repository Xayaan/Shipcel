import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { assetHash, toBase64 } from '../shared/assets';
import { scheduledBuildScans } from '../worker/health';
import app from '../worker/index';
import { account, cloudflareUploads } from './helpers/cloudflare-uploads';

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let fx: ReturnType<typeof cloudflareUploads>;
// Cloudflare's state in these fixtures (see tests/helpers/cloudflare-uploads.ts).
let stored: typeof fx.state.stored;
let workers: typeof fx.state.workers;
let calls: typeof fx.state.calls;

const encode = (text: string) => new TextEncoder().encode(text);
function file(path: string, text: string) {
  const content = toBase64(encode(text));
  return {
    path,
    content,
    hash: assetHash(content, path),
    size: encode(text).length,
  };
}
const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = who.cookie,
) =>
  db.request(
    path,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    cookie,
  );
const confirm = (extra: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  confirm: true,
  ...extra,
});

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  fx = cloudflareUploads();
  ({ stored, workers, calls } = fx.state);
  vi.stubGlobal('fetch', vi.fn(fx.handler));
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

async function project(name = 'my-site', extra: Record<string, unknown> = {}) {
  const response = await request('/projects', 'POST', {
    ...projectInput(name),
    framework: 'static',
    ...extra,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
async function upload(projectId: string, files: ReturnType<typeof file>[]) {
  const created = await request(`/projects/${projectId}/uploads`, 'POST', {
    files: files.map(({ path, hash, size }) => ({ path, hash, size })),
  });
  const body = (await created.json()) as {
    uploadId: string;
    missing: string[];
    workerName: string;
    error?: string;
  };
  return { status: created.status, body };
}
async function send(
  projectId: string,
  uploadId: string,
  files: ReturnType<typeof file>[],
) {
  return request(`/projects/${projectId}/uploads/${uploadId}/files`, 'POST', {
    files: files.map(({ hash, content }) => ({ hash, content })),
  });
}
async function deploy(
  projectId: string,
  uploadId: string,
  extra: Record<string, unknown> = {},
) {
  const response = await request(
    `/projects/${projectId}/uploads/${uploadId}/deploy`,
    'POST',
    confirm(extra),
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      status: string;
      error?: string;
      result: {
        workerName: string;
        versionId: string;
        previewUrl: string | null;
        url: string | null;
        published: boolean;
      };
    },
  };
}
const site = () => [
  file('/index.html', '<h1>Hello</h1>'),
  file('/assets/app.js', 'console.log(1)'),
];

describe('direct uploads', () => {
  it('deploys a dropped folder privately to a preview address, then publishes it', async () => {
    const id = await project();
    const files = site();
    const created = await upload(id, files);
    expect(created.status).toBe(201);
    expect(created.body.workerName).toBe('my-site');
    expect(created.body.missing.sort()).toEqual(
      files.map((f) => f.hash).sort(),
    );
    const sent = await send(id, created.body.uploadId, files);
    expect(await sent.json()).toEqual({ received: 2, missing: [] });
    // Each file is stored under its hash with the type Cloudflare will serve it with.
    expect(stored.get(files[0].hash)).toEqual({
      content: files[0].content,
      type: 'text/html; charset=utf-8',
    });
    expect(stored.get(files[1].hash)!.type).toBe(
      'text/javascript; charset=utf-8',
    );
    const first = await deploy(id, created.body.uploadId);
    expect(first.status).toBe(200);
    expect(first.body.result).toEqual({
      workerName: 'my-site',
      versionId: '00000001-0000-4000-8000-000000000000',
      previewUrl: 'https://00000001-my-site.test-account.workers.dev',
      url: null,
      published: false,
      preview: false,
      productionUrl: null,
    });
    // Files only: no code runs, and the app stays off its public address.
    expect(workers.get('my-site')!.metadata).toEqual({
      assets: {
        jwt: 'completion-jwt',
        config: {
          html_handling: 'auto-trailing-slash',
          not_found_handling: 'none',
        },
      },
      compatibility_date: '2026-10-07',
      annotations: { 'workers/message': 'Direct upload from Shipcel' },
      // Workers Logs on, as for any Worker made in Cloudflare's dashboard.
      observability: { enabled: true },
    });
    expect(fx.state.route).toEqual({ enabled: false, previews_enabled: true });
    const jobs = (await (
      await request(`/projects/${id}/deployments`)
    ).json()) as {
      adapter: string;
      status: string;
      live_url: string | null;
    }[];
    expect(jobs).toMatchObject([
      { adapter: 'direct-upload', status: 'deployed', live_url: null },
    ]);
    const published = await request(
      `/projects/${id}/publish`,
      'POST',
      confirm(),
    );
    expect(published.status).toBe(200);
    expect(fx.state.route).toEqual({ enabled: true, previews_enabled: true });
    expect(
      ((await published.json()) as { result: { url: string } }).result.url,
    ).toBe('https://my-site.test-account.workers.dev/');
    // A later upload sends only what changed and stays published.
    const changed = [files[0], file('/assets/app.js', 'console.log(2)')];
    const second = await upload(id, changed);
    expect(second.body.missing).toEqual([changed[1].hash]);
    await send(id, second.body.uploadId, [changed[1]]);
    const again = await deploy(id, second.body.uploadId);
    expect(again.body.result).toMatchObject({
      published: true,
      url: 'https://my-site.test-account.workers.dev/',
      previewUrl: 'https://00000002-my-site.test-account.workers.dev',
    });
    const history = (await (
      await request(`/projects/${id}/uploads`)
    ).json()) as {
      status: string;
      published: boolean;
    }[];
    expect(history.map((h) => [h.status, h.published])).toEqual([
      ['deployed', true],
      ['deployed', false],
    ]);
    // Upload tokens are cleared once used, and none is ever stored in plain text.
    const rows = JSON.stringify(
      db.sqlite.prepare('SELECT * FROM direct_uploads').all(),
    );
    expect(rows).not.toContain('upload-jwt');
    expect(rows).not.toContain('completion-jwt');
  });

  it('runs an optional Worker module, single-page fallbacks, redirects and headers', async () => {
    const id = await project();
    const files = site();
    const created = await upload(id, files);
    await send(id, created.body.uploadId, files);
    const module = 'export default { fetch: (r, env) => env.ASSETS.fetch(r) };';
    const deployed = await deploy(id, created.body.uploadId, {
      spa: true,
      workerModule: toBase64(encode(module)),
      redirects: '/old /new 301',
      headers: '/*\n  X-Frame-Options: DENY',
    });
    expect(deployed.status).toBe(200);
    const metadata = workers.get('my-site')!.metadata;
    expect(metadata).toMatchObject({
      main_module: '_worker.js',
      bindings: [{ type: 'assets', name: 'ASSETS' }],
      assets: {
        config: {
          not_found_handling: 'single-page-application',
          _redirects: '/old /new 301',
          _headers: '/*\n  X-Frame-Options: DENY',
        },
      },
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(
      await ((put.body as FormData).get('_worker.js') as Blob).text(),
    ).toBe(module);
    // A 404 page wins over the single-page fallback.
    const withNotFound = [...site(), file('/404.html', 'Not here')];
    const next = await upload(id, withNotFound);
    await send(
      id,
      next.body.uploadId,
      withNotFound.filter((f) => next.body.missing.includes(f.hash)),
    );
    await deploy(id, next.body.uploadId, { spa: true });
    expect(workers.get('my-site')!.metadata).toMatchObject({
      assets: { config: { not_found_handling: '404-page' } },
    });
    expect(workers.get('my-site')!.metadata.main_module).toBeUndefined();
  });

  it('refuses unsafe paths, files that do not match, and incomplete uploads', async () => {
    const id = await project();
    for (const path of [
      '../etc/passwd',
      '/a//b',
      '/.env',
      '/x/../y',
      'index.html',
      '/a\\b',
    ])
      expect((await upload(id, [file(path, 'x')])).status, path).toBe(400);
    for (const path of ['/_worker.js', '/_redirects', '/_headers'])
      expect((await upload(id, [file(path, 'x')])).status, path).toBe(400);
    const twice = file('/index.html', 'a');
    expect((await upload(id, [twice, twice])).status).toBe(400);
    const files = site();
    const created = await upload(id, files);
    expect((await deploy(id, created.body.uploadId)).status).toBe(409);
    const forged = { ...files[0], content: toBase64(encode('<h1>Other</h1>')) };
    expect((await send(id, created.body.uploadId, [forged])).status).toBe(400);
    expect(
      (await send(id, created.body.uploadId, [{ ...files[0], content: '%%%' }]))
        .status,
    ).toBe(400);
    const unknown = file('/other.html', 'other');
    expect((await send(id, created.body.uploadId, [unknown])).status).toBe(400);
    expect(stored.size).toBe(0);
    db.sqlite.prepare('UPDATE direct_uploads SET expires_at=1').run();
    expect((await send(id, created.body.uploadId, files)).status).toBe(410);
    const other = await db.user(2);
    expect(
      (
        await request(
          `/projects/${id}/uploads/${created.body.uploadId}/files`,
          'POST',
          { files: [] },
          other.cookie,
        )
      ).status,
    ).toBe(404);
  });

  it('never adopts an existing Worker, and keeps Git and direct uploads apart', async () => {
    workers.set('taken-site', { tag: 'd'.repeat(32), metadata: {} });
    const taken = await project('taken-site');
    const refused = await upload(taken, site());
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('already exists');
    expect(calls.some((c) => c.path.endsWith('/assets-upload-session'))).toBe(
      false,
    );
    // A project that deploys from Git can't take direct uploads…
    const git = await project('git-site', { framework: 'worker' });
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,idempotency_key,created_at,updated_at) VALUES ('git-job',?,?,?,'cf','gh',?,'1','alice/site','main',?,?,'git-site','','deployed','git-key',1,1)",
      )
      .run(
        who.workspaceId,
        git,
        who.userId,
        account,
        'b'.repeat(40),
        crypto.randomUUID(),
      );
    const fromGit = await upload(git, site());
    expect(fromGit.status).toBe(409);
    expect(fromGit.body.error).toContain('deploys from Git');
    // …and a project deployed by upload can't start a Git pipeline or branch previews.
    const id = await project();
    const files = site();
    const created = await upload(id, files);
    await send(id, created.body.uploadId, files);
    await deploy(id, created.body.uploadId);
    const repository = await request(`/projects/${id}/repository`, 'POST', {
      repository: 'alice/site',
    });
    expect(repository.status).toBe(409);
    expect(((await repository.json()) as { error: string }).error).toContain(
      'direct upload',
    );
    // Build scans and the deploy scheduler ignore direct-upload Workers.
    calls.length = 0;
    await scheduledBuildScans(db.env);
    expect(calls.filter((c) => c.path.includes('/builds'))).toEqual([]);
  });

  it('skips files Cloudflare already has', async () => {
    const id = await project();
    const files = site();
    for (const f of files) stored.set(f.hash, { content: f.content, type: '' });
    const created = await upload(id, files);
    expect(created.body.missing).toEqual([]);
    expect((await deploy(id, created.body.uploadId)).status).toBe(200);
    expect(
      calls.some((c) =>
        c.path.startsWith(`/accounts/${account}/workers/assets/upload`),
      ),
    ).toBe(false);
  });

  it('works with an API token, as the CLI and AI agents use it', async () => {
    const id = await project();
    const token = (
      (await (await request('/tokens', 'POST', { name: 'CI' })).json()) as {
        token: string;
      }
    ).token;
    const call = (path: string, body: unknown) =>
      app.request(
        `https://shipcel.test/api${path}`,
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
        db.env,
      );
    const files = site();
    const created = (await (
      await call(`/projects/${id}/uploads`, {
        files: files.map(({ path, hash, size }) => ({ path, hash, size })),
      })
    ).json()) as { uploadId: string };
    await call(`/projects/${id}/uploads/${created.uploadId}/files`, {
      files: files.map(({ hash, content }) => ({ hash, content })),
    });
    const deployed = await call(
      `/projects/${id}/uploads/${created.uploadId}/deploy`,
      confirm(),
    );
    expect(deployed.status).toBe(200);
  });
});

// Like Vercel's preview deployments: a new version gets its own address while production
// keeps serving the current one (Cloudflare's version upload, as wrangler versions upload).
// Cloudflare's Workers Editor scope updates existing Workers but can't create one.
// Seen live on 9 Oct 2026: Cloudflare creates an empty Worker when an upload session starts
// for a new name. It is Shipcel's own; a Worker with code or files never is.
describe('the empty Worker an upload session creates', () => {
  async function upAndSend(id: string) {
    const files = site();
    const { status, body } = await upload(id, files);
    if (status !== 201) return { status, body, uploadId: '' };
    await send(id, body.uploadId, files);
    return { status, body, uploadId: body.uploadId };
  }
  it('is no obstacle to the first deploy, or to a retry after it failed', async () => {
    const id = await project();
    const first = await upAndSend(id);
    expect(fx.state.placeholders.has('my-site')).toBe(true);
    // The deploy doesn't happen (say the person closed the terminal); later they try again.
    const retry = await upAndSend(id);
    expect(retry.status).toBe(201);
    const deployed = await deploy(id, retry.uploadId, { publish: true });
    expect(deployed.status).toBe(200);
    expect(fx.state.placeholders.has('my-site')).toBe(false);
    expect(first.uploadId).not.toBe(retry.uploadId);
  });
  it('still never takes over a Worker that has code, or an empty one Shipcel didn’t start', async () => {
    const id = await project();
    fx.state.placeholders.add('my-site');
    const refused = await upload(id, site());
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('already exists');
  });
});

describe('connections that can’t create Workers', () => {
  it('refuses a new app’s first upload with what to do, before calling Cloudflare', async () => {
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET scopes=? WHERE provider='cloudflare'",
      )
      .run('account-settings.read workers-scripts.edit offline_access');
    const id = await project();
    const files = site();
    const refused = await upload(id, files);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(
      'can update Workers but not create new ones',
    );
    expect(calls).toEqual([]);
    // With Workers Scripts Write it goes ahead.
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET scopes=? WHERE provider='cloudflare'",
      )
      .run('account-settings.read workers-scripts.write offline_access');
    expect((await upload(id, files)).status).toBe(201);
  });
});

describe('preview deploys', () => {
  async function deployed(
    id: string,
    files = site(),
    extra: Record<string, unknown> = {},
  ) {
    const { body } = await upload(id, files);
    if (body.missing.length)
      await send(
        id,
        body.uploadId,
        files.filter((f) => body.missing.includes(f.hash)),
      );
    return deploy(id, body.uploadId, extra);
  }
  const module = btoa(
    'export default { fetch: (r, env) => env.ASSETS.fetch(r) };',
  );
  it('uploads a version with its own address and leaves production as it is', async () => {
    const id = await project();
    expect((await deployed(id, site(), { publish: true })).status).toBe(200);
    const live = fx.state.live;
    const preview = await deployed(
      id,
      [file('/index.html', '<h1>Next</h1>'), file('/assets/app.js', 'x')],
      { preview: true },
    );
    expect(preview.status).toBe(200);
    expect(fx.state.versions).toHaveLength(2);
    const version = fx.state.versions[0];
    expect(preview.body.result).toEqual({
      workerName: 'my-site',
      versionId: version,
      previewUrl: `https://${version.slice(0, 8)}-my-site.test-account.workers.dev`,
      url: null,
      published: false,
      preview: true,
      productionUrl: 'https://my-site.test-account.workers.dev/',
    });
    // Production still serves the first version, at the same public address.
    expect(fx.state.live).toBe(live);
    expect(fx.state.route).toMatchObject({ enabled: true });
    const uploads = calls.filter(
      (c) =>
        c.method === 'POST' &&
        c.path.startsWith(
          `/accounts/${account}/workers/scripts/my-site/versions`,
        ),
    );
    expect(uploads.map((c) => c.path)).toEqual([
      `/accounts/${account}/workers/scripts/my-site/versions?bindings_inherit=strict`,
    ]);
    const listed = (await (
      await request(`/projects/${id}/uploads`)
    ).json()) as {
      versionId: string;
      published: boolean;
      url: string | null;
    }[];
    expect(listed[0]).toMatchObject({
      versionId: version,
      published: false,
      url: null,
    });
    const job = db.sqlite
      .prepare('SELECT live_url FROM deployment_jobs WHERE project_id=?')
      .get(id) as { live_url: string };
    expect(job.live_url).toBe('https://my-site.test-account.workers.dev/');
  });
  it('marks which versions served production, so rollback never picks a preview', async () => {
    const id = await project();
    await deployed(id, site(), { publish: true });
    await deployed(id, [file('/index.html', '<h1>2</h1>')], { preview: true });
    await deployed(id, [file('/index.html', '<h1>3</h1>')]);
    const versions = (await (
      await request(`/projects/${id}/versions`)
    ).json()) as {
      id: string;
      live: number | null;
      production: boolean;
    }[];
    expect(
      versions.map((v) => [v.id.slice(0, 8), v.live, v.production]),
    ).toEqual([
      ['00000003', 100, true],
      ['00000002', null, false],
      ['00000001', null, true],
    ]);
  });
  it('never publishes a preview', async () => {
    const id = await project();
    const refused = await deployed(id, site(), {
      preview: true,
      publish: true,
    });
    expect(refused.status).toBe(400);
    expect(fx.state.workers.size).toBe(0);
  });
  it('creates a new app unpublished when its first deploy is a preview', async () => {
    const id = await project();
    const first = await deployed(id, site(), { preview: true });
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({
      published: false,
      url: null,
      preview: true,
      productionUrl: null,
    });
    expect(fx.state.route).toMatchObject({ enabled: false });
    expect(fx.state.uploadedVersions).toEqual([]);
  });
  it('keeps the Worker’s secrets when a new version replaces its code', async () => {
    const id = await project();
    await deployed(id, site(), { workerModule: module });
    expect(workers.get('my-site')!.metadata).toMatchObject({
      keep_bindings: ['secret_text', 'secret_key'],
    });
    await deployed(id, [file('/index.html', '<h1>2</h1>')], {
      workerModule: module,
      preview: true,
    });
    expect(fx.state.uploadedVersions[0]).toMatchObject({
      main_module: '_worker.js',
      keep_bindings: ['secret_text', 'secret_key'],
    });
  });
});

describe('Workers Logs', () => {
  async function deployed(id: string, extra: Record<string, unknown> = {}) {
    const files = site();
    const { body } = await upload(id, files);
    if (body.missing.length)
      await send(
        id,
        body.uploadId,
        files.filter((f) => body.missing.includes(f.hash)),
      );
    return deploy(id, body.uploadId, extra);
  }
  const module = btoa(
    'export default { fetch: (r, env) => env.ASSETS.fetch(r) };',
  );
  const reads = () => calls.filter((c) => c.path.endsWith('/script-settings'));
  const sent = () => workers.get('my-site')!.metadata.observability;
  it('turns logs on with the deploy that creates the app’s Worker, as Cloudflare’s dashboard does', async () => {
    const id = await project();
    expect((await deployed(id)).status).toBe(200);
    expect(sent()).toEqual({ enabled: true });
    expect(fx.state.observability).toEqual({ enabled: true });
    expect(reads()).toEqual([]);
  });
  it('keeps the Worker’s setting on later deploys, since an upload replaces it', async () => {
    const id = await project();
    await deployed(id);
    const tuned = {
      enabled: true,
      head_sampling_rate: 0.5,
      logs: { enabled: true, invocation_logs: false, persist: true },
      traces: { enabled: false },
    };
    fx.state.observability = tuned;
    await deployed(id, { workerModule: module });
    expect(sent()).toEqual(tuned);
    expect(fx.state.observability).toEqual(tuned);
    // Logs someone turned off in Cloudflare stay off.
    fx.state.observability = null;
    await deployed(id, { workerModule: module });
    expect(workers.get('my-site')!.metadata).not.toHaveProperty(
      'observability',
    );
    expect(fx.state.observability).toBeNull();
    expect(reads().map((c) => c.method)).toEqual(['GET', 'GET']);
  });
  it('leaves it to previews, which don’t change it', async () => {
    const id = await project();
    await deployed(id);
    await deployed(id, { workerModule: module, preview: true });
    expect(fx.state.uploadedVersions[0]).not.toHaveProperty('observability');
    expect(fx.state.observability).toEqual({ enabled: true });
    expect(reads()).toEqual([]);
  });
  it('stops before uploading when Cloudflare can’t say what the setting is', async () => {
    const id = await project();
    await deployed(id);
    fx.state.settingsStatus = 500;
    const puts = () => calls.filter((c) => c.method === 'PUT').length;
    const before = puts();
    expect((await deployed(id, { workerModule: module })).status).toBe(502);
    expect(puts()).toBe(before);
  });
});
