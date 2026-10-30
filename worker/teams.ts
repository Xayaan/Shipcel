import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { limit, requireIdentity } from './auth';
import { base64url, digest } from './crypto';
import { AppError, appOrigin, now, type AppEnv, type Env } from './types';

// Teams: workspaces people share. Owners run the team; developers create, deploy and manage
// projects; viewers read. Invitations are links bound to one GitHub login (Shipcel sends no
// email), stored only as a hash and valid for a week.
export const teams = new Hono<AppEnv>();
const role = z.enum(['owner', 'developer', 'viewer']);
const rank = { owner: 0, developer: 1, viewer: 2 } as const;
const INVITATION_DAYS = 7;
const MAX_TEAMS = 10;
// GitHub user names: letters, digits and single hyphens, up to 39 characters.
const githubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);

// Team changes need a person signed in with GitHub, never an API token or the local mode.
function person(c: Context<AppEnv>, need: 'view' | 'owner' = 'view') {
  const who = requireIdentity(c, need);
  if (who.via !== 'session' || !who.sessionHash)
    throw new AppError(401, 'Sign in with GitHub to manage teams.');
  return who;
}
const owners = async (env: Env, workspaceId: string) =>
  (await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=? AND role='owner'",
  )
    .bind(workspaceId)
    .first<{ n: number }>())!.n;
// A person's personal workspace, from their GitHub sign-in.
export const personalWorkspace = async (env: Env, userId: string) =>
  (
    await env.DB.prepare(
      "SELECT w.id FROM users u JOIN workspaces w ON w.id='personal-' || u.github_id JOIN memberships m ON m.workspace_id=w.id AND m.user_id=u.id WHERE u.id=?",
    )
      .bind(userId)
      .first<{ id: string }>()
  )?.id ?? null;

teams.post('/workspaces', async (c) => {
  const who = person(c);
  await limit(c.env, `teams:${who.userId}`, 5, 3600);
  const { name } = z
    .object({ name: z.string().trim().min(2).max(60) })
    .strict()
    .parse(await c.req.json());
  const owned = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.role='owner' AND w.kind='team'",
  )
    .bind(who.userId)
    .first<{ n: number }>();
  if (owned!.n >= MAX_TEAMS)
    throw new AppError(409, `You own ${MAX_TEAMS} teams, the most allowed.`);
  const id = `team-${crypto.randomUUID()}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at,kind) VALUES (?,?,?,'team')",
    ).bind(id, name, now()),
    c.env.DB.prepare(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES (?,?,'owner')",
    ).bind(id, who.userId),
    c.env.DB.prepare(
      'UPDATE sessions SET workspace_id=? WHERE token_hash=?',
    ).bind(id, who.sessionHash),
  ]);
  return c.json({ id, name }, 201);
});

teams.get('/workspace/members', async (c) => {
  const who = person(c);
  const { results } = await c.env.DB.prepare(
    'SELECT m.user_id AS userId, u.login, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?',
  )
    .bind(who.workspaceId)
    .all<{ userId: string; login: string; role: keyof typeof rank }>();
  return c.json(
    results
      .sort(
        (a, b) => rank[a.role] - rank[b.role] || a.login.localeCompare(b.login),
      )
      .map((m) => ({ ...m, you: m.userId === who.userId })),
  );
});

teams.put('/workspace/members/:userId', async (c) => {
  const who = person(c, 'owner');
  const input = z
    .object({ role })
    .strict()
    .parse(await c.req.json());
  const userId = c.req.param('userId');
  const member = await c.env.DB.prepare(
    'SELECT role FROM memberships WHERE workspace_id=? AND user_id=?',
  )
    .bind(who.workspaceId, userId)
    .first<{ role: string }>();
  if (!member) throw new AppError(404, 'This person is not in the workspace.');
  if (
    member.role === 'owner' &&
    input.role !== 'owner' &&
    (await owners(c.env, who.workspaceId)) <= 1
  )
    throw new AppError(409, 'A workspace needs at least one owner.');
  await c.env.DB.prepare(
    'UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?',
  )
    .bind(input.role, who.workspaceId, userId)
    .run();
  return c.json({ userId, role: input.role });
});

// Owners remove people; anyone may leave. Access ends at once: their API tokens for the
// workspace are revoked and their sessions in it move to their personal workspace.
teams.delete('/workspace/members/:userId', async (c) => {
  const userId = c.req.param('userId');
  const self = c.get('identity')?.userId === userId;
  const who = person(c, self ? 'view' : 'owner');
  const member = await c.env.DB.prepare(
    'SELECT role FROM memberships WHERE workspace_id=? AND user_id=?',
  )
    .bind(who.workspaceId, userId)
    .first<{ role: string }>();
  if (!member) throw new AppError(404, 'This person is not in the workspace.');
  const personal = await personalWorkspace(c.env, userId);
  if (personal === who.workspaceId)
    throw new AppError(409, 'Nobody can leave their personal workspace.');
  if (member.role === 'owner' && (await owners(c.env, who.workspaceId)) <= 1)
    throw new AppError(409, 'A workspace needs at least one owner.');
  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM memberships WHERE workspace_id=? AND user_id=?',
    ).bind(who.workspaceId, userId),
    c.env.DB.prepare(
      'UPDATE api_tokens SET revoked_at=? WHERE workspace_id=? AND user_id=? AND revoked_at IS NULL',
    ).bind(now(), who.workspaceId, userId),
    personal
      ? c.env.DB.prepare(
          'UPDATE sessions SET workspace_id=? WHERE user_id=? AND workspace_id=?',
        ).bind(personal, userId, who.workspaceId)
      : c.env.DB.prepare(
          'DELETE FROM sessions WHERE user_id=? AND workspace_id=?',
        ).bind(userId, who.workspaceId),
  ]);
  return c.json({ removed: true });
});

teams.get('/workspace/invitations', async (c) => {
  const who = person(c, 'owner');
  const { results } = await c.env.DB.prepare(
    'SELECT id, login, role, created_at AS createdAt, expires_at AS expiresAt FROM workspace_invitations WHERE workspace_id=? AND accepted_at IS NULL AND expires_at>? ORDER BY created_at DESC, id',
  )
    .bind(who.workspaceId, now())
    .all();
  return c.json(results);
});

teams.post('/workspace/invitations', async (c) => {
  const who = person(c, 'owner');
  await limit(c.env, `invitations:${who.userId}`, 20, 3600);
  const input = z
    .object({ login: githubLogin, role })
    .strict()
    .parse(await c.req.json());
  const code = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = crypto.randomUUID();
  const expiresAt = now() + INVITATION_DAYS * 86400;
  await c.env.DB.prepare(
    'INSERT INTO workspace_invitations(id,workspace_id,login,role,code_hash,invited_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      who.workspaceId,
      input.login.toLowerCase(),
      input.role,
      await digest(code),
      who.userId,
      now(),
      expiresAt,
    )
    .run();
  // The link is shown once; only its hash is stored.
  return c.json(
    {
      id,
      login: input.login.toLowerCase(),
      role: input.role,
      expiresAt,
      link: `${appOrigin(c.env, c.req.raw)}/app/#invite?code=${code}`,
    },
    201,
  );
});

