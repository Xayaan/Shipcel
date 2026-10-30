// "Continue with GitHub" and "Continue with Google". The app owner registers OAuth apps
// with these providers; client IDs live in settings and client secrets in Worker secrets.
import { complete, issuerOf } from './oidc';
import {
  createUser,
  getAuthRequest,
  readSettings,
  requireSignin,
  startSession,
  type Env,
} from './store';
import {
  hashToken,
  HttpError,
  now,
  randomToken,
  sha256,
  toBase64Url,
} from './util';

type Profile = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

const providers = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
  },
} as const;
export type Provider = keyof typeof providers;
// Own keys only: names such as toString or __proto__ are not providers.
export const isProvider = (value: string): value is Provider =>
  Object.hasOwn(providers, value);

function configured(env: Env, provider: Provider, clientId: string | null) {
  const secret =
    provider === 'github' ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !secret)
    throw new HttpError(
      404,
      `Sign-in with ${provider} is not set up for this app.`,
    );
  return { clientId, secret };
}

export async function start(request: Request, env: Env, provider: Provider) {
  const settings = await readSettings(env);
  requireSignin(settings);
  const { clientId } = configured(
    env,
    provider,
    provider === 'github' ? settings.githubClientId : settings.googleClientId,
  );
  const authRequest = await getAuthRequest(
    env,
    new URL(request.url).searchParams.get('request'),
    request,
  );
  const state = randomToken();
  const verifier = randomToken(48);
  await env.DB.prepare(
    'INSERT INTO oauth_states (state_hash,provider,request_id,verifier,expires_at) VALUES (?,?,?,?,?)',
  )
    .bind(
      await hashToken(state),
      provider,
      authRequest.id,
      verifier,
      now() + 600,
    )
    .run();
  const target = new URL(providers[provider].authorize);
  target.searchParams.set('client_id', clientId);
  target.searchParams.set(
    'redirect_uri',
    `${issuerOf(request)}/oauth/${provider}/callback`,
  );
  target.searchParams.set('scope', providers[provider].scope);
  target.searchParams.set('state', state);
  if (provider === 'google') {
    target.searchParams.set('response_type', 'code');
    target.searchParams.set(
      'code_challenge',
      toBase64Url(await sha256(verifier)),
    );
    target.searchParams.set('code_challenge_method', 'S256');
  }
  return Response.redirect(target.toString(), 302);
}

async function providerJson<T>(url: string, init: RequestInit) {
  let response: Response;
  try {
    // Workers support only "follow" and "manual"; a redirect counts as a failure below.
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new HttpError(
      502,
      'The sign-in provider did not respond. Try again.',
    );
  }
  if (!response.ok)
    throw new HttpError(
      502,
      'The sign-in provider refused the request. Try again.',
    );
  return (await response.json()) as T;
}

async function githubProfile(
  code: string,
  redirectUri: string,
  clientId: string,
  secret: string,
): Promise<Profile> {
  const tokens = await providerJson<{ access_token?: string }>(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: secret,
        code,
        redirect_uri: redirectUri,
      }),
    },
  );
  if (!tokens.access_token)
    throw new HttpError(400, 'GitHub did not complete the sign-in.');
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Shipcel-Sign-in',
  };
  const user = await providerJson<{
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
  }>('https://api.github.com/user', { headers });
  const emails = await providerJson<
    { email: string; primary: boolean; verified: boolean }[]
  >('https://api.github.com/user/emails', { headers });
  const primary = Array.isArray(emails)
    ? emails.find((e) => e.primary && e.verified)
    : undefined;
  if (typeof user.id !== 'number')
    throw new HttpError(502, 'GitHub returned an unexpected profile.');
  return {
    subject: String(user.id),
    email: primary?.email ?? null,
    emailVerified: Boolean(primary),
    name: user.name || user.login || null,
    picture: user.avatar_url ?? null,
  };
}

async function googleProfile(
  code: string,
  redirectUri: string,
  clientId: string,
  secret: string,
  verifier: string,
): Promise<Profile> {
  const tokens = await providerJson<{ access_token?: string }>(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    },
  );
  if (!tokens.access_token)
    throw new HttpError(400, 'Google did not complete the sign-in.');
  const user = await providerJson<{
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  }>('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (typeof user.sub !== 'string')
    throw new HttpError(502, 'Google returned an unexpected profile.');
  return {
    subject: user.sub,
    email: user.email ?? null,
    emailVerified: user.email_verified === true,
    name: user.name ?? null,
    picture: user.picture ?? null,
  };
}

// Finds the user for a provider account. A new provider account joins an existing user
// only when both emails are verified, so an unverified email can never take over an account.
async function userFor(env: Env, provider: Provider, profile: Profile) {
  const linked = await env.DB.prepare(
    'SELECT u.id, u.disabled FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.subject=?',
  )
    .bind(provider, profile.subject)
    .first<{ id: string; disabled: number }>();
  if (linked) return linked;
  const sameEmail =
    profile.emailVerified && profile.email
      ? await env.DB.prepare(
          'SELECT id, disabled FROM users WHERE email=? AND email_verified=1 ORDER BY created_at LIMIT 1',
        )
          .bind(profile.email)
          .first<{ id: string; disabled: number }>()
      : null;
  const user = sameEmail ?? {
    id: await createUser(env, {
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
      picture: profile.picture,
    }),
    disabled: 0,
  };
  await env.DB.prepare(
    'INSERT INTO identities (provider,subject,user_id,email,created_at) VALUES (?,?,?,?,?)',
  )
    .bind(provider, profile.subject, user.id, profile.email, now())
    .run();
  return user;
}

export async function callback(request: Request, env: Env, provider: Provider) {
  const params = new URL(request.url).searchParams;
  const state = await env.DB.prepare(
    'DELETE FROM oauth_states WHERE state_hash=? AND provider=? AND expires_at>? RETURNING request_id, verifier',
  )
    .bind(await hashToken(params.get('state') ?? ''), provider, now())
    .first<{ request_id: string; verifier: string }>();
  if (!state)
    throw new HttpError(
      400,
      'This sign-in attempt expired. Go back to the app and try again.',
    );
  // The callback must come back to the browser that started this sign-in; otherwise someone
  // could finish their own GitHub or Google sign-in in another person's browser.
  const authRequest = await getAuthRequest(env, state.request_id, request);
  if (params.get('error'))
    return Response.redirect(
      `${issuerOf(request)}/sign-in?request=${authRequest.id}&cancelled=1`,
      302,
    );
  const settings = await readSettings(env);
  requireSignin(settings);
  const { clientId, secret } = configured(
    env,
    provider,
    provider === 'github' ? settings.githubClientId : settings.googleClientId,
  );
  const code = params.get('code') ?? '';
  if (!code || code.length > 2048)
    throw new HttpError(400, 'The provider did not return a code.');
  const redirectUri = `${issuerOf(request)}/oauth/${provider}/callback`;
  const profile =
    provider === 'github'
      ? await githubProfile(code, redirectUri, clientId, secret)
      : await googleProfile(
          code,
          redirectUri,
          clientId,
          secret,
          state.verifier,
        );
  const user = await userFor(env, provider, profile);
  if (user.disabled) throw new HttpError(403, 'This account is disabled.');
  const sessionCookie = await startSession(env, user.id);
  return new Response(null, {
    status: 302,
    headers: {
      Location: await complete(env, authRequest.id, user.id),
      'Set-Cookie': sessionCookie,
    },
  });
}
