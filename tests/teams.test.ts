import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';
import app from '../worker/index';

// Teams: shared workspaces with three roles. Owners run the team, its connections and its
// billing switches; developers create, deploy and manage projects; viewers read.
let db: ReturnType<typeof database>;
type Who = Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let owner: Who;

beforeEach(async () => {
  db = database();
  owner = await db.user(1);
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

const call = (who: Who, path: string, method = 'GET', body?: unknown) =>
  db.request(
    path,
    { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    who.cookie,
  );
async function json<T = Record<string, unknown>>(response: Response) {
  return (await response.json()) as T;
}
// A team owned by `owner`, with the session switched to it.
async function team(name = 'Acme') {
  const response = await call(owner, '/workspaces', 'POST', { name });
  expect(response.status).toBe(201);
  return json<{ id: string; name: string }>(response);
}
async function invite(login: string, role: string) {
  const response = await call(owner, '/workspace/invitations', 'POST', {
    login,
    role,
  });
  expect(response.status).toBe(201);
  const body = await json<{ id: string; link: string }>(response);
  return { ...body, code: new URL(body.link).hash.split('code=')[1] };
}
async function join(who: Who, code: string) {
  const response = await call(who, `/invitations/${code}/accept`, 'POST', {});
  expect(response.status).toBe(200);
  return json<{ workspaceId: string }>(response);
}
const session = async (who: Who) =>
  json<{
    user: {
      login: string;
      workspaceId: string;
      role: string;
      workspaces: { id: string; name: string; role: string }[];
    };
  }>(await call(who, '/auth/session'));

describe('team workspaces', () => {
  it('creates a team owned by its creator and switches the session to it', async () => {
    const created = await team('Acme');
    expect(created.id).toMatch(/^team-[a-f0-9-]{36}$/);
    const { user } = await session(owner);
    expect(user).toMatchObject({ workspaceId: created.id, role: 'owner' });
    expect(user.workspaces).toEqual([
      { id: created.id, name: 'Acme', role: 'owner', kind: 'team' },
      {
        id: owner.workspaceId,
        name: 'workspace-1',
        role: 'owner',
        kind: 'personal',
      },
    ]);
    // Projects belong to the workspace the session is in.
    expect(
      (await call(owner, '/projects', 'POST', projectInput('team-app'))).status,
    ).toBe(201);
    await call(owner, '/auth/workspace', 'POST', {
      workspaceId: owner.workspaceId,
    });
    expect(
      (await json<{ name: string }[]>(await call(owner, '/projects'))).map(
        (p) => p.name,
      ),
    ).toEqual([]);
  });

  it('switches only to workspaces the person belongs to', async () => {
    const other = await db.user(2);
    const response = await call(other, '/auth/workspace', 'POST', {
      workspaceId: owner.workspaceId,
    });
    expect(response.status).toBe(404);
    expect((await session(other)).user.workspaceId).toBe(other.workspaceId);
  });
});

describe('invitations', () => {
  it('lets the invited GitHub account join with the role it was given, once', async () => {
    const acme = await team();
    const ada = await db.user(2);
    const link = await invite('USER-2', 'developer');
    expect(link.link).toMatch(
      /^https:\/\/shipcel\.test\/app\/#invite\?code=[A-Za-z0-9_-]{43}$/,
    );
    // The code itself is never stored.
    expect(
      JSON.stringify(
        db.sqlite.prepare('SELECT * FROM workspace_invitations').all(),
      ),
    ).not.toContain(link.code);
    expect(
      await json(await call(ada, `/invitations/${link.code}`)),
    ).toMatchObject({
      workspaceName: 'Acme',
      role: 'developer',
      invitedBy: 'user-1',
    });
    expect(await join(ada, link.code)).toEqual({ workspaceId: acme.id });
    expect((await session(ada)).user).toMatchObject({
      workspaceId: acme.id,
      role: 'developer',
    });
    expect(
      (await call(ada, `/invitations/${link.code}/accept`, 'POST', {})).status,
    ).toBe(410);
  });

  it('refuses other GitHub accounts and expired invitations', async () => {
    await team();
    const link = await invite('user-2', 'viewer');
    const mallory = await db.user(3);
    expect((await call(mallory, `/invitations/${link.code}`)).status).toBe(403);
    expect(
      (await call(mallory, `/invitations/${link.code}/accept`, 'POST', {}))
        .status,
    ).toBe(403);
    const ada = await db.user(2);
    db.sqlite
      .prepare('UPDATE workspace_invitations SET expires_at=?')
      .run(now() - 1);
    expect(
      (await call(ada, `/invitations/${link.code}/accept`, 'POST', {})).status,
    ).toBe(410);
    expect(
      (await call(ada, '/invitations/not-a-real-code/accept', 'POST', {}))
        .status,
    ).toBe(404);
  });

  it('lets owners list and revoke pending invitations', async () => {
    await team();
    const link = await invite('user-2', 'viewer');
    expect(
      await json<unknown[]>(await call(owner, '/workspace/invitations')),
    ).toEqual([
      expect.objectContaining({ id: link.id, login: 'user-2', role: 'viewer' }),
    ]);
    expect(
      (await call(owner, `/workspace/invitations/${link.id}`, 'DELETE')).status,
    ).toBe(200);
    const ada = await db.user(2);
    expect(
      (await call(ada, `/invitations/${link.code}/accept`, 'POST', {})).status,
    ).toBe(404);
  });
});

describe('roles', () => {
  async function member(role: 'developer' | 'viewer', number: number) {
    await team();
    const who = await db.user(number);
    await join(who, (await invite(`user-${number}`, role)).code);
    return who;
  }

  it('lets developers create and manage projects, but not the team or billing switches', async () => {
    const dev = await member('developer', 2);
    const created = await call(
      dev,
      '/projects',
      'POST',
      projectInput('dev-app'),
    );
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string }>(created);
    expect((await call(dev, `/projects/${id}/uploads`)).status).toBe(200);
    expect(
      (await call(dev, '/tokens', 'POST', { name: 'Laptop' })).status,
    ).toBe(201);
    for (const [path, method, body] of [
      [`/projects/${id}/free-only`, 'PUT', { freeOnly: false, confirm: true }],
      [
        `/projects/${id}/notifications`,
        'PUT',
        {
          url: 'https://hooks.example.com/x',
          events: ['deployment.ready'],
        },
      ],
      ['/workspace/invitations', 'POST', { login: 'someone', role: 'owner' }],
      [`/workspace/members/${dev.userId}`, 'PUT', { role: 'owner' }],
      [`/workspace/members/${owner.userId}`, 'DELETE', undefined],
    ] as const)
      expect((await call(dev, path, method, body)).status, path).toBe(403);
  });

  it('lets developers run Cloudflare operations with the team’s connection', async () => {
    const dev = await member('developer', 2);
    const teamId = (await session(owner)).user.workspaceId;
    // The owner connected Cloudflare for the team.
    await db.grant({ ...owner, workspaceId: teamId }, 'cloudflare');
    const project = await json<{ id: string }>(
      await call(dev, '/projects', 'POST', projectInput('team-app')),
    );
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,idempotency_key,created_at,updated_at,worker_tag) VALUES (?,?,?,?,'cf','gh',?,'','','','','','team-app','','deployed',?,?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        teamId,
        project.id,
        dev.userId,
        'a'.repeat(32),
        crypto.randomUUID(),
        now(),
        now(),
        'c'.repeat(32),
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
        const path = new URL(String(raw)).pathname;
        if (path.endsWith('/workers/scripts'))
          return Response.json({
            success: true,
            result: [{ id: 'team-app', tag: 'c'.repeat(32) }],
          });
        if (path.endsWith('/schedules'))
          return Response.json({
            success: true,
            result: {
              schedules: JSON.parse(String(init.body ?? '[]')),
            },
          });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const saved = await call(dev, `/projects/${project.id}/schedules`, 'PUT', {
      requestId: crypto.randomUUID(),
      confirm: true,
      crons: ['0 3 * * *'],
    });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ status: 'succeeded' });
  });

  it('keeps viewers to reading', async () => {
    const viewer = await member('viewer', 2);
    expect((await call(viewer, '/projects')).status).toBe(200);
    expect(
      (await call(viewer, '/projects', 'POST', projectInput('nope'))).status,
    ).toBe(403);
    const project = await json<{ id: string }>(
      await call(owner, '/projects', 'POST', projectInput('owned-app')),
    );
    expect((await call(viewer, `/projects/${project.id}/uploads`)).status).toBe(
      403,
    );
    expect(
      (await call(viewer, `/projects/${project.id}`, 'DELETE')).status,
    ).toBe(403);
    expect((await call(viewer, '/tokens', 'POST', { name: 'x' })).status).toBe(
      403,
    );
  });
});

