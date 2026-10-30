import { beforeEach, describe, expect, it } from 'vitest';
import { database, projectInput } from './helpers/database';

// GET /api/deployments/recent: the newest non-preview deployment of each project in the
// workspace, newest first. The Overview shows the last deploy and each project's status
// (Not deployed, Building, Live, Failed) from it.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;

const job = (
  id: string,
  project: string,
  status: string,
  createdAt: number,
  environment = 'production',
) =>
  db.env.DB.prepare(
    "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,idempotency_key,created_at,updated_at,adapter,environment) VALUES (?,?,?,?,'cf','gh',?,'7','ada/app','main','a',?,?,'',?,'finished',?,?,?,'direct-upload',?)",
  )
    .bind(
      id,
      who.workspaceId,
      project,
      who.userId,
      'a'.repeat(32),
      id,
      `worker-${id}`,
      status,
      id,
      createdAt,
      createdAt,
      environment,
    )
    .run();

const create = async (name: string) =>
  (await (
    await db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(projectInput(name)) },
      who.cookie,
    )
  ).json()) as { id: string };

beforeEach(async () => {
  db = database();
  who = await db.user(1);
});

describe('recent deployments', () => {
  it('returns the newest non-preview deployment of each project, newest first', async () => {
    const a = await create('app-a');
    const b = await create('app-b');
    await job('a1', a.id, 'deployed', 100);
    await job('a2', a.id, 'failed', 200);
    // Newer, but a branch preview: production's state is the failed deploy.
    await job('a3', a.id, 'deployed', 300, 'preview');
    await job('b1', b.id, 'building', 150);
    const response = await db.request('/deployments/recent', {}, who.cookie);
    expect(response.status).toBe(200);
    const list = (await response.json()) as {
      id: string;
      project_id: string;
      status: string;
      environment: string;
    }[];
    expect(list.map((j) => [j.project_id, j.id, j.status])).toEqual([
      [a.id, 'a2', 'failed'],
      [b.id, 'b1', 'building'],
    ]);
  });
  it('is the workspace’s own', async () => {
    const a = await create('app-a');
    await job('a1', a.id, 'deployed', 100);
    const other = await db.user(2);
    const response = await db.request('/deployments/recent', {}, other.cookie);
    expect(await response.json()).toEqual([]);
  });
  it('needs a signed-in session', async () => {
    const response = await db.request('/deployments/recent', {});
    expect(response.status).toBe(401);
  });
});
