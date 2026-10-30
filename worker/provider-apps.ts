import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { digest, encryptionReady, randomToken, seal, unseal } from './crypto';
import { cloudflare, cloudflarePage, providerJSON } from './providers';
import {
  githubManifest,
  normalize,
  pickScopes,
  wantedScopes,
} from '../shared/provider-setup';
import {
  AppError,
  appOrigin,
  localMode,
  now,
  type AppEnv,
  type Env,
} from './types';

// The GitHub App and Cloudflare OAuth client Shipcel signs people in with. A hosted Shipcel
// takes them from its environment (the operator's secrets). A local Shipcel can also set them
// up from the Connections page: a GitHub App from a manifest the person confirms on GitHub, and
// a Cloudflare OAuth client created with a temporary API token that Shipcel uses once and
// doesn't keep. Stored secrets are encrypted with TOKEN_ENCRYPTION_KEY and never returned.
export const setup = new Hono<AppEnv>();
export type Provider = 'github' | 'cloudflare';
export type ProviderApp = {
  source: 'env' | 'setup';
  clientId: string;
  clientSecret: string;
  name: string | null;
  // GitHub: the app's slug and page.
  slug: string | null;
  url: string | null;
  // Cloudflare: the account that owns the client, and the scopes it may request.
  accountId: string | null;
  scopes: string[];
};
type Row = {
  client_id: string;
  secret_sealed: string;
  name: string | null;
  slug: string | null;
  url: string | null;
  account_id: string | null;
  scopes: string | null;
};
const label = { github: 'GitHub', cloudflare: 'Cloudflare' } as const;
const sealContext = (provider: Provider) => `provider-app:${provider}`;

function fromEnv(env: Env, provider: Provider): ProviderApp | null {
  if (provider === 'github')
    return env.GITHUB_CLIENT_ID &&
      env.GITHUB_CLIENT_SECRET &&
      env.GITHUB_APP_SLUG
      ? {
          source: 'env',
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
          name: null,
          slug: env.GITHUB_APP_SLUG,
          url: `https://github.com/apps/${env.GITHUB_APP_SLUG}`,
          accountId: null,
          scopes: [],
        }
      : null;
  return env.CLOUDFLARE_CLIENT_ID &&
    env.CLOUDFLARE_CLIENT_SECRET &&
    env.CLOUDFLARE_OAUTH_SCOPES
    ? {
        source: 'env',
        clientId: env.CLOUDFLARE_CLIENT_ID,
        clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
        name: null,
        slug: null,
        url: null,
        accountId: null,
        scopes: env.CLOUDFLARE_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
      }
    : null;
}

// The app a provider signs in with: the environment's, else one set up from the dashboard.
// Either way it needs the encryption key, which also protects the tokens it produces.
export async function providerApp(
  env: Env,
  provider: Provider,
): Promise<ProviderApp | null> {
  if (!encryptionReady(env.TOKEN_ENCRYPTION_KEY)) return null;
  const configured = fromEnv(env, provider);
  if (configured) return configured;
  const row = await env.DB.prepare(
    'SELECT * FROM provider_apps WHERE provider=?',
  )
    .bind(provider)
    .first<Row>();
  if (!row) return null;
  return {
    source: 'setup',
    clientId: row.client_id,
    clientSecret: await unseal<string>(
      row.secret_sealed,
      env.TOKEN_ENCRYPTION_KEY,
      sealContext(provider),
    ),
    name: row.name,
    slug: row.slug,
    url: row.url,
    accountId: row.account_id,
    scopes: (row.scopes ?? '').split(' ').filter(Boolean),
  };
}

async function store(
  env: Env,
  provider: Provider,
  app: Omit<ProviderApp, 'source'>,
) {
  await env.DB.prepare(
    'INSERT INTO provider_apps(provider,client_id,secret_sealed,name,slug,url,account_id,scopes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET client_id=excluded.client_id,secret_sealed=excluded.secret_sealed,name=excluded.name,slug=excluded.slug,url=excluded.url,account_id=excluded.account_id,scopes=excluded.scopes,updated_at=excluded.updated_at',
  )
    .bind(
      provider,
      app.clientId,
      await seal(
        app.clientSecret,
        env.TOKEN_ENCRYPTION_KEY,
        sealContext(provider),
      ),
      app.name,
      app.slug,
      app.url,
      app.accountId,
      app.scopes.length ? app.scopes.join(' ') : null,
      now(),
      now(),
    )
    .run();
}

