import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { digest, seal, unseal } from '../worker/crypto';
import { activeGrant, grantToken } from '../worker/auth';
import { now } from '../worker/types';
import app from '../worker/index';

let db: ReturnType<typeof database>;
beforeEach(() => {
  db = database();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network request');
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

async function flow(
  provider: 'github' | 'cloudflare' = 'github',
  session = '',
  // Where the sign-in should come back to, as the CLI's page asks.
  back?: string,
) {
  const start = await db.request(
    `/auth/${provider}/start${back === undefined ? '' : `?return=${encodeURIComponent(back)}`}`,
    {},
    session,
  );
  expect(start.status).toBe(302);
  const url = new URL(start.headers.get('Location')!);
  const browserCookie = start.headers.get('Set-Cookie')!.split(';')[0];
  return {
    url,
    browserCookie,
    state: url.searchParams.get('state')!,
    cookie: [session, browserCookie].filter(Boolean).join('; '),
  };
}
function mockLogin(id = 101) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token')
        return Response.json({
          access_token: 'private-github-access',
          refresh_token: 'private-refresh',
          expires_in: 28800,
        });
      if (url === 'https://api.github.com/user')
        return Response.json({ id, login: `user-${id}` });
      throw new Error(`Unexpected provider URL ${url}`);
    }),
  );
}

