import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';
import app from '../worker/index';

// Manage → Domains → Who can open previews: a Cloudflare Access application on the Worker's
// previews (destination `preview_worker`), in the customer's own Zero Trust organization.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const account = 'a'.repeat(32),
  tag = 'c'.repeat(32),
  worker = 'cc-test-app-worker',
  name = `Shipcel previews ${worker}`;
type App = Record<string, unknown> & {
  id: string;
  name: string;
  updated_at: string;
};
let organization: boolean | 'denied',
  providers: { id: string; name: string; type: string }[],
  apps: App[],
  lost: string | null;
const calls: { method: string; path: string; search: string; body: unknown }[] =
  [];
const cf = (result: unknown) => Response.json({ success: true, result });
const missing = (code: number) =>
  Response.json(
    { success: false, errors: [{ code, message: 'not found' }] },
    { status: 404 },
  );
const request = (path: string, init: RequestInit = {}, cookie = who.cookie) =>
  db.request(`/projects/${projectId}${path}`, init, cookie);
const protect = (body: Record<string, unknown>) =>
  request('/access', {
    method: 'PUT',
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      confirm: true,
      ...body,
    }),
  });
const kinds = async () =>
  ((await (await request('/operations')).json()) as { kind: string }[])
    .map((o) => o.kind)
    .sort();
