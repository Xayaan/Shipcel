import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { database } from './helpers/database';
import type { Env } from '../worker/types';
import app from '../worker/index';

// Connections → set up GitHub and Cloudflare sign-in from the dashboard, in local mode only.
// GitHub: an app manifest the person confirms on GitHub. Cloudflare: a temporary API token
// Shipcel uses once to create an OAuth client. Both are stored encrypted, never shown again.
let db: ReturnType<typeof database>;
let env: Env;
const origin = 'http://127.0.0.1:5173';
const calls: {
  url: string;
  method: string;
  body: string;
  headers: Headers;
}[] = [];
let scopeList: { id: string; name: string }[];
let accounts: { id: string; name: string }[];
let rejectOffline: boolean;
let refusePatch: boolean;
const account = 'a'.repeat(32);
const local = (path: string, init: RequestInit = {}, cookie = '') => {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return app.request(`${origin}/api${path}`, { ...init, headers }, env);
};
const json = (body: unknown) => ({
  method: 'POST',
  body: JSON.stringify(body),
});
const everything = () =>
  JSON.stringify(
    db.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map(({ name }) =>
        db.sqlite.prepare(`SELECT * FROM "${name as string}"`).all(),
      ),
  );

beforeEach(() => {
  db = database();
  // Local mode with no provider configuration in the environment.
  env = {
    ...db.env,
    AUTH_MODE: 'local',
    APP_ORIGIN: origin,
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    GITHUB_APP_SLUG: undefined,
    CLOUDFLARE_CLIENT_ID: undefined,
    CLOUDFLARE_CLIENT_SECRET: undefined,
    CLOUDFLARE_OAUTH_SCOPES: undefined,
  };
  calls.length = 0;
  rejectOffline = false;
  refusePatch = false;
  accounts = [{ id: account, name: 'Ada’s account' }];
  scopeList = [
    { id: 'account.read', name: 'Account Read' },
    { id: 'user.read', name: 'User Details Read' },
    { id: 'workers_scripts.write', name: 'Workers Scripts Write' },
    { id: 'workers_ci.write', name: 'Workers CI Write' },
    { id: 'd1.write', name: 'D1 Write' },
    { id: 'workers_kv.write', name: 'Workers KV Storage Write' },
    { id: 'workers_r2.write', name: 'Workers R2 Storage Write' },
    { id: 'account_analytics.read', name: 'Account Analytics Read' },
    { id: 'dns.write', name: 'DNS Write' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method || 'GET';
      calls.push({
        url,
        method,
        body:
          typeof init.body === 'string' ? init.body : String(init.body ?? ''),
        headers: new Headers(init.headers),
      });
      if (
        url === 'https://api.github.com/app-manifests/manifest-code/conversions'
      )
        return Response.json(
          {
            id: 4242,
            slug: 'cloudcel-local-ada',
            name: 'Shipcel local ada',
            html_url: 'https://github.com/apps/cloudcel-local-ada',
            owner: { login: 'ada' },
            client_id: 'Iv23-github-client',
            client_secret: 'github-app-secret-value',
            webhook_secret: 'webhook-secret-value',
            pem: '-----BEGIN RSA PRIVATE KEY-----private-key-----END RSA PRIVATE KEY-----',
          },
          { status: 201 },
        );
      const api = 'https://api.cloudflare.com/client/v4';
      if (url.startsWith(`${api}/accounts?`))
        return Response.json({ success: true, result: accounts });
      if (url.startsWith(`${api}/oauth/scopes`)) {
        const page = Number(new URL(url).searchParams.get('page') ?? 1);
        const perPage = Number(new URL(url).searchParams.get('per_page'));
        return Response.json({
          success: true,
          result: scopeList.slice((page - 1) * perPage, page * perPage),
          result_info: {
            page,
            per_page: perPage,
            total_count: scopeList.length,
          },
        });
      }
      if (
        url === `${api}/accounts/${account}/oauth_clients/cf-client-id` &&
        method === 'PATCH'
      )
        return refusePatch
          ? Response.json(
              {
                success: false,
                errors: [{ code: 1001, message: 'scopes cannot be changed' }],
              },
              { status: 400 },
            )
          : Response.json({
              success: true,
              result: {
                client_id: 'cf-client-id',
                ...JSON.parse(String(init.body)),
              },
            });
      if (url === `${api}/accounts/${account}/oauth_clients`) {
        const body = JSON.parse(String(init.body));
        if (rejectOffline && body.scopes.includes('offline_access'))
          return Response.json(
            {
              success: false,
              errors: [
                { code: 1000, message: 'invalid scope: offline_access' },
              ],
            },
            { status: 400 },
          );
        return Response.json({
          success: true,
          result: {
            client_id: 'cf-client-id',
            client_secret: 'cf-client-secret-value',
            ...body,
          },
        });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('where setup is offered', () => {
  it('is only in local mode, never for hosted Shipcel or API tokens', async () => {
    expect(await (await local('/setup')).json()).toMatchObject({
      available: true,
      encryption: true,
      github: {
        configured: false,
        callbackUrl: `${origin}/api/auth/github/callback`,
      },
      cloudflare: {
        configured: false,
        redirectUrl: `${origin}/api/auth/cloudflare/callback`,
      },
    });
    // Hosted Shipcel (AUTH_MODE=github) is configured by its operator, never from a browser.
    const who = await db.user(1);
    expect((await db.request('/setup', {}, who.cookie)).status).toBe(404);
    expect(
      (await db.request('/setup/github', json({}), who.cookie)).status,
    ).toBe(404);
    // API tokens can't reach it either.
    const token = (
      (await (
        await db.request(
          '/tokens',
          { method: 'POST', body: JSON.stringify({ name: 'Agent' }) },
          who.cookie,
        )
      ).json()) as { token: string }
    ).token;
    for (const [method, path] of [
      ['GET', '/setup'],
      ['PUT', '/setup/cloudflare'],
    ])
      expect(
        (
          await app.request(
            `${origin}/api${path}`,
            {
              method,
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              ...(method === 'GET' ? {} : { body: '{}' }),
            },
            env,
          )
        ).status,
        `${method} ${path}`,
      ).toBe(403);
  });

  it('needs the local encryption key before storing anything', async () => {
    env.TOKEN_ENCRYPTION_KEY = undefined;
    expect(await (await local('/setup')).json()).toMatchObject({
      encryption: false,
    });
    const refused = await local('/setup/github', json({}));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'TOKEN_ENCRYPTION_KEY',
    );
    // Without the key no tokens can be kept, so sign-in counts as not set up at all.
    env.GITHUB_CLIENT_ID = 'env-client';
    env.GITHUB_CLIENT_SECRET = 'env-secret';
    env.GITHUB_APP_SLUG = 'env-app';
    expect(await (await local('/auth/session')).json()).toMatchObject({
      githubConfigured: false,
    });
    expect((await local('/auth/github/start')).status).toBe(503);
  });

  it('leaves configuration from .dev.vars alone', async () => {
    env.GITHUB_CLIENT_ID = 'env-client';
    env.GITHUB_CLIENT_SECRET = 'env-secret';
    env.GITHUB_APP_SLUG = 'env-app';
    expect(await (await local('/setup')).json()).toMatchObject({
      github: { configured: true, source: 'env' },
    });
    expect((await local('/setup/github', json({}))).status).toBe(409);
    expect((await local('/setup/github', { method: 'DELETE' })).status).toBe(
      409,
    );
  });
});

describe('GitHub', () => {
  async function created() {
    const start = await local('/setup/github', json({}));
    const cookie = start.headers.get('Set-Cookie')!.split(';')[0];
    const { action, manifest } = (await start.json()) as {
      action: string;
      manifest: Record<string, unknown>;
    };
    return { start, cookie, action, manifest };
  }

  it('creates a private GitHub App from a manifest the person confirms on GitHub', async () => {
    const { cookie, action, manifest } = await created();
    const url = new URL(action);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/settings/apps/new',
    );
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[\w-]{20,}$/);
    expect(manifest).toMatchObject({
      url: origin,
      redirect_url: `${origin}/api/setup/github/created`,
      callback_urls: [`${origin}/api/auth/github/callback`],
      setup_url: `${origin}/api/auth/github/installed`,
      setup_on_update: true,
      request_oauth_on_install: false,
      public: false,
      // Shipcel adds its deploy workflow to the repositories chosen.
      default_permissions: {
        contents: 'write',
        metadata: 'read',
        workflows: 'write',
      },
    });
    expect(manifest.name).toMatch(/^Shipcel [a-z0-9]{6}$/);
    // No webhook: GitHub Actions runs the deploy workflow on every push.
    expect(manifest).not.toHaveProperty('hook_attributes');
    const back = await local(
      `/setup/github/created?code=manifest-code&state=${state}`,
      {},
      cookie,
    );
    expect(back.status).toBe(302);
    expect(back.headers.get('Location')).toBe('/app/?setup=github#connections');
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/app-manifests/manifest-code/conversions',
    });
    expect(await (await local('/setup')).json()).toMatchObject({
      github: {
        configured: true,
        source: 'setup',
        name: 'Shipcel local ada',
        url: 'https://github.com/apps/cloudcel-local-ada',
      },
    });
    expect(await (await local('/connections')).json()).toMatchObject({
      github: {
        configured: true,
        installUrl:
          'https://github.com/apps/cloudcel-local-ada/installations/new',
      },
    });
    // Sign-in uses it at once, without a restart.
    const signIn = await local('/auth/github/start');
    expect(signIn.status).toBe(302);
    expect(
      new URL(signIn.headers.get('Location')!).searchParams.get('client_id'),
    ).toBe('Iv23-github-client');
    // The secret is stored encrypted; the private key and webhook secret aren't kept.
    const stored = everything();
    expect(stored).not.toContain('github-app-secret-value');
    expect(stored).not.toContain('PRIVATE KEY');
    expect(stored).not.toContain('webhook-secret-value');
    expect(JSON.stringify(await (await local('/setup')).json())).not.toContain(
      'secret-value',
    );
  });

  it('uses the stored secret when GitHub sign-in completes', async () => {
    const { cookie, action } = await created();
    const state = new URL(action).searchParams.get('state')!;
    await local(
      `/setup/github/created?code=manifest-code&state=${state}`,
      {},
      cookie,
    );
    const start = await local('/auth/github/start');
    const browser = start.headers.get('Set-Cookie')!.split(';')[0];
    const signInState = new URL(
      start.headers.get('Location')!,
    ).searchParams.get('state')!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({
          url,
          method: init.method || 'GET',
          body: String(init.body ?? ''),
          headers: new Headers(init.headers),
        });
        if (url === 'https://github.com/login/oauth/access_token')
          return Response.json({ access_token: 'github-user-token' });
        if (url === 'https://api.github.com/user')
          return Response.json({ id: 7, login: 'ada' });
        throw new Error(`Unexpected ${url}`);
      }),
    );
    const callback = await local(
      `/auth/github/callback?state=${signInState}&code=sign-in-code`,
      {},
      browser,
    );
    expect(callback.status).toBe(302);
    const exchange = new URLSearchParams(
      calls.find((c) => c.url.endsWith('/access_token'))!.body,
    );
    expect(exchange.get('client_id')).toBe('Iv23-github-client');
    expect(exchange.get('client_secret')).toBe('github-app-secret-value');
  });

  it('can create the app in an organization', async () => {
    const start = await local('/setup/github', json({ organization: 'acme' }));
    const { action } = (await start.json()) as { action: string };
    expect(new URL(action).pathname).toBe(
      '/organizations/acme/settings/apps/new',
    );
    expect(
      (await local('/setup/github', json({ organization: 'bad/org' }))).status,
    ).toBe(400);
  });

  it('accepts GitHub’s answer only in the browser that started, once', async () => {
    const { cookie, action } = await created();
    const state = new URL(action).searchParams.get('state')!;
    const path = `/setup/github/created?code=manifest-code&state=${state}`;
    expect((await local(path)).status).toBe(400);
    expect(
      (await local(path, {}, 'cloudcel_setup_github=another-browser')).status,
    ).toBe(400);
    expect(
      (
        await local(
          `/setup/github/created?code=manifest-code&state=other`,
          {},
          cookie,
        )
      ).status,
    ).toBe(400);
    expect((await local(path, {}, cookie)).status).toBe(302);
    expect((await local(path, {}, cookie)).status).toBe(400);
    expect(calls.filter((c) => c.url.includes('/conversions'))).toHaveLength(1);
  });

  it('refuses an expired setup, and says so when GitHub won’t convert the code', async () => {
    const first = await created();
    const firstState = new URL(first.action).searchParams.get('state')!;
    db.sqlite.prepare('UPDATE oauth_states SET expires_at=0').run();
    expect(
      (
        await local(
          `/setup/github/created?code=manifest-code&state=${firstState}`,
          {},
          first.cookie,
        )
      ).status,
    ).toBe(400);
    const second = await created();
    const state = new URL(second.action).searchParams.get('state')!;
    const failed = await local(
      `/setup/github/created?code=expired-code&state=${state}`,
      {},
      second.cookie,
    );
    expect(failed.headers.get('Location')).toBe(
      '/app/?setup=failed#connections',
    );
    expect(await (await local('/setup')).json()).toMatchObject({
      github: { configured: false },
    });
  });

  it('accepts the browser coming back from GitHub, a cross-site visit, only there', async () => {
    const { cookie, action } = await created();
    const state = new URL(action).searchParams.get('state')!;
    const crossSite = { 'Sec-Fetch-Site': 'cross-site' };
    expect(
      (
        await local(
          `/setup/github/created?code=manifest-code&state=${state}`,
          { headers: crossSite },
          cookie,
        )
      ).status,
    ).toBe(302);
    expect((await local('/setup', { headers: crossSite })).status).toBe(403);
  });

  it('goes back to Connections when the person cancels on GitHub', async () => {
    const { cookie, action } = await created();
    const state = new URL(action).searchParams.get('state')!;
    const back = await local(
      `/setup/github/created?error=access_denied&state=${state}`,
      {},
      cookie,
    );
    expect(back.headers.get('Location')).toBe(
      '/app/?setup=cancelled#connections',
    );
    expect(calls).toEqual([]);
  });

  it('can be removed and set up again', async () => {
    const { cookie, action } = await created();
    const state = new URL(action).searchParams.get('state')!;
    await local(
      `/setup/github/created?code=manifest-code&state=${state}`,
      {},
      cookie,
    );
    expect((await local('/setup/github', { method: 'DELETE' })).status).toBe(
      200,
    );
    expect(await (await local('/setup')).json()).toMatchObject({
      github: { configured: false, source: null },
    });
  });
});