describe('workspace authorization and free plan', () => {
  it('isolates projects, configs, exports, activity, and deployment IDs between two users', async () => {
    const alice = await db.user(1),
      bob = await db.user(2);
    const created = await db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(projectInput()) },
      alice.cookie,
    );
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };
    expect(
      await (await db.request('/projects', {}, bob.cookie)).json(),
    ).toEqual([]);
    expect(
      await (await db.request('/activity', {}, bob.cookie)).json(),
    ).toEqual([]);
    for (const [path, method] of [
      [`/projects/${project.id}/config`, 'GET'],
      [`/projects/${project.id}/export`, 'POST'],
      [`/projects/${project.id}`, 'DELETE'],
      [`/projects/${project.id}/deployments`, 'GET'],
      [`/projects/${project.id}/repository`, 'POST'],
    ])
      expect((await db.request(path, { method }, bob.cookie)).status).toBe(404);
    expect(
      (
        await db.request(
          '/deployments/unknown/refresh',
          { method: 'POST' },
          bob.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await db.request(
          '/projects',
          { method: 'POST', body: JSON.stringify(projectInput()) },
          bob.cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        (await (
          await db.request('/projects', {}, alice.cookie)
        ).json()) as unknown[]
      ).length,
    ).toBe(1);
  });
  it('rejects missing, expired, revoked, and logged-out sessions', async () => {
    expect((await db.request('/projects')).status).toBe(401);
    const alice = await db.user(1);
    db.sqlite.prepare('UPDATE sessions SET expires_at=?').run(now() - 1);
    expect((await db.request('/projects', {}, alice.cookie)).status).toBe(401);
    db.sqlite.prepare('UPDATE sessions SET expires_at=?').run(now() + 3600);
    db.sqlite
      .prepare('DELETE FROM memberships WHERE user_id=?')
      .run(alice.userId);
    expect((await db.request('/projects', {}, alice.cookie)).status).toBe(401);
    const bob = await db.user(2);
    const logout = await db.request(
      '/auth/logout',
      { method: 'POST' },
      bob.cookie,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get('Set-Cookie')).toContain('Secure');
    expect((await db.request('/projects', {}, bob.cookie)).status).toBe(401);
  });
  it('never falls back to local-owner for an invalid supplied cookie', async () => {
    const response = await app.request(
      'http://localhost/api/projects',
      { headers: { Cookie: 'cloudcel_session=invalid' } },
      { ...db.env, APP_ORIGIN: 'http://localhost', AUTH_MODE: 'local' },
    );
    expect(response.status).toBe(401);
  });
  it('requires a same-origin signal for hosted mutations and refuses foreign origins', async () => {
    const alice = await db.user(1);
    const response = await app.request(
      'https://shipcel.test/api/auth/logout',
      { method: 'POST', headers: { Cookie: alice.cookie } },
      db.env,
    );
    expect(response.status).toBe(403);
    for (const method of ['GET', 'POST', 'DELETE'])
      expect(
        (
          await db.request(
            '/projects',
            { method, headers: { Origin: 'https://evil.test' } },
            alice.cookie,
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await db.request(
          '/auth/session',
          { headers: { 'Sec-Fetch-Site': 'cross-site' } },
          alice.cookie,
        )
      ).status,
    ).toBe(403);
  });
  it('prevents members from connecting accounts and changing provider access', async () => {
    const member = await db.user(1, 'viewer');
    expect(
      (
        await db.request(
          '/connections/cloudflare',
          { method: 'DELETE' },
          member.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (await db.request('/auth/cloudflare/start', {}, member.cookie)).status,
    ).toBe(401);
    expect(
      (await db.request('/connections/cloudflare/accounts', {}, member.cookie))
        .status,
    ).toBe(403);
  });
  it("caps Free projects in SQL at the 100 Workers Cloudflare's free plan allows per account", async () => {
    const who = await db.user(1);
    for (const name of ['app-one', 'app-two', 'app-three', 'app-four'])
      expect(
        (
          await db.request(
            '/projects',
            { method: 'POST', body: JSON.stringify(projectInput(name)) },
            who.cookie,
          )
        ).status,
      ).toBe(201);
    const insert = db.sqlite.prepare(
      'INSERT INTO projects(id,workspace_id,name,framework,created_at) VALUES (?,?,?,?,?)',
    );
    for (let i = 4; i < 100; i++)
      insert.run(`bulk-${i}`, who.workspaceId, `bulk-${i}`, 'worker', 'now');
    const over = await db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(projectInput('app-over')) },
      who.cookie,
    );
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toContain('100');
    expect(() =>
      insert.run('bypass', who.workspaceId, 'bypass', 'worker', 'now'),
    ).toThrow('CLOUDCEL_PROJECT_LIMIT');
    expect(
      await (await db.request('/plan', {}, who.cookie)).json(),
    ).toMatchObject({
      name: 'free',
      price: 0,
      projectLimit: 100,
      projects: 100,
      pipelineLimit: null,
      concurrentSetups: 1,
    });
  });
  it('raises existing Free workspaces to the new limits and drops the monthly setup cap', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { readFileSync, readdirSync } = await import('node:fs');
    const sqlite = new DatabaseSync(':memory:');
    const files = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const change = files.indexOf('0014_free_plan_limits.sql');
    expect(change).toBeGreaterThan(0);
    for (const f of files.slice(0, change))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    sqlite
      .prepare(
        "INSERT INTO workspace_limits(workspace_id,plan,project_limit,monthly_pipeline_limit) VALUES ('w','free',3,10)",
      )
      .run();
    for (const f of files.slice(change))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    expect(
      sqlite.prepare('SELECT project_limit FROM workspace_limits').get(),
    ).toEqual({ project_limit: 100 });
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='enforce_monthly_pipeline_limit'",
        )
        .all(),
    ).toEqual([]);
    sqlite.close();
  });
});

