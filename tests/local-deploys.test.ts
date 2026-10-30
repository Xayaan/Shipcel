import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import app from '../worker/index';
import { wranglerCommand, wranglerEnv } from '../packages/cli/src/app';
import { uploadProblems } from '../worker/wrangler-policy';
import { bridge, origin, sized } from './helpers/wrangler-bridge';
import { database, projectInput } from './helpers/database';
import {
  account,
  cloudflareWrangler,
  oauth,
} from './helpers/cloudflare-wrangler';

// Deploys of apps with code and bindings from a person's computer. The first tests run the
// real Wrangler (the pinned version, from node_modules) through Shipcel against a fake
// Cloudflare: they prove what Wrangler sends and what Shipcel lets through, not how
// Cloudflare behaves.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let fx: ReturnType<typeof cloudflareWrangler>;

const entry =
  'import { DurableObject } from "cloudflare:workers";\nexport class Room extends DurableObject {}\nexport default { fetch() { return new Response("ok"); }, scheduled() {} };\n';
const full = {
  name: 'repo-name',
  main: 'src/index.js',
  compatibility_date: '2026-10-07',
  compatibility_flags: ['nodejs_compat'],
  assets: { directory: 'public', binding: 'ASSETS' },
  d1_databases: [{ binding: 'DB' }],
  kv_namespaces: [{ binding: 'CACHE' }],
  vars: { MODE: 'production', RETRIES: 3 },
  triggers: { crons: ['*/30 * * * *'] },
  durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
  ai: { binding: 'AI' },
};
const filesOf = (config: Record<string, unknown>) => ({
  'package.json': '{"name":"app"}',
  'wrangler.jsonc': JSON.stringify(config),
});

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
async function project(name = 'my-app', extra: Record<string, unknown> = {}) {
  const response = await request('/projects', 'POST', {
    ...projectInput(name),
    ...extra,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
type Opened = {
  id: string;
  token: string;
  apiPath: string;
  accountId: string;
  workerName: string;
  production: boolean;
  first: boolean;
};
async function open(
  projectId: string,
  config: Record<string, unknown> = full,
  extra: Record<string, unknown> = {},
  cookie = who.cookie,
) {
  const response = await request(
    `/projects/${projectId}/local-deploys`,
    'POST',
    confirm({ files: filesOf(config), confirmResources: true, ...extra }),
    cookie,
  );
  return {
    status: response.status,
    body: (await response.json()) as Opened & { error?: string },
  };
}
// One of Wrangler's calls, made by hand.
const call = async (
  session: Opened,
  path: string,
  init: RequestInit = {},
  token = session.token,
) =>
  app.request(
    `https://shipcel.test${session.apiPath}${path}`,
    await sized({
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(typeof init.body === 'string'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init.headers,
      },
    }),
    db.env,
  );
const scripts = (name: string) =>
  `/accounts/${account}/workers/scripts/${name}`;
const upload = (metadata: Record<string, unknown>) => {
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  form.set(
    'index.js',
    new File(['export default {}'], 'index.js', {
      type: 'application/javascript+module',
    }),
  );
  return form;
};
const refusedFor = async (response: Response) =>
  ((await response.json()) as { errors: { message: string }[] }).errors[0]
    .message;
const finish = async (projectId: string, session: Opened, failed = false) => {
  const response = await request(
    `/projects/${projectId}/local-deploys/${session.id}/finish`,
    'POST',
    { failed },
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      error?: string;
      result?: Record<string, unknown>;
    },
  };
};

// The real Wrangler, run with the command line and environment the shipcel CLI gives it.
let link: Awaited<ReturnType<typeof bridge>> | null = null;
async function runWrangler(session: Opened, config: Record<string, unknown>) {
  link ??= await bridge(db.env);
  const cwd = await mkdtemp(join(tmpdir(), 'cloudcel-local-'));
  try {
    await mkdir(join(cwd, 'src'));
    await mkdir(join(cwd, 'public'));
    await writeFile(join(cwd, 'src/index.js'), entry);
    await writeFile(join(cwd, 'public/index.html'), '<h1>hi</h1>');
    await writeFile(join(cwd, 'public/app.js'), 'console.log(1)');
    await writeFile(join(cwd, 'wrangler.jsonc'), JSON.stringify(config));
    const code = await link.run(
      wranglerCommand(session.workerName, session.production),
      cwd,
      wranglerEnv(origin, session),
    );
    return { code, output: link.outputs.at(-1)! };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
const blank = () => ({
  tag: 'f'.repeat(32),
  bindings: [],
  migrationTag: null,
  metadata: {} as Record<string, unknown>,
  parts: {},
});

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  fx = cloudflareWrangler();
  vi.stubGlobal('fetch', vi.fn(fx.handler));
});
afterEach(async () => {
  await link?.close();
  link = null;
  db.close();
  vi.unstubAllGlobals();
});

describe('a deploy from a computer, with the real Wrangler', () => {
  it('creates the app with its files, database, namespace, schedule and Durable Object', async () => {
    const id = await project();
    const { status, body: session } = await open(id);
    expect(status).toBe(201);
    expect(session).toMatchObject({
      workerName: 'my-app',
      production: true,
      first: true,
      accountId: account,
    });
    const run = await runWrangler(session, full);
    expect(run.output).not.toContain('Shipcel:');
    expect(run.code).toBe(0);
    expect(run.output).toContain('https://my-app.test-account.workers.dev');
    const seen = link!.seen;

    // Cloudflare got one Worker, with what the configuration asked for.
    const worker = fx.state.workers.get('my-app')!;
    expect(fx.state.d1).toEqual([
      { name: 'my-app-db', uuid: '60000000-0000-4000-8000-000000000001' },
    ]);
    expect(fx.state.kv.map((n) => n.title)).toEqual(['my-app-cache']);
    expect(worker.bindings).toEqual(
      expect.arrayContaining([
        { name: 'DB', type: 'd1', id: fx.state.d1[0].uuid },
        {
          name: 'CACHE',
          type: 'kv_namespace',
          namespace_id: fx.state.kv[0].id,
        },
        { name: 'ROOMS', type: 'durable_object_namespace', class_name: 'Room' },
        { name: 'AI', type: 'ai' },
        { name: 'ASSETS', type: 'assets' },
        { name: 'MODE', type: 'plain_text', text: 'production' },
      ]),
    );
    expect(worker.metadata).toMatchObject({
      main_module: 'index.js',
      compatibility_flags: ['nodejs_compat'],
      migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: ['Room'] }] },
      // Cloudflare's own completion token, put back in place of the session's.
      assets: { jwt: 'completion-jwt' },
      // The configuration says nothing about logs, so they stay on.
      observability: { enabled: true },
    });
    expect(worker.parts['index.js'].type).toBe('application/javascript+module');
    expect(fx.state.stored.size).toBe(2);
    expect(fx.state.route['my-app']).toEqual({
      enabled: true,
      previews_enabled: true,
    });
    expect(fx.state.schedules['my-app']).toEqual([{ cron: '*/30 * * * *' }]);

    // Wrangler only ever held the session's token, and no answer carried Cloudflare's.
    // It says how long each request is, which is what Shipcel sizes them by.
    expect(seen.length).toBeGreaterThan(10);
    for (const exchange of seen) {
      if (exchange.method !== 'GET')
        expect([exchange.path, exchange.contentLength]).toEqual([
          exchange.path,
          expect.stringMatching(/^\d+$/),
        ]);
      expect(exchange.authorization).toBe(`Bearer ${session.token}`);
      expect(exchange.text).not.toMatch(
        /cloudflare-access-secret|upload-jwt|completion-jwt/,
      );
    }
    // Every call Shipcel sent on used the workspace's connection, or the upload token.
    for (const sent of fx.state.calls)
      expect(sent.authorization).toBe(
        sent.path.includes('/assets/upload') ? 'Bearer upload-jwt' : oauth,
      );
    // The upload went on under Wrangler's own name, so Cloudflare files the deploy as
    // Wrangler's and not as one made "via the script API".
    expect(
      fx.state.calls.find(
        (c) => c.method === 'PUT' && c.path.startsWith(`${scripts('my-app')}?`),
      )!.agent,
    ).toMatch(/^wrangler\/\d+\.\d+\.\d+$/);
    expect(fx.state.from['my-app']).toBe('wrangler');
    // Nothing of the account was listed for Wrangler to choose from.
    expect(
      fx.state.calls.filter(
        (c) =>
          c.method === 'GET' &&
          /\/(d1\/database|kv\/namespaces|r2\/buckets)(\?|$)/.test(c.path),
      ),
    ).toEqual([]);

    const done = await finish(id, session);
    expect(done.status).toBe(200);
    expect(done.body.result).toMatchObject({
      workerName: 'my-app',
      versionId: '00000001-0000-4000-8000-000000000000',
      url: 'https://my-app.test-account.workers.dev/',
      published: true,
      preview: false,
      // This app has a Durable Object, and Cloudflare gives such a Worker no preview
      // addresses (seen live: the address its API implies answers 404).
      previewUrl: null,
      previewNote:
        'Cloudflare gives a Worker with a Durable Object no preview addresses, so this version has none of its own.',
      created: [
        { type: 'kv', name: 'my-app-cache' },
        { type: 'd1', name: 'my-app-db' },
      ],
    });
    const job = db.sqlite
      .prepare('SELECT * FROM deployment_jobs WHERE project_id=?')
      .get(id) as Record<string, unknown>;
    expect(job).toMatchObject({
      adapter: 'direct-upload',
      local_adapter: 'configured-worker',
      worker_name: 'my-app',
      worker_tag: 'c'.repeat(32),
      status: 'deployed',
      live_url: 'https://my-app.test-account.workers.dev/',
    });
    expect(JSON.parse(String(job.resources_json))).toEqual([
      { type: 'd1', binding: 'DB' },
      { type: 'kv', binding: 'CACHE' },
    ]);
    expect(
      db.sqlite
        .prepare(
          'SELECT kind, status FROM project_operations WHERE project_id=?',
        )
        .all(id),
    ).toEqual([{ kind: 'local.deploy', status: 'succeeded' }]);
    expect(
      db.sqlite
        .prepare(
          'SELECT status, files, version_id, published, upload_token, completion_token FROM direct_uploads WHERE project_id=?',
        )
        .all(id),
    ).toEqual([
      {
        status: 'deployed',
        files: 2,
        version_id: '00000001-0000-4000-8000-000000000000',
        published: 1,
        upload_token: null,
        completion_token: null,
      },
    ]);
    expect(
      db.sqlite
        .prepare(
          'SELECT status, upload_token, completion_token FROM local_deploys WHERE id=?',
        )
        .get(session.id),
    ).toEqual({
      status: 'deployed',
      upload_token: null,
      completion_token: null,
    });
    // The session is over: its token opens nothing any more.
    expect((await call(session, `${scripts('my-app')}/settings`)).status).toBe(
      401,
    );
    // Manage and the CLI read the app like any other.
    const versions = (await (
      await request(`/projects/${id}/versions`)
    ).json()) as { id: string; live: number | null }[];
    expect(versions[0]).toMatchObject({
      id: '00000001-0000-4000-8000-000000000000',
      live: 100,
    });
  }, 120000);

  it('deploys again reusing the app’s bindings, then uploads a preview that leaves production alone', async () => {
    const id = await project();
    const first = (await open(id)).body;
    expect((await runWrangler(first, full)).code).toBe(0);
    expect((await finish(id, first)).status).toBe(200);
    const made = fx.state.calls.length;

    // Nothing to create now, so nothing to confirm.
    const again = await open(id, full, {
      confirmResources: false,
      production: true,
    });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ first: false, production: true });
    const run = await runWrangler(again.body, full);
    expect(run.output).not.toContain('Shipcel:');
    expect(run.code).toBe(0);
    // Wrangler warns when the Worker was last uploaded by something else (seen live, when
    // Shipcel sent its uploads on without Wrangler's name).
    expect(run.output).not.toContain('last updated via the script API');
    const later = fx.state.calls.slice(made);
    expect(
      later.some(
        (c) =>
          c.method === 'POST' &&
          /\/(d1\/database|kv\/namespaces|r2\/buckets)$/.test(c.path),
      ),
    ).toBe(false);
    // Wrangler uploads a version and sends production to it.
    const version = later.find(
      (c) => c.method === 'POST' && c.path.includes('/versions'),
    )!;
    expect((version.body as { bindings: unknown[] }).bindings).toEqual(
      expect.arrayContaining([
        { name: 'DB', type: 'inherit' },
        { name: 'CACHE', type: 'inherit' },
      ]),
    );
    expect(fx.state.live).toBe('00000002-0000-4000-8000-000000000000');
    // Both go on under Wrangler's own name.
    for (const sent of later.filter(
      (c) => c.method === 'POST' && /\/(versions|deployments)$/.test(c.path),
    ))
      expect([sent.path, sent.agent]).toEqual([
        sent.path,
        expect.stringMatching(/^wrangler\/\d+\.\d+\.\d+$/),
      ]);
    expect(fx.state.workers.get('my-app')!.bindings).toEqual(
      expect.arrayContaining([
        { name: 'DB', type: 'd1', id: fx.state.d1[0].uuid },
      ]),
    );
    // Wrangler would switch Workers Logs off here; they stay on.
    expect(fx.state.settings['my-app'].observability).toEqual({
      enabled: true,
    });
    const done = await finish(id, again.body);
    expect(done.body.result).toMatchObject({
      versionId: '00000002-0000-4000-8000-000000000000',
      url: 'https://my-app.test-account.workers.dev/',
      preview: false,
    });

    // A preview: a version with its own address; production keeps serving the last one.
    const preview = await open(id, full, { confirmResources: false });
    expect(preview.body).toMatchObject({ first: false, production: false });
    const uploaded = await runWrangler(preview.body, full);
    expect(uploaded.output).not.toContain('Shipcel:');
    expect(uploaded.code).toBe(0);
    expect(fx.state.live).toBe('00000002-0000-4000-8000-000000000000');
    const previewed = await finish(id, preview.body);
    expect(previewed.body.result).toMatchObject({
      versionId: '00000003-0000-4000-8000-000000000000',
      preview: true,
      url: null,
      published: false,
      previewUrl: null,
      productionUrl: 'https://my-app.test-account.workers.dev/',
    });
    expect(
      db.sqlite
        .prepare(
          'SELECT kind, status FROM project_operations WHERE project_id=? ORDER BY created_at, rowid',
        )
        .all(id),
    ).toEqual([
      { kind: 'local.deploy', status: 'succeeded' },
      { kind: 'local.deploy', status: 'succeeded' },
      { kind: 'local.preview', status: 'succeeded' },
    ]);
  }, 240000);
});