// Setup decides how everyone signs in, so it's only for a local Shipcel on this computer;
// a hosted Shipcel is configured through its environment.
function local(c: Context<AppEnv>) {
  if (!localMode(c.env, c.req.raw))
    throw new AppError(
      404,
      'A hosted Shipcel is set up through its environment. See docs/provider-setup.md.',
    );
}
function writable(c: Context<AppEnv>, provider: Provider) {
  local(c);
  if (!encryptionReady(c.env.TOKEN_ENCRYPTION_KEY))
    throw new AppError(
      409,
      'Add TOKEN_ENCRYPTION_KEY to .dev.vars first (`npm run dev` creates one), then restart Shipcel.',
    );
  if (fromEnv(c.env, provider))
    throw new AppError(
      409,
      `${label[provider]} is set up in .dev.vars, which takes precedence. Remove it there to set it up here.`,
    );
}

setup.get('/setup', async (c) => {
  local(c);
  const origin = appOrigin(c.env, c.req.raw);
  const describe = async (provider: Provider) => {
    // A secret sealed with another key can't be read: set it up again.
    const app = await providerApp(c.env, provider).catch(() => null);
    return {
      configured: Boolean(app),
      source: app?.source ?? null,
      name: app?.name ?? null,
      url: app?.url ?? null,
      accountId: app?.accountId ?? null,
      scopes: app?.scopes ?? [],
    };
  };
  const cloudflareApp = await providerApp(c.env, 'cloudflare').catch(
    () => null,
  );
  return c.json({
    available: true,
    encryption: encryptionReady(c.env.TOKEN_ENCRYPTION_KEY),
    origin,
    github: {
      ...(await describe('github')),
      callbackUrl: `${origin}/api/auth/github/callback`,
    },
    cloudflare: {
      ...(await describe('cloudflare')),
      redirectUrl: `${origin}/api/auth/cloudflare/callback`,
      outdated: cloudflareApp ? outdatedScopes(cloudflareApp.scopes) : [],
    },
  });
});

setup.delete('/setup/:provider', async (c) => {
  local(c);
  const provider = z
    .enum(['github', 'cloudflare'])
    .parse(c.req.param('provider'));
  if (fromEnv(c.env, provider))
    throw new AppError(
      409,
      `${label[provider]} is set up in .dev.vars; remove it there.`,
    );
  await c.env.DB.prepare('DELETE FROM provider_apps WHERE provider=?')
    .bind(provider)
    .run();
  return c.json({ removed: true });
});

// GitHub: an app manifest the browser posts to GitHub. The person checks it and creates the
// app there; GitHub sends them back with a code Shipcel exchanges for the app's credentials.
// The browser that started it must finish it, within GitHub's hour.
const setupCookie = (c: Context<AppEnv>) =>
  `${new URL(c.req.url).protocol === 'https:' ? '__Host-' : ''}cloudcel_setup_github`;
const githubOwner = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

setup.post('/setup/github', async (c) => {
  writable(c, 'github');
  const input = z
    .object({ organization: githubOwner.optional() })
    .strict()
    .parse(await c.req.json().catch(() => ({})));
  const state = randomToken(),
    browser = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO oauth_states(state_hash,provider,browser_hash,verifier,expires_at) VALUES (?,'github-setup',?,'',?)",
  )
    .bind(await digest(state), await digest(browser), now() + 3600)
    .run();
  setCookie(c, setupCookie(c), browser, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 3600,
  });
  const origin = appOrigin(c.env, c.req.raw);
  const action = new URL(
    input.organization
      ? `https://github.com/organizations/${input.organization}/settings/apps/new`
      : 'https://github.com/settings/apps/new',
  );
  action.searchParams.set('state', state);
  // GitHub App names are unique on GitHub, so this one ends in a random suffix.
  const suffix = Array.from(
    crypto.getRandomValues(new Uint8Array(6)),
    (byte) => alphabet[byte % alphabet.length],
  ).join('');
  return c.json({
    action: action.toString(),
    manifest: githubManifest(
      origin,
      `${origin}/api/setup/github/created`,
      `Shipcel ${suffix}`,
    ),
  });
});