describe('Free-only projects', () => {
  const create = (who: { cookie: string }, body: Record<string, unknown>) =>
    db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(body) },
      who.cookie,
    );
  const toggle = (
    who: { cookie: string },
    id: string,
    body: Record<string, unknown>,
  ) =>
    db.request(
      `/projects/${id}/free-only`,
      { method: 'PUT', body: JSON.stringify(body) },
      who.cookie,
    );
  it('starts projects Free-only and refuses R2 and containers until it is turned off', async () => {
    const who = await db.user(1);
    const plain = await create(who, projectInput('plain-app'));
    expect(plain.status).toBe(201);
    expect(await plain.json()).toMatchObject({ freeOnly: true });
    const files = await create(who, {
      ...projectInput('files-app'),
      framework: 'react',
      storage: true,
    });
    expect(files.status).toBe(400);
    expect(((await files.json()) as { error: string }).error).toContain(
      'Free-only',
    );
    const box = await create(who, {
      ...projectInput('box-app'),
      framework: 'docker',
    });
    expect(box.status).toBe(400);
    expect(((await box.json()) as { error: string }).error).toContain(
      'Workers Paid',
    );
    for (const body of [
      {
        ...projectInput('files-app'),
        framework: 'react',
        storage: true,
        freeOnly: false,
      },
      { ...projectInput('box-app'), framework: 'docker', freeOnly: false },
    ])
      expect((await create(who, body)).status).toBe(201);
    const listed = (await (
      await db.request('/projects', {}, who.cookie)
    ).json()) as { name: string; freeOnly: boolean }[];
    expect(Object.fromEntries(listed.map((p) => [p.name, p.freeOnly]))).toEqual(
      { 'plain-app': true, 'files-app': false, 'box-app': false },
    );
  });
  it('turns Free-only off only with confirmation, and on only when nothing billable is used', async () => {
    const who = await db.user(1);
    const id = (
      (await (await create(who, projectInput('plain-app'))).json()) as {
        id: string;
      }
    ).id;
    expect((await toggle(who, id, { freeOnly: false })).status).toBe(400);
    const off = await toggle(who, id, { freeOnly: false, confirm: true });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ freeOnly: false });
    expect((await toggle(who, id, { freeOnly: true })).status).toBe(200);
    const files = (
      (await (
        await create(who, {
          ...projectInput('files-app'),
          framework: 'react',
          storage: true,
          freeOnly: false,
        })
      ).json()) as { id: string }
    ).id;
    const refused = await toggle(who, files, { freeOnly: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('R2');
    // A deployment that created an R2 bucket also keeps it off.
    const deployedId = (
      (await (
        await create(who, { ...projectInput('shop-app'), freeOnly: false })
      ).json()) as { id: string }
    ).id;
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,resources_json,status,idempotency_key,created_at,updated_at) VALUES ('job',?,?,?,'cf','gh','acct','1','a/b','main',?,?,'shop','',?,'deployed','key',1,1)",
      )
      .run(
        who.workspaceId,
        deployedId,
        who.userId,
        'b'.repeat(40),
        crypto.randomUUID(),
        JSON.stringify([{ type: 'r2', binding: 'FILES' }]),
      );
    expect((await toggle(who, deployedId, { freeOnly: true })).status).toBe(
      409,
    );
    const other = await db.user(2);
    expect(
      (await toggle(other, id, { freeOnly: false, confirm: true })).status,
    ).toBe(404);
  });
  it('marks existing projects that already use R2 or containers as able to bill', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { readFileSync, readdirSync } = await import('node:fs');
    const sqlite = new DatabaseSync(':memory:');
    const files = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const change = files.indexOf('0016_free_only.sql');
    expect(change).toBeGreaterThan(0);
    for (const f of files.slice(0, change))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    const insert = sqlite.prepare(
      "INSERT INTO projects(id,workspace_id,name,framework,storage_enabled,created_at) VALUES (?,'w',?,?,?,'now')",
    );
    insert.run('plain', 'plain', 'worker', 0);
    insert.run('files', 'files', 'react', 1);
    insert.run('box', 'box', 'docker', 0);
    insert.run('bucket', 'bucket', 'worker', 0);
    sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,resources_json,status,idempotency_key,created_at,updated_at) VALUES ('job','w','bucket','u','cf','gh','acct','1','a/b','main',?,'t','bucket','',?,'deployed','key',1,1)",
      )
      .run('b'.repeat(40), JSON.stringify([{ type: 'r2', binding: 'FILES' }]));
    for (const f of files.slice(change))
      sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
    expect(
      Object.fromEntries(
        sqlite
          .prepare('SELECT id, free_only FROM projects')
          .all()
          .map((r) => [r.id, r.free_only]),
      ),
    ).toEqual({ plain: 1, files: 0, box: 0, bucket: 0 });
    sqlite.close();
  });
});

