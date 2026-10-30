import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from './helpers/database';
import { account, cloudflareUploads } from './helpers/cloudflare-uploads';
import { cloudflareWrangler } from './helpers/cloudflare-wrangler';
import { bridge, sized } from './helpers/wrangler-bridge';
import { buildToken, commit, gitProviders } from './helpers/git-providers';
import { actionsKey, jwks, jwksUrl, runToken } from './helpers/github-oidc';
import { workflowFile } from '../worker/github-actions';
import { previewOnlyRun } from '../worker/tokens';
import { ignoreMatcher, run, type Io } from '../packages/cli/src/cli';
import app from '../worker/index';

let dir: string;
let output: string[];
let errors: string[];
let opened: string[];
// Shell commands the CLI asked for (installs and builds); tests stand in for them.
let ran: string[];
// The deployed apps, at their workers.dev addresses: they answer, unless a test says
// otherwise. (The CLI asks a new version for its home page after a deploy.)
let apps: (url: string) => Response | Promise<Response>;

// A real file system in a temporary folder; everything else is injected.
function io(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Io> = {},
  env: Record<string, string> = {},
): Io {
  return {
    env: { SHIPCEL_CONFIG_DIR: join(dir, 'config'), ...env },
    cwd: join(dir, 'work'),
    home: dir,
    hostname: 'ada-laptop',
    isTTY: false,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
    fetch: ((url: string | URL | Request, init?: RequestInit) =>
      new URL(String(url)).hostname.endsWith('.workers.dev')
        ? Promise.resolve(apps(String(url)))
        : fetch(url, init)) as typeof globalThis.fetch,
    open: async (url) => {
      opened.push(url);
    },
    run: async (command) => {
      ran.push(command);
      return 0;
    },
    sleep: async () => {},
    ask: async () => 'y',
    askSecret: async () => '',
    stdin: async () => '',
    fs: {
      readFile: async (p) => new Uint8Array(readFileSync(p)),
      writeFile: async (p, data, mode) => {
        writeFileSync(p, data, mode ? { mode } : undefined);
        if (mode) chmodSync(p, mode);
      },
      mkdir: async (p, mode) => {
        mkdirSync(p, { recursive: true, ...(mode ? { mode } : {}) });
      },
      remove: async (p) => rmSync(p, { force: true }),
      readdir: async (p) =>
        readdirSync(p, { withFileTypes: true })
          .map((e) => ({
            name: e.name,
            dir: e.isDirectory(),
            file: e.isFile(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      size: async (p) => statSync(p).size,
      exists: async (p) => existsSync(p),
    },
    ...overrides,
  };
}
function write(path: string, text: string) {
  const full = join(dir, 'work', path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipcel-cli-'));
  mkdirSync(join(dir, 'work'));
  output = [];
  errors = [];
  opened = [];
  ran = [];
  apps = () => new Response('ok');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('shipcel login, against the real Shipcel API', () => {
  let db: ReturnType<typeof database>;
  type Who = Awaited<ReturnType<ReturnType<typeof database>['user']>>;
  const toShipcel = ((url: string, init: RequestInit) =>
    app.request(url, init, db.env)) as typeof globalThis.fetch;
  const login = (overrides: Partial<Io> = {}) =>
    run(['login', '--url', 'https://shipcel.test'], io(toShipcel, overrides));
  // What the person does in the browser while the CLI waits: approve the code on the page
  // the CLI opened, then anything else the test passes, one step per wait.
  function browser(who: Who, ...later: (() => Promise<unknown>)[]) {
    const steps = [
      () =>
        db.request(
          '/cli/login/approve',
          {
            method: 'POST',
            body: JSON.stringify({ code: opened[0].split('code=')[1] }),
          },
          who.cookie,
        ),
      ...later,
    ];
    return async () => {
      await steps.shift()?.();
    };
  }
  const configFile = () => join(dir, 'config', 'config.json');

  beforeEach(() => {
    db = database();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Unexpected network request');
      }),
    );
  });
  afterEach(() => db.close());

  it('signs in through the browser, says who and where, and keeps the token private on disk', async () => {
    const who = await db.user(1);
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    expect(await login({ sleep: browser(who) })).toBe(0);
    const code = opened[0].split('code=')[1];
    expect(code).toMatch(/^[B-Z2-9]{4}-[B-Z2-9]{4}$/);
    expect(opened).toEqual([
      `https://shipcel.test/app/#cli-login?code=${code}`,
    ]);
    expect(output).toEqual([
      `Visit https://shipcel.test/app/#cli-login?code=${code}`,
      `Sign in with GitHub there if it asks, check that it shows the code ${code}, then approve.`,
      'Waiting for you in the browser…',
      'Signed in as user-1 in workspace-1.',
      `The token is saved in ${configFile()}.`,
      'Cloudflare: connected to Test Cloud.',
      'Next: run shipcel in your project’s folder to deploy it.',
    ]);
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    expect(config.url).toBe('https://shipcel.test');
    expect(config.token).toMatch(/^cc_pat_[A-Za-z0-9_-]{43}$/);
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(output.join('\n')).not.toContain(config.token);
    expect(db.sqlite.prepare('SELECT name FROM api_tokens').all()).toEqual([
      { name: 'CLI on ada-laptop' },
    ]);
  });

  it('signs in to shipcel.com when no address is given', async () => {
    const who = await db.user(1);
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    // The real Shipcel API answers for shipcel.com.
    const asked = new Set<string>();
    const toShipcelCom = ((url: string, init: RequestInit) => {
      asked.add(new URL(url).origin);
      return toShipcel(
        String(url).replace('https://shipcel.com/', 'https://shipcel.test/'),
        init,
      );
    }) as typeof globalThis.fetch;
    expect(
      await run(['login'], io(toShipcelCom, { sleep: browser(who) })),
    ).toBe(0);
    expect(asked).toEqual(new Set(['https://shipcel.com']));
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).url).toBe(
      'https://shipcel.com',
    );
  });

  it('refuses a token without an address, so a self-hosted token never goes to shipcel.com', async () => {
    const asked: string[] = [];
    const recording = ((url: string, init: RequestInit) => {
      asked.push(String(url));
      return toShipcel(url, init);
    }) as typeof globalThis.fetch;
    // No address at all, and an address left empty by an unset CI secret.
    for (const env of [
      { SHIPCEL_TOKEN: 'cc_pat_x' },
      { SHIPCEL_TOKEN: 'cc_pat_x', SHIPCEL_URL: '' },
    ] as Record<string, string>[]) {
      expect(await run(['whoami'], io(recording, {}, env))).toBe(1);
      expect(errors.pop()).toBe(
        'This token needs the address of its Shipcel too: set SHIPCEL_URL (https://shipcel.com for shipcel.com), or pass --url.',
      );
    }
    expect(asked).toEqual([]);
  });

  it('waits in a terminal while Cloudflare is connected in the tab that is already open', async () => {
    const who = await db.user(1);
    await db.grant(who, 'github');
    expect(
      await login({
        isTTY: true,
        // Approve; nothing yet; then Cloudflare is connected in the browser.
        sleep: browser(
          who,
          async () => {},
          () => db.grant(who, 'cloudflare'),
        ),
      }),
    ).toBe(0);
    expect(output.slice(5)).toEqual([
      'Shipcel deploys into your own Cloudflare account, and it isn’t connected yet.',
      'Connect it in the browser tab that’s open (or visit https://shipcel.test/app/#cli-setup).',
      'Waiting for Cloudflare… (Ctrl+C stops; nothing is lost.)',
      'Connected Cloudflare: Test Cloud.',
      'Next: run shipcel in your project’s folder to deploy it.',
    ]);
    // The page that approved the sign-in carries on to Cloudflare: no second tab.
    expect(opened).toHaveLength(1);
  });

  it('says where to connect Cloudflare when it can’t wait, and who can', async () => {
    const who = await db.user(1);
    await db.grant(who, 'github');
    expect(await login({ sleep: browser(who) })).toBe(0);
    expect(output.slice(5)).toEqual([
      'Cloudflare isn’t connected yet. Connect it once in your browser: https://shipcel.test/app/#cli-setup',
      'Next: run shipcel in your project’s folder to deploy it.',
    ]);
    // Only owners connect accounts: a developer isn't sent to do it, or kept waiting.
    output = [];
    opened = [];
    const developer = await db.user(2, 'developer');
    let waits = 0;
    const approve = browser(developer);
    expect(
      await login({
        isTTY: true,
        sleep: async () => {
          waits++;
          await approve();
        },
      }),
    ).toBe(0);
    expect(output.slice(5)).toEqual([
      'This workspace has no Cloudflare account connected yet. Ask one of its owners to connect it.',
      'Next: run shipcel in your project’s folder to deploy it.',
    ]);
    expect(waits).toBe(1);
  });

  it('signs in first when a command needs it, then carries on with the command', async () => {
    const who = await db.user(1);
    await db.grant(who, 'cloudflare');
    expect(
      await run(
        ['whoami'],
        io(
          toShipcel,
          { isTTY: true, sleep: browser(who) },
          { SHIPCEL_URL: 'https://shipcel.test' },
        ),
      ),
    ).toBe(0);
    expect(output[0]).toBe('You are not signed in yet.');
    // No "Next: run shipcel…": the command they ran is what comes next.
    expect(output.slice(4)).toEqual([
      'Signed in as user-1 in workspace-1.',
      `The token is saved in ${configFile()}.`,
      'Cloudflare: connected to Test Cloud.',
      'Signed in as user-1 (owner) on https://shipcel.test.',
      'Workspace: workspace-1 · Cloudflare: Test Cloud',
    ]);
    // Without a terminal there is nobody to approve it: a token is needed instead.
    rmSync(configFile());
    expect(
      await run(
        ['whoami'],
        io(toShipcel, {}, { SHIPCEL_URL: 'https://shipcel.test' }),
      ),
    ).toBe(1);
    expect(errors.pop()).toContain('set SHIPCEL_TOKEN');
  });

  it('says when this Shipcel has deployments switched off', async () => {
    const who = await db.user(1);
    await db.grant(who, 'cloudflare');
    db.env.NATIVE_BUILDS_ENABLED = 'false';
    expect(await login({ sleep: browser(who) })).toBe(0);
    expect(output.slice(5, 7)).toEqual([
      'Cloudflare: connected to Test Cloud.',
      'Deployments are switched off on this Shipcel. Its operator turns them on with NATIVE_BUILDS_ENABLED=true.',
    ]);
  });
});

describe('shipcel login, when it is refused', () => {
  // The sign-in endpoints alone, answering like Shipcel does.
  function loginApi(outcome: 200 | 403 | 410) {
    let polls = 0;
    const calls: { path: string; headers: Headers; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({
        path,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      });
      if (path === '/api/cli/login')
        return Response.json(
          {
            code: 'BCDF-GHJK',
            deviceSecret: 'secret-1',
            verificationUrl:
              'https://shipcel.test/app/#cli-login?code=BCDF-GHJK',
            expiresIn: 600,
            interval: 2,
          },
          { status: 201 },
        );
      polls++;
      if (polls < 3)
        return Response.json({ status: 'pending' }, { status: 202 });
      return outcome === 200
        ? Response.json({ token: 'cc_pat_' + 'x'.repeat(43) })
        : Response.json({}, { status: outcome });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it('reports a denied or expired sign-in', async () => {
    expect(
      await run(
        ['login', '--url', 'https://shipcel.test'],
        io(loginApi(403).fetch),
      ),
    ).toBe(1);
    expect(errors.pop()).toContain('denied');
    expect(
      await run(
        ['login', '--url', 'https://shipcel.test'],
        io(loginApi(410).fetch),
      ),
    ).toBe(1);
    expect(errors.pop()).toContain('expired');
  });

  it('says what to do when Shipcel doesn’t answer', async () => {
    const down = (() =>
      Promise.reject(new TypeError('fetch failed'))) as typeof globalThis.fetch;
    // On this computer, it is usually not started (seen live: the owner's dev server had
    // stopped overnight).
    expect(
      await run(
        ['whoami'],
        io(
          down,
          {},
          { SHIPCEL_URL: 'http://127.0.0.1:5173', SHIPCEL_TOKEN: 'x' },
        ),
      ),
    ).toBe(1);
    expect(errors.pop()).toBe(
      'Could not reach Shipcel at http://127.0.0.1:5173. Is it running? Start it in its own folder with npm run dev, then run this again.',
    );
    expect(
      await run(
        ['whoami'],
        io(
          down,
          {},
          { SHIPCEL_URL: 'https://shipcel.example', SHIPCEL_TOKEN: 'x' },
        ),
      ),
    ).toBe(1);
    expect(errors.pop()).toBe(
      'Could not reach Shipcel at https://shipcel.example. Check the address and your connection, then run this again.',
    );
  });

  it('refuses insecure addresses and needs a token in CI', async () => {
    const never = (async () => {
      throw new Error('no network');
    }) as typeof globalThis.fetch;
    expect(
      await run(['login', '--url', 'http://shipcel.example'], io(never)),
    ).toBe(1);
    expect(errors.pop()).toContain('https://');
    expect(
      await run(
        ['deploy'],
        io(never, {}, { SHIPCEL_URL: 'https://shipcel.test' }),
      ),
    ).toBe(1);
    expect(errors.pop()).toContain('SHIPCEL_TOKEN');
    expect(await run(['nonsense'], io(never))).toBe(2);
    expect(await run(['--help'], io(never))).toBe(0);
  });
});

describe('shipcel deploy, against the real Shipcel API', () => {
  let db: ReturnType<typeof database>;
  let fx: ReturnType<typeof cloudflareUploads>;
  let token: string;
  // The CLI's requests go to the Shipcel app; the app's requests go to fake Cloudflare.
  const toShipcel = ((url: string, init: RequestInit) =>
    app.request(url, init, db.env)) as typeof globalThis.fetch;
  const cli = (args: string[], overrides: Partial<Io> = {}) =>
    run(
      args,
      io(toShipcel, overrides, {
        SHIPCEL_URL: 'https://shipcel.test',
        SHIPCEL_TOKEN: token,
      }),
    );

  beforeEach(async () => {
    db = database();
    const who = await db.user(1);
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    fx = cloudflareUploads();
    vi.stubGlobal('fetch', vi.fn(fx.handler));
    token = (
      (await (
        await db.request(
          '/tokens',
          { method: 'POST', body: JSON.stringify({ name: 'CLI test' }) },
          who.cookie,
        )
      ).json()) as { token: string }
    ).token;
  });
  afterEach(() => db.close());

  const projectId = async (name: string) =>
    (
      (await (
        await toShipcel('https://shipcel.test/api/projects', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as { id: string; name: string }[]
    ).find((p) => p.name === name)!.id;

  it('deploys previews by default and production with --prod, like Vercel', async () => {
    write('site/index.html', '<h1>Hello</h1>');
    write('site/assets/app.js', 'console.log(1)');
    write('site/assets/app.js.map', '{}');
    write('site/node_modules/left-over.js', 'x');
    write('site/.env', 'SECRET=1');
    write('site/.shipcelignore', '# source maps stay local\n*.map\n');
    write('site/_redirects', '/old /new 301');
    write(
      'site/_worker.js',
      'export default { fetch: (r, env) => env.ASSETS.fetch(r) };',
    );
    expect(
      await cli([
        'deploy',
        'site',
        '--yes',
        '--name',
        'my-cli-site',
        '--target',
        'preview',
      ]),
    ).toBe(0);
    expect(errors).toEqual([]);
    const id = await projectId('my-cli-site');
    // Asked for a preview, a new app is created unpublished, with a preview address.
    expect(output).toEqual([
      'Created the project my-cli-site.',
      'Uploading 2 of 2 new files…',
      'Deployed 2 files (2 new, 4 skipped) to my-cli-site as a preview.',
      `Inspect: https://shipcel.test/app/#projects/${id}/deployments`,
      'Preview: https://00000001-my-cli-site.test-account.workers.dev',
      'Not public yet: only the preview address works. To publish it: shipcel promote 00000001 (or deploy with --prod).',
    ]);
    expect(fx.state.route).toMatchObject({ enabled: false });
    // Ignored, hidden and node_modules files never leave the computer.
    expect(
      [...fx.state.stored.values()]
        .map((f) => Buffer.from(f.content, 'base64').toString())
        .sort(),
    ).toEqual(['<h1>Hello</h1>', 'console.log(1)'].sort());
    expect(fx.state.workers.get('my-cli-site')!.metadata).toMatchObject({
      main_module: '_worker.js',
      assets: {
        config: {
          _redirects: '/old /new 301',
          not_found_handling: 'single-page-application',
        },
      },
    });
    expect(
      JSON.parse(
        readFileSync(join(dir, 'work', '.shipcel', 'project.json'), 'utf8'),
      ),
    ).toMatchObject({ name: 'my-cli-site' });
    // Promoting the first version publishes the app; it already serves all traffic.
    output = [];
    const deployments = fx.state.deployments.length;
    expect(await cli(['promote', '00000001', '--yes'])).toBe(0);
    expect(output).toEqual([
      'Promoted 00000001 to production.',
      'Production: https://my-cli-site.test-account.workers.dev/',
    ]);
    expect(fx.state.route).toMatchObject({ enabled: true });
    expect(fx.state.deployments).toHaveLength(deployments);
    // A folder name alone deploys it; --prod makes it production.
    output = [];
    expect(await cli(['site', '--prod'])).toBe(0);
    expect(output).toEqual([
      'Deployed 2 files (0 new, 4 skipped) to my-cli-site.',
      `Inspect: https://shipcel.test/app/#projects/${id}/deployments`,
      'Preview: https://00000002-my-cli-site.test-account.workers.dev',
      'Production: https://my-cli-site.test-account.workers.dev/',
    ]);
    expect(fx.state.live).toBe('00000002-0000-4000-8000-000000000000');
    expect(fx.state.route).toMatchObject({ enabled: true });
    // Without --prod: a preview, while production keeps serving version 2.
    write('site/index.html', '<h1>Next</h1>');
    output = [];
    expect(await cli(['deploy', 'site'])).toBe(0);
    expect(output).toEqual([
      'Uploading 1 of 1 new files…',
      'Deployed 2 files (1 new, 4 skipped) to my-cli-site as a preview.',
      `Inspect: https://shipcel.test/app/#projects/${id}/deployments`,
      'Preview: https://00000003-my-cli-site.test-account.workers.dev',
      'Production: https://my-cli-site.test-account.workers.dev/ (unchanged). To make this version production: shipcel promote 00000003',
    ]);
    expect(fx.state.live).toBe('00000002-0000-4000-8000-000000000000');
    output = [];
    expect(await cli(['ls'])).toBe(0);
    expect(output[0]).toBe(
      `my-cli-site · production: https://my-cli-site.test-account.workers.dev/ · https://shipcel.test/app/#projects/${id}/deployments`,
    );
    expect(output[1]).toMatch(/^AGE +VERSION +STATUS +PREVIEW +MESSAGE$/);
    expect(output.slice(2).map((l) => l.split(/ {2,}/).slice(1, 4))).toEqual([
      [
        '00000003',
        'Preview',
        'https://00000003-my-cli-site.test-account.workers.dev',
      ],
      [
        '00000002',
        'Production 100%',
        'https://00000002-my-cli-site.test-account.workers.dev',
      ],
      [
        '00000001',
        'Earlier production',
        'https://00000001-my-cli-site.test-account.workers.dev',
      ],
    ]);
    output = [];
    expect(
      await cli([
        'inspect',
        'https://00000003-my-cli-site.test-account.workers.dev',
      ]),
    ).toBe(0);
    expect(output[0]).toMatch(
      /^Version +00000003-0000-4000-8000-000000000000 \(#3\)$/,
    );
    expect(output).toContain('Status   Preview: serves no production traffic');
    expect(await cli(['inspect', '0000000'])).toBe(1);
    expect(errors.pop()).toContain('matches more than one version');
    expect(await cli(['inspect', 'deadbeef'])).toBe(1);
    expect(errors.pop()).toContain('No version deadbeef');
    // Promoting the preview makes it production.
    output = [];
    expect(await cli(['promote', '00000003', '--yes'])).toBe(0);
    expect(output).toEqual([
      'Promoted 00000003 to production.',
      'Production: https://my-cli-site.test-account.workers.dev/',
    ]);
    expect(fx.state.live).toBe('00000003-0000-4000-8000-000000000000');
    expect(await cli(['promote', '00000003', '--yes'])).toBe(1);
    expect(errors.pop()).toBe('That version is already production.');
    // Rollback goes back through earlier production versions only.
    output = [];
    expect(await cli(['rollback', '--yes'])).toBe(0);
    expect(output.join('\n')).toContain(
      '00000002-0000-4000-8000-000000000000 now serves all traffic',
    );
    expect(await cli(['rollback', '--yes'])).toBe(0);
    expect(fx.state.live).toBe('00000001-0000-4000-8000-000000000000');
    expect(await cli(['rollback', '--yes'])).toBe(1);
    expect(errors.pop()).toContain('no earlier production version');
    // A change in a script needs --yes.
    expect(await cli(['promote', '00000003'])).toBe(1);
    expect(errors.pop()).toContain('Pass --yes');
    output = [];
    expect(await cli(['open'])).toBe(0);
    expect(opened.pop()).toBe(`https://shipcel.test/app/#projects/${id}`);
    expect(await cli(['open', '--app'])).toBe(0);
    expect(opened.pop()).toBe('https://my-cli-site.test-account.workers.dev/');
    expect(await cli(['redeploy'])).toBe(1);
    expect(errors.pop()).toContain('deploys by upload');
    output = [];
    expect(await cli(['whoami'])).toBe(0);
    expect(output[0]).toBe(
      'Signed in as user-1 (owner) on https://shipcel.test.',
    );
  });

  it('rolls back to the previous production version, past previews', async () => {
    write('site/index.html', '<h1>1</h1>');
    expect(await cli(['deploy', 'site', '--prod', '--yes'])).toBe(0);
    write('site/index.html', '<h1>2</h1>');
    expect(await cli(['deploy', 'site'])).toBe(0);
    write('site/index.html', '<h1>3</h1>');
    expect(await cli(['deploy', 'site', '--prod'])).toBe(0);
    output = [];
    expect(await cli(['rollback', '--yes'])).toBe(0);
    expect(output).toEqual([
      'Rolled back: 00000001-0000-4000-8000-000000000000 now serves all traffic. Database changes are not undone.',
    ]);
    expect(fx.state.live).toBe('00000001-0000-4000-8000-000000000000');
    // Or to a given version, by its preview address.
    expect(
      await cli([
        'rollback',
        'https://00000002-site.test-account.workers.dev',
        '--yes',
      ]),
    ).toBe(0);
    expect(fx.state.live).toBe('00000002-0000-4000-8000-000000000000');
  });

  it('links folders, and lists, inspects and removes projects', async () => {
    expect(await cli(['project', 'add', 'linked-site'])).toBe(0);
    expect(output.pop()).toBe(
      'Created linked-site. Link a folder to it with shipcel link --project linked-site.',
    );
    expect(await cli(['link'])).toBe(1);
    expect(errors.pop()).toContain('shipcel link --project <name>');
    expect(await cli(['link', '--project', 'linked-site'])).toBe(0);
    expect(output.pop()).toBe(
      `Linked ${join(dir, 'work')} to linked-site (.shipcel/project.json).`,
    );
    output = [];
    expect(await cli(['project', 'ls'])).toBe(0);
    expect(output[1].split(/ {2,}/).slice(0, 3)).toEqual([
      'linked-site',
      'static',
      'kit',
    ]);
    output = [];
    expect(await cli(['project', 'inspect'])).toBe(0);
    expect(output).toContain('Deploys     not deployed yet');
    output = [];
    expect(await cli(['activity'])).toBe(0);
    expect(output[0]).toMatch(/ago +created +linked-site$/);
    expect(await cli(['rm', 'linked-site'])).toBe(1);
    expect(errors.pop()).toContain('Pass --yes');
    output = [];
    expect(await cli(['rm', 'linked-site', '--yes'])).toBe(0);
    expect(output).toEqual(['Removed linked-site from Shipcel.']);
    expect(existsSync(join(dir, 'work', '.shipcel', 'project.json'))).toBe(
      false,
    );
  });

  it('sets secrets without ever showing them', async () => {
    write('site/index.html', '<h1>Hello</h1>');
    write(
      'site/_worker.js',
      'export default { fetch: () => new Response("") };',
    );
    expect(await cli(['deploy', 'site', '--prod', '--yes'])).toBe(0);
    output = [];
    expect(
      await cli(['env', 'add', 'API_KEY'], {
        stdin: async () => 'sk-test-123\n',
      }),
    ).toBe(0);
    expect(output).toEqual([
      'Set the secret API_KEY. Cloudflare deployed it with the current code.',
    ]);
    expect(fx.state.secrets.get('API_KEY')).toBe('sk-test-123');
    const asked: string[] = [];
    expect(
      await cli(['env', 'add', 'OTHER'], {
        isTTY: true,
        askSecret: async (question) => {
          asked.push(question);
          return 'typed-value';
        },
      }),
    ).toBe(0);
    expect(asked).toEqual(['Value of OTHER (hidden as you type): ']);
    expect(await cli(['env', 'add', 'EMPTY'])).toBe(1);
    expect(errors.pop()).toContain('No value for EMPTY');
    output = [];
    expect(await cli(['env', 'ls'])).toBe(0);
    expect(output).toEqual(['API_KEY  secret', 'OTHER    secret']);
    expect(await cli(['env', 'rm', 'API_KEY', '--yes'])).toBe(0);
    expect(fx.state.secrets.has('API_KEY')).toBe(false);
    expect([...output, ...errors].join('\n')).not.toMatch(
      /sk-test-123|typed-value/,
    );
  });

  it('attaches a custom domain in the zone that covers it, and detaches it', async () => {
    write('site/index.html', '<h1>Hello</h1>');
    expect(await cli(['deploy', 'site', '--prod', '--yes'])).toBe(0);
    const zones = [
      {
        id: 'b'.repeat(32),
        name: 'example.com',
        status: 'active',
        account: { id: account },
      },
      {
        id: 'c'.repeat(32),
        name: 'shop.example.com',
        status: 'active',
        account: { id: account },
      },
    ];
    const attached: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(raw));
        const path = url.pathname.replace('/client/v4', '');
        const cf = (result: unknown) =>
          Response.json({ success: true, result });
        if (path === '/zones') return cf(zones);
        const zone = zones.find((z) => path === `/zones/${z.id}`);
        if (zone) return cf(zone);
        if (path.endsWith('/dns_records')) return cf([]);
        if (path === `/accounts/${account}/workers/domains`) {
          if (init.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            const domain = { id: 'd'.repeat(32), ...body };
            attached.push(domain);
            return cf(domain);
          }
          return cf(attached);
        }
        if (path === `/accounts/${account}/workers/domains/${'d'.repeat(32)}`) {
          attached.length = 0;
          return cf(null);
        }
        return fx.handler(raw, init);
      }),
    );
    output = [];
    expect(await cli(['domains', 'add', 'app.shop.example.com'])).toBe(0);
    expect(output).toEqual([
      'Added https://app.shop.example.com (zone shop.example.com). Cloudflare issues its certificate in a few minutes.',
    ]);
    expect(attached[0]).toMatchObject({
      hostname: 'app.shop.example.com',
      zone_id: 'c'.repeat(32),
      service: 'site',
    });
    output = [];
    expect(await cli(['domains', 'ls'])).toBe(0);
    expect(output).toEqual(['https://app.shop.example.com']);
    expect(await cli(['domains', 'add', 'app.other.test'])).toBe(1);
    expect(errors.pop()).toContain('Add the domain to Cloudflare first');
    expect(await cli(['domains', 'rm', 'app.shop.example.com', '--yes'])).toBe(
      0,
    );
    expect(attached).toEqual([]);
  });

  it('adds a Postgres database through Hyperdrive from a connection string, and removes it', async () => {
    write('site/index.html', '<h1>Hello</h1>');
    expect(await cli(['deploy', 'site', '--prod', '--yes'])).toBe(0);
    const id = 'f'.repeat(32);
    const configs: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(raw));
        const path = url.pathname.replace('/client/v4', '');
        const cf = (result: unknown) =>
          Response.json({ success: true, result });
        if (path === `/accounts/${account}/hyperdrive/configs`) {
          const body = JSON.parse(String(init.body));
          configs.push(body);
          return cf({
            id,
            name: body.name,
            origin: { host: body.origin.host },
          });
        }
        if (path === `/accounts/${account}/hyperdrive/configs/${id}`) {
          configs.length = 0;
          return cf(null);
        }
        return fx.handler(raw, init);
      }),
    );
    output = [];
    // The address comes from standard input or a hidden prompt, not the command line.
    expect(
      await cli(['hyperdrive', 'add', 'DB'], {
        stdin: async () => 'postgres://app:s3cret@db.neon.tech:5432/shop\n',
      }),
    ).toBe(0);
    expect(output.join('\n')).toContain(`"id": "${id}"`);
    expect(output.join('\n')).toContain('db.neon.tech');
    expect(configs[0]).toMatchObject({
      origin: { scheme: 'postgres', host: 'db.neon.tech', password: 's3cret' },
    });
    output = [];
    expect(await cli(['hyperdrive', 'ls'])).toBe(0);
    expect(output.join('\n')).toContain('DB');
    expect(output.join('\n')).toContain('postgres');
    expect(
      await cli(['hyperdrive', 'add', 'DB'], { stdin: async () => '' }),
    ).toBe(1);
    expect(errors.pop()).toContain('No address for DB');
    expect(await cli(['hyperdrive', 'rm', 'DB', '--yes'])).toBe(0);
    expect(configs).toEqual([]);
    output = [];
    expect(await cli(['hyperdrive', 'ls'])).toBe(0);
    expect(output.join('\n')).toContain('No Postgres or MySQL databases');
    expect([...output, ...errors].join('\n')).not.toContain('s3cret');
  });

  it('prints logs oldest first, filters errors and follows new ones', async () => {
    write('site/index.html', '<h1>Hello</h1>');
    expect(await cli(['deploy', 'site', '--prod', '--yes'])).toBe(0);
    const queries: Record<string, unknown>[] = [];
    let round = 0;
    const event = (
      id: string,
      minute: number,
      message: string,
      error = false,
    ) => ({
      timestamp: Date.UTC(2026, 9, 8, 12, minute),
      $metadata: {
        id,
        message,
        ...(error ? { error: message, level: 'error' } : { level: 'log' }),
        statusCode: error ? 500 : 200,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
        const path = new URL(String(raw)).pathname.replace('/client/v4', '');
        if (
          path === `/accounts/${account}/workers/observability/telemetry/query`
        ) {
          queries.push(JSON.parse(String(init.body)));
          const events =
            round++ === 0
              ? [event('e2', 2, 'GET /later'), event('e1', 1, 'GET /first')]
              : [event('e2', 2, 'GET /later'), event('e3', 3, 'Boom', true)];
          return Response.json({
            success: true,
            result: { events: { events } },
          });
        }
        return fx.handler(raw, init);
      }),
    );
    output = [];
    expect(await cli(['logs', '--since', '2h'])).toBe(0);
    expect(output).toEqual([
      '2026-10-08T12:01:00.000Z  log    200  GET /first',
      '2026-10-08T12:02:00.000Z  log    200  GET /later',
    ]);
    const window = queries[0].timeframe as { from: number; to: number };
    expect(window.to - window.from).toBe(120 * 60 * 1000);
    expect(await cli(['logs', '--since', '10s'])).toBe(2);
    // Following: new events only, until interrupted.
    round = 0;
    output = [];
    let sleeps = 0;
    expect(
      await cli(['logs', '--follow', '--errors'], {
        sleep: async () => {
          if (sleeps++) throw new Error('Interrupted');
        },
      }),
    ).toBe(1);
    expect(output).toEqual([
      '2026-10-08T12:01:00.000Z  log    200  GET /first',
      '2026-10-08T12:02:00.000Z  log    200  GET /later',
      'Following new events. Press Ctrl+C to stop.',
      '2026-10-08T12:03:00.000Z  error  500  Boom',
    ]);
    expect(JSON.stringify(queries.at(-1))).toContain('$metadata.error');
  });

  it('starts from a starter kit in a new folder, linked and ready to deploy', async () => {
    expect(await cli(['init', 'static', 'my-site'])).toBe(0);
    expect(output).toEqual([
      'Created my-site from the static starter kit: 9 files in my-site.',
      'Next: cd my-site && npm install && npm run dev',
      'Deploy it: shipcel deploy public --prod',
    ]);
    const folder = join(dir, 'work', 'my-site');
    expect(
      readFileSync(join(folder, 'public', 'index.html'), 'utf8'),
    ).toContain('<!doctype html>');
    expect(
      JSON.parse(
        readFileSync(join(folder, '.shipcel', 'project.json'), 'utf8'),
      ),
    ).toMatchObject({ name: 'my-site' });
    // A folder with files in it is never written into, and no project is created.
    write('busy/notes.txt', 'mine');
    expect(await cli(['init', 'static', 'busy'])).toBe(1);
    expect(errors.pop()).toBe('busy already exists and isn’t empty.');
    output = [];
    await cli(['project', 'ls']);
    expect(output.join('\n')).not.toContain('busy');
    expect(await cli(['init', 'nope'])).toBe(2);
    output = [];
    expect(await cli(['init'])).toBe(2);
    expect(output[0]).toBe('Starter kits:');
    // Containers bill by use on Workers Paid, so their project can't be Free-only: asked first.
    output = [];
    expect(await cli(['init', 'umami', 'stats'])).toBe(1);
    expect(errors.pop()).toBe(
      'The umami starter kit runs containers, which need Cloudflare’s Workers Paid plan and bill by use, so its project can’t be Free-only. Pass --yes to create it with Free-only off.',
    );
    expect(await cli(['init', 'umami', 'stats', '--yes'])).toBe(0);
    expect(output).toEqual([
      'The umami starter kit runs containers: its project is created with Free-only off.',
      'Created stats from the umami starter kit: 7 files in stats.',
      'Next: cd stats && npm install',
      'Deploy it: push the folder to GitHub, then run shipcel git connect in it; Cloudflare’s builds deploy its container (README.md has the steps).',
    ]);
    // The kit's own folder deploys from where it was written (--cwd).
    output = [];
    expect(await cli(['deploy', 'public', '--prod', '--cwd', 'my-site'])).toBe(
      0,
    );
    expect(output.at(-1)).toBe(
      'Production: https://my-site.test-account.workers.dev/',
    );
  });

  it('answers --version and help, and refuses what it doesn’t know', async () => {
    expect(await cli(['--version'])).toBe(0);
    expect(output.pop()).toBe(
      JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).version,
    );
    expect(await cli(['help', 'deploy'])).toBe(0);
    expect(output.pop()).toContain('--prod');
    expect(await cli(['ls', '--help'])).toBe(0);
    expect(output.pop()).toContain('shipcel list | ls');
    expect(await cli(['promote'])).toBe(2);
    expect(await cli(['no-such-thing'])).toBe(2);
    expect(errors.pop()).toBe(
      'Unknown command no-such-thing. Run shipcel --help.',
    );
    // With no command, shipcel deploys this folder.
    expect(await cli([])).toBe(1);
    expect(errors.pop()).toContain('has no files to deploy');
  });

  it('points to the build folder instead of deploying source by mistake', async () => {
    write('package.json', '{}');
    write('src/main.js', 'x');
    write('dist/index.html', '<h1>Built</h1>');
    expect(await cli(['deploy', '--create'])).toBe(1);
    expect(errors.pop()).toContain('Did you mean: shipcel deploy dist');
    expect(fx.state.calls).toEqual([]);
  });

  // A Vite project's source, and a stand-in for its package manager and build tool.
  function viteProject(extra: Record<string, unknown> = {}) {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^8.0.0' },
        ...extra,
      }),
    );
    write('index.html', '<div id="app">source</div>');
    write('src/main.js', 'source()');
  }
  const builder =
    (folder = 'dist', exit = 0) =>
    async (command: string) => {
      ran.push(command);
      if (/ install$/.test(command)) write('node_modules/vite/index.js', '');
      else if (exit === 0) {
        write(`${folder}/index.html`, '<h1>Built</h1>');
        write(`${folder}/assets/app.js`, 'built()');
      }
      return exit;
    };
  const uploaded = () =>
    [...fx.state.stored.values()]
      .map((f) => Buffer.from(f.content, 'base64').toString())
      .sort();
  const linkFile = () =>
    JSON.parse(
      readFileSync(join(dir, 'work', '.shipcel', 'project.json'), 'utf8'),
    );
  // Answers by what is asked, and a record of the questions.
  function answering(replies: [RegExp, string][]) {
    const asked: string[] = [];
    return {
      asked,
      ask: async (question: string) => {
        asked.push(question);
        return replies.find(([pattern]) => pattern.test(question))?.[1] ?? '';
      },
    };
  }

  it('builds a project on this computer and deploys what the build wrote, like Vercel', async () => {
    viteProject();
    expect(await cli(['--yes', '--name', 'my-app'], { run: builder() })).toBe(
      0,
    );
    expect(errors).toEqual([]);
    const id = await projectId('my-app');
    expect(output).toEqual([
      'Created the project my-app.',
      'Installing dependencies: npm install',
      'Building: npm run build',
      'Uploading 2 of 2 new files…',
      'Deployed 2 files (2 new) to my-app.',
      `Inspect: https://shipcel.test/app/#projects/${id}/deployments`,
      'Preview: https://00000001-my-app.test-account.workers.dev',
      'Production: https://my-app.test-account.workers.dev/',
      'A new app’s first deploy goes to production. From now on, shipcel deploys a preview and shipcel --prod deploys to production.',
    ]);
    expect(fx.state.route).toMatchObject({ enabled: true });
    expect(ran).toEqual(['npm install', 'npm run build']);
    // The build's output is what deploys: never the source next to it.
    expect(uploaded()).toEqual(['<h1>Built</h1>', 'built()']);
    expect(fx.state.workers.get('my-app')!.metadata).toMatchObject({
      assets: { config: { not_found_handling: 'single-page-application' } },
    });
    // What was detected is kept with the link, so later deploys ask nothing.
    expect(linkFile()).toEqual({
      projectId: id,
      name: 'my-app',
      settings: {
        preset: 'Vite',
        installCommand: 'npm install',
        buildCommand: 'npm run build',
        outputDirectory: 'dist',
        spa: true,
      },
    });
    // The next deploy builds again, without installing what is already there.
    ran = [];
    output = [];
    expect(await cli(['--prod'], { run: builder() })).toBe(0);
    expect(ran).toEqual(['npm run build']);
    expect(output.slice(0, 2)).toEqual([
      'Building: npm run build',
      'Deployed 2 files (0 new) to my-app.',
    ]);
    expect(output.at(-1)).toBe(
      'Production: https://my-app.test-account.workers.dev/',
    );
    // --prebuilt deploys what the last build wrote.
    ran = [];
    expect(await cli(['deploy', '--prebuilt'], { run: builder() })).toBe(0);
    expect(ran).toEqual([]);
    // --json keeps standard output to the result alone.
    output = [];
    expect(await cli(['--json'], { run: builder() })).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toMatchObject({
      project: 'my-app',
      files: 2,
      preview: true,
    });
  });

  it('asks like Vercel the first time: set up, project, what it detected', async () => {
    viteProject();
    const first = answering([]);
    expect(await cli([], { isTTY: true, ask: first.ask, run: builder() })).toBe(
      0,
    );
    expect(first.asked).toEqual([
      `Set up and deploy “${join(dir, 'work')}”? [Y/n] `,
      'Project name [work]: ',
      'Customize settings? [y/N] ',
    ]);
    expect(output.slice(0, 4)).toEqual([
      'Created the project work.',
      'Detected Vite (Build Command: npm run build, Output Directory: dist)',
      'Installing dependencies: npm install',
      'Building: npm run build',
    ]);
    // Linked now: nothing is asked again.
    const again = answering([]);
    expect(await cli([], { isTTY: true, ask: again.ask, run: builder() })).toBe(
      0,
    );
    expect(again.asked).toEqual([]);
  });

  it('lets the person change the commands and the output folder, and keeps them', async () => {
    viteProject();
    write('node_modules/vite/index.js', '');
    const prompts = answering([
      [/^Customize settings/, 'y'],
      [/^Install Command/, '-'],
      [/^Build Command/, 'npx vite build --mode staging'],
      [/^Output Directory/, './out/'],
    ]);
    expect(
      await cli(['--name', 'custom-app'], {
        isTTY: true,
        ask: prompts.ask,
        run: builder('out'),
      }),
    ).toBe(0);
    expect(prompts.asked.slice(2)).toEqual([
      'Customize settings? [y/N] ',
      'Install Command [npm install] (- for none): ',
      'Build Command [npm run build] (- for none): ',
      'Output Directory [dist]: ',
    ]);
    expect(ran).toEqual(['npx vite build --mode staging']);
    expect(linkFile().settings).toEqual({
      preset: 'Vite',
      installCommand: null,
      buildCommand: 'npx vite build --mode staging',
      outputDirectory: 'out',
      spa: true,
    });
    expect(uploaded()).toEqual(['<h1>Built</h1>', 'built()']);
    // Flags change what was saved, and are saved too.
    ran = [];
    expect(
      await cli(['--build-command', 'make site', '--output', 'public'], {
        run: builder('public'),
      }),
    ).toBe(0);
    expect(ran).toEqual(['make site']);
    expect(linkFile().settings).toMatchObject({
      buildCommand: 'make site',
      outputDirectory: 'public',
    });
    // A hand-edited link that no longer makes sense is detected again, not trusted.
    write(
      '.shipcel/project.json',
      JSON.stringify({
        ...linkFile(),
        settings: { ...linkFile().settings, outputDirectory: '../elsewhere' },
      }),
    );
    ran = [];
    expect(await cli(['--yes'], { run: builder() })).toBe(0);
    expect(ran).toEqual(['npm run build']);
    expect(linkFile().settings.outputDirectory).toBe('dist');
    expect(await cli(['--output', '../elsewhere'])).toBe(2);
    expect(errors.pop()).toContain('a folder inside the project');
  });

  it('links to a project that already exists instead of making another', async () => {
    viteProject();
    expect(await cli(['project', 'add', 'work'])).toBe(0);
    expect(await cli(['project', 'add', 'other-site'])).toBe(0);
    const found = answering([]);
    output = [];
    expect(await cli([], { isTTY: true, ask: found.ask, run: builder() })).toBe(
      0,
    );
    expect(found.asked.slice(0, 2)).toEqual([
      `Set up and deploy “${join(dir, 'work')}”? [Y/n] `,
      'Found project “work”. Link to it? [Y/n] ',
    ]);
    expect(output[0]).toBe('Linked to the existing project work.');
    // Or to one with another name, chosen by name.
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    const chosen = answering([
      [/^Found project/, 'n'],
      [/^Project name/, 'other-site'],
    ]);
    output = [];
    expect(
      await cli([], { isTTY: true, ask: chosen.ask, run: builder() }),
    ).toBe(0);
    expect(output[0]).toBe('Linked to the existing project other-site.');
    expect(linkFile().name).toBe('other-site');
    // Saying no to setting up stops before anything is created or built.
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    ran = [];
    expect(
      await cli([], {
        isTTY: true,
        ask: answering([[/^Set up/, 'n']]).ask,
        run: builder(),
      }),
    ).toBe(1);
    expect(errors.pop()).toBe('Nothing was deployed.');
    expect(ran).toEqual([]);
  });

  it('offers existing projects by name when none matches the folder', async () => {
    viteProject();
    expect(await cli(['project', 'add', 'landing'])).toBe(0);
    const prompts = answering([
      [/^Link to existing project/, 'y'],
      [/^Existing project name/, 'landing'],
    ]);
    output = [];
    expect(
      await cli([], { isTTY: true, ask: prompts.ask, run: builder() }),
    ).toBe(0);
    expect(prompts.asked.slice(1, 3)).toEqual([
      'Link to existing project? [y/N] ',
      'Existing project name? ',
    ]);
    expect(output.slice(0, 2)).toEqual([
      'Your projects: landing',
      'Linked to the existing project landing.',
    ]);
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    expect(
      await cli([], {
        isTTY: true,
        ask: answering([
          [/^Link to existing project/, 'y'],
          [/^Existing project name/, 'nope'],
        ]).ask,
        run: builder(),
      }),
    ).toBe(1);
    expect(errors.pop()).toContain('No project nope in your workspace');
  });

  it('asks where the build goes when it doesn’t know the framework', async () => {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'node build.mjs' },
        devDependencies: { metalsmith: '^2.0.0' },
      }),
    );
    write('yarn.lock', '');
    write('node_modules/x/index.js', '');
    write('src/index.md', '# Hello');
    // Without a terminal it can't ask: it says how to tell it.
    expect(await cli(['--yes'], { run: builder('_site') })).toBe(1);
    expect(errors.pop()).toBe(
      'Shipcel doesn’t recognise how this project builds. Say where its build goes: shipcel deploy --output <folder>.',
    );
    expect(ran).toEqual([]);
    // Nothing was set up for a deploy that couldn't happen.
    output = [];
    await cli(['project', 'ls']);
    expect(output).toEqual([
      'No projects yet. Run shipcel deploy, or shipcel init.',
    ]);
    const prompts = answering([[/^Output Directory/, '_site']]);
    output = [];
    expect(
      await cli(['--name', 'notes'], {
        isTTY: true,
        ask: prompts.ask,
        run: builder('_site'),
      }),
    ).toBe(0);
    expect(output).toContain(
      'No framework detected (Build Command: yarn run build)',
    );
    expect(prompts.asked.slice(2)).toEqual([
      'Output Directory: ',
      'Customize settings? [y/N] ',
    ]);
    expect(ran).toEqual(['yarn run build']);
    expect(linkFile().settings).toEqual({
      preset: 'Other',
      installCommand: 'yarn install',
      buildCommand: 'yarn run build',
      outputDirectory: '_site',
      spa: false,
    });
    // Several pages and no preset: unknown paths aren't sent to index.html.
    write('_site/about.html', '<h1>About</h1>');
    expect(await cli(['--prod', '--prebuilt'])).toBe(0);
    expect(fx.state.workers.get('notes')!.metadata).toMatchObject({
      assets: { config: { not_found_handling: 'none' } },
    });
  });

  it('builds anything whose command and folder are named, without Node', async () => {
    write('content/index.md', '# Hello');
    expect(await cli(['--yes', '--build-command', 'hugo'])).toBe(2);
    expect(errors.pop()).toBe(
      'Say where the build goes too: --output <folder>.',
    );
    expect(
      await cli(
        [
          '--yes',
          '--name',
          'blog',
          '--build-command',
          'hugo',
          '--output',
          'public',
        ],
        { run: builder('public') },
      ),
    ).toBe(0);
    expect(ran).toEqual(['hugo']);
    expect(uploaded()).toEqual(['<h1>Built</h1>', 'built()']);
    expect(linkFile().settings).toEqual({
      preset: 'Other',
      installCommand: null,
      buildCommand: 'hugo',
      outputDirectory: 'public',
      spa: false,
    });
  });

  it('uploads a static export when its output folder is named, whatever the framework', async () => {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'next build' },
        dependencies: { next: '16.3.8', react: '19' },
      }),
    );
    expect(
      await cli(['--yes', '--name', 'exported', '--output', 'out'], {
        run: builder('out'),
      }),
    ).toBe(0);
    expect(ran).toEqual(['npm install', 'npm run build']);
    expect(uploaded()).toEqual(['<h1>Built</h1>', 'built()']);
    // The folder was set up as a static build, so the next deploy is one too.
    ran = [];
    expect(await cli([], { run: builder('out') })).toBe(0);
    expect(errors).toEqual([]);
    expect(ran).toEqual(['npm run build']);
  });

  it('sends a new app’s first deploy to production, like Vercel, and says which with --target', async () => {
    write('site/index.html', '<h1>Hello</h1>');
    // A folder of files is asked for its home page too.
    const asked: string[] = [];
    apps = (url) => {
      asked.push(url);
      return new Response('<h1>Hello</h1>');
    };
    expect(await cli(['site', '--yes', '--name', 'first-app'])).toBe(0);
    expect(asked).toEqual(['https://first-app.test-account.workers.dev/']);
    expect(output.slice(-3)).toEqual([
      'Preview: https://00000001-first-app.test-account.workers.dev',
      'Production: https://first-app.test-account.workers.dev/',
      'A new app’s first deploy goes to production. From now on, shipcel deploys a preview and shipcel --prod deploys to production.',
    ]);
    expect(fx.state.route).toMatchObject({ enabled: true });
    // The second is a preview; production keeps serving the first.
    write('site/index.html', '<h1>Next</h1>');
    output = [];
    expect(await cli(['site'])).toBe(0);
    expect(output.at(-1)).toBe(
      'Production: https://first-app.test-account.workers.dev/ (unchanged). To make this version production: shipcel promote 00000002',
    );
    expect(fx.state.live).toBe('00000001-0000-4000-8000-000000000000');
    // --target says it either way; an explicit production deploy needs no explanation.
    output = [];
    expect(await cli(['site', '--target', 'production'])).toBe(0);
    expect(output.at(-1)).toBe(
      'Production: https://first-app.test-account.workers.dev/',
    );
    expect(fx.state.live).toBe('00000003-0000-4000-8000-000000000000');
    expect(await cli(['site', '--target', 'staging'])).toBe(2);
    expect(errors.pop()).toBe('--target takes preview or production.');
    expect(await cli(['site', '--prod', '--target', 'preview'])).toBe(2);
    expect(errors.pop()).toBe(
      '--prod and --target preview say different things.',
    );
    expect(fx.state.live).toBe('00000003-0000-4000-8000-000000000000');
  });

  it('stops when the build fails or writes somewhere else, and deploys nothing', async () => {
    viteProject();
    expect(
      await cli(['--yes', '--name', 'broken'], { run: builder('dist', 1) }),
    ).toBe(1);
    expect(errors.pop()).toBe(
      'npm install failed (exit code 1). If npm stopped with “Cannot read properties of null (reading ‘edgesOut’)” or “Unable to resolve reference”, that is npm 10: npm 11 installs these apps (npm install -g npm@11). Nothing was deployed.',
    );
    expect(ran).toEqual(['npm install']);
    write('node_modules/vite/index.js', '');
    ran = [];
    expect(await cli([], { run: builder('dist', 2) })).toBe(1);
    expect(errors.pop()).toBe(
      'npm run build failed (exit code 2). Nothing was deployed.',
    );
    expect(await cli([], { run: builder('elsewhere') })).toBe(1);
    expect(errors.pop()).toBe(
      'The build finished, but dist doesn’t exist. Say which folder your build writes: shipcel deploy --output <folder>.',
    );
    expect(await cli(['--prebuilt'])).toBe(1);
    expect(errors.pop()).toBe(
      'dist doesn’t exist yet. Build first: shipcel build.',
    );
    // A build that leaves no page is more likely the wrong folder than a site.
    write('dist/readme.txt', 'not a site');
    expect(await cli(['--prebuilt'])).toBe(1);
    expect(errors.pop()).toContain(
      'dist has no index.html. If your build writes somewhere else, say so: shipcel deploy --output <folder>.',
    );
    expect(fx.state.calls).toEqual([]);
  });

  it('refuses a project’s source named as the folder to upload', async () => {
    write(
      'app/package.json',
      JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^8.0.0' },
      }),
    );
    write('app/index.html', '<div id="app">source</div>');
    expect(await cli(['deploy', 'app', '--yes'])).toBe(1);
    expect(errors.pop()).toBe(
      'app is a project’s source, not built files. Build and deploy it from its own folder: shipcel --cwd app',
    );
    expect(fx.state.calls).toEqual([]);
    // From its own folder it builds, and links there.
    expect(
      await cli(['--cwd', 'app', '--yes'], {
        run: async (command, cwd) => {
          expect(cwd).toBe(join(dir, 'work', 'app'));
          ran.push(command);
          if (command === 'npm run build')
            write('app/dist/index.html', '<h1>Built</h1>');
          else write('app/node_modules/vite/index.js', '');
          return 0;
        },
      }),
    ).toBe(0);
    expect(ran).toEqual(['npm install', 'npm run build']);
    expect(
      existsSync(join(dir, 'work', 'app', '.shipcel', 'project.json')),
    ).toBe(true);
    expect(uploaded()).toEqual(['<h1>Built</h1>']);
  });

  it('keeps the link out of Git, as Vercel does with .vercel', async () => {
    viteProject();
    write('.git/config', '[core]\n\tbare = false\n');
    write('.gitignore', 'node_modules\ndist');
    expect(await cli(['--yes', '--name', 'in-git'], { run: builder() })).toBe(
      0,
    );
    expect(output[1]).toBe('Added .shipcel to .gitignore.');
    expect(readFileSync(join(dir, 'work', '.gitignore'), 'utf8')).toBe(
      'node_modules\ndist\n.shipcel\n',
    );
    output = [];
    expect(await cli([], { run: builder() })).toBe(0);
    expect(output).not.toContain('Added .shipcel to .gitignore.');
    // An entry that already covers it is left alone.
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    write('.gitignore', '/.shipcel/\n');
    expect(await cli(['--yes', '--name', 'in-git'], { run: builder() })).toBe(
      0,
    );
    expect(readFileSync(join(dir, 'work', '.gitignore'), 'utf8')).toBe(
      '/.shipcel/\n',
    );
  });

  it('offers GitHub deploys for a repository’s folder, and deploys from here unless asked', async () => {
    viteProject();
    write(
      '.git/config',
      '[remote "origin"]\n\turl = https://github.com/ada/site.git\n',
    );
    // --yes takes the defaults: nothing is asked, and nothing is connected.
    const quiet = answering([]);
    expect(
      await cli(['--yes', '--name', 'from-here'], {
        isTTY: true,
        ask: quiet.ask,
        run: builder(),
      }),
    ).toBe(0);
    expect(quiet.asked).toEqual([]);
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    // Asked, the answer defaults to no: the site is built and uploaded from this computer.
    const prompts = answering([[/^Project name/, 'also-here']]);
    ran = [];
    expect(
      await cli([], { isTTY: true, ask: prompts.ask, run: builder() }),
    ).toBe(0);
    expect(prompts.asked.slice(1)).toEqual([
      'Link to existing project? [y/N] ',
      'Project name [work]: ',
      'Connect ada/site so every push deploys, built by GitHub Actions? [y/N] ',
      'Customize settings? [y/N] ',
    ]);
    expect(ran).toEqual(['npm run build']);
    expect(linkFile().name).toBe('also-here');
    expect(
      db.sqlite
        .prepare("SELECT name FROM projects WHERE source='github'")
        .all(),
    ).toEqual([]);
  });

  it('asks before a project set up for GitHub starts deploying from this computer', async () => {
    viteProject();
    write('node_modules/vite/index.js', '');
    const created = await toShipcel('https://shipcel.test/api/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'my-app',
        framework: 'react',
        source: 'github',
        repository: 'https://github.com/ada/site',
      }),
    });
    expect(created.status).toBe(201);
    expect(await cli(['link', '--project', 'my-app'])).toBe(0);
    // It hasn't deployed from GitHub yet, so it can still start from here: a choice, once.
    expect(await cli([], { run: builder() })).toBe(1);
    expect(errors.pop()).toBe(
      'my-app is set up to deploy ada/site from GitHub and hasn’t yet. Deploy it from this computer instead? It then stays a project you deploy from here. Pass --yes to confirm in scripts.',
    );
    expect(ran).toEqual([]);
    expect(
      await cli([], {
        isTTY: true,
        ask: async () => 'n',
        run: builder(),
      }),
    ).toBe(1);
    expect(errors.pop()).toBe('Nothing was changed.');
    expect(fx.state.calls).toEqual([]);
    expect(await cli(['--prod', '--yes'], { run: builder() })).toBe(0);
    expect(output.at(-1)).toBe(
      'Production: https://my-app.test-account.workers.dev/',
    );
    // From then on it is a project deployed from here: nothing more to confirm.
    expect(await cli([], { run: builder() })).toBe(0);
  });

  it('doesn’t build a project that deploys from GitHub', async () => {
    viteProject();
    const who = db.sqlite
      .prepare('SELECT user_id, workspace_id FROM api_tokens')
      .get() as { user_id: string; workspace_id: string };
    expect(await cli(['project', 'add', 'from-git'])).toBe(0);
    expect(await cli(['link', '--project', 'from-git'])).toBe(0);
    // Before its first deployment, a project can still start either way.
    expect(await cli([], { run: builder() })).toBe(0);
    db.sqlite
      .prepare(
        "UPDATE deployment_jobs SET adapter='static-assets', repository_name='ada/site', branch='main' WHERE workspace_id=? AND created_by=?",
      )
      .run(who.workspace_id, who.user_id);
    ran = [];
    expect(await cli([], { run: builder() })).toBe(1);
    expect(errors.pop()).toBe(
      'from-git deploys from GitHub (ada/site, main): push to deploy it, or run shipcel redeploy.',
    );
    expect(ran).toEqual([]);
  });

  it('builds without deploying, and without signing in', async () => {
    viteProject();
    const offline = (async () => {
      throw new Error('no network');
    }) as typeof globalThis.fetch;
    expect(await run(['build'], io(offline, { run: builder() }))).toBe(0);
    expect(output).toEqual([
      'Installing dependencies: npm install',
      'Building: npm run build',
      'Built dist. Deploy it with shipcel deploy --prebuilt.',
    ]);
    expect(linkFile()).toEqual({
      settings: {
        preset: 'Vite',
        installCommand: 'npm install',
        buildCommand: 'npm run build',
        outputDirectory: 'dist',
        spa: true,
      },
    });
    expect(await run(['build'], io(offline, { run: builder('dist', 3) }))).toBe(
      1,
    );
    expect(errors.pop()).toBe('npm run build failed (exit code 3).');
    // The folder isn't linked to a project yet: the first deploy still sets one up.
    expect(await cli(['--prebuilt', '--yes', '--name', 'built-first'])).toBe(0);
    expect(linkFile()).toMatchObject({
      name: 'built-first',
      settings: { outputDirectory: 'dist' },
    });
    rmSync(join(dir, 'work'), { recursive: true });
    mkdirSync(join(dir, 'work'));
    expect(await run(['build'], io(offline))).toBe(1);
    expect(errors.pop()).toContain('There is nothing to build here');
  });

  it('finishes connecting Cloudflare in the browser before it builds', async () => {
    viteProject();
    const who = db.sqlite
      .prepare(
        'SELECT user_id AS userId, workspace_id AS workspaceId FROM api_tokens',
      )
      .get() as { userId: string; workspaceId: string };
    db.sqlite
      .prepare("DELETE FROM provider_grants WHERE provider='cloudflare'")
      .run();
    // Without a terminal: what to do, and nothing built.
    expect(await cli(['--yes'], { run: builder() })).toBe(1);
    expect(errors.pop()).toBe(
      [
        'Shipcel deploys into your own Cloudflare account, and it isn’t connected yet.',
        'Connect it in your browser: https://shipcel.test/app/#cli-setup',
        'Then run the command again.',
      ].join('\n'),
    );
    expect(ran).toEqual([]);
    // Connected, but to several accounts with none chosen: the same page lists them.
    await db.grant({ ...who, raw: '', cookie: '' }, 'cloudflare');
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET account_id=NULL, account_name=NULL WHERE provider='cloudflare'",
      )
      .run();
    expect(await cli(['--yes'], { run: builder() })).toBe(1);
    expect(errors.pop()).toBe(
      [
        'Your Cloudflare connection reaches several accounts, and none is chosen for your apps yet.',
        'Choose it in your browser: https://shipcel.test/app/#cli-setup',
        'Then run the command again.',
      ].join('\n'),
    );
    db.sqlite
      .prepare("DELETE FROM provider_grants WHERE provider='cloudflare'")
      .run();
    // In a terminal: the page opens, and the deploy carries on once it's connected.
    let waits = 0;
    expect(
      await cli(['--yes', '--name', 'waited'], {
        isTTY: true,
        run: builder(),
        sleep: async () => {
          if (++waits === 2)
            await db.grant({ ...who, raw: '', cookie: '' }, 'cloudflare');
        },
      }),
    ).toBe(0);
    expect(opened).toEqual(['https://shipcel.test/app/#cli-setup']);
    expect(output.slice(0, 5)).toEqual([
      'Shipcel deploys into your own Cloudflare account, and it isn’t connected yet.',
      'Connect it in your browser: https://shipcel.test/app/#cli-setup',
      'Waiting for Cloudflare… (Ctrl+C stops; nothing is lost.)',
      'Connected Cloudflare: Test Cloud.',
      'Created the project waited.',
    ]);
    expect(ran).toEqual(['npm install', 'npm run build']);
  });

  it('says who you are, where, and whether Cloudflare is connected', async () => {
    expect(await cli(['whoami'])).toBe(0);
    expect(output).toEqual([
      'Signed in as user-1 (owner) on https://shipcel.test.',
      'Workspace: workspace-1 · Cloudflare: Test Cloud',
    ]);
    db.sqlite
      .prepare("DELETE FROM provider_grants WHERE provider='cloudflare'")
      .run();
    output = [];
    expect(await cli(['whoami'])).toBe(0);
    expect(output[1]).toBe(
      'Workspace: workspace-1 · Cloudflare: not connected (run shipcel login)',
    );
  });
});