const stamp = () => new Date().toISOString();

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput()) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const row = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: account,
    repository_id: '50',
    repository_name: 'alice/sample',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: worker,
    build_command: '',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: tag,
  };
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${Object.keys(row).join(',')}) VALUES (${Object.keys(
        row,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(row));
  organization = true;
  providers = [{ id: 'idp-1', name: 'One-time PIN', type: 'onetimepin' }];
  apps = [];
  lost = null;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(raw));
      const path = url.pathname.replace('/client/v4', '');
      const method = init.method || 'GET';
      const body =
        typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, search: url.search, body });
      const root = `/accounts/${account}`;
      if (path === `${root}/workers/scripts`) return cf([{ id: worker, tag }]);
      if (path === `${root}/access/organizations`)
        return organization === 'denied'
          ? new Response('', { status: 403 })
          : organization
            ? cf({ auth_domain: 'acme.cloudflareaccess.com', name: 'acme' })
            : missing(12130);
      if (path === `${root}/access/identity_providers`) {
        if (method === 'POST') {
          providers.push({ id: 'idp-otp', name: body.name, type: body.type });
          return cf(providers.at(-1));
        }
        return cf(providers);
      }
      if (path === `${root}/access/apps`) {
        if (method === 'POST') {
          const created: App = {
            ...body,
            id: `app-${apps.length + 1}`,
            aud: 'aud',
            created_at: stamp(),
            updated_at: stamp(),
          };
          apps.push(created);
          if (lost === 'create') return new Response('', { status: 500 });
          return cf(created);
        }
        // Pessimistic: as if the name filter matched parts of names.
        const wanted = url.searchParams.get('name')?.toLowerCase() ?? '';
        return cf(apps.filter((a) => a.name.toLowerCase().includes(wanted)));
      }
      const one = new RegExp(`^${root}/access/apps/([\\w-]+)$`).exec(path);
      if (one) {
        const index = apps.findIndex((a) => a.id === one[1]);
        if (index < 0) return missing(12129);
        if (method === 'PUT') {
          apps[index] = {
            ...body,
            id: apps[index].id,
            aud: 'aud',
            created_at: apps[index].created_at,
            updated_at: stamp(),
          };
          return cf(apps[index]);
        }
        if (method === 'DELETE') {
          apps.splice(index, 1);
          if (lost === 'delete') return new Response('', { status: 500 });
          return cf({ id: one[1] });
        }
        return cf(apps[index]);
      }
      throw new Error(`Unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('preview protection', () => {
  it('explains that Access needs the account’s Zero Trust organization first', async () => {
    organization = false;
    expect(await (await request('/access')).json()).toMatchObject({
      organization: null,
      loginMethods: [],
      protection: null,
    });
    const refused = await protect({ emails: ['ada@example.com'] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'Zero Trust',
    );
    expect(apps).toEqual([]);
    // Missing permissions are reported as such, not as a missing organization.
    organization = 'denied';
    const denied = await request('/access');
    expect(denied.status).toBe(403);
  });

  it('protects the Worker’s previews for the people named', async () => {
    const response = await protect({
      emails: ['Ada@Example.com', 'grace@example.com', 'ada@example.com'],
      domains: ['Example.org'],
    });
    expect(await response.json()).toMatchObject({ status: 'succeeded' });
    expect(apps).toHaveLength(1);
    const { id, aud, created_at, updated_at, ...body } = apps[0];
    expect([id, aud, typeof created_at, typeof updated_at]).toEqual([
      'app-1',
      'aud',
      'string',
      'string',
    ]);
    // Only previews: production stays public.
    expect(body).toEqual({
      type: 'self_hosted',
      name,
      destinations: [{ type: 'preview_worker', worker_id: tag }],
      policies: [
        {
          decision: 'allow',
          include: [
            { email: { email: 'ada@example.com' } },
            { email: { email: 'grace@example.com' } },
            { email_domain: { domain: 'example.org' } },
          ],
        },
      ],
      session_duration: '24h',
      app_launcher_visible: false,
    });
    expect(await (await request('/access')).json()).toEqual({
      organization: { authDomain: 'acme.cloudflareaccess.com' },
      organizationError: null,
      loginMethods: [{ name: 'One-time PIN', type: 'onetimepin' }],
      protection: {
        emails: ['ada@example.com', 'grace@example.com'],
        domains: ['example.org'],
        otherRules: 0,
        sessionDuration: '24h',
      },
      missing: false,
    });
    expect(await kinds()).toEqual(['previews.protect']);
    // Shipcel keeps the application's ID, never who may sign in.
    expect(
      JSON.stringify(
        db.sqlite.prepare('SELECT * FROM project_operations').all(),
      ),
    ).not.toContain('example');
    expect(
      db.sqlite.prepare('SELECT app_id FROM project_access').all(),
    ).toEqual([{ app_id: 'app-1' }]);
  });

  it('changes who can open previews in place', async () => {
    await protect({ emails: ['ada@example.com'] });
    const response = await protect({ domains: ['example.com'] });
    expect(response.status).toBe(200);
    expect(apps).toHaveLength(1);
    expect(apps[0].policies).toEqual([
      {
        decision: 'allow',
        include: [{ email_domain: { domain: 'example.com' } }],
      },
    ]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: `/accounts/${account}/access/apps/app-1`,
    });
  });

  it('adds email codes as a login method only with consent, and only when there is none', async () => {
    providers = [];
    const refused = await protect({ emails: ['ada@example.com'] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'login method',
    );
    expect(apps).toEqual([]);
    expect(
      (await protect({ emails: ['ada@example.com'], addLoginMethod: true }))
        .status,
    ).toBe(200);
    expect(providers).toEqual([
      { id: 'idp-otp', name: 'One-time PIN', type: 'onetimepin' },
    ]);
    // An organization with its own login methods is left as it is.
    providers = [{ id: 'okta', name: 'Okta', type: 'okta' }];
    await protect({ emails: ['ada@example.com'], addLoginMethod: true });
    expect(providers).toHaveLength(1);
    expect(
      calls.filter(
        (c) => c.method === 'POST' && c.path.endsWith('/identity_providers'),
      ),
    ).toHaveLength(1);
  });

  it('adopts the application an interrupted attempt created, and nothing else', async () => {
    const decoy = {
      id: 'decoy',
      name,
      destinations: [{ type: 'preview_worker', worker_id: 'd'.repeat(32) }],
      updated_at: stamp(),
    };
    const earlier = {
      id: 'earlier',
      name,
      destinations: [{ type: 'preview_worker', worker_id: tag }],
      updated_at: stamp(),
    };
    // Someone's own application for this Worker's previews, and one protecting all of it.
    const copy = { ...earlier, id: 'copy', name: `${name} (copy)` };
    const whole = {
      ...earlier,
      id: 'whole',
      destinations: [{ type: 'worker', worker_id: tag }],
    };
    apps = [decoy, copy, whole, earlier];
    expect((await protect({ emails: ['ada@example.com'] })).status).toBe(200);
    expect(apps.map((a) => a.id)).toEqual([
      'decoy',
      'copy',
      'whole',
      'earlier',
    ]);
    expect(apps.slice(0, 3)).toEqual([decoy, copy, whole]);
    expect(
      db.sqlite.prepare('SELECT app_id FROM project_access').all(),
    ).toEqual([{ app_id: 'earlier' }]);
    const listed = calls.find(
      (c) => c.method === 'GET' && c.path.endsWith('/access/apps'),
    )!;
    expect(Object.fromEntries(new URLSearchParams(listed.search))).toEqual({
      name,
      exact: 'true',
    });
  });

  it('removes protection after confirmation', async () => {
    await protect({ emails: ['ada@example.com'] });
    expect(
      (
        await request('/access', {
          method: 'DELETE',
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(400);
    expect(apps).toHaveLength(1);
    const removed = await request('/access', {
      method: 'DELETE',
      body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
    });
    expect(await removed.json()).toMatchObject({ status: 'succeeded' });
    expect(apps).toEqual([]);
    expect(db.sqlite.prepare('SELECT * FROM project_access').all()).toEqual([]);
    expect(await (await request('/access')).json()).toMatchObject({
      protection: null,
      missing: false,
    });
    expect(await kinds()).toEqual(['previews.protect', 'previews.unprotect']);
  });

  it('notices an application removed in Cloudflare', async () => {
    await protect({ emails: ['ada@example.com'] });
    apps = [];
    expect(await (await request('/access')).json()).toMatchObject({
      protection: null,
      missing: true,
    });
    // Removing it again only forgets it.
    const removed = await request('/access', {
      method: 'DELETE',
      body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
    });
    expect(removed.status).toBe(200);
    expect(db.sqlite.prepare('SELECT * FROM project_access').all()).toEqual([]);
  });

  it('checks the people and domains it is given', async () => {
    for (const rules of [
      {},
      { emails: [] },
      { emails: ['not an email'] },
      { domains: ['@example.com'] },
      { domains: ['localhost'] },
      {
        emails: Array.from({ length: 51 }, (_, i) => `p${i}@example.com`),
      },
      { domains: Array.from({ length: 11 }, (_, i) => `d${i}.example.com`) },
    ])
      expect((await protect(rules)).status, JSON.stringify(rules)).toBe(400);
    expect(apps).toEqual([]);
  });

  it('is changed in the dashboard by owners and developers only', async () => {
    const token = (
      (await (
        await db.request(
          '/tokens',
          { method: 'POST', body: JSON.stringify({ name: 'Agent' }) },
          who.cookie,
        )
      ).json()) as { token: string }
    ).token;
    const viaToken = await app.request(
      `https://shipcel.test/api/projects/${projectId}/access`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          emails: ['ada@example.com'],
          requestId: crypto.randomUUID(),
          confirm: true,
        }),
      },
      db.env,
    );
    expect(viaToken.status).toBe(403);
    db.sqlite
      .prepare("UPDATE memberships SET role='viewer' WHERE user_id=?")
      .run(who.userId);
    expect((await protect({ emails: ['ada@example.com'] })).status).toBe(403);
    expect(apps).toEqual([]);
  });
});

