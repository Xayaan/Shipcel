import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  serve,
  setupProduction,
  withDatabaseId,
  type SetupDeps,
} from '../scripts/setup-production.mjs';

// npm run production:setup (scripts/setup-production.mjs), with Wrangler, GitHub, Cloudflare,
// the terminal and the browser faked. The page that sends the browser to GitHub is served for
// real on 127.0.0.1, as the script serves it.
const config = readFileSync('wrangler.jsonc', 'utf8');
const ID = '12345678-90ab-cdef-1234-567890abcdef';
const TOKEN = 'temporary-cloudflare-token-0123456789';
const ACCOUNT = 'a'.repeat(32);
const secretsSet = [
  'TOKEN_ENCRYPTION_KEY',
  'GITHUB_CLIENT_SECRET',
  'CLOUDFLARE_CLIENT_SECRET',
];
const production = '--env production --config wrangler.jsonc';
const bulk = `npx wrangler secret bulk ${production}`;

function fake(
  options: {
    args?: string[];
    signedIn?: boolean;
    // What `wrangler whoami --json` prints.
    whoami?: string;
    databases?: { name: string; uuid: string }[];
    secrets?: string[];
    failing?: string;
    offlineAccess?: boolean;
    token?: string;
    // Whether the token lists the account, and the status Cloudflare refuses clients with.
    listsAccounts?: boolean;
    refuseClients?: number;
    // Answers to the questions, in order (then '1'), and to the hidden ones (then the token).
    answers?: string[];
    hidden?: string[];
    config?: string;
    // The scopes Cloudflare offers, and an OAuth client the account already has.
    offered?: { id: string; name: string }[];
    existingClient?: Record<string, unknown>;
  } = {},
) {
  let databases = options.databases ?? [];
  const answers = [...(options.answers ?? [])],
    hidden = [...(options.hidden ?? [])];
  const t = {
    commands: [] as {
      line: string;
      input?: string;
      env?: Record<string, string>;
    }[],
    said: [] as string[],
    pages: [] as string[],
    clients: [] as Record<string, unknown>[],
    patched: [] as Record<string, unknown>[],
    written: null as string | null,
    asked: 0,
    server: '',
  };
  const saved = () =>
    t.commands
      .filter((c) => c.line === bulk)
      .map((c) => JSON.parse(c.input!) as Record<string, string>);
  const ok = (result: unknown, info?: unknown) =>
    Response.json({
      success: true,
      result,
      ...(info ? { result_info: info } : {}),
    });
  const deps: SetupDeps = {
    args: options.args,
    run: async (command, args, opts = {}) => {
      const line = [command, ...args].join(' ');
      t.commands.push({ line, input: opts.input, env: opts.env });
      if (options.failing && line.startsWith(options.failing))
        return { code: 1, stdout: '' };
      if (line === 'npx wrangler whoami --json')
        return {
          code: options.signedIn === false ? 1 : 0,
          stdout: options.whoami ?? '{}',
        };
      if (line === 'npx wrangler login') options.signedIn = true;
      if (line === 'npx wrangler d1 list --json')
        return {
          code: 0,
          // Wrangler may print its banner before the JSON.
          stdout: ` ⛅️ wrangler 4.148.0\n${JSON.stringify(databases)}`,
        };
      if (line === 'npx wrangler d1 create shipcel') {
        databases = [...databases, { name: 'shipcel', uuid: ID }];
        return { code: 0, stdout: 'Created' };
      }
      if (line.startsWith('npx wrangler secret list'))
        return {
          code: 0,
          stdout: JSON.stringify(
            (options.secrets ?? []).map((name) => ({
              name,
              type: 'secret_text',
            })),
          ),
        };
      return { code: 0, stdout: '' };
    },
    ask: async () => answers.shift() ?? '1',
    askSecret: async () => {
      t.asked++;
      return hidden.shift() ?? options.token ?? TOKEN;
    },
    // The browser: it loads the page, which sends it to GitHub, and GitHub sends it back. A
    // visit from another setup is turned away first.
    open: async (url) => {
      t.server = url.replace(/\/$/, '');
      const html = await (await fetch(url)).text();
      t.pages.push(html);
      const state = html.match(/apps\/new\?state=([0-9a-f]+)"/)![1];
      expect(
        (await fetch(`${t.server}/created?code=gh-code&state=other`)).status,
      ).toBe(400);
      expect(
        (await fetch(`${t.server}/created?code=gh-code&state=${state}`)).status,
      ).toBe(200);
    },
    serve,
    fetch: (async (raw: string, init: RequestInit = {}) => {
      const url = new URL(raw);
      if (
        url.href === 'https://api.github.com/app-manifests/gh-code/conversions'
      )
        return Response.json({
          client_id: 'Iv1.github-client',
          client_secret: 'github-client-secret',
          slug: 'shipcel',
          name: 'Shipcel',
          html_url: 'https://github.com/apps/shipcel',
        });
      expect(new Headers(init.headers).get('Authorization')).toBe(
        `Bearer ${options.token ?? TOKEN}`,
      );
      const path = url.pathname.replace('/client/v4', '');
      if (path === '/accounts')
        return ok(
          options.listsAccounts === false
            ? []
            : [{ id: ACCOUNT, name: 'Ada’s account' }],
        );
      if (path === '/oauth/scopes') {
        const offered = options.offered ?? [
          { id: 'account-settings.read', name: 'Account Settings Read' },
          { id: 'workers-scripts.edit', name: 'Workers Editor' },
          { id: 'workers-scripts.write', name: 'Workers Scripts Write' },
        ];
        return ok(offered, { total_count: offered.length });
      }
      if (
        path === `/accounts/${ACCOUNT}/oauth_clients` &&
        (init.method ?? 'GET') === 'GET'
      )
        return ok(options.existingClient ? [options.existingClient] : []);
      if (
        path === `/accounts/${ACCOUNT}/oauth_clients/cf-client` &&
        init.method === 'PATCH'
      ) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        t.patched.push(body);
        return ok({ ...options.existingClient, ...body });
      }
      if (path === `/accounts/${ACCOUNT}/oauth_clients`) {
        const body = JSON.parse(String(init.body));
        t.clients.push(body);
        if (options.refuseClients)
          return Response.json(
            {
              success: false,
              errors: [{ code: 10000, message: 'Authentication error' }],
            },
            { status: options.refuseClients },
          );
        if (
          options.offlineAccess === false &&
          body.scopes.includes('offline_access')
        )
          return Response.json(
            {
              success: false,
              errors: [
                { code: 1000, message: 'scope offline_access is not allowed' },
              ],
            },
            { status: 400 },
          );
        return ok({
          client_id: 'cf-client',
          client_secret: 'cloudflare-client-secret',
        });
      }
      throw new Error(`Unexpected ${init.method ?? 'GET'} ${raw}`);
    }) as typeof globalThis.fetch,
    say: (line) => t.said.push(line),
    random: (bytes) => 'e'.repeat(bytes * 2),
    readConfig: async () => options.config ?? config,
    writeConfig: async (text) => {
      t.written = text;
    },
  };
  return { deps, t, saved };
}

