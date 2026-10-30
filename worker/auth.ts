import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  AppError,
  appOrigin,
  localMode,
  now,
  type AppEnv,
  type Env,
  type Identity,
} from './types';
import { digest, randomToken, seal, unseal } from './crypto';
import {
  cloudflare,
  github,
  OAuthError,
  oauthError,
  providerJSON,
} from './providers';
import { providerApp } from './provider-apps';

export const auth = new Hono<AppEnv>();
type Provider = 'github' | 'cloudflare';
export type Tokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};
export type Grant = {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: Provider;
  encrypted_tokens: string | null;
  expires_at: number | null;
  status: string;
  revision: number;
  account_id: string | null;
  account_name: string | null;
  scopes?: string | null;
};
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().max(8192).optional(),
  expires_in: z.number().positive().optional(),
  token_type: z.string().optional(),
  // The scopes granted, when the provider says (OAuth 2.0 section 5.1).
  scope: z.string().max(4000).optional(),
});
const cookieName = (c: Context<AppEnv>, suffix: string) =>
  `${new URL(c.req.url).protocol === 'https:' ? '__Host-' : ''}cloudcel_${suffix}`;
const cookieOptions = (c: Context<AppEnv>, maxAge: number) => ({
  httpOnly: true,
  secure: new URL(c.req.url).protocol === 'https:',
  sameSite: 'Lax' as const,
  path: '/',
  maxAge,
});

// Where the browser lands after a sign-in that the shipcel CLI's page started, so the person
// carries on there instead of on Connections: the pending CLI sign-in (`cli-login:<code>`) or
// the CLI's setup page (`cli-setup`). Only these two in-app addresses are ever produced;
// anything else goes back to Connections.
const cliCode = /^[B-DF-HJ-NP-TV-XZ2-9]{4}-[B-DF-HJ-NP-TV-XZ2-9]{4}$/;
export function returnHash(target: string | null | undefined) {
  if (target === 'cli-setup') return 'cli-setup';
  // An AI agent's OAuth sign-in, waiting on the approval page (worker/oauth-server.ts).
  if (target?.startsWith('oauth:') && /^[\w-]{20,64}$/.test(target.slice(6)))
    return `oauth/${target.slice(6)}`;
  const code = target?.startsWith('cli-login:') ? target.slice(10) : '';
  return cliCode.test(code) ? `cli-login?code=${code}` : null;
}

// Cloudflare's Workers Editor scope (workers-scripts.edit) updates existing Workers but can't
// create one; Workers Scripts Write can. Known only when the connection, or the client it was
// granted through, lists Workers Editor without Workers Scripts Write.
export const cannotCreateWorkers =
  'Your Cloudflare connection can update Workers but not create new ones: it was granted Workers Editor instead of Workers Scripts Write. Update Cloudflare sign-in in Connections, then connect Cloudflare again.';
export async function createsWorkers(env: Env, grant: Grant) {
  const scopes = (
    grant.scopes ??
    (await providerApp(env, 'cloudflare').catch(() => null))?.scopes.join(
      ' ',
    ) ??
    ''
  )
    .split(/\s+/)
    .filter(Boolean);
  return (
    !scopes.includes('workers-scripts.edit') ||
    scopes.includes('workers-scripts.write')
  );
}

// Whether a provider's app is set up: in the environment, or from the Connections page.
export const configured = async (env: Env, provider: Provider) =>
  Boolean(await providerApp(env, provider));