describe('shipcel deploys apps with code and bindings, against the real Shipcel API', () => {
  let db: ReturnType<typeof database>;
  let fx: ReturnType<typeof cloudflareWrangler>;
  let token: string;
  // The environment the CLI gave each Wrangler run.
  let envs: Record<string, string | undefined>[];
  // What Wrangler's setup was run with.
  let setups: Record<string, string | undefined>[];
  // Commands run without their output on the terminal.
  let quietly: string[];
  const toShipcel = ((url: string, init: RequestInit) =>
    app.request(url, init, db.env)) as typeof globalThis.fetch;
  const cli = (args: string[], overrides: Partial<Io> = {}) =>
    run(
      args,
      io(toShipcel, overrides, {
        SHIPCEL_URL: 'https://shipcel.test',
        SHIPCEL_TOKEN: token,
      }),
    );

  beforeEach(async () => {
    db = database();
    const who = await db.user(1);
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    fx = cloudflareWrangler();
    vi.stubGlobal('fetch', vi.fn(fx.handler));
    envs = [];
    setups = [];
    quietly = [];
    token = (
      (await (
        await db.request(
          '/tokens',
          { method: 'POST', body: JSON.stringify({ name: 'CLI test' }) },
          who.cookie,
        )
      ).json()) as { token: string }
    ).token;
  });
  afterEach(() => db.close());

  const projects = async () =>
    (await (
      await toShipcel('https://shipcel.test/api/projects', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { id: string; name: string; framework: string }[];
  const linkFile = () =>
    JSON.parse(
      readFileSync(join(dir, 'work', '.shipcel', 'project.json'), 'utf8'),
    );
  const config = {
    name: 'api',
    main: 'src/index.js',
    compatibility_date: '2026-10-07',
    d1_databases: [{ binding: 'DB' }],
  };
  function workerApp(extra: Record<string, unknown> = {}) {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'node build.js' },
        devDependencies: { wrangler: '^4.100.0' },
      }),
    );
    write('wrangler.jsonc', JSON.stringify({ ...config, ...extra }));
    write(
      'src/index.js',
      'export default { fetch() { return new Response("ok"); } };\n',
    );
  }
  const note =
    '  Note: Wrangler creates these resources in your Cloudflare account during the deploy and binds them to the app. Later deploys reuse them. Database migrations are not applied automatically.';
  // Stands in for the tools the CLI runs: installs, builds, Wrangler's setup, and Wrangler
  // itself, which makes the calls the real one makes with the address and token it was
  // given (tests/local-deploys.test.ts and the last test here run the real one).
  const tools =
    (
      stop?:
        | 'before-upload'
        | 'after-upload'
        | 'setup'
        | 'no-setup'
        | 'no-types'
        | 'no-look'
        | 'no-report'
        | 'unknown',
    ) =>
    async (
      command: string,
      _cwd: string,
      env: Record<string, string | undefined> = {},
      quiet = false,
    ) => {
      ran.push(command);
      if (quiet) quietly.push(command);
      if (/ install$/.test(command)) {
        write('node_modules/.package-lock.json', '{}');
        return 0;
      }
      if (/ run cf-typegen$/.test(command)) return stop === 'no-types' ? 1 : 0;
      // A dry run of Wrangler's setup: it reports the framework it recognised.
      if (/ setup --yes --dry-run$/.test(command)) {
        if (stop === 'no-look') return 1;
        if (stop === 'no-report') return 0;
        writeFileSync(
          env.WRANGLER_OUTPUT_FILE_PATH!,
          `${JSON.stringify({ type: 'wrangler-session', version: 1 })}\n${JSON.stringify(
            {
              type: 'autoconfig',
              version: 1,
              command: 'setup',
              summary: { frameworkId: stop === 'unknown' ? 'static' : 'next' },
            },
          )}\n`,
        );
        return 0;
      }
      if (/ setup( --yes)?$/.test(command)) {
        setups.push(env);
        if (stop === 'setup') return 1;
        if (stop === 'no-setup') return 0;
        write(
          'package.json',
          JSON.stringify({
            scripts: { build: 'next build', 'cf-typegen': 'wrangler types' },
            dependencies: {
              next: '16.3.8',
              react: '19',
              '@opennextjs/cloudflare': '1.20.9',
            },
          }),
        );
        write('open-next.config.ts', 'export default {};');
        write(
          'wrangler.jsonc',
          JSON.stringify({
            name: 'shop',
            main: '.open-next/worker.js',
            compatibility_date: '2026-10-07',
            compatibility_flags: ['nodejs_compat'],
            assets: { directory: '.open-next/assets', binding: 'ASSETS' },
            services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shop' }],
          }),
        );
        return 0;
      }
      if (!command.includes('wrangler')) return 0;
      envs.push(env);
      const name = / --name (\S+)/.exec(command)![1];
      const call = async (path: string, init: RequestInit = {}) =>
        toShipcel(
          `${env.CLOUDFLARE_API_BASE_URL}${path}`,
          await sized({
            ...init,
            headers: {
              Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              ...(typeof init.body === 'string'
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
          }),
        );
      const root = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
      const script = `${root}/workers/scripts/${name}`;
      const form = (bindings: unknown[]) => {
        const body = new FormData();
        body.set(
          'metadata',
          JSON.stringify({ main_module: 'index.js', bindings }),
        );
        body.set(
          'index.js',
          new File(['export default {}'], 'index.js', {
            type: 'application/javascript+module',
          }),
        );
        return body;
      };
      const settings = (await (await call(`${script}/settings`)).json()) as {
        success: boolean;
        result: { bindings: { name: string }[] } | null;
      };
      const wants = name !== 'shop';
      let bindings: unknown[] = wants ? [{ name: 'DB', type: 'inherit' }] : [];
      if (wants && !settings.result?.bindings.some((b) => b.name === 'DB')) {
        const made = (await (
          await call(`${root}/d1/database`, {
            method: 'POST',
            body: JSON.stringify({ name: `${name}-db` }),
          })
        ).json()) as { result: { uuid: string } };
        bindings = [{ name: 'DB', type: 'd1', id: made.result.uuid }];
      }
      // An app named rooms has a Durable Object.
      if (name === 'rooms')
        bindings = [
          ...bindings,
          {
            name: 'ROOMS',
            type: 'durable_object_namespace',
            class_name: 'Room',
          },
        ];
      if (stop === 'before-upload') return 1;
      if (command.includes('versions upload')) {
        await call(`${script}/versions`, {
          method: 'POST',
          body: form(bindings),
        });
        return 0;
      }
      await call(script, { method: 'PUT', body: form(bindings) });
      if (stop === 'after-upload') return 1;
      await call(`${script}/subdomain`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      });
      return 0;
    };

  it('deploys a Worker and its database from the folder, with nothing set up in Cloudflare', async () => {
    workerApp();
    expect(await cli(['--yes'], { run: tools() })).toBe(0);
    expect(errors).toEqual([]);
    const [project] = await projects();
    expect(project).toMatchObject({ name: 'work', framework: 'worker' });
    const inspect = `Inspect: https://shipcel.test/app/#projects/${project.id}/deployments`;
    expect(output).toEqual([
      'Created the project work.',
      'Detected Wrangler configuration (Build Command: npm run build)',
      note,
      'Cloudflare creates the D1 database work-db for this app.',
      'Installing dependencies: npm install',
      'Building: npm run build',
      'Deploying work with Wrangler 4.156.0…',
      'Deployed work to production.',
      inspect,
      'Preview: https://00000001-work.test-account.workers.dev',
      'Production: https://work.test-account.workers.dev/',
      'A new app’s first deploy goes to production. From now on, shipcel deploys a preview and shipcel --prod deploys to production.',
    ]);
    // The same command Shipcel's GitHub deployments run, pointed at Shipcel with a token
    // of its own: never the CLI's token, and never one of Cloudflare's.
    expect(ran).toEqual([
      'npm install',
      'npm run build',
      'npx --yes wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name work',
    ]);
    expect(envs[0].CLOUDFLARE_API_BASE_URL).toMatch(
      /^https:\/\/shipcel\.test\/api\/wrangler\/[0-9a-f-]{36}\/client\/v4$/,
    );
    expect(envs[0]).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: account,
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    });
    expect(envs[0].CLOUDFLARE_API_TOKEN).toMatch(/^[\w-]{43}$/);
    expect(envs[0].CLOUDFLARE_API_TOKEN).not.toBe(token);
    // Credentials of the person's own that Wrangler would otherwise use are cleared.
    for (const name of ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL'])
      expect(name in envs[0] && envs[0][name] === undefined).toBe(true);
    expect(fx.state.d1.map((d) => d.name)).toEqual(['work-db']);
    expect(fx.state.workers.get('work')!.bindings).toEqual([
      { name: 'DB', type: 'd1', id: fx.state.d1[0].uuid },
    ]);
    expect(linkFile()).toEqual({ projectId: project.id, name: 'work' });

    // The next deploy is a preview: a version of its own, production untouched.
    ran = [];
    output = [];
    expect(await cli([], { run: tools() })).toBe(0);
    expect(output).toEqual([
      'Detected Wrangler configuration (Build Command: npm run build)',
      note,
      'Building: npm run build',
      'Uploading a preview of work with Wrangler 4.156.0…',
      'Uploaded a preview of work.',
      inspect,
      'Preview: https://00000002-work.test-account.workers.dev',
      'Production: https://work.test-account.workers.dev/ (unchanged). To make this version production: shipcel promote 00000002',
    ]);
    expect(ran).toEqual([
      'npm run build',
      'npx --yes wrangler@4.156.0 versions upload --x-provision --x-auto-create --name work --message "Preview from Shipcel"',
    ]);
    expect(fx.state.live).toBe('00000001-0000-4000-8000-000000000000');
    expect(fx.state.d1).toHaveLength(1);
    // --prod deploys. A newer Wrangler of the project's own isn't run (Wrangler's setup
    // installs the newest): Shipcel lets through the calls of the version it knows.
    write('node_modules/wrangler/package.json', '{"version":"4.150.2"}');
    ran = [];
    output = [];
    expect(await cli(['--prod', '--prebuilt'], { run: tools() })).toBe(0);
    expect(ran).toEqual([
      'npx --yes wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name work',
    ]);
    expect(output).toContain('Deploying work with Wrangler 4.156.0…');
    expect(output.at(-1)).toBe(
      'Production: https://work.test-account.workers.dev/',
    );
    expect(fx.state.live).toBe('00000003-0000-4000-8000-000000000000');
    // The rest of the CLI reads the app like any other.
    output = [];
    expect(await cli(['ls'])).toBe(0);
    expect(output.join('\n')).toContain('Production 100%');
    expect(output.join('\n')).toContain(
      'https://00000002-work.test-account.workers.dev',
    );
    output = [];
    expect(
      await cli(['--json', '--prod', '--prebuilt'], { run: tools() }),
    ).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toMatchObject({
      project: 'work',
      adapter: 'configured-worker',
      preview: false,
      url: 'https://work.test-account.workers.dev/',
    });
  });

  it('deploys a Worker that has a Wrangler configuration and no package.json', async () => {
    workerApp();
    rmSync(join(dir, 'work', 'package.json'));
    expect(await cli(['--yes'], { run: tools() })).toBe(0);
    expect(errors).toEqual([]);
    // Nothing to install and nothing to build: Wrangler bundles the Worker itself.
    expect(ran).toEqual([
      'npx --yes wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name work',
    ]);
    expect(output).toContain(
      'Detected Wrangler configuration (Build Command: none)',
    );
    expect(output).toContain('Deployed work to production.');
    expect(fx.state.workers.get('work')!.bindings).toEqual([
      { name: 'DB', type: 'd1', id: fx.state.d1[0].uuid },
    ]);
  });

  it('makes the types a build checks again before every build, quietly', async () => {
    // SvelteKit's adapter: the build first checks Wrangler's generated types, which are
    // out of date once a first build has written the app's entry point (seen live).
    workerApp();
    write(
      'package.json',
      JSON.stringify({
        scripts: {
          build: 'wrangler types --check && node build.js',
          'cf-typegen': 'wrangler types',
        },
      }),
    );
    expect(await cli(['--yes'], { run: tools() })).toBe(0);
    expect(ran).toEqual([
      'npm install',
      'npm run cf-typegen',
      'npm run build',
      'npx --yes wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name work',
    ]);
    expect(quietly).toEqual(['npm run cf-typegen']);
    expect(output).toContain('Generating types: npm run cf-typegen');
    // Again on the next deploy, and for shipcel build.
    ran = [];
    expect(await cli([], { run: tools() })).toBe(0);
    expect(ran.slice(0, 2)).toEqual(['npm run cf-typegen', 'npm run build']);
    ran = [];
    expect(await cli(['build'], { run: tools() })).toBe(0);
    expect(ran).toEqual(['npm run cf-typegen', 'npm run build']);
    // Types that couldn't be made are said, and the build goes on.
    ran = [];
    output = [];
    expect(await cli(['--prod'], { run: tools('no-types') })).toBe(0);
    expect(output).toContain(
      '  Note: npm run cf-typegen didn’t finish. If the build asks for generated types, run it yourself.',
    );
    expect(ran).toContain('npm run build');
    // A build that doesn't check them leaves them alone.
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'node build.js', 'cf-typegen': 'wrangler types' },
      }),
    );
    ran = [];
    expect(await cli(['--prod'], { run: tools() })).toBe(0);
    expect(ran).not.toContain('npm run cf-typegen');
  });

  it('says when the new version answers a server error at its home page', async () => {
    workerApp();
    const asked: string[] = [];
    apps = (url) => {
      asked.push(url);
      return new Response('boom', { status: 500 });
    };
    expect(await cli(['--yes'], { run: tools() })).toBe(0);
    // The deploy went through; it is asked a few times while a new address comes up.
    expect(output.at(-1)).toBe(
      'Heads up: https://work.test-account.workers.dev/ answers 500. The deploy went through, but the app fails at its home page. Its logs say why (shipcel logs --since 10m); shipcel rollback goes back to the version before.',
    );
    expect(asked).toEqual(
      Array(3).fill('https://work.test-account.workers.dev/'),
    );
    // A preview is asked at its own address; an answer below 500 is the app's own.
    asked.length = 0;
    apps = (url) => {
      asked.push(url);
      return new Response('Not found', { status: 404 });
    };
    output = [];
    expect(await cli([], { run: tools() })).toBe(0);
    expect(asked).toEqual(['https://00000002-work.test-account.workers.dev']);
    expect(output.join('\n')).not.toContain('Heads up');
    // No answer at all is said differently.
    apps = () => Promise.reject(new TypeError('fetch failed'));
    output = [];
    expect(await cli(['--prod'], { run: tools() })).toBe(0);
    expect(output.at(-1)).toBe(
      'Heads up: https://work.test-account.workers.dev/ didn’t answer within 24 seconds. A new address can take a minute; if it still doesn’t answer, the app’s logs say why (shipcel logs --since 10m).',
    );
    // Scripts reading --json get one line, and the check isn't made.
    asked.length = 0;
    apps = (url) => {
      asked.push(url);
      return new Response('boom', { status: 500 });
    };
    output = [];
    expect(await cli(['--prod', '--json'], { run: tools() })).toBe(0);
    expect(output).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('says so when Cloudflare gives a version no preview address', async () => {
    workerApp();
    expect(await cli(['--yes', '--name', 'rooms'], { run: tools() })).toBe(0);
    expect(errors).toEqual([]);
    // A Worker with a Durable Object gets none: no address is made up for it.
    expect(output).toContain(
      'Preview: none. Cloudflare gives a Worker with a Durable Object no preview addresses, so this version has none of its own.',
    );
    expect(output.join('\n')).not.toContain('00000001-rooms');
    expect(output).toContain(
      'Production: https://rooms.test-account.workers.dev/',
    );
    output = [];
    expect(await cli(['ls'])).toBe(0);
    expect(output.join('\n')).toContain('Production 100%');
    expect(output.join('\n')).not.toContain('00000001-rooms');
  });

  it('asks before Cloudflare creates anything, and says what it can’t deploy before building', async () => {
    workerApp();
    const asked: string[] = [];
    const replies = (create: string) => ({
      isTTY: true,
      run: tools(),
      ask: async (question: string) => {
        asked.push(question);
        return /Go ahead/.test(question) ? create : '';
      },
    });
    expect(await cli([], replies('n'))).toBe(1);
    expect(errors.pop()).toBe('Nothing was deployed.');
    expect(asked.at(-1)).toBe(
      'This deploy creates the D1 database work-db in your Cloudflare account. Go ahead? [Y/n] ',
    );
    expect(ran).toEqual([]);
    expect(fx.state.d1).toEqual([]);
    expect(await cli([], replies(''))).toBe(0);
    expect(fx.state.d1).toHaveLength(1);
    // A script says so with --yes.
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    await cli(['project', 'add', 'second']);
    ran = [];
    expect(await cli(['--project', 'second'], { run: tools() })).toBe(1);
    expect(errors.pop()).toBe(
      'This deploy creates the D1 database second-db in your Cloudflare account. Pass --yes to confirm in scripts.',
    );
    expect(ran).toEqual([]);
    // Settings Shipcel doesn't deploy stop it before a project exists or anything builds.
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    workerApp({ routes: ['example.com/*'], name: 'routed' });
    const before = (await projects()).length;
    expect(await cli(['--yes', '--name', 'routed'], { run: tools() })).toBe(1);
    // The answer names the folder and the file it is about: started one folder too high,
    // a deploy reviews some other project's configuration.
    const [where, what] = errors.pop()!.split('\n');
    expect(where).toBe(
      `The app in ${join(dir, 'work')} (wrangler.jsonc) can’t deploy yet:`,
    );
    expect(what).toMatch(
      /^ {2}- Shipcel doesn’t deploy these Wrangler settings yet: routes\./,
    );
    expect(ran).toEqual([]);
    expect(await projects()).toHaveLength(before);
    // A database that already exists (an ID or a name in the configuration) isn't
    // attached: said in the words of someone at a terminal.
    workerApp({
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'cloudcel-local',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: 'migrations',
        },
      ],
    });
    expect(await cli(['deploy', '--prod'], { run: tools() })).toBe(1);
    expect(errors.pop()).toBe(
      `The app in ${join(dir, 'work')} (wrangler.jsonc) can’t deploy yet:\n  - Shipcel can’t deploy the D1 databases the way the Wrangler configuration declares them. It creates what an app needs and can’t attach one that already exists yet: give each entry only "binding" (and migrations_dir), without database_id or database_name, five at most.`,
    );
    expect(ran).toEqual([]);
    expect(await projects()).toHaveLength(before);
  });

  it('offers Wrangler’s setup to a framework that has no Cloudflare adapter yet', async () => {
    const nextApp = () => {
      for (const name of ['wrangler.jsonc', 'open-next.config.ts'])
        rmSync(join(dir, 'work', name), { force: true });
      write(
        'package.json',
        JSON.stringify({
          scripts: { build: 'next build' },
          dependencies: { next: '16.3.8', react: '19' },
        }),
      );
    };
    nextApp();
    // Without a terminal nothing in the project is changed unasked.
    expect(await cli([], { run: tools() })).toBe(1);
    expect(errors.pop()).toBe(
      'This is a Next.js app, which needs its Cloudflare adapter and a Wrangler configuration before it can deploy. Pass --yes and shipcel adds them (Wrangler’s setup changes package.json and writes wrangler.jsonc), then deploys.',
    );
    expect(ran).toEqual([]);
    const asked: string[] = [];
    const terminal = (add: string, stop?: Parameters<typeof tools>[0]) => ({
      isTTY: true,
      run: tools(stop),
      ask: async (question: string) => {
        asked.push(question);
        return /Add them now/.test(question) ? add : '';
      },
    });
    expect(await cli([], terminal('n'))).toBe(1);
    expect(errors.pop()).toBe(
      'Nothing was changed. Run shipcel again when you want the adapter added.',
    );
    expect(asked).toEqual([
      'Add them now? Wrangler changes files in this folder (package.json and its configuration). [Y/n] ',
    ]);
    expect(ran).toEqual([]);
    expect(await cli([], terminal('y', 'setup'))).toBe(1);
    expect(errors.pop()).toBe(
      'Wrangler’s setup failed (exit code 1); its output above says why. Nothing was deployed.',
    );
    ran = [];
    expect(await cli([], terminal('y', 'no-setup'))).toBe(1);
    expect(errors.pop()).toContain(
      'Wrangler’s setup left no Wrangler configuration for this Next.js app.',
    );
    expect(await projects()).toEqual([]);
    // Agreed: Wrangler sets the app up, and it deploys under its configured name.
    rmSync(join(dir, 'work', 'node_modules'), { recursive: true, force: true });
    ran = [];
    quietly = [];
    output = [];
    expect(await cli([], terminal(''))).toBe(0);
    expect(errors).toEqual([]);
    // Wrangler's setup reads the installed packages, so they are installed first. Having
    // agreed once, the person is asked nothing more. (A Next.js build doesn't check the
    // generated types, so they aren't made.)
    expect(ran).toEqual([
      'npm install',
      'npx --yes wrangler@4.156.0 setup --yes --dry-run',
      'npx --yes wrangler@4.156.0 setup --yes',
      'npx opennextjs-cloudflare build',
      'npx --yes wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name shop',
    ]);
    // The report of the dry run isn't left behind. The check is run without its output on
    // the terminal (it is shown if it fails); the setup itself, the build and the deploy
    // are watched.
    expect(existsSync(join(dir, 'config', 'wrangler-setup.json'))).toBe(false);
    expect(quietly).toEqual([
      'npx --yes wrangler@4.156.0 setup --yes --dry-run',
    ]);
    expect(asked.filter((q) => /Add them now/.test(q))).toHaveLength(4);
    // Setup can't reach Cloudflare: not with a sign-in of its own (an adapter's installer
    // would open Wrangler's), not with the person's, and not through the deploy's session.
    expect(setups.at(-1)).toMatchObject({
      CLOUDFLARE_API_TOKEN: 'shipcel-setup-has-no-cloudflare-access',
      CI: 'true',
    });
    for (const name of [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_KEY',
      'CLOUDFLARE_EMAIL',
      'CLOUDFLARE_API_BASE_URL',
    ])
      expect(setups.at(-1)![name]).toBeUndefined();
    expect(envs.at(-1)!.CLOUDFLARE_API_TOKEN).not.toBe(
      setups.at(-1)!.CLOUDFLARE_API_TOKEN,
    );
    expect(output).toContain(
      'This is a Next.js app. On Cloudflare it runs through an adapter and a Wrangler configuration, which this project doesn’t have yet.',
    );
    expect(output).toContain(
      'Detected Next.js (OpenNext) (Build Command: npx opennextjs-cloudflare build)',
    );
    expect(output).toContain('Deployed shop to production.');
    expect(output).toContain(
      'Production: https://shop.test-account.workers.dev/',
    );
    expect(await projects()).toMatchObject([
      { name: 'work', framework: 'nextjs' },
    ]);
    // A second deploy of the set-up app is a preview.
    nextApp();
    ran = [];
    expect(await cli(['--yes'], { run: tools() })).toBe(0);
    expect(ran).toEqual([
      'npx --yes wrangler@4.156.0 setup --yes --dry-run',
      'npx --yes wrangler@4.156.0 setup --yes',
      'npx opennextjs-cloudflare build',
      'npx --yes wrangler@4.156.0 versions upload --x-provision --x-auto-create --name shop --message "Preview from Shipcel"',
    ]);
    // --yes answers the question too.
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true });
    rmSync(join(dir, 'work', 'node_modules'), { recursive: true });
    nextApp();
    ran = [];
    expect(
      await cli(['--yes', '--name', 'again'], { run: tools('setup') }),
    ).toBe(1);
    expect(ran).toEqual([
      'npm install',
      'npx --yes wrangler@4.156.0 setup --yes --dry-run',
      'npx --yes wrangler@4.156.0 setup --yes',
    ]);
    // SvelteKit is set up the same way.
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { '@sveltejs/kit': '3', vite: '8' },
      }),
    );
    ran = [];
    expect(await cli(['--yes'], { run: tools('setup') })).toBe(1);
    expect(errors.pop()).toContain('Wrangler’s setup failed (exit code 1)');
    expect(ran).toEqual([
      'npx --yes wrangler@4.156.0 setup --yes --dry-run',
      'npx --yes wrangler@4.156.0 setup --yes',
    ]);
    // A framework Wrangler's setup has no adapter for would be set up as static files and
    // deploy without its code: the dry run shows that, and nothing is changed.
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'remix vite:build' },
        devDependencies: { '@remix-run/dev': '2', vite: '6' },
      }),
    );
    ran = [];
    expect(await cli(['--yes'], { run: tools('unknown') })).toBe(1);
    expect(errors.pop()).toBe(
      'Wrangler’s setup has no Cloudflare adapter for this Remix app: it would deploy the project’s static files without its code, so it changed nothing. Add the adapter by hand (the framework’s Cloudflare guide has the steps) and run shipcel again. If the app builds to static files, say where instead: shipcel deploy --output <folder>.',
    );
    expect(ran).toEqual(['npx --yes wrangler@4.156.0 setup --yes --dry-run']);
    // So does a version of the framework its setup refuses.
    ran = [];
    expect(await cli(['--yes'], { run: tools('no-look') })).toBe(1);
    expect(errors.pop()).toBe(
      'Wrangler’s setup can’t configure this Remix app (exit code 1); its output above says why. It changed nothing.',
    );
    expect(ran).toEqual(['npx --yes wrangler@4.156.0 setup --yes --dry-run']);
    // Or a dry run that doesn't say what it found.
    ran = [];
    expect(await cli(['--yes'], { run: tools('no-report') })).toBe(1);
    expect(errors.pop()).toBe(
      'Wrangler’s setup didn’t say what it would do with this Remix app, so it changed nothing. Add the adapter by hand (the framework’s Cloudflare guide has the steps) and run shipcel again.',
    );
    expect(ran).toEqual(['npx --yes wrangler@4.156.0 setup --yes --dry-run']);
    expect(existsSync(join(dir, 'work', 'wrangler.jsonc'))).toBe(false);
    nextApp();
    // shipcel build doesn't change a project: it says what to run.
    expect(await cli(['build'], { run: tools() })).toBe(1);
    expect(errors.pop()).toContain(
      'This is a Next.js app without its Cloudflare adapter yet.',
    );
  });

  it('reports a deploy Wrangler didn’t finish, and repeats it without leaving a database behind', async () => {
    workerApp();
    expect(await cli(['--yes'], { run: tools('before-upload') })).toBe(1);
    expect(errors.pop()).toBe(
      'The deploy from a computer stopped before the app was uploaded. It had created work-db in Cloudflare; the next deploy of this project uses them. Wrangler stopped with exit code 1; see its output above.',
    );
    expect(fx.state.workers.size).toBe(0);
    expect(await cli(['--yes'], { run: tools() })).toBe(0);
    expect(fx.state.d1).toHaveLength(1);
    expect(fx.state.workers.get('work')!.bindings).toEqual([
      { name: 'DB', type: 'd1', id: fx.state.d1[0].uuid },
    ]);
    // Uploaded, then stopped: the new version is there, and the person is told to look.
    output = [];
    expect(
      await cli(['--prod', '--prebuilt'], { run: tools('after-upload') }),
    ).toBe(1);
    expect(output).toContain('Deployed work to production.');
    expect(errors.pop()).toBe(
      'The new version is uploaded, but Wrangler didn’t finish. Wrangler stopped with exit code 1; see its output above. Check the app’s address and schedules.',
    );
    // Shipcel was told, so the project's history asks someone to look at both deploys
    // that stopped, and not at the one that finished.
    output = [];
    expect(
      await cli(['api', `/projects/${(await projects())[0].id}/operations`]),
    ).toBe(0);
    expect(
      (JSON.parse(output.join('\n')) as { kind: string; status: string }[])
        .map((operation) => `${operation.kind} ${operation.status}`)
        .sort(),
    ).toEqual([
      'local.deploy needs_attention',
      'local.deploy needs_attention',
      'local.deploy succeeded',
    ]);
  });

  it('builds an app without deploying it, the way a deploy would', async () => {
    workerApp();
    expect(await cli(['build'], { run: tools() })).toBe(0);
    expect(ran).toEqual(['npm install', 'npm run build']);
    expect(output.at(-1)).toBe(
      'Built. Deploy it with shipcel deploy --prebuilt.',
    );
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'next build' },
        packageManager: 'pnpm@10.2.0',
        dependencies: { next: '16.3.8', '@opennextjs/cloudflare': '1.20.9' },
      }),
    );
    ran = [];
    expect(await cli(['build'], { run: tools() })).toBe(0);
    expect(ran).toEqual(['npx opennextjs-cloudflare build']);
    // A Worker with nothing to build is bundled by Wrangler when it deploys.
    write('package.json', '{}');
    ran = [];
    expect(await cli(['build'], { run: tools() })).toBe(0);
    expect(ran).toEqual([]);
    expect(output.at(-1)).toBe(
      'Nothing to build: Wrangler bundles this app when it deploys.',
    );
  });

  it('stops before Wrangler’s setup when lockfiles name two package managers, and names one that isn’t installed', async () => {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'vite build' },
        dependencies: { '@solidjs/start': '2', vite: '8' },
      }),
    );
    // A template that ships its pnpm lockfile, installed with npm as its README says.
    write('package-lock.json', '{}');
    write('pnpm-lock.yaml', 'lockfileVersion: 9.0');
    expect(await cli(['--yes'], { run: tools() })).toBe(1);
    expect(errors.pop()).toBe(
      'This folder has lockfiles for npm and pnpm, so it isn’t clear which package manager installs it, and Wrangler’s setup and shipcel would each pick a different one. Delete the lockfile of the one you don’t use, then run shipcel again.',
    );
    expect(ran).toEqual([]);
    // One package manager's, not installed here.
    rmSync(join(dir, 'work', 'package-lock.json'));
    const run = tools();
    const noPnpm: Io['run'] = async (command, cwd, env, quiet) => {
      if (command !== 'pnpm install') return run(command, cwd, env, quiet);
      ran.push(command);
      return 127;
    };
    expect(await cli(['--yes'], { run: noPnpm })).toBe(1);
    expect(errors.pop()).toBe(
      'pnpm isn’t installed on this computer, and this project uses it (its lockfile says so). Install pnpm, or delete its lockfile to use npm, then run shipcel again. Nothing was deployed.',
    );
    expect(ran).toEqual(['pnpm install']);
    // Bun's two lockfiles are one package manager's.
    rmSync(join(dir, 'work', 'pnpm-lock.yaml'));
    write('bun.lock', '{}');
    write('bun.lockb', 'binary');
    ran = [];
    expect(await cli(['--yes'], { run: tools('setup') })).toBe(1);
    expect(ran.slice(0, 2)).toEqual([
      'bun install',
      'npx --yes wrangler@4.156.0 setup --yes --dry-run',
    ]);
  });

  it('lets an Angular app that Wrangler set up render on its workers.dev addresses', async () => {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'ng build' },
        dependencies: { '@angular/core': '21.2.0', '@angular/ssr': '21.2.26' },
      }),
    );
    const server = {
      builder: '@angular/build:application',
      options: {
        outputMode: 'server',
        ssr: { entry: 'src/server.ts' },
        security: { allowedHosts: [] },
      },
    };
    const browserOnly = { architect: { build: { options: {} } } };
    const angular = {
      version: 1,
      projects: {
        shop: { projectType: 'application', architect: { build: server } },
        widgets: browserOnly,
      },
    };
    write('angular.json', JSON.stringify(angular, null, 2));
    const run = tools();
    // Wrangler's setup for Angular writes a server that allows only localhost, and this.
    // The build stops the deploy here: what is checked happens before it.
    const angularSetup: Io['run'] = async (command, cwd, env, quiet) => {
      if (command === 'npm run build') {
        ran.push(command);
        return 1;
      }
      if (!/ setup --yes$/.test(command)) return run(command, cwd, env, quiet);
      ran.push(command);
      write(
        'wrangler.jsonc',
        JSON.stringify({
          name: 'shop',
          main: './dist/server/server.mjs',
          compatibility_date: '2026-10-06',
          assets: { binding: 'ASSETS', directory: 'dist/browser' },
        }),
      );
      return 0;
    };
    expect(await cli(['--yes'], { run: angularSetup })).toBe(1);
    expect(errors).toEqual([
      'npm run build failed (exit code 1). Nothing was deployed.',
    ]);
    const saved = JSON.parse(
      readFileSync(join(dir, 'work', 'angular.json'), 'utf8'),
    );
    expect(saved.projects.shop.architect.build).toEqual({
      ...server,
      options: {
        ...server.options,
        security: { allowedHosts: ['*.test-account.workers.dev'] },
      },
    });
    // An app that renders only in the browser has no server to tell.
    expect(saved.projects.widgets).toEqual(browserOnly);
    expect(output).toContain(
      'Added *.test-account.workers.dev to angular.json (security.allowedHosts): Angular renders pages only for the hosts listed there. Add your own domains there too when you attach them.',
    );
    // The build comes after, so it reads the new hosts.
    expect(ran).toEqual([
      'npm install',
      'npx --yes wrangler@4.156.0 setup --yes --dry-run',
      'npx --yes wrangler@4.156.0 setup --yes',
      'npm run build',
    ]);
  });

  it('deploys with the real Wrangler, through Shipcel, from the command the CLI runs', async () => {
    workerApp({
      assets: { directory: 'public', binding: 'ASSETS' },
      kv_namespaces: [{ binding: 'CACHE' }],
      vars: { MODE: 'production' },
    });
    write('package.json', '{}');
    write('public/index.html', '<h1>hi</h1>');
    const link = await bridge(db.env);
    // Only Wrangler is real here; there is nothing to install or build.
    const real: Io['run'] = async (command, cwd, env) => {
      if (!command.includes('wrangler')) return 0;
      ran.push(command);
      return link.run(command, cwd, env);
    };
    try {
      expect(await cli(['--yes'], { run: real })).toBe(0);
      expect(errors).toEqual([]);
      expect(link.outputs[0]).toContain(
        'https://work.test-account.workers.dev',
      );
      expect(output.slice(-3, -1)).toEqual([
        'Preview: https://00000001-work.test-account.workers.dev',
        'Production: https://work.test-account.workers.dev/',
      ]);
      expect(fx.state.workers.get('work')!.bindings).toEqual(
        expect.arrayContaining([
          { name: 'DB', type: 'd1', id: fx.state.d1[0].uuid },
          {
            name: 'CACHE',
            type: 'kv_namespace',
            namespace_id: fx.state.kv[0].id,
          },
          { name: 'MODE', type: 'plain_text', text: 'production' },
          { name: 'ASSETS', type: 'assets' },
        ]),
      );
      // Wrangler held only the deploy's token; nothing it was sent names Cloudflare's.
      for (const exchange of link.seen) {
        expect(exchange.authorization).not.toContain(token);
        expect(exchange.text).not.toMatch(
          /cloudflare-access-secret|upload-jwt|completion-jwt/,
        );
      }
      // A preview, then production again: three versions, the last one live.
      expect(await cli([], { run: real })).toBe(0);
      expect(fx.state.live).toBe('00000001-0000-4000-8000-000000000000');
      expect(await cli(['--prod'], { run: real })).toBe(0);
      expect(errors).toEqual([]);
      expect(fx.state.live).toBe('00000003-0000-4000-8000-000000000000');
      expect(ran.map((c) => c.split(' ').slice(3, 5).join(' '))).toEqual([
        'deploy --no-autoconfig',
        'versions upload',
        'deploy --no-autoconfig',
      ]);
    } finally {
      await link.close();
    }
  }, 240000);

  // An app in production (version 1) with a preview (version 2).
  async function twoVersions() {
    workerApp();
    expect(await cli(['--yes'], { run: tools() })).toBe(0);
    expect(await cli([], { run: tools() })).toBe(0);
    output = [];
    ran = [];
  }

  it('moves production to a version a share at a time, like a rolling release', async () => {
    await twoVersions();
    expect(await cli(['rolling-release'])).toBe(0);
    expect(output.pop()).toBe(
      'No rolling release: 00000001 serves all production traffic.',
    );
    expect(await cli(['rolling-release', 'start', '--yes'])).toBe(2);
    expect(errors.pop()).toContain('--dpl <version|preview url>');
    expect(
      await cli(['rolling-release', 'start', '--dpl', '00000002', '--yes']),
    ).toBe(0);
    expect(output).toEqual([
      '00000002 now serves 10% of production traffic; 00000001 serves 90%.',
      'Next: shipcel rolling-release approve --dpl 00000002 --percent <more>, complete, or abort.',
    ]);
    expect(fx.state.deployments[0]).toEqual([
      { version_id: '00000002-0000-4000-8000-000000000000', percentage: 10 },
      { version_id: '00000001-0000-4000-8000-000000000000', percentage: 90 },
    ]);
    output = [];
    expect(await cli(['rr', 'status'])).toBe(0);
    expect(output.pop()).toBe('Rolling release: 00000002 10%, 00000001 90%.');
    // One at a time; a share is 1 to 99; changes ask first in scripts.
    expect(
      await cli(['rolling-release', 'start', '--dpl', '00000002', '--yes']),
    ).toBe(1);
    expect(errors.pop()).toContain('A rolling release is already running');
    for (const percent of ['0', '100', 'half'])
      expect(
        await cli([
          'rr',
          'approve',
          '--dpl',
          '00000002',
          '--percent',
          percent,
          '--yes',
        ]),
      ).toBe(2);
    expect(await cli(['rr', 'approve', '--dpl', '00000002', '--yes'])).toBe(2);
    expect(
      await cli(['rr', 'approve', '--dpl', '00000002', '--percent', '50']),
    ).toBe(1);
    expect(errors.pop()).toContain('Pass --yes to confirm in scripts.');
    expect(fx.state.deployments[0][0].percentage).toBe(10);
    expect(
      await cli([
        'rr',
        'approve',
        '--dpl',
        '00000002',
        '--percent',
        '50',
        '--yes',
      ]),
    ).toBe(0);
    expect(fx.state.deployments[0]).toEqual([
      { version_id: '00000002-0000-4000-8000-000000000000', percentage: 50 },
      { version_id: '00000001-0000-4000-8000-000000000000', percentage: 50 },
    ]);
    // With equal shares, abort needs to know which version was being released.
    expect(await cli(['rr', 'abort', '--yes'])).toBe(1);
    expect(errors.pop()).toContain('--dpl');
    expect(await cli(['rr', 'abort', '--dpl', '00000002', '--yes'])).toBe(0);
    expect(output.pop()).toBe(
      'Aborted: 00000001 serves all production traffic again.',
    );
    expect(fx.state.live).toBe('00000001-0000-4000-8000-000000000000');
    expect(await cli(['rr', 'abort', '--yes'])).toBe(1);
    expect(errors.pop()).toBe('No rolling release is running.');
    // approve needs a release in progress; complete sends everything.
    expect(
      await cli([
        'rr',
        'approve',
        '--dpl',
        '00000002',
        '--percent',
        '20',
        '--yes',
      ]),
    ).toBe(1);
    expect(errors.pop()).toContain('isn’t in a rolling release');
    await cli(['rr', 'start', '--dpl', '00000002', '--percent', '25', '--yes']);
    expect(await cli(['rr', 'complete', '--dpl', '00000002', '--yes'])).toBe(0);
    expect(output.pop()).toBe('00000002 now serves all production traffic.');
    expect(fx.state.deployments[0]).toEqual([
      { version_id: '00000002-0000-4000-8000-000000000000', percentage: 100 },
    ]);
    expect(await cli(['rr', 'complete', '--dpl', '00000002', '--yes'])).toBe(1);
    expect(await cli(['rr', 'sideways'])).toBe(2);
  });

  it('adds and removes cron schedules, and shows the app’s numbers', async () => {
    await twoVersions();
    expect(await cli(['crons'])).toBe(0);
    expect(output.pop()).toContain('No schedules.');
    expect(await cli(['crons', 'add', ' 0  10 * * * '])).toBe(0);
    expect(output.pop()).toContain('Added the schedule 0 10 * * * (UTC).');
    expect(await cli(['crons', 'add', '*/15 * * * *'])).toBe(0);
    expect(fx.state.schedules.work).toEqual([
      { cron: '0 10 * * *' },
      { cron: '*/15 * * * *' },
    ]);
    expect(await cli(['crons', 'add', '0 10 * * *'])).toBe(1);
    expect(errors.pop()).toBe('work already runs on 0 10 * * *.');
    expect(await cli(['crons', 'add'])).toBe(2);
    expect(await cli(['crons', 'add', 'every day'])).toBe(1);
    output = [];
    expect(await cli(['crons', 'ls'])).toBe(0);
    expect(output).toEqual(['0 10 * * *', '*/15 * * * *']);
    expect(await cli(['crons', 'rm', '0 10 * * *'])).toBe(1);
    expect(errors.pop()).toContain('Pass --yes');
    expect(await cli(['crons', 'rm', '0 10 * * *', '--yes'])).toBe(0);
    expect(fx.state.schedules.work).toEqual([{ cron: '*/15 * * * *' }]);
    expect(await cli(['crons', 'rm', '0 10 * * *', '--yes'])).toBe(1);
    expect(await cli(['crons', 'run', '/api/cron'])).toBe(1);
    expect(errors.pop()).toContain('has no call that triggers one');
    // Requests, errors and CPU time from Cloudflare's analytics.
    output = [];
    expect(await cli(['metrics'])).toBe(0);
    expect(output).toEqual([
      'work, last 24 hours',
      'Requests                        1,200',
      'Errors                          6 (0.50%)',
      'Subrequests                     30',
      'Response time, median           35 ms',
      'Response time, 99th percentile  410 ms',
      'CPU time, median                1.4 ms',
      'CPU time, 99th percentile       9 ms',
      'Outcome: success                1,200',
    ]);
    output = [];
    expect(await cli(['analytics', '--since', '7d', '--json'])).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({
      range: '7d',
      totals: { requests: 1200 },
    });
    expect(await cli(['metrics', '--since', '30d'])).toBe(0);
    expect(output.at(-9)).toBe('work, last 30 days');
    expect(await cli(['metrics', '--since', '1y'])).toBe(2);
  });

  it('shows what the app costs against its budget, and leaves changes to the dashboard', async () => {
    await twoVersions();
    expect(await cli(['budget'])).toBe(0);
    expect(output).toEqual([
      'work: a budget of $0.00 a month beyond what Cloudflare includes; over it, an alert only.',
      'Not checked yet. Run shipcel budget check.',
      expect.stringMatching(
        /^An owner changes the budget, or pauses or resumes the app, in the dashboard: https:\/\/shipcel\.test\/app\/#projects\/[\w-]+$/,
      ),
    ]);
    // A reading now. This fake Cloudflare reports Worker requests only.
    output = [];
    expect(await cli(['budget', 'check'])).toBe(0);
    expect(output[1]).toBe(
      'This month so far: $0.00. Cloudflare plan: unknown, estimated as Workers Paid.',
    );
    expect(output).toContainEqual(
      expect.stringMatching(
        /^Cloudflare didn't report Durable Object requests and alarms, .+, so the estimate may be low\.$/,
      ),
    );
    // Over the budget and paused.
    const [project] = await projects();
    db.sqlite
      .prepare(
        "UPDATE budget_checks SET state='paused', plan='paid', estimate_cents=10600, account_cents=12000, missing_json='[]', meters_json=? WHERE project_id=?",
      )
      .run(
        JSON.stringify([
          {
            meter: 'do.rowsWritten',
            label: 'Durable Object rows written',
            mine: 150_000_000,
            account: 150_000_000,
            included: 50_000_000,
            cents: 10000,
          },
        ]),
        project.id,
      );
    output = [];
    expect(await cli(['budget'])).toBe(0);
    expect(output[1]).toBe(
      'This month so far: $106.00, over the budget: the app is PAUSED. Cloudflare plan: Workers Paid.',
    );
    expect(output[2]).toMatch(/^ {2}Usage {2,}This app {2,}Included {2,}Cost$/);
    expect(output[3]).toMatch(
      /^ {2}Durable Object rows written {2,}150,000,000 {2,}50,000,000 {2,}\$100\.00$/,
    );
    expect(output[4]).toBe(
      "The whole Cloudflare account, Workers Shipcel doesn't manage included: $120.00.",
    );
    output = [];
    expect(await cli(['budget', '--json'])).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({
      budget: { monthlyCents: 0, onExceed: 'alert' },
      check: { state: 'paused', estimateCents: 10600 },
    });
    expect(await cli(['budget', 'raise'])).toBe(2);
    expect(errors.pop()).toBe(
      'Unknown command budget raise. Run shipcel help budget.',
    );
    output = [];
    expect(await cli(['help', 'budget'])).toBe(0);
    expect(output[0]).toMatch(/^shipcel budget/);
  });

  it('requests the app with curl, and puts a custom domain behind production only', async () => {
    await twoVersions();
    expect(await cli(['curl', '/api/hello'])).toBe(0);
    expect(ran.pop()).toBe(
      "curl -sS -i 'https://work.test-account.workers.dev/api/hello'",
    );
    expect(await cli(['curl', '/', '--deployment', '00000002'])).toBe(0);
    expect(ran.pop()).toBe(
      "curl -sS -i 'https://00000002-work.test-account.workers.dev/'",
    );
    expect(await cli(['httpstat'])).toBe(0);
    expect(output.pop()).toBe('https://work.test-account.workers.dev/');
    expect(ran.pop()).toMatch(
      /^curl -sS -o \/dev\/null -w 'DNS lookup: .*Total: +%\{time_total\}s.*' 'https:\/\/work\.test-account\.workers\.dev\/'$/,
    );
    // Nothing in a path reaches the shell.
    for (const path of ["/a'; rm -rf ~; '", '/a b', 'api', '/$(id)', '/`id`'])
      expect(await cli(['curl', path])).toBe(2);
    expect(ran).toEqual([]);
    expect(await cli(['curl', '/'], { run: async () => 7 })).toBe(7);
    // A domain serves production: a preview has to be promoted first.
    expect(await cli(['alias', 'set', '00000002', 'www.example.com'])).toBe(1);
    expect(errors.pop()).toBe(
      'A custom domain serves the app’s production version, and 00000002 isn’t it. Promote it first: shipcel promote 00000002. Then add the domain.',
    );
    expect(await cli(['alias', 'set'])).toBe(2);
    expect(await cli(['git', 'ls'])).toBe(0);
    expect(output.pop()).toBe(
      'work isn’t connected to a Git repository: it deploys from this computer. To deploy every push, run shipcel git connect.',
    );
    expect(await cli(['git', 'disconnect'])).toBe(1);
    expect(await cli(['git', 'push'])).toBe(2);
  });

  it('pulls the names of the app’s variables into a local file, never their values', async () => {
    await twoVersions();
    expect(await cli(['env', 'pull'])).toBe(0);
    expect(output.pop()).toContain(
      'work has no secrets or build variables yet',
    );
    for (const name of ['API_KEY', 'DATABASE_URL'])
      expect(
        await cli(['env', 'add', name], {
          stdin: async () => 'value-not-pulled',
        }),
      ).toBe(0);
    output = [];
    // A folder with a Wrangler configuration keeps local values in .dev.vars.
    expect(await cli(['pull'])).toBe(0);
    expect(output).toEqual([
      'Added 2 names to .dev.vars: API_KEY, DATABASE_URL.',
      'Secret values aren’t readable from Cloudflare, so they are empty: fill in what you need for local development.',
    ]);
    const file = join(dir, 'work', '.dev.vars');
    expect(readFileSync(file, 'utf8')).toBe(
      '# Variables of work, from shipcel env pull. Cloudflare never returns a\n# secret’s value: fill in the ones you need locally. Keep this file out of Git.\nAPI_KEY=\nDATABASE_URL=\n',
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // What the person filled in stays; only new names are added.
    writeFileSync(file, 'API_KEY=local-key\nexport EXTRA="x"');
    await cli(['env', 'update', 'NEW_ONE'], { stdin: async () => 'v' });
    output = [];
    expect(await cli(['env', 'pull', '--json'])).toBe(0);
    expect(JSON.parse(output[0])).toEqual({
      file: '.dev.vars',
      added: ['DATABASE_URL', 'NEW_ONE'],
    });
    expect(readFileSync(file, 'utf8')).toBe(
      'API_KEY=local-key\nexport EXTRA="x"\nDATABASE_URL=\nNEW_ONE=\n',
    );
    output = [];
    expect(await cli(['env', 'pull'])).toBe(0);
    expect(output).toEqual([
      '.dev.vars already names all 3 of work’s variables.',
    ]);
    // A named file, inside the folder only.
    expect(await cli(['env', 'pull', '.env.development'])).toBe(0);
    expect(existsSync(join(dir, 'work', '.env.development'))).toBe(true);
    for (const outside of ['../secrets', '/etc/passwd', 'a/../../b'])
      expect(await cli(['env', 'pull', outside])).toBe(2);
    expect(JSON.stringify(readFileSync(file, 'utf8'))).not.toContain(
      'value-not-pulled',
    );
  });

  it('runs a project locally the way it says it runs', async () => {
    const offline = (args: string[], overrides: Partial<Io> = {}) =>
      run(args, io(toShipcel, overrides));
    expect(await offline(['dev'])).toBe(1);
    expect(errors.pop()).toContain('doesn’t know how to run this folder');
    write('index.html', '<h1>hi</h1>');
    expect(await offline(['dev'])).toBe(0);
    expect(ran.pop()).toBe('npx --yes wrangler@4.156.0 dev --assets .');
    write('wrangler.jsonc', '{"name":"api","main":"src/index.js"}');
    write('node_modules/wrangler/package.json', '{"version":"4.120.0"}');
    expect(await offline(['dev'])).toBe(0);
    expect(ran.pop()).toBe('npx wrangler dev');
    write('package.json', '{"scripts":{"start":"react-scripts start"}}');
    write('yarn.lock', '');
    expect(await offline(['dev'])).toBe(0);
    expect(ran.pop()).toBe('yarn run start');
    write('package.json', '{"scripts":{"dev":"vite","start":"node ."}}');
    expect(await offline(['dev'])).toBe(0);
    expect(output.pop()).toBe('Running: yarn run dev');
    expect(await offline(['dev'], { run: async () => 130 })).toBe(130);
  });

  it('connects agents, calls the API, and says what it doesn’t do', async () => {
    expect(await cli(['mcp'])).toBe(0);
    expect(output.join('\n')).toContain(
      'claude mcp add --transport http --scope user shipcel https://shipcel.test/mcp --header "Authorization: Bearer $SHIPCEL_TOKEN"',
    );
    expect(output.join('\n')).not.toContain(token);
    write('.mcp.json', '{"mcpServers":{"other":{"url":"https://x.test"}}}');
    expect(await cli(['mcp', '--write'])).toBe(0);
    const settings = readFileSync(join(dir, 'work', '.mcp.json'), 'utf8');
    expect(JSON.parse(settings)).toEqual({
      mcpServers: {
        other: { url: 'https://x.test' },
        shipcel: {
          type: 'http',
          url: 'https://shipcel.test/mcp',
          headers: { Authorization: 'Bearer ${SHIPCEL_TOKEN}' },
        },
      },
    });
    expect(settings).not.toContain(token);
    write('.mcp.json', 'not json');
    expect(await cli(['mcp', '--write'])).toBe(1);
    expect(readFileSync(join(dir, 'work', '.mcp.json'), 'utf8')).toBe(
      'not json',
    );
    // Deploy notes for coding agents, added once.
    write('AGENTS.md', '# Our rules\n');
    expect(await cli(['agent', 'init'])).toBe(0);
    const notes = readFileSync(join(dir, 'work', 'AGENTS.md'), 'utf8');
    expect(notes.startsWith('# Our rules\n\n<!-- shipcel:deploy -->')).toBe(
      true,
    );
    expect(notes).toContain('shipcel --prod');
    expect(await cli(['agent', 'init'])).toBe(0);
    expect(readFileSync(join(dir, 'work', 'AGENTS.md'), 'utf8')).toBe(notes);
    expect(await cli(['agent'])).toBe(2);
    // The API, as the signed-in person.
    output = [];
    expect(await cli(['api', '/projects'])).toBe(0);
    expect(JSON.parse(output.join('\n'))).toEqual([]);
    expect(
      await cli([
        'api',
        '/api/projects',
        '--data',
        '{"name":"from-api","framework":"static"}',
      ]),
    ).toBe(0);
    expect((await projects()).map((p) => p.name)).toEqual(['from-api']);
    output = [];
    expect(await cli(['api', '/workspace/members'])).toBe(1);
    expect(JSON.parse(output.join('\n')).error).toContain(
      'API tokens can’t do this',
    );
    for (const bad of [
      ['api'],
      ['api', 'projects'],
      ['api', '//evil.test/x'],
      ['api', '/projects', '--method', 'TRACE'],
      ['api', '/projects', '--data', '{'],
    ])
      expect(await cli(bad)).toBe(2);
    // Upgrading installs the CLI this Shipcel serves.
    output = [];
    expect(await cli(['upgrade', '--dry-run'])).toBe(0);
    expect(output).toEqual([
      'npm install -g https://shipcel.test/cli/shipcel.tgz',
    ]);
    expect(await cli(['upgrade'])).toBe(1);
    expect(await cli(['upgrade', '--yes'])).toBe(0);
    expect(ran.pop()).toBe(
      'npm install -g https://shipcel.test/cli/shipcel.tgz',
    );
    expect(await cli(['telemetry'])).toBe(0);
    expect(output.pop()).toContain('collects no telemetry');
    expect(await cli(['teams'])).toBe(0);
    expect(output.slice(-2)).toEqual([
      'Workspace                   Role   Kind',
      'workspace-1 (this sign-in)  owner  personal',
    ]);
    for (const command of [
      'dev',
      'crons',
      'rolling-release',
      'metrics',
      'curl',
      'api',
      'mcp',
      'agent',
      'upgrade',
      'alias',
      'pull',
      'switch',
    ]) {
      output = [];
      expect(await cli(['help', command])).toBe(0);
      expect(output[0]).toMatch(new RegExp(`^shipcel ${command}`));
    }
  });

  it('fills a Next.js app’s OpenNext cache through its deploy, once it is in production', async () => {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'next build' },
        dependencies: {
          next: '16.4.2',
          react: '19.3.1',
          '@opennextjs/cloudflare': '1.20.14',
        },
      }),
    );
    write(
      'open-next.config.ts',
      'import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";\nexport default defineCloudflareConfig({ incrementalCache: r2IncrementalCache });\n',
    );
    write(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'shop',
        main: '.open-next/worker.js',
        compatibility_date: '2026-10-07',
        compatibility_flags: ['nodejs_compat'],
        assets: { directory: '.open-next/assets', binding: 'ASSETS' },
        services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shop' }],
        r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET' }],
      }),
    );
    const bucket = 'shop-next-inc-cache-r2-bucket';
    // OpenNext's build writes what Next.js prerendered, and a fetch() it cached; Wrangler
    // makes the bucket on the first deploy and binds it, or uploads a preview.
    const tools = async (
      command: string,
      _cwd: string,
      env: Record<string, string | undefined> = {},
    ) => {
      ran.push(command);
      if (/ install$/.test(command)) {
        write('node_modules/.package-lock.json', '{}');
        return 0;
      }
      if (command === 'npx opennextjs-cloudflare build') {
        write(
          '.open-next/cache/BUILD_1/index.cache',
          '{"html":"<h1>home</h1>"}',
        );
        write(
          '.open-next/cache/BUILD_1/blog/first-post.cache',
          '{"html":"<h1>1</h1>"}',
        );
        write('.open-next/cache/__fetch/BUILD_1/4f1c0a', '{"kind":"FETCH"}');
        return 0;
      }
      if (!command.includes('wrangler')) return 0;
      const call = async (path: string, init: RequestInit = {}) =>
        toShipcel(
          `${env.CLOUDFLARE_API_BASE_URL}${path}`,
          await sized({
            ...init,
            headers: {
              Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              ...(typeof init.body === 'string'
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
          }),
        );
      const script = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/shop`;
      const preview = command.includes('versions upload');
      if (!preview)
        await call(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`, {
          method: 'POST',
          body: JSON.stringify({ name: bucket }),
        });
      const body = new FormData();
      body.set(
        'metadata',
        JSON.stringify({
          main_module: 'index.js',
          bindings: [
            preview
              ? { name: 'NEXT_INC_CACHE_R2_BUCKET', type: 'inherit' }
              : {
                  name: 'NEXT_INC_CACHE_R2_BUCKET',
                  type: 'r2_bucket',
                  bucket_name: bucket,
                },
            { name: 'WORKER_SELF_REFERENCE', type: 'service', service: 'shop' },
          ],
        }),
      );
      body.set(
        'index.js',
        new File(['export default {}'], 'index.js', {
          type: 'application/javascript+module',
        }),
      );
      if (preview) {
        await call(`${script}/versions`, { method: 'POST', body });
        return 0;
      }
      await call(script, { method: 'PUT', body });
      await call(`${script}/subdomain`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      });
      return 0;
    };
    // A new project is Free-only, and R2 can bill: nothing is built or deployed.
    expect(await cli(['--yes'], { run: tools })).toBe(1);
    expect(errors.pop()).toContain(
      'This project is Free-only, and R2 buckets (NEXT_INC_CACHE_R2_BUCKET) can bill',
    );
    expect(ran).toEqual([]);
    db.sqlite.prepare('UPDATE projects SET free_only=0').run();
    output = [];
    expect(await cli(['--yes'], { run: tools })).toBe(0);
    expect(errors).toEqual([]);
    expect(ran).toContain('npx opennextjs-cloudflare build');
    // At the keys OpenNext's runtime reads: sha256 of the route, under the build's id.
    const at = (route: string, type = 'cache') =>
      `${bucket}/incremental-cache/BUILD_1/${createHash('sha256').update(route).digest('hex')}.${type}`;
    expect([...fx.state.objects.keys()].sort()).toEqual(
      [at('/index'), at('/blog/first-post'), at('/4f1c0a', 'fetch')].sort(),
    );
    expect(fx.state.objects.get(at('/index'))).toBe('{"html":"<h1>home</h1>"}');
    expect(output).toContain(
      'Filled OpenNext’s cache with the 3 entries Next.js prerendered.',
    );
    // A preview shares production's bucket and leaves it alone.
    fx.state.objects.clear();
    output = [];
    expect(await cli([], { run: tools })).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toContain('Uploaded a preview of shop.');
    expect(fx.state.objects.size).toBe(0);
  });

  it('puts a Free-only Next.js app’s prerendered pages in its own files, for OpenNext’s static cache', async () => {
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'next build' },
        dependencies: {
          next: '16.4.2',
          react: '19.3.1',
          '@opennextjs/cloudflare': '1.20.14',
        },
      }),
    );
    write(
      'open-next.config.ts',
      'import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";\nexport default defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache });\n',
    );
    write(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'shop',
        main: '.open-next/worker.js',
        compatibility_date: '2026-10-07',
        compatibility_flags: ['nodejs_compat'],
        assets: { directory: '.open-next/assets', binding: 'ASSETS' },
        services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shop' }],
      }),
    );
    const cached = join(
      dir,
      'work',
      '.open-next/assets/cdn-cgi/_next_cache/BUILD_1/index.cache',
    );
    let inFilesForWrangler = false;
    const tools = async (
      command: string,
      _cwd: string,
      env: Record<string, string | undefined> = {},
    ) => {
      ran.push(command);
      if (/ install$/.test(command)) {
        write('node_modules/.package-lock.json', '{}');
        return 0;
      }
      if (command === 'npx opennextjs-cloudflare build') {
        write(
          '.open-next/cache/BUILD_1/index.cache',
          '{"html":"<h1>home</h1>"}',
        );
        return 0;
      }
      if (!command.includes('wrangler')) return 0;
      // Wrangler uploads the assets folder as it is when it runs.
      inFilesForWrangler = existsSync(cached);
      const call = async (path: string, init: RequestInit = {}) =>
        toShipcel(
          `${env.CLOUDFLARE_API_BASE_URL}${path}`,
          await sized({
            ...init,
            headers: {
              Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              ...(typeof init.body === 'string'
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
          }),
        );
      const script = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/shop`;
      const body = new FormData();
      body.set(
        'metadata',
        JSON.stringify({
          main_module: 'index.js',
          bindings: [
            { name: 'WORKER_SELF_REFERENCE', type: 'service', service: 'shop' },
          ],
        }),
      );
      body.set(
        'index.js',
        new File(['export default {}'], 'index.js', {
          type: 'application/javascript+module',
        }),
      );
      await call(script, { method: 'PUT', body });
      await call(`${script}/subdomain`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      });
      return 0;
    };
    expect(await cli(['--yes'], { run: tools })).toBe(0);
    expect(errors).toEqual([]);
    expect(inFilesForWrangler).toBe(true);
    expect(readFileSync(cached, 'utf8')).toBe('{"html":"<h1>home</h1>"}');
    expect(output).toContain(
      'Added OpenNext’s cache to the app’s files: 1 entry that Next.js prerendered.',
    );
    expect(fx.state.objects.size).toBe(0);
  });
});

describe('shipcel git connect, against the real Shipcel API', () => {
  let db: ReturnType<typeof database>;
  let gx: ReturnType<typeof gitProviders>;
  let token: string;
  const toShipcel = ((url: string, init: RequestInit) =>
    app.request(url, init, db.env)) as typeof globalThis.fetch;
  const cli = (args: string[], overrides: Partial<Io> = {}) =>
    run(
      args,
      io(toShipcel, overrides, {
        SHIPCEL_URL: 'https://shipcel.test',
        SHIPCEL_TOKEN: token,
      }),
    );
  const origin = (url = 'git@github.com:ada/site.git') =>
    write(
      '.git/config',
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`,
    );
  const projects = () =>
    db.sqlite
      .prepare('SELECT name, framework, source, repository FROM projects')
      .all();
  const jobs = () =>
    db.sqlite
      .prepare('SELECT worker_name, status, adapter FROM deployment_jobs')
      .all();
  const notes = [
    '  Note: Commit a lockfile so every build installs the same dependency versions.',
  ];

  beforeEach(async () => {
    db = database();
    const who = await db.user(1);
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    gx = gitProviders();
    vi.stubGlobal('fetch', vi.fn(gx.handler));
    token = (
      (await (
        await db.request(
          '/tokens',
          { method: 'POST', body: JSON.stringify({ name: 'CLI test' }) },
          who.cookie,
        )
      ).json()) as { token: string }
    ).token;
  });
  afterEach(() => db.close());

  it('connects an app with containers through Cloudflare’s builds, which make its images', async () => {
    origin();
    gx.state.files = {
      'package.json': JSON.stringify({
        scripts: {},
        dependencies: { '@cloudflare/containers': '0.3.7' },
        devDependencies: { wrangler: '4.154.0' },
      }),
      'package-lock.json': '{}',
      'wrangler.jsonc': JSON.stringify({
        name: 'site',
        main: 'src/worker.js',
        compatibility_date: '2026-10-07',
        containers: [
          {
            class_name: 'AppContainer',
            image: './Dockerfile',
            instance_type: 'lite',
            max_instances: 2,
          },
        ],
        durable_objects: {
          bindings: [{ name: 'APP', class_name: 'AppContainer' }],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['AppContainer'] }],
      }),
      Dockerfile: 'FROM node:24-alpine\n',
    };
    // A script has to say yes to a project that can't be Free-only.
    expect(await cli(['git', 'connect'])).toBe(1);
    expect(errors.pop()).toBe(
      'ada/site runs containers, which need Cloudflare’s Workers Paid plan and bill by use, so its project can’t be Free-only. Pass --yes to create it with Free-only off.',
    );
    expect(projects()).toEqual([]);
    output = [];
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toContain(
      'ada/site runs containers: its project is created with Free-only off.',
    );
    expect(output).toContain(
      'Containers deploy with Cloudflare’s own builds, which make their images: connecting with them.',
    );
    expect(projects()).toEqual([
      expect.objectContaining({ name: 'site', framework: 'docker' }),
    ]);
    // Cloudflare builds it; no GitHub Actions workflow is committed.
    expect(gx.state.triggers).toHaveLength(1);
    expect(gx.state.commits).toEqual([]);
    expect(jobs()).toEqual([
      expect.objectContaining({ worker_name: 'site', adapter: 'container' }),
    ]);
  });

  it('connects the folder’s repository and follows the first deployment to its address', async () => {
    origin();
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      0,
    );
    expect(errors).toEqual([]);
    expect(output.slice(0, 4)).toEqual([
      'Connecting GitHub repository: https://github.com/ada/site',
      'Created the project site.',
      'Added .shipcel to .gitignore.',
      'Static site (Vite): builds with npm run build, serves dist/.',
    ]);
    expect(output.filter((line) => line.startsWith('  Note: '))).toHaveLength(
      2,
    );
    expect(output.slice(-10)).toEqual([
      'Deploying main at bbbbbbb to https://site.test-account.workers.dev (build token: Shipcel builds)',
      'Checking the app’s name…',
      'Creating the Worker…',
      'Connecting the repository…',
      'Creating the build trigger…',
      'Starting the first build…',
      'Cloudflare is building…',
      'Checking that the app answers…',
      'Production: https://site.test-account.workers.dev/',
      'Every push to main now builds and deploys.',
    ]);
    expect(projects()).toEqual([
      {
        name: 'site',
        // What the repository's root files say it runs; the plan found the Vite preset.
        framework: 'worker',
        source: 'github',
        repository: 'https://github.com/ada/site',
      },
    ]);
    expect(jobs()).toEqual([
      { worker_name: 'site', status: 'deployed', adapter: 'static-assets' },
    ]);
    // Cloudflare builds the reviewed commit of the production branch, on every push to it.
    expect(gx.state.triggers).toHaveLength(1);
    expect(gx.state.triggers[0]).toMatchObject({
      build_token_uuid: buildToken.build_token_uuid,
      build_command: 'npm run build',
      branch_includes: ['main'],
    });
    expect(gx.state.builds).toEqual([{ branch: 'main', commit_hash: commit }]);
    expect(
      JSON.parse(
        readFileSync(join(dir, 'work', '.shipcel', 'project.json'), 'utf8'),
      ),
    ).toMatchObject({ name: 'site' });
    // Again: nothing new is created.
    output = [];
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      0,
    );
    expect(output).toEqual([
      'Connecting GitHub repository: https://github.com/ada/site',
      'site already deploys ada/site on every push to main: https://site.test-account.workers.dev/',
    ]);
    expect(gx.state.triggers).toHaveLength(1);
  });

  it('waits for each thing Cloudflare’s builds need, opening its page, and carries on by itself', async () => {
    origin('https://github.com/ada/site.git');
    gx.state.installed = false;
    gx.state.cloudflareReads = false;
    gx.state.tokens = [];
    // What the person does in the browser, one step per wait.
    const browser = [
      () => {},
      () => (gx.state.installed = true),
      () => {},
      () => (gx.state.cloudflareReads = true),
      () => {},
      () => (gx.state.tokens = [buildToken]),
    ];
    const asked: string[] = [];
    expect(
      await cli(['git', 'connect', '--cloudflare-builds'], {
        isTTY: true,
        sleep: async () => {
          browser.shift()?.();
        },
        ask: async (question) => {
          asked.push(question);
          return /\[y\/N\]/.test(question) ? 'y' : '';
        },
      }),
    ).toBe(0);
    expect(opened).toEqual([
      'https://github.com/apps/shipcel-test/installations/new',
      `https://dash.cloudflare.com/${account}/workers-and-pages/create`,
      'https://shipcel.test/app/#connections',
    ]);
    const waiting = ' (Ctrl+C stops; nothing is lost.)';
    expect(output.filter((line) => !line.startsWith('  Note: '))).toEqual([
      'Connecting GitHub repository: https://github.com/ada/site',
      'Shipcel’s GitHub app can’t see ada/site yet.',
      'Add the repository to it on GitHub: https://github.com/apps/shipcel-test/installations/new',
      `Waiting for GitHub…${waiting}`,
      'Shipcel can read ada/site.',
      'Created the project site.',
      'Added .shipcel to .gitignore.',
      'Static site (Vite): builds with npm run build, serves dist/.',
      'Cloudflare builds with its own GitHub app, and it can’t read ada/site yet.',
      `On Cloudflare’s Create application page, choose GitHub and give Cloudflare Workers and Pages ada and the repository (Install & Authorize). When Cloudflare lists your repositories, you’re done: https://dash.cloudflare.com/${account}/workers-and-pages/create`,
      'If ada is already listed there, add the repository on GitHub instead: https://github.com/settings/installations',
      'If Cloudflare already shows the repository, carry on with: shipcel git connect --skip-checks',
      `Waiting for Cloudflare to see the repository…${waiting}`,
      'Cloudflare can read ada/site.',
      'Cloudflare’s builds also need a build token: an API token you create once.',
      'Add it under Cloudflare on the Connections page: https://shipcel.test/app/#connections',
      `Waiting for the build token…${waiting}`,
      'Deploying main at bbbbbbb to https://site.test-account.workers.dev (build token: Shipcel builds)',
      'Checking the app’s name…',
      'Creating the Worker…',
      'Connecting the repository…',
      'Creating the build trigger…',
      'Starting the first build…',
      'Cloudflare is building…',
      'Checking that the app answers…',
      'Production: https://site.test-account.workers.dev/',
      'Every push to main now builds and deploys.',
    ]);
    // Nothing is created in Cloudflare before the person agrees to it.
    expect(asked).toEqual([
      'Project name [site]: ',
      'Create the Worker site in Test Cloud and build every push to main of ada/site? Only connect a repository you trust; Cloudflare usage and builds may incur charges. [y/N] ',
    ]);
  });

  it('stops without a terminal, saying what is missing, and starts nothing', async () => {
    origin();
    gx.state.cloudflareReads = false;
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      1,
    );
    expect(errors.pop()).toBe(
      [
        'Cloudflare builds with its own GitHub app, and it can’t read ada/site yet.',
        `On Cloudflare’s Create application page, choose GitHub and give Cloudflare Workers and Pages ada and the repository (Install & Authorize). When Cloudflare lists your repositories, you’re done: https://dash.cloudflare.com/${account}/workers-and-pages/create`,
        'If ada is already listed there, add the repository on GitHub instead: https://github.com/settings/installations',
        'If Cloudflare already shows the repository, carry on with: shipcel git connect --skip-checks',
        'Then run the command again.',
      ].join('\n'),
    );
    expect(jobs()).toEqual([]);
    expect(gx.state.workers.size).toBe(0);
    // Saying no at the last question starts nothing either.
    gx.state.cloudflareReads = true;
    expect(
      await cli(['git', 'connect', '--cloudflare-builds'], {
        isTTY: true,
        ask: async () => '',
      }),
    ).toBe(1);
    expect(errors.pop()).toBe('Nothing was changed.');
    expect(jobs()).toEqual([]);
    expect(await cli(['git', 'connect', '--cloudflare-builds'])).toBe(1);
    expect(errors.pop()).toContain('Pass --yes to confirm in scripts.');
  });

  it('starts anyway with --skip-checks, and reports what Cloudflare then says', async () => {
    origin();
    gx.state.cloudflareReads = false;
    gx.state.refusal = 'The repository is not accessible';
    expect(
      await cli([
        'git',
        'connect',
        '--cloudflare-builds',
        '--yes',
        '--skip-checks',
      ]),
    ).toBe(1);
    const id = (
      db.sqlite.prepare('SELECT id FROM projects').get() as { id: string }
    ).id;
    expect(errors.pop()).toBe(
      `Cloudflare reported: The repository is not accessible Cloudflare builds with its own GitHub app: let it read ada/site (Connections shows how), then check Cloudflare and resume.\nSee it in the dashboard: https://shipcel.test/app/#projects/${id}/deployments`,
    );
    expect(jobs()).toEqual([
      {
        worker_name: 'site',
        status: 'needs_attention',
        adapter: 'static-assets',
      },
    ]);
  });

  it('lists what stops a repository from deploying, before anything is created', async () => {
    origin();
    gx.state.files['pnpm-lock.yaml'] = '';
    gx.state.files['yarn.lock'] = '';
    delete gx.state.files['package-lock.json'];
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      1,
    );
    expect(errors.pop()).toBe(
      [
        'ada/site can’t deploy yet:',
        '  - Keep one package manager’s lockfile; this repository has pnpm-lock.yaml and yarn.lock.',
        'Fix these in the repository, push, and run shipcel git connect again.',
      ].join('\n'),
    );
    expect(jobs()).toEqual([]);
  });

  it('names the repository itself, or says what it needs', async () => {
    // No Git folder: the repository can be named.
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      1,
    );
    expect(errors.pop()).toContain('This folder has no GitHub remote.');
    expect(
      await cli([
        'git',
        'connect',
        '--cloudflare-builds',
        '--repo',
        'not a repo',
      ]),
    ).toBe(2);
    expect(await cli(['git'])).toBe(2);
    expect(errors.pop()).toContain(
      'Use shipcel git connect, git ls or git disconnect.',
    );
    expect(
      await cli([
        'git',
        'connect',
        '--cloudflare-builds',
        '--repo',
        'ada/site',
        '--yes',
      ]),
    ).toBe(0);
    expect(output.at(-2)).toBe(
      'Production: https://site.test-account.workers.dev/',
    );
    // A folder that isn't that repository isn't linked to its project.
    expect(existsSync(join(dir, 'work', '.shipcel'))).toBe(false);
    // A remote on another host isn't GitHub.
    origin('git@gitlab.com:ada/site.git');
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      1,
    );
    expect(errors.pop()).toContain('This folder has no GitHub remote.');
  });

  it('connects a GitLab.com repository, whose own CI deploys it signed in with GitLab’s token', async () => {
    write('index.html', '<h1>Shop</h1>');
    origin('git@gitlab.com:ada/shop.git');
    write('.git/refs/remotes/origin/HEAD', 'ref: refs/remotes/origin/trunk\n');
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toEqual([
      'Connecting GitLab repository: https://gitlab.com/ada/shop',
      'Created the project work.',
      'Added .shipcel to .gitignore.',
      'Wrote .gitlab-ci.yml.',
      'Commit .gitlab-ci.yml and push: every push to trunk deploys work to production while trunk is protected in GitLab, and other branches deploy previews.',
    ]);
    const job = readFileSync(join(dir, 'work', '.gitlab-ci.yml'), 'utf8');
    expect(job).toContain(
      '    SHIPCEL_ID_TOKEN:\n      aud: https://shipcel.test\n',
    );
    expect(job).toContain(
      '    - npx --yes --package=https://shipcel.test/cli/shipcel.tgz shipcel deploy\n',
    );
    expect(job).not.toContain('SHIPCEL_TOKEN');
    expect(
      db.sqlite
        .prepare('SELECT provider, host, repository, branch FROM git_sources')
        .all(),
    ).toEqual([
      {
        provider: 'gitlab',
        host: 'gitlab.com',
        repository: 'ada/shop',
        branch: 'trunk',
      },
    ]);
    // A file of the person's own is never replaced: what to add is shown instead.
    write('.gitlab-ci.yml', 'test:\n  script: [npm test]\n');
    output = [];
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(output[1]).toBe(
      '.gitlab-ci.yml is there already, so it was left alone. Add this to it:',
    );
    expect(output[2]).toBe(job);
    expect(readFileSync(join(dir, 'work', '.gitlab-ci.yml'), 'utf8')).toBe(
      'test:\n  script: [npm test]\n',
    );
  });

  it('connects a Bitbucket repository, whose pipeline signs in with a deploy token', async () => {
    write('index.html', '<h1>Shop</h1>');
    origin('https://ada@bitbucket.org/ada/shop.git');
    expect(await cli(['git', 'connect', '--yes', '--branch', 'main'])).toBe(0);
    expect(errors).toEqual([]);
    const [{ id }] = db.sqlite.prepare('SELECT id FROM projects').all() as {
      id: string;
    }[];
    expect(output.slice(-3)).toEqual([
      'Wrote bitbucket-pipelines.yml.',
      'Its jobs sign in with a deploy token: make one with shipcel tokens add "Bitbucket: ada/shop" --project work, and keep it as a secured repository variable (Repository settings → Repository variables) named SHIPCEL_TOKEN.',
      'Commit bitbucket-pipelines.yml and push: every push to main deploys work to production, and other branches deploy previews.',
    ]);
    const pipeline = readFileSync(
      join(dir, 'work', 'bitbucket-pipelines.yml'),
      'utf8',
    );
    expect(pipeline).toContain(`shipcel deploy --prod --project ${id} --yes`);
    expect(pipeline).toContain(`shipcel deploy --project ${id} --yes`);
    // Cloudflare's builds connect GitHub repositories only.
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      1,
    );
    expect(errors.pop()).toContain(
      'Cloudflare’s builds connect GitHub repositories only',
    );
  });

  it('chooses between remotes, and build tokens, when there are several', async () => {
    write(
      '.git/config',
      [
        '[remote "upstream"]',
        '\turl = https://github.com/team/site.git',
        '[remote "origin"]',
        '\turl = https://x-access-token:ghs_secret@github.com/ada/site.git',
        '',
      ].join('\n'),
    );
    gx.state.tokens = [
      buildToken,
      {
        build_token_uuid: '10000000-0000-4000-8000-000000000009',
        build_token_name: 'Older token',
      },
    ];
    // In a script the token has to be named.
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      1,
    );
    expect(errors.pop()).toBe(
      'This account has several build tokens. Choose one: --build-token <name> (Shipcel builds, Older token).',
    );
    const asked: string[] = [];
    output = [];
    expect(
      await cli(['git', 'connect', '--cloudflare-builds'], {
        isTTY: true,
        ask: async (question) => {
          asked.push(question);
          return /^Which build token/.test(question)
            ? 'Older token'
            : /\[y\/N\]/.test(question)
              ? 'y'
              : '';
        },
      }),
    ).toBe(0);
    expect(output.slice(0, 4)).toEqual([
      'Found multiple remote URLs:',
      '  origin  ada/site',
      '  upstream  team/site',
      'Connecting GitHub repository: https://github.com/ada/site',
    ]);
    expect(asked.slice(0, 2)).toEqual([
      'Which remote do you want to connect? [origin] ',
      'Which build token? Shipcel builds, Older token [Shipcel builds] ',
    ]);
    expect(gx.state.triggers[0]).toMatchObject({
      build_token_uuid: '10000000-0000-4000-8000-000000000009',
    });
    // A token in a remote's address is never shown.
    expect([...output, ...errors, ...asked].join('\n')).not.toContain(
      'ghs_secret',
    );
  });

  it('keeps a project deployed from this computer as it is, and says how to add one for pushes', async () => {
    origin();
    expect(await cli(['project', 'add', 'site'])).toBe(0);
    expect(await cli(['link', '--project', 'site'])).toBe(0);
    const who = db.sqlite
      .prepare('SELECT user_id, workspace_id FROM api_tokens')
      .get() as { user_id: string; workspace_id: string };
    const project = db.sqlite.prepare('SELECT id FROM projects').get() as {
      id: string;
    };
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,worker_tag,idempotency_key,created_at,updated_at,adapter,environment) VALUES ('job-1',?,?,?,'','',?,'','','','','','site','','deployed','finished',?,'upload:1',0,0,'direct-upload','production')",
      )
      .run(who.workspace_id, project.id, who.user_id, account, 'c'.repeat(32));
    expect(await cli(['git', 'connect', '--cloudflare-builds', '--yes'])).toBe(
      1,
    );
    expect(errors.pop()).toBe(
      'site is deployed with shipcel deploy, and a project deploys one way. To have Cloudflare build every push, give the repository a project of its own: shipcel git connect --cloudflare-builds --name <another-name>',
    );
    expect(gx.state.triggers).toEqual([]);
    expect(
      await cli([
        'git',
        'connect',
        '--cloudflare-builds',
        '--yes',
        '--name',
        'site-from-git',
      ]),
    ).toBe(0);
    expect(jobs().at(-1)).toEqual({
      worker_name: 'site-from-git',
      status: 'deployed',
      adapter: 'static-assets',
    });
  });

  it('connects the folder’s repository through GitHub Actions: Shipcel adds the workflow, and every push deploys', async () => {
    origin();
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toEqual([
      'Connecting GitHub repository: https://github.com/ada/site',
      'Created the project site.',
      'Added .shipcel to .gitignore.',
      `Added the workflow to ada/site: https://github.com/ada/site/commit/${'c'.repeat(40)}`,
      'Every push deploys now: main to production, other branches as previews. Follow the runs: https://github.com/ada/site/actions',
      'Run git pull to bring the workflow into this folder.',
    ]);
    expect(gx.state.commits).toEqual([
      {
        path: '.github/workflows/shipcel.yml',
        message: 'Deploy with Shipcel',
        branch: 'main',
      },
    ]);
    expect(gx.state.files['.github/workflows/shipcel.yml']).toBe(
      workflowFile('https://shipcel.test'),
    );
    // Nothing is created in Cloudflare until the first push deploys.
    expect(gx.state.triggers).toEqual([]);
    expect(gx.state.workers.size).toBe(0);
    expect(projects()).toEqual([
      {
        name: 'site',
        framework: 'worker',
        source: 'github',
        repository: 'https://github.com/ada/site',
      },
    ]);
    output = [];
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(output).toEqual([
      'Connecting GitHub repository: https://github.com/ada/site',
      'site already deploys ada/site on every push: main to production, other branches as previews. Runs: https://github.com/ada/site/actions',
    ]);
    output = [];
    expect(await cli(['git', 'ls'])).toBe(0);
    expect(output).toEqual([
      'site deploys ada/site with GitHub Actions: main to production, other branches as previews. Runs: https://github.com/ada/site/actions',
    ]);
    expect(await cli(['git', 'disconnect'])).toBe(1);
    expect(errors.pop()).toBe(
      'Stop deploying ada/site to site? Pass --yes to confirm in scripts.',
    );
    output = [];
    expect(await cli(['git', 'disconnect', '--yes'])).toBe(0);
    expect(output).toEqual([
      'Disconnected ada/site: its pushes don’t deploy site anymore. Its workflow is still in the repository; delete it there: https://github.com/ada/site/blob/main/.github/workflows/shipcel.yml',
    ]);
    output = [];
    expect(await cli(['git', 'ls'])).toBe(0);
    expect(output).toEqual([
      'site is set up for ada/site and hasn’t deployed from GitHub yet. Run shipcel git connect.',
    ]);
    expect(await cli(['git', 'disconnect', '--yes'])).toBe(1);
    expect(errors.pop()).toBe('site isn’t connected to a Git repository.');
    // Connected again, the workflow already there is kept.
    output = [];
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(output.slice(-2)).toEqual([
      'ada/site has .github/workflows/shipcel.yml already, so Shipcel kept it.',
      'Every push deploys now: main to production, other branches as previews. Follow the runs: https://github.com/ada/site/actions',
    ]);
    expect(gx.state.commits).toHaveLength(1);
  });

  it('says that GitHub Actions can’t reach a Shipcel on this computer, before anything is created', async () => {
    origin();
    expect(
      await run(
        ['git', 'connect', '--yes'],
        io(
          toShipcel,
          {},
          {
            SHIPCEL_URL: 'http://127.0.0.1:5173',
            SHIPCEL_TOKEN: token,
          },
        ),
      ),
    ).toBe(1);
    expect(errors.pop()).toBe(
      'GitHub Actions can’t reach the Shipcel on this computer (http://127.0.0.1:5173). Deploy every push with Cloudflare’s own builds instead: shipcel git connect --cloudflare-builds. Or deploy from here: shipcel deploy.',
    );
    expect(projects()).toEqual([]);
  });

  it('says how to add the workflow by hand when GitHub refuses the commit', async () => {
    origin();
    gx.state.commitStatus = 409;
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    const add = `https://github.com/ada/site/new/main?filename=${encodeURIComponent('.github/workflows/shipcel.yml')}&value=${encodeURIComponent(workflowFile('https://shipcel.test'))}`;
    expect(output.slice(-2)).toEqual([
      'Linked ada/site to site, but the workflow isn’t in the repository yet. GitHub didn’t accept a commit to main. A protected branch takes changes through pull requests only.',
      `Add it on GitHub, on this page filled in for you: ${add}`,
    ]);
    expect(opened).toEqual([add]);
    expect(gx.state.commits).toEqual([]);
  });

  it('says where to install Shipcel’s app when that is why GitHub refused, and adds the workflow when connected again', async () => {
    origin();
    gx.state.commitStatus = 404;
    gx.state.installations = [];
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    const add = `https://github.com/ada/site/new/main?filename=${encodeURIComponent('.github/workflows/shipcel.yml')}&value=${encodeURIComponent(workflowFile('https://shipcel.test'))}`;
    const install = 'https://github.com/apps/shipcel-test/installations/new';
    expect(output.slice(-3)).toEqual([
      'Linked ada/site to site, but the workflow isn’t in the repository yet. Shipcel’s GitHub App isn’t installed on ada, so it can’t commit there. Install it on ada and connect again, or add the file by hand.',
      `GitHub’s page for that: ${install}`,
      `Or add it on GitHub, on this page filled in for you: ${add}`,
    ]);
    expect(opened).toEqual([install]);
    // Installed now: connecting again adds it, after asking, since it commits to the repository.
    gx.state.commitStatus = 201;
    output = [];
    expect(await cli(['git', 'connect'])).toBe(1);
    expect(errors.pop()).toContain('Pass --yes to confirm in scripts.');
    expect(gx.state.commits).toEqual([]);
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(output.slice(-3)).toEqual([
      `Added the workflow to ada/site: https://github.com/ada/site/commit/${'c'.repeat(40)}`,
      'Every push deploys now: main to production, other branches as previews. Follow the runs: https://github.com/ada/site/actions',
      'Run git pull to bring the workflow into this folder.',
    ]);
    expect(gx.state.commits).toHaveLength(1);
  });

  it('asks before adding the workflow, also for a project deployed from this computer', async () => {
    origin();
    expect(await cli(['project', 'add', 'site'])).toBe(0);
    expect(await cli(['link', '--project', 'site'])).toBe(0);
    const who = db.sqlite
      .prepare('SELECT user_id, workspace_id FROM api_tokens')
      .get() as { user_id: string; workspace_id: string };
    const project = db.sqlite.prepare('SELECT id FROM projects').get() as {
      id: string;
    };
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,worker_tag,idempotency_key,created_at,updated_at,adapter,environment) VALUES ('job-1',?,?,?,'','',?,'','','','','','site','','deployed','finished',?,'upload:1',0,0,'direct-upload','production')",
      )
      .run(who.workspace_id, project.id, who.user_id, account, 'c'.repeat(32));
    expect(await cli(['git', 'connect'])).toBe(1);
    expect(errors.pop()).toBe(
      'Add a workflow to ada/site (.github/workflows/shipcel.yml) so GitHub Actions builds every push and deploys it to site? Pushes to its default branch go to production, other branches to previews. Pass --yes to confirm in scripts.',
    );
    expect(
      await cli(['git', 'connect'], { isTTY: true, ask: async () => '' }),
    ).toBe(1);
    expect(errors.pop()).toBe('Nothing was changed.');
    expect(gx.state.commits).toEqual([]);
    // Deployed from here, it deploys every push too: both upload through Shipcel.
    expect(await cli(['git', 'connect', '--yes'])).toBe(0);
    expect(gx.state.commits).toHaveLength(1);
  });

  it('offers to deploy from GitHub when a new project is set up in a repository’s folder', async () => {
    origin();
    write(
      'package.json',
      JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^8.0.0' },
      }),
    );
    const asked: string[] = [];
    expect(
      await cli([], {
        isTTY: true,
        ask: async (question) => {
          asked.push(question);
          return /^(Connect ada\/site|Add a workflow)/.test(question)
            ? 'y'
            : /^Project name/.test(question)
              ? 'site'
              : '';
        },
      }),
    ).toBe(0);
    expect(asked).toEqual([
      `Set up and deploy “${join(dir, 'work')}”? [Y/n] `,
      'Project name [work]: ',
      'Connect ada/site so every push deploys, built by GitHub Actions? [y/N] ',
      'Add a workflow to ada/site (.github/workflows/shipcel.yml) so GitHub Actions builds every push and deploys it to site? Pushes to its default branch go to production, other branches to previews. [y/N] ',
    ]);
    expect(output.slice(-3)).toEqual([
      `Added the workflow to ada/site: https://github.com/ada/site/commit/${'c'.repeat(40)}`,
      'Every push deploys now: main to production, other branches as previews. Follow the runs: https://github.com/ada/site/actions',
      'Run git pull to bring the workflow into this folder.',
    ]);
    // GitHub Actions builds it: nothing was built or uploaded from here.
    expect(ran).toEqual([]);
    expect(gx.state.commits).toHaveLength(1);
    expect(projects()).toMatchObject([{ name: 'site', source: 'github' }]);
  });
});

