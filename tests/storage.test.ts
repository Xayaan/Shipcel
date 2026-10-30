import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';

// Manage → Storage: browse the KV namespaces and R2 buckets the app's Worker binds (or the
// previews' staging copies). Changes are confirmed and journaled; downloads never render.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const account = 'a'.repeat(32),
  tag = 'c'.repeat(32),
  worker = 'cc-test-app-worker',
  namespace = '0123456789abcdef0123456789abcdef',
  bucket = 'cc-test-app-worker-files';
const later = Math.floor(Date.now() / 1000) + 86400;
// Objects last changed a week ago.
const old = new Date(Date.now() - 7 * 86400000).toISOString();
type Entry = {
  value: string | Uint8Array;
  expiration?: number;
  metadata?: string;
};
type Stored = { body: string; type: string; modified: string };
let kv: Map<string, Entry>, buckets: Record<string, Map<string, Stored>>;
// Cloudflare failures to simulate: a request that changes the data but loses its response.
let lost: string | null;
// Chunks of a streamed value that were read.
let pulled = 0;
const calls: {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body?: unknown;
  redirect?: RequestRedirect;
}[] = [];
const cf = (result: unknown, info?: unknown) =>
  Response.json({
    success: true,
    result,
    ...(info ? { result_info: info } : {}),
  });
const request = (path: string, init: RequestInit = {}, cookie = who.cookie) =>
  db.request(`/projects/${projectId}${path}`, init, cookie);
const confirmed = (method: string, body: Record<string, unknown>) => ({
  method,
  body: JSON.stringify({
    requestId: crypto.randomUUID(),
    confirm: true,
    ...body,
  }),
});
const kinds = async () =>
  ((await (await request('/operations')).json()) as { kind: string }[])
    .map((o) => o.kind)
    .sort();