export async function identity(c: Context<AppEnv>): Promise<Identity | null> {
  const raw = getCookie(c, cookieName(c, 'session'));
  if (raw && c.env.DB) {
    const hash = await digest(raw);
    const session = await c.env.DB.prepare(
      'SELECT s.user_id AS userId, s.workspace_id AS workspaceId, u.login, m.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
    )
      .bind(hash, now())
      .first<Omit<Identity, 'sessionHash'>>();
    if (session) return { ...session, sessionHash: hash, via: 'session' };
    // An invalid supplied session must never fall back to a local owner.
    return null;
  }
  return localMode(c.env, c.req.raw)
    ? {
        userId: 'local-owner',
        workspaceId: 'local',
        login: 'Local workspace',
        role: 'owner',
        sessionHash: null,
      }
    : null;
}
// What a request needs: any member ('view'), a developer or owner ('deploy'), or an owner.
export function requireIdentity(
  c: Context<AppEnv>,
  need: 'view' | 'deploy' | 'owner' = 'view',
) {
  const who = c.get('identity');
  if (!who) throw new AppError(401, 'Sign in with GitHub to continue.');
  if (need === 'owner' && who.role !== 'owner')
    throw new AppError(403, 'Workspace owner access is required.');
  if (need === 'deploy' && who.role === 'viewer')
    throw new AppError(
      403,
      'Viewers can’t change projects. Ask a workspace owner for developer access.',
    );
  return who;
}
export async function limit(
  env: Env,
  key: string,
  maximum: number,
  window = 60,
) {
  if (!env.DB) return;
  const row = await env.DB.prepare(
    'INSERT INTO request_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count',
  )
    .bind(key, now() + window, now(), now())
    .first<{ count: number }>();
  if (row && row.count > maximum)
    throw new AppError(429, 'Too many requests. Wait a minute and try again.');
}
export async function activeGrant(
  env: Env,
  workspaceId: string,
  provider: Provider,
) {
  return env.DB.prepare(
    "SELECT * FROM provider_grants WHERE workspace_id=? AND provider=? AND status='active'",
  )
    .bind(workspaceId, provider)
    .first<Grant>();
}
async function exchange(env: Env, provider: Provider, params: URLSearchParams) {
  const app = await providerApp(env, provider);
  if (!app) throw new AppError(503, 'Provider configuration is incomplete.');
  const url =
    provider === 'github'
      ? 'https://github.com/login/oauth/access_token'
      : 'https://dash.cloudflare.com/oauth2/token';
  params.set('client_id', app.clientId);
  params.set('client_secret', app.clientSecret);
  const result = await providerJSON<unknown>(
    url,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    },
    { oauth: true },
  );
  const parsed = tokenSchema.safeParse(result);
  if (parsed.success) return parsed.data;
  throw (
    oauthError(result) ??
    new AppError(502, 'The provider returned an unexpected token response.')
  );
}
// Only the provider's refusal of the refresh token itself ends a connection. A timeout, a 5xx,
// a rate limit or a refusal of Shipcel's own sign-in app leaves it as it was, unlocked, for
// the next call to try again. None of these is a 401, which the CLI reads as its own token
// having expired.
const REFRESH_REFUSED = new Set(['invalid_grant', 'bad_refresh_token']);
async function refreshFailed(
  env: Env,
  grant: Grant,
  error: unknown,
): Promise<never> {
  const name = grant.provider === 'github' ? 'GitHub' : 'Cloudflare';
  const refused =
    error instanceof OAuthError && REFRESH_REFUSED.has(error.code);
  await env.DB.prepare(
    refused
      ? "UPDATE provider_grants SET status='reconnect_required', encrypted_tokens=NULL, refresh_lock_until=0 WHERE id=? AND revision=? AND status='active'"
      : 'UPDATE provider_grants SET refresh_lock_until=0 WHERE id=? AND revision=?',
  )
    .bind(grant.id, grant.revision)
    .run();
  if (error instanceof OAuthError)
    throw refused
      ? new AppError(
          409,
          `${name} no longer accepts this connection (${error.code}). Connect ${name} again.`,
        )
      : new AppError(
          502,
          `${name} refused Shipcel’s sign-in app (${error.code}). The connection is kept: check the app’s client ID and secret.`,
        );
  throw new AppError(
    503,
    `Couldn’t renew Shipcel’s access to ${name} just now. The connection is kept: try again in a minute.`,
  );
}
export async function grantToken(env: Env, grant: Grant): Promise<string> {
  if (grant.status !== 'active' || !grant.encrypted_tokens)
    throw new AppError(401, 'Reconnect this provider account.');
  const context = `${grant.workspace_id}:${grant.provider}:${grant.id}`;
  const tokens = await unseal<Tokens>(
    grant.encrypted_tokens,
    env.TOKEN_ENCRYPTION_KEY,
    context,
  );
  if (!grant.expires_at || grant.expires_at > now() + 90)
    return tokens.access_token;
  if (!tokens.refresh_token)
    throw new AppError(
      401,
      'Provider authorization expired. Reconnect the account.',
    );
  const lock = await env.DB.prepare(
    "UPDATE provider_grants SET refresh_lock_until=? WHERE id=? AND status='active' AND revision=? AND refresh_lock_until<=? RETURNING id",
  )
    .bind(now() + 30, grant.id, grant.revision, now())
    .first();
  if (!lock)
    throw new AppError(
      409,
      'Authorization is being refreshed. Try again shortly.',
    );
  const next = await exchange(
    env,
    grant.provider,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  ).catch((error: unknown) => refreshFailed(env, grant, error));
  const updated = await env.DB.prepare(
    "UPDATE provider_grants SET encrypted_tokens=?, expires_at=?, scopes=COALESCE(?, scopes), revision=revision+1, refresh_lock_until=0 WHERE id=? AND status='active' AND revision=? RETURNING id",
  )
    .bind(
      await seal(
        {
          ...next,
          refresh_token: next.refresh_token || tokens.refresh_token,
        },
        env.TOKEN_ENCRYPTION_KEY,
        context,
      ),
      next.expires_in ? now() + next.expires_in : null,
      next.scope ?? null,
      grant.id,
      grant.revision,
    )
    .first();
  if (!updated)
    throw new AppError(401, 'Provider access was disconnected during refresh.');
  return next.access_token;
}
async function saveGrant(
  env: Env,
  who: Identity,
  provider: Provider,
  tokens: Tokens,
) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE provider_grants SET status='replaced', encrypted_tokens=NULL WHERE workspace_id=? AND provider=? AND status='active'",
    ).bind(who.workspaceId, provider),
    env.DB.prepare(
      'INSERT INTO provider_grants(id,workspace_id,user_id,provider,encrypted_tokens,expires_at,created_at,scopes) VALUES (?,?,?,?,?,?,?,?)',
    ).bind(
      id,
      who.workspaceId,
      who.userId,
      provider,
      await seal(
        tokens,
        env.TOKEN_ENCRYPTION_KEY,
        `${who.workspaceId}:${provider}:${id}`,
      ),
      tokens.expires_in ? now() + tokens.expires_in : null,
      now(),
      tokens.scope ?? null,
    ),
  ]);
  return id;
}