describe('shipcel deploy in GitHub Actions, against the real Shipcel API', () => {
  let db: ReturnType<typeof database>;
  let fx: ReturnType<typeof cloudflareUploads>;
  let key: Awaited<ReturnType<typeof actionsKey>>;
  // GitHub's address for the run's token, as the runner sets it, and what it was asked.
  const requestUrl =
    'https://pipelines.actions.githubusercontent.test/idtoken/run-1?api-version=2.0';
  let asked: { url: string; authorization: string | null }[];
  // What GitHub's token for the run says, beyond a push to main of alice/landing.
  let claims: Record<string, unknown>;
  beforeAll(async () => {
    key = await actionsKey('key-1');
  });
  beforeEach(async () => {
    db = database();
    const who = await db.user(1);
    await db.grant(who, 'github');
    await db.grant(who, 'cloudflare');
    fx = cloudflareUploads();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        String(input) === jwksUrl ||
        String(input) === 'https://gitlab.com/oauth/discovery/keys'
          ? jwks([key])
          : fx.handler(input, init),
      ),
    );
    // A project linked to alice/landing, as shipcel git connect leaves it.
    const created = await db.request(
      '/projects',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'landing',
          framework: 'static',
          repository: '',
          database: false,
          storage: false,
        }),
      },
      who.cookie,
    );
    const { id } = (await created.json()) as { id: string };
    db.sqlite
      .prepare('INSERT INTO github_actions VALUES (?,?,?,?,?,?,?,?)')
      .run(
        id,
        who.workspaceId,
        501,
        42,
        'alice/landing',
        'main',
        who.userId,
        0,
      );
    asked = [];
    claims = {};
    write('index.html', '<h1>Hello</h1>');
  });
  afterEach(() => db.close());
  // The runner of a job of the workflow: GitHub's environment, and no Shipcel token.
  const runner = (env: Record<string, string> = {}) =>
    io(
      (async (url: string | URL | Request, init?: RequestInit) => {
        if (
          String(url).startsWith(
            'https://pipelines.actions.githubusercontent.test/',
          )
        ) {
          asked.push({
            url: String(url),
            authorization: new Headers(init?.headers).get('Authorization'),
          });
          return Response.json({
            count: 1,
            value: await runToken(key, 'https://shipcel.test', claims),
          });
        }
        return app.request(String(url), init, db.env);
      }) as typeof globalThis.fetch,
      {},
      {
        SHIPCEL_URL: 'https://shipcel.test',
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
        ...env,
      },
    );

  it('signs in with GitHub’s token for the run, and deploys the production branch to production', async () => {
    expect(await run(['deploy'], runner())).toBe(0);
    expect(errors).toEqual([]);
    expect(asked).toEqual([
      {
        url: `${requestUrl}&audience=${encodeURIComponent('https://shipcel.test')}`,
        authorization: 'Bearer request-token',
      },
    ]);
    expect(output[0]).toBe(
      'GitHub Actions: deploying main of alice/landing to landing, in production.',
    );
    expect(output).toContain(
      'Production: https://landing.test-account.workers.dev/',
    );
  });

  it('deploys a preview from another branch once production has deployed, whatever the workflow asks', async () => {
    claims = { ref: 'refs/heads/feature' };
    expect(await run(['deploy'], runner())).toBe(1);
    expect(output[0]).toBe(
      'GitHub Actions: deploying feature of alice/landing to landing, as a preview.',
    );
    expect(errors.pop()).toBe(previewOnlyRun);
    claims = {};
    expect(await run(['deploy'], runner())).toBe(0);
    claims = { ref: 'refs/heads/feature' };
    output = [];
    expect(await run(['deploy', '--prod'], runner())).toBe(0);
    expect(output).toContain(
      'Production: https://landing.test-account.workers.dev/ (unchanged). To make this version production: shipcel promote 00000002',
    );
  });

  it('signs a GitLab.com job in with its ID token, and deploys its branch', async () => {
    const linked = db.sqlite
      .prepare('SELECT project_id, workspace_id, user_id FROM github_actions')
      .get() as { project_id: string; workspace_id: string; user_id: string };
    db.sqlite.prepare('DELETE FROM github_actions').run();
    db.sqlite
      .prepare(
        "INSERT INTO git_sources(project_id,workspace_id,provider,host,repository,branch,user_id,created_at) VALUES (?,?,'gitlab','gitlab.com','ada/landing','main',?,0)",
      )
      .run(linked.project_id, linked.workspace_id, linked.user_id);
    // GitLab's ID token for the job, as the job named SHIPCEL_ID_TOKEN gets it.
    const job = (claims: Record<string, unknown> = {}) =>
      runToken(key, 'https://shipcel.test', {
        iss: 'https://gitlab.com',
        project_id: '9001',
        project_path: 'ada/landing',
        namespace_id: '77',
        ref: 'main',
        ref_type: 'branch',
        ref_protected: 'true',
        pipeline_source: 'push',
        job_id: '6001',
        sha: 'e'.repeat(40),
        repository: undefined,
        repository_id: undefined,
        repository_owner_id: undefined,
        event_name: undefined,
        run_id: undefined,
        ...claims,
      });
    const gitlab = (env: Record<string, string>) =>
      io(
        ((url: string | URL | Request, init?: RequestInit) =>
          app.request(String(url), init, db.env)) as typeof globalThis.fetch,
        {},
        { SHIPCEL_URL: 'https://shipcel.test', GITLAB_CI: 'true', ...env },
      );
    // Its CI file names the project, as shipcel git connect writes it.
    const deploy = ['deploy', '--project', linked.project_id];
    expect(await run(deploy, gitlab({ SHIPCEL_ID_TOKEN: await job() }))).toBe(
      0,
    );
    expect(errors).toEqual([]);
    expect(output[0]).toBe(
      'GitLab CI: deploying main of ada/landing to landing, in production.',
    );
    expect(output).toContain(
      'Production: https://landing.test-account.workers.dev/',
    );
    expect(await run(deploy, gitlab({}))).toBe(1);
    expect(errors.pop()).toBe(
      'This GitLab job can’t sign in to Shipcel: give it an ID token named SHIPCEL_ID_TOKEN with Shipcel’s address as its audience (the job shipcel git connect adds has it), or set SHIPCEL_TOKEN to a deploy token.',
    );
    expect(
      await run(
        ['deploy'],
        gitlab({ SHIPCEL_ID_TOKEN: await job({ job_id: '6002' }) }),
      ),
    ).toBe(1);
    expect(errors.pop()).toBe(
      'This GitLab job names no project: deploy with --project <id>, as the job shipcel git connect adds does.',
    );
  });

  it('says what the run needs to sign in, and uses a token it is given instead', async () => {
    expect(
      await run(['deploy'], runner({ ACTIONS_ID_TOKEN_REQUEST_URL: '' })),
    ).toBe(1);
    expect(errors.pop()).toBe(
      'This GitHub Actions job can’t sign in to Shipcel: give its workflow permissions: id-token: write (the workflow shipcel git connect adds has it), or set SHIPCEL_TOKEN to an API token.',
    );
    claims = { repository_id: '999', repository: 'alice/other' };
    expect(await run(['deploy'], runner())).toBe(1);
    expect(errors.pop()).toBe(
      'alice/other isn’t linked to a project in this Shipcel. Link it on the project’s Deployments page, or with shipcel git connect.',
    );
    asked = [];
    expect(
      await run(
        ['deploy', '--project', 'landing', '--yes'],
        runner({ SHIPCEL_TOKEN: `cc_pat_${'x'.repeat(43)}` }),
      ),
    ).toBe(1);
    expect(asked).toEqual([]);
    expect(errors.pop()).toBe(
      'Your Shipcel token is no longer valid. Run shipcel login.',
    );
  });
});