const upload = (
  fields: Record<string, string>,
  file?: File,
  binding = 'FILES',
) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  if (file) form.set('file', file);
  return request(`/storage/r2/${binding}/object`, {
    method: 'PUT',
    body: form,
  });
};

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput()) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const row = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: account,
    repository_id: '50',
    repository_name: 'alice/sample',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: worker,
    build_command: '',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: tag,
  };
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${Object.keys(row).join(',')}) VALUES (${Object.keys(
        row,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(row));
  kv = new Map<string, Entry>([
    ['config:theme', { value: 'dark' }],
    [
      'config:limits',
      { value: '{"max":10}', expiration: later, metadata: '{"v":2}' },
    ],
    ['blob', { value: '\u0000\u0001binary' }],
  ]);
  buckets = {
    [bucket]: new Map([
      [
        'index.html',
        { body: '<script>alert(1)</script>', type: 'text/html', modified: old },
      ],
      ['images/a.png', { body: 'png', type: 'image/png', modified: old }],
      ['images/b.png', { body: 'png', type: 'image/png', modified: old }],
      [
        'docs/résumé.pdf',
        { body: 'pdf', type: 'application/pdf', modified: old },
      ],
    ]),
    'cc-archive': new Map([
      ['2025.tar', { body: 'tar', type: 'application/x-tar', modified: old }],
    ]),
  };
  lost = null;
  pulled = 0;
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(raw));
      const path = url.pathname.replace('/client/v4', '');
      const method = init.method || 'GET';
      const headers = new Headers(init.headers);
      calls.push({
        method,
        path,
        search: url.search,
        headers,
        body: init.body,
        redirect: init.redirect,
      });
      if (path === `/accounts/${account}/workers/scripts`)
        return cf([{ id: worker, tag }]);
      if (path.endsWith(`/workers/scripts/${worker}/settings`))
        return cf({
          bindings: [
            { name: 'DB', type: 'd1', id: 'd'.repeat(32) },
            { name: 'CACHE', type: 'kv_namespace', namespace_id: namespace },
            {
              name: 'ROOMS',
              type: 'durable_object_namespace',
              class_name: 'Room',
              namespace_id: 'e'.repeat(32),
            },
            { name: 'FILES', type: 'r2_bucket', bucket_name: bucket },
            {
              name: 'ARCHIVE',
              type: 'r2_bucket',
              bucket_name: 'cc-archive',
              jurisdiction: 'eu',
            },
            // Malformed values never reach a request path.
            { name: 'ODD', type: 'kv_namespace', namespace_id: '../../x' },
            { name: 'ODD_FILES', type: 'r2_bucket', bucket_name: '../x' },
          ],
        });
      const kvPath = `/accounts/${account}/storage/kv/namespaces/${namespace}`;
      if (path === `${kvPath}/keys`) {
        const prefix = url.searchParams.get('prefix') ?? '';
        const all = [...kv.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, e]) => ({
            name,
            ...(e.expiration ? { expiration: e.expiration } : {}),
            ...(e.metadata ? { metadata: JSON.parse(e.metadata) } : {}),
          }));
        // Cursors here are offsets; Cloudflare's are opaque.
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        const page = all.slice(start, start + limit);
        return cf(page, {
          count: page.length,
          cursor: start + limit < all.length ? String(start + limit) : '',
        });
      }
      if (path.startsWith(`${kvPath}/values/`)) {
        const key = decodeURIComponent(path.slice(`${kvPath}/values/`.length));
        if (method === 'PUT') {
          const body = init.body;
          const expiration = url.searchParams.get('expiration');
          kv.set(
            key,
            body instanceof FormData
              ? {
                  value: String(body.get('value')),
                  metadata: String(body.get('metadata')),
                  ...(expiration ? { expiration: Number(expiration) } : {}),
                }
              : { value: String(body) },
          );
          return cf(null);
        }
        if (method === 'DELETE') {
          kv.delete(key);
          if (lost === 'kv.delete') return new Response('', { status: 500 });
          return cf(null);
        }
        if (key === 'stream') {
          // 1 MB in 16 KB chunks, produced only as they are read.
          return new Response(
            new ReadableStream({
              pull(controller) {
                pulled++;
                controller.enqueue(new Uint8Array(16384).fill(120));
                if (pulled === 64) controller.close();
              },
            }),
          );
        }
        return kv.has(key)
          ? new Response(kv.get(key)!.value as BodyInit, {
              headers: { 'Content-Type': 'application/octet-stream' },
            })
          : Response.json(
              { success: false, errors: [{ code: 10009 }] },
              { status: 404 },
            );
      }
      const r2 = new RegExp(
        `^/accounts/${account}/r2/buckets/([a-z0-9-]+)/objects(?:/(.+))?$`,
      ).exec(path);
      if (r2 && buckets[r2[1]]) {
        const objects = buckets[r2[1]];
        if (
          r2[1] === 'cc-archive' &&
          headers.get('cf-r2-jurisdiction') !== 'eu'
        )
          return Response.json(
            { success: false, errors: [{ code: 10006 }] },
            { status: 404 },
          );
        if (r2[2] === undefined) {
          const prefix = url.searchParams.get('prefix') ?? '';
          const keys = [...objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .sort();
          const folders = new Set<string>();
          const listed = [];
          for (const key of keys) {
            const rest = key.slice(prefix.length);
            if (url.searchParams.get('delimiter') === '/' && rest.includes('/'))
              folders.add(prefix + rest.split('/')[0] + '/');
            else
              listed.push({
                key,
                size: objects.get(key)!.body.length,
                last_modified: objects.get(key)!.modified,
                http_metadata: { contentType: objects.get(key)!.type },
              });
          }
          const start = Number(url.searchParams.get('cursor') || 0);
          const perPage = Number(url.searchParams.get('per_page') ?? 1000);
          const more = start + perPage < listed.length;
          // A cursor counts only while the listing is truncated.
          return cf(listed.slice(start, start + perPage), {
            cursor: more ? String(start + perPage) : 'end',
            is_truncated: more,
            delimited: [...folders],
          });
        }
        const key = r2[2].split('/').map(decodeURIComponent).join('/');
        if (method === 'PUT') {
          objects.set(key, {
            body: new TextDecoder().decode(init.body as ArrayBuffer),
            type: headers.get('Content-Type') ?? '',
            modified: new Date().toISOString(),
          });
          if (lost === 'r2.put') return new Response('', { status: 500 });
          return cf({ key, size: String(objects.get(key)!.body.length) });
        }
        if (method === 'DELETE') {
          objects.delete(key);
          if (lost === 'r2.delete') return new Response('', { status: 500 });
          return cf({ key });
        }
        return objects.has(key)
          ? new Response(objects.get(key)!.body, {
              headers: {
                'Content-Type': objects.get(key)!.type,
                'Content-Length': String(objects.get(key)!.body.length),
              },
            })
          : Response.json(
              { success: false, errors: [{ code: 10007 }] },
              { status: 404 },
            );
      }
      throw new Error(`Unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('storage the app binds', () => {
  it('lists only the KV namespaces and R2 buckets bound to the app’s Worker', async () => {
    expect(await (await request('/storage')).json()).toEqual({
      kv: [{ binding: 'CACHE', id: namespace }],
      r2: [
        { binding: 'FILES', bucket },
        { binding: 'ARCHIVE', bucket: 'cc-archive', jurisdiction: 'eu' },
      ],
    });
    expect((await request('/storage/kv/OTHER/keys')).status).toBe(404);
    expect((await request('/storage/kv/FILES/keys')).status).toBe(404);
    expect((await request('/storage/r2/CACHE/objects')).status).toBe(404);
    expect((await request('/storage/kv/ODD/keys')).status).toBe(404);
    expect((await request('/storage/r2/ODD_FILES/objects')).status).toBe(404);
  });

  it('is for owners and developers, not viewers', async () => {
    db.sqlite
      .prepare("UPDATE memberships SET role='viewer' WHERE user_id=?")
      .run(who.userId);
    expect((await request('/storage')).status).toBe(403);
    expect(
      (await request('/storage/r2/FILES/object?key=index.html')).status,
    ).toBe(403);
  });
});

describe('KV', () => {
  it('lists keys by prefix and shows text values', async () => {
    expect(
      await (await request('/storage/kv/CACHE/keys?prefix=config%3A')).json(),
    ).toEqual({
      keys: [
        { name: 'config:limits', expiration: later },
        { name: 'config:theme', expiration: null },
      ],
      cursor: null,
    });
    const listed = calls.find((c) => c.path.endsWith('/keys'))!;
    expect(new URLSearchParams(listed.search).get('prefix')).toBe('config:');
    expect(
      await (
        await request('/storage/kv/CACHE/value?key=config%3Atheme')
      ).json(),
    ).toEqual({ key: 'config:theme', text: 'dark', size: 4, truncated: false });
    // Binary values are described, not shown.
    expect(
      await (await request('/storage/kv/CACHE/value?key=blob')).json(),
    ).toEqual({ key: 'blob', text: null, size: 8, truncated: false });
    const missing = await request('/storage/kv/CACHE/value?key=missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: 'Nothing is stored under this key.',
    });
    // Bytes that aren't UTF-8 aren't text either.
    kv.set('png', { value: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]) });
    expect(
      await (await request('/storage/kv/CACHE/value?key=png')).json(),
    ).toMatchObject({ text: null, size: 5 });
  });

  it('pages through long key lists', async () => {
    for (let i = 0; i <= 100; i++)
      kv.set(`item:${String(i).padStart(3, '0')}`, { value: String(i) });
    const first = (await (
      await request('/storage/kv/CACHE/keys?prefix=item%3A')
    ).json()) as { keys: { name: string }[]; cursor: string | null };
    expect(first.keys).toHaveLength(100);
    expect(first.cursor).toBe('100');
    const next = (await (
      await request(
        `/storage/kv/CACHE/keys?prefix=item%3A&cursor=${first.cursor}`,
      )
    ).json()) as { keys: { name: string }[]; cursor: string | null };
    expect(next).toEqual({
      keys: [{ name: 'item:100', expiration: null }],
      cursor: null,
    });
    expect(new URLSearchParams(calls.at(-1)!.search).get('cursor')).toBe('100');
  });

  it('shows the first 64 KB of a long value', async () => {
    // The cut falls inside a two-byte character, which is left out.
    kv.set('long', { value: 'a' + 'é'.repeat(40000) });
    const value = (await (
      await request('/storage/kv/CACHE/value?key=long')
    ).json()) as { text: string; size: number; truncated: boolean };
    expect(value.truncated).toBe(true);
    expect(value.size).toBeNull();
    expect(value.text).toBe('a' + 'é'.repeat(32767));
  });

  it('reads only as much of a value as it shows', async () => {
    const value = (await (
      await request('/storage/kv/CACHE/value?key=stream')
    ).json()) as { text: string; truncated: boolean };
    expect(value).toMatchObject({ text: 'x'.repeat(65536), truncated: true });
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('downloads values as attachments', async () => {
    const response = await request('/storage/kv/CACHE/download?key=blob');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="blob"',
    );
    expect(response.headers.get('Content-Type')).toBe(
      'application/octet-stream',
    );
    expect(await response.text()).toBe('\u0000\u0001binary');
    kv.set('say "hi"', { value: 'hi' });
    expect(
      (
        await request(
          `/storage/kv/CACHE/download?key=${encodeURIComponent('say "hi"')}`,
        )
      ).headers.get('Content-Disposition'),
    ).toBe(`attachment; filename="say _hi_"; filename*=UTF-8''say%20%22hi%22`);
  });

  it('sets and deletes keys only after confirmation', async () => {
    const unconfirmed = await request('/storage/kv/CACHE/value', {
      method: 'PUT',
      body: JSON.stringify({ key: 'config:theme', value: 'light' }),
    });
    expect(unconfirmed.status).toBe(400);
    expect(kv.get('config:theme')!.value).toBe('dark');
    const set = await request(
      '/storage/kv/CACHE/value',
      confirmed('PUT', { key: 'config:theme', value: 'light' }),
    );
    expect(await set.json()).toMatchObject({
      status: 'succeeded',
      result: { key: 'config:theme' },
    });
    expect(kv.get('config:theme')).toEqual({ value: 'light' });
    expect(
      calls.find((c) => c.method === 'PUT')!.headers.get('Content-Type'),
    ).toBe('text/plain; charset=utf-8');
    const removed = await request(
      '/storage/kv/CACHE/value',
      confirmed('DELETE', { key: 'blob' }),
    );
    expect(removed.status).toBe(200);
    expect(kv.has('blob')).toBe(false);
    expect(await kinds()).toEqual(['kv.delete:CACHE', 'kv.put:CACHE']);
    // The journal records the key, never the value.
    expect(
      JSON.stringify(
        db.sqlite.prepare('SELECT * FROM project_operations').all(),
      ),
    ).not.toContain('light');
  });

  it('keeps a key’s expiration and metadata when its value changes', async () => {
    const set = await request(
      '/storage/kv/CACHE/value',
      confirmed('PUT', { key: 'config:limits', value: '{"max":20}' }),
    );
    expect(set.status).toBe(200);
    expect(kv.get('config:limits')).toEqual({
      value: '{"max":20}',
      metadata: '{"v":2}',
      expiration: later,
    });
    // Cloudflare refuses expirations less than a minute away, so Shipcel asks to wait.
    kv.set('soon', { value: 'x', expiration: now() + 30 });
    const soon = await request(
      '/storage/kv/CACHE/value',
      confirmed('PUT', { key: 'soon', value: 'y' }),
    );
    expect(soon.status).toBe(409);
    expect(kv.get('soon')!.value).toBe('x');
  });

  it('takes text values up to 1 MB', async () => {
    const large = 'x'.repeat(100000);
    expect(
      (
        await request(
          '/storage/kv/CACHE/value',
          confirmed('PUT', { key: 'large', value: large }),
        )
      ).status,
    ).toBe(200);
    expect(kv.get('large')!.value).toBe(large);
    expect(
      (
        await request(
          '/storage/kv/CACHE/value',
          confirmed('PUT', { key: 'huge', value: 'x'.repeat(1048577) }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/storage/kv/CACHE/value',
          confirmed('PUT', { key: 'huge', value: 'x'.repeat(3 * 1048576) }),
        )
      ).status,
    ).toBe(413);
    expect(kv.has('huge')).toBe(false);
  });

  it('refuses keys Cloudflare can’t address', async () => {
    expect((await request('/storage/kv/CACHE/value?key=..')).status).toBe(400);
    expect(
      (await request(`/storage/kv/CACHE/value?key=${'k'.repeat(513)}`)).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/storage/kv/CACHE/value',
          confirmed('DELETE', { key: '.' }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('R2', () => {
  it('browses objects folder by folder', async () => {
    expect(await (await request('/storage/r2/FILES/objects')).json()).toEqual({
      objects: [
        {
          key: 'index.html',
          size: 25,
          lastModified: old,
          contentType: 'text/html',
        },
      ],
      folders: ['docs/', 'images/'],
      cursor: null,
    });
    const listed = calls.find((c) => c.path.endsWith('/objects'))!;
    expect(new URLSearchParams(listed.search).get('delimiter')).toBe('/');
    expect(
      (
        (await (
          await request('/storage/r2/FILES/objects?prefix=images%2F')
        ).json()) as { objects: { key: string }[] }
      ).objects.map((o) => o.key),
    ).toEqual(['images/a.png', 'images/b.png']);
  });

  it('pages through long folders', async () => {
    for (let i = 0; i <= 100; i++)
      buckets[bucket].set(`many/${String(i).padStart(3, '0')}`, {
        body: '',
        type: 'text/plain',
        modified: old,
      });
    const first = (await (
      await request('/storage/r2/FILES/objects?prefix=many%2F')
    ).json()) as { objects: { key: string }[]; cursor: string | null };
    expect(first.objects).toHaveLength(100);
    expect(first.cursor).toBe('100');
    const next = (await (
      await request(
        `/storage/r2/FILES/objects?prefix=many%2F&cursor=${first.cursor}`,
      )
    ).json()) as { objects: { key: string }[]; cursor: string | null };
    expect(next.objects.map((o) => o.key)).toEqual(['many/100']);
    expect(next.cursor).toBeNull();
  });

  it('sends the bucket’s jurisdiction with every request', async () => {
    expect(
      (
        (await (await request('/storage/r2/ARCHIVE/objects')).json()) as {
          objects: { key: string }[];
        }
      ).objects.map((o) => o.key),
    ).toEqual(['2025.tar']);
    expect(
      await (await request('/storage/r2/ARCHIVE/object?key=2025.tar')).text(),
    ).toBe('tar');
  });

  it('downloads objects as attachments that never render in Shipcel', async () => {
    const response = await request('/storage/r2/FILES/object?key=index.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="index.html"',
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Length')).toBe('25');
    expect(await response.text()).toBe('<script>alert(1)</script>');
    // A provider redirect is never followed with Shipcel's credentials.
    expect(calls.at(-1)!.redirect).toBe('manual');
    // Slashes stay literal in the provider path; everything else is encoded.
    const named = await request(
      `/storage/r2/FILES/object?key=${encodeURIComponent('docs/résumé.pdf')}`,
    );
    expect(named.headers.get('Content-Disposition')).toBe(
      `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
    );
    expect(calls.at(-1)!.path).toBe(
      `/accounts/${account}/r2/buckets/${bucket}/objects/docs/r%C3%A9sum%C3%A9.pdf`,
    );
    expect(
      (await request('/storage/r2/FILES/object?key=missing.txt')).status,
    ).toBe(404);
  });

  it('opens only keys whose path parts are unambiguous', async () => {
    for (const key of [
      '../secrets',
      'a/./b',
      'a//b',
      '/root',
      'dir/',
      'k'.repeat(1025),
    ])
      expect(
        (
          await request(
            `/storage/r2/FILES/object?key=${encodeURIComponent(key)}`,
          )
        ).status,
        key,
      ).toBe(400);
    expect(calls.some((c) => c.path.includes('..'))).toBe(false);
  });

  it('uploads files after confirmation', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    for (const fields of [
      { key: 'notes/hello.txt' } as Record<string, string>,
      { key: 'notes/hello.txt', requestId: crypto.randomUUID() },
      {
        key: 'notes/hello.txt',
        requestId: crypto.randomUUID(),
        confirm: 'yes',
      },
    ])
      expect((await upload(fields, file)).status).toBe(400);
    expect(buckets[bucket].has('notes/hello.txt')).toBe(false);
    const response = await upload(
      {
        key: 'notes/hello.txt',
        requestId: crypto.randomUUID(),
        confirm: 'true',
      },
      file,
    );
    expect(await response.json()).toMatchObject({
      status: 'succeeded',
      result: { key: 'notes/hello.txt', size: 5 },
    });
    expect(buckets[bucket].get('notes/hello.txt')).toMatchObject({
      body: 'hello',
      type: 'text/plain',
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers.get('cf-r2-data-catalog-check')).toBe('true');
    expect(await kinds()).toEqual(['r2.put:FILES']);
    expect(
      (
        await upload({
          key: 'empty.txt',
          requestId: crypto.randomUUID(),
          confirm: 'true',
        })
      ).status,
    ).toBe(400);
  });

  it('takes files larger than ordinary requests', async () => {
    const response = await upload(
      { key: 'big.bin', requestId: crypto.randomUUID(), confirm: 'true' },
      new File([new Uint8Array(1048576)], 'big.bin', { type: 'weird type' }),
    );
    expect(response.status).toBe(200);
    expect(buckets[bucket].get('big.bin')).toMatchObject({
      type: 'application/octet-stream',
    });
  });

  it('refuses uploads over 25 MB', async () => {
    const big = new File([new Uint8Array(25 * 1048576 + 1)], 'big.bin');
    const response = await upload(
      { key: 'big.bin', requestId: crypto.randomUUID(), confirm: 'true' },
      big,
    );
    expect(response.status).toBe(413);
    expect(buckets[bucket].has('big.bin')).toBe(false);
  });

  it('deletes an object only after confirmation', async () => {
    const response = await request(
      '/storage/r2/FILES/object',
      confirmed('DELETE', { key: 'images/a.png' }),
    );
    expect(response.status).toBe(200);
    expect(buckets[bucket].has('images/a.png')).toBe(false);
    const removed = calls.find((c) => c.method === 'DELETE')!;
    expect(removed.headers.get('cf-r2-data-catalog-check')).toBe('true');
    expect(
      (
        await request('/storage/r2/FILES/object', {
          method: 'DELETE',
          body: JSON.stringify({ key: 'images/b.png' }),
        })
      ).status,
    ).toBe(400);
    expect(buckets[bucket].has('images/b.png')).toBe(true);
    expect(await kinds()).toEqual(['r2.delete:FILES']);
  });
});

