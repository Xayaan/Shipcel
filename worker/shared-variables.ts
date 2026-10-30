import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireIdentity } from './auth';
import { refuseWhilePaused } from './budgets';
import { change, confirmation, secretName, target } from './operations';
import { cloudflare, providerPath } from './providers';
import { AppError, now, type AppEnv, type Env } from './types';

// Shared variables: a secret a workspace sets on several of its projects' Workers at once.
// The value goes to each Worker, as `shipcel env add` sends it, and nowhere else: Shipcel
// keeps the name and when each project last got it, so a project added later needs the value
// again. Each Worker's change is an operation in that project's history.
export const sharedVariables = new Hono<AppEnv>();

// Projects one change reaches: each takes a few Cloudflare calls and database queries, well
// inside a request's limits on Workers Paid.
const MAX_PROJECTS = 20;

type Result = {
  projectId: string;
  status: 'set' | 'removed' | 'failed';
  error?: string;
};

// Sets the secret on one project's Worker, or removes it (`value` null).
async function apply(
  c: Context<AppEnv>,
  projectId: string,
  name: string,
  requestId: string,
  value: string | null,
): Promise<Result> {
  try {
    const t = await target(c, true, projectId);
    await refuseWhilePaused(c.env, projectId);
    const response = await change(
      c,
      t,
      `${value === null ? 'secret.remove' : 'secret.set'}:${name}`,
      `${requestId}:${projectId}`,
      async () => {
        if (value !== null)
          await cloudflare(t.token, `${t.script}/secrets`, {
            method: 'PUT',
            body: JSON.stringify({ name, text: value, type: 'secret_text' }),
          });
        else
          await cloudflare(
            t.token,
            `${t.script}/secrets/${providerPath(name)}`,
            { method: 'DELETE' },
          ).catch((error) => {
            // Removed in Cloudflare already.
            if (!(error instanceof AppError && error.status === 404))
              throw error;
          });
        return { name };
      },
      { intent: { name } },
    );
    const outcome = (await response.json()) as {
      status: string;
      error?: string;
    };
    return outcome.status === 'succeeded'
      ? { projectId, status: value === null ? 'removed' : 'set' }
      : { projectId, status: 'failed', error: outcome.error };
  } catch (error) {
    return {
      projectId,
      status: 'failed',
      error:
        error instanceof AppError
          ? error.message
          : 'Something went wrong on Shipcel’s side.',
    };
  }
}

// Where the value is now: projects that got it are current, removed ones leave the list, and
// one that failed stays as it was (out of date, if it had an older value).
async function record(
  env: Env,
  workspaceId: string,
  name: string,
  results: Result[],
  at: number,
) {
  const statements = results.flatMap((r) =>
    r.status === 'set'
      ? [
          env.DB.prepare(
            'INSERT INTO shared_variable_projects(workspace_id,name,project_id,set_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,name,project_id) DO UPDATE SET set_at=excluded.set_at',
          ).bind(workspaceId, name, r.projectId, at),
        ]
      : r.status === 'removed'
        ? [
            env.DB.prepare(
              'DELETE FROM shared_variable_projects WHERE workspace_id=? AND name=? AND project_id=?',
            ).bind(workspaceId, name, r.projectId),
          ]
        : [],
  );
  if (statements.length) await env.DB.batch(statements);
}

const linkedProjects = async (env: Env, workspaceId: string, name: string) =>
  (
    await env.DB.prepare(
      'SELECT v.project_id FROM shared_variable_projects v JOIN projects p ON p.id=v.project_id WHERE v.workspace_id=? AND v.name=? ORDER BY p.name',
    )
      .bind(workspaceId, name)
      .all<{ project_id: string }>()
  ).results.map((row) => row.project_id);

sharedVariables.get('/shared-variables', async (c) => {
  const who = requireIdentity(c);
  const { results: variables } = await c.env.DB.prepare(
    'SELECT name, updated_at FROM shared_variables WHERE workspace_id=? ORDER BY name',
  )
    .bind(who.workspaceId)
    .all<{ name: string; updated_at: number }>();
  const { results: links } = await c.env.DB.prepare(
    'SELECT v.name, v.project_id, v.set_at, p.name AS project FROM shared_variable_projects v JOIN projects p ON p.id=v.project_id AND p.workspace_id=v.workspace_id WHERE v.workspace_id=? ORDER BY p.name',
  )
    .bind(who.workspaceId)
    .all<{
      name: string;
      project_id: string;
      set_at: number;
      project: string;
    }>();
  return c.json({
    variables: variables.map((v) => ({
      name: v.name,
      updatedAt: v.updated_at,
      projects: links
        .filter((link) => link.name === v.name)
        .map((link) => ({
          id: link.project_id,
          name: link.project,
          current: link.set_at >= v.updated_at,
        })),
    })),
  });
});

// The variable, with this value, on exactly these projects: it is set on each of them and
// removed from projects that had it before and aren't listed now.
sharedVariables.put('/shared-variables/:name', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const name = secretName.parse(c.req.param('name'));
  const input = z
    .object({
      ...confirmation,
      value: z.string().min(1).max(4096),
      projectIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_PROJECTS),
    })
    .strict()
    .parse(await c.req.json());
  const wanted = [...new Set(input.projectIds)];
  const { results: known } = await c.env.DB.prepare(
    `SELECT id FROM projects WHERE workspace_id=? AND id IN (${wanted.map(() => '?').join(',')})`,
  )
    .bind(who.workspaceId, ...wanted)
    .all<{ id: string }>();
  if (known.length !== wanted.length)
    throw new AppError(404, 'Project not found.');
  const dropped = (await linkedProjects(c.env, who.workspaceId, name)).filter(
    (id) => !wanted.includes(id),
  );
  if (wanted.length + dropped.length > MAX_PROJECTS)
    throw new AppError(
      409,
      `One change reaches at most ${MAX_PROJECTS} projects. Remove the variable from some first.`,
    );
  const at = now();
  await c.env.DB.prepare(
    'INSERT INTO shared_variables(workspace_id,name,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET updated_by=excluded.updated_by, updated_at=excluded.updated_at',
  )
    .bind(who.workspaceId, name, who.userId, at)
    .run();
  const results: Result[] = [];
  for (const id of wanted)
    results.push(await apply(c, id, name, input.requestId, input.value));
  for (const id of dropped)
    results.push(await apply(c, id, name, input.requestId, null));
  await record(c.env, who.workspaceId, name, results, at);
  return c.json({ name, results });
});

// Removed from every project that has it; the variable goes once none is left.
sharedVariables.delete('/shared-variables/:name', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const name = secretName.parse(c.req.param('name'));
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const results: Result[] = [];
  for (const id of await linkedProjects(c.env, who.workspaceId, name))
    results.push(await apply(c, id, name, input.requestId, null));
  await record(c.env, who.workspaceId, name, results, now());
  if (!results.some((r) => r.status === 'failed'))
    await c.env.DB.prepare(
      'DELETE FROM shared_variables WHERE workspace_id=? AND name=?',
    )
      .bind(who.workspaceId, name)
      .run();
  return c.json({ name, results });
});
