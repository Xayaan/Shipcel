// npm run production:setup: Shipcel at its own address (wrangler.jsonc's production
// environment), in your own Cloudflare account, set up from this terminal. Run it again to
// deploy a newer version. Each step says what it does and skips what is already done:
//   1. Wrangler signs in to Cloudflare (npx wrangler login opens your browser).
//   2. The D1 database `shipcel` is created, and its ID written into wrangler.jsonc.
//   3. Its migrations are applied (Wrangler lists them and asks first).
//   4. A production build (CLOUDFLARE_ENV=production npm run build) is deployed.
//   5. The secrets Shipcel needs go straight to Cloudflare with `wrangler secret bulk`, each
//      as soon as it is made: an encryption key made here, a private GitHub App you confirm on
//      GitHub's own page, and a private Cloudflare OAuth client made with a temporary API token
//      you paste. None is shown or written to disk. `--github-app <slug>` uses a GitHub App
//      made earlier instead, with a new client secret you generate on its page.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { githubManifest, pickScopes } from '../shared/provider-setup.ts';

const CONFIG = 'wrangler.jsonc';
const DATABASE = 'shipcel';
const production = ['--env', 'production', '--config', CONFIG];
// GitHub's manifest code lasts an hour; the browser step gives up after half of that.
const BROWSER_WAIT = 30 * 60_000;

