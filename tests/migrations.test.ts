import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';
import { providerJSON } from '../worker/providers';

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const account = 'a'.repeat(32),
  tag = 'c'.repeat(32),
  databaseId = '40000000-0000-4000-8000-000000000004';
// The fake "remote" D1 database is real SQLite, so migrations actually run.
let remote: DatabaseSync, previewRemote: DatabaseSync;
const previewDatabaseId = '40000000-0000-4000-8000-000000000099';
let head: string,
  files: Record<string, string>,
  config: Record<string, unknown>,
  repoPush: boolean,
  bookmarks: number,
  boundDatabase: string,
  loseResponseAfter: string | null,
  exportFails: boolean;
const calls: { url: string; method: string; body?: BodyInit | null }[] = [];
const cf = (result: unknown) => Response.json({ success: true, result });
const input = (values: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  confirm: true,
  ...values,
});
const tables = (database = remote) =>
  (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]
  )
    .map((t) => t.name)
    .filter((n) => !n.startsWith('sqlite_'));
const recorded = () =>
  (
    remote.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as {
      name: string;
    }[]
  ).map((r) => r.name);
function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = who.cookie,
) {
  return db.request(
    `/projects/${projectId}${path}`,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    cookie,
  );
}
// D1 runs a multi-statement query as a batch; a failed batch changes nothing.
function d1(sql: string, database = remote) {
  try {
    const single = sql.trim().replace(/;\s*$/, '');
    if (/^(select|pragma|explain)/i.test(single) && !single.includes(';'))
      return cf([
        {
          results: database.prepare(single).all(),
          success: true,
          meta: { changes: 0, rows_read: 1, rows_written: 0 },
        },
      ]);
    if (!single.includes(';')) {
      const run = database.prepare(single).run();
      return cf([
        {
          results: [],
          success: true,
          meta: { changes: Number(run.changes), rows_read: 0, rows_written: 1 },
        },
      ]);
    }
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return cf([{ results: [], success: true }]);
  } catch (error) {
    return Response.json(
      {
        success: false,
        errors: [{ code: 7500, message: (error as Error).message }],
        messages: [],
        result: null,
      },
      { status: 400 },
    );
  }
}
beforeEach(async () => {
  db = database();
  remote = new DatabaseSync(':memory:');
  previewRemote = new DatabaseSync(':memory:');
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput()) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const row: Record<string, string | number> = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf-original',
    gh_grant_id: 'gh-original',
    account_id: account,
    repository_id: '50',
    repository_name: 'alice/sample',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: 'cc-test-app-worker',
    build_command: 'npm run build',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: tag,
    trigger_uuid: '20000000-0000-4000-8000-000000000002',
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
  calls.length = 0;
  head = 'f'.repeat(40);
  repoPush = true;
  bookmarks = 0;
  boundDatabase = databaseId;
  loseResponseAfter = null;
  exportFails = false;
  config = {
    name: 'sample',
    main: 'src/index.js',
    compatibility_date: '2026-10-07',
    d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
  };
  files = {
    'migrations/0001_a.sql': 'CREATE TABLE a (id INTEGER);',
    'migrations/0002_b.sql': 'CREATE TABLE b (id INTEGER);',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(raw)),
        path = url.pathname,
        method = init.method || 'GET';
      calls.push({ url: String(raw), method, body: init.body });
      if (path.endsWith('/workers/scripts'))
        return cf([{ id: 'cc-test-app-worker', tag }]);
      if (path.endsWith(`/d1/database/${previewDatabaseId}/query`))
        return d1(JSON.parse(String(init.body)).sql, previewRemote);
      if (
        path.endsWith(`/d1/database/${previewDatabaseId}/time_travel/bookmark`)
      )
        return cf({ bookmark: 'preview-bookmark-1' });
      if (path.endsWith('/workers/scripts/cc-test-app-worker/settings'))
        return cf({
          bindings: [
            { name: 'DB', type: 'd1', id: boundDatabase },
            { name: 'API_KEY', type: 'secret_text' },
          ],
        });
      if (path.endsWith(`/d1/database/${databaseId}/query`)) {
        const sql = JSON.parse(String(init.body)).sql;
        const response = d1(sql);
        // Simulates D1 applying the batch but the response never arriving.
        if (loseResponseAfter && sql.includes(loseResponseAfter))
          throw new Error('Response lost');
        return response;
      }
      if (path.endsWith(`/d1/database/${databaseId}/time_travel/bookmark`))
        return cf({ bookmark: `00000085-0000024c-00004c6d-${++bookmarks}` });
      if (path.endsWith(`/d1/database/${databaseId}/export`)) {
        const body = JSON.parse(String(init.body));
        expect(body.output_format).toBe('polling');
        if (exportFails)
          return cf({
            success: true,
            type: 'export',
            status: 'error',
            error: 'Export failed: database too large',
            messages: [],
          });
        return cf(
          body.current_bookmark === 'export-1'
            ? {
                success: true,
                type: 'export',
                at_bookmark: 'export-1',
                status: 'complete',
                result: {
                  filename: 'cc-db-export.sql',
                  signed_url:
                    'https://d1-exports.example/download?token=secret-link',
                },
                messages: [],
              }
            : {
                success: true,
                type: 'export',
                at_bookmark: 'export-1',
                status: 'active',
                messages: ['Generating SQL dump'],
              },
        );
      }
      if (path.endsWith(`/d1/database/${databaseId}/time_travel/restore`))
        return cf({
          bookmark: '00000090-00000000-00000000-restored',
          previous_bookmark: '00000089-00000000-00000000-before-restore',
          message: 'Restored',
        });
      if (url.href === 'https://api.github.com/repos/alice/sample')
        return Response.json({
          id: 50,
          name: 'sample',
          full_name: 'alice/sample',
          default_branch: 'main',
          private: true,
          archived: false,
          permissions: { push: repoPush },
          owner: { id: 1, login: 'alice' },
        });
      if (url.href === 'https://api.github.com/repos/alice/sample/commits/main')
        return Response.json({ sha: head });
      const contents = path.match(/^\/repos\/alice\/sample\/contents\/(.+)$/);
      if (contents) {
        expect(url.searchParams.get('ref')).toBe(head);
        const name = decodeURIComponent(contents[1]);
        if (name === 'wrangler.json') {
          const source = JSON.stringify(config);
          return Response.json({
            type: 'file',
            encoding: 'base64',
            size: source.length,
            content: btoa(source),
          });
        }
        if (name in files)
          return Response.json({
            type: 'file',
            name: name.split('/').pop(),
            path: name,
            encoding: 'base64',
            size: files[name].length,
            content: btoa(files[name]),
          });
        const listing = Object.keys(files)
          .filter((f) => f.startsWith(`${name}/`))
          .map((f) => f.slice(name.length + 1));
        if (listing.length)
          return Response.json(
            [...new Set(listing.map((f) => f.split('/')[0]))].map((entry) => ({
              type: listing.includes(entry) ? 'file' : 'dir',
              name: entry,
              path: `${name}/${entry}`,
              size: files[`${name}/${entry}`]?.length ?? 0,
            })),
          );
        return new Response('', { status: 404 });
      }
      throw new Error(`Unexpected provider URL ${url.href}`);
    }),
  );
});
afterEach(() => {
  db.close();
  remote.close();
  previewRemote.close();
  vi.unstubAllGlobals();
});

