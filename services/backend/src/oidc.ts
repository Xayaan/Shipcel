// OpenID Connect provider: authorization code flow with PKCE (S256) for public clients,
// ES256-signed ID and access tokens, rotating refresh tokens with reuse detection.
import { parseSigningKey, publicJwk, signEs256, verifyEs256 } from './jwt';
import {
  activeUser,
  bindToBrowser,
  browserBinding,
  currentSession,
  endSession,
  getAuthRequest,
  readSettings,
  removeExpired,
  type AuthRequest,
  type Env,
  type Settings,
  type User,
} from './store';
import {
  hashToken,
  HttpError,
  json,
  now,
  randomToken,
  sha256,
  toBase64Url,
} from './util';

export const TOKEN_LIFETIME = 3600;
const REFRESH_LIFETIME = 30 * 86400;

export const issuerOf = (request: Request) => new URL(request.url).origin;

const allowedRedirect = (uri: string) => {
  try {
    const url = new URL(uri);
    return (
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
};

export function discovery(request: Request) {
  const issuer = issuerOf(request);
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    revocation_endpoint: `${issuer}/revoke`,
    end_session_endpoint: `${issuer}/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    scopes_supported: ['openid', 'email', 'profile'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: [
      'sub',
      'email',
      'email_verified',
      'name',
      'picture',
      'auth_time',
      'nonce',
    ],
  });
}

export function jwks(env: Env) {
  return json(
    { keys: [publicJwk(parseSigningKey(env.SIGNING_KEY))] },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}

function redirectWithError(
  request: { redirect_uri: string; state: string | null },
  error: string,
  description: string,
) {
  const target = new URL(request.redirect_uri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (request.state) target.searchParams.set('state', request.state);
  return Response.redirect(target.toString(), 302);
}

// GET /authorize. Unknown apps and unregistered redirect addresses get an error page:
// redirecting to an unverified address would turn the endpoint into an open redirect.
export async function authorize(request: Request, env: Env) {
  const settings = await readSettings(env);
  if (!settings.signin)
    throw new HttpError(404, 'Sign-in is turned off for this app.');
  const params = new URL(request.url).searchParams;
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri') ?? '';
  if (!clientId || clientId !== settings.clientId)
    throw new HttpError(400, 'This app is not registered for sign-in here.');
  if (
    !settings.redirectUris.includes(redirectUri) ||
    !allowedRedirect(redirectUri)
  )
    throw new HttpError(
      400,
      'This return address is not registered for the app.',
    );
  const state = params.get('state');
  const back = { redirect_uri: redirectUri, state };
  if (state && state.length > 512)
    return redirectWithError(back, 'invalid_request', 'state is too long');
  if (params.get('response_type') !== 'code')
    return redirectWithError(
      back,
      'unsupported_response_type',
      'Only the code flow is supported',
    );
  const scope = params.get('scope') ?? '';
  if (!scope.split(' ').includes('openid'))
    return redirectWithError(
      back,
      'invalid_scope',
      'The openid scope is required',
    );
  const challenge = params.get('code_challenge') ?? '';
  if (
    params.get('code_challenge_method') !== 'S256' ||
    !/^[\w-]{43,128}$/.test(challenge)
  )
    return redirectWithError(
      back,
      'invalid_request',
      'PKCE with S256 is required',
    );
  const nonce = params.get('nonce');
  if (nonce && nonce.length > 512)
    return redirectWithError(back, 'invalid_request', 'nonce is too long');
  if (Math.random() < 0.05) await removeExpired(env);
  const authRequest: AuthRequest = {
    id: randomToken(24),
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    nonce,
    scope: scope
      .split(' ')
      .filter((s) => ['openid', 'email', 'profile'].includes(s))
      .join(' '),
    code_challenge: challenge,
    expires_at: now() + 600,
  };
  await env.DB.prepare(
    'INSERT INTO auth_requests (id,client_id,redirect_uri,state,nonce,scope,code_challenge,expires_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(
      authRequest.id,
      authRequest.client_id,
      authRequest.redirect_uri,
      authRequest.state,
      authRequest.nonce,
      authRequest.scope,
      authRequest.code_challenge,
      authRequest.expires_at,
    )
    .run();
  const prompt = params.get('prompt');
  const session =
    prompt === 'login' ? null : await currentSession(env, request);
  if (session) {
    const location = await complete(
      env,
      authRequest.id,
      session.user_id,
      session.auth_time,
    );
    return Response.redirect(location, 302);
  }
  if (prompt === 'none')
    return redirectWithError(
      back,
      'login_required',
      'The user is not signed in',
    );
  const browser = browserBinding(request);
  await bindToBrowser(
    env,
    authRequest.id,
    browser.value,
    authRequest.expires_at,
  );
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${issuerOf(request)}/sign-in?request=${authRequest.id}`,
      ...(browser.setCookie ? { 'Set-Cookie': browser.setCookie } : {}),
    },
  });
}

