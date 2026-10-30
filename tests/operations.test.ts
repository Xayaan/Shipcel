import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';
import { scheduledBuildScans, scheduledHealthChecks } from '../worker/health';

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const account = 'a'.repeat(32),
  tag = 'c'.repeat(32),
  zoneId = 'd'.repeat(32),
  domainId = 'dom_01HZ8Q6YK0M2N5P7R9T1V3X5Z7',
  versionId = '10000000-0000-4000-8000-000000000001',
  triggerId = '20000000-0000-4000-8000-000000000002',
  buildId = '30000000-0000-4000-8000-000000000003';
let workerTag: string,
  zoneAccount: string,
  existingDomains: Record<string, unknown>[],
  dnsRecords: unknown[],
  repoPush: boolean,
  failWrite: boolean,
  buildOutcome: string | null,
  homepage: number,
  activeVersion: string,
  secretNames: string[],
  buildRecords: Record<string, unknown>[] | null,
  extraScripts: { id: string; tag: string }[],
  // Two versions sharing traffic, when set; otherwise activeVersion serves 100%.
  activeSplit: { version_id: string; percentage: number }[] | null,
  schedules: string[],
  // Workers Builds variables per trigger UUID.
  buildVars: Record<
    string,
    Record<string, { value: string; is_secret: boolean }>
  >;
