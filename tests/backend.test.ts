// Runs the bundled sign-in and realtime service in workerd (Miniflare) with a real D1
// database, a SQLite Durable Object and WebSockets. GitHub and Google are fixtures.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { backendSchema, backendScript } from '../worker/generated/backend';
import {
  Authenticator,
  b64url,
  hs256,
  sha256,
  signingKey,
  verifyJwt,
} from './helpers/authenticator';

const origin = 'https://shop-backend.test-account.workers.dev';
const rpId = 'shop-backend.test-account.workers.dev';
const appOrigin = 'https://shop.test-account.workers.dev';
const redirectUri = `${appOrigin}/auth/callback`;
const clientId = 'cc_client_test_0123456789';
const realtimeSecret = 'realtime-secret-for-tests-0123456789abcdef';

let mf: Miniflare;
let key: Awaited<ReturnType<typeof signingKey>>;
let upstream: (request: Request) => Promise<Response> | Response;
let upstreamCalls: string[];
// What the service sent through its EMAIL binding, as the fake mail worker received it.
let sent: Record<string, unknown>[] = [];

type Fetch = {
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  webSocket?: unknown;
};
const call = (path: string, init: RequestInit = {}) =>
  mf.dispatchFetch(`${origin}${path}`, {
    redirect: 'manual',
    ...init,
  } as never) as unknown as Promise<Fetch>;
const location = (r: Fetch) => new URL(r.headers.get('Location')!);

// One browser: keeps the cookies the service sets and sends them back, like a real one.
class Browser {
  cookies = new Map<string, string>();
  async call(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers as HeadersInit);
    if (this.cookies.size)
      headers.set(
        'Cookie',
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      );
    const response = await call(path, { ...init, headers });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const [name, ...value] = pair.split('=');
      if (attributes.some((a) => a.trim().toLowerCase() === 'max-age=0'))
        this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value.join('='));
    }
    return response;
  }
}

async function settings(values: Record<string, string>) {
  const db = await mf.getD1Database('DB');
  await db.batch(
    Object.entries(values).map(([k, v]) =>
      db
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .bind(k, v),
    ),
  );
}

beforeAll(async () => {
  key = await signingKey();
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'backend',
          modules: [
            { type: 'ESModule', path: 'index.js', contents: backendScript },
          ],
          compatibilityDate: '2026-10-07',
          // DATA is the app's own database, which the data API reads and changes.
          d1Databases: { DB: 'backend-db', DATA: 'app-db' },
          durableObjects: {
            CHANNELS: { className: 'Channel', useSQLite: true },
          },
          bindings: {
            SIGNING_KEY: JSON.stringify(key),
            REALTIME_SECRET: realtimeSecret,
            GITHUB_CLIENT_SECRET: 'github-secret',
            GOOGLE_CLIENT_SECRET: 'google-secret',
            // Channels re-check signed-in members every second in tests (5 minutes live).
            REALTIME_RECHECK_SECONDS: '1',
          },
          outboundService: (request: Request) => upstream(request),
          // Cloudflare's Email Service binding (`send_email`), stood in for by the worker below:
          // the service calls env.EMAIL.send() either way.
          serviceBindings: { EMAIL: { name: 'mail', entrypoint: 'Mail' } },
        },
        {
          name: 'mail',
          compatibilityDate: '2026-10-07',
          modules: [
            {
              type: 'ESModule',
              path: 'mail.js',
              contents: `import { WorkerEntrypoint } from 'cloudflare:workers';
export class Mail extends WorkerEntrypoint {
  async send(message) {
    await fetch('https://mail.test/sent', { method: 'POST', body: JSON.stringify(message) });
    return { messageId: 'msg-' + crypto.randomUUID() };
  }
}
export default { fetch: () => new Response('mail', { status: 404 }) };`,
            },
          ],
          outboundService: async (request: Request) => {
            sent.push((await request.json()) as Record<string, unknown>);
            return Response.json({ ok: true });
          },
        },
      ],
    } as never),
  );
  const db = await mf.getD1Database('DB');
  await db.batch(
    backendSchema
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
}, 60000);
afterAll(() => mf?.dispose());

beforeEach(async () => {
  upstreamCalls = [];
  sent = [];
  upstream = (request) => {
    upstreamCalls.push(request.url);
    return new Response('unexpected', { status: 500 });
  };
  await settings({
    client_id: clientId,
    app_name: 'Test Shop',
    redirect_uris: JSON.stringify([redirectUri]),
    logout_uris: JSON.stringify([`${appOrigin}/`]),
    github_client_id: 'github-client',
    google_client_id: 'google-client',
    signin: 'on',
    realtime: 'on',
    // Email sign-in is off until a test sets a sender address.
    email_from: '',
    password: 'off',
  });
});

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  return { verifier, challenge: b64url(await sha256(verifier)) };
}

async function startAuthorize(
  browser = new Browser(),
  extra: Record<string, string> = {},
) {
  const { verifier, challenge } = await pkce();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: 'state-123',
    nonce: 'nonce-456',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  });
  const response = await browser.call(`/authorize?${params}`);
  return { response, verifier, browser };
}

const requestIdOf = (response: Fetch) =>
  location(response).searchParams.get('request')!;
const json = (body: unknown) => ({
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function signUp(name = 'Ada Lovelace', email?: string) {
  const { response, verifier, browser } = await startAuthorize();
  const request = requestIdOf(response);
  const options = (await (
    await browser.call(
      '/passkeys/register/options',
      json({ request, name, email }),
    )
  ).json()) as {
    challengeId: string;
    publicKey: { challenge: string; user: { id: string }; rp: { id: string } };
  };
  const authenticator = new Authenticator(rpId, origin);
  const credential = await authenticator.create(options.publicKey);
  const verified = await browser.call(
    '/passkeys/register/verify',
    json({ request, challengeId: options.challengeId, credential }),
  );
  return { verified, verifier, authenticator, options, browser };
}

async function exchange(
  code: string,
  verifier: string,
  overrides: Record<string, string> = {},
) {
  return call('/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: appOrigin,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      ...overrides,
    }).toString(),
  });
}

type Tokens = {
  access_token: string;
  id_token: string;
  refresh_token: string;
  token_type: string;
};