// Turns a finished sign-in into a one-time code for the app's return address.
export async function complete(
  env: Env,
  requestId: string,
  userId: string,
  authTime = now(),
) {
  const authRequest = await getAuthRequest(env, requestId);
  const code = randomToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_requests WHERE id=?').bind(requestId),
    env.DB.prepare(
      'INSERT INTO codes (code_hash,client_id,redirect_uri,code_challenge,nonce,scope,user_id,auth_time,expires_at,used) VALUES (?,?,?,?,?,?,?,?,?,0)',
    ).bind(
      await hashToken(code),
      authRequest.client_id,
      authRequest.redirect_uri,
      authRequest.code_challenge,
      authRequest.nonce,
      authRequest.scope,
      userId,
      authTime,
      now() + 60,
    ),
  ]);
  const target = new URL(authRequest.redirect_uri);
  target.searchParams.set('code', code);
  if (authRequest.state) target.searchParams.set('state', authRequest.state);
  return target.toString();
}

export function corsHeaders(
  request: Request,
  settings: Settings,
  methods = 'GET, POST',
): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = settings.redirectUris.some((uri) => {
    try {
      return new URL(uri).origin === origin;
    } catch {
      return false;
    }
  });
  return allowed
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': methods,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      }
    : {};
}

export async function preflight(request: Request, env: Env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, await readSettings(env)),
  });
}

async function readForm(request: Request) {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded'))
    throw new HttpError(400, 'Send the token request as form data.');
  const body = await request.text();
  if (body.length > 8192) throw new HttpError(413, 'Request is too large.');
  return new URLSearchParams(body);
}

// Signs the tokens for a response. The new refresh token is stored by the caller, so a
// rotation can claim the old token and store the new one in one transaction.
async function mintTokens(
  request: Request,
  env: Env,
  settings: Settings,
  user: User,
  options: {
    scope: string;
    nonce?: string | null;
    authTime?: number;
    family?: string;
  },
) {
  const key = parseSigningKey(env.SIGNING_KEY);
  const issuer = issuerOf(request);
  const issuedAt = now();
  const refreshToken = randomToken();
  const family = options.family ?? randomToken(16);
  const accessToken = await signEs256(
    {
      iss: issuer,
      sub: user.id,
      aud: settings.clientId,
      client_id: settings.clientId,
      scope: options.scope,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME,
      jti: randomToken(12),
    },
    key,
    'at+jwt',
  );
  const idToken = await signEs256(
    {
      iss: issuer,
      sub: user.id,
      aud: settings.clientId,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME,
      ...(options.authTime ? { auth_time: options.authTime } : {}),
      ...(options.nonce ? { nonce: options.nonce } : {}),
      ...claimsFor(user, options.scope),
    },
    key,
  );
  return {
    refresh: {
      hash: await hashToken(refreshToken),
      family,
      userId: user.id,
      clientId: settings.clientId,
      scope: options.scope,
      expiresAt: issuedAt + REFRESH_LIFETIME,
    },
    body: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_LIFETIME,
      id_token: idToken,
      refresh_token: refreshToken,
      scope: options.scope,
    },
  };
}
type Minted = Awaited<ReturnType<typeof mintTokens>>;
const refreshColumns =
  'INSERT INTO refresh_tokens (token_hash,family,user_id,client_id,scope,expires_at,used_at,revoked)';
const refreshValues = (r: Minted['refresh']) => [
  r.hash,
  r.family,
  r.userId,
  r.clientId,
  r.scope,
  r.expiresAt,
];

function claimsFor(user: User, scope: string) {
  const scopes = scope.split(' ');
  return {
    ...(scopes.includes('email') && user.email
      ? { email: user.email, email_verified: user.email_verified === 1 }
      : {}),
    ...(scopes.includes('profile')
      ? {
          ...(user.name ? { name: user.name } : {}),
          ...(user.picture ? { picture: user.picture } : {}),
        }
      : {}),
  };
}

const tokenError = (
  error: string,
  description: string,
  headers: Record<string, string>,
  status = 400,
) => json({ error, error_description: description }, { status, headers });