const secondVersion = '10000000-0000-4000-8000-000000000002';
const calls: {
  url: string;
  method: string;
  body?: BodyInit | null;
  headers: Headers;
}[] = [];
const cf = (result: unknown) => Response.json({ success: true, result });
const input = (values: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  confirm: true,
  ...values,
});
function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = who.cookie,
) {
  return db.request(
    `/projects/${projectId}${path}`,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    cookie,
  );
}
beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput()) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const fields = [
    'id',
    'workspace_id',
    'project_id',
    'created_by',
    'cf_grant_id',
    'gh_grant_id',
    'account_id',
    'repository_id',
    'repository_name',
    'branch',
    'commit_sha',
    'build_token_uuid',
    'worker_name',
    'build_command',
    'status',
    'idempotency_key',
    'created_at',
    'updated_at',
    'worker_tag',
    'trigger_uuid',
  ];
  const values = [
    crypto.randomUUID(),
    who.workspaceId,
    projectId,
    who.userId,
    'cf-original',
    'gh-original',
    account,
    '50',
    'alice/sample',
    'main',
    'b'.repeat(40),
    crypto.randomUUID(),
    'cc-test-app-worker',
    'npm run build',
    'deployed',
    crypto.randomUUID(),
    now(),
    now(),
    tag,
    triggerId,
  ];
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
    )
    .run(...values);
  calls.length = 0;
  workerTag = tag;
  zoneAccount = account;
  existingDomains = [];
  dnsRecords = [];
  repoPush = true;
  failWrite = false;
  buildOutcome = 'success';
  homepage = 200;
  activeVersion = versionId;
  secretNames = ['API_KEY'];
  buildRecords = null;
  extraScripts = [];
  activeSplit = null;
  schedules = ['0 3 * * *'];
  buildVars = {
    [triggerId]: {
      API_URL: { value: 'https://api.example', is_secret: false },
      NPM_TOKEN: { value: 'npm-secret-value', is_secret: true },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = String(raw),
        path = new URL(url).pathname,
        method = init.method || 'GET';
      calls.push({
        url,
        method,
        body: init.body,
        headers: new Headers(init.headers),
      });
      if (method !== 'GET' && failWrite)
        throw new Error('Provider write interrupted');
      if (path.endsWith('/workers/scripts'))
        return cf([
          { id: 'cc-test-app-worker', tag: workerTag },
          ...extraScripts,
        ]);
      if (path.endsWith('/settings'))
        return cf({
          bindings: [
            {
              name: 'DB',
              type: 'd1',
              id: '40000000-0000-4000-8000-000000000004',
            },
            { name: 'API_KEY', type: 'secret_text', text: 'never-return-this' },
            {
              name: 'PUBLIC_NAME',
              type: 'plain_text',
              text: 'also-never-return',
            },
          ],
        });
      const vars = path.match(
        /\/builds\/triggers\/([^/]+)\/environment_variables(?:\/([^/]+))?$/,
      );
      if (vars) {
        const [, trigger, key] = vars;
        const list = (buildVars[trigger] ??= {});
        if (method === 'PATCH')
          Object.assign(list, JSON.parse(String(init.body)) as typeof list);
        if (method === 'DELETE') delete list[decodeURIComponent(key)];
        // Cloudflare never returns secret values.
        return cf(
          Object.fromEntries(
            Object.entries(list).map(([name, v]) => [
              name,
              {
                created_on: '2026-10-08T00:00:00Z',
                is_secret: v.is_secret,
                value: v.is_secret ? null : v.value,
              },
            ]),
          ),
        );
      }
      if (path.endsWith('/schedules')) {
        if (method === 'PUT')
          schedules = (JSON.parse(String(init.body)) as { cron: string }[]).map(
            (s) => s.cron,
          );
        return cf({
          schedules: schedules.map((cron) => ({
            cron,
            created_on: '2026-10-08T00:00:00Z',
            modified_on: '2026-10-08T00:00:00Z',
          })),
        });
      }
      if (path.endsWith('/secrets'))
        return method === 'GET'
          ? cf(
              secretNames.map((name) => ({
                name,
                type: 'secret_text',
                text: 'provider-should-not-echo',
              })),
            )
          : cf({ name: 'API_KEY', type: 'secret_text' });
      if (path.includes('/secrets/')) return cf(null);
      if (path.endsWith('/versions'))
        return cf({
          items: [
            {
              id: versionId,
              number: 1,
              metadata: { created_on: '2026-10-07T00:00:00Z' },
              annotations: {
                'workers/message': 'release',
                'private-field': 'never-send',
              },
            },
          ],
        });
      if (path.endsWith(`/versions/${versionId}`))
        return cf({ id: versionId, number: 1 });
      if (path.endsWith(`/versions/${secondVersion}`))
        return cf({ id: secondVersion, number: 2 });
      if (path.includes('/versions/')) return new Response('', { status: 404 });
      if (path.endsWith('/deployments'))
        return method === 'GET'
          ? cf({
              deployments: [
                {
                  id: '50000000-0000-4000-8000-000000000005',
                  created_on: new Date().toISOString(),
                  versions: activeSplit ?? [
                    { version_id: activeVersion, percentage: 100 },
                  ],
                },
              ],
            })
          : cf({ id: '50000000-0000-4000-8000-000000000005' });
      if (path.includes('/builds/builds/'))
        return cf({
          build_uuid: path.split('/').pop(),
          build_outcome: buildOutcome,
        });
      if (path.endsWith('/workers/subdomain'))
        return cf({ subdomain: 'test-account' });
      if (new URL(url).hostname.endsWith('.test-account.workers.dev'))
        return new Response('App content', { status: homepage });
      if (path.includes('/builds/workers/'))
        return cf(
          buildRecords ?? [
            {
              build_uuid: buildId,
              build_outcome: 'success',
              branch: 'main',
              created_at: '2026-10-07T00:00:00Z',
              secret: 'never-send',
            },
          ],
        );
      if (path.endsWith('/builds') && path.includes('/triggers/'))
        return cf({ build_uuid: buildId });
      if (url === 'https://api.github.com/repos/alice/sample')
        return Response.json({
          id: 50,
          name: 'sample',
          full_name: 'alice/sample',
          default_branch: 'main',
          private: true,
          permissions: { push: repoPush },
          owner: { id: 1, login: 'alice' },
        });
      if (url === 'https://api.github.com/repos/alice/sample/commits/main')
        return Response.json({ sha: 'f'.repeat(40) });
      if (path === '/client/v4/zones')
        return cf([
          {
            id: zoneId,
            name: 'example.com',
            status: 'active',
            account: { id: zoneAccount },
          },
        ]);
      if (path === `/client/v4/zones/${zoneId}`)
        return cf({
          id: zoneId,
          name: 'example.com',
          status: 'active',
          account: { id: zoneAccount },
        });
      if (path.endsWith('/dns_records')) return cf(dnsRecords);
      if (path.endsWith('/workers/domains'))
        return method === 'GET'
          ? cf(existingDomains)
          : cf({
              id: domainId,
              hostname: 'app.example.com',
              service: 'cc-test-app-worker',
              environment: 'production',
              zone_id: zoneId,
            });
      if (path.includes('/workers/domains/')) return cf(null);
      throw new Error(`Unexpected provider URL ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('project operation authorization', () => {
  it('rejects every operation and metadata route across workspaces before calling providers', async () => {
    const bob = await db.user(2);
    for (const [path, method, body] of [
      ['/operations', 'GET', undefined],
      ['/cloud', 'GET', undefined],
      ['/secrets', 'GET', undefined],
      ['/secrets', 'PUT', input({ name: 'API_KEY', value: 'test-secret' })],
      ['/versions', 'GET', undefined],
      ['/rollback', 'POST', input({ versionId })],
      ['/builds', 'GET', undefined],
      ['/redeploy', 'POST', input()],
      ['/domains', 'GET', undefined],
      ['/zones', 'GET', undefined],
      ['/domains', 'POST', input({ hostname: 'app.example.com', zoneId })],
    ] as const)
      expect((await request(path, method, body, bob.cookie)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not operate on a replaced Worker even if its name matches', async () => {
    workerTag = 'f'.repeat(32);
    expect(
      (
        await request(
          '/secrets',
          'PUT',
          input({ name: 'API_KEY', value: 'test-secret' }),
        )
      ).status,
    ).toBe(409);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
  it('requires the original account and an enabled cloud switch', async () => {
    db.env.NATIVE_BUILDS_ENABLED = 'false';
    expect((await request('/redeploy', 'POST', input())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    db.env.NATIVE_BUILDS_ENABLED = 'true';
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET account_id=? WHERE provider='cloudflare'",
      )
      .run('f'.repeat(32));
    expect((await request('/cloud')).status).toBe(409);
  });
  it('blocks a member from reading provider data or mutating secrets', async () => {
    db.sqlite
      .prepare("UPDATE memberships SET role='viewer' WHERE user_id=?")
      .run(who.userId);
    expect((await request('/cloud')).status).toBe(403);
    expect(
      (
        await request(
          '/secrets',
          'PUT',
          input({ name: 'API_KEY', value: 'value' }),
        )
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation for production mutations', async () => {
    expect(
      (
        await request('/secrets', 'PUT', {
          name: 'API_KEY',
          value: 'value',
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('secrets and operation journal', () => {
  it('filters binding values and secret values from reads', async () => {
    const cloud = await (await request('/cloud')).text();
    expect(cloud).toContain('DB');
    expect(cloud).not.toContain('never-return');
    const secrets = await (await request('/secrets')).text();
    expect(secrets).not.toContain('provider-should-not-echo');
  });
  it('writes a secret once without storing or returning the value and replays safely', async () => {
    const data = input({ name: 'API_KEY', value: 'fixture-sensitive-value' });
    const result = await request('/secrets', 'PUT', data);
    expect(result.status).toBe(200);
    expect(await result.text()).not.toContain('fixture-sensitive-value');
    expect((await request('/secrets', 'PUT', data)).status).toBe(200);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(
      JSON.stringify(
        db.sqlite.prepare('SELECT * FROM project_operations').all(),
      ),
    ).not.toContain('fixture-sensitive-value');
    expect(await (await request('/operations')).json()).toMatchObject([
      { kind: 'secret.set:API_KEY', status: 'succeeded' },
    ]);
  });
  it('refuses to reinterpret an idempotency key as another operation', async () => {
    const data = input({ name: 'FIRST_KEY', value: 'one' });
    await request('/secrets', 'PUT', data);
    expect(
      (await request('/secrets', 'PUT', { ...data, name: 'SECOND_KEY' }))
        .status,
    ).toBe(409);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
  it('records uncertain writes without retrying them automatically', async () => {
    const data = input({ name: 'API_KEY', value: 'fixture-sensitive-value' });
    failWrite = true;
    const response = await request('/secrets', 'PUT', data);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('fixture-sensitive-value');
    failWrite = false;
    expect(await (await request('/secrets', 'PUT', data)).json()).toMatchObject(
      { status: 'needs_attention' },
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
  it('serializes concurrent operations on a project', async () => {
    const original = fetch;
    let release!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
        if (init.method === 'PUT')
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return original(raw, init);
      }),
    );
    const first = request(
      '/secrets',
      'PUT',
      input({ name: 'FIRST_KEY', value: 'one' }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(
      (
        await request(
          '/secrets',
          'PUT',
          input({ name: 'SECOND_KEY', value: 'two' }),
        )
      ).status,
    ).toBe(409);
    release(cf({ name: 'FIRST_KEY', type: 'secret_text' }));
    expect((await first).status).toBe(200);
  });
  it('turns interrupted operation records into needs_attention without provider writes', async () => {
    db.sqlite
      .prepare(
        "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,result_json,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'running',NULL,NULL,?,?)",
      )
      .run(
        'stale',
        who.workspaceId,
        projectId,
        who.userId,
        account,
        'secret.set:API_KEY',
        crypto.randomUUID(),
        now() - 200,
        now() - 200,
      );
    expect(await (await request('/operations')).json()).toMatchObject([
      { status: 'needs_attention' },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('domains, versions and builds', () => {
  it('rejects another account zone, mismatched hostname suffix, and existing DNS without writes', async () => {
    zoneAccount = 'f'.repeat(32);
    expect(
      (
        await request(
          '/domains',
          'POST',
          input({ hostname: 'app.example.com', zoneId }),
        )
      ).status,
    ).toBe(403);
    zoneAccount = account;
    expect(
      (
        await request(
          '/domains',
          'POST',
          input({ hostname: 'example.com.evil.test', zoneId }),
        )
      ).status,
    ).toBe(403);
    dnsRecords = [{ id: 'existing' }];
    expect(
      (
        await request(
          '/domains',
          'POST',
          input({ hostname: 'app.example.com', zoneId }),
        )
      ).status,
    ).toBe(409);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('does not take over another Worker hostname or detach its domain ID', async () => {
    existingDomains = [
      {
        id: domainId,
        hostname: 'app.example.com',
        service: 'another-worker',
        zone_id: zoneId,
      },
    ];
    expect(
      (
        await request(
          '/domains',
          'POST',
          input({ hostname: 'app.example.com', zoneId }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await request(`/domains/${domainId}`, 'DELETE', input())).status,
    ).toBe(404);
    expect(await (await request('/domains')).json()).toEqual([]);
  });
  it('attaches an unused verified hostname and records only safe metadata', async () => {
    expect(
      (
        await request(
          '/domains',
          'POST',
          input({ hostname: 'app.example.com', zoneId }),
        )
      ).status,
    ).toBe(200);
    const write = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(String(write.body))).toMatchObject({
      hostname: 'app.example.com',
      service: 'cc-test-app-worker',
      zone_id: zoneId,
    });
  });
  it('replays domain attach and detach after provider state has changed', async () => {
    const attach = input({ hostname: 'app.example.com', zoneId });
    const first = await (await request('/domains', 'POST', attach)).json();
    existingDomains = [
      {
        id: domainId,
        hostname: 'app.example.com',
        service: 'cc-test-app-worker',
        zone_id: zoneId,
      },
    ];
    const repeated = await request('/domains', 'POST', attach);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject(
      first as Record<string, unknown>,
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    const detach = input();
    const removed = await (
      await request(`/domains/${domainId}`, 'DELETE', detach)
    ).json();
    existingDomains = [];
    const repeatedRemoval = await request(
      `/domains/${domainId}`,
      'DELETE',
      detach,
    );
    expect(repeatedRemoval.status).toBe(200);
    expect(await repeatedRemoval.json()).toMatchObject(
      removed as Record<string, unknown>,
    );
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
  it('only promotes a version fetched under the owned Worker and does not force unsafe rollback', async () => {
    expect(
      (
        await request(
          '/rollback',
          'POST',
          input({ versionId: '60000000-0000-4000-8000-000000000006' }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await request('/rollback', 'POST', input({ versionId }))).status,
    ).toBe(200);
    const write = calls.find((c) => c.method === 'POST')!;
    expect(write.url).toContain(
      '/workers/scripts/cc-test-app-worker/deployments?force=false',
    );
    expect(JSON.parse(String(write.body)).versions).toEqual([
      { version_id: versionId, percentage: 100 },
    ]);
  });
  it('revalidates repository access and pins the new build commit', async () => {
    repoPush = false;
    expect((await request('/redeploy', 'POST', input())).status).toBe(403);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    repoPush = true;
    expect((await request('/redeploy', 'POST', input())).status).toBe(200);
    const write = calls.find((c) => c.method === 'POST')!;
    expect(write.url).toContain(`/builds/triggers/${triggerId}/builds`);
    expect(JSON.parse(String(write.body))).toEqual({
      branch: 'main',
      commit_hash: 'f'.repeat(40),
    });
  });
  it('maps real build/version metadata without returning arbitrary provider fields', async () => {
    const builds = await (await request('/builds')).text();
    expect(builds).toContain('created_at');
    expect(builds).not.toContain('never-send');
    const versions = await (await request('/versions')).text();
    expect(versions).toContain('release');
    expect(versions).not.toContain('private-field');
  });
});

describe('the deployment serving traffic', () => {
  it('marks the live version and reports the active deployment', async () => {
    const versions = (await (await request('/versions')).json()) as {
      id: string;
      live: number | null;
    }[];
    expect(versions).toEqual([
      expect.objectContaining({ id: versionId, live: 100 }),
    ]);
    activeVersion = '60000000-0000-4000-8000-000000000006';
    const after = (await (await request('/versions')).json()) as {
      live: number | null;
    }[];
    expect(after[0].live).toBeNull();
    expect(await (await request('/deployment')).json()).toEqual({
      id: '50000000-0000-4000-8000-000000000005',
      createdOn: expect.any(String),
      versions: [{ versionId: activeVersion, percentage: 100 }],
    });
  });
});

describe('build variables', () => {
  const set = (body: Record<string, unknown>) =>
    request('/build-variables', 'PUT', input(body));
  it('lists build variables without secret values', async () => {
    expect(
      await (await request('/build-variables?environment=production')).json(),
    ).toEqual({
      variables: [
        { name: 'API_URL', secret: false, value: 'https://api.example' },
        { name: 'NPM_TOKEN', secret: true, value: null },
      ],
    });
  });

  it('sets a variable on the production trigger after confirmation, never storing a secret', async () => {
    const response = await set({
      environment: 'production',
      name: 'SENTRY_TOKEN',
      value: 'very-secret-build-value',
      secret: true,
    });
    expect(response.status).toBe(200);
    const write = calls.find((c) => c.method === 'PATCH')!;
    expect(write.url).toContain(
      `/builds/triggers/${triggerId}/environment_variables`,
    );
    expect(JSON.parse(String(write.body))).toEqual({
      SENTRY_TOKEN: { value: 'very-secret-build-value', is_secret: true },
    });
    expect(await response.text()).not.toContain('very-secret-build-value');
    expect(
      JSON.stringify(
        db.sqlite.prepare('SELECT * FROM project_operations').all(),
      ),
    ).not.toContain('very-secret-build-value');
    expect(await (await request('/operations')).json()).toMatchObject([
      { kind: 'buildvar.set:SENTRY_TOKEN', status: 'succeeded' },
    ]);
  });

  it('removes a variable after confirmation', async () => {
    const response = await request(
      '/build-variables/API_URL',
      'DELETE',
      input({ environment: 'production' }),
    );
    expect(response.status).toBe(200);
    expect(calls.find((c) => c.method === 'DELETE')!.url).toContain(
      `/builds/triggers/${triggerId}/environment_variables/API_URL`,
    );
    expect(buildVars[triggerId].API_URL).toBeUndefined();
  });

  it('uses the preview trigger for branch previews', async () => {
    expect((await request('/build-variables?environment=preview')).status).toBe(
      409,
    );
    const previewTrigger = '30000000-0000-4000-8000-000000000009';
    db.sqlite
      .prepare(
        "INSERT INTO project_previews(project_id,workspace_id,account_id,worker_name,resource_suffix,trigger_uuid,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)",
      )
      .run(
        projectId,
        who.workspaceId,
        account,
        'cc-test-app-worker',
        'a1b2c3d4',
        previewTrigger,
        who.userId,
        now(),
        now(),
      );
    expect(
      (
        await set({
          environment: 'preview',
          name: 'API_URL',
          value: 'https://staging.example',
          secret: false,
        })
      ).status,
    ).toBe(200);
    expect(buildVars[previewTrigger]).toEqual({
      API_URL: { value: 'https://staging.example', is_secret: false },
    });
    expect(await (await request('/operations')).json()).toMatchObject([
      { kind: 'buildvar.set:API_URL@preview' },
    ]);
  });

  async function interruptedSet() {
    failWrite = true;
    const response = await set({
      environment: 'production',
      name: 'NEW_VAR',
      value: 'x',
      secret: true,
    });
    failWrite = false;
    expect(response.status).toBe(502);
    const { id } = (await response.json()) as { id: string };
    return async () =>
      (await (await request(`/operations/${id}/reconcile`, 'POST')).json()) as {
        status: string;
      };
  }
  it('reports an interrupted variable change Cloudflare did not apply', async () => {
    const reconcile = await interruptedSet();
    expect((await reconcile()).status).toBe('not_applied');
  });
  it('asks to set an interrupted secret variable again, since no value can be compared', async () => {
    const reconcile = await interruptedSet();
    buildVars[triggerId].NEW_VAR = { value: 'x', is_secret: true };
    expect((await reconcile()).status).toBe('needs_attention');
  });

  it('refuses bad names and values, and apps without Git builds', async () => {
    for (const body of [
      { name: '1BAD', value: 'x', secret: false },
      { name: 'OK', value: 'x'.repeat(5001), secret: false },
      { name: 'OK', value: '', secret: false },
    ])
      expect(
        (await set({ environment: 'production', ...body })).status,
        JSON.stringify(body).slice(0, 40),
      ).toBe(400);
    db.sqlite.prepare('UPDATE deployment_jobs SET trigger_uuid=NULL').run();
    expect(
      (
        await set({
          environment: 'production',
          name: 'OK',
          value: 'x',
          secret: false,
        })
      ).status,
    ).toBe(409);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('cron schedules', () => {
  it('lists the Worker’s schedules and replaces them after confirmation', async () => {
    expect(await (await request('/schedules')).json()).toEqual([
      {
        cron: '0 3 * * *',
        createdOn: '2026-10-08T00:00:00Z',
        modifiedOn: '2026-10-08T00:00:00Z',
      },
    ]);
    const response = await request(
      '/schedules',
      'PUT',
      input({ crons: ['*/30 * * * *', '0 9 * * MON-FRI'] }),
    );
    expect(response.status).toBe(200);
    const write = calls.find((c) => c.method === 'PUT')!;
    expect(write.url).toContain(
      '/workers/scripts/cc-test-app-worker/schedules',
    );
    expect(JSON.parse(String(write.body))).toEqual([
      { cron: '*/30 * * * *' },
      { cron: '0 9 * * MON-FRI' },
    ]);
    expect(await (await request('/operations')).json()).toMatchObject([
      { kind: 'schedules.set', status: 'succeeded' },
    ]);
    // Removing every schedule is allowed too.
    expect(
      (await request('/schedules', 'PUT', input({ crons: [] }))).status,
    ).toBe(200);
    expect(schedules).toEqual([]);
  });

  it('refuses malformed, repeated or too many schedules', async () => {
    for (const crons of [
      ['every minute'],
      ['* * * *'],
      ['* * * * *', '* * * * *'],
      Array.from({ length: 6 }, (_, i) => `${i} * * * *`),
    ])
      expect(
        (await request('/schedules', 'PUT', input({ crons }))).status,
        JSON.stringify(crons),
      ).toBe(400);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  async function interruptedSchedule() {
    failWrite = true;
    const response = await request(
      '/schedules',
      'PUT',
      input({ crons: ['*/5 * * * *'] }),
    );
    failWrite = false;
    expect(response.status).toBe(502);
    const { id } = (await response.json()) as { id: string };
    return async () =>
      (await (await request(`/operations/${id}/reconcile`, 'POST')).json()) as {
        status: string;
      };
  }
  it('reports an interrupted schedule change that Cloudflare did not apply', async () => {
    const reconcile = await interruptedSchedule();
    expect((await reconcile()).status).toBe('not_applied');
  });
  it('marks an interrupted schedule change as done when Cloudflare has it', async () => {
    const reconcile = await interruptedSchedule();
    schedules = ['*/5 * * * *'];
    expect((await reconcile()).status).toBe('succeeded');
  });
});

describe('traffic splitting between two versions', () => {
  const split = (versions: unknown) =>
    request('/traffic', 'POST', input({ versions }));
  const health = (id: string) =>
    db.sqlite
      .prepare('SELECT * FROM operation_health WHERE operation_id=?')
      .get(id) as Record<string, unknown> | undefined;
  const later = () =>
    db.sqlite
      .prepare('UPDATE operation_health SET checked_at=?')
      .run(now() - 30);
  const shares = [
    { versionId: secondVersion, percentage: 10 },
    { versionId, percentage: 90 },
  ];

  it('sends a share of traffic to a new version, both fetched under the owned Worker', async () => {
    const response = await split(shares);
    expect(response.status).toBe(200);
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toContain(
      '/workers/scripts/cc-test-app-worker/deployments?force=false',
    );
    expect(JSON.parse(String(writes[0].body))).toEqual({
      strategy: 'percentage',
      versions: [
        { version_id: secondVersion, percentage: 10 },
        { version_id: versionId, percentage: 90 },
      ],
      annotations: { 'workers/message': 'Traffic split from Shipcel' },
    });
    expect(await (await request('/operations')).json()).toMatchObject([
      {
        kind: `version.split:${secondVersion}@10,${versionId}@90`,
        status: 'succeeded',
      },
    ]);
  });

  it('refuses anything but two different versions sharing 100%', async () => {
    for (const versions of [
      [
        { versionId, percentage: 50 },
        { versionId, percentage: 50 },
      ],
      [
        { versionId: secondVersion, percentage: 10 },
        { versionId, percentage: 80 },
      ],
      [
        { versionId: secondVersion, percentage: 0 },
        { versionId, percentage: 100 },
      ],
      [{ versionId: secondVersion, percentage: 100 }],
    ]) {
      const response = await split(versions);
      expect(response.status).toBe(400);
    }
    // A version this Worker doesn't have.
    expect(
      (
        await split([
          {
            versionId: '60000000-0000-4000-8000-000000000006',
            percentage: 10,
          },
          { versionId, percentage: 90 },
        ])
      ).status,
    ).toBe(404);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('confirms the new version serves its share, then checks that version', async () => {
    const { id } = (await (await split(shares)).json()) as { id: string };
    expect(health(id)).toMatchObject({
      status: 'pending',
      target: `${secondVersion}@10`,
    });
    activeSplit = [
      { version_id: secondVersion, percentage: 10 },
      { version_id: versionId, percentage: 90 },
    ];
    later();
    await request(`/operations/${id}/health`, 'POST');
    expect(health(id)).toMatchObject({ status: 'healthy' });
    const probe = calls.find((c) => c.url.includes('.workers.dev'))!;
    expect(probe.headers.get('Cloudflare-Workers-Version-Overrides')).toBe(
      `cc-test-app-worker="${secondVersion}"`,
    );
  });

  it('does not attribute health to a split that was replaced', async () => {
    const { id } = (await (await split(shares)).json()) as { id: string };
    activeSplit = [
      { version_id: secondVersion, percentage: 50 },
      { version_id: versionId, percentage: 50 },
    ];
    later();
    await request(`/operations/${id}/health`, 'POST');
    expect(health(id)).toMatchObject({ status: 'unknown' });
  });

  it('checks an interrupted split against Cloudflare', async () => {
    failWrite = true;
    const response = await split(shares);
    failWrite = false;
    expect(response.status).toBe(502);
    const { id } = (await response.json()) as { id: string };
    const reconcile = () => request(`/operations/${id}/reconcile`, 'POST');
    expect(await (await reconcile()).json()).toMatchObject({
      status: 'not_applied',
    });
  });

  it('marks an interrupted split as done when Cloudflare serves it', async () => {
    failWrite = true;
    const { id } = (await (await split(shares)).json()) as { id: string };
    failWrite = false;
    activeSplit = [
      { version_id: secondVersion, percentage: 10 },
      { version_id: versionId, percentage: 90 },
    ];
    const reconciled = (await (
      await request(`/operations/${id}/reconcile`, 'POST')
    ).json()) as { status: string };
    expect(reconciled.status).toBe('succeeded');
    expect(health(id)).toMatchObject({
      status: 'pending',
      target: `${secondVersion}@10`,
    });
  });
});

describe('post-change health checks', () => {
  const health = (id: string) =>
    db.sqlite
      .prepare('SELECT * FROM operation_health WHERE operation_id=?')
      .get(id) as Record<string, unknown> | undefined;
  // Checks of one change are at least 20 seconds apart; move the last check back.
  const later = () =>
    db.sqlite
      .prepare('UPDATE operation_health SET checked_at=?')
      .run(now() - 30);
  const probes = () =>
    calls.filter((c) => c.url.includes('.workers.dev')).length;
  const check = (id: string, cookie = who.cookie) =>
    request(`/operations/${id}/health`, 'POST', undefined, cookie);
  async function start(path: '/redeploy' | '/rollback') {
    const response = await request(
      path,
      'POST',
      input(path === '/rollback' ? { versionId } : {}),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  }
  it('follows a redeploy build and records a healthy homepage', async () => {
    buildOutcome = null;
    const id = await start('/redeploy');
    expect(health(id)).toMatchObject({ status: 'pending', step: 'build' });
    expect((await check(id)).status).toBe(200);
    expect(health(id)).toMatchObject({ status: 'pending', step: 'build' });
    buildOutcome = 'success';
    later();
    await check(id);
    expect(health(id)).toMatchObject({ status: 'healthy' });
    expect(String(health(id)!.detail)).toContain('HTTP 200');
    expect(await (await request('/operations')).json()).toMatchObject([
      { id, kind: 'build.redeploy', health: 'healthy' },
    ]);
  });
  it('reports a failed build without probing the app', async () => {
    buildOutcome = 'fail';
    const id = await start('/redeploy');
    await check(id);
    expect(health(id)).toMatchObject({ status: 'build_failed' });
    expect(probes()).toBe(0);
  });
  it('confirms the promoted version is serving and waits before the first probe', async () => {
    const id = await start('/rollback');
    expect(health(id)).toMatchObject({ status: 'pending', step: 'probe' });
    await check(id);
    expect(probes()).toBe(0);
    later();
    await check(id);
    expect(health(id)).toMatchObject({ status: 'healthy' });
  });
  it('needs three failed probes before calling a change unhealthy, and never rolls back by itself', async () => {
    homepage = 503;
    expect(
      (
        await request('/notifications', 'PUT', {
          url: 'https://hooks.example.com/services/x',
          events: ['health.unhealthy'],
        })
      ).status,
    ).toBe(200);
    const id = await start('/rollback');
    for (const attempt of [1, 2]) {
      later();
      await check(id);
      expect(health(id)).toMatchObject({
        status: 'pending',
        attempts: attempt,
      });
    }
    later();
    await check(id);
    expect(health(id)).toMatchObject({ status: 'unhealthy', attempts: 3 });
    expect(String(health(id)!.detail)).toContain('HTTP 503');
    // The project's webhook hears about it once, when the check gives up.
    expect(
      db.sqlite.prepare('SELECT event FROM webhook_deliveries').all(),
    ).toEqual([{ event: 'health.unhealthy' }]);
    expect(probes()).toBe(3);
    expect(
      calls.filter(
        (c) => c.method === 'POST' && c.url.includes('/deployments'),
      ),
    ).toHaveLength(1);
  });
  it('does not attribute health to a version that is no longer serving', async () => {
    const id = await start('/rollback');
    activeVersion = '60000000-0000-4000-8000-000000000006';
    later();
    await check(id);
    expect(health(id)).toMatchObject({ status: 'unknown' });
    expect(String(health(id)!.detail)).toContain('Another deployment');
    expect(probes()).toBe(0);
  });
  it('stops tracking when the Cloudflare account changes', async () => {
    const id = await start('/rollback');
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET account_id=? WHERE provider='cloudflare'",
      )
      .run('f'.repeat(32));
    calls.length = 0;
    later();
    await check(id);
    expect(health(id)).toMatchObject({ status: 'unknown' });
    expect(calls).toEqual([]);
  });
  it('stops tracking a replaced Worker', async () => {
    const id = await start('/rollback');
    workerTag = 'f'.repeat(32);
    later();
    await check(id);
    expect(health(id)).toMatchObject({ status: 'unknown' });
    expect(probes()).toBe(0);
  });
  it('ends tracking after 45 minutes', async () => {
    buildOutcome = null;
    const id = await start('/redeploy');
    db.sqlite
      .prepare('UPDATE operation_health SET started_at=?, checked_at=?')
      .run(now() - 2701, now() - 30);
    await check(id);
    expect(health(id)).toMatchObject({ status: 'unknown' });
    expect(String(health(id)!.detail)).toContain('45 minutes');
  });
  it('advances pending checks from the scheduled handler', async () => {
    const id = await start('/redeploy');
    later();
    await scheduledHealthChecks(db.env);
    expect(health(id)).toMatchObject({ status: 'healthy' });
  });
  it('keeps health checks inside the workspace', async () => {
    const id = await start('/rollback');
    const bob = await db.user(2);
    later();
    expect((await check(id, bob.cookie)).status).toBe(404);
    expect(health(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
  it('does not track changes that have no deployment to check', async () => {
    const response = await request(
      '/secrets',
      'PUT',
      input({ name: 'API_KEY', value: 'one' }),
    );
    const { id } = (await response.json()) as { id: string };
    expect(health(id)).toBeUndefined();
  });
});

describe('recovery of interrupted operations', () => {
  const reconcile = (id: string, cookie = who.cookie) =>
    request(`/operations/${id}/reconcile`, 'POST', undefined, cookie);
  const operation = (id: string) =>
    db.sqlite
      .prepare('SELECT * FROM project_operations WHERE id=?')
      .get(id) as Record<string, unknown>;
  // Makes the provider write fail so the operation needs attention.
  async function interrupted(path: string, method: string, body: unknown) {
    failWrite = true;
    const response = await request(path, method, body);
    failWrite = false;
    expect(response.status).toBe(502);
    const { id } = (await response.json()) as { id: string };
    expect(operation(id).status).toBe('needs_attention');
    calls.length = 0;
    return id;
  }
  const outcome = async (id: string) => {
    const response = await reconcile(id);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      status: string;
      error: string | null;
      result: Record<string, unknown> | null;
    };
  };
  it('records operation parameters without secret values', async () => {
    const id = await interrupted(
      '/secrets',
      'PUT',
      input({ name: 'API_KEY', value: 'fixture-sensitive-value' }),
    );
    expect(String(operation(id).intent_json)).toContain('API_KEY');
    expect(String(operation(id).intent_json)).not.toContain(
      'fixture-sensitive-value',
    );
  });
  it('reports a secret that never reached Cloudflare as not applied', async () => {
    const id = await interrupted(
      '/secrets',
      'PUT',
      input({ name: 'NEW_KEY', value: 'value' }),
    );
    expect(await outcome(id)).toMatchObject({ status: 'not_applied' });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('says so when Cloudflare cannot confirm a secret value', async () => {
    const id = await interrupted(
      '/secrets',
      'PUT',
      input({ name: 'API_KEY', value: 'value' }),
    );
    const result = await outcome(id);
    expect(result.status).toBe('needs_attention');
    expect(result.error).toContain('never reveals');
  });
  it('confirms a secret removal that reached Cloudflare', async () => {
    const id = await interrupted('/secrets/API_KEY', 'DELETE', input());
    secretNames = [];
    expect(await outcome(id)).toMatchObject({ status: 'succeeded' });
  });
  it('reports a secret removal that did not happen as not applied', async () => {
    const id = await interrupted('/secrets/API_KEY', 'DELETE', input());
    expect(await outcome(id)).toMatchObject({ status: 'not_applied' });
  });
  it('confirms a domain attachment that reached Cloudflare', async () => {
    const id = await interrupted(
      '/domains',
      'POST',
      input({ hostname: 'app.example.com', zoneId }),
    );
    existingDomains = [
      {
        id: domainId,
        hostname: 'app.example.com',
        service: 'cc-test-app-worker',
        environment: 'production',
        zone_id: zoneId,
      },
    ];
    expect(await outcome(id)).toMatchObject({
      status: 'succeeded',
      result: { id: domainId, hostname: 'app.example.com' },
    });
  });
  it('flags a hostname that another Worker now holds', async () => {
    const id = await interrupted(
      '/domains',
      'POST',
      input({ hostname: 'app.example.com', zoneId }),
    );
    existingDomains = [
      {
        id: domainId,
        hostname: 'app.example.com',
        service: 'someone-else',
        zone_id: zoneId,
      },
    ];
    const result = await outcome(id);
    expect(result.status).toBe('needs_attention');
    expect(result.error).toContain('another Worker');
  });
  it('confirms a version promotion and starts its health check', async () => {
    const id = await interrupted('/rollback', 'POST', input({ versionId }));
    expect(await outcome(id)).toMatchObject({ status: 'succeeded' });
    expect(
      db.sqlite
        .prepare(
          'SELECT kind,target FROM operation_health WHERE operation_id=?',
        )
        .get(id),
    ).toMatchObject({ kind: 'promotion', target: versionId });
  });
  it('reports a promotion that is not serving as not applied', async () => {
    const id = await interrupted('/rollback', 'POST', input({ versionId }));
    activeVersion = '60000000-0000-4000-8000-000000000006';
    expect(await outcome(id)).toMatchObject({ status: 'not_applied' });
  });
  it('confirms a redeploy build for the recorded commit and starts its health check', async () => {
    const id = await interrupted('/redeploy', 'POST', input());
    buildRecords = [
      {
        build_uuid: buildId,
        trigger: { trigger_uuid: triggerId },
        build_trigger_metadata: { commit_hash: 'f'.repeat(40) },
        created_at: new Date().toISOString(),
      },
    ];
    expect(await outcome(id)).toMatchObject({
      status: 'succeeded',
      result: { buildId, commit: 'f'.repeat(40) },
    });
    expect(
      db.sqlite
        .prepare(
          'SELECT kind,target FROM operation_health WHERE operation_id=?',
        )
        .get(id),
    ).toMatchObject({ kind: 'build', target: buildId });
  });
  it('does not mistake an older build of the same commit for the interrupted redeploy', async () => {
    const id = await interrupted('/redeploy', 'POST', input());
    buildRecords = [
      {
        build_uuid: buildId,
        trigger: { trigger_uuid: triggerId },
        build_trigger_metadata: { commit_hash: 'f'.repeat(40) },
        created_at: new Date((now() - 86400) * 1000).toISOString(),
      },
    ];
    expect(await outcome(id)).toMatchObject({ status: 'not_applied' });
  });
  it('reports a redeploy that never started as not applied', async () => {
    const id = await interrupted('/redeploy', 'POST', input());
    buildRecords = [];
    expect(await outcome(id)).toMatchObject({ status: 'not_applied' });
  });
  it('only checks operations that need attention', async () => {
    const response = await request(
      '/secrets',
      'PUT',
      input({ name: 'API_KEY', value: 'one' }),
    );
    const { id } = (await response.json()) as { id: string };
    expect((await reconcile(id)).status).toBe(409);
  });
  it('keeps operation checks inside the workspace', async () => {
    const id = await interrupted('/secrets/API_KEY', 'DELETE', input());
    const bob = await db.user(2);
    expect((await reconcile(id, bob.cookie)).status).toBe(404);
    expect(operation(id).status).toBe('needs_attention');
  });
});

describe('health checks for builds started by pushes', () => {
  const pushBuild = '30000000-0000-4000-8000-000000000009';
  const recent = (uuid: string, at = now()) => ({
    build_uuid: uuid,
    trigger: { trigger_uuid: triggerId },
    build_trigger_metadata: { commit_hash: 'a'.repeat(40), branch: 'main' },
    created_at: new Date(at * 1000).toISOString(),
  });
  const tracked = () =>
    db.sqlite
      .prepare('SELECT operation_id,target,status FROM operation_health')
      .all() as { operation_id: string; target: string; status: string }[];
  // Scans run at most every five minutes per project; move the last scan back.
  const later = () => {
    db.sqlite.prepare('UPDATE build_scans SET scanned_at=?').run(now() - 400);
    db.sqlite
      .prepare('UPDATE operation_health SET checked_at=?')
      .run(now() - 30);
  };
  it('records a baseline first and never checks builds that already existed', async () => {
    buildRecords = [recent(buildId, now() - 60)];
    await scheduledBuildScans(db.env);
    expect(tracked()).toEqual([]);
    expect(
      db.sqlite.prepare('SELECT build_uuid FROM observed_builds').all(),
    ).toEqual([{ build_uuid: buildId }]);
  });
  it('checks the health of a new build started by a push', async () => {
    buildRecords = [recent(buildId, now() - 60)];
    await scheduledBuildScans(db.env);
    buildRecords = [recent(pushBuild), recent(buildId, now() - 60)];
    later();
    await scheduledBuildScans(db.env);
    expect(tracked()).toEqual([
      {
        operation_id: `push:${pushBuild}`,
        target: pushBuild,
        status: 'pending',
      },
    ]);
    await scheduledHealthChecks(db.env);
    expect(tracked()[0].status).toBe('healthy');
  });
  it('does not track a build twice when Shipcel started it', async () => {
    buildRecords = [];
    await scheduledBuildScans(db.env);
    const response = await request('/redeploy', 'POST', input());
    const { result } = (await response.json()) as {
      result: { buildId: string };
    };
    buildRecords = [recent(result.buildId)];
    later();
    await scheduledBuildScans(db.env);
    expect(tracked().filter((h) => h.target === result.buildId)).toHaveLength(
      1,
    );
  });
  it('ignores builds older than an hour even after the baseline', async () => {
    buildRecords = [];
    await scheduledBuildScans(db.env);
    db.sqlite
      .prepare('UPDATE build_scans SET baseline_at=?')
      .run(now() - 86400);
    buildRecords = [recent(pushBuild, now() - 7200)];
    later();
    await scheduledBuildScans(db.env);
    expect(tracked()).toEqual([]);
  });
  it('scans each project at most every five minutes', async () => {
    await scheduledBuildScans(db.env);
    calls.length = 0;
    await scheduledBuildScans(db.env);
    expect(calls).toEqual([]);
  });
  it('skips projects whose Cloudflare account changed', async () => {
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET account_id=? WHERE provider='cloudflare'",
      )
      .run('f'.repeat(32));
    await scheduledBuildScans(db.env);
    expect(calls.some((c) => c.url.includes('/builds/workers/'))).toBe(false);
  });
  it('never scans preview pipelines, whose builds are uploaded versions', async () => {
    const production = db.sqlite
      .prepare('SELECT * FROM deployment_jobs LIMIT 1')
      .get() as Record<string, string | number | null>;
    const preview = {
      ...production,
      id: crypto.randomUUID(),
      worker_name: 'cc-test-app-pv-worker',
      worker_tag: 'e'.repeat(32),
      idempotency_key: crypto.randomUUID(),
      environment: 'preview',
    };
    const fields = Object.keys(preview);
    db.sqlite
      .prepare(
        `INSERT INTO deployment_jobs (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
      )
      .run(...fields.map((f) => preview[f as keyof typeof preview]));
    // The preview Worker exists, so only the environment filter can skip it.
    extraScripts = [{ id: 'cc-test-app-pv-worker', tag: 'e'.repeat(32) }];
    await scheduledBuildScans(db.env);
    expect(
      calls.some((c) => c.url.includes(`/builds/workers/${'e'.repeat(32)}`)),
    ).toBe(false);
    expect(calls.some((c) => c.url.includes(`/builds/workers/${tag}`))).toBe(
      true,
    );
  });
  it('shows health next to builds in the build list', async () => {
    buildRecords = [recent(buildId, now() - 60)];
    await scheduledBuildScans(db.env);
    buildRecords = [recent(pushBuild), recent(buildId, now() - 60)];
    later();
    const list = (await (await request('/builds')).json()) as {
      builds: { build_uuid: string; health?: string }[];
    };
    expect(list.builds.find((b) => b.build_uuid === pushBuild)).toMatchObject({
      health: 'pending',
    });
    expect(
      list.builds.find((b) => b.build_uuid === buildId)?.health,
    ).toBeUndefined();
  });
});
