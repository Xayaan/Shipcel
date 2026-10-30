import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { parse, type ParseError } from 'jsonc-parser';
import { activeGrant, grantToken } from './auth';
import { repoSchema } from './connections';
import { cloudflare, github, providerPath } from './providers';
import { AppError, now, type AppEnv } from './types';
import { change, replay, target, type Target } from './operations';
import { stagingDatabase } from './previews';

export const migrations = new Hono<AppEnv>();
const bindingName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const safeDir = z
  .string()
  .regex(/^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*\/?$/)
  .refine((v) => !v.split('/').includes('..'));
const migrationName = /^[\w.-]{1,120}\.sql$/;
const environmentSchema = z
  .enum(['production', 'preview'])
  .default('production');
// Journal kinds name the preview environment so history stays unambiguous.
const kindFor = (
  action: string,
  binding: string,
  environment: 'production' | 'preview',
) => `${action}:${binding}${environment === 'preview' ? '@preview' : ''}`;
const MAX_FILE = 262144,
  MAX_PENDING = 20;

// Mirrors Wrangler 4.148: `<migrations_dir>/*.sql`, ordered by the number before the first
// underscore, numbered files first, then by name. Applied names live in "d1_migrations".
const leadingNumber = (name: string) => parseInt(name.split('_')[0], 10);
export function compareMigrations(a: string, b: string) {
  const [x, y] = [leadingNumber(a), leadingNumber(b)];
  if (x !== y) {
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
    if (Number.isFinite(x)) return -1;
    if (Number.isFinite(y)) return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
const createTable = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
const migrationQuery = (sql: string, name: string) =>
  `${sql}\nINSERT INTO "d1_migrations" (name)\nvalues ('${name.replace(/'/g, "''")}');`;

type D1Result = {
  results?: unknown[];
  success?: boolean;
  meta?: Record<string, unknown>;
}[];
export const d1 = (
  t: Target,
  databaseId: string,
  sql: string,
  timeout?: number,
) =>
  cloudflare<D1Result>(
    t.token,
    `${t.root}/d1/database/${databaseId}/query`,
    { method: 'POST', body: JSON.stringify({ sql }) },
    { errorDetail: true, timeout },
  );
async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
const repoPath = (path: string) => path.split('/').map(providerPath).join('/');
async function repoFile(
  token: string,
  repository: string,
  path: string,
  ref: string,
) {
  let response: unknown;
  try {
    response = await github(
      token,
      `/repos/${repository}/contents/${repoPath(path)}?ref=${ref}`,
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return null;
    throw error;
  }
  const file = z
    .object({
      type: z.literal('file'),
      size: z.number().nonnegative(),
      encoding: z.string().optional(),
      content: z.string().optional(),
    })
    .parse(response);
  if (file.size > MAX_FILE || file.encoding !== 'base64' || !file.content)
    throw new AppError(
      413,
      `${path} is larger than ${MAX_FILE / 1024} KB. Apply it with Wrangler instead.`,
    );
  return new TextDecoder().decode(
    Uint8Array.from(atob(file.content.replace(/\s/g, '')), (c) =>
      c.charCodeAt(0),
    ),
  );
}

// Reads the production-branch head and the database state. Nothing is written.
async function inspect(
  c: Context<AppEnv>,
  t: Target,
  binding: string,
  environment: 'production' | 'preview',
) {
  const databaseId = await databaseFor(c, t, binding, environment);
  const gh = await activeGrant(c.env, t.who.workspaceId, 'github');
  if (!gh)
    throw new AppError(
      409,
      'Reconnect GitHub to read the repository migrations.',
    );
  const token = await grantToken(c.env, gh),
    repository = t.job.repository_name;
  const repo = repoSchema.parse(await github(token, `/repos/${repository}`));
  if (
    String(repo.id) !== t.job.repository_id ||
    repo.archived ||
    (!repo.permissions?.push && !repo.permissions?.admin)
  )
    throw new AppError(
      403,
      'Repository write access is required to review and apply migrations.',
    );
  const commit = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(
      await github(
        token,
        `/repos/${repository}/commits/${providerPath(t.job.branch)}`,
      ),
    ).sha;
  const source =
    (await repoFile(token, repository, 'wrangler.json', commit)) ??
    (await repoFile(token, repository, 'wrangler.jsonc', commit));
  const errors: ParseError[] = [];
  const config = source
    ? parse(source, errors, { allowTrailingComma: true })
    : null;
  const entry = z
    .array(z.record(z.string(), z.unknown()))
    .catch([])
    .parse(errors.length ? [] : config?.d1_databases)
    .find((d) => d.binding === binding);
  if (!entry)
    throw new AppError(
      409,
      'The repository configuration does not declare this D1 binding at the production-branch head.',
    );
  if ('migrations_table' in entry || 'migrations_pattern' in entry)
    throw new AppError(
      409,
      'Custom migration tables or patterns are not supported yet. Apply these migrations with Wrangler.',
    );
  const configured = safeDir.safeParse(entry.migrations_dir ?? 'migrations');
  if (!configured.success)
    throw new AppError(
      409,
      'Set migrations_dir to a relative directory inside the repository.',
    );
  const dir = configured.data.replace(/^\.\//, '').replace(/\/$/, '');
  let listing: unknown = [];
  try {
    listing = await github(
      token,
      `/repos/${repository}/contents/${repoPath(dir)}?ref=${commit}`,
    );
  } catch (error) {
    if (!(error instanceof AppError && error.status === 404)) throw error;
  }
  const entries = z
    .array(z.object({ type: z.string(), name: z.string() }))
    .catch([])
    .parse(listing)
    .filter((e) => e.type === 'file' && e.name.endsWith('.sql'));
  const warnings: string[] = [];
  const skipped = entries.filter((e) => !migrationName.test(e.name));
  if (skipped.length)
    warnings.push(
      `Skipped files with unsupported names: ${skipped.map((e) => e.name).join(', ')}.`,
    );
  const names = entries
    .map((e) => e.name)
    .filter((n) => migrationName.test(n))
    .sort(compareMigrations);
  const tracked = await d1(
    t,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
  );
  const applied = tracked[0]?.results?.length
    ? z
        .array(z.object({ name: z.string() }))
        .parse(
          (
            await d1(
              t,
              databaseId,
              'SELECT name FROM "d1_migrations" ORDER BY id',
            )
          )[0]?.results ?? [],
        )
        .map((r) => r.name)
    : [];
  const missing = applied.filter((n) => !names.includes(n));
  if (missing.length)
    warnings.push(
      `Applied migrations not found in the repository: ${missing.join(', ')}.`,
    );
  const pendingNames = names.filter((n) => !applied.includes(n));
  const latest = applied.filter((n) => names.includes(n)).at(-1);
  if (latest && pendingNames.some((n) => compareMigrations(n, latest) < 0))
    warnings.push(
      'Some pending migrations sort before migrations that are already applied. They will run after them.',
    );
  if (pendingNames.length > MAX_PENDING)
    warnings.push(
      `Only the first ${MAX_PENDING} pending migrations are shown. Apply them, then check again.`,
    );
  const pending = await Promise.all(
    pendingNames.slice(0, MAX_PENDING).map(async (name) => {
      const sql = await repoFile(token, repository, `${dir}/${name}`, commit);
      if (sql === null)
        throw new AppError(
          409,
          `${name} could not be read from the repository.`,
        );
      return {
        name,
        size: new TextEncoder().encode(sql).length,
        sha256: await sha256(sql),
        sql,
      };
    }),
  );
  const { results: restorePoints } = await c.env.DB.prepare(
    'SELECT operation_id AS operationId,bookmark,created_at AS createdAt FROM d1_restore_points WHERE workspace_id=? AND project_id=? AND binding=? AND database_id=? ORDER BY created_at DESC LIMIT 5',
  )
    .bind(t.who.workspaceId, t.p.id, binding, databaseId)
    .all<{ operationId: string; bookmark: string; createdAt: number }>();
  return {
    commit,
    binding,
    databaseId,
    migrationsDir: dir,
    applied,
    pending,
    warnings,
    restorePoints,
  };
}

migrations.get('/projects/:id/migrations', async (c) => {
  const environment = environmentSchema.parse(
    c.req.query('environment') ?? undefined,
  );
  const t = await target(c, false);
  return c.json(
    await inspect(c, t, bindingName.parse(c.req.query('binding')), environment),
  );
});

migrations.post('/projects/:id/migrations', async (c) => {
  const input = z
    .object({
      requestId: z.string().uuid(),
      confirm: z.literal(true),
      binding: bindingName,
      environment: environmentSchema,
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      migrations: z
        .array(
          z.object({
            name: z.string().regex(migrationName),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        )
        .min(1)
        .max(MAX_PENDING),
    })
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true),
    kind = kindFor('d1.migrate', input.binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  // Apply exactly what was reviewed: same commit, same files, same content, same order.
  const plan = await inspect(c, t, input.binding, input.environment);
  if (plan.commit !== input.commit)
    throw new AppError(
      409,
      'The production branch changed since you reviewed these migrations. Check again.',
    );
  const key = (m: { name: string; sha256: string }) => `${m.name}:${m.sha256}`;
  if (plan.pending.map(key).join('\n') !== input.migrations.map(key).join('\n'))
    throw new AppError(
      409,
      'The pending migrations changed since you reviewed them. Check again.',
    );
  return change(
    c,
    t,
    kind,
    input.requestId,
    async (operationId) => {
      const { bookmark } = z
        .object({ bookmark: z.string().regex(/^[\w-]{1,200}$/) })
        .parse(
          await cloudflare(
            t.token,
            `${t.root}/d1/database/${plan.databaseId}/time_travel/bookmark`,
          ),
        );
      // Saved before any migration runs, so it survives a failure or an interrupted request.
      await c.env.DB.prepare(
        'INSERT INTO d1_restore_points(operation_id,workspace_id,project_id,binding,database_id,bookmark,created_at) VALUES (?,?,?,?,?,?,?)',
      )
        .bind(
          operationId,
          t.who.workspaceId,
          t.p.id,
          plan.binding,
          plan.databaseId,
          bookmark,
          now(),
        )
        .run();
      await d1(t, plan.databaseId, createTable);
      const applied: string[] = [];
      for (const migration of plan.pending) {
        try {
          const results = await d1(
            t,
            plan.databaseId,
            migrationQuery(migration.sql, migration.name),
            60000,
          );
          if (results.some((r) => r.success === false))
            throw new AppError(502, 'D1 reported a failed statement.');
        } catch (error) {
          const reason =
            error instanceof AppError
              ? error.message
              : 'D1 did not confirm the result.';
          throw new AppError(
            502,
            `Migration ${migration.name} did not complete. ${reason} ${
              applied.length
                ? `Applied before it: ${applied.join(', ')}.`
                : 'No earlier migration in this request was applied.'
            } Restore point: Time Travel bookmark ${bookmark}.`,
          );
        }
        applied.push(migration.name);
      }
      return {
        binding: plan.binding,
        databaseId: plan.databaseId,
        applied,
        bookmark,
      };
    },
    {
      intent: {
        databaseId: plan.databaseId,
        commit: plan.commit,
        migrations: plan.pending.map((m) => m.name),
      },
    },
  );
});

// Destructive: overwrites the database with its state at the recorded bookmark. Cloudflare
// returns the bookmark from just before the restore, so the restore itself can be undone.
migrations.post('/projects/:id/migrations/restore', async (c) => {
  const input = z
    .object({
      requestId: z.string().uuid(),
      confirm: z.literal(true),
      operationId: z.string().uuid(),
      environment: environmentSchema,
    })
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true);
  const point = await c.env.DB.prepare(
    'SELECT binding,database_id,bookmark FROM d1_restore_points WHERE operation_id=? AND workspace_id=? AND project_id=?',
  )
    .bind(input.operationId, t.who.workspaceId, t.p.id)
    .first<{ binding: string; database_id: string; bookmark: string }>();
  if (!point)
    throw new AppError(404, 'Restore point not found for this project.');
  const kind = kindFor('d1.restore', point.binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const bound = await databaseFor(c, t, point.binding, input.environment).catch(
    (error) => {
      if (error instanceof AppError && error.status === 409) return null;
      throw error;
    },
  );
  if (bound !== point.database_id)
    throw new AppError(
      409,
      'This database is no longer bound to the Worker under the same name. Restore it with Wrangler after checking it.',
    );
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      const restored = z
        .object({ previous_bookmark: z.string().optional() })
        .parse(
          await cloudflare(
            t.token,
            `${t.root}/d1/database/${point.database_id}/time_travel/restore?bookmark=${providerPath(point.bookmark)}`,
            { method: 'POST' },
            { errorDetail: true, timeout: 60000 },
          ),
        );
      return {
        binding: point.binding,
        databaseId: point.database_id,
        restoredTo: point.bookmark,
        undoBookmark: restored.previous_bookmark ?? null,
      };
    },
    {
      intent: { databaseId: point.database_id, bookmark: point.bookmark },
    },
  );
});

// The D1 database `binding` uses: the one bound to the deployed Worker (read from its
// settings), or for previews the staging copy Shipcel created.
async function databaseFor(
  c: Context<AppEnv>,
  t: Target,
  binding: string,
  environment: 'production' | 'preview',
) {
  if (environment === 'preview') return stagingDatabase(c, t.p.id, binding);
  const settings = z
    .object({
      bindings: z
        .array(
          z.object({
            name: z.string(),
            type: z.string(),
            id: z.string().optional(),
          }),
        )
        .optional(),
    })
    .parse(await cloudflare(t.token, `${t.script}/settings`));
  const id = settings.bindings?.find(
    (b) => b.name === binding && b.type === 'd1',
  )?.id;
  if (!id || !/^[a-f0-9-]{32,36}$/i.test(id))
    throw new AppError(
      409,
      'The deployed Worker has no D1 database bound under this name.',
    );
  return id;
}
// The table browser and SQL console. Tables and views a person made are listed; SQLite's
// and D1's internal tables (sqlite_*, _cf_*) are hidden and can't be browsed.
const PAGE = 50,
  MAX_ROWS = 200;
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
async function userTables(t: Target, databaseId: string) {
  return z
    .array(z.object({ name: z.string(), type: z.string() }))
    .parse(
      (
        await d1(
          t,
          databaseId,
          "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
        )
      )[0]?.results ?? [],
    );
}
// SELECT and EXPLAIN alone can't change data; anything else needs confirmation.
const readOnly = (sql: string) => {
  const statement = sql.trim().replace(/;\s*$/, '');
  return /^(select|explain)\b/i.test(statement) && !statement.includes(';');
};
const shape = (result: D1Result[number] | undefined) => {
  const rows = (result?.results ?? []) as Record<string, unknown>[];
  const meta = result?.meta ?? {};
  const number = (key: string) =>
    typeof meta[key] === 'number' ? (meta[key] as number) : null;
  return {
    columns: rows[0] ? Object.keys(rows[0]) : [],
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
    meta: {
      changes: number('changes'),
      rowsRead: number('rows_read'),
      rowsWritten: number('rows_written'),
      duration: number('duration'),
    },
  };
};

migrations.get('/projects/:id/databases/:binding/tables', async (c) => {
  const environment = environmentSchema.parse(
    c.req.query('environment') ?? undefined,
  );
  const binding = bindingName.parse(c.req.param('binding'));
  const t = await target(c);
  const databaseId = await databaseFor(c, t, binding, environment);
  return c.json({ databaseId, tables: await userTables(t, databaseId) });
});

migrations.get('/projects/:id/databases/:binding/tables/:table', async (c) => {
  const environment = environmentSchema.parse(
    c.req.query('environment') ?? undefined,
  );
  const binding = bindingName.parse(c.req.param('binding'));
  const name = z.string().min(1).max(256).parse(c.req.param('table'));
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .parse(c.req.query('offset') ?? '0');
  const t = await target(c);
  const databaseId = await databaseFor(c, t, binding, environment);
  if (!(await userTables(t, databaseId)).some((table) => table.name === name))
    throw new AppError(404, 'Table not found.');
  const columns = z
    .array(
      z.object({
        name: z.string(),
        type: z.string().nullable().optional(),
        pk: z.number().optional(),
      }),
    )
    .parse(
      (await d1(t, databaseId, `PRAGMA table_info(${quote(name)})`))[0]
        ?.results ?? [],
    );
  const rows =
    (
      await d1(
        t,
        databaseId,
        `SELECT * FROM ${quote(name)} LIMIT ${PAGE + 1} OFFSET ${offset}`,
      )
    )[0]?.results ?? [];
  return c.json({
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type ?? '',
      primaryKey: (column.pk ?? 0) > 0,
    })),
    rows: rows.slice(0, PAGE),
    nextOffset: rows.length > PAGE ? offset + PAGE : null,
  });
});

// Read-only statements run at once. Anything else is confirmed, journaled, and preceded by
// a Time Travel restore point (listed with the migrations' restore points).
migrations.post('/projects/:id/databases/:binding/query', async (c) => {
  const input = z
    .object({
      sql: z.string().trim().min(1).max(100_000),
      environment: environmentSchema,
      requestId: z.string().uuid().optional(),
      confirm: z.literal(true).optional(),
    })
    .strict()
    .parse(await c.req.json());
  const binding = bindingName.parse(c.req.param('binding'));
  if (readOnly(input.sql)) {
    const t = await target(c);
    const databaseId = await databaseFor(c, t, binding, input.environment);
    return c.json(shape((await d1(t, databaseId, input.sql, 30000))[0]));
  }
  if (!input.requestId || !input.confirm)
    throw new AppError(
      409,
      'This statement can change data. Confirm it to run; Shipcel records a restore point first.',
    );
  const t = await target(c, true),
    kind = kindFor('d1.query', binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const databaseId = await databaseFor(c, t, binding, input.environment);
  return change(
    c,
    t,
    kind,
    input.requestId,
    async (operationId) => {
      const { bookmark } = z
        .object({ bookmark: z.string().regex(/^[\w-]{1,200}$/) })
        .parse(
          await cloudflare(
            t.token,
            `${t.root}/d1/database/${databaseId}/time_travel/bookmark`,
          ),
        );
      await c.env.DB.prepare(
        'INSERT INTO d1_restore_points(operation_id,workspace_id,project_id,binding,database_id,bookmark,created_at) VALUES (?,?,?,?,?,?,?)',
      )
        .bind(
          operationId,
          t.who.workspaceId,
          t.p.id,
          binding,
          databaseId,
          bookmark,
          now(),
        )
        .run();
      const results = await d1(t, databaseId, input.sql, 60000);
      if (results.some((r) => r.success === false))
        throw new AppError(
          502,
          `D1 reported a failed statement. Restore point: Time Travel bookmark ${bookmark}.`,
        );
      return { bookmark, statements: results.length, ...shape(results.at(-1)) };
    },
    { intent: { databaseId } },
  );
});

const clean = (text: unknown) =>
  typeof text === 'string'
    ? text
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 300)
    : '';

// One step of a D1 export. Cloudflare cancels an export that is not polled, and the database
// cannot serve queries while it runs, so the browser keeps polling after explicit consent.
// The signed download link is returned once and never stored.
migrations.post('/projects/:id/databases/:binding/export', async (c) => {
  const input = z
    .object({
      requestId: z.string().uuid(),
      confirm: z.literal(true),
      bookmark: z
        .string()
        .regex(/^[\w-]{1,200}$/)
        .optional(),
      environment: environmentSchema,
    })
    .strict()
    .parse(await c.req.json());
  const binding = bindingName.parse(c.req.param('binding'));
  const t = await target(c, true);
  const databaseId = await databaseFor(c, t, binding, input.environment);
  const step = z
    .object({
      status: z.string().optional(),
      at_bookmark: z.string().optional(),
      error: z.string().optional(),
      result: z
        .object({ filename: z.string(), signed_url: z.string() })
        .partial()
        .optional(),
    })
    .parse(
      await cloudflare(
        t.token,
        `${t.root}/d1/database/${databaseId}/export`,
        {
          method: 'POST',
          body: JSON.stringify({
            output_format: 'polling',
            ...(input.bookmark ? { current_bookmark: input.bookmark } : {}),
          }),
        },
        { errorDetail: true, timeout: 30000 },
      ),
    );
  if (step.status === 'error')
    throw new AppError(
      502,
      `Cloudflare could not export the database: ${clean(step.error) || 'no reason given'}.`,
    );
  if (step.status === 'complete') {
    const url = z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'))
      .parse(step.result?.signed_url);
    const filename = clean(step.result?.filename) || 'export.sql';
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO project_operations(id,workspace_id,project_id,user_id,account_id,kind,request_key,status,result_json,intent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'succeeded',?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        t.who.workspaceId,
        t.p.id,
        t.who.userId,
        t.job.account_id,
        kindFor('d1.export', binding, input.environment),
        input.requestId,
        JSON.stringify({ databaseId, filename, atBookmark: step.at_bookmark }),
        JSON.stringify({ databaseId }),
        now(),
        now(),
      )
      .run();
    return c.json({ status: 'complete', filename, url });
  }
  const bookmark = z
    .string()
    .regex(/^[\w-]{1,200}$/)
    .parse(step.at_bookmark);
  return c.json({ status: 'active', bookmark });
});

// Destructive: Time Travel point-in-time restore. Cloudflare keeps 7 days on Workers Free
// and 30 days on Workers Paid; the returned bookmark undoes the restore.
migrations.post('/projects/:id/databases/:binding/restore', async (c) => {
  const input = z
    .object({
      requestId: z.string().uuid(),
      confirm: z.literal(true),
      timestamp: z.string().max(40),
      environment: environmentSchema,
    })
    .strict()
    .parse(await c.req.json());
  const at = Date.parse(input.timestamp) / 1000;
  if (!Number.isFinite(at) || at > now() || at < now() - 30 * 86400)
    throw new AppError(
      400,
      'Choose a time within the past 30 days. Cloudflare keeps 7 days of history on Workers Free and 30 days on Workers Paid.',
    );
  const timestamp = new Date(at * 1000).toISOString();
  const binding = bindingName.parse(c.req.param('binding'));
  const t = await target(c, true),
    kind = kindFor('d1.restore', binding, input.environment);
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const databaseId = await databaseFor(c, t, binding, input.environment);
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      const restored = z
        .object({ previous_bookmark: z.string().optional() })
        .parse(
          await cloudflare(
            t.token,
            `${t.root}/d1/database/${databaseId}/time_travel/restore?timestamp=${providerPath(timestamp)}`,
            { method: 'POST' },
            { errorDetail: true, timeout: 60000 },
          ),
        );
      return {
        binding,
        databaseId,
        restoredTo: timestamp,
        undoBookmark: restored.previous_bookmark ?? null,
      };
    },
    { intent: { databaseId, timestamp } },
  );
});
