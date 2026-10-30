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
import { database } from './helpers/database';
import { run, type Io } from '../packages/cli/src/cli';
import app from '../worker/index';

// shipcel dns (worker/dns.ts, packages/cli/src/account.ts): the DNS records of the zones in
// the workspace's Cloudflare account, with Cloudflare faked.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let dir: string, output: string[], errors: string[];
const account = 'a'.repeat(32);
const zoneId = 'f'.repeat(32);
let records: Record<string, unknown>[];
const sent: { method: string; path: string; body: unknown }[] = [];
const cf = (result: unknown, info?: unknown) =>
  Response.json({
    success: true,
    result,
    ...(info ? { result_info: info } : {}),
  });
const id = (n: number) => String(n).repeat(32).slice(0, 32);

function io(): Io {
  return {
    env: { SHIPCEL_CONFIG_DIR: join(dir, 'config') },
    cwd: dir,
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipcel-dns-'));
  output = [];
  errors = [];
  sent.length = 0;
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
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
  records = [
    {
      id: id(1),
      type: 'A',
      name: 'example.com',
      content: '192.0.2.1',
      proxied: true,
      ttl: 1,
    },
    {
      id: id(2),
      type: 'MX',
      name: 'example.com',
      content: 'mail.example.com',
      priority: 10,
      ttl: 3600,
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const url = new URL(String(raw));
      const path = url.pathname.replace('/client/v4', '');
      const method = init.method ?? 'GET';
      sent.push({
        method,
        path: `${path}${url.search}`,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === '/zones') {
        const zones = [
          { id: zoneId, name: 'example.com', status: 'active' },
          { id: 'e'.repeat(32), name: 'other.dev', status: 'pending' },
        ].filter(
          (z) =>
            !url.searchParams.get('name') ||
            z.name === url.searchParams.get('name'),
        );
        return cf(zones, { total_count: zones.length });
      }
      if (path === `/zones/${zoneId}/dns_records` && method === 'GET')
        return cf(records, { total_count: records.length });
      if (path === `/zones/${zoneId}/dns_records` && method === 'POST') {
        const created = {
          id: id(3),
          ...(JSON.parse(String(init.body)) as object),
        };
        records.push(created);
        return cf(created);
      }
      if (
        path.startsWith(`/zones/${zoneId}/dns_records/`) &&
        method === 'DELETE'
      ) {
        records = records.filter((r) => r.id !== path.split('/').pop());
        return cf({ id: path.split('/').pop() });
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

describe('shipcel dns', () => {
  it('lists the account’s zones and a zone’s records', async () => {
    expect(await cli('dns')).toBe(0);
    expect(output).toEqual([
      'Zone         Status',
      'example.com  active',
      'other.dev    pending',
    ]);
    // Zones are looked up in the connected account only.
    expect(sent[0].path).toContain(`account.id=${account}`);
    output = [];
    expect(await cli('dns', 'ls', 'example.com')).toBe(0);
    expect(output).toEqual([
      'ID                                Type  Name         Value                Proxied  TTL',
      `${id(1)}  A     example.com  192.0.2.1            yes      auto`,
      `${id(2)}  MX    example.com  10 mail.example.com  no       3600`,
    ]);
    // Every zone lookup is in the connected account.
    for (const s of sent.filter((s) => s.path.startsWith('/zones?')))
      expect(s.path).toContain(`account.id=${account}`);
    expect(await cli('dns', 'ls', 'notmine.com')).toBe(1);
    expect(errors.at(-1)).toBe(
      "notmine.com isn't a zone of the connected Cloudflare account. shipcel dns ls lists them.",
    );
  });

  it('adds and deletes records after confirmation, and checks them first', async () => {
    expect(
      await cli(
        'dns',
        'add',
        'example.com',
        'www',
        'CNAME',
        'shop.example.net',
      ),
    ).toBe(1);
    expect(errors.at(-1)).toContain('Pass --yes to confirm in scripts.');
    expect(
      await cli(
        'dns',
        'add',
        'example.com',
        'www',
        'CNAME',
        'shop.example.net',
        '--proxied',
        '--yes',
      ),
    ).toBe(0);
    expect(output.at(-1)).toBe(
      `Added CNAME www → shop.example.net (${id(3)}).`,
    );
    expect(sent.find((s) => s.method === 'POST')!.body).toEqual({
      type: 'CNAME',
      name: 'www',
      content: 'shop.example.net',
      ttl: 1,
      proxied: true,
    });
    // MX with its priority, TXT with spaces.
    expect(
      await cli(
        'dns',
        'add',
        'example.com',
        '@',
        'MX',
        '20',
        'backup.example.com',
        '--yes',
      ),
    ).toBe(0);
    expect(sent.filter((s) => s.method === 'POST').at(-1)!.body).toMatchObject({
      type: 'MX',
      priority: 20,
      content: 'backup.example.com',
    });
    expect(
      await cli(
        'dns',
        'add',
        'example.com',
        '_verify',
        'TXT',
        'token=abc',
        'def',
        '--yes',
      ),
    ).toBe(0);
    expect(sent.filter((s) => s.method === 'POST').at(-1)!.body).toMatchObject({
      content: 'token=abc def',
    });
    // Refused before Cloudflare is asked.
    const posts = sent.filter((s) => s.method === 'POST').length;
    for (const argv of [
      ['dns', 'add', 'example.com', 'www', 'A', 'not-an-ip', '--yes'],
      ['dns', 'add', 'example.com', 'www', 'TXT', 'hi', '--proxied', '--yes'],
      ['dns', 'add', 'example.com', 'www', 'SRV', 'x', '--yes'],
      [
        'dns',
        'add',
        'example.com',
        'www',
        'A',
        '192.0.2.9',
        '--ttl',
        '5',
        '--yes',
      ],
    ])
      expect(await cli(...argv), argv.join(' ')).toBe(1);
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(posts);
    expect(await cli('dns', 'rm', 'example.com', id(1), '--yes')).toBe(0);
    expect(output.at(-1)).toBe('Deleted A example.com.');
    expect(records.some((r) => r.id === id(1))).toBe(false);
    expect(await cli('dns', 'rm', 'example.com', id(9), '--yes')).toBe(1);
  });

  it('needs a developer to change records and an explicit yes, and stays in the workspace', async () => {
    const viewer = await db.user(2, 'viewer');
    await db.grant(viewer, 'cloudflare');
    const add = (cookie: string, body: unknown) =>
      db.request(
        '/dns/example.com/records',
        { method: 'POST', body: JSON.stringify(body) },
        cookie,
      );
    const valid = { type: 'A', name: 'api', content: '192.0.2.7' };
    expect((await add(viewer.cookie, { ...valid, confirm: true })).status).toBe(
      403,
    );
    expect((await add(who.cookie, valid)).status).toBe(400);
    expect((await add(who.cookie, { ...valid, confirm: true })).status).toBe(
      201,
    );
    // A workspace without Cloudflare connected.
    const lonely = await db.user(3);
    expect((await db.request('/dns', {}, lonely.cookie)).status).toBe(409);
  });
});