// Signs up with a passkey and exchanges the code, like an app would.
async function signedIn(name: string) {
  const flow = await signUp(name);
  const code = new URL(
    ((await flow.verified.json()) as { redirect: string }).redirect,
  ).searchParams.get('code')!;
  const tokens = (await (await exchange(code, flow.verifier)).json()) as Tokens;
  const sub = JSON.parse(
    Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString(),
  ).sub as string;
  return { ...flow, tokens, sub };
}
const refresh = (token: string) =>
  call('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: clientId,
    }).toString(),
  });

describe('sign-in service (OpenID Connect)', () => {
  it('publishes discovery metadata and a public signing key', async () => {
    const discovery = (await (
      await call('/.well-known/openid-configuration')
    ).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/.well-known/jwks.json`,
      code_challenge_methods_supported: ['S256'],
    });
    const jwks = (await (await call('/.well-known/jwks.json')).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      kid: 'test-key-1',
      alg: 'ES256',
    });
    expect(jwks.keys[0].d).toBeUndefined();
  });

  it('signs up with a passkey and returns a code the app exchanges for verified tokens', async () => {
    const { verified, verifier } = await signUp(
      'Ada Lovelace',
      'ada@example.com',
    );
    expect(verified.status).toBe(200);
    expect(verified.headers.get('Set-Cookie')).toMatch(
      /^__Host-cc_session=.+HttpOnly; Secure; SameSite=Lax/,
    );
    const redirect = new URL(
      ((await verified.json()) as { redirect: string }).redirect,
    );
    expect(redirect.origin + redirect.pathname).toBe(redirectUri);
    expect(redirect.searchParams.get('state')).toBe('state-123');
    const tokenResponse = await exchange(
      redirect.searchParams.get('code')!,
      verifier,
    );
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get('Access-Control-Allow-Origin')).toBe(
      appOrigin,
    );
    const tokens = (await tokenResponse.json()) as Tokens;
    expect(tokens.token_type).toBe('Bearer');
    const publicKey = { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
    const id = await verifyJwt(tokens.id_token, publicKey);
    expect(id.valid).toBe(true);
    expect(id.claims).toMatchObject({
      iss: origin,
      aud: clientId,
      nonce: 'nonce-456',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      email_verified: false,
    });
    const access = await verifyJwt(tokens.access_token, publicKey);
    expect(access.valid).toBe(true);
    const info = await call('/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(await info.json()).toMatchObject({
      sub: id.claims.sub,
      email: 'ada@example.com',
    });
  });

  it('signs in again with the passkey, and skips the page while the session lasts', async () => {
    const { verified, authenticator } = await signUp('Grace Hopper');
    const sub = new URL(
      ((await verified.json()) as { redirect: string }).redirect,
    );
    expect(sub.searchParams.get('code')).toBeTruthy();
    const { response, verifier, browser } = await startAuthorize();
    const request = requestIdOf(response);
    const options = (await (
      await browser.call('/passkeys/login/options', json({ request }))
    ).json()) as {
      challengeId: string;
      publicKey: {
        challenge: string;
        rpId: string;
        allowCredentials: unknown[];
      };
    };
    expect(options.publicKey.rpId).toBe(rpId);
    expect(options.publicKey.allowCredentials).toEqual([]);
    const credential = await authenticator.get(options.publicKey);
    const signedIn = await browser.call(
      '/passkeys/login/verify',
      json({ request, challengeId: options.challengeId, credential }),
    );
    expect(signedIn.status).toBe(200);
    const redirect = new URL(
      ((await signedIn.json()) as { redirect: string }).redirect,
    );
    expect(
      (await exchange(redirect.searchParams.get('code')!, verifier)).status,
    ).toBe(200);
    // The same browser now has a session, so the page is skipped.
    const again = await startAuthorize(browser);
    expect(again.response.status).toBe(302);
    expect(
      location(again.response).origin + location(again.response).pathname,
    ).toBe(redirectUri);
    expect(location(again.response).searchParams.get('code')).toBeTruthy();
    const forced = await startAuthorize(browser, { prompt: 'login' });
    expect(location(forced.response).pathname).toBe('/sign-in');
  });

  it('refuses unregistered apps and return addresses with an error page instead of redirecting', async () => {
    const { challenge } = await pkce();
    const base = {
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const evil = await call(
      `/authorize?${new URLSearchParams({ ...base, client_id: clientId, redirect_uri: 'https://evil.example/cb' })}`,
    );
    expect(evil.status).toBe(400);
    expect(evil.headers.get('Location')).toBeNull();
    expect(await evil.text()).toContain('return address is not registered');
    const unknown = await call(
      `/authorize?${new URLSearchParams({ ...base, client_id: 'other', redirect_uri: redirectUri })}`,
    );
    expect(unknown.status).toBe(400);
  });

  it('requires PKCE with S256 and the openid scope', async () => {
    const noPkce = await call(
      `/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid', state: 's' })}`,
    );
    expect(noPkce.status).toBe(302);
    expect(location(noPkce).searchParams.get('error')).toBe('invalid_request');
    expect(location(noPkce).searchParams.get('state')).toBe('s');
    const plain = await startAuthorize(undefined, {
      code_challenge_method: 'plain',
    });
    expect(location(plain.response).searchParams.get('error')).toBe(
      'invalid_request',
    );
    const noOpenid = await startAuthorize(undefined, { scope: 'email' });
    expect(location(noOpenid.response).searchParams.get('error')).toBe(
      'invalid_scope',
    );
  });

  it('accepts each code once, only with the right verifier and return address', async () => {
    const { verified, verifier } = await signUp('Code Tester');
    const code = new URL(
      ((await verified.json()) as { redirect: string }).redirect,
    ).searchParams.get('code')!;
    const wrongVerifier = await exchange(
      code,
      b64url(crypto.getRandomValues(new Uint8Array(48))),
    );
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({
      error: 'invalid_grant',
    });
    // The failed attempt used the code up.
    expect((await exchange(code, verifier)).status).toBe(400);
    const second = await signUp('Code Tester Two');
    const code2 = new URL(
      ((await second.verified.json()) as { redirect: string }).redirect,
    ).searchParams.get('code')!;
    expect(
      (
        await exchange(code2, second.verifier, {
          redirect_uri: `${appOrigin}/other`,
        })
      ).status,
    ).toBe(400);
  });

  it('rotates refresh tokens and ends the whole family when one is reused', async () => {
    const { verified, verifier } = await signUp('Refresh Tester');
    const code = new URL(
      ((await verified.json()) as { redirect: string }).redirect,
    ).searchParams.get('code')!;
    const first = (await (await exchange(code, verifier)).json()) as Tokens;
    const refresh = (token: string) =>
      call('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token,
          client_id: clientId,
        }).toString(),
      });
    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    const rotated = (await second.json()) as Tokens;
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    const reused = await refresh(first.refresh_token);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
  });

  it('refuses cross-site passkey requests, other origins and cloned passkeys', async () => {
    const { response, browser } = await startAuthorize();
    const request = requestIdOf(response);
    const crossSite = await browser.call('/passkeys/login/options', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ request }),
    });
    expect(crossSite.status).toBe(403);
    const { authenticator } = await signUp('Clone Tester');
    const login = async (overrides: {
      signCount?: number;
      origin?: string;
    }) => {
      const flow = await startAuthorize();
      const id = requestIdOf(flow.response);
      const options = (await (
        await flow.browser.call(
          '/passkeys/login/options',
          json({ request: id }),
        )
      ).json()) as {
        challengeId: string;
        publicKey: { challenge: string };
      };
      const credential = await authenticator.get(options.publicKey, overrides);
      return flow.browser.call(
        '/passkeys/login/verify',
        json({ request: id, challengeId: options.challengeId, credential }),
      );
    };
    expect((await login({ origin: 'https://evil.example' })).status).toBe(400);
    expect((await login({ signCount: 5 })).status).toBe(200);
    const cloned = await login({ signCount: 5 });
    expect(cloned.status).toBe(400);
    expect(await cloned.text()).toContain('copied');
  });

  it('refuses forged signatures and passkeys that skip user verification', async () => {
    const { authenticator } = await signUp('Forgery Tester');
    const attempt = async (overrides: { forge?: boolean; flags?: number }) => {
      const flow = await startAuthorize();
      const id = requestIdOf(flow.response);
      const options = (await (
        await flow.browser.call(
          '/passkeys/login/options',
          json({ request: id }),
        )
      ).json()) as {
        challengeId: string;
        publicKey: { challenge: string };
      };
      const credential = await authenticator.get(options.publicKey, overrides);
      return flow.browser.call(
        '/passkeys/login/verify',
        json({ request: id, challengeId: options.challengeId, credential }),
      );
    };
    const forged = await attempt({ forge: true });
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain('signature is not valid');
    const presenceOnly = await attempt({ flags: 0x01 });
    expect(presenceOnly.status).toBe(400);
    expect(await presenceOnly.text()).toContain('did not verify the user');
    expect((await attempt({})).status).toBe(200);
  });

  it('blocks disabled users from signing in and refreshing', async () => {
    const { verified, verifier, authenticator } =
      await signUp('Disabled Tester');
    const code = new URL(
      ((await verified.json()) as { redirect: string }).redirect,
    ).searchParams.get('code')!;
    const tokens = (await (await exchange(code, verifier)).json()) as Tokens;
    const db = await mf.getD1Database('DB');
    await db
      .prepare("UPDATE users SET disabled=1 WHERE name='Disabled Tester'")
      .run();
    const refreshed = await call('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshed.status).toBe(400);
    const flow = await startAuthorize();
    const id = requestIdOf(flow.response);
    const options = (await (
      await flow.browser.call('/passkeys/login/options', json({ request: id }))
    ).json()) as {
      challengeId: string;
      publicKey: { challenge: string };
    };
    const credential = await authenticator.get(options.publicKey);
    expect(
      (
        await flow.browser.call(
          '/passkeys/login/verify',
          json({ request: id, challengeId: options.challengeId, credential }),
        )
      ).status,
    ).toBe(403);
  });

  it('signs in with GitHub and links Google by verified email, but never by an unverified one', async () => {
    // A passkey account that typed someone's email without verifying it.
    await signUp('Squatter', 'linus@example.com');
    upstream = async (request) => {
      upstreamCalls.push(`${request.method} ${request.url}`);
      const url = new URL(request.url);
      if (url.href === 'https://github.com/login/oauth/access_token') {
        expect(await request.json()).toMatchObject({
          client_id: 'github-client',
          client_secret: 'github-secret',
          code: 'gh-code',
        });
        return Response.json({ access_token: 'gh-token' });
      }
      if (url.href === 'https://api.github.com/user')
        return Response.json({
          id: 42,
          login: 'linus',
          name: 'Linus',
          avatar_url: null,
        });
      if (url.href === 'https://api.github.com/user/emails')
        return Response.json([
          { email: 'linus@example.com', primary: true, verified: true },
        ]);
      if (url.href === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(await request.text());
        expect(form.get('code_verifier')).toBeTruthy();
        return Response.json({ access_token: 'google-token' });
      }
      if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo')
        return Response.json({
          sub: 'g-1',
          email: 'linus@example.com',
          email_verified: true,
          name: 'Linus T.',
        });
      return new Response('unexpected', { status: 500 });
    };
    const signInWith = async (provider: 'github' | 'google', code: string) => {
      const flow = await startAuthorize();
      const started = await flow.browser.call(
        `/oauth/${provider}/start?request=${requestIdOf(flow.response)}`,
      );
      expect(started.status).toBe(302);
      const providerUrl = location(started);
      expect(providerUrl.searchParams.get('redirect_uri')).toBe(
        `${origin}/oauth/${provider}/callback`,
      );
      const back = await flow.browser.call(
        `/oauth/${provider}/callback?code=${code}&state=${providerUrl.searchParams.get('state')}`,
      );
      expect(back.status).toBe(302);
      const tokens = (await (
        await exchange(location(back).searchParams.get('code')!, flow.verifier)
      ).json()) as Tokens;
      return (
        await verifyJwt(tokens.id_token, {
          kty: key.kty,
          crv: key.crv,
          x: key.x,
          y: key.y,
        })
      ).claims;
    };
    const github = await signInWith('github', 'gh-code');
    expect(github).toMatchObject({
      email: 'linus@example.com',
      email_verified: true,
      name: 'Linus',
    });
    const google = await signInWith('google', 'google-code');
    expect(google.sub).toBe(github.sub);
    const db = await mf.getD1Database('DB');
    const squatter = await db
      .prepare("SELECT id FROM users WHERE name='Squatter'")
      .first<{ id: string }>();
    expect(squatter!.id).not.toBe(github.sub);
    // A replayed state is refused.
    expect(
      (await call('/oauth/github/callback?code=x&state=forged')).status,
    ).toBe(400);
  });

  it('refuses to finish a sign-in in a browser other than the one that started it (login CSRF)', async () => {
    // Mallory starts a GitHub sign-in in her own browser and stops before the callback.
    const mallory = await startAuthorize();
    const request = requestIdOf(mallory.response);
    const started = await mallory.browser.call(
      `/oauth/github/start?request=${request}`,
    );
    const state = location(started).searchParams.get('state');
    // Her victim's browser is sent to the callback with Mallory's code and state.
    const victim = new Browser();
    const planted = await victim.call(
      `/oauth/github/callback?code=gh-code&state=${state}`,
    );
    expect(planted.status).toBe(400);
    expect(await planted.text()).toContain('another browser');
    expect(victim.cookies.has('__Host-cc_session')).toBe(false);
    // The code was never exchanged with GitHub.
    expect(upstreamCalls).toEqual([]);
    // The page and passkey calls for someone else's sign-in request are refused too.
    expect((await victim.call(`/sign-in?request=${request}`)).status).toBe(400);
    expect(
      (await victim.call('/passkeys/login/options', json({ request }))).status,
    ).toBe(400);
    // In the browser that started it, the page works.
    expect(
      (await mallory.browser.call(`/sign-in?request=${request}`)).status,
    ).toBe(200);
  });

  it('ends the whole token family when one refresh token is used twice at once', async () => {
    const { tokens } = await signedIn('Race Tester');
    const [a, b] = await Promise.all([
      refresh(tokens.refresh_token),
      refresh(tokens.refresh_token),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const winner = (await (a.status === 200 ? a : b).json()) as Tokens;
    // The successor was issued, but the family ended when the reuse was seen.
    expect((await refresh(winner.refresh_token)).status).toBe(400);
  });

  it('refuses a refresh token once any token of its family is revoked', async () => {
    const { tokens } = await signedIn('Family Tester');
    const next = (await (await refresh(tokens.refresh_token)).json()) as Tokens;
    const db = await mf.getD1Database('DB');
    const hash = b64url(await sha256(next.refresh_token));
    // A revocation that landed while another rotation was in flight.
    await db
      .prepare(
        'UPDATE refresh_tokens SET revoked=1 WHERE family=(SELECT family FROM refresh_tokens WHERE token_hash=?) AND token_hash<>?',
      )
      .bind(hash, hash)
      .run();
    const refused = await refresh(next.refresh_token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('indexes every expiry column so cleanup never scans whole tables', async () => {
    const db = await mf.getD1Database('DB');
    const { results } = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%_expires' ORDER BY name",
      )
      .all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      'auth_request_browsers_expires',
      'auth_requests_expires',
      'challenges_expires',
      'codes_expires',
      'email_links_expires',
      'oauth_states_expires',
      'refresh_tokens_expires',
      'sessions_expires',
    ]);
  });

  it('stops every sign-in step and token refresh while sign-in is off', async () => {
    const { tokens } = await signedIn('Switch Tester');
    // A sign-in that was already in progress when the owner turned it off.
    const pending = await startAuthorize();
    const request = requestIdOf(pending.response);
    await settings({ signin: 'off' });
    expect(
      (await pending.browser.call(`/sign-in?request=${request}`)).status,
    ).toBe(404);
    for (const path of [
      '/passkeys/login/options',
      '/passkeys/register/options',
    ])
      expect(
        (
          await pending.browser.call(
            path,
            json({ request, name: 'Late Sign-up' }),
          )
        ).status,
      ).toBe(404);
    expect(
      (await pending.browser.call(`/oauth/github/start?request=${request}`))
        .status,
    ).toBe(404);
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({
      error: 'unauthorized_client',
    });
    // An access token issued earlier works until it expires (at most an hour).
    expect(
      (
        await call('/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
      ).status,
    ).toBe(200);
  });

  it('accepts only access tokens as bearer tokens, not ID tokens', async () => {
    const { tokens } = await signedIn('Token Type Tester');
    const header = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[0], 'base64url').toString(),
    );
    expect(header.typ).toBe('at+jwt');
    const withId = await call('/userinfo', {
      headers: { Authorization: `Bearer ${tokens.id_token}` },
    });
    expect(withId.status).toBe(401);
  });

  it('answers malformed input with a client error, never a server error', async () => {
    const part = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of [
      `${part(null)}.${part({})}.c2ln`,
      `${part([])}.${part({})}.c2ln`,
      `${part({ alg: 'ES256' })}.${part(null)}.c2ln`,
    ]) {
      const response = await call('/userinfo', {
        headers: { Authorization: `Bearer ${bad}` },
      });
      expect(response.status).toBe(401);
    }
    for (const name of ['toString', '__proto__', 'constructor'])
      expect((await call(`/oauth/${name}/start?request=x`)).status).toBe(404);
    expect(
      (
        await call('/realtime/channels/%E0%A4%A', {
          headers: { Upgrade: 'websocket' },
        })
      ).status,
    ).toBe(404);
  });

  it('asks before signing out unless the app sends an ID token for the signed-in user', async () => {
    const back = `${appOrigin}/`;
    const first = await signedIn('Logout Tester');
    // A link from another site only shows a confirmation page.
    const link = await first.browser.call(
      `/logout?post_logout_redirect_uri=${encodeURIComponent(back)}`,
    );
    expect(link.status).toBe(200);
    const html = await link.text();
    expect(html).toContain('Sign out?');
    expect(html).toContain('<form method="post" action="/logout">');
    expect(first.browser.cookies.has('__Host-cc_session')).toBe(true);
    const form = (originHeader: string) =>
      first.browser.call('/logout', {
        method: 'POST',
        headers: {
          Origin: originHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          post_logout_redirect_uri: back,
        }).toString(),
      });
    expect((await form('https://evil.example')).status).toBe(403);
    expect(first.browser.cookies.has('__Host-cc_session')).toBe(true);
    const confirmed = await form(origin);
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get('Location')).toBe(back);
    expect(first.browser.cookies.has('__Host-cc_session')).toBe(false);
    // With an ID token issued to the signed-in user, sign-out is immediate.
    const second = await signedIn('Logout Tester Two');
    const other = await signedIn('Logout Tester Three');
    const withOthers = await second.browser.call(
      `/logout?id_token_hint=${other.tokens.id_token}`,
    );
    expect(withOthers.status).toBe(200);
    expect(second.browser.cookies.has('__Host-cc_session')).toBe(true);
    const immediate = await second.browser.call(
      `/logout?id_token_hint=${second.tokens.id_token}&post_logout_redirect_uri=${encodeURIComponent(back)}`,
    );
    expect(immediate.status).toBe(302);
    expect(immediate.headers.get('Location')).toBe(back);
    expect(second.browser.cookies.has('__Host-cc_session')).toBe(false);
  });

  it('serves the sign-in page with a strict content security policy and turns off when asked', async () => {
    const { response, browser } = await startAuthorize();
    const page = await browser.call(
      `/sign-in?request=${requestIdOf(response)}`,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain(
      "script-src 'self'",
    );
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    const html = await page.text();
    expect(html).toContain('Sign in to Test Shop');
    expect(html).toContain('Continue with GitHub');
    expect(html).not.toMatch(/<script>[^<]/);
    await settings({ signin: 'off' });
    expect((await startAuthorize()).response.status).toBe(404);
  });

  // Sign-ins count against the free plan's daily requests, so returning visitors load the
  // page's script and styles from their browser cache.
  it('serves the page script and styles from fingerprinted addresses browsers keep', async () => {
    const { response, browser } = await startAuthorize();
    const html = await (
      await browser.call(`/sign-in?request=${requestIdOf(response)}`)
    ).text();
    const script = html.match(
      /<script src="(\/assets\/sign-in\.[a-z0-9]+\.js)">/,
    )?.[1];
    const style = html.match(
      /<link rel="stylesheet" href="(\/assets\/sign-in\.[a-z0-9]+\.css)">/,
    )?.[1];
    expect(script).toBeTruthy();
    expect(style).toBeTruthy();
    for (const [path, type] of [
      [script!, 'text/javascript'],
      [style!, 'text/css'],
    ]) {
      const asset = await call(path);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('Content-Type')).toContain(type);
      expect(asset.headers.get('Cache-Control')).toBe(
        'public, max-age=31536000, immutable',
      );
    }
    expect((await call('/assets/sign-in.js')).status).toBe(404);
  });
});