// POST /token
export async function token(request: Request, env: Env) {
  const settings = await readSettings(env);
  const headers = corsHeaders(request, settings);
  try {
    const form = await readForm(request);
    if (form.get('client_id') !== settings.clientId)
      return tokenError('invalid_client', 'Unknown client', headers, 401);
    if (!settings.signin)
      return tokenError(
        'unauthorized_client',
        'Sign-in is turned off for this app',
        headers,
      );
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
        return tokenError(
          'invalid_request',
          'A valid code_verifier is required',
          headers,
        );
      const stored = await env.DB.prepare(
        'UPDATE codes SET used=1 WHERE code_hash=? AND used=0 AND expires_at>? RETURNING *',
      )
        .bind(await hashToken(code), now())
        .first<{
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          nonce: string | null;
          scope: string;
          user_id: string;
          auth_time: number;
        }>();
      if (!stored)
        return tokenError(
          'invalid_grant',
          'The code is invalid, expired or already used',
          headers,
        );
      if (
        stored.client_id !== settings.clientId ||
        stored.redirect_uri !== form.get('redirect_uri')
      )
        return tokenError(
          'invalid_grant',
          'The code was issued for another request',
          headers,
        );
      if (toBase64Url(await sha256(verifier)) !== stored.code_challenge)
        return tokenError(
          'invalid_grant',
          'The code_verifier does not match',
          headers,
        );
      const user = await activeUser(env, stored.user_id);
      const minted = await mintTokens(request, env, settings, user, {
        scope: stored.scope,
        nonce: stored.nonce,
        authTime: stored.auth_time,
      });
      await env.DB.prepare(`${refreshColumns} VALUES (?,?,?,?,?,?,NULL,0)`)
        .bind(...refreshValues(minted.refresh))
        .run();
      return json(minted.body, { headers });
    }
    if (grant === 'refresh_token') {
      const hash = await hashToken(form.get('refresh_token') ?? '');
      const stored = await env.DB.prepare(
        'SELECT * FROM refresh_tokens WHERE token_hash=?',
      )
        .bind(hash)
        .first<{
          family: string;
          user_id: string;
          client_id: string;
          scope: string;
          expires_at: number;
          used_at: number | null;
          revoked: number;
        }>();
      if (
        !stored ||
        stored.revoked ||
        stored.expires_at <= now() ||
        stored.client_id !== settings.clientId
      )
        return tokenError(
          'invalid_grant',
          'The refresh token is invalid or expired',
          headers,
        );
      const endFamily = () =>
        env.DB.prepare('UPDATE refresh_tokens SET revoked=1 WHERE family=?')
          .bind(stored.family)
          .run();
      // Rotation: a refresh token works once. Reuse means it leaked, so end the whole family.
      if (stored.used_at !== null) {
        await endFamily();
        return tokenError(
          'invalid_grant',
          'The refresh token was already used',
          headers,
        );
      }
      const user = await activeUser(env, stored.user_id);
      const minted = await mintTokens(request, env, settings, user, {
        scope: stored.scope,
        family: stored.family,
      });
      // Claiming the old token and storing its successor happen in one transaction, and only
      // while no token of the family is revoked, so a concurrent reuse or revocation can't
      // leave a working successor behind. changes() is the claim's row count.
      const [claim] = await env.DB.batch([
        env.DB.prepare(
          'UPDATE refresh_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND revoked=0 AND NOT EXISTS (SELECT 1 FROM refresh_tokens f WHERE f.family=? AND f.revoked=1)',
        ).bind(now(), hash, stored.family),
        env.DB.prepare(
          `${refreshColumns} SELECT ?,?,?,?,?,?,NULL,0 WHERE changes()=1`,
        ).bind(...refreshValues(minted.refresh)),
      ]);
      if (claim.meta.changes !== 1) {
        await endFamily();
        return tokenError(
          'invalid_grant',
          'The refresh token was already used',
          headers,
        );
      }
      return json(minted.body, { headers });
    }
    return tokenError(
      'unsupported_grant_type',
      'Use authorization_code or refresh_token',
      headers,
    );
  } catch (error) {
    if (error instanceof HttpError)
      return tokenError(
        error.code === 'access_denied' ? 'invalid_grant' : error.code,
        error.message,
        headers,
        error.status >= 500 ? error.status : error.status === 413 ? 413 : 400,
      );
    throw error;
  }
}