describe('npm run production:setup', () => {
  it('sets up Shipcel at its address: database, migrations, deploy, and secrets only Wrangler sees', async () => {
    const { deps, t, saved } = fake({ signedIn: false });
    await setupProduction(deps);
    expect(t.commands.map((c) => c.line)).toEqual([
      'npx wrangler whoami --json',
      'npx wrangler login',
      'npx wrangler whoami --json',
      'npx wrangler d1 list --json',
      'npx wrangler d1 create shipcel',
      'npx wrangler d1 list --json',
      `npx wrangler d1 migrations apply shipcel --remote ${production}`,
      'npm run build',
      'npx wrangler deploy',
      `npx wrangler secret list ${production} --format json`,
      bulk,
      bulk,
      bulk,
    ]);
    // Built for production, with the database it created.
    expect(t.commands[7].env).toEqual({ CLOUDFLARE_ENV: 'production' });
    expect(t.written).toBe(withDatabaseId(config, ID));
    // The GitHub App: private, read-only, signing people in at shipcel.com, and created on
    // GitHub's page, which sends the browser back to this script.
    const manifest = JSON.parse(
      t.pages[0]
        .match(/name="manifest" value="([^"]*)"/)![1]
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))),
    );
    expect(t.pages[0]).toContain(
      'action="https://github.com/settings/apps/new?state=',
    );
    expect(manifest).toEqual({
      name: 'Shipcel',
      url: 'https://shipcel.com',
      redirect_url: `${t.server}/created`,
      callback_urls: ['https://shipcel.com/api/auth/github/callback'],
      // GitHub brings people back to Shipcel after they choose or change repositories.
      setup_url: 'https://shipcel.com/api/auth/github/installed',
      setup_on_update: true,
      description:
        'Signs you in to your Shipcel and adds its deploy workflow to the repositories you choose.',
      public: false,
      default_permissions: {
        contents: 'write',
        metadata: 'read',
        workflows: 'write',
      },
      request_oauth_on_install: false,
    });
    expect(t.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The page is gone once GitHub has answered.
    await expect(fetch(`${t.server}/`)).rejects.toThrow();
    // The Cloudflare OAuth client: private to the account, for shipcel.com, never Workers
    // Editor, with refresh tokens.
    expect(t.clients).toEqual([
      {
        client_name: 'Shipcel',
        redirect_uris: ['https://shipcel.com/api/auth/cloudflare/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scopes: [
          'account-settings.read',
          'workers-scripts.write',
          'offline_access',
        ],
      },
    ]);
    // Each saved as soon as it's made.
    expect(saved()).toEqual([
      { TOKEN_ENCRYPTION_KEY: 'e'.repeat(64) },
      {
        GITHUB_CLIENT_ID: 'Iv1.github-client',
        GITHUB_CLIENT_SECRET: 'github-client-secret',
        GITHUB_APP_SLUG: 'shipcel',
      },
      {
        CLOUDFLARE_CLIENT_ID: 'cf-client',
        CLOUDFLARE_CLIENT_SECRET: 'cloudflare-client-secret',
        CLOUDFLARE_OAUTH_SCOPES:
          'account-settings.read workers-scripts.write offline_access',
      },
    ]);
    // Nothing secret is printed, and the temporary token is never passed to a command.
    const shown = t.said.join('\n');
    for (const value of [
      'e'.repeat(64),
      'github-client-secret',
      'cloudflare-client-secret',
      TOKEN,
    ])
      expect(shown).not.toContain(value);
    expect(JSON.stringify(t.commands)).not.toContain(TOKEN);
    expect(t.said.at(-1)).toBe(
      'Shipcel is at https://shipcel.com. Open https://shipcel.com/app/, sign in with GitHub, then connect Cloudflare.',
    );
  });

  it('deploys again without asking anything once it is set up', async () => {
    const { deps, t } = fake({
      databases: [
        { name: 'cloudcel-local', uuid: 'f'.repeat(36) },
        { name: 'shipcel', uuid: ID },
      ],
      secrets: secretsSet,
      config: withDatabaseId(config, ID),
    });
    await setupProduction(deps);
    expect(t.commands.map((c) => c.line)).toEqual([
      'npx wrangler whoami --json',
      'npx wrangler d1 list --json',
      `npx wrangler d1 migrations apply shipcel --remote ${production}`,
      'npm run build',
      'npx wrangler deploy',
      `npx wrangler secret list ${production} --format json`,
    ]);
    expect(t.written).toBeNull();
    expect(t.asked).toBe(0);
    expect(t.pages).toEqual([]);
    expect(t.said).toContain('    All there already.');
  });

  it('gives an existing OAuth client the permissions asked for since it was made, with --cloudflare-permissions', async () => {
    const offered = [
      { id: 'account-settings.read', name: 'Account Settings Read' },
      { id: 'workers-scripts.write', name: 'Workers Scripts Write' },
      { id: 'hyperdrive.write', name: 'Hyperdrive Write' },
    ];
    const client = {
      client_id: 'cf-client',
      redirect_uris: ['https://shipcel.com/api/auth/cloudflare/callback'],
      scopes: [
        'account-settings.read',
        'workers-scripts.write',
        'offline_access',
      ],
    };
    const { deps, t, saved } = fake({
      args: ['--cloudflare-permissions'],
      secrets: secretsSet,
      offered,
      existingClient: client,
    });
    await setupProduction(deps);
    // The client is patched without offline_access, which follows its grant types; the
    // secret the Worker asks with keeps it.
    expect(t.patched).toEqual([
      {
        scopes: [
          'account-settings.read',
          'workers-scripts.write',
          'hyperdrive.write',
        ],
      },
    ]);
    expect(saved()).toEqual([
      {
        CLOUDFLARE_OAUTH_SCOPES:
          'account-settings.read workers-scripts.write hyperdrive.write offline_access',
      },
    ]);
    expect(t.said.join('\n')).toContain('Added hyperdrive.write');
    expect(t.asked).toBe(1);
    // Current already: nothing patched, nothing saved.
    const again = fake({
      args: ['--cloudflare-permissions'],
      secrets: secretsSet,
      offered,
      existingClient: {
        ...client,
        scopes: [...client.scopes, 'hyperdrive.write'],
      },
    });
    await setupProduction(again.deps);
    expect(again.t.patched).toEqual([]);
    expect(again.saved()).toEqual([]);
    expect(again.t.said).toContain('    Its permissions are current already.');
  });

  it('stops at a step that fails, so a failed build is never deployed', async () => {
    const { deps, t } = fake({
      databases: [{ name: 'shipcel', uuid: ID }],
      failing: 'npm run build',
    });
    await expect(setupProduction(deps)).rejects.toThrow(
      'The build failed (exit code 1).',
    );
    expect(t.commands.map((c) => c.line)).not.toContain('npx wrangler deploy');
    const migrations = fake({
      databases: [{ name: 'shipcel', uuid: ID }],
      failing: 'npx wrangler d1 migrations',
    });
    await expect(setupProduction(migrations.deps)).rejects.toThrow(
      'Applying the migrations failed',
    );
    expect(migrations.t.commands.map((c) => c.line)).not.toContain(
      'npm run build',
    );
  });

  it('keeps the key and the GitHub App it made when the Cloudflare step fails', async () => {
    const { deps, saved } = fake({
      databases: [{ name: 'shipcel', uuid: ID }],
      token: 'not a token',
    });
    await expect(setupProduction(deps)).rejects.toThrow(
      'That doesn’t look like a Cloudflare API token.',
    );
    expect(saved().map((s) => Object.keys(s))).toEqual([
      ['TOKEN_ENCRYPTION_KEY'],
      ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_SLUG'],
    ]);
  });

  it('uses a GitHub App an earlier run made, with a new client secret', async () => {
    const secret = '0123456789abcdef0123456789abcdef01234567';
    const { deps, t, saved } = fake({
      args: ['--github-app', 'shipcel'],
      databases: [{ name: 'shipcel', uuid: ID }],
      secrets: ['TOKEN_ENCRYPTION_KEY', 'CLOUDFLARE_CLIENT_SECRET'],
      answers: ['Iv23liAbCdEf01234567'],
      hidden: [secret],
    });
    await setupProduction(deps);
    expect(t.pages).toEqual([]);
    expect(saved()).toEqual([
      {
        GITHUB_CLIENT_ID: 'Iv23liAbCdEf01234567',
        GITHUB_CLIENT_SECRET: secret,
        GITHUB_APP_SLUG: 'shipcel',
      },
    ]);
    expect(t.said.join('\n')).toContain(
      'https://github.com/settings/apps/shipcel',
    );
    expect(t.said.join('\n')).not.toContain(secret);
    // Checked before anything runs, and before anything is saved.
    const misnamed = fake({ args: ['--github-app', 'Not an app!'] });
    await expect(setupProduction(misnamed.deps)).rejects.toThrow(
      '--github-app takes the app’s name',
    );
    expect(misnamed.t.commands).toEqual([]);
    const pasted = fake({
      args: ['--github-app', 'shipcel'],
      databases: [{ name: 'shipcel', uuid: ID }],
      secrets: ['TOKEN_ENCRYPTION_KEY'],
      answers: ['Iv23liAbCdEf01234567'],
      hidden: ['not a secret'],
    });
    await expect(setupProduction(pasted.deps)).rejects.toThrow(
      'That doesn’t look like a GitHub client secret.',
    );
    expect(pasted.saved()).toEqual([]);
  });

  it('makes the OAuth client in the account Wrangler deployed to when the token lists none, and says what the token needs', async () => {
    const setUp = {
      databases: [{ name: 'shipcel', uuid: ID }],
      secrets: ['TOKEN_ENCRYPTION_KEY', 'GITHUB_CLIENT_SECRET'],
      listsAccounts: false,
      whoami: ` ⛅️ wrangler 4.148.0\n${JSON.stringify({
        loggedIn: true,
        email: 'ada@example.com',
        accounts: [{ id: ACCOUNT, name: 'Ada’s account' }],
      })}`,
    };
    const { deps, t, saved } = fake(setUp);
    await setupProduction(deps);
    expect(t.clients).toHaveLength(1);
    expect(saved()[0].CLOUDFLARE_CLIENT_ID).toBe('cf-client');
    expect(t.said.join('\n')).toContain('Wrangler deployed to Ada’s account.');
    const refused = fake({ ...setUp, refuseClients: 403 });
    await expect(setupProduction(refused.deps)).rejects.toThrow(
      'Cloudflare refused: Authentication error. The token needs one permission, Account · OAuth Client · Edit (Cloudflare also calls it OAuth Clients Write), with your account included under Account Resources.',
    );
    const nowhere = fake({ ...setUp, whoami: '{}' });
    await expect(setupProduction(nowhere.deps)).rejects.toThrow(
      'That token can’t see a Cloudflare account. The token needs one permission',
    );
  });

  it('does without refresh tokens when Cloudflare won’t give them', async () => {
    const { deps, t, saved } = fake({
      databases: [{ name: 'shipcel', uuid: ID }],
      secrets: ['TOKEN_ENCRYPTION_KEY', 'GITHUB_CLIENT_SECRET'],
      offlineAccess: false,
    });
    await setupProduction(deps);
    expect(t.clients.map((c) => c.scopes)).toEqual([
      ['account-settings.read', 'workers-scripts.write', 'offline_access'],
      ['account-settings.read', 'workers-scripts.write'],
    ]);
    expect(saved()).toEqual([
      {
        CLOUDFLARE_CLIENT_ID: 'cf-client',
        CLOUDFLARE_CLIENT_SECRET: 'cloudflare-client-secret',
        CLOUDFLARE_OAUTH_SCOPES: 'account-settings.read workers-scripts.write',
      },
    ]);
    expect(t.pages).toEqual([]);
  });

  it('writes the database ID into the production environment only', () => {
    const updated = withDatabaseId(config, ID);
    expect(updated).toContain(
      `"database_name": "shipcel",\n          "database_id": "${ID}"`,
    );
    // The local database keeps its placeholder.
    expect(updated).toContain(
      '"database_name": "cloudcel-local",\n      "database_id": "00000000-0000-0000-0000-000000000000"',
    );
    expect(() => withDatabaseId('{}', ID)).toThrow('no production database');
  });
});
