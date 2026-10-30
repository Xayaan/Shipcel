import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';
import { backendVersion } from '../worker/generated/backend';

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const account = 'a'.repeat(32),
  appTag = 'c'.repeat(32),
  backendTag = 'f'.repeat(32),
  databaseId = '50000000-0000-4000-8000-000000000005',
  // The app's own D1 database, which the data API reaches.
  appDatabaseId = '60000000-0000-4000-8000-000000000006';
const app = 'cc-test-app-worker',
  backend = 'cc-test-app-worker-backend';
let remote: DatabaseSync;
let appData: DatabaseSync;
let backendScript: {
  tag: string;
  created_on: string;
  migration_tag?: string;
} | null;
let existingDatabases: { uuid: string; name: string; created_at: string }[];
let failUpload: number;
let failCreate: number;
let databaseGone: boolean;
// The service Worker's bindings as Cloudflare would report them, and an upload whose
// response is lost after Cloudflare stored the Worker.
let backendBindings: { name: string; type: string; text?: string }[];
let loseUploadResponse: number;
const calls: { url: string; method: string; body?: BodyInit | null }[] = [];
const uploads: Record<string, unknown>[] = [];
const secrets: { script: string; name: string; text: string }[] = [];
const cf = (result: unknown) => Response.json({ success: true, result });
const input = (values: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  confirm: true,
  ...values,
});
const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = who.cookie,
) =>
  db.request(
    `/projects/${projectId}${path}`,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    cookie,
  );