// Sign-in by email (services/backend/src/email.ts): a link sent through Cloudflare's Email
// Service from the app's own address, and an optional password set once signed in.
describe('sign-in by email', () => {
  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
  const linkIn = (message: Record<string, unknown>) =>
    String(message.text)
      .match(/https:\/\/\S+\/email\/finish\?\S+/)![0]
      .replace(origin, '');
  const claimsOf = (tokens: Tokens) =>
    JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString(),
    ) as Record<string, unknown>;

  it('signs in with an emailed link: once, in the browser that asked, with the email verified', async () => {
    await settings({ email_from: 'sign-in@shop.example' });
    const { response, verifier, browser } = await startAuthorize();
    const request = requestIdOf(response);
    const asked = await browser.call(
      '/email/start',
      form({ request, email: 'Ada@Example.com' }),
    );
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('Check your email');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: 'sign-in@shop.example', name: 'Test Shop' },
      to: 'ada@example.com',
    });
    expect(String(sent[0].subject)).toContain('Test Shop');
    const link = linkIn(sent[0]);
    // Another browser can't finish a sign-in this one started.
    expect((await new Browser().call(link)).status).toBe(400);
    const finished = await browser.call(link);
    expect(finished.status).toBe(302);
    const code = location(finished).searchParams.get('code')!;
    const tokens = (await (await exchange(code, verifier)).json()) as Tokens;
    expect(claimsOf(tokens)).toMatchObject({
      email: 'ada@example.com',
      email_verified: true,
    });
    // The link works once.
    expect((await browser.call(link)).status).toBe(400);
    // The same address reaches the same account next time.
    const again = await startAuthorize();
    await again.browser.call(
      '/email/start',
      form({ request: requestIdOf(again.response), email: 'ada@example.com' }),
    );
    const second = await again.browser.call(linkIn(sent[1]));
    const secondTokens = (await (
      await exchange(location(second).searchParams.get('code')!, again.verifier)
    ).json()) as Tokens;
    expect(claimsOf(secondTokens).sub).toBe(claimsOf(tokens).sub);
  });

  it('sets a password once signed in and signs in with it; a wrong or unknown one gets the same answer', async () => {
    await settings({ email_from: 'sign-in@shop.example', password: 'on' });
    const first = await startAuthorize();
    await first.browser.call(
      '/email/start',
      form({ request: requestIdOf(first.response), email: 'ada@example.com' }),
    );
    expect((await first.browser.call(linkIn(sent[0]))).status).toBe(302);
    // The session the link started lets this browser set a password.
    expect(
      (
        await first.browser.call(
          '/password/set',
          json({ password: 'correct horse battery' }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await first.browser.call('/password/set', json({ password: 'short' })))
        .status,
    ).toBe(400);
    expect(
      (await call('/password/set', json({ password: 'no session here' })))
        .status,
    ).toBe(401);
    // A new browser signs in with it.
    const second = await startAuthorize();
    const login = await second.browser.call(
      '/password/login',
      json({
        request: requestIdOf(second.response),
        email: 'ada@example.com',
        password: 'correct horse battery',
      }),
    );
    expect(login.status).toBe(200);
    const { redirect } = (await login.json()) as { redirect: string };
    const tokens = (await (
      await exchange(
        new URL(redirect).searchParams.get('code')!,
        second.verifier,
      )
    ).json()) as Tokens;
    expect(claimsOf(tokens)).toMatchObject({ email: 'ada@example.com' });
    // A wrong password and an unknown address answer alike: no account enumeration.
    const third = await startAuthorize();
    const request = requestIdOf(third.response);
    const wrong = await third.browser.call(
      '/password/login',
      json({ request, email: 'ada@example.com', password: 'wrong horse' }),
    );
    const unknown = await third.browser.call(
      '/password/login',
      json({
        request,
        email: 'nobody@example.com',
        password: 'correct horse battery',
      }),
    );
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(await wrong.text()).toBe(await unknown.text());
    // Passwords are off until the app turns them on.
    await settings({ password: 'off' });
    expect(
      (
        await third.browser.call(
          '/password/login',
          json({
            request,
            email: 'ada@example.com',
            password: 'correct horse battery',
          }),
        )
      ).status,
    ).toBe(404);
  });

  it('refuses email sign-in without a sender address, malformed addresses, and a sixth link in ten minutes', async () => {
    const { response, browser } = await startAuthorize();
    const request = requestIdOf(response);
    const ask = (email: string) =>
      browser.call('/email/start', form({ request, email }));
    expect((await ask('ada@example.com')).status).toBe(404);
    expect(sent).toEqual([]);
    await settings({ email_from: 'sign-in@shop.example' });
    expect((await ask('not an address')).status).toBe(400);
    for (let i = 0; i < 5; i++)
      expect((await ask('ada@example.com')).status).toBe(200);
    expect((await ask('ada@example.com')).status).toBe(429);
    expect(sent).toHaveLength(5);
    // The sign-in page offers the email form only when a sender address is set.
    const page = await (
      await browser.call(`/sign-in?request=${request}`)
    ).text();
    expect(page).toContain('/email/start');
    await settings({ email_from: '' });
    expect(
      await (await browser.call(`/sign-in?request=${request}`)).text(),
    ).not.toContain('/email/start');
  });
});

