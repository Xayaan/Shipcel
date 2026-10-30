import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database, projectInput } from './helpers/database';
import { run, type Io } from '../packages/cli/src/cli';
import app from '../worker/index';
import { now } from '../worker/types';

// shipcel cache purge and shipcel redirects (packages/cli/src/edge.ts, worker/dns.ts).
let db: ReturnType<typeof database>;
let dir: string, output: string[], errors: string[];
const account = 'a'.repeat(32),
  worker = 'cc-shop-worker',
  zone = 'f'.repeat(32);
let domains: unknown[], purgeStatus: number;
const purges: { zone: string; body: unknown }[] = [];

function io(): Io {
  return {
    env: { SHIPCEL_CONFIG_DIR: join(dir, 'config') },
    cwd: join(dir, 'work'),
    home: dir,
    hostname: 'ada-laptop',
    isTTY: false,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
    fetch: ((url: string, init: RequestInit) =>
      app.request(url, init, db.env)) as typeof globalThis.fetch,
    open: async () => {},
    run: async () => 0,
    sleep: async () => {},
    ask: async () => 'y',
    askSecret: async () => '',
    stdin: async () => '',
    fs: {
      readFile: async (p) => new Uint8Array(readFileSync(p)),
      writeFile: async (p, data) => writeFileSync(p, data),
      mkdir: async (p) => {
        mkdirSync(p, { recursive: true });
      },
      remove: async (p) => rmSync(p, { force: true }),
      readdir: async () => [],
      size: async () => 0,
      exists: async (p) => existsSync(p),
    },
  };
}
const cli = (...argv: string[]) => run(argv, io());
const file = (path: string) => join(dir, 'work', path);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipcel-edge-'));
  mkdirSync(join(dir, 'work', '.shipcel'), { recursive: true });
  output = [];
  errors = [];
  purges.length = 0;
  purgeStatus = 200;
  db = database();
  const who = await db.user(1);
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput('shop')) },
    who.cookie,
  );
  const projectId = ((await created.json()) as { id: string }).id;
  const job = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: account,
    repository_id: '1',
    repository_name: 'ada/shop',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: worker,
    build_command: '',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: 'c'.repeat(32),
  };
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${Object.keys(job).join(',')}) VALUES (${Object.keys(
        job,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(job));
  const token = (
    (await (
      await db.request(
        '/tokens',
        { method: 'POST', body: JSON.stringify({ name: 'CLI' }) },
        who.cookie,
      )
    ).json()) as { token: string }
  ).token;
  mkdirSync(join(dir, 'config'));
  writeFileSync(
    join(dir, 'config', 'config.json'),
    JSON.stringify({ url: 'https://shipcel.test', token }),
  );
  writeFileSync(
    file('.shipcel/project.json'),
    JSON.stringify({ projectId, name: 'shop' }),
  );
  domains = [
    { hostname: 'Shop.Example.com', service: worker, zone_id: zone },
    { hostname: 'blog.example.com', service: 'another-app', zone_id: zone },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const path = new URL(String(raw)).pathname.replace('/client/v4', '');
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (path === `/accounts/${account}/workers/scripts`)
        return ok([{ id: worker, tag: 'c'.repeat(32) }]);
      if (path === `/accounts/${account}/workers/domains`) return ok(domains);
      if (path.endsWith('/purge_cache')) {
        purges.push({
          zone: path.split('/')[2],
          body: JSON.parse(String(init.body)),
        });
        return purgeStatus === 200
          ? ok({ id: 'p' })
          : Response.json(
              {
                success: false,
                errors: [{ code: 10000, message: 'Authentication error' }],
              },
              { status: purgeStatus },
            );
      }
      throw new Error(`Unexpected ${init.method ?? 'GET'} ${raw}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('shipcel cache purge', () => {
  it('purges the app’s own custom domains, or URLs on them, after confirmation', async () => {
    expect(await cli('cache', 'purge')).toBe(1);
    expect(errors.at(-1)).toContain('Pass --yes to confirm in scripts.');
    expect(await cli('cache', 'purge', '--yes')).toBe(0);
    expect(output.at(-1)).toBe('Purged the cache of shop.example.com.');
    // Another app's domain in the same zone is left alone.
    expect(purges).toEqual([{ zone, body: { hosts: ['shop.example.com'] } }]);
    expect(
      await cli('cache', 'purge', 'https://shop.example.com/logo.png', '--yes'),
    ).toBe(0);
    expect(purges.at(-1)).toEqual({
      zone,
      body: { files: ['https://shop.example.com/logo.png'] },
    });
    expect(
      await cli('cache', 'purge', 'https://blog.example.com/', '--yes'),
    ).toBe(1);
    expect(errors.at(-1)).toBe(
      "blog.example.com isn't one of this app's custom domains.",
    );
    expect(await cli('cache', 'purge', 'logo.png', '--yes')).toBe(2);
  });

  it('says why when there is nothing to purge or the connection may not purge', async () => {
    purgeStatus = 403;
    expect(await cli('cache', 'purge', '--yes')).toBe(1);
    expect(errors.at(-1)).toContain('no Cache Purge permission');
    domains = [];
    expect(await cli('cache', 'purge', '--yes')).toBe(1);
    expect(errors.at(-1)).toContain('a workers.dev address has none to purge');
  });
});

describe('shipcel redirects', () => {
  it('adds, lists and removes redirects in the static files’ _redirects, and checks it', async () => {
    mkdirSync(file('public'));
    expect(await cli('redirects')).toBe(0);
    expect(output.at(-1)).toBe(
      'No redirects in public/_redirects. Add one: shipcel redirects add /old /new',
    );
    expect(await cli('redirects', 'add', '/old', '/new')).toBe(0);
    expect(
      await cli(
        'redirects',
        'add',
        '/blog/:slug',
        'https://blog.example.com/:slug',
        '--status',
        '302',
      ),
    ).toBe(0);
    expect(output.at(-1)).toContain('from the next deploy (shipcel --prod)');
    expect(readFileSync(file('public/_redirects'), 'utf8')).toBe(
      '/old /new 301\n/blog/:slug https://blog.example.com/:slug 302\n',
    );
    output = [];
    expect(await cli('redirects', 'ls')).toBe(0);
    expect(output.slice(0, 3)).toEqual([
      'From         To                              Status',
      '/old         /new                            301',
      '/blog/:slug  https://blog.example.com/:slug  302',
    ]);
    expect(output[3]).toMatch(
      /^2 redirects \(1 dynamic\) in public\/_redirects\./,
    );
    for (const argv of [
      ['redirects', 'add', '/old', '/elsewhere'],
      ['redirects', 'add', 'old', '/new'],
      ['redirects', 'add', '/x', '/y', '--status', '200'],
    ])
      expect(await cli(...argv), argv.join(' ')).not.toBe(0);
    expect(await cli('redirects', 'rm', '/old')).toBe(0);
    expect(readFileSync(file('public/_redirects'), 'utf8')).toBe(
      '/blog/:slug https://blog.example.com/:slug 302\n',
    );
    expect(await cli('redirects', 'rm', '/old')).toBe(1);
  });

  it('reports a file Workers would refuse, and a folder of files keeps its own', async () => {
    writeFileSync(
      file('_redirects'),
      `# hand-written\n/a /b 301\n/broken\n${Array.from({ length: 101 }, (_, i) => `/d/${i}/* /e 302`).join('\n')}\n`,
    );
    expect(await cli('redirects', 'ls')).toBe(1);
    expect(output).toContain(
      'Problem: Line 3 isn\'t "/from /to [301|302|303|307|308]": /broken',
    );
    expect(output).toContain(
      'Problem: 101 dynamic redirects: Workers takes 100.',
    );
    expect(errors.at(-1)).toBe('Fix _redirects before deploying.');
  });
});
