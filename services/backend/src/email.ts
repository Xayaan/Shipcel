// Sign-in by email: a one-time link sent through Cloudflare's Email Service from the app's
// own address, and an optional password set once signed in. The link finishes the sign-in
// request it was asked for, in the browser that asked (login CSRF, like every other method),
// and an address reached this way counts as verified, so it links to the same account
// GitHub or Google verified.
import { complete, issuerOf } from './oidc';
import { checkEmailPage } from './pages';
import {
  createUser,
  currentSession,
  getAuthRequest,
  readSettings,
  requireSignin,
  startSession,
  type Env,
  type Settings,
} from './store';
import {
  HttpError,
  escapeHtml,
  hashToken,
  json,
  now,
  randomToken,
  readJson,
  requireSameOrigin,
  safeEqual,
  toBase64Url,
} from './util';

const LINK_LIFETIME = 15 * 60;
// At most this many links per address in the window: an inbox can't be flooded from here.
const LINKS_PER_WINDOW = 5;
const WINDOW = 10 * 60;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
// PBKDF2-HMAC-SHA256 at OWASP's 2023 figure. Native in workerd, about a tenth of a second
// of CPU: within Workers Paid's limit, which Email Sending needs anyway.
const PBKDF2_ITERATIONS = 600000;

function emailOf(raw: unknown) {
  const email = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

// The hosted page posts a plain form (it works without scripts); it must come from here.
async function readForm(request: Request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin)
    throw new HttpError(403, 'Cross-site request refused.');
  const text = await request.text();
  if (text.length > 4096) throw new HttpError(413, 'Request is too large.');
  return new URLSearchParams(text);
}

function emailSetUp(settings: Settings, env: Env) {
  if (!settings.emailFrom || !env.EMAIL)
    throw new HttpError(404, 'Sign-in by email isn’t set up for this app.');
  return settings.emailFrom;
}

export async function emailStart(request: Request, env: Env) {
  const settings = await readSettings(env);
  requireSignin(settings);
  const from = emailSetUp(settings, env);
  const form = await readForm(request);
  const authRequest = await getAuthRequest(env, form.get('request'), request);
  const email = emailOf(form.get('email'));
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM email_links WHERE email=? AND created_at>?',
  )
    .bind(email, now() - WINDOW)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= LINKS_PER_WINDOW)
    throw new HttpError(
      429,
      'Several sign-in links were sent to this address already. Open the latest one, or try again in a few minutes.',
    );
  const token = randomToken();
  await env.DB.prepare(
    'INSERT INTO email_links (token_hash,request_id,email,created_at,expires_at) VALUES (?,?,?,?,?)',
  )
    .bind(
      await hashToken(token),
      authRequest.id,
      email,
      now(),
      now() + LINK_LIFETIME,
    )
    .run();
  const link = `${issuerOf(request)}/email/finish?token=${token}`;
  const note =
    'It works once, for 15 minutes, in the browser where you asked for it. If you didn’t ask for it, ignore this email.';
  await env.EMAIL!.send({
    from: { email: from, name: settings.appName },
    to: email,
    subject: `Sign in to ${settings.appName}`,
    text: `Open this link to sign in to ${settings.appName}:\n\n${link}\n\n${note}`,
    html: `<p>Open this link to sign in to ${escapeHtml(settings.appName)}:</p><p><a href="${link}">${link}</a></p><p>${note}</p>`,
  });
  return checkEmailPage(settings, email);
}

// The account an address signs in to: the one it was linked to before, else the one that
// verified the same address another way, else a new one.
async function userForEmail(env: Env, email: string) {
  const linked = await env.DB.prepare(
    'SELECT u.id, u.disabled FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.subject=?',
  )
    .bind('email', email)
    .first<{ id: string; disabled: number }>();
  if (linked) return linked;
  const sameEmail = await env.DB.prepare(
    'SELECT id, disabled FROM users WHERE email=? AND email_verified=1 ORDER BY created_at LIMIT 1',
  )
    .bind(email)
    .first<{ id: string; disabled: number }>();
  const user = sameEmail ?? {
    id: await createUser(env, {
      email,
      emailVerified: true,
      name: null,
      picture: null,
    }),
    disabled: 0,
  };
  await env.DB.prepare(
    'INSERT INTO identities (provider,subject,user_id,email,created_at) VALUES (?,?,?,?,?)',
  )
    .bind('email', email, user.id, email, now())
    .run();
  return user;
}

