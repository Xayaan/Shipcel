import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { nextBackup, scheduledBackups } from '../worker/backups';
import worker from '../worker/index';

// Scheduled copies of a project's D1 database in R2 (worker/backups.ts), against a fake
// Cloudflare: the Worker's settings, D1's polling export, the signed dump, and R2's bucket and
// object calls through the API, as Cloudflare documents them.
const ACCOUNT = 'a'.repeat(32);
const WORKER = 'shop';
const DATABASE = '11111111-2222-4333-8444-555555555555';
const DUMP = 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n';

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let projectId: string;
let cf: ReturnType<typeof cloudflare>;

function cloudflare() {
  const state = {
    buckets: new Set<string>(),
    objects: new Map<string, string>(),
    // What each export call answers, in order; then complete.
    exports: [] as Record<string, unknown>[],
    exportCalls: [] as Record<string, unknown>[],
    // The size the signed download says it is.
    length: null as number | null,
    deletesFail: false,
    calls: [] as string[],
  };
  const ok = (result: unknown, status = 200) =>
    Response.json(
      { success: true, errors: [], messages: [], result },
      { status },
    );
  const missing = () =>
    Response.json(
      {
        success: false,
        errors: [{ code: 10006, message: 'not found' }],
        result: null,
      },
      { status: 404 },
    );
  const root = `/client/v4/accounts/${ACCOUNT}`;
  async function handler(
    input: string | URL | Request,
    init: RequestInit = {},
  ) {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    state.calls.push(`${method} ${url.pathname}`);
    if (url.hostname === 'd1-exports.test')
      return new Response(DUMP, {
        headers: { 'Content-Length': String(state.length ?? DUMP.length) },
      });
    const path = url.pathname;
    if (path === `${root}/workers/scripts/${WORKER}/settings`)
      return ok({ bindings: [{ name: 'DB', type: 'd1', id: DATABASE }] });
    if (
      path === `${root}/d1/database/${DATABASE}/export` &&
      method === 'POST'
    ) {
      state.exportCalls.push(JSON.parse(String(init.body)));
      return ok(
        state.exports.shift() ?? {
          status: 'complete',
          at_bookmark: 'b-done',
          result: {
            filename: 'shop.sql',
            signed_url: 'https://d1-exports.test/shop.sql?signature=x',
          },
        },
      );
    }
    if (path === `${root}/r2/buckets` && method === 'POST') {
      const { name } = JSON.parse(String(init.body)) as { name: string };
      state.buckets.add(name);
      return ok({ name });
    }
    const bucket = /^.*\/r2\/buckets\/([a-z0-9-]+)$/.exec(path)?.[1];
    if (bucket && method === 'GET')
      return state.buckets.has(bucket) ? ok({ name: bucket }) : missing();
    const object = /\/r2\/buckets\/([a-z0-9-]+)\/objects\/(.+)$/.exec(path);
    if (object) {
      const key = `${object[1]}/${decodeURIComponent(object[2])}`;
      if (method === 'PUT') {
        state.objects.set(
          key,
          await new Response(init.body as BodyInit).text(),
        );
        return ok({ key: object[2] });
      }
      if (method === 'DELETE') {
        if (state.deletesFail)
          return Response.json(
            {
              success: false,
              errors: [{ code: 10001, message: 'internal error' }],
              result: null,
            },
            { status: 500 },
          );
        state.objects.delete(key);
        return ok({});
      }
      const stored = state.objects.get(key);
      return stored === undefined ? missing() : new Response(stored);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }
  return { state, handler };
}

const request = (path: string, method = 'GET', body?: unknown) =>
  db.request(
    `/projects/${projectId}${path}`,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    who.cookie,
  );
const schedule = (body: Record<string, unknown> = {}) =>
  request('/backups', 'PUT', {
    binding: 'DB',
    cadence: 'daily',
    hour: 3,
    keep: 2,
    confirm: true,
    ...body,
  });
type View = {
  schedule: {
    cadence: string;
    hour: number;
    keep: number;
    bucket: string;
    nextAt: number;
    lastError: string | null;
  } | null;
  backups: {
    id: string;
    status: string;
    key: string;
    bytes: number | null;
    error: string | null;
  }[];
};
const view = async () => (await (await request('/backups')).json()) as View;
// One minute of Shipcel's cron, as Cloudflare runs it.
async function minute() {
  const work: Promise<unknown>[] = [];
  worker.scheduled({} as ScheduledController, db.env, {
    waitUntil: (promise: Promise<unknown>) => work.push(promise),
  } as unknown as ExecutionContext);
  await Promise.all(work);
}
// The schedule is due now: the next minute's run starts a copy.
const due = () =>
  db.sqlite
    .prepare('UPDATE backup_schedules SET next_at=?')
    .run(Math.floor(Date.now() / 1000) - 1);

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    {
      method: 'POST',
      body: JSON.stringify({
        ...projectInput(WORKER),
        freeOnly: false,
        database: true,
      }),
    },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const t = Math.floor(Date.now() / 1000);
  db.sqlite
    .prepare(
      "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,worker_tag,idempotency_key,created_at,updated_at,adapter,environment) VALUES ('job-1',?,?,?,'','',?,'','','','','',?,'','deployed','finished',?,'upload:1',?,?,'direct-upload','production')",
    )
    .run(
      who.workspaceId,
      projectId,
      who.userId,
      ACCOUNT,
      WORKER,
      'f'.repeat(32),
      t,
      t,
    );
  cf = cloudflare();
  vi.stubGlobal('fetch', vi.fn(cf.handler));
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('scheduled database backups to R2', () => {
  it('keeps a schedule of copies in a bucket Shipcel makes for the project', async () => {
    const set = await schedule();
    expect(set.status).toBe(200);
    const { schedule: saved } = await view();
    expect(saved).toMatchObject({
      cadence: 'daily',
      hour: 3,
      keep: 2,
      bucket: 'shop-backups',
    });
    expect(new Date(saved!.nextAt * 1000).getUTCHours()).toBe(3);
    expect(saved!.nextAt).toBeGreaterThan(Date.now() / 1000);
    expect([...cf.state.buckets]).toEqual(['shop-backups']);
    // Changing it keeps the bucket.
    expect(
      (await schedule({ cadence: 'weekly', hour: 22, keep: 8 })).status,
    ).toBe(200);
    expect((await view()).schedule).toMatchObject({
      cadence: 'weekly',
      hour: 22,
      keep: 8,
      bucket: 'shop-backups',
    });
    // What isn't a schedule is refused.
    for (const bad of [
      { hour: 24 },
      { keep: 0 },
      { keep: 91 },
      { cadence: 'hourly' },
      { binding: 'no such' },
      { confirm: undefined },
    ])
      expect([bad, (await schedule(bad)).status]).toEqual([bad, 400]);
    // While backups run, Free-only can't come back on: R2 can bill.
    const freeOnly = await request('/free-only', 'PUT', { freeOnly: true });
    expect(freeOnly.status).toBe(409);
    expect(await freeOnly.text()).toContain('Scheduled backups');
    // Stopping keeps the copies in the bucket.
    expect((await request('/backups', 'DELETE')).status).toBe(200);
    expect((await view()).schedule).toBeNull();
    // Started again, copies go on into the bucket Shipcel made, made again if it was deleted
    // in Cloudflare meanwhile.
    expect((await schedule()).status).toBe(200);
    expect((await view()).schedule?.bucket).toBe('shop-backups');
    await request('/backups', 'DELETE');
    cf.state.buckets.clear();
    expect((await schedule()).status).toBe(200);
    expect([...cf.state.buckets]).toEqual(['shop-backups']);
  });

  it('says on the schedule why a copy didn’t start, and tries again an hour later', async () => {
    await schedule();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = () => Math.floor(Date.now() / 1000);
    const causes = [
      [
        'Free-only',
        () => db.sqlite.prepare('UPDATE projects SET free_only=1').run(),
      ],
      [
        'paused',
        () =>
          db.sqlite
            .prepare(
              "INSERT INTO budget_checks(project_id,workspace_id,account_id,worker_name,month,plan,state,checked_at) VALUES (?,?,?,?,'2026-10','paid','paused',?)",
            )
            .run(projectId, who.workspaceId, ACCOUNT, WORKER, t()),
      ],
      [
        'Deploy this project first',
        () => db.sqlite.prepare('DELETE FROM deployment_jobs').run(),
      ],
    ] as const;
    for (const [why, cause] of causes) {
      db.sqlite.prepare('UPDATE projects SET free_only=0').run();
      db.sqlite.prepare('DELETE FROM budget_checks').run();
      cause();
      due();
      await scheduledBackups(db.env);
      const { schedule: saved, backups } = await view();
      expect(saved!.lastError).toContain(why);
      expect(saved!.nextAt - t()).toBeGreaterThan(3500);
      expect(saved!.nextAt - t()).toBeLessThanOrEqual(3600);
      expect(backups).toEqual([]);
    }
    expect(logged).toHaveBeenCalled();
  });

  it('stores a copy once when two runs reach it, and gives up an upload that stopped', async () => {
    await schedule();
    cf.state.exports = [{ status: 'active', at_bookmark: 'b-1' }];
    expect(
      (await request('/backups/run', 'POST', { confirm: true })).status,
    ).toBe(202);
    // Two minutes' runs at once both find the export done; one stores it.
    await Promise.all([scheduledBackups(db.env), scheduledBackups(db.env)]);
    const uploads = cf.state.calls.filter(
      (call) => call.startsWith('PUT') && call.includes('/objects/'),
    );
    expect(uploads).toHaveLength(1);
    expect((await view()).backups.map((b) => b.status)).toEqual(['done']);
    // An upload whose run ended part-way is given up after twenty minutes.
    db.sqlite
      .prepare("UPDATE backups SET status='storing', updated_at=?")
      .run(Math.floor(Date.now() / 1000) - 1300);
    await scheduledBackups(db.env);
    expect((await view()).backups[0]).toMatchObject({
      status: 'failed',
      error: 'Storing the copy in R2 didn’t finish.',
    });
  });

  it('refuses what it can’t do: a Free-only project, a database that isn’t bound, a bucket that isn’t Shipcel’s', async () => {
    db.sqlite.prepare('UPDATE projects SET free_only=1').run();
    const free = await schedule();
    expect(free.status).toBe(409);
    expect(await free.text()).toContain('Free-only');
    db.sqlite.prepare('UPDATE projects SET free_only=0').run();
    const unbound = await schedule({ binding: 'OTHER' });
    expect(unbound.status).toBe(409);
    expect(await unbound.text()).toContain('no D1 database bound as OTHER');
    cf.state.buckets.add('shop-backups');
    const taken = await schedule();
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain('shop-backups exists already');
  });

  it('copies the database at its hour through Cloudflare’s export, and keeps the newest', async () => {
    await schedule();
    cf.state.exports = [{ status: 'active', at_bookmark: 'b-1' }];
    due();
    // The first minute starts the export; the next one finishes it and stores the dump.
    await minute();
    let backups = (await view()).backups;
    expect(backups).toEqual([expect.objectContaining({ status: 'exporting' })]);
    await scheduledBackups(db.env);
    expect(cf.state.exportCalls).toEqual([
      { output_format: 'polling' },
      { output_format: 'polling', current_bookmark: 'b-1' },
    ]);
    backups = (await view()).backups;
    expect(backups).toEqual([
      expect.objectContaining({
        status: 'done',
        bytes: DUMP.length,
        error: null,
      }),
    ]);
    expect(backups[0].key).toMatch(
      /^d1\/DB\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}\.sql$/,
    );
    expect(cf.state.objects.get(`shop-backups/${backups[0].key}`)).toBe(DUMP);
    // The next copy is the next time 03:00 UTC comes round.
    const { nextAt } = (await view()).schedule!;
    const left = nextAt - Math.floor(Date.now() / 1000);
    expect(new Date(nextAt * 1000).getUTCHours()).toBe(3);
    expect(left > 0 && left <= 86400).toBe(true);
    // Three more copies, a day apart: the two newest are kept, in the bucket and the list.
    for (let i = 0; i < 3; i++) {
      db.sqlite.prepare('UPDATE backups SET created_at=created_at-86400').run();
      due();
      await scheduledBackups(db.env);
    }
    backups = (await view()).backups;
    expect(backups.map((b) => b.status)).toEqual(['done', 'done']);
    expect([...cf.state.objects.keys()].sort()).toEqual(
      backups.map((b) => `shop-backups/${b.key}`).sort(),
    );
    // An old copy R2 won't remove now doesn't fail the new one, and goes after the next copy.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    cf.state.deletesFail = true;
    for (const statuses of [
      ['done', 'done', 'done'],
      ['done', 'done'],
    ]) {
      db.sqlite.prepare('UPDATE backups SET created_at=created_at-86400').run();
      due();
      await scheduledBackups(db.env);
      expect((await view()).backups.map((b) => b.status)).toEqual(statuses);
      cf.state.deletesFail = false;
    }
    expect(logged).toHaveBeenCalledWith(
      'Removing old backups failed',
      projectId,
      expect.anything(),
    );
    expect(cf.state.objects.size).toBe(2);
    // A deleted project's copies stop, and those made stay in the bucket.
    expect((await request('', 'DELETE')).status).toBe(200);
    due();
    await scheduledBackups(db.env);
    expect(
      db.sqlite.prepare('SELECT COUNT(*) AS n FROM backups').get(),
    ).toEqual({ n: 0 });
    expect(cf.state.objects.size).toBe(2);
  });

  it('starts no other copy while one is being made', async () => {
    await schedule();
    cf.state.exports = [
      { status: 'active', at_bookmark: 'b-1' },
      { status: 'active', at_bookmark: 'b-2' },
    ];
    due();
    await scheduledBackups(db.env);
    expect(
      (await request('/backups/run', 'POST', { confirm: true })).status,
    ).toBe(409);
    due();
    await scheduledBackups(db.env);
    expect((await view()).backups).toEqual([
      expect.objectContaining({ status: 'exporting' }),
    ]);
    expect(cf.state.exportCalls).toHaveLength(2);
  });

  it('says why a copy failed', async () => {
    await schedule();
    cf.state.exports = [{ status: 'error', error: 'D1 is busy' }];
    due();
    await scheduledBackups(db.env);
    expect((await view()).backups[0]).toMatchObject({
      status: 'failed',
      error: 'Cloudflare couldn’t export the database: D1 is busy.',
    });
    // A dump too large for one upload through the API.
    cf.state.length = 400 * 1024 * 1024;
    due();
    await scheduledBackups(db.env);
    expect((await view()).backups[0].error).toContain('400 MB');
    cf.state.length = null;
    // An export that never finishes is given up after two hours.
    cf.state.exports = [{ status: 'active', at_bookmark: 'b-1' }];
    due();
    await scheduledBackups(db.env);
    db.sqlite
      .prepare(
        "UPDATE backups SET created_at=created_at-7300 WHERE status='exporting'",
      )
      .run();
    await scheduledBackups(db.env);
    const stuck = (await view()).backups.find((b) =>
      b.error?.includes('two hours'),
    );
    expect(stuck?.status).toBe('failed');
    // It wasn't asked about again.
    expect(cf.state.exportCalls).toHaveLength(3);
  });

  it('backs up now on request, and downloads a copy', async () => {
    await schedule();
    const started = await request('/backups/run', 'POST', { confirm: true });
    expect(started.status).toBe(202);
    const [done] = (await view()).backups;
    expect(done.status).toBe('done');
    const download = await request(`/backups/${done.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(await download.text()).toBe(DUMP);
    expect(
      (await request(`/backups/${crypto.randomUUID()}/download`)).status,
    ).toBe(404);
    // Only through its own project, in its own workspace.
    const other = await db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(projectInput('other')) },
      who.cookie,
    );
    const otherId = ((await other.json()) as { id: string }).id;
    const elsewhere = await db.request(
      `/projects/${otherId}/backups/${done.id}/download`,
      {},
      who.cookie,
    );
    expect(elsewhere.status).toBe(404);
    const intruder = await db.user(2);
    for (const path of ['/backups', `/backups/${done.id}/download`])
      expect(
        (await db.request(`/projects/${projectId}${path}`, {}, intruder.cookie))
          .status,
      ).toBe(404);
  });

  it('times copies at the hour asked, every day or week', () => {
    const at = (iso: string) => Date.parse(iso) / 1000;
    expect(nextBackup('daily', 3, at('2026-10-30T02:59:00Z'))).toBe(
      at('2026-10-30T03:00:00Z'),
    );
    expect(nextBackup('daily', 3, at('2026-10-30T03:00:00Z'))).toBe(
      at('2026-10-31T03:00:00Z'),
    );
    expect(nextBackup('weekly', 3, at('2026-10-30T03:00:00Z'))).toBe(
      at('2026-11-06T03:00:00Z'),
    );
  });
});