describe('Cloudflare', () => {
  const token = 'temporary-setup-token-value';

  it('checks a temporary token and shows what it will create', async () => {
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as {
      accounts: { id: string; name: string }[];
      scopes: { id: string; name: string }[];
      missing: string[];
    };
    expect(preview.accounts).toEqual(accounts);
    expect(preview.scopes.map((s) => s.id)).toEqual([
      'account.read',
      'workers_scripts.write',
      'workers_ci.write',
      'd1.write',
      'workers_kv.write',
      'workers_r2.write',
      'account_analytics.read',
      'dns.write',
    ]);
    expect(preview.missing.length).toBeGreaterThan(0);
    for (const call of calls)
      expect(call.headers.get('Authorization')).toBe(`Bearer ${token}`);
  });

  it('matches scopes by ID when Cloudflare names them differently', async () => {
    scopeList = [
      { id: 'account.read', name: 'Read your account' },
      { id: 'd1.write', name: 'Edit D1 databases' },
    ];
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as { scopes: { id: string }[]; ready: boolean };
    expect(preview.scopes.map((s) => s.id)).toEqual([
      'account.read',
      'd1.write',
    ]);
    expect(preview.ready).toBe(true);
  });

  it('recognises the scope IDs Cloudflare listed for a real account, whatever their names', async () => {
    // Cloudflare's scope list on 8 Oct 2026 (names checked with a live grant).
    const seen = [
      'account-settings.read',
      'workers-scripts.write',
      'workers-ci.write',
      'd1.write',
      'workers-kv-storage.write',
      'workers-r2.write',
      'account-analytics.read',
      'workers-observability.write',
      'zone.read',
      'workers-routes.write',
      'dns.write',
      'access.write',
      'access-acct.write',
    ];
    scopeList = [
      // Workers Editor updates existing Workers; only Workers Scripts Write creates them.
      { id: 'workers-scripts.edit', name: 'Workers Editor' },
      ...seen.map((id, i) => ({
        id,
        name:
          id === 'workers-scripts.write'
            ? 'Workers Scripts Write'
            : `Permission ${i}`,
      })),
    ];
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as { scopes: { id: string }[]; missing: string[] };
    expect(preview.scopes.map((s) => s.id)).toEqual(seen);
    // Asked for since 14 Oct 2026 for the budget guard, and optional: without it the guard
    // estimates as if the account were on Workers Paid.
    // Optional ones the account's list didn't have: setup still goes ahead.
    expect(preview.missing).toEqual([
      'Hyperdrive Write',
      'Billing Read',
      'Cache Purge',
      'Zone WAF Write',
      'Bot Management Write',
      'Zone Settings Write',
    ]);
  });

  it('asks for the Security tab’s permissions when Cloudflare offers them, by name or ID', async () => {
    scopeList = [
      { id: 'account-settings.read', name: 'Account Settings Read' },
      { id: 'zone-waf.write', name: 'Permission 1' },
      { id: 'bot-management.edit', name: 'Bot Management Edit' },
      { id: 'zone-settings.write', name: 'Zone Settings Write' },
    ];
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as { scopes: { id: string }[]; missing: string[] };
    expect(preview.scopes.map((s) => s.id)).toEqual([
      'account-settings.read',
      'zone-waf.write',
      'bot-management.edit',
      'zone-settings.write',
    ]);
    for (const label of [
      'Zone WAF Write',
      'Bot Management Write',
      'Zone Settings Write',
    ])
      expect(preview.missing).not.toContain(label);
  });

  it('asks for Billing Read, for the budget guard, when Cloudflare offers it', async () => {
    scopeList = [
      { id: 'account-settings.read', name: 'Account Settings Read' },
      { id: 'billing.read', name: 'Billing Read' },
    ];
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as {
      scopes: { id: string }[];
      missing: string[];
      ready: boolean;
    };
    expect(preview.scopes.map((s) => s.id)).toEqual([
      'account-settings.read',
      'billing.read',
    ]);
    expect(preview.missing).not.toContain('Billing Read');
    expect(preview.ready).toBe(true);
  });

  it('prefers the scope it names first, whatever order Cloudflare lists them in', async () => {
    scopeList = [
      { id: 'account.read', name: 'Account Read' },
      { id: 'd1.edit', name: 'D1 Edit' },
      { id: 'd1.write', name: 'D1 Write' },
    ];
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as { scopes: { id: string }[] };
    expect(preview.scopes.map((s) => s.id)).toEqual([
      'account.read',
      'd1.write',
    ]);
  });

  it('never takes Workers Editor for Workers Scripts Write, since it can’t create Workers', async () => {
    scopeList = [
      { id: 'account-settings.read', name: 'Account Settings Read' },
      { id: 'workers-scripts.edit', name: 'Workers Editor' },
    ];
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as { scopes: { id: string }[]; missing: string[] };
    expect(preview.scopes.map((s) => s.id)).toEqual(['account-settings.read']);
    expect(preview.missing).toContain('Workers Scripts Write');
  });

  it('says when the client can’t create Workers, and updates it in place', async () => {
    // A client set up before the fix: Workers Editor only.
    scopeList = [
      { id: 'account-settings.read', name: 'Account Settings Read' },
      { id: 'workers-scripts.edit', name: 'Workers Editor' },
    ];
    await local(
      '/setup/cloudflare/create',
      json({ token, accountId: account }),
    );
    expect(
      (
        (await (await local('/setup')).json()) as {
          cloudflare: { outdated: string[] };
        }
      ).cloudflare.outdated,
    ).toEqual(['Workers Scripts Write']);
    const who = await db.user(1);
    await db.grant(who, 'cloudflare');
    scopeList.push({
      id: 'workers-scripts.write',
      name: 'Workers Scripts Write',
    });
    calls.length = 0;
    const updated = await local('/setup/cloudflare/update', json({ token }));
    expect(await updated.json()).toEqual({
      updated: 'in place',
      reconnect: true,
    });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${account}/oauth_clients/cf-client-id`,
    );
    expect(JSON.parse(patch.body)).toEqual({
      scopes: [
        'account-settings.read',
        'workers-scripts.write',
        'offline_access',
      ],
    });
    const setup = (await (await local('/setup')).json()) as {
      cloudflare: { outdated: string[]; scopes: string[] };
    };
    expect(setup.cloudflare.outdated).toEqual([]);
    expect(setup.cloudflare.scopes).toContain('workers-scripts.write');
    // The connection asks for the new permission again.
    expect(
      db.sqlite
        .prepare(
          "SELECT status FROM provider_grants WHERE provider='cloudflare'",
        )
        .get(),
    ).toEqual({ status: 'reconnect_required' });
    expect(everything()).not.toContain(token);
  });

  it('creates a new client when Cloudflare won’t change the old one', async () => {
    scopeList = [
      { id: 'account-settings.read', name: 'Account Settings Read' },
      { id: 'workers-scripts.edit', name: 'Workers Editor' },
    ];
    await local(
      '/setup/cloudflare/create',
      json({ token, accountId: account }),
    );
    scopeList.push({
      id: 'workers-scripts.write',
      name: 'Workers Scripts Write',
    });
    refusePatch = true;
    calls.length = 0;
    const updated = await local('/setup/cloudflare/update', json({ token }));
    expect(await updated.json()).toEqual({
      updated: 'replaced',
      reconnect: true,
    });
    const created = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/oauth_clients'),
    )!;
    expect(JSON.parse(created.body).scopes).toContain('workers-scripts.write');
    expect(
      (
        (await (await local('/setup')).json()) as {
          cloudflare: { outdated: string[] };
        }
      ).cloudflare.outdated,
    ).toEqual([]);
  });

  it('reports other refusals from Cloudflare without trying again', async () => {
    accounts = [{ id: account, name: 'Ada’s account' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({
          url,
          method: init.method || 'GET',
          body: String(init.body ?? ''),
          headers: new Headers(init.headers),
        });
        const api = 'https://api.cloudflare.com/client/v4';
        if (url.startsWith(`${api}/accounts?`))
          return Response.json({ success: true, result: accounts });
        if (url.startsWith(`${api}/oauth/scopes`))
          return Response.json({
            success: true,
            result: [{ id: 'account.read', name: 'Account Read' }],
            result_info: { total_count: 1 },
          });
        return Response.json(
          {
            success: false,
            errors: [{ code: 1001, message: 'redirect_uris must use https' }],
          },
          { status: 400 },
        );
      }),
    );
    const refused = await local(
      '/setup/cloudflare/create',
      json({ token, accountId: account }),
    );
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toContain(
      'redirect_uris must use https',
    );
    expect(calls.filter((c) => c.url.endsWith('/oauth_clients'))).toHaveLength(
      1,
    );
  });

  it('reads every page of Cloudflare’s scope list', async () => {
    scopeList = [
      ...Array.from({ length: 150 }, (_, i) => ({
        id: `filler_${i}.read`,
        name: `Filler ${i} Read`,
      })),
      { id: 'account.read', name: 'Account Read' },
      { id: 'workers_scripts.write', name: 'Workers Scripts Write' },
    ];
    const preview = (await (
      await local('/setup/cloudflare/inspect', json({ token }))
    ).json()) as { scopes: { id: string }[] };
    expect(preview.scopes.map((s) => s.id)).toEqual([
      'account.read',
      'workers_scripts.write',
    ]);
  });

  it('creates a private OAuth client and keeps only its ID and encrypted secret', async () => {
    const response = await local(
      '/setup/cloudflare/create',
      json({ token, accountId: account }),
    );
    expect(await response.json()).toMatchObject({
      configured: true,
      refreshTokens: true,
    });
    const create = calls.find((c) => c.url.endsWith('/oauth_clients'))!;
    expect(create.method).toBe('POST');
    expect(JSON.parse(create.body)).toEqual({
      client_name: 'Shipcel local',
      redirect_uris: [`${origin}/api/auth/cloudflare/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scopes: [
        'account.read',
        'workers_scripts.write',
        'workers_ci.write',
        'd1.write',
        'workers_kv.write',
        'workers_r2.write',
        'account_analytics.read',
        'dns.write',
        'offline_access',
      ],
    });
    expect(await (await local('/setup')).json()).toMatchObject({
      cloudflare: { configured: true, source: 'setup', accountId: account },
    });
    // Neither the setup token nor the client secret is kept in clear.
    const stored = everything();
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('cf-client-secret-value');
  });

  it('connects with the new client at once', async () => {
    await local(
      '/setup/cloudflare/create',
      json({ token, accountId: account }),
    );
    // Signed in with GitHub; on plain HTTP the session cookie has no __Host- prefix.
    const who = await db.user(1);
    const start = await local(
      '/auth/cloudflare/start',
      {},
      who.cookie.replace('__Host-', ''),
    );
    expect(start.status).toBe(302);
    const url = new URL(start.headers.get('Location')!);
    expect(url.searchParams.get('client_id')).toBe('cf-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${origin}/api/auth/cloudflare/callback`,
    );
    expect(url.searchParams.get('scope')?.split(' ')).toContain(
      'offline_access',
    );
  });

  it('does without refresh tokens when Cloudflare won’t allow offline_access', async () => {
    rejectOffline = true;
    const response = await local(
      '/setup/cloudflare/create',
      json({ token, accountId: account }),
    );
    expect(await response.json()).toMatchObject({
      configured: true,
      refreshTokens: false,
    });
    expect(calls.filter((c) => c.url.endsWith('/oauth_clients'))).toHaveLength(
      2,
    );
    expect(await (await local('/setup')).json()).toMatchObject({
      cloudflare: { scopes: expect.not.arrayContaining(['offline_access']) },
    });
  });

  it('only creates the client in an account the token can see, with Account Read', async () => {
    expect(
      (
        await local(
          '/setup/cloudflare/create',
          json({ token, accountId: 'b'.repeat(32) }),
        )
      ).status,
    ).toBe(400);
    scopeList = scopeList.filter((s) => s.id !== 'account.read');
    const refused = await local(
      '/setup/cloudflare/create',
      json({ token, accountId: account }),
    );
    expect(refused.status).toBe(409);
    expect(calls.some((c) => c.url.endsWith('/oauth_clients'))).toBe(false);
  });

  it('accepts a client created by hand', async () => {
    const saved = await local('/setup/cloudflare', {
      method: 'PUT',
      body: JSON.stringify({
        clientId: 'hand-made-client',
        clientSecret: 'hand-made-secret',
        scopes: 'account.read workers_scripts.write offline_access',
      }),
    });
    expect(saved.status).toBe(200);
    expect(await (await local('/setup')).json()).toMatchObject({
      cloudflare: {
        configured: true,
        source: 'setup',
        scopes: ['account.read', 'workers_scripts.write', 'offline_access'],
      },
    });
    expect(everything()).not.toContain('hand-made-secret');
    for (const bad of [
      { clientId: '', clientSecret: 'x', scopes: 'account.read' },
      { clientId: 'x', clientSecret: 'x', scopes: 'account.read; drop' },
    ])
      expect(
        (
          await local('/setup/cloudflare', {
            method: 'PUT',
            body: JSON.stringify(bad),
          })
        ).status,
      ).toBe(400);
  });
});