describe('OAuth, credentials, and disconnect', () => {
  it('uses PKCE, one-use browser-bound state, secure cookies, and encrypted server-only grants', async () => {
    const f = await flow();
    expect(f.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(f.url.searchParams.get('redirect_uri')).toBe(
      'https://shipcel.test/api/auth/github/callback',
    );
    const stored = db.sqlite.prepare('SELECT * FROM oauth_states').get()!;
    expect(stored.state_hash).toBe(await digest(f.state));
    expect(stored.browser_hash).not.toContain(f.browserCookie);
    const verifier = await unseal<string>(
      String(stored.verifier),
      db.env.TOKEN_ENCRYPTION_KEY,
      String(stored.state_hash),
    );
    expect(await digest(verifier)).toBe(
      f.url.searchParams.get('code_challenge'),
    );
    mockLogin();
    const callback = `/auth/github/callback?state=${f.state}&code=authorization-code`;
    const response = await db.request(
      callback,
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
      f.cookie,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(response.headers.get('Set-Cookie')).toContain('Secure');
    const grant = db.sqlite.prepare('SELECT * FROM provider_grants').get()!;
    expect(JSON.stringify(grant)).not.toContain('private-github-access');
    expect(
      await grantToken(
        db.env,
        (await activeGrant(db.env, 'personal-101', 'github'))!,
      ),
    ).toBe('private-github-access');
    const tokenCall = vi.mocked(fetch).mock.calls[0][1]!;
    expect(
      new URLSearchParams(tokenCall.body as URLSearchParams).get(
        'code_verifier',
      ),
    ).toBe(verifier);
    expect((await db.request(callback, {}, f.cookie)).status).toBe(400);
  });
  it('rejects missing, tampered, wrong-browser, and expired OAuth state without provider requests', async () => {
    const f = await flow();
    expect(
      (await db.request(`/auth/github/callback?state=${f.state}&code=x`))
        .status,
    ).toBe(400);
    expect(
      (
        await db.request(
          `/auth/github/callback?state=wrong&code=x`,
          {},
          f.cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await db.request(
          `/auth/github/callback?state=${f.state}&code=x`,
          {},
          '__Host-cloudcel_oauth_github=wrong',
        )
      ).status,
    ).toBe(400);
    db.sqlite.prepare('UPDATE oauth_states SET expires_at=?').run(now() - 1);
    expect(
      (
        await db.request(
          `/auth/github/callback?state=${f.state}&code=x`,
          {},
          f.cookie,
        )
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('comes back to the CLI’s page after a sign-in it started, and to nowhere else', async () => {
    const finish = async (
      f: Awaited<ReturnType<typeof flow>>,
      provider = 'github',
      query = 'code=x',
    ) =>
      (
        await db.request(
          `/auth/${provider}/callback?state=${f.state}&${query}`,
          {},
          f.cookie,
        )
      ).headers.get('Location');
    // shipcel login's page: back to the pending sign-in, with its code.
    mockLogin();
    const signIn = await flow('github', '', 'cli-login:BCDF-GHJK');
    expect(
      db.sqlite.prepare('SELECT return_to FROM oauth_states').get(),
    ).toEqual({ return_to: 'cli-login:BCDF-GHJK' });
    expect(await finish(signIn)).toBe(
      '/app/?connection=success#cli-login?code=BCDF-GHJK',
    );
    // Declining comes back to it too.
    expect(
      await finish(
        await flow('github', '', 'cli-login:BCDF-GHJK'),
        'github',
        'error=access_denied',
      ),
    ).toBe('/app/?connection=declined#cli-login?code=BCDF-GHJK');
    // Anything else is ignored: only Shipcel's own two pages are ever produced.
    for (const target of [
      'https://evil.example/',
      '//evil.example',
      'connections',
      'cli-login',
      'cli-login:',
      'cli-login:bcdf-ghjk',
      'cli-login:AEIO-UAEI',
      'cli-login:BCDF-GHJK/../../x',
      'cli-login:BCDF-GHJK&next=https://evil.example',
      'cli-setup/../x',
      ' cli-setup',
    ]) {
      // Sign-ins are limited to ten a minute; this loop is not what's being tested.
      db.sqlite.exec('DELETE FROM oauth_states; DELETE FROM request_limits');
      const f = await flow('github', '', target);
      expect(
        db.sqlite.prepare('SELECT return_to FROM oauth_states').get(),
      ).toEqual({ return_to: null });
      expect(await finish(f)).toBe('/app/?connection=success#connections');
    }
    // Without a return, as before.
    expect(await finish(await flow())).toBe(
      '/app/?connection=success#connections',
    );
    // Connecting Cloudflare from the CLI's setup page, signed in as the owner.
    const alice = await db.user(1);
    const connect = await flow('cloudflare', alice.cookie, 'cli-setup');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://dash.cloudflare.com/oauth2/token')
          return Response.json({ access_token: 'private-cloudflare-access' });
        if (url.startsWith('https://api.cloudflare.com/client/v4/accounts'))
          return Response.json({
            success: true,
            result: [{ id: 'a'.repeat(32), name: 'Alice' }],
          });
        throw new Error(`Unexpected provider URL ${url}`);
      }),
    );
    expect(await finish(connect, 'cloudflare')).toBe(
      '/app/?connection=success#cli-setup',
    );
    // And a stored value is checked again on the way out.
    const tampered = await flow('cloudflare', alice.cookie, 'cli-setup');
    db.sqlite
      .prepare("UPDATE oauth_states SET return_to='//evil.example'")
      .run();
    expect(await finish(tampered, 'cloudflare')).toBe(
      '/app/?connection=success#connections',
    );
  });
  it('saves a GitHub connection made inside a team in that team, and only for its owners', async () => {
    const alice = await db.user(101);
    const team = (await (
      await db.request(
        '/workspaces',
        { method: 'POST', body: JSON.stringify({ name: 'Acme' }) },
        alice.cookie,
      )
    ).json()) as { id: string };
    const f = await flow('github', alice.cookie);
    mockLogin();
    const done = await db.request(
      `/auth/github/callback?state=${f.state}&code=x`,
      {},
      f.cookie,
    );
    expect(done.status).toBe(302);
    // The session stays in the team, and the grant belongs to the team.
    expect(
      (
        (await (
          await db.request('/auth/session', {}, alice.cookie)
        ).json()) as { user: { workspaceId: string } }
      ).user.workspaceId,
    ).toBe(team.id);
    expect(
      db.sqlite
        .prepare(
          "SELECT workspace_id FROM provider_grants WHERE provider='github' AND status='active'",
        )
        .all(),
    ).toEqual([{ workspace_id: team.id }]);
    // A developer in the team can't replace it.
    db.sqlite
      .prepare("UPDATE memberships SET role='developer' WHERE workspace_id=?")
      .run(team.id);
    db.sqlite
      .prepare(
        "INSERT INTO memberships(workspace_id,user_id,role) VALUES (?,?,'owner')",
      )
      .run(team.id, 'gh-1');
    const g = await flow('github', alice.cookie);
    mockLogin();
    expect(
      (
        await db.request(
          `/auth/github/callback?state=${g.state}&code=x`,
          {},
          g.cookie,
        )
      ).status,
    ).toBe(403);
  });
  it('does not recreate revoked workspace membership at a later login', async () => {
    await db.user(101);
    db.sqlite.prepare('DELETE FROM memberships WHERE user_id=?').run('gh-101');
    const f = await flow();
    mockLogin();
    expect(
      (
        await db.request(
          `/auth/github/callback?state=${f.state}&code=x`,
          {},
          f.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      db.sqlite
        .prepare('SELECT * FROM memberships WHERE user_id=?')
        .get('gh-101'),
    ).toBeUndefined();
  });
  it('rejects Cloudflare callback after a session/account change', async () => {
    const alice = await db.user(1),
      bob = await db.user(2);
    const f = await flow('cloudflare', alice.cookie);
    expect(
      (
        await db.request(
          `/auth/cloudflare/callback?state=${f.state}&code=x`,
          {},
          `${bob.cookie}; ${f.browserCookie}`,
        )
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('records the scopes Cloudflare reports granting a connection', async () => {
    const alice = await db.user(1);
    const f = await flow('cloudflare', alice.cookie);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === 'https://dash.cloudflare.com/oauth2/token')
          return Response.json({
            access_token: 'private-cloudflare-access',
            refresh_token: 'private-refresh',
            expires_in: 3600,
            scope: 'account-settings.read workers-scripts.write offline_access',
          });
        throw new Error(`Unexpected provider URL ${String(input)}`);
      }),
    );
    const response = await db.request(
      `/auth/cloudflare/callback?state=${f.state}&code=x`,
      {},
      f.cookie,
    );
    expect(response.status).toBe(302);
    expect(
      db.sqlite
        .prepare(
          "SELECT scopes FROM provider_grants WHERE provider='cloudflare' AND status='active'",
        )
        .get(),
    ).toEqual({
      scopes: 'account-settings.read workers-scripts.write offline_access',
    });
  });
  describe('the account a new Cloudflare connection deploys to', () => {
    const accountA = { id: 'a'.repeat(32), name: 'Alice' },
      accountB = { id: 'b'.repeat(32), name: 'Studio' };
    async function connect(accounts: { id: string; name: string }[]) {
      const alice = await db.user(1);
      const f = await flow('cloudflare', alice.cookie);
      const asked: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === 'https://dash.cloudflare.com/oauth2/token')
            return Response.json({
              access_token: 'new-cloudflare-access',
              expires_in: 3600,
            });
          asked.push(url.replace('https://api.cloudflare.com/client/v4', ''));
          const one = url.match(/\/accounts\/([a-f0-9]{32})$/)?.[1];
          if (one) {
            const found = accounts.find((a) => a.id === one);
            return found
              ? Response.json({ success: true, result: found })
              : Response.json(
                  { success: false, errors: [{ code: 9109, message: 'no' }] },
                  { status: 403 },
                );
          }
          if (url.includes('/accounts?'))
            return Response.json({ success: true, result: accounts });
          throw new Error(`Unexpected provider URL ${url}`);
        }),
      );
      const response = await db.request(
        `/auth/cloudflare/callback?state=${f.state}&code=x`,
        {},
        f.cookie,
      );
      expect(response.status).toBe(302);
      return { alice, asked };
    }
    const chosen = () =>
      db.sqlite
        .prepare(
          "SELECT account_id, account_name FROM provider_grants WHERE provider='cloudflare' AND status='active'",
        )
        .get();
    it('is the only account the connection can see, so connecting is all it takes', async () => {
      const { asked } = await connect([accountA]);
      expect(chosen()).toEqual({
        account_id: accountA.id,
        account_name: 'Alice',
      });
      expect(asked).toEqual(['/accounts?per_page=2']);
    });
    it('is left to the owner when the connection sees several accounts', async () => {
      await connect([accountA, accountB]);
      expect(chosen()).toEqual({ account_id: null, account_name: null });
    });
    it('stays the one chosen before when the connection still reaches it', async () => {
      const alice = await db.user(1);
      await db.grant(alice, 'cloudflare');
      db.sqlite
        .prepare(
          "UPDATE provider_grants SET account_id=?, account_name='Old name', status='reconnect_required'",
        )
        .run(accountB.id);
      const f = await flow('cloudflare', alice.cookie);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === 'https://dash.cloudflare.com/oauth2/token')
            return Response.json({ access_token: 'new-cloudflare-access' });
          if (url.endsWith(`/accounts/${accountB.id}`))
            return Response.json({ success: true, result: accountB });
          throw new Error(`Unexpected provider URL ${url}`);
        }),
      );
      await db.request(
        `/auth/cloudflare/callback?state=${f.state}&code=x`,
        {},
        f.cookie,
      );
      expect(chosen()).toEqual({
        account_id: accountB.id,
        account_name: 'Studio',
      });
    });
    it('falls back to the only account when the earlier one is out of reach', async () => {
      const alice = await db.user(1);
      await db.grant(alice, 'cloudflare');
      db.sqlite
        .prepare("UPDATE provider_grants SET account_id=?, status='replaced'")
        .run(accountB.id);
      const f = await flow('cloudflare', alice.cookie);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url === 'https://dash.cloudflare.com/oauth2/token')
            return Response.json({ access_token: 'new-cloudflare-access' });
          if (url.endsWith(`/accounts/${accountB.id}`))
            return Response.json(
              { success: false, errors: [{ code: 9109, message: 'no' }] },
              { status: 403 },
            );
          if (url.includes('/accounts?'))
            return Response.json({ success: true, result: [accountA] });
          throw new Error(`Unexpected provider URL ${url}`);
        }),
      );
      await db.request(
        `/auth/cloudflare/callback?state=${f.state}&code=x`,
        {},
        f.cookie,
      );
      expect(chosen()).toEqual({
        account_id: accountA.id,
        account_name: 'Alice',
      });
    });
  });
  it('rejects a GitHub callback after logout before exchanging its authorization code', async () => {
    const alice = await db.user(1);
    const f = await flow('github', alice.cookie);
    await db.request('/auth/logout', { method: 'POST' }, alice.cookie);
    const response = await db.request(
      `/auth/github/callback?state=${f.state}&code=x`,
      {},
      f.cookie,
    );
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('authenticates the workspace and grant as encryption context', async () => {
    const blob = await seal(
      { access_token: 'never-in-browser' },
      db.env.TOKEN_ENCRYPTION_KEY,
      'workspace-one:github:grant-one',
    );
    expect(blob).not.toContain('never-in-browser');
    await expect(
      unseal(
        blob,
        db.env.TOKEN_ENCRYPTION_KEY,
        'workspace-two:github:grant-one',
      ),
    ).rejects.toThrow('cannot be read');
    await expect(
      unseal(blob, 'cd'.repeat(32), 'workspace-one:github:grant-one'),
    ).rejects.toThrow('cannot be read');
  });
  it('serializes token refresh and refuses to restore disconnected credentials', async () => {
    const who = await db.user(1);
    const id = await db.grant(who, 'cloudflare', {
      expires: now() - 1,
      refresh: 'private-refresh',
    });
    const grant = (await activeGrant(db.env, who.workspaceId, 'cloudflare'))!;
    let release!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const first = grantToken(db.env, grant);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(grantToken(db.env, grant)).rejects.toThrow('being refreshed');
    expect(
      (
        await db.request(
          '/connections/cloudflare',
          { method: 'DELETE' },
          who.cookie,
        )
      ).status,
    ).toBe(200);
    release(
      Response.json({
        access_token: 'new-private-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    );
    await expect(first).rejects.toThrow('disconnected');
    expect(
      db.sqlite
        .prepare(
          'SELECT status,encrypted_tokens FROM provider_grants WHERE id=?',
        )
        .get(id),
    ).toMatchObject({ status: 'disconnected', encrypted_tokens: null });
  });
  it('refreshes tokens once and never sends credentials in status responses', async () => {
    const who = await db.user(1);
    await db.grant(who, 'cloudflare', {
      expires: now() - 1,
      refresh: 'private-refresh',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          access_token: 'new-private-token',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      ),
    );
    expect(
      await grantToken(
        db.env,
        (await activeGrant(db.env, who.workspaceId, 'cloudflare'))!,
      ),
    ).toBe('new-private-token');
    expect(
      await grantToken(
        db.env,
        (await activeGrant(db.env, who.workspaceId, 'cloudflare'))!,
      ),
    ).toBe('new-private-token');
    expect(fetch).toHaveBeenCalledOnce();
    const response = await db.request('/connections', {}, who.cookie);
    const text = await response.text();
    expect(text).toContain('Test Cloud');
    expect(text).not.toMatch(
      /private-token|private-refresh|encrypted_tokens|test-cf-secret/,
    );
  });
  it('keeps the connection when a refresh fails for a passing reason, and ends it only when the provider refuses the refresh token', async () => {
    const who = await db.user(1);
    const id = await db.grant(who, 'cloudflare', {
      expires: now() - 1,
      refresh: 'private-refresh',
    });
    const state = (grantId: string) =>
      db.sqlite
        .prepare(
          'SELECT status, encrypted_tokens IS NOT NULL AS sealed, refresh_lock_until FROM provider_grants WHERE id=?',
        )
        .get(grantId);
    const renew = async (provider: 'github' | 'cloudflare' = 'cloudflare') =>
      grantToken(
        db.env,
        (await activeGrant(db.env, who.workspaceId, provider))!,
      );
    const answer = (respond: () => Promise<Response>) =>
      vi.stubGlobal('fetch', vi.fn(respond));
    // Nothing here is about the refresh token itself, so the connection stays, unlocked, for
    // the next call to try again at once.
    for (const respond of [
      async () => {
        throw new TypeError('Network connection lost.');
      },
      async () => new Response('Bad gateway', { status: 502 }),
      async () =>
        Response.json({ error: 'temporarily_unavailable' }, { status: 503 }),
      async () => new Response('Slow down', { status: 429 }),
      async () => new Response('<html>', { status: 400 }),
      async () => Response.json({ token_type: 'bearer' }),
    ]) {
      answer(respond);
      // Not a 401, which the CLI reads as its own token having expired.
      await expect(renew()).rejects.toMatchObject({
        status: 503,
        message:
          'Couldn’t renew Shipcel’s access to Cloudflare just now. The connection is kept: try again in a minute.',
      });
      expect(state(id)).toEqual({
        status: 'active',
        sealed: 1,
        refresh_lock_until: 0,
      });
    }
    // Nor is a refusal of Shipcel's own sign-in app.
    answer(async () =>
      Response.json({ error: 'invalid_client' }, { status: 401 }),
    );
    await expect(renew()).rejects.toMatchObject({
      status: 502,
      message:
        'Cloudflare refused Shipcel’s sign-in app (invalid_client). The connection is kept: check the app’s client ID and secret.',
    });
    expect(state(id)).toMatchObject({ status: 'active', sealed: 1 });
    answer(async () =>
      Response.json({
        access_token: 'new-private-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    );
    expect(await renew()).toBe('new-private-token');
    // The provider's OAuth answer that the refresh token is no longer valid ends it.
    db.sqlite
      .prepare('UPDATE provider_grants SET expires_at=? WHERE id=?')
      .run(now() - 1, id);
    answer(async () =>
      Response.json(
        {
          error: 'invalid_grant',
          error_description: 'The refresh token has expired.',
        },
        { status: 400 },
      ),
    );
    await expect(renew()).rejects.toMatchObject({
      status: 409,
      message:
        'Cloudflare no longer accepts this connection (invalid_grant). Connect Cloudflare again.',
    });
    expect(state(id)).toEqual({
      status: 'reconnect_required',
      sealed: 0,
      refresh_lock_until: 0,
    });
    // GitHub says so with a 200.
    const gh = await db.grant(who, 'github', {
      expires: now() - 1,
      refresh: 'private-github-refresh',
    });
    answer(async () => Response.json({ error: 'bad_refresh_token' }));
    await expect(renew('github')).rejects.toThrow('Connect GitHub again.');
    expect(state(gh)).toMatchObject({
      status: 'reconnect_required',
      sealed: 0,
    });
  });
});
