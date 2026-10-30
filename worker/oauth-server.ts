import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { limit, requireIdentity } from './auth';
import { base64url, digest, randomToken } from './crypto';
import { insertToken } from './tokens';
import { AppError, LOCAL_HOSTS, appOrigin, now, type AppEnv } from './types';

// OAuth for the MCP server, so chat apps and agents that only sign in with OAuth (Claude.ai,
// ChatGPT and the like) can connect. Shipcel is the authorization server for its own MCP
// endpoint: a client registers itself (RFC 7591), sends the owner to the dashboard, where
// they allow or deny it after signing in with GitHub, and exchanges the code (PKCE, RFC
// 7636) for an API token of its own, the same kind the MCP server accepts already. The
// token is named after the client and listed under API & CLI, where it can be revoked.

const REQUEST_LIFETIME = 10 * 60;
const CODE_LIFETIME = 60;
const TOKEN_DAYS = 90;
const REGISTRATIONS_PER_MINUTE = 30;
const cors = { 'Access-Control-Allow-Origin': '*' };
const noStore = { ...cors, 'Cache-Control': 'no-store', Pragma: 'no-cache' };

const oauthError = (
  c: Context<AppEnv>,
  status: 400 | 401,
  error: string,
  description: string,
) => c.json({ error, error_description: description }, status, cors);

// A return address a public client may use: HTTPS, or loopback while developing.
function returnAddress(uri: string) {
  try {
    const url = new URL(uri);
    return (
      !url.hash &&
      !url.username &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)))
    );
  } catch {
    return false;
  }
}

type Row = {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string | null;
  status: string;
  workspace_id: string | null;
  user_id: string | null;
  expires_at: number;
};

export const oauthServer = new Hono<AppEnv>();
// The same guard as /api: a public Shipcel needs its sign-in configured, and answers only
// at its own address.
const guarded = async (
  c: Context<AppEnv>,
  next: () => Promise<void>,
): Promise<Response | void> => {
  if (!c.env) c.env = {} as AppEnv['Bindings'];
  const url = new URL(c.req.url);
  if (
    !LOCAL_HOSTS.has(url.hostname) &&
    (c.env.AUTH_MODE !== 'github' || !c.env.APP_ORIGIN)
  )
    return c.json(
      { error: 'Public hosting requires configured authentication.' },
      403,
    );
  if (url.origin !== appOrigin(c.env, c.req.raw))
    return c.json({ error: 'Unexpected request origin.' }, 403);
  await next();
};
oauthServer.use('/.well-known/oauth-*', guarded);
oauthServer.use('/oauth/*', guarded);
oauthServer.options('/oauth/*', (c) =>
  c.body(null, 204, {
    ...cors,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }),
);

// What MCP clients discover (RFC 9728 and RFC 8414).
const protectedResource = (c: Context<AppEnv>) => {
  const origin = appOrigin(c.env, c.req.raw);
  return c.json(
    {
      resource: `${origin}/mcp`,
      resource_name: 'Shipcel',
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    },
    200,
    cors,
  );
};
oauthServer.get('/.well-known/oauth-protected-resource', protectedResource);
oauthServer.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
oauthServer.get('/.well-known/oauth-authorization-server', (c) => {
  const origin = appOrigin(c.env, c.req.raw);
  return c.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    },
    200,
    cors,
  );
});

// Dynamic registration of public clients. Fields beyond these are accepted and ignored.
const registration = z.object({
  client_name: z.string().trim().min(1).max(80).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.string().max(40)).max(10).optional(),
  response_types: z.array(z.string().max(40)).max(10).optional(),
});
oauthServer.post('/oauth/register', async (c) => {
  await limit(c.env, 'oauth:register', REGISTRATIONS_PER_MINUTE);
  const parsed = registration.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return oauthError(
      c,
      400,
      'invalid_client_metadata',
      'Send client_name and one to ten redirect_uris.',
    );
  const bad = parsed.data.redirect_uris.find((u) => !returnAddress(u));
  if (bad)
    return oauthError(
      c,
      400,
      'invalid_redirect_uri',
      `${bad.slice(0, 100)} must be https://, or http://localhost while developing, without a #fragment.`,
    );
  const client = {
    client_id: `mcp_${randomToken()}`,
    client_name: parsed.data.client_name ?? 'An AI agent',
    redirect_uris: parsed.data.redirect_uris,
  };
  await c.env.DB.prepare(
    'INSERT INTO oauth_clients (id,name,redirect_uris,created_at) VALUES (?,?,?,?)',
  )
    .bind(
      client.client_id,
      client.client_name,
      JSON.stringify(client.redirect_uris),
      now(),
    )
    .run();
  return c.json(
    {
      ...client,
      client_id_issued_at: now(),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    201,
    cors,
  );
});

// The authorization request: checked, recorded, and sent to the dashboard to decide.
// Problems answer here rather than at a return address nobody has verified.
const authorization = z.object({
  client_id: z.string().regex(/^mcp_[\w-]{20,}$/),
  redirect_uri: z.string().max(2048),
  response_type: z.literal('code'),
  code_challenge: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(512).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(2048).optional(),
});
oauthServer.get('/oauth/authorize', async (c) => {
  const origin = appOrigin(c.env, c.req.raw);
  const parsed = authorization.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success)
    return oauthError(
      c,
      400,
      'invalid_request',
      'The authorization request needs client_id, redirect_uri, response_type=code, code_challenge and code_challenge_method=S256.',
    );
  const q = parsed.data;
  const client = await c.env.DB.prepare(
    'SELECT id, redirect_uris FROM oauth_clients WHERE id=?',
  )
    .bind(q.client_id)
    .first<{ id: string; redirect_uris: string }>();
  if (!client)
    return oauthError(
      c,
      400,
      'invalid_client',
      'Unknown client. Register it first.',
    );
  if (!(JSON.parse(client.redirect_uris) as string[]).includes(q.redirect_uri))
    return oauthError(
      c,
      400,
      'invalid_request',
      'The return address isn’t one the client registered.',
    );
  if (q.resource && q.resource !== `${origin}/mcp`)
    return oauthError(
      c,
      400,
      'invalid_target',
      `This authorization server protects ${origin}/mcp only.`,
    );
  const id = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO oauth_requests (id,client_id,redirect_uri,code_challenge,state,scope,resource,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)",
  )
    .bind(
      id,
      client.id,
      q.redirect_uri,
      q.code_challenge,
      q.state ?? null,
      q.scope ?? null,
      q.resource ?? null,
      now(),
      now() + REQUEST_LIFETIME,
    )
    .run();
  return c.redirect(`${origin}/app/#oauth/${id}`, 302);
});