describe('the dashboard’s content security policy', () => {
  it('lets the setup form reach GitHub’s app creation pages and nowhere else', () => {
    const policy = readFileSync('public/_headers', 'utf8').match(
      /Content-Security-Policy: (.*)/,
    )![1];
    expect(policy.split('; ').find((d) => d.startsWith('form-action'))).toBe(
      "form-action 'self' https://github.com/settings/apps/new https://github.com/organizations/",
    );
  });
});

describe('npm run setup:check', () => {
  const check = (vars: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'shipcel-setup-check-'));
    try {
      writeFileSync(join(dir, '.dev.vars'), vars);
      try {
        return {
          ok: true,
          output: execFileSync(
            process.execPath,
            [resolve('scripts/check-setup.mjs')],
            { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' },
          ),
        };
      } catch (error) {
        return {
          ok: false,
          output: String((error as { stdout: string }).stdout),
        };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const key = `TOKEN_ENCRYPTION_KEY=${'ab'.repeat(32)}\n`;

  it('accepts a local Shipcel whose sign-in is set up from Connections', () => {
    const result = check(
      `AUTH_MODE=local\nAPP_ORIGIN=http://127.0.0.1:5173\n${key}`,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain(
      'GitHub: not in .dev.vars; set it up from Connections.',
    );
  });

  it('still needs every provider value for a hosted Shipcel, and complete groups anywhere', () => {
    const hosted = check(
      `AUTH_MODE=github\nAPP_ORIGIN=https://shipcel.example\n${key}`,
    );
    expect(hosted.ok).toBe(false);
    expect(hosted.output).toContain('GITHUB_CLIENT_ID: missing');
    expect(hosted.output).toContain('CLOUDFLARE_OAUTH_SCOPES: missing');
    const partial = check(
      `AUTH_MODE=local\nAPP_ORIGIN=http://127.0.0.1:5173\n${key}GITHUB_CLIENT_ID=only-this\n`,
    );
    expect(partial.ok).toBe(false);
    expect(partial.output).toContain('GITHUB_CLIENT_SECRET: missing');
    expect(partial.output).not.toContain('only-this');
  });
});

describe('npm run dev', () => {
  it('gives a fresh checkout its own encryption key, and never touches an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shipcel-dev-env-'));
    try {
      writeFileSync(
        join(dir, '.dev.vars.example'),
        readFileSync('.dev.vars.example', 'utf8'),
      );
      const run = () =>
        execFileSync(process.execPath, [resolve('scripts/dev-env.mjs')], {
          cwd: dir,
          encoding: 'utf8',
        });
      const output = run();
      const created = readFileSync(join(dir, '.dev.vars'), 'utf8');
      const key = created.match(/^TOKEN_ENCRYPTION_KEY=([0-9a-f]{64})$/m)?.[1];
      expect(key).toBeTruthy();
      expect(output).not.toContain(key);
      expect(created).toContain('AUTH_MODE=local');
      writeFileSync(join(dir, '.dev.vars'), 'AUTH_MODE=local\n');
      expect(run()).toBe('');
      expect(readFileSync(join(dir, '.dev.vars'), 'utf8')).toBe(
        'AUTH_MODE=local\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
