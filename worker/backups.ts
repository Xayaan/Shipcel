import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, requireIdentity } from './auth';
import { refuseWhilePaused } from './budgets';
import {
  cloudflare,
  cloudflareBody,
  providerPath,
  workerDatabases,
} from './providers';
import { AppError, now, type AppEnv, type Env } from './types';

// Scheduled copies of a project's D1 database in R2. Each copy is Cloudflare's own export of
// the database (SQL), which Shipcel drives from its minute schedule and then streams into a
// bucket it makes in the customer's account, keeping the newest few. Time Travel keeps the
// last 7 or 30 days in place; these copies last as long as the person keeps them, outside the
// database.
export const backups = new Hono<AppEnv>();

// One upload through Cloudflare's API takes at most this much (Wrangler's limit for the same
// call); a larger dump needs the S3 API's multipart upload.
const MAX_BYTES = 300 * 1024 * 1024;
// Cloudflare cancels an export nobody polls; one that still isn't done after this is given up.
const GIVE_UP_AFTER = 7200;
// Copies started and polled per minute, all accounts together.
const BATCH = 5;
// A copy whose upload stopped part-way (its run ended) is given up after this; one upload
// takes ten minutes at most.
const STORE_GIVE_UP = 1200;
// A scheduled copy that couldn't start is tried again this much later.
const RETRY_AFTER = 3600;

const bindingName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
type Cadence = 'daily' | 'weekly';
type Schedule = {
  project_id: string;
  workspace_id: string;
  binding: string;
  cadence: Cadence;
  hour: number;
  keep: number;
  bucket: string;
  next_at: number | null;
  last_error: string | null;
};
type Backup = {
  id: string;
  project_id: string;
  workspace_id: string;
  binding: string;
  database_id: string;
  status: 'exporting' | 'storing' | 'done' | 'failed';
  bookmark: string | null;
  bucket: string;
  key: string;
  bytes: number | null;
  error: string | null;
  created_at: number;
};

// The next copy after `from`: at the hour (UTC) the next day it comes round, or a week on.
export function nextBackup(cadence: Cadence, hour: number, from: number) {
  const day = new Date(from * 1000);
  let at =
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour) /
    1000;
  if (at <= from) at += 86400;
  return cadence === 'weekly' && at - from < 6 * 86400 ? at + 6 * 86400 : at;
}