describe('what a deploy session lets through', () => {
  const simple = {
    name: 'repo-name',
    main: 'src/index.js',
    compatibility_date: '2026-10-07',
    d1_databases: [{ binding: 'DB' }],
  };
  // A new app, deployed by hand through the same calls Wrangler makes.
  async function deployed(config: Record<string, unknown> = simple) {
    const id = await project();
    const session = (await open(id, config)).body;
    const made = await call(session, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'my-app-db' }),
    });
    expect(made.status).toBe(200);
    const uuid = ((await made.json()) as { result: { uuid: string } }).result
      .uuid;
    const put = await call(session, scripts('my-app'), {
      method: 'PUT',
      body: upload({
        main_module: 'index.js',
        bindings: [{ name: 'DB', type: 'd1', id: uuid }],
      }),
    });
    expect(put.status).toBe(200);
    await call(session, `${scripts('my-app')}/subdomain`, {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    });
    expect((await finish(id, session)).status).toBe(200);
    return { id, uuid };
  }

  it('answers only the session’s own token, while the session is open', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    const path = `/accounts/${account}/workers/subdomain`;
    expect((await call(session, path)).status).toBe(200);
    expect((await call(session, path, {}, 'x'.repeat(43))).status).toBe(401);
    // A browser session is not a deploy's token.
    expect(
      (await call(session, path, { headers: { Cookie: who.cookie } }, ''))
        .status,
    ).toBe(401);
    const other = {
      ...session,
      apiPath: `/api/wrangler/${crypto.randomUUID()}/client/v4`,
    };
    expect(await refusedFor(await call(other, path))).toContain(
      'no longer open',
    );
    // The connection changed: the deploy can't go on with another account.
    const setAccount = (value: string) =>
      db.sqlite
        .prepare(
          "UPDATE provider_grants SET account_id=? WHERE provider='cloudflare'",
        )
        .run(value);
    setAccount('b'.repeat(32));
    expect((await call(session, path)).status).toBe(401);
    setAccount(account);
    expect((await call(session, path)).status).toBe(200);
    // The person who opened it lost their role.
    db.sqlite.prepare("UPDATE memberships SET role='viewer'").run();
    expect((await call(session, path)).status).toBe(401);
    db.sqlite.prepare("UPDATE memberships SET role='owner'").run();
    // Deployments switched off, then the hour is up.
    db.env.NATIVE_BUILDS_ENABLED = 'false';
    expect((await call(session, path)).status).toBe(401);
    db.env.NATIVE_BUILDS_ENABLED = 'true';
    const later = Math.floor(Date.now() / 1000) + 600;
    const until = (at: number) =>
      db.sqlite.prepare('UPDATE local_deploys SET expires_at=?').run(at);
    until(1);
    expect((await call(session, path)).status).toBe(401);
    until(later);
    expect((await call(session, path)).status).toBe(200);
    // The browser sign-in that opened it ran out, or signed out.
    const signIn = (at: number) =>
      db.sqlite
        .prepare('UPDATE sessions SET expires_at=? WHERE user_id=?')
        .run(at, who.userId);
    signIn(1);
    expect((await call(session, path)).status).toBe(401);
    signIn(later);
    expect((await call(session, path)).status).toBe(200);
    expect((await request('/auth/logout', 'POST')).status).toBe(200);
    expect((await call(session, path)).status).toBe(401);
  });

  it('reaches one Worker of one account, and nothing else of Cloudflare', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    const before = fx.state.calls.length;
    for (const [method, path] of [
      ['GET', scripts('other-app')],
      ['GET', `${scripts('other-app')}/settings`],
      ['PUT', scripts('other-app')],
      ['GET', `/accounts/${'b'.repeat(32)}/workers/scripts/my-app/settings`],
      ['GET', `/accounts/${account}/workers/scripts/my-app`],
      ['GET', `${scripts('my-app')}/versions`],
      [
        'GET',
        `${scripts('my-app')}/versions/00000001-0000-4000-8000-000000000000`,
      ],
      ['GET', `${scripts('my-app')}/settings/`],
      ['GET', `${scripts('my-app')}%2Fsettings`],
      ['GET', `/accounts/${account}/workers//scripts/my-app/settings`],
      [
        'GET',
        `/accounts/${account}/workers/scripts/my-app/../other-app/settings`,
      ],
      ['GET', `/accounts/${account}/workers/scripts/%6dy-app/settings`],
      ['DELETE', scripts('my-app')],
      ['PUT', `${scripts('my-app')}/secrets`],
      [
        'GET',
        `/accounts/${account}/d1/database/60000000-0000-4000-8000-000000000001`,
      ],
      ['POST', `/accounts/${account}/d1/database/x/query`],
      ['GET', '/zones'],
      ['GET', `/accounts/${account}/workers/domains`],
      ['PUT', `/accounts/${account}/workers/subdomain`],
      ['POST', `/accounts/${account}/queues`],
    ] as const) {
      const response = await call(session, path, {
        method,
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect([method, path, response.status]).toEqual([method, path, 403]);
      expect(await refusedFor(response)).toContain('Shipcel:');
    }
    expect(fx.state.calls.length).toBe(before);
    // The account's resources are never listed, whatever it holds.
    fx.state.d1.push({ uuid: 'x', name: 'someone-elses' });
    for (const path of [
      'd1/database',
      'storage/kv/namespaces?per_page=100',
      'r2/buckets',
    ]) {
      const listed = (await (
        await call(session, `/accounts/${account}/${path}`)
      ).json()) as { success: boolean; result: unknown };
      expect(listed.success).toBe(true);
      expect(JSON.stringify(listed.result)).not.toContain('someone');
    }
    expect(fx.state.calls.length).toBe(before);
    // Other Workers of the account stay out of an older Wrangler's list.
    fx.state.workers.set('private-worker', blank());
    const listed = (await (
      await call(session, `/accounts/${account}/workers/scripts`)
    ).json()) as { result: unknown[] };
    expect(listed.result).toEqual([]);
  });

  it('creates only the reviewed resources, and binds only the ones created for the app', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    const create = (kind: string, body: unknown) =>
      call(session, `/accounts/${account}/${kind}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    for (const [kind, body] of [
      ['d1/database', { name: 'another-db' }],
      ['d1/database', { name: 'my-app-other' }],
      ['storage/kv/namespaces', { title: 'my-app-db' }],
      ['r2/buckets', { name: 'my-app-db' }],
      ['d1/database', {}],
    ] as const) {
      const response = await create(kind, body);
      expect(response.status).toBe(403);
      expect(await refusedFor(response)).toContain('wasn’t reviewed to create');
    }
    expect(fx.state.d1).toEqual([]);
    // Only the name goes to Cloudflare.
    const made = await create('d1/database', {
      name: 'my-app-db',
      primary_location_hint: 'weur',
    });
    expect(made.status).toBe(200);
    expect(fx.state.calls.at(-1)!.body).toEqual({ name: 'my-app-db' });
    const uuid = fx.state.d1[0].uuid;
    fx.state.d1.push({
      uuid: '70000000-0000-4000-8000-000000000009',
      name: 'payroll',
    });
    const put = (bindings: unknown[], extra: Record<string, unknown> = {}) =>
      call(session, scripts('my-app'), {
        method: 'PUT',
        body: upload({ main_module: 'index.js', bindings, ...extra }),
      });
    for (const [binding, reason] of [
      [
        { name: 'DB', type: 'd1', id: '70000000-0000-4000-8000-000000000009' },
        'didn’t create for this app',
      ],
      [
        { name: 'KV', type: 'kv_namespace', namespace_id: 'k'.repeat(32) },
        'didn’t create for this app',
      ],
      [
        { name: 'FILES', type: 'r2_bucket', bucket_name: 'payroll' },
        'didn’t create for this app',
      ],
      [
        { name: 'API', type: 'service', service: 'private-worker' },
        'may only bind itself',
      ],
      [
        {
          name: 'ROOMS',
          type: 'durable_object_namespace',
          class_name: 'Room',
          script_name: 'private-worker',
        },
        'durable_object_namespace binding',
      ],
      [{ name: 'Q', type: 'queue', queue_name: 'jobs' }, 'queue binding'],
      [
        { name: 'SECRET', type: 'secret_text', text: 'x' },
        'secret_text binding',
      ],
      [{ name: 'HD', type: 'hyperdrive', id: 'x' }, 'Hyperdrive configuration'],
    ] as const) {
      const response = await put([binding]);
      expect(response.status).toBe(403);
      expect(await refusedFor(response)).toContain(reason);
    }
    for (const [extra, reason] of [
      [
        { tail_consumers: [{ service: 'spy' }] },
        'sends its logs to another Worker',
      ],
      [{ logpush: true }, 'Logpush'],
      [{ containers: [{ class_name: 'C' }] }, 'containers'],
      [{ dispatch_namespace: 'x' }, 'dispatch_namespace'],
      [{ keep_bindings: ['d1'] }, 'keeps bindings'],
      [
        {
          migrations: {
            steps: [
              {
                transferred_classes: [{ from: 'A', from_script: 'x', to: 'B' }],
              },
            ],
          },
        },
        'Durable Object migrations',
      ],
      [
        { migrations: { steps: [{ new_classes: ['A'] }] } },
        'Durable Object migrations',
      ],
      [{ placement: { region: 'aws:us-east-1' } }, 'placement'],
      [
        { observability: { enabled: true, logs: { destinations: ['siem'] } } },
        'destinations send them elsewhere',
      ],
      [{ logpush: 'yes' }, 'Logpush'],
      [{ assets: 'x', bindings: 'y' }, 'bindings can’t be read'],
    ] as const) {
      const response = await put([], extra);
      expect(response.status).toBe(403);
      expect(await refusedFor(response)).toContain(reason);
    }
    const old = new FormData();
    old.set(
      'metadata',
      JSON.stringify({ body_part: 'index.js', bindings: [] }),
    );
    expect(
      await refusedFor(
        await call(session, scripts('my-app'), { method: 'PUT', body: old }),
      ),
    ).toContain('service-worker format');
    expect(fx.state.workers.size).toBe(0);
    // The database made for the app, itself, and what a Worker may always have.
    const accepted = await put([
      { name: 'DB', type: 'd1', id: uuid },
      { name: 'SELF', type: 'service', service: 'my-app' },
      { name: 'ROOMS', type: 'durable_object_namespace', class_name: 'Room' },
      { name: 'MODE', type: 'plain_text', text: 'x' },
    ]);
    expect(accepted.status).toBe(200);
    expect(fx.state.workers.get('my-app')!.bindings).toHaveLength(4);
    // An upload goes on with Wrangler's own flags and no others.
    const flagged = await call(
      session,
      `${scripts('my-app')}?excludeScript=true&bindings_inherit=strict&include_subdomain_availability=a%26b&rollback_to=abc&dispatch_namespace=x`,
      {
        method: 'PUT',
        body: upload({ main_module: 'index.js', bindings: [] }),
      },
    );
    expect(flagged.status).toBe(200);
    expect(fx.state.calls.at(-1)!.path).toBe(
      `${scripts('my-app')}?excludeScript=true&bindings_inherit=strict`,
    );
    // And under Wrangler's own name when it gives one, in the form Wrangler writes it;
    // anything else a caller claims to be isn't passed on.
    for (const [agent, sent] of [
      ['wrangler/4.148.0', 'wrangler/4.148.0'],
      ['wrangler/4.148.0 (and more)', null],
      ['Wrangler/4.148.0', null],
      ['dash', null],
    ] as const) {
      const named = await call(session, scripts('my-app'), {
        method: 'PUT',
        headers: { 'User-Agent': agent },
        body: upload({ main_module: 'index.js', bindings: [] }),
      });
      expect(named.status).toBe(200);
      const passed = fx.state.calls.at(-1)!.agent;
      expect([agent, passed === agent ? passed : null]).toEqual([agent, sent]);
    }
  });

  it('touches nothing under a new app’s name until its own upload has made the Worker', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    // A Worker of that name appears in Cloudflare after the review.
    fx.state.workers.set('my-app', { ...blank(), metadata: { theirs: true } });
    const before = fx.state.calls.length;
    for (const [method, path, body] of [
      [
        'POST',
        `${scripts('my-app')}/versions`,
        upload({ main_module: 'index.js', bindings: [] }),
      ],
      [
        'POST',
        `${scripts('my-app')}/deployments`,
        JSON.stringify({
          strategy: 'percentage',
          versions: [
            {
              version_id: '00000001-0000-4000-8000-000000000000',
              percentage: 100,
            },
          ],
        }),
      ],
      [
        'POST',
        `${scripts('my-app')}/subdomain`,
        JSON.stringify({ enabled: true }),
      ],
      [
        'PUT',
        `${scripts('my-app')}/schedules`,
        JSON.stringify([{ cron: '0 0 * * *' }]),
      ],
      [
        'PATCH',
        `${scripts('my-app')}/script-settings`,
        JSON.stringify({ observability: { enabled: false } }),
      ],
    ] as const) {
      const response = await call(session, path, { method, body });
      expect([path, response.status]).toEqual([path, 409]);
    }
    expect(
      fx.state.calls.slice(before).filter((c) => c.method !== 'GET'),
    ).toEqual([]);
    expect(fx.state.workers.get('my-app')!.metadata).toEqual({ theirs: true });
    expect(fx.state.route['my-app']).toBeUndefined();
    expect(fx.state.schedules['my-app']).toBeUndefined();
  });

  it('stops when the app’s Worker was replaced, or the sign-in that opened the deploy was revoked', async () => {
    const { id } = await deployed();
    const session = (await open(id, simple, { production: true })).body;
    // Replaced in Cloudflare since the review: its tag is another one.
    fx.state.workers.get('my-app')!.tag = '9'.repeat(32);
    for (const [method, path] of [
      ['PUT', scripts('my-app')],
      ['POST', `${scripts('my-app')}/versions`],
    ] as const) {
      const response = await call(session, path, {
        method,
        body: upload({ main_module: 'index.js', bindings: [] }),
      });
      expect(response.status).toBe(409);
      expect(await refusedFor(response)).toContain(
        'changed in Cloudflare since this deploy was reviewed',
      );
    }
    expect(fx.state.versions).toHaveLength(1);
    fx.state.workers.get('my-app')!.tag = 'c'.repeat(32);
    await finish(id, session, true);
    // Opened with an API token, as the CLI does: revoking the token ends the deploy.
    const token = (await (
      await request('/tokens', 'POST', { name: 'CLI' })
    ).json()) as { id: string; token: string };
    const opened = await db.request(
      `/projects/${id}/local-deploys`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.token}` },
        body: JSON.stringify(
          confirm({ files: filesOf(simple), production: true }),
        ),
      },
      undefined,
    );
    expect(opened.status).toBe(201);
    const byToken = (await opened.json()) as Opened;
    const path = `/accounts/${account}/workers/subdomain`;
    expect((await call(byToken, path)).status).toBe(200);
    const expire = (at: number | null) =>
      db.sqlite
        .prepare('UPDATE api_tokens SET expires_at=? WHERE id=?')
        .run(at, token.id);
    expire(1);
    expect((await call(byToken, path)).status).toBe(401);
    expire(null);
    expect((await call(byToken, path)).status).toBe(200);
    expect((await request(`/tokens/${token.id}`, 'DELETE')).status).toBe(200);
    expect((await call(byToken, path)).status).toBe(401);
  });

  it('counts a deploy’s calls, and those of all the workspace’s deploys', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    const used = (key: string, count: number) =>
      db.sqlite
        .prepare(
          'INSERT OR REPLACE INTO request_limits(key,count,expires_at) VALUES (?,?,?)',
        )
        .run(key, count, Math.floor(Date.now() / 1000) + 60);
    const mine = `local-deploy:${session.id}`;
    used(mine, 239);
    expect((await call(session, '/user')).status).toBe(200);
    const over = await call(session, '/user');
    expect(over.status).toBe(429);
    // Said in Cloudflare's shape, which is what Wrangler prints.
    expect(await refusedFor(over)).toBe(
      'Shipcel: Too many requests. Wait a minute and try again.',
    );
    // Someone without the deploy's token uses up none of its calls.
    used(mine, 240);
    expect((await call(session, '/user', {}, 'x'.repeat(43))).status).toBe(401);
    expect(
      db.sqlite
        .prepare('SELECT count FROM request_limits WHERE key=?')
        .get(mine),
    ).toEqual({ count: 240 });
    // The workspace's deploys share what Cloudflare allows its connection.
    used(mine, 0);
    used(`local-deploys:${who.workspaceId}`, 600);
    expect((await call(session, '/user')).status).toBe(429);
  });

  it('keeps Cloudflare’s upload tokens, whatever Cloudflare answers', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    const hash = 'a'.repeat(32);
    const start = () =>
      call(session, `${scripts('my-app')}/assets-upload-session`, {
        method: 'POST',
        body: JSON.stringify({
          manifest: { '/index.html': { hash, size: 1 } },
        }),
      });
    const files = () => {
      const form = new FormData();
      form.set(hash, new File(['aGk='], hash, { type: 'text/html' }));
      return call(
        session,
        `/accounts/${account}/workers/assets/upload?base64=true`,
        { method: 'POST', body: form },
      );
    };
    const put = () =>
      call(session, scripts('my-app'), {
        method: 'PUT',
        body: upload({
          main_module: 'index.js',
          bindings: [],
          assets: { jwt: session.token },
        }),
      });
    const refuseWith = (match: RegExp, jwt: string) => {
      fx.state.fail = { match, status: 400, code: 10021, result: { jwt } };
    };
    // Files and code wait for the upload they belong to.
    expect((await files()).status).toBe(409);
    expect((await put()).status).toBe(409);
    // An answer about the files that can't be read isn't handed on with the token in it.
    fx.state.garbledSession = true;
    const garbled = await start();
    expect(garbled.status).toBe(502);
    expect(await garbled.text()).not.toContain('upload-jwt');
    // Nor is a refusal that carries one.
    refuseWith(/assets-upload-session$/, 'upload-jwt');
    const refused = await start();
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain('upload-jwt');
    // Wrangler gets the session's own token to present with the files, and again for
    // the code.
    expect(
      ((await (await start()).json()) as { result: unknown }).result,
    ).toEqual({ jwt: session.token, buckets: [[hash]] });
    expect((await put()).status).toBe(409);
    refuseWith(/assets\/upload$/, 'completion-jwt');
    const failed = await files();
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain('completion-jwt');
    const uploaded = await files();
    expect(uploaded.status).toBe(201);
    expect(((await uploaded.json()) as { result: unknown }).result).toEqual({
      jwt: session.token,
    });
    // Both of Cloudflare's tokens are kept sealed, and Cloudflare gets its own back.
    const kept = db.sqlite
      .prepare(
        'SELECT upload_token, completion_token FROM local_deploys WHERE id=?',
      )
      .get(session.id) as Record<string, string>;
    expect(kept.upload_token.length).toBeGreaterThan(20);
    expect(kept.completion_token.length).toBeGreaterThan(20);
    expect(JSON.stringify(kept)).not.toMatch(/upload-jwt|completion-jwt/);
    expect((await put()).status).toBe(200);
    // Logs stay on: the configuration says nothing about them.
    expect(fx.state.workers.get('my-app')!.metadata).toMatchObject({
      assets: { jwt: 'completion-jwt' },
      observability: { enabled: true },
    });
  });

  it('sizes every call by the length it declares, before reading any of it', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    const send = (
      path: string,
      headers: Record<string, string>,
      method = 'POST',
    ) =>
      app.request(
        `https://shipcel.test${session.apiPath}${path}`,
        {
          method,
          body: '{}',
          headers: { Authorization: `Bearer ${session.token}`, ...headers },
        },
        db.env,
      );
    const json = { 'Content-Type': 'application/json' };
    const database = `/accounts/${account}/d1/database`;
    // No declared length, or a body sent in chunks: refused, with or without a token.
    expect((await send(database, json)).status).toBe(411);
    expect(
      (
        await send(database, {
          ...json,
          'Content-Length': '2',
          'Transfer-Encoding': 'chunked',
        })
      ).status,
    ).toBe(411);
    expect(
      (await send(database, { ...json, 'Content-Length': 'many' })).status,
    ).toBe(411);
    const stranger = await app.request(
      `https://shipcel.test${session.apiPath}${database}`,
      { method: 'POST', body: '{}' },
      db.env,
    );
    expect(stranger.status).toBe(411);
    // Too much is refused before anyone is asked who they are.
    const flood = await app.request(
      `https://shipcel.test${session.apiPath}${database}`,
      {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Length': String(100 * 1024 * 1024 + 1) },
      },
      db.env,
    );
    expect(flood.status).toBe(413);
    expect(
      (
        await send(database, {
          ...json,
          'Content-Length': String(100 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    // Each part of a deploy has its own size: settings are small, code is 32 MB at most.
    for (const [path, method, length, status] of [
      [database, 'POST', 64 * 1024 + 1, 413],
      [`${scripts('my-app')}/schedules`, 'PUT', 70_000, 413],
      [scripts('my-app'), 'PUT', 32 * 1024 * 1024 + 1, 413],
      [`${scripts('my-app')}/versions`, 'POST', 40_000_000, 413],
      [
        `${scripts('my-app')}/assets-upload-session`,
        'POST',
        8 * 1024 * 1024 + 1,
        413,
      ],
      // Within its size, a call is judged on what it asks, as before.
      [database, 'POST', 2, 403],
    ] as const)
      expect([
        path,
        (
          await send(
            path,
            { ...json, 'Content-Length': String(length) },
            method,
          )
        ).status,
      ]).toEqual([path, status]);
    expect(fx.state.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    // An upload with more parts than a Worker has is refused too.
    const parts = upload({ main_module: 'index.js', bindings: [] });
    for (let i = 0; i < 2000; i++) parts.append(`part-${i}`, 'x');
    const many = await call(session, scripts('my-app'), {
      method: 'PUT',
      body: parts,
    });
    expect(many.status).toBe(413);
    expect(fx.state.workers.size).toBe(0);
    // Any other address under /api/wrangler still needs a Shipcel sign-in.
    expect(
      (
        await app.request(
          'https://shipcel.test/api/wrangler/status',
          {},
          db.env,
        )
      ).status,
    ).toBe(401);
  });

  it('shows Wrangler which bindings the Worker has, never their values', async () => {
    const { id } = await deployed();
    fx.state.workers.get('my-app')!.bindings.push(
      {
        name: 'API_URL',
        type: 'plain_text',
        text: 'https://internal.example',
      },
      {
        name: 'FILES',
        type: 'r2_bucket',
        bucket_name: 'my-app-files',
        jurisdiction: 'eu',
      },
    );
    const session = (await open(id, simple, { production: true })).body;
    const settings = await (
      await call(session, `${scripts('my-app')}/settings`)
    ).json();
    expect(settings).toMatchObject({
      success: true,
      result: {
        bindings: [
          { name: 'DB', type: 'd1' },
          { name: 'API_URL', type: 'plain_text' },
          { name: 'FILES', type: 'r2_bucket', jurisdiction: 'eu' },
        ],
      },
    });
    expect(JSON.stringify(settings)).not.toMatch(
      /internal\.example|60000000|my-app-files/,
    );
  });

  it('keeps a preview away from production', async () => {
    const { id } = await deployed();
    const live = fx.state.live;
    const session = (await open(id, simple)).body;
    expect(session.production).toBe(false);
    const version = await call(session, `${scripts('my-app')}/versions`, {
      method: 'POST',
      body: upload({
        main_module: 'index.js',
        bindings: [{ name: 'DB', type: 'inherit' }],
      }),
    });
    expect(version.status).toBe(200);
    const versionId = ((await version.json()) as { result: { id: string } })
      .result.id;
    for (const [method, path, body] of [
      [
        'PUT',
        scripts('my-app'),
        upload({ main_module: 'index.js', bindings: [] }),
      ],
      [
        'POST',
        `${scripts('my-app')}/deployments`,
        JSON.stringify({
          strategy: 'percentage',
          versions: [{ version_id: versionId, percentage: 100 }],
        }),
      ],
      [
        'POST',
        `${scripts('my-app')}/subdomain`,
        JSON.stringify({ enabled: false }),
      ],
      [
        'PUT',
        `${scripts('my-app')}/schedules`,
        JSON.stringify([{ cron: '0 0 * * *' }]),
      ],
      [
        'PATCH',
        `${scripts('my-app')}/script-settings`,
        JSON.stringify({ observability: { enabled: false } }),
      ],
    ] as const) {
      const response = await call(session, path, { method, body });
      expect([path, response.status]).toEqual([path, 403]);
      expect(await refusedFor(response)).toContain('uploads a preview');
    }
    expect(fx.state.live).toBe(live);
    expect(fx.state.route['my-app']).toEqual({
      enabled: true,
      previews_enabled: true,
    });
    // A Worker without a Durable Object has an address for each version. It is reported
    // also when Cloudflare can't be asked about the Worker's bindings just then.
    fx.state.fail = { match: /GET .*\/settings$/, status: 500, code: 10000 };
    const done = await finish(id, session);
    expect(done.body.result).toMatchObject({
      preview: true,
      versionId,
      url: null,
      previewUrl: `https://${versionId.slice(0, 8)}-my-app.test-account.workers.dev`,
    });
    expect(done.body.result).not.toHaveProperty('previewNote');
    expect(fx.state.fail).toBeNull();
  });

  it('sends production only to the version the deploy uploaded', async () => {
    const { id } = await deployed();
    const earlier = fx.state.live!;
    const session = (await open(id, simple, { production: true })).body;
    const deploy = (versions: unknown) =>
      call(session, `${scripts('my-app')}/deployments`, {
        method: 'POST',
        body: JSON.stringify({ strategy: 'percentage', versions }),
      });
    // Before anything is uploaded, and to a version this deploy didn't make.
    expect(
      (await deploy([{ version_id: earlier, percentage: 100 }])).status,
    ).toBe(403);
    const version = await call(session, `${scripts('my-app')}/versions`, {
      method: 'POST',
      body: upload({
        main_module: 'index.js',
        bindings: [{ name: 'DB', type: 'inherit' }],
      }),
    });
    const versionId = ((await version.json()) as { result: { id: string } })
      .result.id;
    for (const versions of [
      [{ version_id: earlier, percentage: 100 }],
      [
        { version_id: versionId, percentage: 50 },
        { version_id: earlier, percentage: 50 },
      ],
      [{ version_id: versionId, percentage: 10 }],
    ])
      expect((await deploy(versions)).status).toBe(403);
    expect(fx.state.live).toBe(earlier);
    expect(
      (await deploy([{ version_id: versionId, percentage: 100 }])).status,
    ).toBe(200);
    expect(fx.state.live).toBe(versionId);
    // Settings that send data elsewhere, and schedules beyond the plan, are refused.
    const patch = (body: unknown) =>
      call(session, `${scripts('my-app')}/script-settings`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    expect((await patch({ tail_consumers: [{ service: 'spy' }] })).status).toBe(
      403,
    );
    expect((await patch({ logpush: true })).status).toBe(403);
    expect(
      (await patch({ observability: { logs: { destinations: ['siem'] } } }))
        .status,
    ).toBe(403);
    expect(
      (await patch({ observability: { enabled: false }, tags: [] })).status,
    ).toBe(200);
    const schedules = (body: unknown) =>
      call(session, `${scripts('my-app')}/schedules`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    expect((await schedules([{ cron: 'not a cron' }])).status).toBe(400);
    expect((await schedules(Array(6).fill({ cron: '0 0 * * *' }))).status).toBe(
      400,
    );
    expect((await schedules([{ cron: '0 0 * * *' }])).status).toBe(200);
    // A change carries no query string to Cloudflare; a read keeps its own.
    await call(session, `${scripts('my-app')}/schedules?force=true`, {
      method: 'PUT',
      body: JSON.stringify([{ cron: '5 0 * * *' }]),
    });
    expect(fx.state.calls.at(-1)!.path).toBe(`${scripts('my-app')}/schedules`);
    const listed = await call(
      session,
      `${scripts('my-app')}/deployments?per_page=5`,
    );
    expect(fx.state.calls.at(-1)!.path).toBe(
      `${scripts('my-app')}/deployments?per_page=5`,
    );
    // Of a deployment, Wrangler gets which versions serve: not who deployed or their notes.
    const deployments = await listed.text();
    expect(JSON.parse(deployments).result.deployments[0]).toEqual({
      id: '50000000-0000-4000-8000-000000000001',
      source: 'wrangler',
      strategy: 'percentage',
      versions: [{ version_id: versionId, percentage: 100 }],
    });
    expect(deployments).not.toMatch(/owner@example\.com|private note/);
  });

  it('respects a configuration that turns logs off or previews off', async () => {
    const config = {
      ...simple,
      observability: { enabled: false },
      preview_urls: false,
    };
    const id = await project();
    const session = (await open(id, config)).body;
    await call(session, scripts('my-app'), {
      method: 'PUT',
      body: upload({ main_module: 'index.js', bindings: [] }),
    });
    expect(
      fx.state.workers.get('my-app')!.metadata.observability,
    ).toBeUndefined();
    await call(session, `${scripts('my-app')}/subdomain`, {
      method: 'POST',
      headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' },
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
    expect(fx.state.route['my-app']).toEqual({
      enabled: true,
      previews_enabled: false,
    });
    await call(session, `${scripts('my-app')}/script-settings`, {
      method: 'PATCH',
      body: JSON.stringify({ observability: { enabled: false }, tags: [] }),
    });
    expect(fx.state.settings['my-app'].observability).toEqual({
      enabled: false,
    });
  });

  it('never replaces a Worker it didn’t create', async () => {
    fx.state.workers.set('my-app', blank());
    const id = await project();
    const refused = await open(id, simple);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(
      'A Worker named my-app already exists',
    );
    // Created in Cloudflare by someone else between the review and the upload.
    fx.state.workers.delete('my-app');
    const session = (await open(id, simple)).body;
    fx.state.workers.set('my-app', { ...blank(), metadata: { theirs: true } });
    const put = await call(session, scripts('my-app'), {
      method: 'PUT',
      body: upload({ main_module: 'index.js', bindings: [] }),
    });
    expect(put.status).toBe(409);
    expect(fx.state.workers.get('my-app')!.metadata).toEqual({ theirs: true });
    // An empty Worker left by someone's upload session isn't this project's either.
    fx.state.workers.delete('my-app');
    fx.state.placeholders.add('my-app');
    const other = await project('second-app');
    expect(
      (await open(other, simple, { workerName: 'my-app' })).body.error,
    ).toContain('already exists');
  });

  it('uses what a stopped deploy created instead of failing on the name', async () => {
    const id = await project();
    const stopped = (await open(id, simple)).body;
    await call(stopped, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'my-app-db' }),
    });
    const uuid = fx.state.d1[0].uuid;
    const failed = await finish(id, stopped, true);
    expect(failed.status).toBe(409);
    expect(failed.body.error).toContain('It had created my-app-db');
    expect(
      db.sqlite.prepare('SELECT status FROM project_operations').all(),
    ).toEqual([{ status: 'needs_attention' }]);
    const session = (await open(id, simple)).body;
    const again = await call(session, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'my-app-db' }),
    });
    expect(await again.json()).toMatchObject({
      success: true,
      result: { name: 'my-app-db', uuid },
    });
    expect(fx.state.d1).toHaveLength(1);
    // Bound like one made in this deploy.
    const put = await call(session, scripts('my-app'), {
      method: 'PUT',
      body: upload({
        main_module: 'index.js',
        bindings: [{ name: 'DB', type: 'd1', id: uuid }],
      }),
    });
    expect(put.status).toBe(200);
    // Deleted in Cloudflare since: a new one is made.
    const next = await project('next-app');
    const first = (await open(next, simple)).body;
    await call(first, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'next-app-db' }),
    });
    await finish(next, first, true);
    fx.state.d1 = fx.state.d1.filter((d) => d.name !== 'next-app-db');
    const second = (await open(next, simple)).body;
    const fresh = await call(second, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'next-app-db' }),
    });
    expect(fresh.status).toBe(200);
    expect(fx.state.d1.map((d) => d.name)).toContain('next-app-db');
    // What a deploy recorded under another Cloudflare account is not handed to this one:
    // Cloudflare is asked, and decides (in this test, that the name is taken).
    const moved = await project('moved-app');
    const before = (await open(moved, simple)).body;
    await call(before, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'moved-app-db' }),
    });
    await finish(moved, before, true);
    db.sqlite
      .prepare('UPDATE local_deploys SET account_id=? WHERE id=?')
      .run('b'.repeat(32), before.id);
    const after = (await open(moved, simple)).body;
    const asked = await call(after, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'moved-app-db' }),
    });
    expect(asked.status).toBe(400);
    expect(fx.state.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { name: 'moved-app-db' },
    });
  });
});

