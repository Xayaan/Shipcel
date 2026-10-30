import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import app from '../worker/index';
import { tokenForbidden } from '../worker/tokens';

let db: ReturnType<typeof database>;
type Who = Awaited<ReturnType<ReturnType<typeof database>['user']>>;

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

// A request from a terminal or an agent: no cookies, no Origin, no X-Shipcel-Request.
const bearer = (token: string, path: string, init: RequestInit = {}) =>
  app.request(
    `https://shipcel.test/api${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    },
    db.env,
  );
// The CLI before it has a token: unauthenticated, marked as a Shipcel client.
const cli = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(
    `https://shipcel.test/api${path}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'X-Shipcel-Request': '1',
        ...headers,
      },
    },
    db.env,
  );
async function createToken(
  who: Who,
  body: Record<string, unknown> = { name: 'Laptop' },
) {
  const response = await db.request(
    '/tokens',
    { method: 'POST', body: JSON.stringify(body) },
    who.cookie,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, string | number | null>,
  };
}
const everything = () =>
  JSON.stringify([
    db.sqlite.prepare('SELECT * FROM api_tokens').all(),
    db.sqlite.prepare('SELECT * FROM cli_logins').all(),
  ]);

describe('API tokens', () => {
  it('creates a token that is shown once and stored only as a hash', async () => {
    const who = await db.user(1);
    const { status, body } = await createToken(who, {
      name: 'Laptop',
      expiresInDays: 30,
    });
    expect(status).toBe(201);
    const token = body.token as string;
    expect(token).toMatch(/^cc_pat_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(token.slice(0, 12));
    expect(Number(body.expiresAt) - Number(body.createdAt)).toBe(30 * 86400);
    expect(everything()).not.toContain(token);
    const listed = await (await db.request('/tokens', {}, who.cookie)).json();
    expect(listed).toEqual([
      {
        id: body.id,
        name: 'Laptop',
        prefix: body.prefix,
        createdAt: body.createdAt,
        lastUsedAt: null,
        expiresAt: body.expiresAt,
        // Only a token can be the one a request came with.
        current: false,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect((await createToken(who, { name: '' })).status).toBe(400);
    expect(
      (await createToken(who, { name: 'Too long', expiresInDays: 366 })).status,
    ).toBe(400);
  });

  it('authenticates API requests with a Bearer token, without browser checks', async () => {
    const who = await db.user(1);
    const token = (await createToken(who)).body.token as string;
    const created = await bearer(token, '/projects', {
      method: 'POST',
      body: JSON.stringify(projectInput('cli-app')),
    });
    expect(created.status).toBe(201);
    const projects = (await (await bearer(token, '/projects')).json()) as {
      name: string;
    }[];
    expect(projects.map((p) => p.name)).toEqual(['cli-app']);
    const used = db.sqlite
      .prepare('SELECT last_used_at FROM api_tokens')
      .get() as { last_used_at: number | null };
    expect(used.last_used_at).toBeGreaterThan(0);
    // The same request with a cookie and no Shipcel header is still refused.
    const crossSite = await app.request(
      'https://shipcel.test/api/projects',
      {
        method: 'POST',
        body: JSON.stringify(projectInput('csrf-app')),
        headers: {
          Cookie: who.cookie,
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
      },
      db.env,
    );
    expect(crossSite.status).toBe(403);
  });

  it('tells the CLI who a token acts as', async () => {
    const who = await db.user(1);
    const token = (await createToken(who)).body.token as string;
    expect(await (await bearer(token, '/me')).json()).toEqual({
      login: 'user-1',
      workspace: who.workspaceId,
      workspaceName: 'workspace-1',
      role: 'owner',
      via: 'token',
    });
  });

  it('refuses unknown, revoked and expired tokens, and tokens of people who left', async () => {
    const who = await db.user(1);
    const forged = `cc_pat_${'A'.repeat(43)}`;
    expect((await bearer(forged, '/projects')).status).toBe(401);
    expect((await bearer('not-a-token', '/projects')).status).toBe(401);
    const revokedToken = await createToken(who, { name: 'Old' });
    const revoked = await db.request(
      `/tokens/${revokedToken.body.id}`,
      { method: 'DELETE' },
      who.cookie,
    );
    expect(revoked.status).toBe(200);
    expect(
      (await bearer(revokedToken.body.token as string, '/projects')).status,
    ).toBe(401);
    const expiring = await createToken(who, {
      name: 'Short',
      expiresInDays: 1,
    });
    db.sqlite
      .prepare('UPDATE api_tokens SET expires_at=? WHERE id=?')
      .run(Math.floor(Date.now() / 1000) - 1, expiring.body.id);
    expect(
      (await bearer(expiring.body.token as string, '/projects')).status,
    ).toBe(401);
    const kept = (await createToken(who, { name: 'Kept' })).body
      .token as string;
    expect((await bearer(kept, '/projects')).status).toBe(200);
    // Someone else stays in the workspace after the token's owner is removed.
    const colleague = await db.user(4);
    db.sqlite
      .prepare('INSERT INTO memberships VALUES (?,?,?)')
      .run(who.workspaceId, colleague.userId, 'owner');
    db.sqlite
      .prepare('DELETE FROM memberships WHERE user_id=? AND workspace_id=?')
      .run(who.userId, who.workspaceId);
    expect((await bearer(kept, '/projects')).status).toBe(401);
  });

  it('cannot create tokens, approve CLI logins, connect accounts or turn Free-only off', async () => {
    const who = await db.user(1);
    const token = (await createToken(who)).body.token as string;
    const project = (await (
      await bearer(token, '/projects', {
        method: 'POST',
        body: JSON.stringify(projectInput('agent-app')),
      })
    ).json()) as { id: string };
    for (const [path, method, body] of [
      ['/tokens', 'POST', { name: 'Escalate' }],
      ['/workspace/members', 'GET', undefined],
      ['/workspace/invitations', 'POST', { login: 'someone' }],
      ['/cli/login/approve', 'POST', { code: 'BCDF-GHJK' }],
      ['/auth/cloudflare/start', 'GET', undefined],
      ['/connections/cloudflare', 'DELETE', undefined],
      [
        `/projects/${project.id}/free-only`,
        'PUT',
        { freeOnly: false, confirm: true },
      ],
      [
        `/projects/${project.id}/budget`,
        'PUT',
        { monthlyCents: 10_000_000, onExceed: 'alert' },
      ],
      [
        `/projects/${project.id}/budget/pause`,
        'POST',
        { requestId: crypto.randomUUID(), confirm: true },
      ],
      [
        `/projects/${project.id}/budget/resume`,
        'POST',
        { requestId: crypto.randomUUID(), confirm: true },
      ],
    ] as const) {
      const response = await bearer(token, path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lets a token list its person’s tokens and revoke them, never create one', async () => {
    const who = await db.user(1);
    const cli = (await createToken(who, { name: 'CLI' })).body;
    const ci = (await createToken(who, { name: 'CI', expiresInDays: 30 })).body;
    const other = await db.user(2);
    const theirs = (await createToken(other, { name: 'Theirs' })).body;
    const listed = (await (
      await bearer(cli.token as string, '/tokens')
    ).json()) as { id: string; name: string; current: boolean }[];
    // The one the request came with is marked, and nobody else's is there. (Both were
    // made in the same second, so their order isn't part of this.)
    expect(listed.map((t) => [t.name, t.current]).sort()).toEqual([
      ['CI', false],
      ['CLI', true],
    ]);
    expect(JSON.stringify(listed)).not.toContain(theirs.id as string);
    // Another person's token isn't found; one's own is revoked and stops working.
    expect(
      (
        await bearer(cli.token as string, `/tokens/${theirs.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await bearer(cli.token as string, `/tokens/${ci.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect((await bearer(ci.token as string, '/projects')).status).toBe(401);
    expect(
      (
        await bearer(cli.token as string, '/tokens', {
          method: 'POST',
          body: JSON.stringify({ name: 'More' }),
        })
      ).status,
    ).toBe(403);
    // The workspaces the person belongs to, and the one the token acts in.
    await db.request(
      '/workspaces',
      { method: 'POST', body: JSON.stringify({ name: 'Acme' }) },
      who.cookie,
    );
    expect(
      await (await bearer(cli.token as string, '/me/workspaces')).json(),
    ).toEqual([
      {
        id: expect.stringMatching(/^team-/),
        name: 'Acme',
        kind: 'team',
        role: 'owner',
        current: false,
      },
      {
        id: who.workspaceId,
        name: 'workspace-1',
        kind: 'personal',
        role: 'owner',
        current: true,
      },
    ]);
  });

  it('lets only a signed-in workspace owner create, list or revoke tokens', async () => {
    const owner = await db.user(1);
    const member = await db.user(2, 'viewer');
    expect((await createToken(member)).status).toBe(403);
    const mine = await createToken(owner, { name: 'Mine' });
    const other = await db.user(3);
    expect(
      (
        await db.request(
          `/tokens/${mine.body.id}`,
          { method: 'DELETE' },
          other.cookie,
        )
      ).status,
    ).toBe(404);
    expect((await bearer(mine.body.token as string, '/projects')).status).toBe(
      200,
    );
  });
});

describe('what a token can’t do', () => {
  it('leaves standing integrations and who reads an app’s data to the dashboard', () => {
    for (const path of [
      'notifications',
      'notifications/telegram',
      'access',
      'backend/data',
    ])
      for (const method of ['PUT', 'POST', 'DELETE'])
        expect([
          path,
          method,
          tokenForbidden(`/api/projects/p1/${path}`, method),
        ]).toEqual([path, method, true]);
    expect(tokenForbidden('/api/projects/p1/backend/data', 'GET')).toBe(false);
    expect(tokenForbidden('/api/projects/p1/backend/settings', 'PUT')).toBe(
      false,
    );
  });
});

describe('CLI device login', () => {
  async function start(host = 'ada-laptop') {
    const response = await cli('/cli/login', { host });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      code: string;
      deviceSecret: string;
      verificationUrl: string;
      expiresIn: number;
      interval: number;
    };
  }
  const poll = (deviceSecret: string) =>
    cli('/cli/login/poll', { deviceSecret });

  it('signs the CLI in once the person approves the code in the dashboard', async () => {
    const who = await db.user(1);
    const login = await start();
    expect(login.code).toMatch(/^[B-Z2-9]{4}-[B-Z2-9]{4}$/);
    expect(login.verificationUrl).toBe(
      `https://shipcel.test/app/#cli-login?code=${login.code}`,
    );
    expect(login).toMatchObject({ expiresIn: 600, interval: 2 });
    expect((await poll(login.deviceSecret)).status).toBe(202);
    const info = async () =>
      (await db.request(`/cli/login/${login.code}`, {}, who.cookie)).json();
    const pending = (await info()) as Record<string, unknown>;
    expect(pending).toMatchObject({
      code: login.code,
      host: 'ada-laptop',
      status: 'pending',
      mine: false,
    });
    // Who decides a sign-in is never part of what the page is told.
    expect(Object.keys(pending).sort()).toEqual([
      'code',
      'createdAt',
      'expiresAt',
      'host',
      'mine',
      'status',
    ]);
    const approved = await db.request(
      '/cli/login/approve',
      { method: 'POST', body: JSON.stringify({ code: login.code }) },
      who.cookie,
    );
    expect(approved.status).toBe(200);
    // The page can tell the person who approved it that it is theirs; nobody else.
    expect(await info()).toMatchObject({ status: 'approved', mine: true });
    const other = await db.user(2);
    expect(
      await (
        await db.request(`/cli/login/${login.code}`, {}, other.cookie)
      ).json(),
    ).toMatchObject({ status: 'approved', mine: false });
    // Nor the same person looking from another of their workspaces.
    await db.request(
      '/workspaces',
      { method: 'POST', body: JSON.stringify({ name: 'Acme' }) },
      who.cookie,
    );
    expect(await info()).toMatchObject({ status: 'approved', mine: false });
    const done = await poll(login.deviceSecret);
    expect(done.status).toBe(200);
    const { token } = (await done.json()) as { token: string };
    expect(token).toMatch(/^cc_pat_/);
    expect((await bearer(token, '/projects')).status).toBe(200);
    expect((await poll(login.deviceSecret)).status).toBe(410);
    expect(
      (
        db.sqlite.prepare('SELECT name FROM api_tokens').get() as {
          name: string;
        }
      ).name,
    ).toBe('CLI on ada-laptop');
    expect(everything()).not.toContain(token);
    expect(everything()).not.toContain(login.deviceSecret);
  });

  it('creates a named token asked for from the terminal once the person approves it', async () => {
    const who = await db.user(1);
    const response = await cli('/cli/login', {
      host: 'build-box',
      token: { name: 'CI deploy', expiresInDays: 30 },
    });
    expect(response.status).toBe(201);
    const request = (await response.json()) as {
      code: string;
      deviceSecret: string;
      verificationUrl: string;
    };
    // The page knows from the link, and from the code, that it approves a token.
    expect(request.verificationUrl).toBe(
      `https://shipcel.test/app/#cli-login?code=${request.code}&token=1`,
    );
    expect(
      await (
        await db.request(`/cli/login/${request.code}`, {}, who.cookie)
      ).json(),
    ).toMatchObject({
      status: 'pending',
      host: 'build-box',
      token: { name: 'CI deploy', expiresInDays: 30 },
    });
    await db.request(
      '/cli/login/approve',
      { method: 'POST', body: JSON.stringify({ code: request.code }) },
      who.cookie,
    );
    const done = await poll(request.deviceSecret);
    expect(done.status).toBe(200);
    const created = (await done.json()) as {
      token: string;
      id: string;
      name: string;
      expiresAt: number;
    };
    expect(created.name).toBe('CI deploy');
    expect(created.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(
      30 * 86400 - 60,
    );
    expect(
      created.expiresAt - Math.floor(Date.now() / 1000),
    ).toBeLessThanOrEqual(30 * 86400);
    expect((await bearer(created.token, '/projects')).status).toBe(200);
    expect(
      (
        db.sqlite
          .prepare('SELECT name FROM api_tokens WHERE id=?')
          .get(created.id) as {
          name: string;
        }
      ).name,
    ).toBe('CI deploy');
    expect(everything()).not.toContain(created.token);
    // Always an end date, at most a year; and a name.
    for (const token of [
      { name: 'Forever', expiresInDays: 366 },
      { name: 'Never', expiresInDays: 0 },
      { name: '', expiresInDays: 30 },
      { name: 'No days' },
    ])
      expect(
        (await cli('/cli/login', { token })).status,
        JSON.stringify(token),
      ).toBe(400);
  });

  it('reports denied and expired logins, and refuses guessed secrets', async () => {
    const who = await db.user(1);
    const denied = await start();
    await db.request(
      '/cli/login/deny',
      { method: 'POST', body: JSON.stringify({ code: denied.code }) },
      who.cookie,
    );
    expect((await poll(denied.deviceSecret)).status).toBe(403);
    const expired = await start();
    db.sqlite
      .prepare('UPDATE cli_logins SET expires_at=? WHERE code=?')
      .run(Math.floor(Date.now() / 1000) - 1, expired.code);
    expect((await poll(expired.deviceSecret)).status).toBe(410);
    expect(
      (
        await db.request(
          '/cli/login/approve',
          { method: 'POST', body: JSON.stringify({ code: expired.code }) },
          who.cookie,
        )
      ).status,
    ).toBe(410);
    expect((await poll('x'.repeat(43))).status).toBe(410);
  });

  it('needs a signed-in owner to approve', async () => {
    const login = await start();
    const member = await db.user(2, 'viewer');
    expect(
      (
        await db.request(
          '/cli/login/approve',
          { method: 'POST', body: JSON.stringify({ code: login.code }) },
          member.cookie,
        )
      ).status,
    ).toBe(403);
    expect((await poll(login.deviceSecret)).status).toBe(202);
  });

  it('limits how often logins can start and be polled', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++)
      statuses.push(
        (
          await cli(
            '/cli/login',
            { host: 'busy' },
            { 'CF-Connecting-IP': '203.0.113.7' },
          )
        ).status,
      );
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    const login = await start();
    let last = 0;
    for (let i = 0; i < 41; i++) last = (await poll(login.deviceSecret)).status;
    expect(last).toBe(429);
  });
});