const must = (result, what) => {
  if (result.code !== 0)
    throw new Error(`${what} failed (exit code ${result.code}).`);
  return result;
};
// Wrangler's JSON output, after any line it prints first.
const json = (text) => JSON.parse(text.slice(text.search(/[[{]/)));
const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body) =>
  `<!doctype html><meta charset="utf-8"><title>Shipcel setup</title><body style="font:16px system-ui;margin:3em">${body}</body>`;
// The Cloudflare accounts Wrangler is signed in to (`wrangler whoami --json`); none when its
// answer can't be read.
const accountsOf = (stdout) => {
  try {
    const listed = json(stdout).accounts;
    return Array.isArray(listed)
      ? listed.filter(
          (a) =>
            /^[a-f0-9]{32}$/.test(a?.id ?? '') && typeof a.name === 'string',
        )
      : [];
  } catch {
    return [];
  }
};
const TOKEN_HINT =
  'The token needs one permission, Account · OAuth Client · Edit (Cloudflare also calls it OAuth Clients Write), with your account included under Account Resources.';

// wrangler.jsonc with the production database's ID.
export function withDatabaseId(config, id) {
  const pattern = new RegExp(
    `("database_name":\\s*"${DATABASE}",\\s*"database_id":\\s*")[^"]*(")`,
  );
  if (!pattern.test(config))
    throw new Error(`${CONFIG} has no production database "${DATABASE}".`);
  return config.replace(pattern, `$1${id}$2`);
}

async function database(d) {
  const find = async () =>
    json(
      must(
        await d.run('npx', ['wrangler', 'd1', 'list', '--json'], {
          capture: true,
        }),
        'Listing your D1 databases',
      ).stdout,
    ).find((db) => db.name === DATABASE)?.uuid;
  const found = await find();
  if (found) return found;
  must(
    await d.run('npx', ['wrangler', 'd1', 'create', DATABASE], {
      capture: true,
    }),
    'Creating the database',
  );
  const created = await find();
  if (!/^[0-9a-f-]{36}$/.test(created ?? ''))
    throw new Error('Wrangler created the database but didn’t list it.');
  d.say(`    Created it.`);
  return created;
}

// A private, read-only GitHub App, created on GitHub's own page from a manifest this script
// serves on 127.0.0.1; GitHub sends the browser back with a code for its credentials.
async function githubApp(d, origin) {
  const state = d.random(16);
  let arrived;
  const code = new Promise((resolve, reject) => {
    arrived = resolve;
    setTimeout(
      () =>
        reject(
          new Error(
            'GitHub didn’t come back within 30 minutes. Run npm run production:setup again.',
          ),
        ),
      BROWSER_WAIT,
    ).unref?.();
  });
  let manifest = '';
  const server = await d.serve((path, query) => {
    if (path === '/created') {
      const given = query.get('code') ?? '';
      if (query.get('state') !== state || !/^[\w-]{1,100}$/.test(given))
        return {
          status: 400,
          body: page('This isn’t the setup your terminal started.'),
        };
      arrived(given);
      return {
        status: 200,
        body: page(
          'Shipcel’s GitHub App is created. Close this tab and go back to your terminal.',
        ),
      };
    }
    if (path !== '/') return { status: 404, body: page('Not found.') };
    return {
      status: 200,
      body: page(
        `<form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><button>Create Shipcel’s GitHub App on GitHub</button></form><script>document.forms[0].submit()</script>`,
      ),
    };
  });
  manifest = JSON.stringify(
    githubManifest(origin, `${server.url}/created`, 'Shipcel'),
  );
  try {
    d.say(
      `    Your browser opens GitHub to create Shipcel’s GitHub App: private, reading only the repositories you choose. Check it and click Create GitHub App (rename it if GitHub says the name is taken). If nothing opens, go to ${server.url}/`,
    );
    await d.open(`${server.url}/`);
    const answer = await d.fetch(
      `https://api.github.com/app-manifests/${await code}/conversions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Shipcel',
        },
      },
    );
    const app = await answer.json().catch(() => ({}));
    if (
      !answer.ok ||
      typeof app.client_id !== 'string' ||
      typeof app.client_secret !== 'string' ||
      !/^[\w-]{1,100}$/.test(app.slug ?? '')
    )
      throw new Error(
        `GitHub didn’t hand over the new app (HTTP ${answer.status}).`,
      );
    d.say(`    Created the GitHub App ${app.name} (${app.html_url}).`);
    return {
      GITHUB_CLIENT_ID: app.client_id,
      GITHUB_CLIENT_SECRET: app.client_secret,
      GITHUB_APP_SLUG: app.slug,
    };
  } finally {
    server.close();
  }
}

// A GitHub App made earlier, by a run that stopped before saving it: its client ID, and a new
// client secret generated on its settings page.
async function existingGithubApp(d, slug) {
  d.say(
    `    Using the GitHub App ${slug}. Open https://github.com/settings/apps/${slug}, click Generate a new client secret, and copy it and the Client ID shown above it.`,
  );
  const clientId = (await d.ask('    Client ID: ')).trim();
  if (!/^[\w.-]{8,100}$/.test(clientId))
    throw new Error('That doesn’t look like a GitHub App’s client ID.');
  const clientSecret = (
    await d.askSecret('    New client secret (it isn’t shown or kept): ')
  ).trim();
  if (!/^\w{20,200}$/.test(clientSecret))
    throw new Error('That doesn’t look like a GitHub client secret.');
  return {
    GITHUB_CLIENT_ID: clientId,
    GITHUB_CLIENT_SECRET: clientSecret,
    GITHUB_APP_SLUG: slug,
  };
}

// Cloudflare's API with a temporary token (never shown or kept).
function cloudflareWith(d, token) {
  return async (path, init = {}) => {
    const answer = await d.fetch(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
    );
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok || !body.success)
      throw new Error(
        `Cloudflare refused: ${body.errors?.[0]?.message ?? `HTTP ${answer.status}`}.${[401, 403].includes(answer.status) ? ` ${TOKEN_HINT}` : ''}`,
      );
    return body;
  };
}
// The scopes Cloudflare offers OAuth clients in this account.
async function offeredScopes(cloudflare) {
  const available = [];
  for (let page = 1; page <= 20; page++) {
    const { result = [], result_info: info = {} } = await cloudflare(
      `/oauth/scopes?per_page=100&page=${page}`,
    );
    available.push(...result.map(({ id, name }) => ({ id, name })));
    if (!result.length || available.length >= Number(info.total_count ?? 0))
      break;
  }
  return available;
}

// The permissions in shared/provider-setup.ts grow (Hyperdrive Write on 28 October 2026), and
// an OAuth client keeps the list it was made with. `--cloudflare-permissions` patches the
// client at Cloudflare and the CLOUDFLARE_OAUTH_SCOPES secret; people then connect Cloudflare
// again in Connections to grant the new ones. offline_access is Cloudflare's to add: it
// follows the client's grant types, so it isn't sent.
async function updateClientScopes(d, origin) {
  d.say(
    `    Updating the Cloudflare OAuth client's permissions. Create a temporary API token at https://dash.cloudflare.com/profile/api-tokens with OAuth Client Write on the account that owns the client.`,
  );
  const token = (
    await d.askSecret('    Paste the token (it isn’t shown or kept): ')
  ).trim();
  if (!/^[\w.-]{20,200}$/.test(token))
    throw new Error('That doesn’t look like a Cloudflare API token.');
  const cloudflare = cloudflareWith(d, token);
  const wanted = pickScopes(await offeredScopes(cloudflare)).scopes.map(
    (s) => s.id,
  );
  const callback = `${origin}/api/auth/cloudflare/callback`;
  for (const account of (await cloudflare('/accounts?per_page=50')).result ??
    []) {
    const clients =
      (await cloudflare(`/accounts/${account.id}/oauth_clients?per_page=50`))
        .result ?? [];
    const client = clients.find((c) =>
      (c.redirect_uris ?? []).includes(callback),
    );
    if (!client) continue;
    const had = client.scopes ?? [];
    const refresh = had.includes('offline_access');
    const added = wanted.filter((s) => !had.includes(s));
    if (!added.length) {
      d.say('    Its permissions are current already.');
      return null;
    }
    await cloudflare(
      `/accounts/${account.id}/oauth_clients/${client.client_id ?? client.id}`,
      { method: 'PATCH', body: JSON.stringify({ scopes: wanted }) },
    );
    d.say(
      `    Added ${added.join(', ')} to the OAuth client in ${account.name}. Everyone connects Cloudflare again in Connections to grant them. Delete the temporary token in Cloudflare now.`,
    );
    return {
      CLOUDFLARE_OAUTH_SCOPES: [
        ...wanted,
        ...(refresh ? ['offline_access'] : []),
      ].join(' '),
    };
  }
  d.say(
    `    No OAuth client in the accounts that token sees sends people back to ${callback}; nothing changed.`,
  );
  return null;
}

// A private Cloudflare OAuth client for the Shipcel at `origin`, as Connections makes one
// (worker/provider-apps.ts): the scopes in shared/provider-setup.ts that Cloudflare offers,
// and refresh tokens when Cloudflare allows them. It belongs to an account the token can see,
// or else to the one Wrangler deployed to.
async function cloudflareClient(d, origin, signedIn) {
  d.say(
    `    Shipcel signs people in to Cloudflare with an OAuth client of its own. To make it, create a temporary API token at https://dash.cloudflare.com/profile/api-tokens: Create Token → Create Custom Token. ${TOKEN_HINT}${signedIn.length ? ` Wrangler deployed to ${signedIn.map((a) => a.name).join(' or ')}.` : ''}`,
  );
  const token = (
    await d.askSecret('    Paste the token (it isn’t shown or kept): ')
  ).trim();
  if (!/^[\w.-]{20,200}$/.test(token))
    throw new Error('That doesn’t look like a Cloudflare API token.');
  const cloudflare = cloudflareWith(d, token);
  const listed = (await cloudflare('/accounts?per_page=50')).result ?? [];
  const accounts = listed.length ? listed : signedIn;
  if (!accounts.length)
    throw new Error(`That token can’t see a Cloudflare account. ${TOKEN_HINT}`);
  let account = accounts[0];
  if (accounts.length > 1) {
    accounts.forEach((a, i) => d.say(`    ${i + 1}. ${a.name}`));
    const chosen = Number(
      await d.ask(
        `    Which account should own the OAuth client (the one with ${new URL(origin).host})? [1] `,
      ),
    );
    account = accounts[(chosen || 1) - 1];
    if (!account) throw new Error('There’s no account with that number.');
  }
  const { scopes, missing, ready } = pickScopes(
    await offeredScopes(cloudflare),
  );
  if (!ready)
    throw new Error(
      'Cloudflare doesn’t offer Account Read to OAuth clients in this account, which Shipcel needs to list accounts.',
    );
  if (missing.length)
    d.say(
      `    Cloudflare doesn’t offer, so not asked for: ${missing.join(', ')}.`,
    );
  const create = (refresh) =>
    cloudflare(`/accounts/${account.id}/oauth_clients`, {
      method: 'POST',
      body: JSON.stringify({
        client_name: 'Shipcel',
        redirect_uris: [`${origin}/api/auth/cloudflare/callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scopes: [
          ...scopes.map((s) => s.id),
          ...(refresh ? ['offline_access'] : []),
        ],
      }),
    });
  // offline_access gives refresh tokens. Without it, a connection lasts until its access
  // token expires and then asks to reconnect.
  let refresh = true,
    created;
  try {
    created = await create(true);
  } catch (error) {
    if (!/offline_access/i.test(error.message)) throw error;
    refresh = false;
    created = await create(false);
  }
  const { client_id, client_secret } = created.result ?? {};
  if (typeof client_id !== 'string' || typeof client_secret !== 'string')
    throw new Error('Cloudflare didn’t return the new OAuth client.');
  d.say(
    `    Created the OAuth client in ${account.name}. Delete the temporary token in Cloudflare now: Shipcel doesn’t need it again.`,
  );
  return {
    CLOUDFLARE_CLIENT_ID: client_id,
    CLOUDFLARE_CLIENT_SECRET: client_secret,
    CLOUDFLARE_OAUTH_SCOPES: [
      ...scopes.map((s) => s.id),
      ...(refresh ? ['offline_access'] : []),
    ].join(' '),
  };
}

export async function setupProduction(d) {
  const config = await d.readConfig();
  const origin = config.match(/"APP_ORIGIN":\s*"(https:\/\/[a-z0-9.-]+)"/)?.[1];
  if (!origin)
    throw new Error(`${CONFIG} has no production APP_ORIGIN (https://…).`);
  const args = d.args ?? [];
  const earlierApp = args.includes('--github-app')
    ? (args[args.indexOf('--github-app') + 1] ?? '')
    : null;
  if (earlierApp !== null && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(earlierApp))
    throw new Error(
      '--github-app takes the app’s name as in its address, github.com/apps/<name>.',
    );

  d.say('1/5 Wrangler and your Cloudflare account');
  const whoami = () =>
    d.run('npx', ['wrangler', 'whoami', '--json'], { capture: true });
  let signedIn = await whoami();
  if (signedIn.code !== 0) {
    d.say('    Wrangler isn’t signed in: your browser opens to sign in.');
    must(await d.run('npx', ['wrangler', 'login']), 'Signing in');
    signedIn = must(await whoami(), 'Checking the sign-in');
  }

  d.say(`2/5 The database ${DATABASE}`);
  const id = await database(d);
  const updated = withDatabaseId(config, id);
  if (updated !== config) {
    await d.writeConfig(updated);
    d.say(`    Wrote its ID (${id}) into ${CONFIG}.`);
  }

  d.say('3/5 Its migrations');
  must(
    await d.run('npx', [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      DATABASE,
      '--remote',
      ...production,
    ]),
    'Applying the migrations',
  );

  d.say(`4/5 Building and deploying ${origin}`);
  must(
    await d.run('npm', ['run', 'build'], {
      env: { CLOUDFLARE_ENV: 'production' },
    }),
    'The build',
  );
  must(await d.run('npx', ['wrangler', 'deploy']), 'The deploy');

  d.say('5/5 Secrets');
  const listed = must(
    await d.run(
      'npx',
      ['wrangler', 'secret', 'list', ...production, '--format', 'json'],
      { capture: true },
    ),
    'Listing the secrets',
  );
  const have = new Set(json(listed.stdout).map((s) => s.name));
  // Each secret is saved as soon as it's made, so a later step that fails loses nothing.
  const save = async (secrets) =>
    must(
      await d.run('npx', ['wrangler', 'secret', 'bulk', ...production], {
        input: JSON.stringify(secrets),
      }),
      'Saving the secrets',
    );
  const missing = [
    'TOKEN_ENCRYPTION_KEY',
    'GITHUB_CLIENT_SECRET',
    'CLOUDFLARE_CLIENT_SECRET',
  ].filter((name) => !have.has(name));
  if (missing.includes('TOKEN_ENCRYPTION_KEY'))
    await save({ TOKEN_ENCRYPTION_KEY: d.random(32) });
  if (missing.includes('GITHUB_CLIENT_SECRET'))
    await save(
      earlierApp
        ? await existingGithubApp(d, earlierApp)
        : await githubApp(d, origin),
    );
  if (missing.includes('CLOUDFLARE_CLIENT_SECRET'))
    await save(await cloudflareClient(d, origin, accountsOf(signedIn.stdout)));
  if (!missing.length) d.say('    All there already.');
  if (args.includes('--cloudflare-permissions')) {
    const updated = await updateClientScopes(d, origin);
    if (updated) await save(updated);
  }
  d.say(
    `Shipcel is at ${origin}. Open ${origin}/app/, sign in with GitHub, then connect Cloudflare.`,
  );
}

// The terminal, Wrangler and your browser.
function run(command, args, { capture = false, input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [
        input !== undefined ? 'pipe' : capture ? 'ignore' : 'inherit',
        capture ? 'pipe' : 'inherit',
        'inherit',
      ],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    if (input !== undefined) child.stdin.end(input);
    child.on('error', () => resolve({ code: 127, stdout }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}
async function ask(question) {
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}
// Typed without echo, in a terminal.
function askSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY)
      return reject(new Error('Run this in a terminal: it asks for a token.'));
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Stopped.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
function open(url) {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true })
    .on('error', () => {
      // The address is printed too.
    })
    .unref();
}
export function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const { status, body } = handler(url.pathname, url.searchParams);
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      }),
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  setupProduction({
    args: process.argv.slice(2),
    run,
    ask,
    askSecret,
    open,
    serve,
    fetch,
    say: (line) => console.log(line),
    random: (bytes) => randomBytes(bytes).toString('hex'),
    readConfig: () => readFile(CONFIG, 'utf8'),
    writeConfig: (text) => writeFile(CONFIG, text),
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