describe('previews', () => {
  it('browses the previews’ staging copies instead of production', async () => {
    db.sqlite
      .prepare(
        "INSERT INTO project_previews(project_id,workspace_id,account_id,worker_name,resource_suffix,resources_json,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)",
      )
      .run(
        projectId,
        who.workspaceId,
        account,
        worker,
        'a1b2c3d4',
        JSON.stringify([
          {
            type: 'd1',
            binding: 'DB',
            name: 'cc-test-app-worker-pv-a1b2c3d4-db',
            id: crypto.randomUUID(),
          },
          {
            type: 'kv',
            binding: 'CACHE',
            name: 'cc-test-app-worker-pv-a1b2c3d4-cache',
            id: 'f'.repeat(32),
          },
          {
            type: 'r2',
            binding: 'FILES',
            name: 'cc-test-app-worker-pv-a1b2c3d4-files',
            id: 'cc-test-app-worker-pv-a1b2c3d4-files',
          },
        ]),
        who.userId,
        now(),
        now(),
      );
    expect(
      await (await request('/storage?environment=preview')).json(),
    ).toEqual({
      kv: [{ binding: 'CACHE', id: 'f'.repeat(32) }],
      r2: [
        { binding: 'FILES', bucket: 'cc-test-app-worker-pv-a1b2c3d4-files' },
      ],
    });
    await request(
      '/storage/kv/CACHE/value',
      confirmed('DELETE', { key: 'blob', environment: 'preview' }),
    );
    expect(calls.at(-1)!.path).toBe(
      `/accounts/${account}/storage/kv/namespaces/${'f'.repeat(32)}/values/blob`,
    );
    expect(await kinds()).toEqual(['kv.delete:CACHE@preview']);
  });
});