export async function emailFinish(request: Request, env: Env) {
  const settings = await readSettings(env);
  requireSignin(settings);
  const token = new URL(request.url).searchParams.get('token');
  if (!token || !/^[\w-]{20,64}$/.test(token))
    throw new HttpError(400, 'This sign-in link is not valid.');
  const tokenHash = await hashToken(token);
  const link = await env.DB.prepare(
    'SELECT request_id, email, expires_at FROM email_links WHERE token_hash=?',
  )
    .bind(tokenHash)
    .first<{ request_id: string; email: string; expires_at: number }>();
  if (!link || link.expires_at < now())
    throw new HttpError(
      400,
      'This sign-in link has expired or was used already. Go back to the app and ask for a new one.',
    );
  // Refused before the link is spent, so the right browser can still use it.
  const authRequest = await getAuthRequest(env, link.request_id, request);
  await env.DB.prepare('DELETE FROM email_links WHERE token_hash=?')
    .bind(tokenHash)
    .run();
  const user = await userForEmail(env, link.email);
  if (user.disabled) throw new HttpError(403, 'This account is disabled.');
  const sessionCookie = await startSession(env, user.id);
  return new Response(null, {
    status: 302,
    headers: {
      Location: await complete(env, authRequest.id, user.id),
      'Set-Cookie': sessionCookie,
      'Cache-Control': 'no-store',
    },
  });
}

async function derive(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      iterations,
    },
    key,
    256,
  );
  return toBase64Url(bits);
}

function passwordsOn(settings: Settings) {
  if (!settings.password)
    throw new HttpError(404, 'Passwords aren’t turned on for this app.');
}

// Sets or changes the password of the signed-in account (the session the hosted page holds).
export async function passwordSet(request: Request, env: Env) {
  requireSameOrigin(request);
  const settings = await readSettings(env);
  requireSignin(settings);
  passwordsOn(settings);
  const session = await currentSession(env, request);
  if (!session) throw new HttpError(401, 'Sign in first, then set a password.');
  const body = (await readJson(request)) as { password?: unknown };
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
    throw new HttpError(
      400,
      `Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`,
    );
  const salt = randomToken(16);
  await env.DB.prepare(
    'INSERT OR REPLACE INTO passwords (user_id,hash,salt,iterations,updated_at) VALUES (?,?,?,?,?)',
  )
    .bind(
      session.user_id,
      await derive(password, salt, PBKDF2_ITERATIONS),
      salt,
      PBKDF2_ITERATIONS,
      now(),
    )
    .run();
  return json({ set: true });
}

export async function passwordLogin(request: Request, env: Env) {
  requireSameOrigin(request);
  const settings = await readSettings(env);
  requireSignin(settings);
  passwordsOn(settings);
  const body = (await readJson(request)) as {
    request?: unknown;
    email?: unknown;
    password?: unknown;
  };
  const authRequest = await getAuthRequest(env, body.request, request);
  const email = emailOf(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const stored = await env.DB.prepare(
    'SELECT p.user_id, p.hash, p.salt, p.iterations, u.disabled FROM passwords p JOIN users u ON u.id=p.user_id WHERE u.email=? AND u.email_verified=1 ORDER BY u.created_at LIMIT 1',
  )
    .bind(email)
    .first<{
      user_id: string;
      hash: string;
      salt: string;
      iterations: number;
      disabled: number;
    }>();
  // Derived either way, so the time taken doesn't say whether the address is known.
  const hash = await derive(
    password,
    stored?.salt ?? 'no-such-account',
    stored?.iterations ?? PBKDF2_ITERATIONS,
  );
  if (!stored || !safeEqual(hash, stored.hash))
    throw new HttpError(401, 'That email address and password don’t match.');
  if (stored.disabled) throw new HttpError(403, 'This account is disabled.');
  const sessionCookie = await startSession(env, stored.user_id);
  return json(
    { redirect: await complete(env, authRequest.id, stored.user_id) },
    { headers: { 'Set-Cookie': sessionCookie } },
  );
}