setup.get('/setup/github/created', async (c) => {
  local(c);
  const state = c.req.query('state') ?? '';
  const browser = getCookie(c, setupCookie(c));
  deleteCookie(c, setupCookie(c), { path: '/' });
  const flow =
    browser && state.length <= 100
      ? await c.env.DB.prepare(
          "DELETE FROM oauth_states WHERE state_hash=? AND provider='github-setup' AND browser_hash=? AND expires_at>? RETURNING state_hash",
        )
          .bind(await digest(state), await digest(browser), now())
          .first()
      : null;
  if (c.req.query('error'))
    return c.redirect('/app/?setup=cancelled#connections');
  if (!flow)
    throw new AppError(
      400,
      'This GitHub App setup expired or was started in another browser. Start again from Connections.',
    );
  const code = z
    .string()
    .regex(/^[\w-]{1,100}$/)
    .parse(c.req.query('code'));
  writable(c, 'github');
  try {
    const created = z
      .object({
        slug: z.string().regex(/^[\w-]{1,100}$/),
        name: z.string().min(1).max(200),
        html_url: z.string().regex(/^https:\/\/github\.com\/[\w./-]+$/),
        client_id: z.string().min(1).max(200),
        client_secret: z.string().min(1).max(500),
      })
      .parse(
        await providerJSON(
          `https://api.github.com/app-manifests/${code}/conversions`,
          {
            method: 'POST',
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'Shipcel',
            },
          },
        ),
      );
    // Shipcel signs people in with the app's client; its private key and webhook secret
    // aren't needed, so they're not kept.
    await store(c.env, 'github', {
      clientId: created.client_id,
      clientSecret: created.client_secret,
      name: created.name,
      slug: created.slug,
      url: created.html_url,
      accountId: null,
      scopes: [],
    });
  } catch {
    return c.redirect('/app/?setup=failed#connections');
  }
  return c.redirect('/app/?setup=github#connections');
});

// Cloudflare: Shipcel creates a private OAuth client with a temporary API token that has the
// OAuth Client Write permission, asking for the scopes in shared/provider-setup.ts.
const setupToken = z
  .string()
  .trim()
  .min(20)
  .max(200)
  .regex(/^[\w.-]+$/);
const accountId = z.string().regex(/^[a-f0-9]{32}$/);

async function inspectToken(token: string) {
  const accounts = z
    .array(z.object({ id: accountId, name: z.string().max(200) }))
    .parse(
      await cloudflare(
        token,
        '/accounts?per_page=50',
        {},
        { errorDetail: true },
      ),
    )
    .map(({ id, name }) => ({ id, name }));
  const available: { id: string; name: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const { result, info } = await cloudflarePage<unknown>(
      token,
      `/oauth/scopes?per_page=100&page=${page}`,
    );
    const list = z
      .array(z.object({ id: z.string().max(200), name: z.string().max(200) }))
      .parse(result);
    available.push(...list.map(({ id, name }) => ({ id, name })));
    if (!list.length || available.length >= Number(info.total_count ?? 0))
      break;
  }
  return { accounts, ...pickScopes(available) };
}

setup.post('/setup/cloudflare/inspect', async (c) => {
  writable(c, 'cloudflare');
  const { token } = z
    .object({ token: setupToken })
    .strict()
    .parse(await c.req.json());
  return c.json(await inspectToken(token));
});

// Scopes every deploy needs that a client set up earlier may lack: Workers Scripts Write,
// where older setups took Workers Editor, which can't create Workers.
export function outdatedScopes(scopes: string[]) {
  const write = wantedScopes
    .find((w) => w.label === 'Workers Scripts Write')!
    .names.map(normalize);
  return scopes.some((s) => write.includes(normalize(s)))
    ? []
    : ['Workers Scripts Write'];
}
const notReady =
  'Cloudflare doesn’t offer Account Read to OAuth clients for this account, and Shipcel needs it to list your accounts. Create the client by hand instead.';