describe('interrupted changes', () => {
  const reconcile = async () => {
    const [op] = (await (await request('/operations')).json()) as {
      id: string;
    }[];
    return (await (
      await request(`/operations/${op.id}/reconcile`, {
        method: 'POST',
        body: '{}',
      })
    ).json()) as { status: string; error: string | null };
  };

  it('learns from Cloudflare whether a key was deleted', async () => {
    lost = 'kv.delete';
    const response = await request(
      '/storage/kv/CACHE/value',
      confirmed('DELETE', { key: 'blob' }),
    );
    expect(response.status).toBe(502);
    expect(await reconcile()).toMatchObject({ status: 'succeeded' });
  });

  it('can’t confirm a value it never stored', async () => {
    db.sqlite
      .prepare(
        "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,'kv.put:CACHE',?,'needs_attention',?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        who.workspaceId,
        projectId,
        who.userId,
        account,
        crypto.randomUUID(),
        JSON.stringify({ namespaceId: namespace, key: 'config:theme' }),
        now(),
        now(),
      );
    expect(await reconcile()).toMatchObject({
      status: 'needs_attention',
      error: expect.stringContaining('keeps no copy of the value'),
    });
    kv.delete('config:theme');
    expect(await reconcile()).toMatchObject({ status: 'not_applied' });
  });

  it('learns from an object’s modification time whether an upload landed', async () => {
    lost = 'r2.put';
    const response = await upload(
      {
        key: 'index.html',
        requestId: crypto.randomUUID(),
        confirm: 'true',
      },
      new File(['new'], 'index.html', { type: 'text/html' }),
    );
    expect(response.status).toBe(502);
    expect(await reconcile()).toMatchObject({ status: 'succeeded' });
  });

  it('checks EU buckets in their jurisdiction', async () => {
    lost = 'r2.delete';
    const response = await request(
      '/storage/r2/ARCHIVE/object',
      confirmed('DELETE', { key: '2025.tar' }),
    );
    expect(response.status).toBe(502);
    expect(await reconcile()).toMatchObject({ status: 'succeeded' });
    db.sqlite.prepare('DELETE FROM project_operations').run();
    lost = 'r2.put';
    const uploaded = await upload(
      { key: '2026.tar', requestId: crypto.randomUUID(), confirm: 'true' },
      new File(['tar'], '2026.tar'),
      'ARCHIVE',
    );
    expect(uploaded.status).toBe(502);
    expect(await reconcile()).toMatchObject({ status: 'succeeded' });
  });

  it('reports deletions that never happened', async () => {
    const pending = (kind: string, intent: unknown) =>
      db.sqlite
        .prepare(
          "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'needs_attention',?,?,?)",
        )
        .run(
          crypto.randomUUID(),
          who.workspaceId,
          projectId,
          who.userId,
          account,
          kind,
          crypto.randomUUID(),
          JSON.stringify(intent),
          now(),
          now(),
        );
    pending('kv.delete:CACHE', { namespaceId: namespace, key: 'blob' });
    expect(await reconcile()).toMatchObject({ status: 'not_applied' });
    db.sqlite.prepare('DELETE FROM project_operations').run();
    pending('r2.delete:FILES', { bucket, key: 'images/a.png' });
    expect(await reconcile()).toMatchObject({ status: 'not_applied' });
  });

  it('reports an upload that never landed', async () => {
    db.sqlite
      .prepare(
        "INSERT INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,'r2.put:FILES',?,'needs_attention',?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        who.workspaceId,
        projectId,
        who.userId,
        account,
        crypto.randomUUID(),
        JSON.stringify({ bucket, key: 'index.html' }),
        now(),
        now(),
      );
    expect(await reconcile()).toMatchObject({ status: 'not_applied' });
  });
});