describe('realtime service', () => {
  type Socket = {
    accept(): void;
    send(data: string): void;
    close(): void;
    addEventListener(
      type: 'message',
      listener: (event: { data: string }) => void,
    ): void;
  };
  async function connect(
    channel: string,
    token?: string,
    headers: Record<string, string> = {},
  ) {
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const response = await call(
      `/realtime/channels/${encodeURIComponent(channel)}${query}`,
      {
        headers: { Upgrade: 'websocket', ...headers },
      },
    );
    if (response.status !== 101) return { status: response.status, response };
    const ws = response.webSocket as Socket;
    const inbox: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    ws.accept();
    ws.addEventListener('message', (event) => {
      inbox.push(JSON.parse(event.data));
      waiters.splice(0).forEach((w) => w());
    });
    const next = async (predicate: (m: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 50; i++) {
        const found = inbox.find(predicate);
        if (found) return found;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
      throw new Error('message not received');
    };
    return { status: 101, ws, inbox, next };
  }
  const token = (claims: Record<string, unknown>) =>
    hs256(
      { exp: Math.floor(Date.now() / 1000) + 600, ...claims },
      realtimeSecret,
    );
  const publish = (channel: string, body: unknown, secret = realtimeSecret) =>
    call(`/realtime/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('lets anyone listen on public channels and only the server key publish', async () => {
    const listener = await connect('public:news');
    expect(listener.status).toBe(101);
    await listener.next!((m) => m.type === 'welcome');
    expect(
      (
        await publish(
          'public:news',
          { event: 'headline', data: { title: 'Hello' } },
          'wrong',
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await publish('public:news', {
          event: 'headline',
          data: { title: 'Hello' },
        })
      ).status,
    ).toBe(200);
    const headline = await listener.next!((m) => m.type === 'message');
    expect(headline).toMatchObject({
      event: 'headline',
      data: { title: 'Hello' },
      server: true,
    });
    expect(headline.from).toBeUndefined();
    listener.ws!.send(JSON.stringify({ event: 'spam', data: 1 }));
    expect(await listener.next!((m) => m.type === 'error')).toMatchObject({
      message: 'This connection can only listen.',
    });
    listener.ws!.close();
  });

  it('needs a channel token signed by the app for private channels', async () => {
    expect((await connect('room:1')).status).toBe(401);
    expect(
      (
        await connect(
          'room:1',
          await token({ sub: 'ada', channels: ['room:2'] }),
        )
      ).status,
    ).toBe(403);
    const forged = await hs256(
      {
        sub: 'ada',
        channels: ['room:*'],
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      'not-the-secret',
    );
    expect((await connect('room:1', forged)).status).toBe(401);
    const expired = await hs256(
      { sub: 'ada', channels: ['room:*'], exp: 1 },
      realtimeSecret,
    );
    expect((await connect('room:1', expired)).status).toBe(401);
  });

  it('broadcasts messages and presence between members of a channel', async () => {
    const ada = await connect(
      'room:7',
      await token({
        sub: 'ada',
        channels: ['room:*'],
        publish: true,
        info: { name: 'Ada' },
      }),
    );
    expect(await ada.next!((m) => m.type === 'welcome')).toMatchObject({
      members: [{ sub: 'ada', info: { name: 'Ada' } }],
    });
    const bob = await connect(
      'room:7',
      await token({ sub: 'bob', channels: ['room:7'], publish: true }),
    );
    await bob.next!((m) => m.type === 'welcome');
    expect(await ada.next!((m) => m.type === 'presence')).toMatchObject({
      event: 'join',
      member: { sub: 'bob' },
    });
    ada.ws!.send(JSON.stringify({ event: 'chat', data: 'hi bob' }));
    expect(await bob.next!((m) => m.type === 'message')).toMatchObject({
      event: 'chat',
      data: 'hi bob',
      from: 'ada',
    });
    const presence = await call('/realtime/channels/room%3A7/presence', {
      headers: { Authorization: `Bearer ${realtimeSecret}` },
    });
    expect(
      ((await presence.json()) as { members: { sub: string }[] }).members
        .map((m) => m.sub)
        .sort(),
    ).toEqual(['ada', 'bob']);
    bob.ws!.close();
    expect(
      await ada.next!((m) => m.type === 'presence' && m.event === 'leave'),
    ).toMatchObject({ member: { sub: 'bob' } });
    expect(
      ada.inbox!.some((m) => m.type === 'message' && m.from === 'ada'),
    ).toBe(false);
    ada.ws!.close();
  });

  it('lets a signed-in user listen on their own user channel only', async () => {
    const { verified, verifier } = await signUp('Realtime User');
    const code = new URL(
      ((await verified.json()) as { redirect: string }).redirect,
    ).searchParams.get('code')!;
    const tokens = (await (await exchange(code, verifier)).json()) as Tokens;
    const sub = JSON.parse(
      Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString(),
    ).sub;
    expect((await connect(`user:${sub}`, tokens.access_token)).status).toBe(
      101,
    );
    expect(
      (await connect('user:someone-else', tokens.access_token)).status,
    ).toBe(403);
    expect((await connect('room:9', tokens.access_token)).status).toBe(403);
  });

  it('marks server messages so no channel token can pose as the server', async () => {
    const listener = await connect('public:alerts');
    await listener.next!((m) => m.type === 'welcome');
    const impostor = await connect(
      'public:alerts',
      await token({ sub: 'server', channels: ['public:*'], publish: true }),
    );
    await impostor.next!((m) => m.type === 'welcome');
    impostor.ws!.send(JSON.stringify({ event: 'alert', data: 'fake' }));
    const fake = await listener.next!((m) => m.type === 'message');
    expect(fake).toMatchObject({ from: 'server', data: 'fake' });
    expect(fake.server).toBeUndefined();
    await publish('public:alerts', { event: 'alert', data: 'real' });
    expect(
      await listener.next!((m) => m.type === 'message' && m.data === 'real'),
    ).toMatchObject({ server: true });
    listener.ws!.close();
    impostor.ws!.close();
  });

  it('limits anonymous listeners per address so members can still join', async () => {
    const address = { 'CF-Connecting-IP': '203.0.113.9' };
    const open = [];
    for (let i = 0; i < 20; i++) {
      const listener = await connect('public:busy', undefined, address);
      expect(listener.status).toBe(101);
      open.push(listener);
    }
    expect((await connect('public:busy', undefined, address)).status).toBe(429);
    const elsewhere = await connect('public:busy', undefined, {
      'CF-Connecting-IP': '198.51.100.4',
    });
    expect(elsewhere.status).toBe(101);
    const memberToken = await token({ sub: 'ada', channels: ['public:*'] });
    expect((await connect('public:busy', memberToken, address)).status).toBe(
      101,
    );
    for (const l of [...open, elsewhere]) l.ws!.close();
  });

  it('refuses disabled users and closes their open connections', async () => {
    const { tokens, sub } = await signedIn('Realtime Disabled');
    const socket = await connect(`user:${sub}`, tokens.access_token);
    expect(socket.status).toBe(101);
    await socket.next!((m) => m.type === 'welcome');
    const members = async () =>
      (
        (await (
          await call(
            `/realtime/channels/${encodeURIComponent(`user:${sub}`)}/presence`,
            {
              headers: { Authorization: `Bearer ${realtimeSecret}` },
            },
          )
        ).json()) as { members: { sub: string }[] }
      ).members.map((m) => m.sub);
    expect(await members()).toEqual([sub]);
    const db = await mf.getD1Database('DB');
    await db.prepare('UPDATE users SET disabled=1 WHERE id=?').bind(sub).run();
    // The channel closes the socket at its next re-check (every second in tests, five
    // minutes live). Miniflare doesn't pass a server-side close of a hibernatable socket on
    // to the test client, so this checks the channel's own view.
    let remaining = [sub];
    for (let i = 0; i < 40 && remaining.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      remaining = await members();
    }
    expect(remaining).toEqual([]);
    await publish(`user:${sub}`, { event: 'after', data: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.inbox!.some((m) => m.event === 'after')).toBe(false);
    expect((await connect(`user:${sub}`, tokens.access_token)).status).toBe(
      403,
    );
  });

  it('does not accept an ID token for a user channel', async () => {
    const { tokens, sub } = await signedIn('Realtime ID Token');
    expect((await connect(`user:${sub}`, tokens.id_token)).status).toBe(401);
  });

  it('turns off when asked', async () => {
    await settings({ realtime: 'off' });
    expect((await connect('public:news')).status).toBe(404);
  });

  // The data API (services/backend/src/data.ts) over the app's own database, with each
  // change sent on the channels of those who may read it.
  describe('data API', () => {
    const api = (path: string, init: RequestInit = {}, token?: string) =>
      call(`/data/${path}`, {
        ...init,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    const send = (
      path: string,
      method: string,
      body: unknown,
      token?: string,
    ) => api(path, { method, body: JSON.stringify(body) }, token);
    const rows = async (r: Fetch) =>
      ((await r.json()) as { rows: Record<string, unknown>[] }).rows;
    beforeEach(async () => {
      const db = await mf.getD1Database('DATA');
      await db.batch(
        [
          'DROP TABLE IF EXISTS notes',
          'DROP TABLE IF EXISTS posts',
          'DROP TABLE IF EXISTS comments',
          'DROP TABLE IF EXISTS private',
          'CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)',
          'CREATE TABLE posts (id INTEGER PRIMARY KEY, author TEXT NOT NULL, title TEXT NOT NULL)',
          'CREATE TABLE comments (id INTEGER PRIMARY KEY, text TEXT)',
          'CREATE TABLE private (id INTEGER PRIMARY KEY, value TEXT)',
          "INSERT INTO comments (text) VALUES ('first')",
        ].map((sql) => db.prepare(sql)),
      );
      await settings({
        data_tables: JSON.stringify({
          notes: { read: 'owner', write: 'owner', owner: 'user_id' },
          posts: { read: 'public', write: 'signed-in', owner: 'author' },
          comments: { read: 'signed-in', write: 'none' },
        }),
      });
    });

    it('lets each user read and change only their own rows, in the tables opened', async () => {
      const ada = await signedIn('Ada Data');
      const bob = await signedIn('Bob Data');
      const [a, b] = [ada.tokens.access_token, bob.tokens.access_token];
      const created = await send('notes', 'POST', { body: 'buy milk' }, a);
      expect(created.status).toBe(201);
      const [note] = await rows(created);
      expect(note).toMatchObject({
        user_id: ada.sub,
        body: 'buy milk',
        done: 0,
      });
      // A row for someone else is refused.
      expect(
        (await send('notes', 'POST', { body: 'x', user_id: bob.sub }, a))
          .status,
      ).toBe(403);
      await send(
        'notes',
        'POST',
        [{ body: 'call mum' }, { body: 'fix bike' }],
        b,
      );
      expect(
        (await rows(await api('notes', {}, a))).map((n) => n.body),
      ).toEqual(['buy milk']);
      expect(await rows(await api('notes', {}, b))).toHaveLength(2);
      // Bob's changes reach none of Ada's rows.
      expect(
        await rows(
          await send(`notes?id=eq.${note.id}`, 'PATCH', { done: true }, b),
        ),
      ).toEqual([]);
      expect(
        await rows(
          await api(`notes?id=eq.${note.id}`, { method: 'DELETE' }, b),
        ),
      ).toEqual([]);
      expect(
        await rows(
          await send(`notes?id=eq.${note.id}`, 'PATCH', { done: true }, a),
        ),
      ).toEqual([{ ...note, done: 1 }]);
      // Nor can a row be handed to someone else.
      expect(
        (await send(`notes?id=eq.${note.id}`, 'PATCH', { user_id: bob.sub }, a))
          .status,
      ).toBe(403);
      expect(
        await rows(
          await api(`notes?id=eq.${note.id}`, { method: 'DELETE' }, a),
        ),
      ).toHaveLength(1);
      // Without a token, or for a table not opened, nothing.
      expect((await api('notes')).status).toBe(401);
      expect((await api('private', {}, a)).status).toBe(404);
      expect((await send('comments', 'POST', { text: 'x' }, a)).status).toBe(
        403,
      );
      expect(await rows(await api('comments', {}, a))).toEqual([
        { id: 1, text: 'first' },
      ]);
      expect((await api('comments')).status).toBe(401);
      // A public table is read by anyone; signed-in users add to it as themselves, and a
      // change keeps a row's author.
      const [post] = await rows(
        await send('posts', 'POST', { title: 'Hello' }, a),
      );
      expect(post).toEqual({ id: 1, author: ada.sub, title: 'Hello' });
      expect(await rows(await api('posts'))).toHaveLength(1);
      expect((await send('posts', 'POST', { title: 'Anon' })).status).toBe(401);
      expect(
        await rows(
          await send('posts?id=eq.1', 'PATCH', { title: 'Edited' }, b),
        ),
      ).toEqual([{ id: 1, author: ada.sub, title: 'Edited' }]);
    });

    it('filters, orders and pages as PostgREST does, and says what it can’t take', async () => {
      const ada = await signedIn('Filter Ada');
      const t = ada.tokens.access_token;
      await send(
        'notes',
        'POST',
        [{ body: 'a' }, { body: 'b', done: 1 }, { body: 'c' }],
        t,
      );
      expect(
        await rows(
          await api('notes?done=eq.0&order=id.desc&select=body&limit=1', {}, t),
        ),
      ).toEqual([{ body: 'c' }]);
      expect(
        await rows(await api('notes?body=like.%25b%25&select=body', {}, t)),
      ).toEqual([{ body: 'b' }]);
      expect(
        await rows(await api('notes?select=body&order=id.asc&offset=2', {}, t)),
      ).toEqual([{ body: 'c' }]);
      for (const bad of [
        'notes?nope=eq.1',
        'notes?done=equals.1',
        'notes?limit=500',
        'notes?order=id.sideways',
        'notes?select=body;drop',
      ])
        expect([bad, (await api(bad, {}, t)).status]).toEqual([bad, 400]);
      // Changing or deleting needs a filter naming the rows.
      expect((await api('notes', { method: 'DELETE' }, t)).status).toBe(400);
      const [first] = await rows(
        await api('notes?order=id.asc&limit=1', {}, t),
      );
      const again = await send(
        'notes',
        'POST',
        { id: first.id, body: 'again' },
        t,
      );
      expect(again.status).toBe(409);
      expect(await again.text()).toContain('UNIQUE constraint failed');
      // The app's pages call it from their own address; other sites get no CORS answer.
      const preflight = await call('/data/notes', {
        method: 'OPTIONS',
        headers: { Origin: appOrigin },
      });
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(
        appOrigin,
      );
      expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain(
        'PATCH',
      );
      const elsewhere = await call('/data/notes', {
        method: 'OPTIONS',
        headers: { Origin: 'https://elsewhere.test' },
      });
      expect(elsewhere.headers.get('Access-Control-Allow-Origin')).toBeNull();
      // Turned off, it answers nothing.
      await settings({ data_tables: '{}' });
      expect((await api('notes', {}, t)).status).toBe(404);
    });

    it('takes only new rows into a table no one reads, and opens nothing more people change than read', async () => {
      await settings({
        data_tables: JSON.stringify({
          comments: { read: 'none', write: 'signed-in' },
          notes: { read: 'owner', write: 'signed-in', owner: 'user_id' },
        }),
      });
      const t = (await signedIn('Writer Ada')).tokens.access_token;
      expect(
        (await send('comments', 'POST', { text: 'hello' }, t)).status,
      ).toBe(201);
      expect((await api('comments', {}, t)).status).toBe(403);
      // A change would answer with rows the writer can't read.
      expect(
        (await send('comments?id=eq.1', 'PATCH', { text: 'x' }, t)).status,
      ).toBe(403);
      expect(
        (await api('comments?id=eq.1', { method: 'DELETE' }, t)).status,
      ).toBe(403);
      expect((await api('notes', {}, t)).status).toBe(404);
      // Names every object has are no table, and no operator, even when the app has one.
      await (
        await mf.getD1Database('DATA')
      )
        .prepare(
          'CREATE TABLE IF NOT EXISTS "constructor" (id INTEGER PRIMARY KEY)',
        )
        .run();
      expect((await api('constructor', {}, t)).status).toBe(404);
      await settings({
        data_tables: JSON.stringify({
          comments: { read: 'signed-in', write: 'none' },
        }),
      });
      expect((await api('comments?text=constructor.1', {}, t)).status).toBe(
        400,
      );
    });

    it('sends each change to whoever may read it', async () => {
      const ada = await signedIn('Stream Ada');
      const everyone = await connect('public:data:posts');
      await everyone.next!((m) => m.type === 'welcome');
      const own = await connect(`user:${ada.sub}`, ada.tokens.access_token);
      await own.next!((m) => m.type === 'welcome');
      await send('posts', 'POST', { title: 'Live' }, ada.tokens.access_token);
      expect(await everyone.next!((m) => m.type === 'message')).toMatchObject({
        event: 'data:insert',
        data: { table: 'posts', rows: [{ title: 'Live', author: ada.sub }] },
        server: true,
      });
      await send('notes', 'POST', { body: 'mine' }, ada.tokens.access_token);
      expect(await own.next!((m) => m.type === 'message')).toMatchObject({
        event: 'data:insert',
        data: { table: 'notes', rows: [{ body: 'mine', user_id: ada.sub }] },
      });
      // A signed-in table's channel needs a sign-in token.
      expect((await connect('signed-in:data:comments')).status).toBe(401);
      const member = await connect(
        'signed-in:data:comments',
        ada.tokens.access_token,
      );
      expect(member.status).toBe(101);
      for (const socket of [everyone, own, member]) socket.ws!.close();
    });
  });
});