teams.delete('/workspace/invitations/:id', async (c) => {
  const who = person(c, 'owner');
  const result = await c.env.DB.prepare(
    'DELETE FROM workspace_invitations WHERE id=? AND workspace_id=? AND accepted_at IS NULL',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .run();
  if (!result.meta.changes) throw new AppError(404, 'Invitation not found.');
  return c.json({ revoked: true });
});

type Invitation = {
  id: string;
  workspace_id: string;
  login: string;
  role: string;
  expires_at: number;
  accepted_at: number | null;
  workspace_name: string;
  inviter: string | null;
};
// The invitation behind a code, for the GitHub account it was made for.
async function invitation(c: Context<AppEnv>, login: string) {
  const code = c.req.param('code') ?? '';
  const found = /^[A-Za-z0-9_-]{43}$/.test(code)
    ? await c.env.DB.prepare(
        'SELECT i.id, i.workspace_id, i.login, i.role, i.expires_at, i.accepted_at, w.name AS workspace_name, u.login AS inviter FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id LEFT JOIN users u ON u.id=i.invited_by WHERE i.code_hash=?',
      )
        .bind(await digest(code))
        .first<Invitation>()
    : null;
  if (!found) throw new AppError(404, 'This invitation link is not valid.');
  if (found.login !== login.toLowerCase())
    throw new AppError(
      403,
      'This invitation is for another GitHub account. Sign in with the account it was sent to.',
    );
  return found;
}

teams.get('/invitations/:code', async (c) => {
  const who = person(c);
  const found = await invitation(c, who.login);
  return c.json({
    workspaceName: found.workspace_name,
    role: found.role,
    invitedBy: found.inviter,
    login: found.login,
    accepted: found.accepted_at !== null,
    expired: found.expires_at <= now(),
  });
});

teams.post('/invitations/:code/accept', async (c) => {
  const who = person(c);
  const found = await invitation(c, who.login);
  const claimed = await c.env.DB.prepare(
    'UPDATE workspace_invitations SET accepted_by=?, accepted_at=? WHERE id=? AND accepted_at IS NULL AND expires_at>?',
  )
    .bind(who.userId, now(), found.id, now())
    .run();
  if (!claimed.meta.changes)
    throw new AppError(410, 'This invitation was already used or has expired.');
  await c.env.DB.batch([
    // Someone already in the workspace keeps their role.
    c.env.DB.prepare(
      'INSERT INTO memberships(workspace_id,user_id,role) VALUES (?,?,?) ON CONFLICT(workspace_id,user_id) DO NOTHING',
    ).bind(found.workspace_id, who.userId, found.role),
    c.env.DB.prepare(
      'UPDATE sessions SET workspace_id=? WHERE token_hash=?',
    ).bind(found.workspace_id, who.sessionHash),
  ]);
  return c.json({ workspaceId: found.workspace_id });
});