describe('members', () => {
  it('lets owners change roles and remove people, ending their access at once', async () => {
    await team();
    const ada = await db.user(2);
    await join(ada, (await invite('user-2', 'developer')).code);
    const token = (
      await json<{ token: string }>(
        await call(ada, '/tokens', 'POST', { name: 'CLI' }),
      )
    ).token;
    expect(await json(await call(owner, '/workspace/members'))).toEqual([
      { userId: owner.userId, login: 'user-1', role: 'owner', you: true },
      { userId: ada.userId, login: 'user-2', role: 'developer', you: false },
    ]);
    expect(
      (
        await call(owner, `/workspace/members/${ada.userId}`, 'PUT', {
          role: 'viewer',
        })
      ).status,
    ).toBe(200);
    expect((await session(ada)).user.role).toBe('viewer');
    expect(
      (await call(owner, `/workspace/members/${ada.userId}`, 'DELETE')).status,
    ).toBe(200);
    // Her session in the team and her token there stop working.
    expect((await session(ada)).user.workspaceId).toBe(ada.workspaceId);
    const withToken = () =>
      app.request(
        'https://shipcel.test/api/me',
        { headers: { Authorization: `Bearer ${token}` } },
        db.env,
      );
    expect((await withToken()).status).toBe(401);
    // Invited back later, her old token stays revoked.
    await call(owner, '/auth/workspace', 'POST', {
      workspaceId: (await session(owner)).user.workspaces[0].id,
    });
    await join(ada, (await invite('user-2', 'developer')).code);
    expect((await withToken()).status).toBe(401);
  });

  it('never removes or demotes the last owner', async () => {
    const acme = await team();
    expect(
      (
        await call(owner, `/workspace/members/${owner.userId}`, 'PUT', {
          role: 'developer',
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(owner, `/workspace/members/${owner.userId}`, 'DELETE'))
        .status,
    ).toBe(409);
    // With a second owner, the first may leave.
    const ada = await db.user(2);
    await join(ada, (await invite('user-2', 'owner')).code);
    expect(
      (await call(owner, `/workspace/members/${owner.userId}`, 'DELETE'))
        .status,
    ).toBe(200);
    expect(
      (await session(owner)).user.workspaces.map((w) => w.id),
    ).not.toContain(acme.id);
  });

  it('never lets someone leave their personal workspace, even with another owner there', async () => {
    const ada = await db.user(2);
    // Invited as an owner of user-1's personal workspace.
    const link = await invite('user-2', 'owner');
    await join(ada, link.code);
    expect(
      (await call(owner, `/workspace/members/${owner.userId}`, 'DELETE'))
        .status,
    ).toBe(409);
  });

  it('lets anyone leave a team themselves, but not their personal workspace', async () => {
    await team();
    const ada = await db.user(2);
    await join(ada, (await invite('user-2', 'viewer')).code);
    expect(
      (await call(ada, `/workspace/members/${ada.userId}`, 'DELETE')).status,
    ).toBe(200);
    await call(owner, '/auth/workspace', 'POST', {
      workspaceId: owner.workspaceId,
    });
    expect(
      (await call(owner, `/workspace/members/${owner.userId}`, 'DELETE'))
        .status,
    ).toBe(409);
  });

  it('keeps team management out of API tokens', async () => {
    await team();
    const token = (
      await json<{ token: string }>(
        await call(owner, '/tokens', 'POST', { name: 'CLI' }),
      )
    ).token;
    for (const [path, method] of [
      ['/workspace/members', 'GET'],
      ['/workspace/invitations', 'POST'],
      ['/workspaces', 'POST'],
      ['/invitations/x/accept', 'POST'],
    ])
      expect(
        (
          await app.request(
            `https://shipcel.test/api${path}`,
            {
              method,
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              ...(method === 'POST' ? { body: '{}' } : {}),
            },
            db.env,
          )
        ).status,
        path,
      ).toBe(403);
  });
});