describe('interrupted changes', () => {
  const reconcile = async () => {
    const op = (
      (await (await request('/operations')).json()) as {
        id: string;
        status: string;
      }[]
    ).find((o) => o.status === 'needs_attention')!;
    return (await (
      await request(`/operations/${op.id}/reconcile`, {
        method: 'POST',
        body: '{}',
      })
    ).json()) as { status: string; error: string | null };
  };

  it('finds an application created before the response was lost', async () => {
    lost = 'create';
    expect((await protect({ emails: ['ada@example.com'] })).status).toBe(502);
    expect(await reconcile()).toMatchObject({ status: 'succeeded' });
  });

  it('reports protection that never landed', async () => {
    const pending = () =>
      db.sqlite
        .prepare(
          "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,'previews.protect',?,'needs_attention',?,?,?)",
        )
        .run(
          crypto.randomUUID(),
          who.workspaceId,
          projectId,
          who.userId,
          account,
          crypto.randomUUID(),
          JSON.stringify({ workerTag: tag }),
          now(),
          now(),
        );
    pending();
    expect(await reconcile()).toMatchObject({ status: 'not_applied' });
    // An application last changed before the operation began doesn't count.
    apps = [
      {
        id: 'earlier',
        name,
        destinations: [{ type: 'preview_worker', worker_id: tag }],
        updated_at: new Date(Date.now() - 86400000).toISOString(),
      },
    ];
    db.sqlite.prepare('DELETE FROM project_operations').run();
    pending();
    expect(await reconcile()).toMatchObject({ status: 'not_applied' });
  });

  it('reports a removal that never happened', async () => {
    await protect({ emails: ['ada@example.com'] });
    db.sqlite
      .prepare(
        "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,'previews.unprotect',?,'needs_attention',?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        who.workspaceId,
        projectId,
        who.userId,
        account,
        crypto.randomUUID(),
        JSON.stringify({ workerTag: tag, appId: 'app-1' }),
        now(),
        now(),
      );
    expect(await reconcile()).toMatchObject({ status: 'not_applied' });
  });

  it('learns whether a removal happened', async () => {
    await protect({ emails: ['ada@example.com'] });
    lost = 'delete';
    const removed = await request('/access', {
      method: 'DELETE',
      body: JSON.stringify({ requestId: crypto.randomUUID(), confirm: true }),
    });
    expect(removed.status).toBe(502);
    expect(await reconcile()).toMatchObject({ status: 'succeeded' });
  });
});