describe('.shipcelignore', () => {
  it('matches names anywhere, anchored paths, folders and wildcards', () => {
    const ignored = ignoreMatcher(
      '*.map\n/drafts/\nsecret-*.txt\n**/tmp/**\n# comment\n',
    );
    expect(ignored('/assets/app.js.map')).toBe(true);
    expect(ignored('/drafts/')).toBe(true);
    expect(ignored('/blog/drafts/')).toBe(false);
    expect(ignored('/notes/secret-1.txt')).toBe(true);
    expect(ignored('/a/tmp/b.txt')).toBe(true);
    expect(ignored('/index.html')).toBe(false);
  });
});

describe('the published shipcel binary', () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, ['scripts/build-cli.mjs'], {
      encoding: 'utf8',
    });
    expect(built.status).toBe(0);
  });

  it('runs on Node and prints its help', () => {
    const help = spawnSync(
      process.execPath,
      ['packages/cli/dist/shipcel.js', '--help'],
      {
        encoding: 'utf8',
      },
    );
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('shipcel [deploy] [folder]');
    expect(help.stdout).toContain('shipcel promote <version|url>');
    const unknown = spawnSync(
      process.execPath,
      ['packages/cli/dist/shipcel.js', 'nope'],
      {
        encoding: 'utf8',
      },
    );
    expect(unknown.status).toBe(2);
  });

  it('is packed as an npm package that Shipcel serves at /cli/shipcel.tgz', () => {
    const out = join(dir, 'unpacked');
    mkdirSync(out);
    const unpacked = spawnSync(
      'tar',
      ['-xzf', 'public/cli/shipcel.tgz', '-C', out],
      { encoding: 'utf8' },
    );
    expect(unpacked.status).toBe(0);
    expect(readdirSync(join(out, 'package')).sort()).toEqual([
      'README.md',
      'dist',
      'package.json',
    ]);
    const manifest = JSON.parse(
      readFileSync(join(out, 'package', 'package.json'), 'utf8'),
    );
    expect(manifest.bin).toEqual({ shipcel: 'dist/shipcel.js' });
    expect(
      statSync(join(out, 'package', 'dist', 'shipcel.js')).mode & 0o111,
    ).not.toBe(0);
    const help = spawnSync(
      process.execPath,
      [join(out, 'package', 'dist', 'shipcel.js'), '--help'],
      { encoding: 'utf8' },
    );
    expect(help.stdout).toContain('shipcel [deploy] [folder]');
  });
});
