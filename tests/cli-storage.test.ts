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

// shipcel storage (packages/cli/src/storage.ts) through Manage → Storage's routes, with
// Cloudflare's KV and R2 faked.
let dir: string, output: string[], errors: string[];
let db: ReturnType<typeof database>;
const account = 'a'.repeat(32),
  worker = 'cc-shop-worker',
  namespace = '0123456789abcdef0123456789abcdef',
  bucket = 'cc-shop-files';
let kv: Map<string, string>,
  r2: Map<string, { body: Uint8Array; type: string }>;
let bindings: unknown[];

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
const cf = (result: unknown, info?: unknown) =>
  Response.json({
    success: true,
    result,
    ...(info ? { result_info: info } : {}),
  });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipcel-storage-'));
  mkdirSync(join(dir, 'work', '.shipcel'), { recursive: true });
  output = [];
  errors = [];
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
    join(dir, 'work', '.shipcel', 'project.json'),
    JSON.stringify({ projectId, name: 'shop' }),
  );
  kv = new Map([
    ['config:theme', 'dark'],
    ['config:limits', '{"max":10}'],
  ]);
  r2 = new Map([
    [
      'index.html',
      { body: new TextEncoder().encode('<h1>Shop</h1>'), type: 'text/html' },
    ],
  ]);
  bindings = [
    { name: 'CACHE', type: 'kv_namespace', namespace_id: namespace },
    { name: 'FILES', type: 'r2_bucket', bucket_name: bucket },
  ];
  const kvPath = `/accounts/${account}/storage/kv/namespaces/${namespace}`;
  const r2Path = `/accounts/${account}/r2/buckets/${bucket}/objects`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const url = new URL(String(raw));
      const path = decodeURIComponent(url.pathname.replace('/client/v4', ''));
      const method = init.method ?? 'GET';
      if (path === `/accounts/${account}/workers/scripts`)
        return cf([{ id: worker, tag: 'c'.repeat(32) }]);
      if (path.endsWith(`/workers/scripts/${worker}/settings`))
        return cf({ bindings });
      if (path === `${kvPath}/keys`) {
        const prefix = url.searchParams.get('prefix') ?? '';
        return cf(
          [...kv.keys()]
            .filter((k) => k.startsWith(prefix))
            .sort()
            .map((name) => ({ name })),
          { cursor: '' },
        );
      }
      if (path.startsWith(`${kvPath}/values/`)) {
        const key = path.slice(`${kvPath}/values/`.length);
        if (method === 'GET')
          return kv.has(key)
            ? new Response(kv.get(key))
            : Response.json(
                {
                  success: false,
                  errors: [{ code: 10009, message: 'key not found' }],
                },
                { status: 404 },
              );
        if (method === 'PUT') {
          kv.set(
            key,
            init.body instanceof FormData
              ? String(init.body.get('value'))
              : String(init.body),
          );
          return cf(null);
        }
        if (method === 'DELETE') {
          kv.delete(key);
          return cf(null);
        }
      }
      if (path === r2Path)
        return cf(
          [...r2.entries()].map(([key, o]) => ({
            key,
            size: o.body.length,
            last_modified: '2026-10-20T10:00:00Z',
            http_metadata: { contentType: o.type },
          })),
          { delimited: [], is_truncated: false },
        );
      if (path.startsWith(`${r2Path}/`)) {
        const key = path.slice(r2Path.length + 1);
        if (method === 'GET') {
          const o = r2.get(key);
          return o
            ? new Response(new Uint8Array(o.body))
            : Response.json(
                {
                  success: false,
                  errors: [{ code: 10007, message: 'not found' }],
                },
                { status: 404 },
              );
        }
        if (method === 'PUT') {
          r2.set(key, {
            body: new Uint8Array(init.body as ArrayBuffer),
            type: new Headers(init.headers).get('Content-Type') ?? '',
          });
          return cf({});
        }
        if (method === 'DELETE') {
          r2.delete(key);
          return cf({});
        }
      }
      throw new Error(`Unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('shipcel storage', () => {
  it('lists bindings, keys and objects, and reads values and files', async () => {
    expect(await cli('storage')).toBe(0);
    expect(output).toEqual([
      'Binding  Kind          Where',
      `CACHE    KV namespace  ${namespace}`,
      `FILES    R2 bucket     ${bucket}`,
    ]);
    output = [];
    expect(await cli('storage', 'ls', 'CACHE', 'config:')).toBe(0);
    expect(output).toEqual(['config:limits', 'config:theme']);
    output = [];
    expect(await cli('blob', 'list', 'FILES')).toBe(0);
    expect(output).toEqual(['index.html  13 B  2026-10-20']);
    output = [];
    expect(await cli('storage', 'get', 'CACHE', 'config:theme')).toBe(0);
    expect(output).toEqual(['dark']);
    // An R2 object is saved under its own name, and never over a file without --yes.
    expect(await cli('storage', 'get', 'FILES', 'index.html')).toBe(0);
    expect(readFileSync(join(dir, 'work', 'index.html'), 'utf8')).toBe(
      '<h1>Shop</h1>',
    );
    expect(await cli('storage', 'get', 'FILES', 'index.html')).toBe(1);
    expect(errors.at(-1)).toContain(
      'is already there. Pass --yes to replace it.',
    );
    // Two bindings: a command has to say which.
    expect(await cli('storage', 'get', 'config:theme')).toBe(2);
    expect(errors.at(-1)).toBe(
      'Say which: CACHE, FILES (shipcel storage ls lists them).',
    );
    expect(await cli('storage', 'get', 'CACHE')).toBe(2);
  });

  it('puts text into KV and files into R2, byte for byte, and deletes them, after confirmation', async () => {
    expect(
      await cli('storage', 'put', 'CACHE', 'greeting', '--value', 'hello'),
    ).toBe(1);
    expect(errors.at(-1)).toContain('Pass --yes to confirm in scripts.');
    expect(kv.has('greeting')).toBe(false);
    expect(
      await cli(
        'storage',
        'put',
        'CACHE',
        'greeting',
        '--value',
        'hello',
        '--yes',
      ),
    ).toBe(0);
    expect(kv.get('greeting')).toBe('hello');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 1]);
    writeFileSync(join(dir, 'work', 'cat.png'), png);
    // An upload asks first, like every change.
    expect(
      await cli('storage', 'put', 'FILES', 'photos/cat.png', 'cat.png'),
    ).toBe(1);
    expect(r2.has('photos/cat.png')).toBe(false);
    expect(
      await cli(
        'storage',
        'put',
        'FILES',
        'photos/cat.png',
        'cat.png',
        '--yes',
      ),
    ).toBe(0);
    expect(output.at(-1)).toBe('Uploaded photos/cat.png to FILES (8 B).');
    expect(r2.get('photos/cat.png')).toEqual({ body: png, type: 'image/png' });
    expect(
      await cli('storage', 'get', 'FILES', 'photos/cat.png', 'copy.png'),
    ).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, 'work', 'copy.png')))).toEqual(
      png,
    );
    // KV takes text only.
    expect(
      await cli('storage', 'put', 'CACHE', 'image', 'cat.png', '--yes'),
    ).toBe(1);
    expect(errors.at(-1)).toBe(
      'Shipcel puts text into KV. For a file, use an R2 bucket, or Wrangler.',
    );
    expect(await cli('storage', 'rm', 'FILES', 'photos/cat.png', '--yes')).toBe(
      0,
    );
    expect(r2.has('photos/cat.png')).toBe(false);
    expect(await cli('storage', 'rm', 'CACHE', 'greeting', '--yes')).toBe(0);
    expect(kv.has('greeting')).toBe(false);
    // With one binding, its name can be left out.
    bindings = [bindings[1]];
    output = [];
    expect(await cli('storage', 'ls')).toBe(0);
    expect(await cli('storage', 'get', 'index.html', '-')).toBe(0);
    expect(output.at(-1)).toBe('<h1>Shop</h1>');
  });
});
