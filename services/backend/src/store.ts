// D1 access for the sign-in service. Secrets never go in D1: keys and OAuth client
// secrets are Worker secrets; tokens, codes and session IDs are stored only as hashes.
import {
  cookie,
  hashToken,
  hostCookie,
  HttpError,
  now,
  randomToken,
  safeEqual,
} from './util';

export type Env = {
  DB: D1Database;
  CHANNELS: DurableObjectNamespace;
  SIGNING_KEY?: string;
  REALTIME_SECRET?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  CLOUDCEL_BACKEND_VERSION?: string;
  // How often realtime channels re-check signed-in members (seconds); tests shorten it.
  REALTIME_RECHECK_SECONDS?: string;
  // Cloudflare's Email Service (a `send_email` binding): sign-in links go through it.
  EMAIL?: {
    send(message: EmailMessage): Promise<{ messageId: string }>;
  };
  // The app's own D1 database, when its owner turns on the data API (data.ts).
  DATA?: D1Database;
};
export type EmailMessage = {
  from: { email: string; name: string };
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type Settings = {
  clientId: string;
  appName: string;
  redirectUris: string[];
  logoutUris: string[];
  githubClientId: string | null;
  googleClientId: string | null;
  emailFrom: string | null;
  password: boolean;
  signin: boolean;
  realtime: boolean;
  dataTables: Record<string, TablePolicy>;
};

// Who may read and change a table through the data API (data.ts): everyone, any signed-in
// user, only the user a row belongs to (named in its `owner` column), or no one.
export type Access = 'public' | 'signed-in' | 'owner' | 'none';
export type TablePolicy = {
  read: Access;
  write: Exclude<Access, 'public'>;
  owner?: string;
};
export const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// How many people an access level reaches. A change answers with the rows it reached, so
// no table lets more people change it than read it, except one no one reads, which only
// takes new rows.
const reach: Record<Access, number> = {
  none: 0,
  owner: 1,
  'signed-in': 2,
  public: 3,
};
export const changesWithinReads = (p: TablePolicy) =>
  p.read === 'none' || reach[p.write] <= reach[p.read];

// The tables the data API opens, dropping any entry that isn't a sound policy.
function tablePolicies(raw: string | undefined) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const sound = ([table, policy]: [string, unknown]) => {
    const p = policy as Partial<TablePolicy> | null;
    return (
      identifier.test(table) &&
      !/^(_cf_|sqlite_|d1_)/i.test(table) &&
      !!p &&
      ['public', 'signed-in', 'owner', 'none'].includes(p.read as string) &&
      ['signed-in', 'owner', 'none'].includes(p.write as string) &&
      (p.owner === undefined || identifier.test(p.owner)) &&
      changesWithinReads(p as TablePolicy) &&
      (p.read !== 'owner' && p.write !== 'owner' ? true : p.owner !== undefined)
    );
  };
  return Object.fromEntries(Object.entries(parsed).filter(sound)) as Record<
    string,
    TablePolicy
  >;
}

export type User = {
  id: string;
  email: string | null;
  email_verified: number;
  name: string | null;
  picture: string | null;
  disabled: number;
};

export type AuthRequest = {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  nonce: string | null;
  scope: string;
  code_challenge: string;
  expires_at: number;
};

export async function readSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare(
    'SELECT key, value FROM settings',
  ).all<{
    key: string;
    value: string;
  }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const list = (key: string) => {
    try {
      const value = JSON.parse(map.get(key) ?? '[]');
      return Array.isArray(value)
        ? value.filter((v) => typeof v === 'string')
        : [];
    } catch {
      return [];
    }
  };
  return {
    clientId: map.get('client_id') ?? '',
    appName: map.get('app_name') || 'this app',
    redirectUris: list('redirect_uris'),
    logoutUris: list('logout_uris'),
    githubClientId: map.get('github_client_id') || null,
    googleClientId: map.get('google_client_id') || null,
    // Sign-in by email: links are sent from this address (on a domain onboarded for
    // Cloudflare's Email Service); passwords are allowed only when the app says so.
    emailFrom: map.get('email_from') || null,
    password: map.get('password') === 'on',
    signin: map.get('signin') !== 'off',
    realtime: map.get('realtime') !== 'off',
    dataTables: tablePolicies(map.get('data_tables')),
  };
}

export const SESSION_COOKIE = '__Host-cc_session';
// Ties each sign-in request to the browser that started it, so a request (or an OAuth
// callback) started by someone else can't be finished in this browser (login CSRF).
export const BROWSER_COOKIE = '__Host-cc_browser';
const BROWSER_LIFETIME = 86400;