type Plan = {
  commit: string;
  binding: string;
  databaseId: string;
  migrationsDir: string;
  applied: string[];
  pending: { name: string; sha256: string; size: number; sql: string }[];
  warnings: string[];
  restorePoints: { operationId: string; bookmark: string; createdAt: number }[];
};
async function reviewed(binding = 'DB') {
  const response = await request(`/migrations?binding=${binding}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Plan;
}
const approval = (plan: Plan) =>
  input({
    binding: plan.binding,
    commit: plan.commit,
    migrations: plan.pending.map(({ name, sha256 }) => ({ name, sha256 })),
  });

describe('reviewed D1 migrations', () => {
  it('lists pending migrations in Wrangler order with content hashes, without changing the database', async () => {
    files = {
      'migrations/10_c.sql': 'CREATE TABLE c (id INTEGER);',
      'migrations/2_b.sql': 'CREATE TABLE b (id INTEGER);',
      'migrations/1_a.sql': 'CREATE TABLE a (id INTEGER);',
      'migrations/seed.sql': 'INSERT INTO a VALUES (1);',
      'migrations/notes.md': '# not a migration',
      'migrations/archive/0000_old.sql': 'CREATE TABLE old (id INTEGER);',
    };
    const plan = await reviewed();
    expect(plan).toMatchObject({
      commit: head,
      binding: 'DB',
      databaseId,
      migrationsDir: 'migrations',
      applied: [],
    });
    // Numeric, not alphabetical: 10_c.sql runs after 2_b.sql.
    expect(plan.pending.map((m) => m.name)).toEqual([
      '1_a.sql',
      '2_b.sql',
      '10_c.sql',
      'seed.sql',
    ]);
    expect(plan.pending[0]).toMatchObject({
      sql: 'CREATE TABLE a (id INTEGER);',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(tables()).toEqual([]);
  });
  it('excludes applied migrations and warns about applied files missing from the repository', async () => {
    remote.exec(
      `CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
       INSERT INTO d1_migrations(name) VALUES ('0001_a.sql'), ('0000_removed.sql');`,
    );
    const plan = await reviewed();
    expect(plan.applied).toEqual(['0001_a.sql', '0000_removed.sql']);
    expect(plan.pending.map((m) => m.name)).toEqual(['0002_b.sql']);
    expect(plan.warnings.join(' ')).toContain('0000_removed.sql');
  });
  it('applies reviewed migrations in order after recording a Time Travel restore point', async () => {
    const plan = await reviewed();
    const response = await request('/migrations', 'POST', approval(plan));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'succeeded',
      result: {
        binding: 'DB',
        databaseId,
        applied: ['0001_a.sql', '0002_b.sql'],
        bookmark: '00000085-0000024c-00004c6d-1',
      },
    });
    expect(recorded()).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(tables()).toEqual(expect.arrayContaining(['a', 'b']));
    const first = calls.findIndex((c) =>
      String(c.body).includes('CREATE TABLE a'),
    );
    const bookmark = calls.findIndex((c) => c.url.includes('/time_travel/'));
    expect(bookmark).toBeGreaterThan(-1);
    expect(bookmark).toBeLessThan(first);
    expect((await reviewed()).pending).toEqual([]);
    expect(await (await request('/operations')).json()).toMatchObject([
      { kind: 'd1.migrate:DB', status: 'succeeded' },
    ]);
  });
  it('stops at a failing migration, keeps earlier ones, and reports the D1 error with the restore point', async () => {
    files = {
      'migrations/0001_a.sql': 'CREATE TABLE a (id INTEGER);',
      'migrations/0002_bad.sql':
        'CREATE TABLE b (id INTEGER); INSERT INTO missing VALUES (1);',
      'migrations/0003_c.sql': 'CREATE TABLE c (id INTEGER);',
    };
    const plan = await reviewed();
    const response = await request('/migrations', 'POST', approval(plan));
    expect(response.status).toBe(502);
    const body = (await response.json()) as { status: string; error: string };
    expect(body.status).toBe('needs_attention');
    expect(body.error).toContain('0002_bad.sql');
    expect(body.error).toContain('no such table: missing');
    expect(body.error).toContain('00000085-0000024c-00004c6d-1');
    expect(recorded()).toEqual(['0001_a.sql']);
    expect(tables()).not.toContain('b');
    expect(tables()).not.toContain('c');
  });
  it('refuses migrations that changed after review or a production branch that moved', async () => {
    const plan = await reviewed();
    files['migrations/0002_b.sql'] = 'CREATE TABLE b (id INTEGER, extra TEXT);';
    expect((await request('/migrations', 'POST', approval(plan))).status).toBe(
      409,
    );
    files['migrations/0002_b.sql'] = 'CREATE TABLE b (id INTEGER);';
    head = 'e'.repeat(40);
    expect((await request('/migrations', 'POST', approval(plan))).status).toBe(
      409,
    );
    expect(tables()).toEqual([]);
  });
  it('replays a completed request without applying anything again', async () => {
    const plan = await reviewed();
    const body = approval(plan);
    expect((await request('/migrations', 'POST', body)).status).toBe(200);
    const queries = calls.filter((c) => c.url.includes('/query')).length;
    expect(
      await (await request('/migrations', 'POST', body)).json(),
    ).toMatchObject({
      status: 'succeeded',
      result: { applied: ['0001_a.sql', '0002_b.sql'] },
    });
    expect(calls.filter((c) => c.url.includes('/query')).length).toBe(queries);
  });
  it('requires explicit confirmation, an owner, and the cloud switch', async () => {
    const plan = await reviewed();
    const { confirm: _confirm, ...unconfirmed } = approval(plan);
    expect((await request('/migrations', 'POST', unconfirmed)).status).toBe(
      400,
    );
    db.env.NATIVE_BUILDS_ENABLED = 'false';
    expect((await request('/migrations', 'POST', approval(plan))).status).toBe(
      503,
    );
    db.env.NATIVE_BUILDS_ENABLED = 'true';
    db.sqlite
      .prepare("UPDATE memberships SET role='viewer' WHERE user_id=?")
      .run(who.userId);
    expect((await request('/migrations?binding=DB')).status).toBe(403);
    expect((await request('/migrations', 'POST', approval(plan))).status).toBe(
      403,
    );
    expect(tables()).toEqual([]);
  });
  it('keeps migrations inside the workspace', async () => {
    const plan = await reviewed();
    const bob = await db.user(2);
    expect(
      (await request('/migrations?binding=DB', 'GET', undefined, bob.cookie))
        .status,
    ).toBe(404);
    expect(
      (await request('/migrations', 'POST', approval(plan), bob.cookie)).status,
    ).toBe(404);
    expect(tables()).toEqual([]);
  });
  it('only uses a D1 binding that the deployed Worker still has', async () => {
    config = {
      ...config,
      d1_databases: [{ binding: 'OTHER', migrations_dir: 'migrations' }],
    };
    expect((await request('/migrations?binding=OTHER')).status).toBe(409);
    expect((await request('/migrations?binding=DB')).status).toBe(409);
  });
  it('refuses migration settings it cannot mirror exactly', async () => {
    config = {
      ...config,
      d1_databases: [
        { binding: 'DB', migrations_dir: 'migrations', migrations_table: 'x' },
      ],
    };
    expect((await request('/migrations?binding=DB')).status).toBe(409);
  });
  it('refuses a migrations directory outside the repository', async () => {
    config = {
      ...config,
      d1_databases: [{ binding: 'DB', migrations_dir: '../outside' }],
    };
    const response = await request('/migrations?binding=DB');
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('migrations_dir');
  });
  it('requires repository write access', async () => {
    repoPush = false;
    expect((await request('/migrations?binding=DB')).status).toBe(403);
  });
  it('refuses oversized migration files', async () => {
    files['migrations/0003_big.sql'] = `-- ${'x'.repeat(300_000)}`;
    const response = await request('/migrations?binding=DB');
    expect(response.status).toBe(413);
    expect(await response.text()).toContain('0003_big.sql');
  });
});

describe('Time Travel restore points', () => {
  it('records the restore point before migrations run, even when one fails', async () => {
    files['migrations/0002_b.sql'] = 'INSERT INTO missing VALUES (1);';
    const plan = await reviewed();
    const response = await request('/migrations', 'POST', approval(plan));
    const { id } = (await response.json()) as { id: string };
    expect((await reviewed()).restorePoints).toEqual([
      {
        operationId: id,
        bookmark: '00000085-0000024c-00004c6d-1',
        createdAt: expect.any(Number),
      },
    ]);
  });
  it('restores to a recorded point only after confirmation and journals the undo bookmark', async () => {
    const plan = await reviewed();
    const { id } = (await (
      await request('/migrations', 'POST', approval(plan))
    ).json()) as { id: string };
    expect(
      (
        await request('/migrations/restore', 'POST', {
          requestId: crypto.randomUUID(),
          operationId: id,
        })
      ).status,
    ).toBe(400);
    expect(calls.some((c) => c.url.includes('/time_travel/restore'))).toBe(
      false,
    );
    const response = await request(
      '/migrations/restore',
      'POST',
      input({ operationId: id }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'succeeded',
      result: {
        binding: 'DB',
        databaseId,
        restoredTo: '00000085-0000024c-00004c6d-1',
        undoBookmark: '00000089-00000000-00000000-before-restore',
      },
    });
    const restore = calls.find((c) => c.url.includes('/time_travel/restore'))!;
    expect(restore.method).toBe('POST');
    expect(new URL(restore.url).searchParams.get('bookmark')).toBe(
      '00000085-0000024c-00004c6d-1',
    );
  });
  it('refuses to restore a database that the Worker no longer binds under that name', async () => {
    const plan = await reviewed();
    const { id } = (await (
      await request('/migrations', 'POST', approval(plan))
    ).json()) as { id: string };
    boundDatabase = '40000000-0000-4000-8000-000000000009';
    expect(
      (await request('/migrations/restore', 'POST', input({ operationId: id })))
        .status,
    ).toBe(409);
    expect(calls.some((c) => c.url.includes('/time_travel/restore'))).toBe(
      false,
    );
  });
  it('refuses restore points from another workspace or an unknown operation', async () => {
    const plan = await reviewed();
    const { id } = (await (
      await request('/migrations', 'POST', approval(plan))
    ).json()) as { id: string };
    const bob = await db.user(2);
    expect(
      (
        await request(
          '/migrations/restore',
          'POST',
          input({ operationId: id }),
          bob.cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          '/migrations/restore',
          'POST',
          input({ operationId: crypto.randomUUID() }),
        )
      ).status,
    ).toBe(404);
    expect(calls.some((c) => c.url.includes('/time_travel/restore'))).toBe(
      false,
    );
  });
});

describe('migration recovery', () => {
  async function interruptedAt(sqlFragment: string) {
    files['migrations/0003_c.sql'] = 'CREATE TABLE c (id INTEGER);';
    const plan = await reviewed();
    loseResponseAfter = sqlFragment;
    const response = await request('/migrations', 'POST', approval(plan));
    loseResponseAfter = null;
    expect(response.status).toBe(502);
    return ((await response.json()) as { id: string }).id;
  }
  it('lists which migrations reached the database after a lost response', async () => {
    const id = await interruptedAt('CREATE TABLE b');
    const result = (await (
      await request(`/operations/${id}/reconcile`, 'POST')
    ).json()) as { status: string; error: string };
    expect(result.status).toBe('needs_attention');
    expect(result.error).toContain('Applied: 0001_a.sql, 0002_b.sql');
    expect(result.error).toContain('Not applied: 0003_c.sql');
  });
  it('confirms a migration request whose last response was lost', async () => {
    const id = await interruptedAt('CREATE TABLE c');
    expect(
      await (await request(`/operations/${id}/reconcile`, 'POST')).json(),
    ).toMatchObject({
      status: 'succeeded',
      result: { applied: ['0001_a.sql', '0002_b.sql', '0003_c.sql'] },
    });
  });
});

describe('database exports and point-in-time restore', () => {
  const exportStep = (body: Record<string, unknown>, cookie = who.cookie) =>
    request('/databases/DB/export', 'POST', body, cookie);
  it('exports a SQL dump in polled steps after confirmation and never stores the download link', async () => {
    expect((await exportStep({ requestId: crypto.randomUUID() })).status).toBe(
      400,
    );
    const requestId = crypto.randomUUID();
    const started = await exportStep({ requestId, confirm: true });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({
      status: 'active',
      bookmark: 'export-1',
    });
    const finished = await exportStep({
      requestId,
      confirm: true,
      bookmark: 'export-1',
    });
    expect(await finished.json()).toEqual({
      status: 'complete',
      filename: 'cc-db-export.sql',
      url: 'https://d1-exports.example/download?token=secret-link',
    });
    const journal = JSON.stringify(
      db.sqlite.prepare('SELECT * FROM project_operations').all(),
    );
    expect(journal).toContain('d1.export:DB');
    expect(journal).toContain('cc-db-export.sql');
    expect(journal).not.toContain('secret-link');
  });
  it('reports a failed export with Cloudflare’s reason', async () => {
    exportFails = true;
    const response = await exportStep({
      requestId: crypto.randomUUID(),
      confirm: true,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('database too large');
  });
  it('only exports a database bound to the Worker, inside the workspace, for an owner', async () => {
    boundDatabase = '40000000-0000-4000-8000-000000000009';
    expect(
      (
        await request('/databases/OTHER/export', 'POST', {
          requestId: crypto.randomUUID(),
          confirm: true,
        })
      ).status,
    ).toBe(409);
    const bob = await db.user(2);
    expect(
      (
        await exportStep(
          { requestId: crypto.randomUUID(), confirm: true },
          bob.cookie,
        )
      ).status,
    ).toBe(404);
    expect(calls.some((c) => c.url.includes('/export'))).toBe(false);
  });
  it('restores to a point in time after confirmation and records the undo bookmark', async () => {
    const timestamp = new Date((now() - 3600) * 1000).toISOString();
    expect(
      (
        await request('/databases/DB/restore', 'POST', {
          requestId: crypto.randomUUID(),
          timestamp,
        })
      ).status,
    ).toBe(400);
    const response = await request(
      '/databases/DB/restore',
      'POST',
      input({ timestamp }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'succeeded',
      result: {
        binding: 'DB',
        restoredTo: timestamp,
        undoBookmark: '00000089-00000000-00000000-before-restore',
      },
    });
    const restore = calls.find((c) => c.url.includes('/time_travel/restore'))!;
    expect(new URL(restore.url).searchParams.get('timestamp')).toBe(timestamp);
  });
  it('refuses restore times in the future or beyond Time Travel retention', async () => {
    for (const offset of [-3600, 31 * 86400])
      expect(
        (
          await request(
            '/databases/DB/restore',
            'POST',
            input({
              timestamp: new Date((now() - offset) * 1000).toISOString(),
            }),
          )
        ).status,
      ).toBe(400);
    expect(calls.some((c) => c.url.includes('/time_travel/restore'))).toBe(
      false,
    );
  });
});

describe('table browser and SQL console', () => {
  const seed = () =>
    remote.exec(
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE \"odd \"\"name\" (x INTEGER); CREATE TABLE _cf_KV (key TEXT); INSERT INTO notes (body) VALUES ('first'), ('second'), ('third');",
    );
  const query = (body: Record<string, unknown>) =>
    request('/databases/DB/query', 'POST', {
      environment: 'production',
      ...body,
    });

  it('lists tables without D1’s internal ones, and pages through rows', async () => {
    seed();
    remote.exec(
      `INSERT INTO notes (body) VALUES ${Array.from({ length: 60 }, (_, i) => `('n${i}')`).join(',')}`,
    );
    const listed = (await (await request('/databases/DB/tables')).json()) as {
      databaseId: string;
      tables: { name: string; type: string }[];
    };
    expect(listed.databaseId).toBe(databaseId);
    expect(listed.tables.map((t) => t.name)).toEqual(['notes', 'odd "name']);
    const page = (await (
      await request('/databases/DB/tables/notes')
    ).json()) as {
      columns: { name: string; type: string; primaryKey: boolean }[];
      rows: { id: number; body: string }[];
      nextOffset: number | null;
    };
    expect(page.columns).toEqual([
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'body', type: 'TEXT', primaryKey: false },
    ]);
    expect(page.rows).toHaveLength(50);
    expect(page.rows[0]).toEqual({ id: 1, body: 'first' });
    expect(page.nextOffset).toBe(50);
    const last = (await (
      await request('/databases/DB/tables/notes?offset=50')
    ).json()) as { rows: unknown[]; nextOffset: number | null };
    expect(last.rows).toHaveLength(13);
    expect(last.nextOffset).toBeNull();
    // Names are quoted, so a table named with quotes is still just a table.
    expect(
      (await request(`/databases/DB/tables/${encodeURIComponent('odd "name')}`))
        .status,
    ).toBe(200);
    // Only listed tables can be browsed.
    for (const name of ['sqlite_master', '_cf_KV', 'missing'])
      expect((await request(`/databases/DB/tables/${name}`)).status, name).toBe(
        404,
      );
  });

  it('runs a read-only query at once, without changing anything', async () => {
    seed();
    const response = await query({
      sql: 'SELECT id, body FROM notes ORDER BY id;',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      columns: ['id', 'body'],
      rows: [
        { id: 1, body: 'first' },
        { id: 2, body: 'second' },
        { id: 3, body: 'third' },
      ],
      truncated: false,
    });
    expect(await (await request('/operations')).json()).toEqual([]);
  });

  it('needs confirmation for anything that could change data', async () => {
    seed();
    for (const sql of [
      "DELETE FROM notes WHERE body = 'first'",
      'SELECT 1; DELETE FROM notes',
      'WITH x AS (SELECT 1) DELETE FROM notes',
      'PRAGMA foreign_keys = OFF',
    ]) {
      const response = await query({ sql });
      expect(response.status, sql).toBe(409);
      expect(await response.text(), sql).toContain('Confirm');
    }
    expect(
      (remote.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number })
        .n,
    ).toBe(3);
  });

  it('runs a confirmed change after recording a restore point', async () => {
    seed();
    const response = await query({
      sql: "DELETE FROM notes WHERE body = 'first'",
      requestId: crypto.randomUUID(),
      confirm: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      result: { bookmark: string; meta: { changes: number } };
    };
    expect(body.status).toBe('succeeded');
    expect(body.result.meta.changes).toBe(1);
    expect(
      (remote.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number })
        .n,
    ).toBe(2);
    // The bookmark from before the change is a restore point, like a migration's.
    expect(
      db.sqlite
        .prepare('SELECT binding, bookmark FROM d1_restore_points')
        .all(),
    ).toEqual([{ binding: 'DB', bookmark: body.result.bookmark }]);
    expect(await (await request('/operations')).json()).toMatchObject([
      { kind: 'd1.query:DB', status: 'succeeded' },
    ]);
  });

  it('reports a failed statement and keeps the restore point', async () => {
    seed();
    const response = await query({
      sql: 'INSERT INTO missing (x) VALUES (1)',
      requestId: crypto.randomUUID(),
      confirm: true,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('no such table: missing');
    expect(
      db.sqlite.prepare('SELECT COUNT(*) AS n FROM d1_restore_points').get(),
    ).toEqual({ n: 1 });
  });
});

describe('preview databases', () => {
  // Previews bind the staging copy Shipcel created; the production Worker never binds it.
  function addPreview() {
    db.sqlite
      .prepare(
        "INSERT INTO project_previews(project_id,workspace_id,account_id,worker_name,resource_suffix,resources_json,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?)",
      )
      .run(
        projectId,
        who.workspaceId,
        account,
        'cc-test-app-worker',
        'a1b2c3d4',
        JSON.stringify([
          {
            type: 'd1',
            binding: 'DB',
            name: 'cc-test-app-worker-pv-a1b2c3d4-db',
            id: previewDatabaseId,
          },
        ]),
        who.userId,
        now(),
        now(),
      );
  }
  it('reviews and applies migrations to the preview database without touching production', async () => {
    addPreview();
    const response = await request(
      '/migrations?binding=DB&environment=preview',
    );
    expect(response.status).toBe(200);
    const plan = (await response.json()) as Plan;
    expect(plan.databaseId).toBe(previewDatabaseId);
    const applied = await request('/migrations', 'POST', {
      ...approval(plan),
      environment: 'preview',
    });
    expect(applied.status).toBe(200);
    expect(tables(previewRemote)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(tables()).toEqual([]);
    expect(await (await request('/operations')).json()).toMatchObject([
      { kind: 'd1.migrate:DB@preview', status: 'succeeded' },
    ]);
  });
  it('rejects an unknown environment', async () => {
    expect(
      (await request('/migrations?binding=DB&environment=staging')).status,
    ).toBe(400);
  });
  it('requires branch previews before using preview databases', async () => {
    expect(
      (await request('/migrations?binding=DB&environment=preview')).status,
    ).toBe(409);
  });
});

describe('provider error details', () => {
  it('surfaces a Cloudflare error message only when the caller asks for it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 7500, message: 'no such table: missing\u0000' }],
          },
          { status: 400 },
        ),
      ),
    );
    await expect(
      providerJSON(
        'https://api.cloudflare.com/client/v4/x',
        {},
        {
          errorDetail: true,
        },
      ),
    ).rejects.toThrow('Cloudflare reported: no such table: missing');
    await expect(
      providerJSON('https://api.cloudflare.com/client/v4/x'),
    ).rejects.toThrow('The provider rejected this operation');
  });
});
