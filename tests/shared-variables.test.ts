import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';

// Shared variables (worker/shared-variables.ts): a secret set on several of a workspace's
// projects at once, through each Worker's secrets API as Cloudflare documents it. Three
// deployed projects, each with its own Worker, against a fake Cloudflare.
const ACCOUNT = 'a'.repeat(32);
// A Worker's immutable tag, as Cloudflare gives it: hex.
const tagOf = (worker: string) =>
  Buffer.from(worker).toString('hex').padEnd(32, '0');
const VALUE = 'sk_live_shared_value';

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let ids: Record<string, string>;
let cf: {
  // Each Worker's secrets, by name.
  secrets: Map<string, Map<string, string>>;
  failing: Set<string>;
  calls: string[];
};

async function deployedProject(name: string) {
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput(name)) },
    who.cookie,
  );
  const id = ((await created.json()) as { id: string }).id;
  const t = Math.floor(Date.now() / 1000);
  db.sqlite
    .prepare(
      "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,worker_tag,idempotency_key,created_at,updated_at,adapter,environment) VALUES (?,?,?,?,'','',?,'','','','','',?,'','deployed','finished',?,?,?,?,'direct-upload','production')",
    )
    .run(
      `job-${name}`,
      who.workspaceId,
      id,
      who.userId,
      ACCOUNT,
      `wk-${name}`,
      tagOf(`wk-${name}`),
      `upload:${name}`,
      t,
      t,
    );
  cf.secrets.set(`wk-${name}`, new Map());
  return id;
}
const share = (body: Record<string, unknown>, name = 'API_KEY') =>
  db.request(
    `/shared-variables/${name}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        confirm: true,
        value: VALUE,
        ...body,
      }),
    },
    who.cookie,
  );
type Listed = {
  variables: { name: string; projects: { name: string; current: boolean }[] }[];
};
const listed = async () =>
  (
    (await (
      await db.request('/shared-variables', {}, who.cookie)
    ).json()) as Listed
  ).variables;
const results = async (response: Response) =>
  (
    (await response.json()) as {
      results: { projectId: string; status: string; error?: string }[];
    }
  ).results.map((r) => [
    Object.keys(ids).find((k) => ids[k] === r.projectId),
    r.status,
    r.error,
  ]);

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  cf = { secrets: new Map(), failing: new Set(), calls: [] };
  const ok = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(String(raw)).pathname;
      const method = (init.method ?? 'GET').toUpperCase();
      cf.calls.push(`${method} ${path}`);
      if (path === `/client/v4/accounts/${ACCOUNT}/workers/scripts`)
        return ok([...cf.secrets.keys()].map((id) => ({ id, tag: tagOf(id) })));
      const secret = /\/workers\/scripts\/([\w-]+)\/secrets(?:\/(\w+))?$/.exec(
        path,
      );
      if (secret) {
        const [, worker, name] = secret;
        if (cf.failing.has(worker))
          return Response.json(
            {
              success: false,
              errors: [{ code: 10013, message: 'internal error' }],
              result: null,
            },
            { status: 500 },
          );
        const stored = cf.secrets.get(worker)!;
        if (method === 'PUT') {
          const body = JSON.parse(String(init.body)) as {
            name: string;
            text: string;
          };
          stored.set(body.name, body.text);
          return ok({ name: body.name, type: 'secret_text' });
        }
        if (method === 'DELETE') {
          if (!stored.delete(name))
            return Response.json(
              {
                success: false,
                errors: [{ code: 10056, message: 'secret not found' }],
                result: null,
              },
              { status: 404 },
            );
          return ok(null);
        }
      }
      throw new Error(`Unexpected ${method} ${path}`);
    }),
  );
  ids = {};
  for (const name of ['alpha', 'beta', 'gamma'])
    ids[name] = await deployedProject(name);
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('shared variables', () => {
  it('sets one value on the chosen projects, each as an operation, and keeps only names and times', async () => {
    const set = await share({ projectIds: [ids.alpha, ids.beta, ids.alpha] });
    expect(set.status).toBe(200);
    expect(await results(set)).toEqual([
      ['alpha', 'set', undefined],
      ['beta', 'set', undefined],
    ]);
    expect(cf.secrets.get('wk-alpha')!.get('API_KEY')).toBe(VALUE);
    expect(cf.secrets.get('wk-beta')!.get('API_KEY')).toBe(VALUE);
    expect(cf.secrets.get('wk-gamma')!.size).toBe(0);
    expect(await listed()).toEqual([
      {
        name: 'API_KEY',
        updatedAt: expect.any(Number),
        projects: [
          { id: ids.alpha, name: 'alpha', current: true },
          { id: ids.beta, name: 'beta', current: true },
        ],
      },
    ]);
    const history = (await (
      await db.request(`/projects/${ids.alpha}/operations`, {}, who.cookie)
    ).json()) as { kind: string; status: string }[];
    expect(history).toContainEqual(
      expect.objectContaining({
        kind: 'secret.set:API_KEY',
        status: 'succeeded',
      }),
    );
    // The value went to Cloudflare and nowhere else.
    const everything = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(({ name }) =>
        JSON.stringify(db.sqlite.prepare(`SELECT * FROM "${name}"`).all()),
      )
      .join();
    expect(everything).not.toContain(VALUE);
  });

  it('moves to exactly the projects listed, removing it where it was and isn’t now', async () => {
    await share({ projectIds: [ids.alpha, ids.beta] });
    const moved = await share({ projectIds: [ids.beta, ids.gamma] });
    expect(await results(moved)).toEqual([
      ['beta', 'set', undefined],
      ['gamma', 'set', undefined],
      ['alpha', 'removed', undefined],
    ]);
    expect(cf.secrets.get('wk-alpha')!.has('API_KEY')).toBe(false);
    expect((await listed())[0].projects.map((p) => p.name)).toEqual([
      'beta',
      'gamma',
    ]);
    // One already removed in Cloudflare counts as removed.
    cf.secrets.get('wk-gamma')!.delete('API_KEY');
    expect(await results(await share({ projectIds: [ids.beta] }))).toEqual([
      ['beta', 'set', undefined],
      ['gamma', 'removed', undefined],
    ]);
  });

  it('shows a project that missed a new value as out of date, and a paused project refuses it', async () => {
    await share({ projectIds: [ids.alpha, ids.beta] });
    cf.failing.add('wk-beta');
    const t = Math.floor(Date.now() / 1000);
    db.sqlite
      .prepare(
        "INSERT INTO budget_checks(project_id,workspace_id,account_id,worker_name,month,plan,state,checked_at) VALUES (?,?,?,?,?,'paid','paused',?)",
      )
      .run(ids.gamma, who.workspaceId, ACCOUNT, 'wk-gamma', '2026-10', t);
    // A second later, so the new value is newer than the old one.
    vi.useFakeTimers({ now: Date.now() + 2000, toFake: ['Date'] });
    const changed = await share({
      projectIds: [ids.alpha, ids.beta, ids.gamma],
      value: 'sk_live_rotated',
    });
    vi.useRealTimers();
    const [alpha, beta, gamma] = await results(changed);
    expect(alpha).toEqual(['alpha', 'set', undefined]);
    expect(beta.slice(0, 2)).toEqual(['beta', 'failed']);
    expect(gamma).toEqual([
      'gamma',
      'failed',
      expect.stringContaining('paused for going over its budget'),
    ]);
    expect(cf.secrets.get('wk-beta')!.get('API_KEY')).toBe(VALUE);
    expect((await listed())[0].projects).toEqual([
      { id: ids.alpha, name: 'alpha', current: true },
      { id: ids.beta, name: 'beta', current: false },
    ]);
  });

  it('is removed from every project, and stays where removing failed', async () => {
    await share({ projectIds: [ids.alpha, ids.beta] });
    cf.failing.add('wk-beta');
    const remove = () =>
      db.request(
        '/shared-variables/API_KEY',
        {
          method: 'DELETE',
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            confirm: true,
          }),
        },
        who.cookie,
      );
    expect((await results(await remove())).map((r) => r.slice(0, 2))).toEqual([
      ['alpha', 'removed'],
      ['beta', 'failed'],
    ]);
    expect((await listed())[0].projects.map((p) => p.name)).toEqual(['beta']);
    cf.failing.clear();
    await remove();
    expect(await listed()).toEqual([]);
    expect(
      [...cf.secrets.values()].every((secrets) => !secrets.has('API_KEY')),
    ).toBe(true);
  });

  it('reaches only the workspace’s own projects, for those who can deploy', async () => {
    const stranger = await db.user(2);
    const theirs = await db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(projectInput('theirs')) },
      stranger.cookie,
    );
    const theirId = ((await theirs.json()) as { id: string }).id;
    expect((await share({ projectIds: [ids.alpha, theirId] })).status).toBe(
      404,
    );
    for (const bad of [
      { projectIds: [] },
      { projectIds: Array.from({ length: 21 }, (_, i) => `p${i}`) },
      { projectIds: [ids.alpha], value: '' },
      { projectIds: [ids.alpha], confirm: undefined },
    ])
      expect([bad, (await share(bad)).status]).toEqual([bad, 400]);
    expect((await share({ projectIds: [ids.alpha] }, 'bad-name')).status).toBe(
      400,
    );
    const viewer = await db.user(3, 'viewer');
    db.sqlite
      .prepare('UPDATE sessions SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, viewer.userId);
    db.sqlite
      .prepare('UPDATE memberships SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, viewer.userId);
    const refused = await db.request(
      '/shared-variables/API_KEY',
      {
        method: 'PUT',
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          confirm: true,
          value: VALUE,
          projectIds: [ids.alpha],
        }),
      },
      viewer.cookie,
    );
    expect(refused.status).toBe(403);
    expect(cf.secrets.get('wk-alpha')!.size).toBe(0);
  });

  it('forgets a deleted project', async () => {
    await share({ projectIds: [ids.alpha, ids.beta] });
    expect(
      (
        await db.request(
          `/projects/${ids.alpha}`,
          { method: 'DELETE' },
          who.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      db.sqlite
        .prepare('SELECT project_id FROM shared_variable_projects')
        .all(),
    ).toEqual([{ project_id: ids.beta }]);
  });
});