// The account a new Cloudflare connection deploys to, so connecting is all it takes: the one
// chosen before when the new connection still reaches it, or else the only one it can see.
// With several and no earlier choice, the owner picks on Connections. Never fails a sign-in.
async function chooseAccount(
  env: Env,
  workspaceId: string,
  grantId: string,
  token: string,
) {
  const account = z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    name: z.string().max(200),
  });
  try {
    const before = await env.DB.prepare(
      "SELECT account_id FROM provider_grants WHERE workspace_id=? AND provider='cloudflare' AND id<>? AND account_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
      .bind(workspaceId, grantId)
      .first<{ account_id: string }>();
    let chosen = before
      ? await cloudflare(token, `/accounts/${before.account_id}`).then(
          (a) => account.parse(a),
          () => undefined,
        )
      : undefined;
    if (!chosen) {
      const all = z
        .array(account)
        .parse(await cloudflare(token, '/accounts?per_page=2'));
      if (all.length === 1) chosen = all[0];
    }
    if (chosen)
      await env.DB.prepare(
        "UPDATE provider_grants SET account_id=?,account_name=? WHERE id=? AND status='active'",
      )
        .bind(chosen.id, chosen.name, grantId)
        .run();
  } catch {
    // The owner chooses on Connections.
  }
}