// D1's HTTP API: one statement with optional params, or several statements as a batch.
function d1(sql: string, params: unknown[] = [], on = remote) {
  try {
    const single = sql.trim().replace(/;\s*$/, '');
    if (!single.includes(';')) {
      const statement = on.prepare(single);
      const results = /^(select|pragma)/i.test(single)
        ? statement.all(...(params as never[]))
        : (statement.run(...(params as never[])), []);
      return cf([{ results, success: true }]);
    }
    if (params.length) throw new Error('params with several statements');
    remote.exec('BEGIN');
    try {
      remote.exec(sql);
      remote.exec('COMMIT');
    } catch (error) {
      remote.exec('ROLLBACK');
      throw error;
    }
    return cf([{ results: [], success: true }]);
  } catch (error) {
    return Response.json(
      {
        success: false,
        errors: [{ code: 7500, message: (error as Error).message }],
        result: null,
      },
      { status: 400 },
    );
  }
}

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput('shop')) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const job: Record<string, unknown> = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: account,
    repository_id: '50',
    repository_name: 'alice/shop',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: app,
    build_command: '',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: appTag,
    trigger_uuid: crypto.randomUUID(),
    live_url: `https://${app}.test-account.workers.dev/`,
  };
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${Object.keys(job).join(',')}) VALUES (${Object.keys(
        job,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...(Object.values(job) as string[]));
  remote = new DatabaseSync(':memory:');
  appData = new DatabaseSync(':memory:');
  backendScript = null;
  existingDatabases = [];
  failUpload = 0;
  failCreate = 0;
  databaseGone = false;
  backendBindings = [];
  loseUploadResponse = 0;
  calls.length = 0;
  uploads.length = 0;
  secrets.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(raw));
      const path = url.pathname,
        method = init.method || 'GET';
      calls.push({ url: url.toString(), method, body: init.body });
      if (path.endsWith('/workers/scripts') && method === 'GET')
        return cf([
          { id: app, tag: appTag },
          ...(backendScript ? [{ id: backend, tag: backendScript.tag }] : []),
        ]);
      if (path.endsWith('/workers/subdomain'))
        return cf({ subdomain: 'test-account' });
      if (path.endsWith(`/workers/services/${backend}`))
        return backendScript
          ? cf({ default_environment: { script: backendScript } })
          : Response.json(
              {
                success: false,
                errors: [{ code: 10090, message: 'not found' }],
              },
              { status: 404 },
            );
      if (path.endsWith('/d1/database') && method === 'GET') {
        const name = url.searchParams.get('name');
        return cf(existingDatabases.filter((d) => !name || d.name === name));
      }
      if (path.endsWith('/d1/database') && method === 'POST') {
        const { name } = JSON.parse(String(init.body));
        existingDatabases.push({
          uuid: databaseId,
          name,
          created_at: new Date().toISOString(),
        });
        // The database exists, but the response never arrives.
        if (failCreate > 0) {
          failCreate--;
          throw new Error('Connection reset');
        }
        return cf({ uuid: databaseId, name });
      }
      if (path.endsWith(`/d1/database/${databaseId}`) && method === 'DELETE') {
        existingDatabases = existingDatabases.filter(
          (d) => d.uuid !== databaseId,
        );
        return cf(null);
      }
      const gone = () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 7404, message: 'database not found' }],
          },
          { status: 404 },
        );
      if (databaseGone && path.includes(`/d1/database/${databaseId}`))
        return gone();
      if (path.endsWith(`/d1/database/${databaseId}/query`)) {
        const body = JSON.parse(String(init.body));
        return d1(body.sql, body.params);
      }
      if (path.endsWith(`/d1/database/${appDatabaseId}/query`)) {
        const body = JSON.parse(String(init.body));
        return d1(body.sql, body.params, appData);
      }
      if (path.endsWith(`/workers/scripts/${app}/settings`))
        return cf({
          bindings: [{ name: 'DB', type: 'd1', id: appDatabaseId }],
        });
      if (path.endsWith(`/workers/scripts/${backend}`) && method === 'PUT') {
        if (failUpload > 0) {
          failUpload--;
          throw new Error('Upload interrupted');
        }
        const form = init.body as FormData;
        const metadata = JSON.parse(String(form.get('metadata')));
        uploads.push(metadata);
        expect(await (form.get('index.js') as Blob).text()).toContain(
          'shipcel-backend',
        );
        backendScript = {
          tag: backendTag,
          created_on: new Date().toISOString(),
          migration_tag: 'v1',
        };
        backendBindings = (
          metadata.bindings as { name: string; type: string; text?: string }[]
        ).map((b) =>
          b.type === 'secret_text' ? { name: b.name, type: b.type } : b,
        );
        if (loseUploadResponse > 0) {
          loseUploadResponse--;
          throw new Error('Connection reset');
        }
        return cf({ id: backend, tag: backendTag });
      }
      if (path.endsWith(`/workers/scripts/${backend}/settings`))
        return backendScript
          ? cf({ bindings: backendBindings })
          : Response.json(
              {
                success: false,
                errors: [{ code: 10007, message: 'not found' }],
              },
              { status: 404 },
            );
      if (path.endsWith(`/workers/scripts/${backend}`) && method === 'DELETE') {
        backendScript = null;
        return cf(null);
      }
      if (path.endsWith(`/workers/scripts/${backend}/subdomain`))
        return cf({ enabled: true, previews_enabled: false });
      const secret = path.match(/\/workers\/scripts\/([^/]+)\/secrets$/);
      if (secret && method === 'PUT') {
        const body = JSON.parse(String(init.body));
        secrets.push({ script: secret[1], name: body.name, text: body.text });
        return cf({ name: body.name, type: 'secret_text' });
      }
      const removed = path.match(
        /\/workers\/scripts\/([^/]+)\/secrets\/([A-Z_]+)$/,
      );
      if (removed && method === 'DELETE')
        return secrets.some(
          (s) => s.script === removed[1] && s.name === removed[2],
        )
          ? cf(null)
          : Response.json(
              {
                success: false,
                errors: [{ code: 10056, message: 'secret not found' }],
              },
              { status: 404 },
            );
      throw new Error(`Unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  remote.close();
  appData.close();
  vi.unstubAllGlobals();
});

const enable = async () => {
  const response = await request('/backend', 'POST', input());
  return { response, body: (await response.json()) as Record<string, unknown> };
};

describe('sign-in and realtime service', () => {
  it('shows what turning it on will create before anything is created', async () => {
    const response = await request('/backend');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'off',
      latestVersion: backendVersion,
      plan: {
        workerName: backend,
        databaseName: `${backend}-db-…`,
        appSecrets: [
          'CLOUDCEL_AUTH_ISSUER',
          'CLOUDCEL_CLIENT_ID',
          'CLOUDCEL_REALTIME_URL',
          'CLOUDCEL_REALTIME_SECRET',
        ],
      },
    });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('creates the database, Worker and Durable Object class, and wires the app with no secrets in Shipcel', async () => {
    expect(
      (await request('/backend', 'POST', { requestId: crypto.randomUUID() }))
        .status,
    ).toBe(400);
    const { response, body } = await enable();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'succeeded',
      result: {
        url: `https://${backend}.test-account.workers.dev`,
        version: backendVersion,
      },
    });
    // The database name carries this setup's random suffix.
    const created = JSON.parse(
      String(
        calls.find(
          (c) => c.method === 'POST' && c.url.endsWith('/d1/database'),
        )!.body,
      ),
    );
    expect(created.name).toMatch(new RegExp(`^${backend}-db-[0-9a-f]{8}$`));
    const suffix = (
      db.sqlite
        .prepare('SELECT resource_suffix FROM project_backends')
        .get() as { resource_suffix: string }
    ).resource_suffix;
    expect(created.name).toBe(`${backend}-db-${suffix}`);
    const tables = remote
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all();
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'users',
        'passkeys',
        'identities',
        'codes',
        'refresh_tokens',
        'settings',
      ]),
    );
    const settings = Object.fromEntries(
      remote
        .prepare('SELECT key, value FROM settings')
        .all()
        .map((r) => [r.key, r.value]),
    );
    expect(settings).toMatchObject({
      app_name: 'shop',
      redirect_uris: JSON.stringify([
        `https://${app}.test-account.workers.dev/auth/callback`,
      ]),
      signin: 'on',
      realtime: 'on',
    });
    expect(settings.client_id).toMatch(/^cc_[\w-]{24}$/);
    const [metadata] = uploads as {
      bindings: {
        type: string;
        name: string;
        text?: string;
        id?: string;
        class_name?: string;
      }[];
      migrations?: unknown;
      keep_bindings?: string[];
    }[];
    expect(metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: 'd1', name: 'DB', id: databaseId },
        {
          type: 'durable_object_namespace',
          name: 'CHANNELS',
          class_name: 'Channel',
        },
        {
          type: 'plain_text',
          name: 'CLOUDCEL_BACKEND_VERSION',
          text: backendVersion,
        },
        {
          type: 'plain_text',
          name: 'CLOUDCEL_BACKEND_OWNER',
          text: `${projectId}:${suffix}`,
        },
        // Cloudflare's Email Service, for sign-in links; used once a sender address is set.
        { type: 'send_email', name: 'EMAIL' },
      ]),
    );
    expect(metadata.migrations).toEqual({
      new_tag: 'v1',
      steps: [{ new_sqlite_classes: ['Channel'] }],
    });
    const signingKey = JSON.parse(
      metadata.bindings.find((b) => b.name === 'SIGNING_KEY')!.text!,
    );
    expect(signingKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(signingKey.d).toBeTruthy();
    expect(signingKey.kid).toHaveLength(16);
    const realtimeSecret = metadata.bindings.find(
      (b) => b.name === 'REALTIME_SECRET',
    )!.text!;
    expect(
      calls.some((c) =>
        c.url.endsWith(`/workers/scripts/${backend}/subdomain`),
      ),
    ).toBe(true);
    expect(secrets.filter((s) => s.script === app)).toEqual([
      {
        script: app,
        name: 'CLOUDCEL_AUTH_ISSUER',
        text: `https://${backend}.test-account.workers.dev`,
      },
      { script: app, name: 'CLOUDCEL_CLIENT_ID', text: settings.client_id },
      {
        script: app,
        name: 'CLOUDCEL_REALTIME_URL',
        text: `wss://${backend}.test-account.workers.dev/realtime/channels/`,
      },
      { script: app, name: 'CLOUDCEL_REALTIME_SECRET', text: realtimeSecret },
    ]);
    const stored = JSON.stringify([
      db.sqlite.prepare('SELECT * FROM project_backends').all(),
      db.sqlite.prepare('SELECT * FROM project_operations').all(),
    ]);
    expect(stored).not.toContain(realtimeSecret);
    expect(stored).not.toContain(signingKey.d);
    const status = (await (await request('/backend')).json()) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({
      status: 'active',
      url: `https://${backend}.test-account.workers.dev`,
      clientId: settings.client_id,
      version: backendVersion,
      updateAvailable: false,
      settings: {
        appName: 'shop',
        signin: true,
        realtime: true,
        githubClientId: null,
      },
    });
  });

  it('continues an interrupted setup and adopts the database that attempt created', async () => {
    failUpload = 1;
    const first = await enable();
    expect(first.response.status).toBe(502);
    expect(
      ((await (await request('/backend')).json()) as { status: string }).status,
    ).toBe('needs_attention');
    const second = await enable();
    expect(second.response.status).toBe(200);
    expect(
      calls.filter(
        (c) => c.method === 'POST' && c.url.endsWith('/d1/database'),
      ),
    ).toHaveLength(1);
    expect(
      ((await (await request('/backend')).json()) as { status: string }).status,
    ).toBe('active');
    expect((await enable()).response.status).toBe(409);
  });

  it('continues setup much later and still adopts the database its first attempt created', async () => {
    failCreate = 1;
    expect((await enable()).response.status).toBe(502);
    expect(existingDatabases).toHaveLength(1);
    // The owner comes back an hour later.
    const began = now() - 3600;
    db.sqlite.prepare('UPDATE project_backends SET started_at=?').run(began);
    existingDatabases[0].created_at = new Date(
      (began + 1) * 1000,
    ).toISOString();
    const second = await enable();
    expect(second.response.status).toBe(200);
    expect(
      calls.filter(
        (c) => c.method === 'POST' && c.url.endsWith('/d1/database'),
      ),
    ).toHaveLength(1);
  });

  it('never adopts a database or Worker with the same name that Shipcel did not create', async () => {
    // A database with the service's plain name is someone else's: it is left alone.
    existingDatabases = [
      {
        uuid: '60000000-0000-4000-8000-000000000006',
        name: `${backend}-db`,
        created_at: new Date().toISOString(),
      },
    ];
    // A Worker that appeared with the service's name, without this setup's marker.
    backendScript = {
      tag: 'd'.repeat(32),
      created_on: new Date().toISOString(),
    };
    const worker = await enable();
    expect(worker.response.status).toBe(502);
    expect(worker.body.error).toContain(
      `A Worker named ${backend} already exists`,
    );
    expect(uploads).toEqual([]);
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.endsWith('/d1/database') &&
          String(c.body).includes(`"${backend}-db"`),
      ),
    ).toBe(false);
  });

  it('refuses a same-named Worker that appeared after setup began, and leaves it when removing', async () => {
    // Setup stops before its upload…
    failUpload = 1;
    expect((await enable()).response.status).toBe(502);
    // …and another app is deployed under the service's name before the owner continues.
    backendScript = {
      tag: 'e'.repeat(32),
      created_on: new Date().toISOString(),
    };
    backendBindings = [{ type: 'plain_text', name: 'GREETING', text: 'hi' }];
    const continued = await enable();
    expect(continued.response.status).toBe(502);
    expect(continued.body.error).toContain('Shipcel did not create it');
    expect(uploads).toEqual([]);
    const removed = await request(
      '/backend',
      'DELETE',
      input({ confirmName: backend }),
    );
    expect(removed.status).toBe(200);
    expect(
      calls.some(
        (c) =>
          c.method === 'DELETE' &&
          c.url.includes(`/workers/scripts/${backend}?`),
      ),
    ).toBe(false);
    expect(backendScript).not.toBeNull();
  });

  it('adopts its own Worker when an upload response was lost', async () => {
    loseUploadResponse = 1;
    expect((await enable()).response.status).toBe(502);
    // Cloudflare stored the Worker with this setup's marker; continuing adopts it.
    const second = await enable();
    expect(second.response.status).toBe(200);
    expect(
      (
        db.sqlite.prepare('SELECT worker_tag FROM project_backends').get() as {
          worker_tag: string;
        }
      ).worker_tag,
    ).toBe(backendTag);
  });

  it('refuses to set up when another Shipcel app in the account uses the name', async () => {
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,idempotency_key,created_at,updated_at) VALUES ('other-job',?,'other-project',?,'cf','gh',?,'7','alice/other','main',?,?,?,'','deployed','other-key',1,1)",
      )
      .run(
        who.workspaceId,
        who.userId,
        account,
        'c'.repeat(40),
        crypto.randomUUID(),
        backend,
      );
    const refused = await request('/backend', 'POST', input());
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'Another Shipcel app',
    );
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('writes secrets and code only to the recorded service Worker', async () => {
    await enable();
    secrets.length = 0;
    const githubInput = () =>
      input({ clientId: 'Iv1.abc', clientSecret: 'super-secret-value' });
    // Replaced outside Shipcel: same name, different Worker.
    backendScript = { ...backendScript!, tag: 'e'.repeat(32) };
    for (const [path, method, body] of [
      ['/backend/providers/github', 'PUT', githubInput()],
      ['/backend/providers/github', 'DELETE', input()],
      ['/backend/realtime-secret', 'POST', input()],
      ['/backend/update', 'POST', input()],
    ] as const)
      expect((await request(path, method, body)).status).toBe(409);
    // Deleted outside Shipcel: Install update must not recreate it without its secrets.
    backendScript = null;
    const update = await request('/backend/update', 'POST', input());
    expect(update.status).toBe(409);
    expect(((await update.json()) as { error: string }).error).toContain(
      'missing',
    );
    expect(
      (await request('/backend/realtime-secret', 'POST', input())).status,
    ).toBe(409);
    expect(secrets).toEqual([]);
    expect(uploads).toHaveLength(1);
  });

  it('saves settings and refuses return addresses that are not HTTPS', async () => {
    await enable();
    const settings = {
      appName: 'Shop',
      redirectUris: [
        'https://shop.example.com/auth/callback',
        'http://localhost:5173/auth/callback',
      ],
      logoutUris: ['https://shop.example.com/'],
      signin: true,
      realtime: false,
      // Sign-in by email: links sent from this address, and passwords allowed.
      emailFrom: 'sign-in@shop.example.com',
      password: true,
    };
    expect(
      (
        await request(
          '/backend/settings',
          'PUT',
          input({ ...settings, emailFrom: 'not an address' }),
        )
      ).status,
    ).toBe(400);
    const refused = await request(
      '/backend/settings',
      'PUT',
      input({ ...settings, redirectUris: ['http://shop.example.com/cb'] }),
    );
    expect(refused.status).toBe(400);
    expect(
      (await request('/backend/settings', 'PUT', input(settings))).status,
    ).toBe(200);
    const status = (await (await request('/backend')).json()) as {
      settings: Record<string, unknown>;
    };
    expect(status.settings).toMatchObject({ ...settings });
  });

  it('stores provider client secrets only as Worker secrets', async () => {
    await enable();
    secrets.length = 0;
    const saved = await request(
      '/backend/providers/github',
      'PUT',
      input({ clientId: 'Iv1.abc', clientSecret: 'super-secret-value' }),
    );
    expect(saved.status).toBe(200);
    expect(secrets).toEqual([
      {
        script: backend,
        name: 'GITHUB_CLIENT_SECRET',
        text: 'super-secret-value',
      },
    ]);
    expect(
      remote
        .prepare("SELECT value FROM settings WHERE key='github_client_id'")
        .get(),
    ).toEqual({ value: 'Iv1.abc' });
    expect(
      JSON.stringify(
        db.sqlite.prepare('SELECT * FROM project_operations').all(),
      ),
    ).not.toContain('super-secret-value');
    const removed = await request(
      '/backend/providers/github',
      'DELETE',
      input(),
    );
    expect(removed.status).toBe(200);
    expect(
      remote
        .prepare("SELECT value FROM settings WHERE key='github_client_id'")
        .get(),
    ).toBeUndefined();
    expect(
      calls.some(
        (c) =>
          c.method === 'DELETE' &&
          c.url.endsWith('/secrets/GITHUB_CLIENT_SECRET'),
      ),
    ).toBe(true);
  });

  it('lists users and disables or deletes them, ending their sessions', async () => {
    await enable();
    remote.exec(`
      INSERT INTO users (id,email,email_verified,name,disabled,created_at) VALUES ('user-aaaaaaaaaa','ada@example.com',1,'Ada',0,1);
      INSERT INTO identities (provider,subject,user_id,created_at) VALUES ('github','1','user-aaaaaaaaaa',1);
      INSERT INTO sessions (token_hash,user_id,auth_time,expires_at) VALUES ('h','user-aaaaaaaaaa',1,9999999999);
      INSERT INTO refresh_tokens (token_hash,family,user_id,client_id,scope,expires_at,revoked) VALUES ('r','f','user-aaaaaaaaaa','c','openid',9999999999,0);
    `);
    const listed = (await (await request('/backend/users')).json()) as {
      total: number;
      users: Record<string, unknown>[];
    };
    expect(listed.total).toBe(1);
    expect(listed.users[0]).toMatchObject({
      id: 'user-aaaaaaaaaa',
      email: 'ada@example.com',
      emailVerified: true,
      providers: ['github'],
      passkeys: 0,
      disabled: false,
    });
    expect(
      (await request('/backend/users/user-aaaaaaaaaa/disable', 'POST', input()))
        .status,
    ).toBe(200);
    expect(remote.prepare('SELECT disabled FROM users').get()).toEqual({
      disabled: 1,
    });
    expect(remote.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({
      n: 0,
    });
    expect(remote.prepare('SELECT revoked FROM refresh_tokens').get()).toEqual({
      revoked: 1,
    });
    expect(
      (await request("/backend/users/x'%20OR%201=1/delete", 'POST', input()))
        .status,
    ).toBe(400);
    expect(
      (await request('/backend/users/user-aaaaaaaaaa/delete', 'POST', input()))
        .status,
    ).toBe(200);
    expect(remote.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({
      n: 0,
    });
    expect(
      remote.prepare('SELECT COUNT(*) AS n FROM identities').get(),
    ).toEqual({ n: 0 });
  });

  it('rotates the realtime secret on the service and the app together', async () => {
    await enable();
    secrets.length = 0;
    expect(
      (await request('/backend/realtime-secret', 'POST', input())).status,
    ).toBe(200);
    expect(secrets.map((s) => [s.script, s.name])).toEqual([
      [backend, 'REALTIME_SECRET'],
      [app, 'CLOUDCEL_REALTIME_SECRET'],
    ]);
    expect(secrets[0].text).toBe(secrets[1].text);
  });

  it('updates the service code while keeping its keys and data', async () => {
    await enable();
    db.sqlite.prepare("UPDATE project_backends SET version='old'").run();
    expect(
      (
        (await (await request('/backend')).json()) as {
          updateAvailable: boolean;
        }
      ).updateAvailable,
    ).toBe(true);
    expect((await request('/backend/update', 'POST', input())).status).toBe(
      200,
    );
    const update = uploads[1] as {
      bindings: { type: string }[];
      keep_bindings: string[];
      migrations?: unknown;
    };
    expect(update.keep_bindings).toEqual(['secret_text']);
    expect(update.bindings.some((b) => b.type === 'secret_text')).toBe(false);
    expect(update.migrations).toBeUndefined();
    expect(
      (
        (await (await request('/backend')).json()) as {
          updateAvailable: boolean;
        }
      ).updateAvailable,
    ).toBe(false);
  });

  it('removes the service, its database and the app secrets once its name is typed', async () => {
    await enable();
    const deletes = () =>
      calls
        .filter((c) => c.method === 'DELETE')
        .map((c) => {
          const url = new URL(c.url);
          return (
            url.pathname.replace(`/client/v4/accounts/${account}`, '') +
            url.search
          );
        });
    const wrong = await request(
      '/backend',
      'DELETE',
      input({ confirmName: 'shop' }),
    );
    expect(wrong.status).toBe(400);
    expect(deletes()).toEqual([]);
    const removed = await request(
      '/backend',
      'DELETE',
      input({ confirmName: backend }),
    );
    expect(removed.status).toBe(200);
    expect(deletes()).toEqual([
      `/workers/scripts/${app}/secrets/CLOUDCEL_AUTH_ISSUER`,
      `/workers/scripts/${app}/secrets/CLOUDCEL_CLIENT_ID`,
      `/workers/scripts/${app}/secrets/CLOUDCEL_REALTIME_URL`,
      `/workers/scripts/${app}/secrets/CLOUDCEL_REALTIME_SECRET`,
      `/workers/scripts/${backend}?force=true`,
      `/d1/database/${databaseId}`,
    ]);
    expect(
      ((await (await request('/backend')).json()) as { status: string }).status,
    ).toBe('off');
    // Turning it on again starts fresh.
    expect((await enable()).response.status).toBe(200);
  });

  it('removes a setup that stopped part-way, skipping what was never created', async () => {
    failUpload = 1;
    expect((await enable()).response.status).toBe(502);
    const removed = await request(
      '/backend',
      'DELETE',
      input({ confirmName: backend }),
    );
    expect(removed.status).toBe(200);
    expect(existingDatabases).toEqual([]);
    expect(
      calls.some(
        (c) =>
          c.method === 'DELETE' &&
          c.url.includes(`/workers/scripts/${backend}?`),
      ),
    ).toBe(false);
    expect(
      ((await (await request('/backend')).json()) as { status: string }).status,
    ).toBe('off');
  });

  it('removes nothing when the service Worker was replaced outside Shipcel', async () => {
    await enable();
    backendScript = {
      tag: 'd'.repeat(32),
      created_on: new Date().toISOString(),
      migration_tag: 'v1',
    };
    const refused = await request(
      '/backend',
      'DELETE',
      input({ confirmName: backend }),
    );
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'replaced outside Shipcel',
    );
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(existingDatabases).toHaveLength(1);
  });

  it('still shows the service, and removes it, after its database was deleted in Cloudflare', async () => {
    await enable();
    databaseGone = true;
    const status = await request('/backend');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: 'active',
      settings: null,
      settingsError: expect.stringContaining('database not found'),
    });
    const removed = await request(
      '/backend',
      'DELETE',
      input({ confirmName: backend }),
    );
    expect(removed.status).toBe(200);
    expect(
      ((await (await request('/backend')).json()) as { status: string }).status,
    ).toBe('off');
  });

  it('opens tables of the app’s database to the data API, each with who may read and change it', async () => {
    await enable();
    appData.exec(
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id TEXT, body TEXT); CREATE TABLE _cf_KV (key TEXT)',
    );
    expect(await (await request('/backend/data')).json()).toEqual({
      binding: null,
      databases: ['DB'],
      tables: {},
      schema: { notes: ['id', 'user_id', 'body'] },
    });
    const notes = { read: 'owner', write: 'owner', owner: 'user_id' };
    const saved = await request(
      '/backend/data',
      'PUT',
      input({ binding: 'DB', tables: { notes } }),
    );
    expect(saved.status).toBe(200);
    // The service has the app's database as DATA, and the tables as a setting.
    const dataBinding = { type: 'd1', name: 'DATA', id: appDatabaseId };
    expect(uploads.at(-1)!.bindings).toContainEqual(dataBinding);
    const setting = () =>
      (
        remote
          .prepare("SELECT value FROM settings WHERE key='data_tables'")
          .get() as { value: string }
      ).value;
    expect(JSON.parse(setting())).toEqual({ notes });
    // Changing the tables only changes the setting; updating the service keeps the database.
    const uploaded = uploads.length;
    await request(
      '/backend/data',
      'PUT',
      input({ binding: 'DB', tables: { notes: { ...notes, read: 'public' } } }),
    );
    expect(uploads).toHaveLength(uploaded);
    await request('/backend/update', 'POST', input());
    expect(uploads.at(-1)!.bindings).toContainEqual(dataBinding);
    for (const [body, status] of [
      [
        {
          binding: 'DB',
          tables: { missing: { read: 'public', write: 'none' } },
        },
        409,
      ],
      [
        { binding: 'DB', tables: { notes: { ...notes, owner: 'author' } } },
        409,
      ],
      [
        { binding: 'DB', tables: { notes: { read: 'owner', write: 'none' } } },
        400,
      ],
      [
        {
          binding: 'DB',
          tables: { _cf_KV: { read: 'public', write: 'none' } },
        },
        400,
      ],
      [
        {
          binding: 'DB',
          tables: { notes: { read: 'public', write: 'public' } },
        },
        400,
      ],
      [
        { binding: 'DB', tables: { notes: { ...notes, write: 'signed-in' } } },
        400,
      ],
      [{ binding: 'OTHER', tables: {} }, 409],
    ] as const)
      expect([
        body,
        (await request('/backend/data', 'PUT', input(body))).status,
      ]).toEqual([body, status]);
    // An upload that fails while the database changes leaves every table closed.
    await request('/backend/data', 'PUT', input({ binding: null, tables: {} }));
    failUpload = 1;
    const interrupted = await request(
      '/backend/data',
      'PUT',
      input({ binding: 'DB', tables: { notes } }),
    );
    expect(interrupted.status).toBe(502);
    expect(setting()).toBe('{}');
    await request(
      '/backend/data',
      'PUT',
      input({ binding: 'DB', tables: { notes } }),
    );
    // Turned off, the service loses the database and every table.
    expect(
      (
        await request(
          '/backend/data',
          'PUT',
          input({ binding: null, tables: { notes } }),
        )
      ).status,
    ).toBe(200);
    expect(uploads.at(-1)!.bindings).not.toContainEqual(dataBinding);
    expect(setting()).toBe('{}');
  });

  it('is invisible to other workspaces and needs a deployed project', async () => {
    const other = await db.user(2);
    expect(
      (await request('/backend', 'GET', undefined, other.cookie)).status,
    ).toBe(404);
    db.sqlite.prepare('DELETE FROM deployment_jobs').run();
    expect((await request('/backend')).status).toBe(409);
  });
});