export const requireSignin = (settings: Settings) => {
  if (!settings.signin)
    throw new HttpError(
      404,
      'Sign-in is turned off for this app.',
      'access_denied',
    );
};

// Returns the browser's binding value, creating one (and its cookie) when missing.
export function browserBinding(request: Request) {
  const existing = cookie(request, BROWSER_COOKIE);
  if (existing && /^[\w-]{43}$/.test(existing))
    return { value: existing, setCookie: null };
  const value = randomToken();
  return {
    value,
    setCookie: hostCookie(BROWSER_COOKIE, value, BROWSER_LIFETIME),
  };
}

export async function bindToBrowser(
  env: Env,
  requestId: string,
  browser: string,
  expiresAt: number,
) {
  await env.DB.prepare(
    'INSERT INTO auth_request_browsers (request_id,browser_hash,expires_at) VALUES (?,?,?)',
  )
    .bind(requestId, await hashToken(browser), expiresAt)
    .run();
}

// Loads a pending sign-in request. With `from`, the request must have been started in the
// same browser.
export async function getAuthRequest(env: Env, id: unknown, from?: Request) {
  if (typeof id !== 'string' || !/^[\w-]{20,64}$/.test(id))
    throw new HttpError(400, 'This sign-in link is not valid.');
  const request = await env.DB.prepare(
    'SELECT a.*, b.browser_hash FROM auth_requests a LEFT JOIN auth_request_browsers b ON b.request_id=a.id WHERE a.id=? AND a.expires_at>?',
  )
    .bind(id, now())
    .first<AuthRequest & { browser_hash: string | null }>();
  if (!request)
    throw new HttpError(
      400,
      'This sign-in link has expired. Go back to the app and sign in again.',
    );
  if (from) {
    const browser = cookie(from, BROWSER_COOKIE);
    if (
      !request.browser_hash ||
      !browser ||
      !safeEqual(await hashToken(browser), request.browser_hash)
    )
      throw new HttpError(
        400,
        'This sign-in was started in another browser. Go back to the app and sign in again.',
      );
  }
  return request;
}

export async function getUser(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(id)
    .first<User>();
}

export async function activeUser(env: Env, id: string) {
  const user = await getUser(env, id);
  if (!user)
    throw new HttpError(400, 'This account no longer exists.', 'invalid_grant');
  if (user.disabled)
    throw new HttpError(403, 'This account is disabled.', 'access_denied');
  return user;
}

export async function createUser(
  env: Env,
  user: {
    id?: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    picture: string | null;
  },
) {
  const id = user.id ?? randomToken(16);
  await env.DB.prepare(
    'INSERT INTO users (id,email,email_verified,name,picture,disabled,created_at) VALUES (?,?,?,?,?,0,?)',
  )
    .bind(
      id,
      user.email,
      user.emailVerified ? 1 : 0,
      user.name,
      user.picture,
      now(),
    )
    .run();
  return id;
}

export async function startSession(env: Env, userId: string) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO sessions (token_hash,user_id,auth_time,expires_at) VALUES (?,?,?,?)',
    ).bind(await hashToken(token), userId, now(), now() + 30 * 86400),
    env.DB.prepare('UPDATE users SET last_sign_in_at=? WHERE id=?').bind(
      now(),
      userId,
    ),
  ]);
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

export async function currentSession(env: Env, request: Request) {
  const token = cookie(request, SESSION_COOKIE);
  if (!token || !/^[\w-]{20,64}$/.test(token)) return null;
  const session = await env.DB.prepare(
    'SELECT s.user_id, s.auth_time FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0',
  )
    .bind(await hashToken(token), now())
    .first<{ user_id: string; auth_time: number }>();
  return session;
}

export async function endSession(env: Env, request: Request) {
  const token = cookie(request, SESSION_COOKIE);
  if (token)
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
      .bind(await hashToken(token))
      .run();
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// Expired rows are removed on a sample of new sign-ins, through the expires_at indexes,
// so a sign-in never scans whole tables (D1's free plan counts rows read).
export async function removeExpired(env: Env) {
  const time = now();
  await env.DB.batch(
    [
      'auth_requests',
      'auth_request_browsers',
      'challenges',
      'oauth_states',
      'codes',
      'sessions',
      'refresh_tokens',
      'email_links',
    ].map((table) =>
      env.DB.prepare(`DELETE FROM ${table} WHERE expires_at<?`).bind(time),
    ),
  );
}