auth.get('/session', async (c) => {
  const who = c.get('identity');
  // Every workspace the person belongs to, teams first, for the workspace switcher.
  const workspaces = who
    ? (
        await c.env.DB.prepare(
          "SELECT w.id, w.name, m.role, w.kind FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.kind='personal', w.name, w.id",
        )
          .bind(who.userId)
          .all<{ id: string; name: string; role: string; kind: string }>()
      ).results
    : [];
  return c.json({
    user: who
      ? {
          login: who.login,
          workspaceId: who.workspaceId,
          role: who.role,
          local: !who.sessionHash,
          workspaces,
        }
      : null,
    githubConfigured: await configured(c.env, 'github'),
    local: localMode(c.env, c.req.raw),
  });
});
// Moves the browser session to another workspace the person belongs to.
auth.post('/workspace', async (c) => {
  const who = requireIdentity(c);
  if (!who.sessionHash || who.via !== 'session')
    throw new AppError(401, 'Sign in with GitHub to switch workspaces.');
  const { workspaceId } = z
    .object({ workspaceId: z.string().min(1).max(100) })
    .strict()
    .parse(await c.req.json());
  const member = await c.env.DB.prepare(
    'SELECT role FROM memberships WHERE workspace_id=? AND user_id=?',
  )
    .bind(workspaceId, who.userId)
    .first();
  if (!member) throw new AppError(404, 'Workspace not found.');
  await c.env.DB.prepare(
    'UPDATE sessions SET workspace_id=? WHERE token_hash=?',
  )
    .bind(workspaceId, who.sessionHash)
    .run();
  return c.json({ workspaceId });
});
auth.post('/logout', async (c) => {
  const raw = getCookie(c, cookieName(c, 'session'));
  if (raw)
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
      .bind(await digest(raw))
      .run();
  deleteCookie(c, cookieName(c, 'session'), cookieOptions(c, 0));
  return c.json({ ok: true });
});
// The GitHub App's setup URL: GitHub sends people here after they install the app or change
// its repositories. The installation_id it adds isn't trusted or used; the pages ask GitHub for
// the person's installations themselves.
auth.get('/github/installed', (c) => {
  const back = returnHash(getCookie(c, cookieName(c, 'github_return')));
  deleteCookie(c, cookieName(c, 'github_return'), cookieOptions(c, 0));
  return c.redirect(`/app/?connection=repositories#${back ?? 'connections'}`);
});
auth.get('/:provider/start', async (c) => {
  const provider = z
    .enum(['github', 'cloudflare'])
    .parse(c.req.param('provider'));
  const app = await providerApp(c.env, provider);
  if (!app)
    throw new AppError(
      503,
      `${provider === 'github' ? 'GitHub App' : 'Cloudflare OAuth'} registration is not configured. Set it up in Connections, or see docs/provider-setup.md.`,
    );
  const who = c.get('identity');
  if (provider === 'cloudflare' && (!who?.sessionHash || who.role !== 'owner'))
    throw new AppError(
      401,
      'Sign in with GitHub before connecting Cloudflare.',
    );
  await limit(
    c.env,
    `oauth:${c.req.header('CF-Connecting-IP') || 'local'}`,
    10,
  );
  const state = randomToken(),
    browser = randomToken(),
    verifier = randomToken();
  const stateHash = await digest(state);
  const returnTo = c.req.query('return');
  await c.env.DB.prepare(
    'INSERT INTO oauth_states(state_hash,provider,browser_hash,verifier,user_id,workspace_id,session_hash,expires_at,return_to) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      stateHash,
      provider,
      await digest(browser),
      await seal(verifier, c.env.TOKEN_ENCRYPTION_KEY, stateHash),
      who?.userId || null,
      who?.workspaceId || null,
      who?.sessionHash || null,
      now() + 600,
      returnHash(returnTo) ? returnTo! : null,
    )
    .run();
  setCookie(
    c,
    cookieName(c, `oauth_${provider}`),
    browser,
    cookieOptions(c, 600),
  );
  const url = new URL(
    provider === 'github'
      ? 'https://github.com/login/oauth/authorize'
      : 'https://dash.cloudflare.com/oauth2/auth',
  );
  url.search = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: `${appOrigin(c.env, c.req.raw)}/api/auth/${provider}/callback`,
    response_type: 'code',
    state,
    code_challenge: await digest(verifier),
    code_challenge_method: 'S256',
    ...(provider === 'cloudflare' ? { scope: app.scopes.join(' ') } : {}),
  }).toString();
  return c.redirect(url.toString());
});
auth.get('/:provider/callback', async (c) => {
  const provider = z
    .enum(['github', 'cloudflare'])
    .parse(c.req.param('provider'));
  const browser = getCookie(c, cookieName(c, `oauth_${provider}`));
  const state = c.req.query('state');
  if (!browser || !state || state.length > 100)
    throw new AppError(400, 'Invalid or expired sign-in state. Start again.');
  const hash = await digest(state);
  const flow = await c.env.DB.prepare(
    'DELETE FROM oauth_states WHERE state_hash=? AND provider=? AND browser_hash=? AND expires_at>? RETURNING *',
  )
    .bind(hash, provider, await digest(browser), now())
    .first<{
      verifier: string;
      user_id: string | null;
      workspace_id: string | null;
      session_hash: string | null;
      return_to: string | null;
    }>();
  deleteCookie(c, cookieName(c, `oauth_${provider}`), cookieOptions(c, 0));
  if (!flow)
    throw new AppError(400, 'Invalid or expired sign-in state. Start again.');
  // Back to where the sign-in started: Connections, or the CLI's page.
  const back = (result: 'success' | 'declined') =>
    c.redirect(
      `/app/?connection=${result}#${returnHash(flow.return_to) ?? 'connections'}`,
    );
  // Repositories are chosen in the same visit: when GitHub has no installation of Shipcel's app
  // for this person, they go on to GitHub's page for choosing repositories, and the app's setup
  // URL (/github/installed) brings them back to where they started. When GitHub can't say, they
  // land on Connections, which offers that page too.
  const repositoriesNext = async (token: string) => {
    const app = await providerApp(c.env, 'github');
    let none = false;
    try {
      none =
        z
          .object({ total_count: z.number() })
          .parse(await github(token, '/user/installations?per_page=1'))
          .total_count === 0;
    } catch (error) {
      if (!(error instanceof AppError || error instanceof z.ZodError))
        throw error;
    }
    if (!none || !app?.slug || !/^[\w-]+$/.test(app.slug))
      return back('success');
    setCookie(
      c,
      cookieName(c, 'github_return'),
      flow.return_to ?? 'connections',
      cookieOptions(c, 3600),
    );
    return c.redirect(`https://github.com/apps/${app.slug}/installations/new`);
  };
  if (c.req.query('error')) return back('declined');
  const code = c.req.query('code');
  if (!code || code.length > 4096)
    throw new AppError(400, 'Authorization code is missing or invalid.');
  if (!(await configured(c.env, provider)))
    throw new AppError(503, 'Provider configuration is incomplete.');
  let who = c.get('identity');
  if (
    flow.session_hash &&
    (!who ||
      who.sessionHash !== flow.session_hash ||
      who.userId !== flow.user_id ||
      who.workspaceId !== flow.workspace_id)
  ) {
    throw new AppError(
      403,
      'The account-connection session changed. Start again.',
    );
  }
  if (
    provider === 'cloudflare' &&
    (!who ||
      !flow.session_hash ||
      who.sessionHash !== flow.session_hash ||
      who.userId !== flow.user_id ||
      who.workspaceId !== flow.workspace_id ||
      who.role !== 'owner')
  )
    throw new AppError(
      403,
      'The account-connection session changed. Start again.',
    );
  const tokens = await exchange(
    c.env,
    provider,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: await unseal<string>(
        flow.verifier,
        c.env.TOKEN_ENCRYPTION_KEY,
        hash,
      ),
      redirect_uri: `${appOrigin(c.env, c.req.raw)}/api/auth/${provider}/callback`,
    }),
  );
  if (provider === 'github') {
    const user = z
      .object({
        id: z.number().int().positive(),
        login: z.string().regex(/^[\w-]{1,100}$/),
      })
      .parse(await github(tokens.access_token, '/user'));
    if (
      flow.session_hash &&
      (!who ||
        who.sessionHash !== flow.session_hash ||
        who.userId !== `gh-${user.id}`)
    )
      throw new AppError(
        403,
        'Sign in with the GitHub account that owns this session.',
      );
    // Connecting GitHub while signed in saves the connection in the current workspace,
    // which only its owners may change.
    if (flow.session_hash && who) {
      if (who.role !== 'owner')
        throw new AppError(
          403,
          'Only workspace owners can connect accounts. Ask an owner to connect GitHub.',
        );
      await c.env.DB.prepare('UPDATE users SET login=? WHERE id=?')
        .bind(user.login, who.userId)
        .run();
      await saveGrant(c.env, who, provider, tokens);
      return repositoriesNext(tokens.access_token);
    }
    const userId = `gh-${user.id}`,
      workspaceId = `personal-${user.id}`;
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO users(id,github_id,login,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login',
      ).bind(userId, String(user.id), user.login, now()),
      c.env.DB.prepare(
        "INSERT INTO memberships(workspace_id,user_id,role) SELECT ?,?,'owner' WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE id=?)",
      ).bind(workspaceId, userId, workspaceId),
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES (?,?,?)',
      ).bind(workspaceId, `${user.login}'s workspace`, now()),
    ]);
    // Never silently re-add a membership removed by a workspace administrator.
    const membership = await c.env.DB.prepare(
      'SELECT role FROM memberships WHERE workspace_id=? AND user_id=?',
    )
      .bind(workspaceId, userId)
      .first<{ role: Identity['role'] }>();
    if (!membership)
      throw new AppError(403, 'Workspace membership is not available.');
    const raw = randomToken();
    if (who?.sessionHash)
      await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
        .bind(who.sessionHash)
        .run();
    const sessionHash = await digest(raw);
    await c.env.DB.prepare(
      'INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at) VALUES (?,?,?,?)',
    )
      .bind(sessionHash, userId, workspaceId, now() + 86400)
      .run();
    setCookie(c, cookieName(c, 'session'), raw, cookieOptions(c, 86400));
    who = {
      userId,
      workspaceId,
      login: user.login,
      role: membership.role,
      sessionHash,
    };
  }
  const grantId = await saveGrant(c.env, who!, provider, tokens);
  if (provider === 'cloudflare')
    await chooseAccount(c.env, who!.workspaceId, grantId, tokens.access_token);
  return provider === 'github'
    ? repositoriesNext(tokens.access_token)
    : back('success');
});