// The code, once, with the verifier, for a token of the client's own.
oauthServer.post('/oauth/token', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  if (form.get('grant_type') !== 'authorization_code')
    return oauthError(
      c,
      400,
      'unsupported_grant_type',
      'Only the authorization_code grant is supported; connect the app again when its token expires.',
    );
  const code = form.get('code') ?? '';
  const verifier = form.get('code_verifier') ?? '';
  const mismatch = () =>
    oauthError(
      c,
      400,
      'invalid_grant',
      'The code is unknown, used or expired, or doesn’t match the client, return address or verifier.',
    );
  if (
    !/^[\w-]{20,128}$/.test(code) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
  )
    return mismatch();
  const row = await c.env.DB.prepare(
    "SELECT r.*, c.name AS client_name FROM oauth_requests r JOIN oauth_clients c ON c.id=r.client_id WHERE r.code_hash=? AND r.status='approved'",
  )
    .bind(await digest(code))
    .first<Row>();
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  if (
    !row ||
    row.expires_at < now() ||
    row.client_id !== form.get('client_id') ||
    row.redirect_uri !== form.get('redirect_uri') ||
    row.code_challenge !== challenge ||
    !row.workspace_id ||
    !row.user_id
  )
    return mismatch();
  // Spent before the token exists, so a code can never be exchanged twice.
  const spent = await c.env.DB.prepare(
    "UPDATE oauth_requests SET status='used' WHERE id=? AND status='approved' RETURNING id",
  )
    .bind(row.id)
    .first();
  if (!spent) return mismatch();
  const token = await insertToken(
    c.env,
    { workspaceId: row.workspace_id, userId: row.user_id },
    `${row.client_name} (MCP)`,
    now() + TOKEN_DAYS * 86400,
  );
  return c.json(
    {
      access_token: token.token,
      token_type: 'Bearer',
      expires_in: TOKEN_DAYS * 86400,
      scope: row.scope ?? 'mcp',
    },
    200,
    noStore,
  );
});

// The dashboard's side (/api/oauth/…): what the approval page shows, and the decision, by a
// signed-in developer or owner; the token is theirs, in their workspace.
export const oauthApprovals = new Hono<AppEnv>();
function approver(c: Context<AppEnv>) {
  const who = requireIdentity(c, 'deploy');
  if (who.via !== 'session')
    throw new AppError(
      401,
      'Sign in with GitHub to let an AI agent use Shipcel as you.',
    );
  return who;
}
async function pending(c: Context<AppEnv>) {
  const id = c.req.param('id') ?? '';
  if (!/^[\w-]{20,64}$/.test(id))
    throw new AppError(404, 'This request is not valid.');
  const row = await c.env.DB.prepare(
    'SELECT r.*, c.name AS client_name FROM oauth_requests r JOIN oauth_clients c ON c.id=r.client_id WHERE r.id=?',
  )
    .bind(id)
    .first<Row>();
  if (!row) throw new AppError(404, 'This request is not valid.');
  return row;
}
oauthApprovals.get('/oauth/:id', async (c) => {
  approver(c);
  const row = await pending(c);
  return c.json({
    client: {
      name: row.client_name,
      redirectHost: new URL(row.redirect_uri).hostname,
    },
    status:
      row.status === 'pending' && row.expires_at <= now()
        ? 'expired'
        : row.status,
    expiresAt: row.expires_at,
  });
});
for (const [route, status] of [
  ['/oauth/:id/approve', 'approved'],
  ['/oauth/:id/deny', 'denied'],
] as const)
  oauthApprovals.post(route, async (c) => {
    const who = approver(c);
    const row = await pending(c);
    const code = randomToken();
    const updated = await c.env.DB.prepare(
      "UPDATE oauth_requests SET status=?, code_hash=?, workspace_id=?, user_id=?, expires_at=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id",
    )
      .bind(
        status,
        status === 'approved' ? await digest(code) : null,
        who.workspaceId,
        who.userId,
        now() + CODE_LIFETIME,
        row.id,
        now(),
      )
      .first();
    if (!updated)
      throw new AppError(
        410,
        'This request expired or was decided already. Start again from the app.',
      );
    const target = new URL(row.redirect_uri);
    if (status === 'approved') target.searchParams.set('code', code);
    else target.searchParams.set('error', 'access_denied');
    if (row.state) target.searchParams.set('state', row.state);
    return c.json({ redirect: target.toString() });
  });