// The account a project's production Worker is in, with the workspace's Cloudflare connection.
async function account(env: Env, workspaceId: string, projectId: string) {
  const job = await env.DB.prepare(
    "SELECT account_id, worker_name FROM deployment_jobs WHERE workspace_id=? AND project_id=? AND environment='production' AND worker_tag IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(workspaceId, projectId)
    .first<{ account_id: string; worker_name: string }>();
  if (!job)
    throw new AppError(
      409,
      'Deploy this project first: backups copy its database.',
    );
  const grant = await activeGrant(env, workspaceId, 'cloudflare');
  if (!grant || grant.account_id !== job.account_id)
    throw new AppError(
      409,
      'Reconnect the Cloudflare account that owns this project.',
    );
  return {
    token: await grantToken(env, grant),
    root: `/accounts/${job.account_id}`,
    worker: job.worker_name,
  };
}
type Account = Awaited<ReturnType<typeof account>>;

async function databaseId(a: Account, binding: string) {
  const id = (
    await workerDatabases(a.token, `${a.root}/workers/scripts/${a.worker}`)
  ).find((d) => d.binding === binding)?.id;
  if (!id)
    throw new AppError(
      409,
      `The deployed Worker has no D1 database bound as ${binding}.`,
    );
  return id;
}

const bucketPath = (a: Account, bucket: string) =>
  `${a.root}/r2/buckets/${providerPath(bucket)}`;
const objectPath = (a: Account, bucket: string, key: string) =>
  `${bucketPath(a, bucket)}/objects/${key.split('/').map(providerPath).join('/')}`;

// One step of Cloudflare's export: done (with where to download it) or still going.
async function exportStep(
  a: Account,
  database: string,
  bookmark: string | null,
) {
  const step = z
    .object({
      status: z.string().optional(),
      at_bookmark: z.string().optional(),
      error: z.string().optional(),
      result: z.object({ signed_url: z.string() }).partial().optional(),
    })
    .parse(
      await cloudflare(
        a.token,
        `${a.root}/d1/database/${database}/export`,
        {
          method: 'POST',
          body: JSON.stringify({
            output_format: 'polling',
            ...(bookmark ? { current_bookmark: bookmark } : {}),
          }),
        },
        { errorDetail: true, timeout: 30000 },
      ),
    );
  if (step.status === 'error')
    throw new AppError(
      502,
      `Cloudflare couldn’t export the database: ${(step.error ?? 'no reason given').slice(0, 200)}.`,
    );
  if (step.status === 'complete')
    return {
      url: z
        .string()
        .url()
        .refine((u) => u.startsWith('https://'))
        .parse(step.result?.signed_url),
    };
  return {
    bookmark: z
      .string()
      .regex(/^[\w-]{1,200}$/)
      .parse(step.at_bookmark),
  };
}

// The dump, streamed from Cloudflare's signed address into the bucket.
async function store(a: Account, backup: Backup, url: string) {
  const dump = await fetch(url, { redirect: 'manual' });
  const bytes = Number(dump.headers.get('Content-Length'));
  if (!dump.ok || !dump.body || !Number.isFinite(bytes) || bytes <= 0) {
    await dump.body?.cancel();
    throw new AppError(502, 'Cloudflare’s export couldn’t be downloaded.');
  }
  if (bytes > MAX_BYTES) {
    await dump.body.cancel();
    throw new AppError(
      413,
      `The dump is ${Math.round(bytes / 1024 / 1024)} MB, more than the 300 MB one upload through Cloudflare’s API takes. Keep copies with wrangler d1 export instead; Time Travel covers the last 30 days.`,
    );
  }
  await cloudflare(
    a.token,
    objectPath(a, backup.bucket, backup.key),
    {
      method: 'PUT',
      body: dump.body,
      headers: {
        'Content-Type': 'application/sql',
        'Content-Length': String(bytes),
      },
      // Node needs this to send a stream; Workers streams without it.
      ...({ duplex: 'half' } as RequestInit),
    },
    { errorDetail: true, timeout: 600000 },
  );
  return bytes;
}

// The newest `keep` copies stay; older ones leave the bucket and the list. A failed copy is
// listed for a month.
async function prune(env: Env, a: Account, schedule: Schedule) {
  const { results } = await env.DB.prepare(
    "SELECT id, bucket, key FROM backups WHERE project_id=? AND status='done' ORDER BY created_at DESC LIMIT -1 OFFSET ?",
  )
    .bind(schedule.project_id, schedule.keep)
    .all<{ id: string; bucket: string; key: string }>();
  for (const old of results) {
    await cloudflare(a.token, objectPath(a, old.bucket, old.key), {
      method: 'DELETE',
    }).catch((error) => {
      if (!(error instanceof AppError && error.status === 404)) throw error;
    });
    await env.DB.prepare('DELETE FROM backups WHERE id=?').bind(old.id).run();
  }
  await env.DB.prepare(
    "DELETE FROM backups WHERE project_id=? AND status='failed' AND created_at<?",
  )
    .bind(schedule.project_id, now() - 30 * 86400)
    .run();
}

const finish = (
  env: Env,
  id: string,
  fields: { status: string; bytes?: number; error?: string },
) =>
  env.DB.prepare(
    'UPDATE backups SET status=?, bytes=?, error=?, bookmark=NULL, updated_at=? WHERE id=?',
  )
    .bind(fields.status, fields.bytes ?? null, fields.error ?? null, now(), id)
    .run();
const failure = (error: unknown) =>
  error instanceof AppError
    ? error.message
    : 'Something went wrong on Shipcel’s side.';

// Takes a copy one step on: polls the export, and once it is done, stores and prunes.
async function advance(env: Env, backup: Backup, schedule: Schedule | null) {
  let a: Account;
  let bytes: number;
  try {
    a = await account(env, backup.workspace_id, backup.project_id);
    const step = await exportStep(a, backup.database_id, backup.bookmark);
    if ('bookmark' in step) {
      await env.DB.prepare(
        'UPDATE backups SET bookmark=?, updated_at=? WHERE id=?',
      )
        .bind(step.bookmark, now(), backup.id)
        .run();
      return;
    }
    // One run stores it; a later minute's run finds it storing and leaves it alone.
    const claimed = await env.DB.prepare(
      "UPDATE backups SET status='storing', updated_at=? WHERE id=? AND status='exporting'",
    )
      .bind(now(), backup.id)
      .run();
    if (!claimed.meta.changes) return;
    bytes = await store(a, backup, step.url);
  } catch (error) {
    await finish(env, backup.id, { status: 'failed', error: failure(error) });
    return;
  }
  await finish(env, backup.id, { status: 'done', bytes });
  // The copy is stored either way; old ones that can't be removed now go after the next copy.
  if (schedule)
    await prune(env, a, schedule).catch((error) =>
      console.error('Removing old backups failed', backup.project_id, error),
    );
}

// A new copy of the schedule's database, started at once.
async function start(env: Env, schedule: Schedule) {
  const project = await env.DB.prepare(
    'SELECT free_only FROM projects WHERE id=?',
  )
    .bind(schedule.project_id)
    .first<{ free_only: number }>();
  if (project?.free_only)
    throw new AppError(
      409,
      'This project is Free-only, and backups go to R2, which can bill. Turn Free-only off, or stop backups.',
    );
  await refuseWhilePaused(env, schedule.project_id);
  const a = await account(env, schedule.workspace_id, schedule.project_id);
  const id = crypto.randomUUID();
  // Two copies in the same second still get keys of their own.
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const backup: Backup = {
    id,
    project_id: schedule.project_id,
    workspace_id: schedule.workspace_id,
    binding: schedule.binding,
    database_id: await databaseId(a, schedule.binding),
    status: 'exporting',
    bookmark: null,
    bucket: schedule.bucket,
    key: `d1/${schedule.binding}/${stamp}Z-${id.slice(0, 8)}.sql`,
    bytes: null,
    error: null,
    created_at: now(),
  };
  await env.DB.prepare(
    "INSERT INTO backups(id,project_id,workspace_id,binding,database_id,status,bucket,key,created_at,updated_at) VALUES (?,?,?,?,?,'exporting',?,?,?,?)",
  )
    .bind(
      backup.id,
      backup.project_id,
      backup.workspace_id,
      backup.binding,
      backup.database_id,
      backup.bucket,
      backup.key,
      now(),
      now(),
    )
    .run();
  await env.DB.prepare(
    'UPDATE backup_schedules SET last_error=NULL WHERE project_id=?',
  )
    .bind(schedule.project_id)
    .run();
  await advance(env, backup, schedule);
}

// Every minute: copies under way go one step on (or are given up), then due schedules start.
export async function scheduledBackups(env: Env) {
  const schedules = new Map<string, Schedule>();
  const scheduleOf = async (projectId: string) => {
    if (!schedules.has(projectId)) {
      const row = await env.DB.prepare(
        'SELECT * FROM backup_schedules WHERE project_id=?',
      )
        .bind(projectId)
        .first<Schedule>();
      if (row) schedules.set(projectId, row);
    }
    return schedules.get(projectId) ?? null;
  };
  const { results: running } = await env.DB.prepare(
    "SELECT * FROM backups WHERE status='exporting' ORDER BY updated_at LIMIT ?",
  )
    .bind(BATCH)
    .all<Backup>();
  for (const backup of running)
    if (backup.created_at < now() - GIVE_UP_AFTER)
      await finish(env, backup.id, {
        status: 'failed',
        error: 'Cloudflare’s export didn’t finish within two hours.',
      });
    else await advance(env, backup, await scheduleOf(backup.project_id));
  await env.DB.prepare(
    "UPDATE backups SET status='failed', error=?, updated_at=? WHERE status='storing' AND updated_at<?",
  )
    .bind('Storing the copy in R2 didn’t finish.', now(), now() - STORE_GIVE_UP)
    .run();
  const { results: due } = await env.DB.prepare(
    "SELECT s.* FROM backup_schedules s WHERE s.next_at<=? AND NOT EXISTS (SELECT 1 FROM backups b WHERE b.project_id=s.project_id AND b.status IN ('exporting', 'storing')) ORDER BY s.next_at LIMIT ?",
  )
    .bind(now(), BATCH)
    .all<Schedule>();
  for (const schedule of due) {
    await env.DB.prepare(
      'UPDATE backup_schedules SET next_at=? WHERE project_id=?',
    )
      .bind(
        nextBackup(schedule.cadence, schedule.hour, now()),
        schedule.project_id,
      )
      .run();
    await start(env, schedule).catch(async (error) => {
      // Not started (disconnected, not deployed, Free-only or paused): the schedule says why,
      // and an hour later it's tried again.
      console.error('Scheduled backup not started', schedule.project_id, error);
      await env.DB.prepare(
        'UPDATE backup_schedules SET last_error=?, next_at=? WHERE project_id=?',
      )
        .bind(failure(error), now() + RETRY_AFTER, schedule.project_id)
        .run();
    });
  }
}

// Routes ----------------------------------------------------------------------------------

async function project(c: Context<AppEnv>, need: 'view' | 'deploy') {
  const who = requireIdentity(c, need);
  const p = await c.env.DB.prepare(
    'SELECT id, name, free_only FROM projects WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<{ id: string; name: string; free_only: number }>();
  if (!p) throw new AppError(404, 'Project not found.');
  return { who, p };
}
const shownSchedule = (s: Schedule) => ({
  binding: s.binding,
  cadence: s.cadence,
  hour: s.hour,
  keep: s.keep,
  bucket: s.bucket,
  nextAt: s.next_at,
  lastError: s.last_error,
});
const shownBackup = (b: Backup) => ({
  id: b.id,
  binding: b.binding,
  status: b.status,
  key: b.key,
  bytes: b.bytes,
  error: b.error,
  createdAt: b.created_at,
});
const writable = (c: Context<AppEnv>) => {
  if (c.env.NATIVE_BUILDS_ENABLED !== 'true')
    throw new AppError(
      503,
      'Cloud operations are disabled until provider setup is verified.',
    );
};

backups.get('/projects/:id/backups', async (c) => {
  const { p } = await project(c, 'view');
  const schedule = await c.env.DB.prepare(
    'SELECT * FROM backup_schedules WHERE project_id=?',
  )
    .bind(p.id)
    .first<Schedule>();
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM backups WHERE project_id=? ORDER BY created_at DESC LIMIT 100',
  )
    .bind(p.id)
    .all<Backup>();
  return c.json({
    // A stopped schedule (no next copy) only keeps the bucket's name.
    schedule: schedule?.next_at ? shownSchedule(schedule) : null,
    backups: results.map(shownBackup),
  });
});

backups.put('/projects/:id/backups', async (c) => {
  const { who, p } = await project(c, 'deploy');
  writable(c);
  const input = z
    .object({
      binding: bindingName,
      cadence: z.enum(['daily', 'weekly']),
      hour: z.number().int().min(0).max(23),
      keep: z.number().int().min(1).max(90),
      confirm: z.literal(true),
    })
    .strict()
    .parse(await c.req.json());
  if (p.free_only)
    throw new AppError(
      409,
      'Backups go to R2, which can bill beyond its free tier, so a Free-only project can’t have them. An owner turns Free-only off in the project’s Billing panel.',
    );
  const a = await account(c.env, who.workspaceId, p.id);
  await databaseId(a, input.binding);
  const existing = await c.env.DB.prepare(
    'SELECT bucket FROM backup_schedules WHERE project_id=?',
  )
    .bind(p.id)
    .first<{ bucket: string }>();
  // The copies go to a bucket Shipcel made (kept by a stopped schedule too), never into one
  // it didn't; one deleted in Cloudflare since is made again.
  const bucket = existing?.bucket ?? `${a.worker.slice(0, 55)}-backups`;
  const there = await cloudflare(a.token, bucketPath(a, bucket)).then(
    () => true,
    (error) => {
      if (error instanceof AppError && error.status === 404) return false;
      throw error;
    },
  );
  if (there && !existing)
    throw new AppError(
      409,
      `A bucket named ${bucket} exists already in this Cloudflare account, and Shipcel keeps copies only in a bucket it makes. Rename or remove that bucket first.`,
    );
  if (!there)
    await cloudflare(
      a.token,
      `${a.root}/r2/buckets`,
      { method: 'POST', body: JSON.stringify({ name: bucket }) },
      { errorDetail: true },
    );
  await c.env.DB.prepare(
    'INSERT INTO backup_schedules(project_id,workspace_id,binding,cadence,hour,keep,bucket,next_at,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET binding=excluded.binding, cadence=excluded.cadence, hour=excluded.hour, keep=excluded.keep, next_at=excluded.next_at, last_error=NULL, user_id=excluded.user_id',
  )
    // The first copy is at the next time the hour comes round, whatever the cadence.
    .bind(
      p.id,
      who.workspaceId,
      input.binding,
      input.cadence,
      input.hour,
      input.keep,
      bucket,
      nextBackup('daily', input.hour, now()),
      who.userId,
      now(),
    )
    .run();
  const saved = await c.env.DB.prepare(
    'SELECT * FROM backup_schedules WHERE project_id=?',
  )
    .bind(p.id)
    .first<Schedule>();
  return c.json(shownSchedule(saved!));
});

backups.delete('/projects/:id/backups', async (c) => {
  const { p } = await project(c, 'deploy');
  await c.env.DB.prepare(
    'UPDATE backup_schedules SET next_at=NULL, last_error=NULL WHERE project_id=?',
  )
    .bind(p.id)
    .run();
  return c.json({ stopped: true });
});

backups.post('/projects/:id/backups/run', async (c) => {
  const { p } = await project(c, 'deploy');
  writable(c);
  z.object({ confirm: z.literal(true) })
    .strict()
    .parse(await c.req.json());
  const schedule = await c.env.DB.prepare(
    'SELECT * FROM backup_schedules WHERE project_id=?',
  )
    .bind(p.id)
    .first<Schedule>();
  if (!schedule?.next_at)
    throw new AppError(409, 'Set up backups for this project first.');
  const running = await c.env.DB.prepare(
    "SELECT 1 FROM backups WHERE project_id=? AND status IN ('exporting', 'storing')",
  )
    .bind(p.id)
    .first();
  if (running) throw new AppError(409, 'A copy is being made already.');
  await start(c.env, schedule);
  return c.json({ started: true }, 202);
});

backups.get('/projects/:id/backups/:backupId/download', async (c) => {
  const { who, p } = await project(c, 'deploy');
  const backup = await c.env.DB.prepare(
    "SELECT * FROM backups WHERE id=? AND project_id=? AND status='done'",
  )
    .bind(c.req.param('backupId'), p.id)
    .first<Backup>();
  if (!backup) throw new AppError(404, 'Backup not found.');
  const a = await account(c.env, who.workspaceId, p.id);
  const object = await cloudflareBody(
    a.token,
    objectPath(a, backup.bucket, backup.key),
  );
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/sql',
      'Content-Disposition': `attachment; filename="${backup.key.split('/').pop()}"`,
      'Cache-Control': 'no-store',
    },
  });
});