// Creates a private OAuth client for this Shipcel in the account and stores it.
async function createClient(
  c: Context<AppEnv>,
  token: string,
  account: string,
  scopes: { id: string }[],
) {
  const origin = appOrigin(c.env, c.req.raw);
  const create = (refresh: boolean) =>
    cloudflare<unknown>(
      token,
      `/accounts/${account}/oauth_clients`,
      {
        method: 'POST',
        body: JSON.stringify({
          client_name: 'Shipcel local',
          redirect_uris: [`${origin}/api/auth/cloudflare/callback`],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
          scopes: [
            ...scopes.map((s) => s.id),
            ...(refresh ? ['offline_access'] : []),
          ],
        }),
      },
      { errorDetail: true },
    );
  // offline_access gives refresh tokens. If Cloudflare won't allow it, connections last until
  // the access token expires and then ask to reconnect.
  let refreshTokens = true,
    created: unknown;
  try {
    created = await create(true);
  } catch (error) {
    if (!(error instanceof AppError && /offline_access/i.test(error.message)))
      throw error;
    refreshTokens = false;
    created = await create(false);
  }
  const client = z
    .object({
      client_id: z.string().min(1).max(200),
      client_secret: z.string().min(1).max(500),
    })
    .parse(created);
  const granted = [
    ...scopes.map((s) => s.id),
    ...(refreshTokens ? ['offline_access'] : []),
  ];
  await store(c.env, 'cloudflare', {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    name: 'Shipcel local',
    slug: null,
    url: null,
    accountId: account,
    scopes: granted,
  });
  return { refreshTokens, granted };
}

setup.post('/setup/cloudflare/create', async (c) => {
  writable(c, 'cloudflare');
  const input = z
    .object({ token: setupToken, accountId })
    .strict()
    .parse(await c.req.json());
  const { accounts, scopes, ready } = await inspectToken(input.token);
  if (!accounts.some((a) => a.id === input.accountId))
    throw new AppError(400, 'This token can’t reach that account.');
  if (!ready) throw new AppError(409, notReady);
  const { refreshTokens, granted } = await createClient(
    c,
    input.token,
    input.accountId,
    scopes,
  );
  return c.json({ configured: true, refreshTokens, scopes: granted });
});

// Brings a client set up earlier up to date (see outdatedScopes): changed in place when
// Cloudflare allows it, otherwise replaced by a new client. Either way connections were
// granted the old scopes, so each one is asked for again.
setup.post('/setup/cloudflare/update', async (c) => {
  writable(c, 'cloudflare');
  const { token } = z
    .object({ token: setupToken })
    .strict()
    .parse(await c.req.json());
  const current = await providerApp(c.env, 'cloudflare');
  if (!current?.accountId)
    throw new AppError(409, 'Set up Cloudflare sign-in first.');
  const { accounts, scopes, ready } = await inspectToken(token);
  if (!accounts.some((a) => a.id === current.accountId))
    throw new AppError(
      400,
      'This token can’t reach the account that owns Shipcel’s OAuth client.',
    );
  if (!ready) throw new AppError(409, notReady);
  const wanted = [
    ...scopes.map((s) => s.id),
    ...(current.scopes.includes('offline_access') ? ['offline_access'] : []),
  ];
  let updated: 'in place' | 'replaced' = 'in place';
  try {
    await cloudflare(
      token,
      `/accounts/${current.accountId}/oauth_clients/${current.clientId}`,
      { method: 'PATCH', body: JSON.stringify({ scopes: wanted }) },
      { errorDetail: true },
    );
    await store(c.env, 'cloudflare', {
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      name: current.name,
      slug: current.slug,
      url: current.url,
      accountId: current.accountId,
      scopes: wanted,
    });
  } catch (error) {
    // Refused or gone: a token that can't change clients can't create one either.
    if (!(error instanceof AppError) || ![404, 502].includes(error.status))
      throw error;
    await createClient(c, token, current.accountId, scopes);
    updated = 'replaced';
  }
  await c.env.DB.prepare(
    "UPDATE provider_grants SET status='reconnect_required', encrypted_tokens=NULL, refresh_lock_until=0 WHERE provider='cloudflare' AND status='active'",
  ).run();
  return c.json({ updated, reconnect: true });
});

// A client created by hand in Cloudflare's dashboard.
setup.put('/setup/cloudflare', async (c) => {
  writable(c, 'cloudflare');
  const input = z
    .object({
      clientId: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[\w.-]+$/),
      clientSecret: z.string().trim().min(1).max(500),
      scopes: z.string().trim().min(1).max(4000),
    })
    .strict()
    .parse(await c.req.json());
  const scopes = input.scopes.split(/[\s,]+/).filter(Boolean);
  if (!scopes.every((scope) => /^[\w.:-]{1,100}$/.test(scope)))
    throw new AppError(
      400,
      'Use Cloudflare’s scope names, separated by spaces.',
    );
  await store(c.env, 'cloudflare', {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    name: null,
    slug: null,
    url: null,
    accountId: null,
    scopes,
  });
  return c.json({ configured: true, scopes });
});