// Verifies an access token issued by this service for this app.
export async function verifyAccessToken(
  request: Request,
  env: Env,
  value: string,
) {
  const settings = await readSettings(env);
  const claims = await verifyEs256(value, parseSigningKey(env.SIGNING_KEY), {
    typ: 'at+jwt',
  });
  if (
    claims.iss !== issuerOf(request) ||
    claims.aud !== settings.clientId ||
    typeof claims.sub !== 'string'
  )
    throw new HttpError(401, 'Invalid token.', 'invalid_token');
  return { claims, settings };
}

// GET /userinfo
export async function userinfo(request: Request, env: Env) {
  const settings = await readSettings(env);
  const headers = corsHeaders(request, settings);
  const authorization = request.headers.get('Authorization') ?? '';
  try {
    if (!authorization.startsWith('Bearer '))
      throw new HttpError(401, 'Bearer token required.', 'invalid_token');
    const { claims } = await verifyAccessToken(
      request,
      env,
      authorization.slice(7),
    );
    const user = await activeUser(env, claims.sub as string);
    return json(
      { sub: user.id, ...claimsFor(user, String(claims.scope ?? '')) },
      { headers },
    );
  } catch (error) {
    if (error instanceof HttpError)
      return json(
        { error: 'invalid_token', error_description: error.message },
        {
          status: 401,
          headers: {
            ...headers,
            'WWW-Authenticate': 'Bearer error="invalid_token"',
          },
        },
      );
    throw error;
  }
}

// POST /revoke (RFC 7009): always 200; a known refresh token ends its family.
export async function revoke(request: Request, env: Env) {
  const settings = await readSettings(env);
  const form = await readForm(request);
  const hash = await hashToken(form.get('token') ?? '');
  const stored = await env.DB.prepare(
    'SELECT family FROM refresh_tokens WHERE token_hash=?',
  )
    .bind(hash)
    .first<{ family: string }>();
  if (stored)
    await env.DB.prepare('UPDATE refresh_tokens SET revoked=1 WHERE family=?')
      .bind(stored.family)
      .run();
  return new Response(null, {
    status: 200,
    headers: corsHeaders(request, settings),
  });
}

type LogoutParams = { target: string | null; state: string | null };
export type LogoutResult =
  { done: Response } | { signedOut: string } | { confirm: LogoutParams };

async function signOut(
  request: Request,
  env: Env,
  settings: Settings,
  params: LogoutParams,
): Promise<LogoutResult> {
  const clear = await endSession(env, request);
  if (
    params.target &&
    settings.logoutUris.includes(params.target) &&
    allowedRedirect(params.target)
  ) {
    const url = new URL(params.target);
    if (params.state && params.state.length <= 512)
      url.searchParams.set('state', params.state);
    return {
      done: new Response(null, {
        status: 302,
        headers: { Location: url.toString(), 'Set-Cookie': clear },
      }),
    };
  }
  return { signedOut: clear };
}

// GET /logout (RP-initiated logout). It signs out at once only when the app sends an ID
// token it was issued for the signed-in user (id_token_hint); otherwise the person confirms,
// so another site can't sign them out with a link. Returns only to registered addresses.
export async function logout(
  request: Request,
  env: Env,
): Promise<LogoutResult> {
  const settings = await readSettings(env);
  const params = new URL(request.url).searchParams;
  const logoutParams = {
    target: params.get('post_logout_redirect_uri'),
    state: params.get('state'),
  };
  const session = await currentSession(env, request);
  if (!session) return signOut(request, env, settings, logoutParams);
  const hint = params.get('id_token_hint');
  if (hint) {
    try {
      const claims = await verifyEs256(hint, parseSigningKey(env.SIGNING_KEY), {
        allowExpired: true,
      });
      if (
        claims.iss === issuerOf(request) &&
        claims.aud === settings.clientId &&
        claims.sub === session.user_id
      )
        return signOut(request, env, settings, logoutParams);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return { confirm: logoutParams };
}

// POST /logout from the confirmation page (same origin only).
export async function confirmLogout(
  request: Request,
  env: Env,
): Promise<LogoutResult> {
  if (request.headers.get('Origin') !== issuerOf(request))
    throw new HttpError(403, 'Cross-site request refused.');
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded'))
    throw new HttpError(400, 'Invalid request.');
  const body = await request.text();
  if (body.length > 8192) throw new HttpError(413, 'Request is too large.');
  const form = new URLSearchParams(body);
  return signOut(request, env, await readSettings(env), {
    target: form.get('post_logout_redirect_uri') || null,
    state: form.get('state') || null,
  });
}
