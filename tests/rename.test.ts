import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database, projectInput } from './helpers/database';
import { cloudflareUploads } from './helpers/cloudflare-uploads';
import { run, type Io } from '../packages/cli/src/cli';
import app from '../worker/index';

// What keeps working from before Cloudcel became Shipcel (23 Oct 2026): the CLI reads the
// sign-in, folder links, ignore files and variables the cloudcel command saved, and
// Shipcel takes the request header CLIs installed earlier send.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let fx: ReturnType<typeof cloudflareUploads>;
let dir: string, output: string[], errors: string[], token: string;

function io(env: Record<string, string> = {}, cwd = join(dir, 'work')): Io {
  return {
    env,
    cwd,
    home: dir,
    hostname: 'ada-laptop',
    isTTY: false,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
    fetch: ((url: string, init: RequestInit) =>
      new URL(String(url)).hostname.endsWith('.workers.dev')
        ? Promise.resolve(new Response('ok'))
        : app.request(url, init, db.env)) as typeof globalThis.fetch,
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
  };
}
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const read = (path: string) =>
  JSON.parse(readFileSync(join(dir, path), 'utf8'));
const signedIn = { SHIPCEL_URL: 'https://shipcel.test' };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipcel-rename-'));
  mkdirSync(join(dir, 'work'));
  output = [];
  errors = [];
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  fx = cloudflareUploads();
  vi.stubGlobal('fetch', vi.fn(fx.handler));
  token = (
    (await (
      await db.request(
        '/tokens',
        { method: 'POST', body: JSON.stringify({ name: 'CLI' }) },
        who.cookie,
      )
    ).json()) as { token: string }
  ).token;
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('after the rename to Shipcel', () => {
  it('reads the sign-in the cloudcel command saved, until a new one is saved', async () => {
    write(
      '.config/cloudcel/config.json',
      JSON.stringify({ url: 'https://shipcel.test', token }),
    );
    expect(await run(['whoami'], io())).toBe(0);
    expect(output[0]).toMatch(/^Signed in as .+ on https:\/\/shipcel\.test\.$/);
    // Signing out saves the new place, which is read from then on.
    expect(await run(['logout'], io())).toBe(0);
    expect(read('.config/shipcel/config.json')).toEqual({
      url: 'https://shipcel.test',
    });
    expect(await run(['whoami'], io())).toBe(1);
    expect(errors.at(-1)).toContain('Not signed in');
    // The earlier variable for the folder still names it.
    write(
      'old-config/config.json',
      JSON.stringify({ url: 'https://shipcel.test', token }),
    );
    expect(
      await run(
        ['whoami'],
        io({ CLOUDCEL_CONFIG_DIR: join(dir, 'old-config') }),
      ),
    ).toBe(0);
  });

  it('reads CLOUDCEL_URL and CLOUDCEL_TOKEN, with the SHIPCEL_ ones first', async () => {
    const earlier = {
      CLOUDCEL_URL: 'https://shipcel.test',
      CLOUDCEL_TOKEN: token,
    };
    expect(await run(['whoami'], io(earlier))).toBe(0);
    expect(
      await run(
        ['whoami'],
        io({ ...earlier, SHIPCEL_TOKEN: 'ss_not-a-token' }),
      ),
    ).toBe(1);
    expect(errors.at(-1)).toContain('token is no longer valid');
    expect(
      await run(
        ['whoami'],
        io({ ...earlier, SHIPCEL_URL: 'https://elsewhere.test' }),
      ),
    ).toBe(1);
  });

  it('keeps a folder’s .cloudcel link, updates it there, and links new folders in .shipcel', async () => {
    const ids: Record<string, string> = {};
    for (const name of ['first', 'second'])
      ids[name] = (
        (await (
          await db.request(
            '/projects',
            { method: 'POST', body: JSON.stringify(projectInput(name)) },
            who.cookie,
          )
        ).json()) as { id: string }
      ).id;
    write(
      'work/.cloudcel/project.json',
      JSON.stringify({ projectId: ids.first, name: 'first' }),
    );
    const env = { ...signedIn, SHIPCEL_TOKEN: token };
    expect(await run(['project', 'inspect'], io(env))).toBe(0);
    expect(output[0]).toContain(`first (${ids.first})`);
    expect(await run(['link', '--project', 'second'], io(env))).toBe(0);
    expect(read('work/.cloudcel/project.json')).toMatchObject({
      projectId: ids.second,
    });
    expect(existsSync(join(dir, 'work', '.shipcel'))).toBe(false);
    mkdirSync(join(dir, 'other'));
    expect(
      await run(['link', '--project', 'first'], io(env, join(dir, 'other'))),
    ).toBe(0);
    expect(read('other/.shipcel/project.json')).toMatchObject({
      projectId: ids.first,
    });
  });

  it('leaves out what .cloudcelignore lists when there is no .shipcelignore', async () => {
    write('work/site/index.html', '<h1>Hello</h1>');
    write('work/site/app.js.map', '{}');
    write('work/site/.cloudcelignore', '*.map\n');
    const env = { ...signedIn, SHIPCEL_TOKEN: token };
    const deploy = (name: string) =>
      run(['deploy', 'site', '--yes', '--name', name, '--prod'], io(env));
    const stored = () =>
      [...fx.state.stored.values()].map((f) =>
        Buffer.from(f.content, 'base64').toString(),
      );
    expect(await deploy('old-ignore')).toBe(0);
    expect(stored()).toEqual(['<h1>Hello</h1>']);
    // .shipcelignore wins when both are there.
    write('work/site/.shipcelignore', '# nothing left out\n');
    rmSync(join(dir, 'work', '.shipcel'), { recursive: true, force: true });
    expect(await deploy('new-ignore')).toBe(0);
    expect(stored()).toContain('{}');
  });

  it('takes the same-origin header under its earlier name', async () => {
    const post = (headers: Record<string, string>) =>
      app.request(
        'https://shipcel.test/api/projects',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: who.cookie,
            ...headers,
          },
          body: JSON.stringify(projectInput('header-check')),
        },
        db.env,
      );
    expect((await post({})).status).toBe(403);
    expect((await post({ 'X-Cloudcel-Request': '1' })).status).toBe(201);
    expect((await post({ 'X-Shipcel-Request': '1' })).status).toBe(409);
  });
});
