import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { base64url, digest } from './crypto';
import { limit, requireIdentity } from './auth';
import {
  AppError,
  appOrigin,
  now,
  type AppEnv,
  type Env,
  type Identity,
} from './types';

// API tokens (for the shipcel CLI, AI agents through MCP, and scripts) and the CLI's
// device-code sign-in. Contract: docs/contracts/direct-deploy-and-tokens.md.

const TOKEN_PREFIX = 'cc_pat_';
const tokenPattern = /^cc_pat_[A-Za-z0-9_-]{43}$/;
const CLI_TOKEN_DAYS = 90;
// A token asked for from the terminal (`shipcel tokens add`) always expires: one without
// an end date can only be made in the dashboard.
const REQUESTED_TOKEN_DAYS = { min: 1, max: 365 };
const LOGIN_LIFETIME = 600;
// No vowels or look-alike characters, so codes are easy to read and never spell words.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const newToken = () => `${TOKEN_PREFIX}${base64url(randomBytes(32))}`;
const newCode = () => {
  const chars = [...randomBytes(8)].map(
    (b) => CODE_ALPHABET[b % CODE_ALPHABET.length],
  );
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
};

export const bearerToken = (c: Context<AppEnv>) => {
  const header = c.req.header('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

// The identity behind an API token, or null when the token is unknown, revoked, expired,
// or its owner is no longer a member of the workspace (checked on every request).
export async function tokenIdentity(
  env: Env,
  token: string,
): Promise<Identity | null> {
  if (!tokenPattern.test(token)) return null;
  const row = await env.DB.prepare(
    'SELECT t.id, t.user_id AS userId, t.workspace_id AS workspaceId, t.last_used_at, t.project_id AS projectId, t.preview_only AS previewOnly, u.login, m.role FROM api_tokens t JOIN users u ON u.id=t.user_id JOIN memberships m ON m.workspace_id=t.workspace_id AND m.user_id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)',
  )
    .bind(await digest(token), now())
    .first<{
      id: string;
      userId: string;
      workspaceId: string;
      last_used_at: number | null;
      projectId: string | null;
      previewOnly: number;
      login: string;
      role: Identity['role'];
    }>();
  if (!row) return null;
  if (!row.last_used_at || row.last_used_at < now() - 60)
    await env.DB.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?')
      .bind(now(), row.id)
      .run();
  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    login: row.login,
    role: row.role,
    sessionHash: `pat:${row.id}`,
    via: 'token',
    ...(row.projectId
      ? {
          actionsRun: {
            projectId: row.projectId,
            previewOnly: row.previewOnly === 1,
          },
        }
      : {}),
  };
}

// What a token made for one GitHub Actions run may do: what `shipcel deploy` does for its
// project, and nothing else.
export function runTokenAllows(
  projectId: string,
  path: string,
  method: string,
) {
  const project = `/api/projects/${projectId}`;
  if (method === 'GET')
    return [
      '/api/me',
      '/api/connections',
      '/api/connections/cloudflare/subdomain',
      '/api/projects',
      `${project}/deployments`,
    ].includes(path);
  return (
    method === 'POST' &&
    (path === '/api/local-plan' ||
      (path.startsWith(`${project}/`) &&
        /^(local-plan|local-deploys|local-deploys\/[0-9a-f-]{36}\/finish|uploads|uploads\/[0-9a-f-]{36}\/(files|deploy))$/.test(
          path.slice(project.length + 1),
        )))
  );
}
export const previewOnlyRun =
  'This GitHub Actions run is for a branch other than the production branch, so it deploys a preview, and an app’s previews start after its first production deploy.';

// Things a token can never do: create tokens or decide CLI sign-ins, sign in or connect
// provider accounts, manage teams, or make a billing decision such as turning Free-only
// off, setting a budget, or pausing or resuming an app for it (reading the budget and
// checking now are fine). It may list its person's tokens and revoke them (`shipcel tokens
// ls | rm`): that only reads, or takes access away.
export function tokenForbidden(path: string, method: string) {
  return (
    /^\/api\/(auth|workspaces|workspace|invitations|setup)(\/|$)/.test(path) ||
    (/^\/api\/tokens(\/|$)/.test(path) &&
      !['GET', 'DELETE'].includes(method)) ||
    /^\/api\/cli\/login\/(?!poll$)/.test(path) ||
    (path.startsWith('/api/connections') && method !== 'GET') ||
    /^\/api\/projects\/[^/]+\/free-only$/.test(path) ||
    (/^\/api\/projects\/[^/]+\/budget(\/(pause|resume))?$/.test(path) &&
      method !== 'GET') ||
    // Notifications are standing integrations that send data out, preview protection decides
    // who sees unreleased work, and the data API who reads an app's tables: dashboard only.
    (/^\/api\/projects\/[^/]+\/(notifications|access|backend\/data)(\/|$)/.test(
      path,
    ) &&
      method !== 'GET')
  );
}

// `run`: a token for one GitHub Actions run, which reaches that project only.
export async function insertToken(
  env: Env,
  owner: { workspaceId: string; userId: string },
  name: string,
  expiresAt: number | null,
  // A project's token: a CI run's for an hour, or a deploy token (`deploy`) kept until it
  // expires or is revoked, for a CI system that can't prove which run it is.
  run?: { projectId: string; previewOnly: boolean; deploy?: boolean },
) {
  const token = newToken();
  const id = crypto.randomUUID();
  const createdAt = now();
  await env.DB.prepare(
    'INSERT INTO api_tokens (id,workspace_id,user_id,name,token_hash,prefix,created_at,expires_at,project_id,preview_only,deploy) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      owner.workspaceId,
      owner.userId,
      name,
      await digest(token),
      token.slice(0, 12),
      createdAt,
      expiresAt,
      run?.projectId ?? null,
      Number(run?.previewOnly ?? false),
      Number(run?.deploy ?? false),
    )
    .run();
  return { id, name, prefix: token.slice(0, 12), token, createdAt, expiresAt };
}

// Creating tokens and deciding CLI sign-ins need a developer or owner in a browser session;
// each person manages their own tokens.
function sessionOwner(c: Context<AppEnv>) {
  const who = requireIdentity(c, 'deploy');
  if (who.via !== 'session')
    throw new AppError(401, 'Sign in with GitHub to manage API tokens.');
  return who;
}
// Listing and revoking also work with a token (the CLI), never in the local mode, which has
// no person.
function tokenHolder(c: Context<AppEnv>) {
  const who = requireIdentity(c, 'deploy');
  if (who.via !== 'session' && who.via !== 'token')
    throw new AppError(401, 'Sign in with GitHub to manage API tokens.');
  return who;
}

export const tokens = new Hono<AppEnv>();

// Who the request acts as: the CLI's whoami.
tokens.get('/me', async (c) => {
  const who = requireIdentity(c);
  const workspace = await c.env.DB.prepare(
    'SELECT name FROM workspaces WHERE id=?',
  )
    .bind(who.workspaceId)
    .first<{ name: string }>();
  return c.json({
    login: who.login,
    workspace: who.workspaceId,
    workspaceName: workspace?.name ?? null,
    role: who.role,
    via: who.via ?? 'local',
  });
});

// The workspaces the person belongs to, and the one this request acts in: `shipcel teams
// ls`. A token works in one of them; changing teams stays in the browser.
tokens.get('/me/workspaces', async (c) => {
  const who = requireIdentity(c);
  const { results } = await c.env.DB.prepare(
    "SELECT w.id, w.name, w.kind, m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.kind='personal', w.name, w.id",
  )
    .bind(who.userId)
    .all<{ id: string; name: string; kind: string; role: string }>();
  return c.json(
    results.map((w) => ({ ...w, current: w.id === who.workspaceId })),
  );
});

tokens.get('/tokens', async (c) => {
  const who = tokenHolder(c);
  const { results } = await c.env.DB.prepare(
    // A CI run's tokens aren't the person's to manage: they expire within the hour. Deploy
    // tokens are, with the project they deploy.
    'SELECT t.id, t.name, t.prefix, t.created_at AS createdAt, t.last_used_at AS lastUsedAt, t.expires_at AS expiresAt, p.name AS project FROM api_tokens t LEFT JOIN projects p ON p.id=t.project_id WHERE t.workspace_id=? AND t.user_id=? AND t.revoked_at IS NULL AND (t.project_id IS NULL OR t.deploy=1) ORDER BY t.created_at DESC, t.id',
  )
    .bind(who.workspaceId, who.userId)
    .all<{ id: string; project: string | null }>();
  // The token this request came with, so `shipcel tokens ls` can mark this computer's.
  return c.json(
    results.map(({ project, ...t }) => ({
      ...t,
      ...(project ? { project } : {}),
      current: who.sessionHash === `pat:${t.id}`,
    })),
  );
});

tokens.post('/tokens', async (c) => {
  const who = sessionOwner(c);
  await limit(c.env, `tokens:${who.userId}`, 10);
  const input = z
    .object({
      name: z.string().trim().min(1).max(60),
      expiresInDays: z.number().int().min(1).max(365).optional(),
    })
    .strict()
    .parse(await c.req.json());
  const created = await insertToken(
    c.env,
    who,
    input.name,
    input.expiresInDays ? now() + input.expiresInDays * 86400 : null,
  );
  return c.json(created, 201);
});

tokens.delete('/tokens/:id', async (c) => {
  const who = tokenHolder(c);
  const result = await c.env.DB.prepare(
    'UPDATE api_tokens SET revoked_at=? WHERE id=? AND workspace_id=? AND user_id=? AND revoked_at IS NULL',
  )
    .bind(now(), c.req.param('id'), who.workspaceId, who.userId)
    .run();
  if (!result.meta.changes) throw new AppError(404, 'Token not found.');
  return c.json({ revoked: true });
});

// The dashboard shows a pending CLI sign-in before the owner approves it.
tokens.get('/cli/login/:code', async (c) => {
  const who = sessionOwner(c);
  const login = await c.env.DB.prepare(
    'SELECT code, host, status, created_at AS createdAt, expires_at AS expiresAt, user_id, workspace_id, token_name, token_days, token_project FROM cli_logins WHERE code=?',
  )
    .bind(c.req.param('code').toUpperCase())
    .first<{
      status: string;
      expiresAt: number;
      user_id: string | null;
      workspace_id: string | null;
      token_name: string | null;
      token_days: number | null;
      token_project: string | null;
    }>();
  if (!login) throw new AppError(404, 'This sign-in code is not valid.');
  const {
    user_id,
    workspace_id,
    token_name,
    token_days,
    token_project,
    ...shown
  } = login;
  // A deploy token names one project of the approver's workspace.
  const project = token_project
    ? await c.env.DB.prepare(
        'SELECT id, name FROM projects WHERE id=? AND workspace_id=?',
      )
        .bind(token_project, who.workspaceId)
        .first<{ id: string; name: string }>()
    : null;
  return c.json({
    ...shown,
    // A token request (`shipcel tokens add`) instead of a sign-in: what approving creates.
    ...(token_name
      ? {
          token: {
            name: token_name,
            expiresInDays: token_days,
            ...(token_project ? { project } : {}),
          },
        }
      : {}),
    status:
      login.status === 'pending' && login.expiresAt <= now()
        ? 'expired'
        : login.status,
    // Whether this person decided it, in this workspace: the page then says so instead of
    // calling the code used.
    mine: user_id === who.userId && workspace_id === who.workspaceId,
  });
});

for (const [route, status] of [
  ['/cli/login/approve', 'approved'],
  ['/cli/login/deny', 'denied'],
] as const)
  tokens.post(route, async (c) => {
    const who = sessionOwner(c);
    const { code } = z
      .object({ code: z.string().trim().toUpperCase() })
      .strict()
      .parse(await c.req.json());
    // A deploy token can only be for a project of the approver's own workspace.
    const requested = await c.env.DB.prepare(
      'SELECT token_project FROM cli_logins WHERE code=?',
    )
      .bind(code)
      .first<{ token_project: string | null }>();
    if (
      status === 'approved' &&
      requested?.token_project &&
      !(await c.env.DB.prepare(
        'SELECT 1 FROM projects WHERE id=? AND workspace_id=?',
      )
        .bind(requested.token_project, who.workspaceId)
        .first())
    )
      throw new AppError(404, 'Project not found.');
    const updated = await c.env.DB.prepare(
      "UPDATE cli_logins SET status=?, workspace_id=?, user_id=? WHERE code=? AND status='pending' AND expires_at>? RETURNING id",
    )
      .bind(status, who.workspaceId, who.userId, code, now())
      .first();
    if (!updated)
      throw new AppError(
        410,
        'This sign-in code expired or was already used. Run shipcel login again.',
      );
    return c.json({ [status]: true });
  });

// Unauthenticated: the CLI starts a sign-in and polls for its token.
export const cliLogin = new Hono<AppEnv>();

cliLogin.post('/cli/login', async (c) => {
  await limit(
    c.env,
    `cli-login:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`,
    10,
  );
  const { host, token } = z
    .object({
      host: z.string().trim().max(64).optional(),
      // `shipcel tokens add`: a named token instead of the CLI's own sign-in.
      token: z
        .object({
          name: z.string().trim().min(1).max(60),
          expiresInDays: z
            .number()
            .int()
            .min(REQUESTED_TOKEN_DAYS.min)
            .max(REQUESTED_TOKEN_DAYS.max),
          // A deploy token for one project (shipcel tokens add --project), for CI.
          projectId: z.string().uuid().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(await c.req.json());
  const deviceSecret = base64url(randomBytes(32));
  const createdAt = now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newCode();
    try {
      await c.env.DB.prepare(
        "INSERT INTO cli_logins (id,code,secret_hash,host,status,created_at,expires_at,token_name,token_days,token_project) VALUES (?,?,?,?,'pending',?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          code,
          await digest(deviceSecret),
          host?.replace(/[^\w.-]/g, '') || null,
          createdAt,
          createdAt + LOGIN_LIFETIME,
          token?.name ?? null,
          token?.expiresInDays ?? null,
          token?.projectId ?? null,
        )
        .run();
      return c.json(
        {
          code,
          deviceSecret,
          verificationUrl: `${appOrigin(c.env, c.req.raw)}/app/#cli-login?code=${code}${token ? '&token=1' : ''}`,
          expiresIn: LOGIN_LIFETIME,
          interval: 2,
        },
        201,
      );
    } catch (error) {
      if (!(error instanceof Error && /UNIQUE/.test(error.message)))
        throw error;
    }
  }
  throw new AppError(503, 'Could not start a sign-in. Try again.');
});

cliLogin.post('/cli/login/poll', async (c) => {
  const { deviceSecret } = z
    .object({ deviceSecret: z.string().min(1).max(100) })
    .strict()
    .parse(await c.req.json());
  const secretHash = await digest(deviceSecret);
  await limit(c.env, `cli-poll:${secretHash}`, 40);
  const login = await c.env.DB.prepare(
    'SELECT * FROM cli_logins WHERE secret_hash=?',
  )
    .bind(secretHash)
    .first<{
      id: string;
      status: string;
      host: string | null;
      workspace_id: string | null;
      user_id: string | null;
      expires_at: number;
      token_name: string | null;
      token_days: number | null;
      token_project: string | null;
    }>();
  if (!login || login.status === 'delivered')
    return c.json({ status: 'expired' }, 410);
  if (login.status === 'denied') return c.json({ status: 'denied' }, 403);
  if (login.status === 'pending')
    return login.expires_at <= now()
      ? c.json({ status: 'expired' }, 410)
      : c.json({ status: 'pending' }, 202);
  // Approved: hand out a new token exactly once.
  const claimed = await c.env.DB.prepare(
    "UPDATE cli_logins SET status='delivered' WHERE id=? AND status='approved' RETURNING id",
  )
    .bind(login.id)
    .first();
  if (!claimed) return c.json({ status: 'expired' }, 410);
  const created = await insertToken(
    c.env,
    { workspaceId: login.workspace_id!, userId: login.user_id! },
    login.token_name ?? `CLI on ${login.host || 'a computer'}`,
    now() + (login.token_name ? login.token_days! : CLI_TOKEN_DAYS) * 86400,
    login.token_project
      ? { projectId: login.token_project, previewOnly: false, deploy: true }
      : undefined,
  );
  await c.env.DB.prepare('UPDATE cli_logins SET token_id=? WHERE id=?')
    .bind(created.id, login.id)
    .run();
  return c.json({
    token: created.token,
    workspace: login.workspace_id,
    expiresAt: created.expiresAt,
    ...(login.token_name ? { id: created.id, name: created.name } : {}),
  });
});