describe('opening a deploy', () => {
  const simple = {
    name: 'repo-name',
    main: 'src/index.js',
    compatibility_date: '2026-10-07',
  };
  const plan = async (
    files: Record<string, string | null>,
    projectId?: string,
  ) =>
    (await (
      await request(
        projectId ? `/projects/${projectId}/local-plan` : '/local-plan',
        'POST',
        { files },
      )
    ).json()) as {
      framework: string | null;
      adapter: string;
      buildCommand: string;
      issues: string[];
      warnings: string[];
      create?: { name: string }[];
      first?: boolean;
      workerName?: string;
      error?: string;
    };

  it('reviews a folder like a repository, without what only Cloudflare’s builds need', async () => {
    // pnpm, a workspace member and no committed lockfile are fine on a computer.
    const reviewed = await plan({
      'package.json': JSON.stringify({
        scripts: { build: 'vite build' },
        packageManager: 'pnpm@10.2.0',
        workspaces: ['packages/*'],
        dependencies: { hono: '^4.0.0' },
      }),
      'pnpm-lock.yaml': 'present',
      'wrangler.jsonc': JSON.stringify({
        ...simple,
        main: '@tanstack/react-start/server-entry',
        minify: true,
        upload_source_maps: true,
        services: [{ binding: 'SELF', service: 'repo-name' }],
        d1_databases: [{ binding: 'DB' }],
      }),
    });
    expect(reviewed).toMatchObject({
      framework: 'hono',
      adapter: 'configured-worker',
      buildCommand: 'pnpm run build',
      issues: [],
    });
    expect(reviewed.warnings.join(' ')).toContain(
      'in your Cloudflare account during the deploy',
    );
    expect(reviewed.warnings.join(' ')).not.toMatch(
      /build token|trusted repositories/,
    );
    // A plain Worker needs no package.json.
    expect(
      (await plan({ 'wrangler.json': JSON.stringify(simple) })).issues,
    ).toEqual([]);
    // What isn't deployed is named.
    const unsupported = await plan({
      'wrangler.jsonc': JSON.stringify({
        ...simple,
        routes: ['example.com/*'],
        queues: { producers: [] },
        services: [{ binding: 'API', service: 'another' }],
      }),
    });
    expect(unsupported.issues.join(' ')).toContain(
      'these Wrangler settings yet: routes, queues',
    );
    expect(unsupported.issues.join(' ')).toContain(
      'only point to this Worker itself',
    );
    expect(
      (await plan({ 'wrangler.toml': 'present' })).issues.join(' '),
    ).toContain('Shipcel reads wrangler.json or wrangler.jsonc');
    expect(
      (
        await plan({
          'wrangler.jsonc': JSON.stringify({ ...simple, workers_dev: false }),
        })
      ).issues.join(' '),
    ).toContain('shipcel unpublish');
    expect(
      (
        await plan({
          'wrangler.jsonc': JSON.stringify({
            ...simple,
            containers: [{ class_name: 'C', image: './Dockerfile' }],
          }),
        })
      ).issues,
    ).toEqual([expect.stringContaining('shipcel git connect')]);
    // Next.js with OpenNext builds with its adapter, under the configured name.
    const next = await plan({
      'package.json': JSON.stringify({
        scripts: { build: 'next build' },
        dependencies: { next: '16.3.8', '@opennextjs/cloudflare': '1.20.9' },
      }),
      'yarn.lock': 'present',
      'open-next.config.ts': 'export default {}',
      'wrangler.jsonc': JSON.stringify({
        name: 'shop',
        main: '.open-next/worker.js',
        compatibility_date: '2026-10-07',
        compatibility_flags: ['nodejs_compat'],
        assets: { directory: '.open-next/assets', binding: 'ASSETS' },
        services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shop' }],
      }),
    });
    expect(next).toMatchObject({
      framework: 'nextjs',
      adapter: 'nextjs',
      buildCommand: 'npx opennextjs-cloudflare build',
      workerName: 'shop',
      issues: [],
    });
    // Namespaces and buckets that already exist aren't attached either.
    expect(
      (
        await plan({
          'wrangler.jsonc': JSON.stringify({
            ...simple,
            kv_namespaces: [{ binding: 'CACHE', id: 'a'.repeat(32) }],
            r2_buckets: [{ binding: 'FILES', bucket_name: 'uploads' }],
          }),
        })
      ).issues,
    ).toEqual([
      'Shipcel can’t deploy the R2 buckets the way the Wrangler configuration declares them. It creates what an app needs and can’t attach one that already exists yet: give each entry only "binding", without bucket_name, five at most.',
      'Shipcel can’t deploy the KV namespaces the way the Wrangler configuration declares them. It creates what an app needs and can’t attach one that already exists yet: give each entry only "binding", without id, five at most.',
    ]);
    // What OpenNext can't run yet stops a folder before it deploys: the versions npm
    // locked, and a setting in next.config, which the review of a folder reads.
    const stopped = await plan({
      'package.json': JSON.stringify({
        scripts: { build: 'next build' },
        dependencies: { next: '16.4.0', '@opennextjs/cloudflare': '1.20.10' },
      }),
      'package-lock.json': JSON.stringify({
        packages: {
          'node_modules/next': { version: '16.4.0' },
          'node_modules/@opennextjs/cloudflare': { version: '1.20.10' },
        },
      }),
      'next.config.ts':
        'export default { cacheComponents: true, partialPrefetching: true };',
      'open-next.config.ts': 'export default {}',
      'wrangler.jsonc': JSON.stringify({
        name: 'shop',
        main: '.open-next/worker.js',
        compatibility_date: '2026-10-07',
        assets: { directory: '.open-next/assets', binding: 'ASSETS' },
        services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shop' }],
      }),
    });
    expect(stopped.issues).toEqual([
      expect.stringContaining(
        'update OpenNext (npm install @opennextjs/cloudflare@latest)',
      ),
      expect.stringContaining(
        'Remove cacheComponents (and partialPrefetching, which needs it)',
      ),
    ]);
    // Without the adapter installed, the configuration decides (a static export).
    expect(
      await plan({
        'package.json': JSON.stringify({
          scripts: { build: 'next build' },
          dependencies: { next: '16.3.8' },
        }),
        'wrangler.jsonc': JSON.stringify({
          name: 'docs',
          compatibility_date: '2026-10-07',
          assets: { directory: 'out' },
        }),
      }),
    ).toMatchObject({
      adapter: 'configured-worker',
      buildCommand: 'npm run build',
      issues: [],
    });
    // Only the files a review reads are accepted, and no more than a megabyte of them.
    expect(
      (await request('/local-plan', 'POST', { files: { '.env': 'SECRET=1' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await request('/local-plan', 'POST', {
          files: { 'package.json': 'x'.repeat(1_100_000) },
        })
      ).status,
    ).toBe(413);
  });

  it('says what a deploy would create, for a new app and for one that exists', async () => {
    const id = await project();
    const config = {
      ...simple,
      d1_databases: [{ binding: 'DB' }],
      kv_namespaces: [{ binding: 'MY_CACHE' }],
    };
    const before = await plan(filesOf(config), id);
    expect(before).toMatchObject({
      first: true,
      workerName: 'my-app',
      create: [
        { type: 'd1', binding: 'DB', name: 'my-app-db' },
        { type: 'kv', binding: 'MY_CACHE', name: 'my-app-my-cache' },
      ],
    });
    // Creating them is a choice the person confirms.
    const unconfirmed = await open(id, config, { confirmResources: false });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toContain('my-app-db, my-app-my-cache');
    expect(db.sqlite.prepare('SELECT 1 FROM local_deploys').all()).toEqual([]);
    const session = (await open(id, config)).body;
    await call(session, scripts('my-app'), {
      method: 'PUT',
      body: upload({ main_module: 'index.js', bindings: [] }),
    });
    await finish(id, session);
    fx.state.workers
      .get('my-app')!
      .bindings.push({ name: 'DB', type: 'd1', id: 'x' });
    expect(await plan(filesOf(config), id)).toMatchObject({
      first: false,
      create: [{ type: 'kv', binding: 'MY_CACHE', name: 'my-app-my-cache' }],
    });
    // The next deploy may create what was agreed to, not what the app already has.
    const next = (await open(id, config, { production: true })).body;
    const again = await call(next, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'my-app-db' }),
    });
    expect(again.status).toBe(403);
    const cache = await call(
      next,
      `/accounts/${account}/storage/kv/namespaces`,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'my-app-my-cache' }),
      },
    );
    expect(cache.status).toBe(200);
    // A review reads framework configurations as text, and only small ones.
    expect(
      (
        await request('/local-plan', 'POST', {
          files: { 'vite.config.ts': '/*'.repeat(25_001) },
        })
      ).status,
    ).toBe(400);
  });

  it('refuses what the project can’t do', async () => {
    // Free-only projects never get R2.
    const id = await project();
    const bucket = await open(id, {
      ...simple,
      r2_buckets: [{ binding: 'FILES' }],
    });
    expect(bucket.status).toBe(409);
    expect(bucket.body.error).toContain('Free-only');
    // A viewer, and someone from another workspace.
    const viewer = await db.user(2, 'viewer');
    db.sqlite
      .prepare('INSERT INTO memberships VALUES (?,?,?)')
      .run(who.workspaceId, viewer.userId, 'viewer');
    db.sqlite
      .prepare('UPDATE sessions SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, viewer.userId);
    expect((await open(id, simple, {}, viewer.cookie)).status).toBe(403);
    const stranger = await db.user(3);
    expect((await open(id, simple, {}, stranger.cookie)).status).toBe(404);
    // Deployments switched off on this Shipcel.
    db.env.NATIVE_BUILDS_ENABLED = 'false';
    expect((await open(id, simple)).status).toBe(503);
    db.env.NATIVE_BUILDS_ENABLED = 'true';
    // A name that can't be a Worker's.
    const named = await open(id, simple, { workerName: 'Not Valid' });
    expect(named.body.error).toContain('can’t be an app name');
    // A project Cloudflare builds from GitHub.
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,idempotency_key,created_at,updated_at,adapter) VALUES ('j',?,?,?,'g','g',?,'1','ada/site','main','c','t','git-app','','deployed','k',1,1,'configured-worker')",
      )
      .run(who.workspaceId, id, who.userId, account);
    expect((await open(id, simple)).body.error).toContain(
      'deploys from GitHub',
    );
    expect(fx.state.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('runs one deploy of a project at a time, and takes over an abandoned one', async () => {
    const id = await project();
    const config = { ...simple, d1_databases: [{ binding: 'DB' }] };
    const first = (await open(id, config)).body;
    const busy = await open(id, config);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain(
      'Another deploy of this project is in progress',
    );
    // Its computer went away two minutes ago, after creating the database.
    await call(first, `/accounts/${account}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: 'my-app-db' }),
    });
    db.sqlite
      .prepare('UPDATE project_operations SET updated_at=updated_at-121')
      .run();
    const second = await open(id, config);
    expect(second.status).toBe(201);
    expect(
      (await call(first, `/accounts/${account}/workers/subdomain`)).status,
    ).toBe(401);
    expect(
      db.sqlite
        .prepare(
          'SELECT status, error FROM project_operations ORDER BY created_at, rowid',
        )
        .all(),
    ).toMatchObject([
      {
        status: 'needs_attention',
        error: expect.stringContaining('It had created my-app-db'),
      },
      { status: 'running' },
    ]);
    // A deploy whose hour ran out is closed with the next one, and Cloudflare's sealed
    // upload token with it.
    const other = await project('other-app');
    const stale = (await open(other, simple)).body;
    await call(stale, `${scripts('other-app')}/assets-upload-session`, {
      method: 'POST',
      body: JSON.stringify({
        manifest: { '/index.html': { hash: 'b'.repeat(32), size: 1 } },
      }),
    });
    const row = () =>
      db.sqlite
        .prepare(
          'SELECT status, upload_token IS NULL AS cleared FROM local_deploys WHERE id=?',
        )
        .get(stale.id);
    expect(row()).toEqual({ status: 'open', cleared: 0 });
    db.sqlite
      .prepare('UPDATE local_deploys SET expires_at=1 WHERE id=?')
      .run(stale.id);
    // The same request twice starts nothing new, even after the first has ended.
    const key = crypto.randomUUID();
    await finish(id, second.body, true);
    const body = {
      requestId: key,
      confirm: true,
      files: filesOf(config),
      confirmResources: true,
    };
    const started = await request(
      `/projects/${id}/local-deploys`,
      'POST',
      body,
    );
    expect(started.status).toBe(201);
    await finish(id, (await started.json()) as Opened, true);
    const again = await request(`/projects/${id}/local-deploys`, 'POST', body);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe(
      'This deploy was already started. Start a new one.',
    );
    expect(row()).toEqual({ status: 'failed', cleared: 1 });
    const operations = (projectId: string) =>
      db.sqlite
        .prepare(
          'SELECT status, error FROM project_operations WHERE project_id=? ORDER BY created_at, rowid',
        )
        .all(projectId);
    // Its operation ended with it, so the project isn't left busy.
    expect(operations(other)).toEqual([
      {
        status: 'failed',
        error:
          'The deploy from a computer stopped before anything changed in Cloudflare.',
      },
    ]);
    // The empty Worker that stale deploy's file upload left is this project's own:
    // another deploy from the computer can start the app, and so can a folder of files.
    const retry = await open(other, simple);
    expect(retry.status).toBe(201);
    // A deploy that uploaded the app and never reported back is closed as what it was.
    await call(retry.body, scripts('other-app'), {
      method: 'PUT',
      body: upload({ main_module: 'index.js', bindings: [] }),
    });
    db.sqlite
      .prepare('UPDATE local_deploys SET expires_at=1 WHERE id=?')
      .run(retry.body.id);
    expect((await open(id, config)).status).toBe(201);
    expect(operations(other).at(-1)).toEqual({
      status: 'needs_attention',
      error: expect.stringMatching(
        /^The deploy from a computer uploaded version [0-9a-f]{8} and then stopped reporting back, so this project’s history doesn’t list it\. Production serves it\.$/,
      ),
    });
    // A folder of files can start an app whose only trace is that empty Worker.
    const third = await project('third-app');
    const begun = (await open(third, simple)).body;
    await call(begun, `${scripts('third-app')}/assets-upload-session`, {
      method: 'POST',
      body: JSON.stringify({
        manifest: { '/index.html': { hash: 'c'.repeat(32), size: 1 } },
      }),
    });
    await finish(third, begun, true);
    const files = await request(`/projects/${third}/uploads`, 'POST', {
      files: [{ path: '/index.html', hash: 'c'.repeat(32), size: 1 }],
    });
    expect(files.status).toBe(201);
  });

  it('keeps a folder of files from replacing an app, and reports a deploy that uploaded nothing', async () => {
    const id = await project();
    const session = (await open(id, simple)).body;
    const nothing = await finish(id, session);
    expect(nothing.status).toBe(409);
    expect(nothing.body.error).toContain(
      'before anything changed in Cloudflare',
    );
    expect(
      db.sqlite.prepare('SELECT status FROM project_operations').all(),
    ).toEqual([{ status: 'failed' }]);
    const again = (await open(id, simple)).body;
    await call(again, scripts('my-app'), {
      method: 'PUT',
      body: upload({ main_module: 'index.js', bindings: [] }),
    });
    // Wrangler stopped after the upload: the app is deployed, and someone should look.
    const done = await finish(id, again, true);
    expect(done.status).toBe(200);
    expect(
      db.sqlite
        .prepare(
          'SELECT status FROM project_operations ORDER BY created_at, rowid',
        )
        .all()
        .at(-1),
    ).toEqual({ status: 'needs_attention' });
    // Asked twice, the recorded result comes back.
    expect((await finish(id, again)).body.result).toMatchObject({
      versionId: done.body.result!.versionId,
    });
    // The app exists now. A deploy of it that uploads nothing changed nothing...
    const idle = (await open(id, simple, { production: true })).body;
    const unchanged = await finish(id, idle);
    expect(unchanged.status).toBe(409);
    expect(unchanged.body.error).toContain(
      'before anything changed in Cloudflare',
    );
    // ...and one that uploaded a version without sending production to it says so.
    const half = (await open(id, simple, { production: true })).body;
    const version = await call(half, `${scripts('my-app')}/versions`, {
      method: 'POST',
      body: upload({ main_module: 'index.js', bindings: [] }),
    });
    const versionId = ((await version.json()) as { result: { id: string } })
      .result.id;
    const waiting = await finish(id, half);
    expect(waiting.status).toBe(409);
    expect(waiting.body.error).toBe(
      `Wrangler uploaded version ${versionId.slice(0, 8)}, but production still serves the previous one. Deploy again, or make it production: shipcel promote ${versionId.slice(0, 8)}.`,
    );
    expect(
      db.sqlite
        .prepare(
          'SELECT status FROM project_operations ORDER BY created_at, rowid',
        )
        .all()
        .slice(-2),
    ).toEqual([{ status: 'failed' }, { status: 'needs_attention' }]);
    expect(fx.state.live).toBe(done.body.result!.versionId);
    const files = await request(`/projects/${id}/uploads`, 'POST', {
      files: [{ path: '/index.html', hash: 'a'.repeat(32), size: 1 }],
    });
    expect(files.status).toBe(409);
    expect(((await files.json()) as { error: string }).error).toContain(
      'Wrangler deploys: run shipcel in its folder',
    );
  });
});

describe('OpenNext’s cache, filled after a Next.js deploy', () => {
  const bucket = 'shop-next-inc-cache-r2-bucket';
  const nextConfig = {
    name: 'shop',
    main: '.open-next/worker.js',
    compatibility_date: '2026-10-07',
    compatibility_flags: ['nodejs_compat'],
    assets: { directory: '.open-next/assets', binding: 'ASSETS' },
    services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shop' }],
    r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET' }],
    durable_objects: {
      bindings: [{ name: 'NEXT_CACHE_DO_QUEUE', class_name: 'DOQueueHandler' }],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['DOQueueHandler'] }],
  };
  const nextFiles = () => ({
    'package.json': JSON.stringify({
      scripts: { build: 'next build' },
      dependencies: { next: '16.4.2', '@opennextjs/cloudflare': '1.20.14' },
    }),
    'wrangler.jsonc': JSON.stringify(nextConfig),
    'open-next.config.ts': `import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
export default defineCloudflareConfig({ incrementalCache: r2IncrementalCache, queue: doQueue });`,
  });
  type Cached = Opened & {
    cache?: { bucket: string; prefix: string };
    error?: string;
  };
  async function openNext(id: string, extra: Record<string, unknown> = {}) {
    const response = await request(
      `/projects/${id}/local-deploys`,
      'POST',
      confirm({ files: nextFiles(), confirmResources: true, ...extra }),
    );
    return {
      status: response.status,
      body: (await response.json()) as Cached,
    };
  }
  // R2 can bill: an owner turns Free-only off before an app may have a bucket.
  async function billable(name = 'shop') {
    const id = await project(name);
    expect(
      (
        await request(`/projects/${id}/free-only`, 'PUT', {
          freeOnly: false,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    return id;
  }
  const object = (b: string, key: string) =>
    `/accounts/${account}/r2/buckets/${b}/objects/${key}`;
  const key = `incremental-cache/Kj3x_build-1/${'a'.repeat(64)}.cache`;
  const entry = '{"value":{"kind":"APP_PAGE","html":"<h1>hi</h1>"}}';
  const fill = (session: Opened, k = key, b = bucket) =>
    call(session, object(b, k), { method: 'PUT', body: entry });
  // What Wrangler does for the app: the bucket on its first deploy, then the upload.
  async function upload(session: Opened, first = true) {
    if (first)
      expect(
        (
          await call(session, `/accounts/${account}/r2/buckets`, {
            method: 'POST',
            body: JSON.stringify({ name: bucket }),
          })
        ).status,
      ).toBe(200);
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        main_module: 'index.js',
        bindings: [
          first
            ? {
                name: 'NEXT_INC_CACHE_R2_BUCKET',
                type: 'r2_bucket',
                bucket_name: bucket,
              }
            : { name: 'NEXT_INC_CACHE_R2_BUCKET', type: 'inherit' },
          {
            name: 'NEXT_CACHE_DO_QUEUE',
            type: 'durable_object_namespace',
            class_name: 'DOQueueHandler',
          },
          { name: 'WORKER_SELF_REFERENCE', type: 'service', service: 'shop' },
        ],
        ...(first
          ? {
              migrations: {
                new_tag: 'v1',
                steps: [{ new_sqlite_classes: ['DOQueueHandler'] }],
              },
            }
          : {}),
      }),
    );
    form.set(
      'index.js',
      new File(['export default {}'], 'index.js', {
        type: 'application/javascript+module',
      }),
    );
    expect(
      (await call(session, scripts('shop'), { method: 'PUT', body: form }))
        .status,
    ).toBe(200);
  }

  it('lets a production deploy fill its own cache bucket, at OpenNext’s keys, and nothing else', async () => {
    const id = await billable();
    const { status, body: session } = await openNext(id);
    expect(status).toBe(201);
    expect(session.cache).toEqual({ bucket, prefix: 'incremental-cache' });
    // Nothing is filled before the app's own upload has made it live.
    expect(await refusedFor(await fill(session))).toContain('uploaded');
    await upload(session);
    const fetched = `incremental-cache/Kj3x_build-1/${'b'.repeat(64)}.fetch`;
    expect((await fill(session)).status).toBe(200);
    expect((await fill(session, fetched)).status).toBe(200);
    expect([...fx.state.objects]).toEqual([
      [`${bucket}/${key}`, entry],
      [`${bucket}/${fetched}`, entry],
    ]);
    // Only that bucket, and only OpenNext's keys under its prefix.
    const before = fx.state.calls.length;
    for (const [b, k] of [
      ['shop-files', key],
      [bucket, 'notes/private.txt'],
      [bucket, `incremental-cache/Kj3x_build-1/${'a'.repeat(63)}.cache`],
      [bucket, `incremental-cache/Kj3x.build/${'a'.repeat(64)}.cache`],
      [bucket, `incremental-cache/Kj3x_build-1/${'a'.repeat(64)}.json`],
      [bucket, `other-prefix/Kj3x_build-1/${'a'.repeat(64)}.cache`],
    ] as const) {
      const response = await fill(session, k, b);
      expect([b, k, response.status]).toEqual([b, k, 403]);
    }
    expect(fx.state.calls.length).toBe(before);
    expect((await finish(id, session)).status).toBe(200);

    // The next production deploy keeps the bucket and fills it again.
    const again = (await openNext(id, { production: true })).body;
    expect(again.cache).toEqual({ bucket, prefix: 'incremental-cache' });
    await upload(again, false);
    expect((await fill(again)).status).toBe(200);
    expect((await finish(id, again)).status).toBe(200);
    // A bucket of that name Shipcel didn't make for this project is left alone.
    db.sqlite.prepare("UPDATE local_deploys SET created_json='[]'").run();
    const third = (await openNext(id, { production: true })).body;
    await upload(third, false);
    expect(await refusedFor(await fill(third))).toContain('didn’t create');
    expect((await finish(id, third)).status).toBe(200);

    // A preview shares production's bucket: it fills nothing.
    const preview = await openNext(id);
    expect(preview.body.production).toBe(false);
    expect(preview.body.cache).toBeUndefined();
    expect(await refusedFor(await fill(preview.body))).toContain('preview');
  });

  it('keeps an app that isn’t Next.js out of a bucket with that name', async () => {
    const id = await billable();
    const { body: session } = await open(id, {
      name: 'shop',
      main: 'src/index.js',
      compatibility_date: '2026-10-07',
      r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET' }],
    });
    expect((session as Cached).cache).toBeUndefined();
    expect(
      (
        await call(session, `/accounts/${account}/r2/buckets`, {
          method: 'POST',
          body: JSON.stringify({ name: bucket }),
        })
      ).status,
    ).toBe(200);
    const put = await call(session, scripts('shop'), {
      method: 'PUT',
      body: (() => {
        const form = new FormData();
        form.set(
          'metadata',
          JSON.stringify({
            main_module: 'index.js',
            bindings: [
              {
                name: 'NEXT_INC_CACHE_R2_BUCKET',
                type: 'r2_bucket',
                bucket_name: bucket,
              },
            ],
          }),
        );
        form.set(
          'index.js',
          new File(['export default {}'], 'index.js', {
            type: 'application/javascript+module',
          }),
        );
        return form;
      })(),
    });
    expect(put.status).toBe(200);
    expect(await refusedFor(await fill(session))).toContain('Next.js');
    expect(fx.state.objects.size).toBe(0);
  });
});

describe('what an upload may contain', () => {
  it("takes Workers' rate limiter as Wrangler declares it, and nothing else under that type", () => {
    const limiter = (change: object) =>
      uploadProblems(
        {
          bindings: [
            {
              name: 'LIMITER',
              type: 'ratelimit',
              namespace_id: '1001',
              simple: { limit: 100, period: 60 },
              ...change,
            },
          ],
        },
        'my-app',
        [],
      );
    expect(limiter({})).toEqual([]);
    expect(limiter({ simple: { limit: 10, period: 10 } })).toEqual([]);
    for (const bad of [
      { namespace_id: 'abc' },
      { namespace_id: 1001 },
      { simple: { limit: 100, period: 30 } },
      { simple: { limit: 0, period: 60 } },
      { simple: { limit: 100, period: 60, burst: 5 } },
      { simple: undefined },
      { other: 1 },
    ])
      expect(limiter(bad), JSON.stringify(bad)).toEqual([
        expect.stringContaining('LIMITER is a ratelimit binding'),
      ]);
  });

  it('lets an app send email through Cloudflare’s Email Service, by binding name only', () => {
    const upload = (binding: Record<string, unknown>) =>
      uploadProblems(
        { main_module: 'index.js', bindings: [{ name: 'EMAIL', ...binding }] },
        'my-app',
        [],
      );
    expect(upload({ type: 'send_email' })).toEqual([]);
    expect(
      upload({ type: 'send_email', destination_address: 'a@b.example' }),
    ).toHaveLength(1);
  });

  it('accepts what Wrangler sends for a reviewed app', () => {
    expect(
      uploadProblems(
        {
          main_module: 'index.js',
          bindings: [
            { name: 'MODE', type: 'plain_text', text: 'production' },
            { name: 'RETRIES', type: 'json', json: 3 },
            { name: 'CACHE', type: 'inherit' },
            { name: 'AI', type: 'ai' },
            { name: 'BROWSER', type: 'browser' },
            { name: 'IMAGES', type: 'images' },
            { name: 'VERSION', type: 'version_metadata' },
            { name: 'ASSETS', type: 'assets' },
            { name: 'DB', type: 'd1', id: 'one' },
            {
              name: 'LIMITER',
              type: 'ratelimit',
              namespace_id: '1001',
              simple: { limit: 100, period: 60 },
            },
          ],
          compatibility_date: '2026-10-07',
          compatibility_flags: ['nodejs_compat'],
          migrations: {
            old_tag: 'v1',
            new_tag: 'v2',
            steps: [
              {
                renamed_classes: [{ from: 'A', to: 'B' }],
                deleted_classes: ['C'],
              },
            ],
          },
          code_update_strategy: { mode: 'deferred', max_delay: 300 },
          keep_bindings: ['secret_text', 'secret_key', 'plain_text', 'json'],
          assets: {
            jwt: 'x',
            config: { not_found_handling: 'single-page-application' },
          },
          observability: { enabled: true },
          placement: { mode: 'smart' },
          limits: { cpu_ms: 50 },
          annotations: { 'workers/message': 'x' },
          logpush: false,
          tail_consumers: [],
          keep_assets: true,
        },
        'my-app',
        [{ type: 'd1', name: 'my-app-db', id: 'one' }],
      ),
    ).toEqual([]);
    expect(uploadProblems(null, 'my-app', [])).toHaveLength(1);
    expect(uploadProblems({ bindings: 'x' }, 'my-app', [])).toHaveLength(1);
    // An ID of the right kind only: a namespace ID is not a database.
    expect(
      uploadProblems(
        { bindings: [{ name: 'DB', type: 'd1', id: 'one' }] },
        'my-app',
        [{ type: 'kv', name: 'my-app-db', id: 'one' }],
      ),
    ).toHaveLength(1);
    expect(
      uploadProblems(
        {
          bindings: [{ type: 'ai' }, null, { name: 'X', type: 'ai', extra: 1 }],
        },
        'my-app',
        [],
      ),
    ).toHaveLength(3);
  });
});
