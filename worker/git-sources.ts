import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { limit, requireIdentity } from './auth';
import { checkedToken, signedClaims, type Signer } from './github-oidc';
import { insertToken } from './tokens';
import { AppError, appOrigin, now, type AppEnv } from './types';

// Repositories on GitLab, Bitbucket and Gitea (or Forgejo) that deploy a project from their own
// CI with the shipcel CLI, as GitHub Actions do (worker/github-actions.ts). A job on GitLab.com
// signs in with GitLab's ID token, exchanged here for a token that deploys the linked project for
// an hour. Bitbucket Pipelines, Gitea Actions and GitLab on another host sign in with a deploy
// token: one of the project's, made through the approval page (shipcel tokens add --project).
export const gitSources = new Hono<AppEnv>();
export const gitSourceToken = new Hono<AppEnv>();

const RUN_TOKEN_SECONDS = 3600;
const GITLAB_ISSUER = 'https://gitlab.com';
const GITLAB: Signer = {
  jwks: `${GITLAB_ISSUER}/oauth/discovery/keys`,
  name: 'GitLab',
  unreachable:
    'Shipcel couldn’t reach GitLab to check this job. Retry the job.',
};
// GitLab's ID tokens last as long as their job may run: one made for more than a day is refused.
const GITLAB_LIFETIME = 86_400;

const host = /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;
const hosts = {
  gitlab: host,
  bitbucket: /^bitbucket\.org$/,
  gitea: host,
};
const segment = /^(?!\.{1,2}$)[\w.-]{1,100}$/;
const repositoryPath = z.string().refine((p) => {
  const parts = p.split('/');
  return (
    parts.length >= 2 &&
    parts.length <= 5 &&
    parts.every((s) => segment.test(s))
  );
}, 'Name the repository by its path, such as group/project.');
const branchName = z
  .string()
  .regex(/^[\w./-]{1,200}$/)
  .refine((b) => !b.includes('..'), 'Use a branch name without "..".');
const sourceInput = z
  .object({
    provider: z.enum(['gitlab', 'bitbucket', 'gitea']),
    host: z.string().max(260),
    repository: repositoryPath,
    branch: branchName,
  })
  .strict()
  .refine((s) => hosts[s.provider].test(s.host), {
    message:
      'Name the Git host by its name alone, such as gitlab.com, bitbucket.org or codeberg.org.',
    path: ['host'],
  });

type Source = {
  project_id: string;
  workspace_id: string;
  provider: string;
  host: string;
  repository: string;
  branch: string;
  remote_id: string | null;
  owner_id: string | null;
  user_id: string;
  created_at: number;
};
// How the repository's jobs sign in: GitLab.com's ID token, or a deploy token.
const signIn = (s: Pick<Source, 'provider' | 'host'>) =>
  s.provider === 'gitlab' && s.host === 'gitlab.com'
    ? 'id-token'
    : 'deploy-token';
const shown = (s: Source) => ({
  provider: s.provider,
  host: s.host,
  repository: s.repository,
  branch: s.branch,
  signIn: signIn(s),
  url: `https://${s.host}/${s.repository}`,
  createdAt: s.created_at,
});

async function project(c: Context<AppEnv>, need: 'view' | 'deploy') {
  const who = requireIdentity(c, need);
  const p = await c.env.DB.prepare(
    'SELECT id, name FROM projects WHERE id=? AND workspace_id=?',
  )
    .bind(c.req.param('id'), who.workspaceId)
    .first<{ id: string; name: string }>();
  if (!p) throw new AppError(404, 'Project not found.');
  return { who, p };
}

gitSources.get('/projects/:id/git-source', async (c) => {
  const { who, p } = await project(c, 'view');
  const source = await c.env.DB.prepare(
    'SELECT * FROM git_sources WHERE project_id=? AND workspace_id=?',
  )
    .bind(p.id, who.workspaceId)
    .first<Source>();
  return c.json({ source: source ? shown(source) : null });
});

gitSources.put('/projects/:id/git-source', async (c) => {
  const { who, p } = await project(c, 'deploy');
  const input = sourceInput.parse(await c.req.json());
  // A project deploys one way.
  const github = await c.env.DB.prepare(
    "SELECT 1 FROM github_actions WHERE project_id=? UNION ALL SELECT 1 FROM deployment_jobs WHERE project_id=? AND environment='production' AND adapter<>'direct-upload' LIMIT 1",
  )
    .bind(p.id, p.id)
    .first();
  if (github)
    throw new AppError(
      409,
      `${p.name} deploys from GitHub. Disconnect it there first, or give this repository a project of its own.`,
    );
  const taken = await c.env.DB.prepare(
    'SELECT p.name, p.workspace_id FROM git_sources g JOIN projects p ON p.id=g.project_id WHERE g.host=? AND lower(g.repository)=lower(?) AND g.project_id<>?',
  )
    .bind(input.host, input.repository, p.id)
    .first<{ name: string; workspace_id: string }>();
  if (taken)
    throw new AppError(
      409,
      // Another workspace's project stays unnamed.
      taken.workspace_id === who.workspaceId
        ? `${input.host}/${input.repository} already deploys the project ${taken.name}. Disconnect it there first.`
        : `${input.host}/${input.repository} already deploys a project in another workspace.`,
    );
  // A repository other than the one linked starts over: its GitLab ids are pinned again.
  await c.env.DB.prepare(
    'INSERT INTO git_sources(project_id,workspace_id,provider,host,repository,branch,user_id,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET remote_id=CASE WHEN provider=excluded.provider AND host=excluded.host AND lower(repository)=lower(excluded.repository) THEN remote_id END, owner_id=CASE WHEN provider=excluded.provider AND host=excluded.host AND lower(repository)=lower(excluded.repository) THEN owner_id END, provider=excluded.provider, host=excluded.host, repository=excluded.repository, branch=excluded.branch, user_id=excluded.user_id, created_at=excluded.created_at',
  )
    .bind(
      p.id,
      who.workspaceId,
      input.provider,
      input.host,
      input.repository,
      input.branch,
      who.userId,
      now(),
    )
    .run();
  const source = await c.env.DB.prepare(
    'SELECT * FROM git_sources WHERE project_id=?',
  )
    .bind(p.id)
    .first<Source>();
  return c.json(shown(source!));
});

gitSources.delete('/projects/:id/git-source', async (c) => {
  const { who, p } = await project(c, 'deploy');
  await c.env.DB.prepare(
    'DELETE FROM git_sources WHERE project_id=? AND workspace_id=?',
  )
    .bind(p.id, who.workspaceId)
    .run();
  return c.json({ removed: true });
});

// GitLab's ID token for a job (docs.gitlab.com/ci/secrets/id_token_authentication/).
const gitlabJob = z.object({
  iss: z.literal(GITLAB_ISSUER),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nbf: z.number().optional(),
  jti: z.string().min(1).max(200),
  project_id: z.string().regex(/^[1-9]\d{0,14}$/),
  project_path: repositoryPath,
  namespace_id: z.string().regex(/^[1-9]\d{0,14}$/),
  ref: z.string().max(300),
  ref_type: z.string().max(20),
  ref_protected: z.enum(['true', 'false']),
  pipeline_source: z.string().max(60),
  job_id: z.string().max(40),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
});
const refused = (why: string) =>
  new AppError(401, `Shipcel refused GitLab’s token for this job: ${why}.`);

// Unauthenticated: a GitLab.com job exchanges its ID token for one that deploys the linked
// project. Pushes and runs started by hand, of a branch; the production branch deploys to
// production when it is protected, any other branch a preview.
gitSourceToken.post('/git-sources/token', async (c) => {
  await limit(
    c.env,
    `git-source-token:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`,
    60,
  );
  const { token, project } = z
    .object({
      token: z.string().min(1).max(8000),
      // The project the repository's own CI file deploys (shipcel deploy --project).
      project: z.string().min(1).max(64),
    })
    .strict()
    .parse(await c.req.json());
  const claims = gitlabJob.safeParse(
    await signedClaims(token, GITLAB, refused),
  );
  if (!claims.success) throw refused('it doesn’t describe a GitLab CI job');
  const run = claims.data;
  await checkedToken(
    c.env,
    run,
    {
      audience: appOrigin(c.env, c.req.raw),
      lifetime: GITLAB_LIFETIME,
      signer: 'GitLab',
      once: `gitlab-job:${run.jti}`,
    },
    refused,
  );
  if (run.ref_type !== 'branch')
    throw new AppError(
      403,
      `Shipcel deploys branches, and this job is for the ${run.ref_type} ${run.ref}.`,
    );
  if (run.pipeline_source !== 'push' && run.pipeline_source !== 'web')
    throw new AppError(
      403,
      `Shipcel deploys pushes and pipelines started by hand, and this is a ${run.pipeline_source} pipeline.`,
    );
  const link = await c.env.DB.prepare(
    "SELECT g.*, p.name, m.role FROM git_sources g JOIN projects p ON p.id=g.project_id AND p.workspace_id=g.workspace_id LEFT JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id WHERE g.provider='gitlab' AND g.host='gitlab.com' AND lower(g.repository)=lower(?)",
  )
    .bind(run.project_path)
    .first<Source & { name: string; role: string | null }>();
  if (!link)
    throw new AppError(
      404,
      `gitlab.com/${run.project_path} isn’t linked to a project in this Shipcel. Link it with shipcel git connect in the repository’s folder.`,
    );
  // Only those who can change the repository choose where it deploys: a link someone else
  // made to the same path deploys nothing of it.
  if (link.project_id !== project)
    throw new AppError(
      403,
      `gitlab.com/${run.project_path} is linked to another project than the one this job deploys. Link it again from that project.`,
    );
  // The first job pins the GitLab project behind the path; a path that names another one later
  // (renamed, transferred, or taken by someone else) deploys nothing.
  if (
    (link.remote_id && link.remote_id !== run.project_id) ||
    (link.owner_id && link.owner_id !== run.namespace_id)
  )
    throw new AppError(
      403,
      `gitlab.com/${run.project_path} is another GitLab project than the one linked to ${link.name}. Link it again.`,
    );
  if (!link.remote_id)
    await c.env.DB.prepare(
      'UPDATE git_sources SET remote_id=?, owner_id=? WHERE project_id=? AND remote_id IS NULL',
    )
      .bind(run.project_id, run.namespace_id, link.project_id)
      .run();
  if (link.role !== 'owner' && link.role !== 'developer')
    throw new AppError(
      403,
      `The person who linked gitlab.com/${run.project_path} can no longer deploy in this workspace. Link it again.`,
    );
  const production = run.ref === link.branch && run.ref_protected === 'true';
  const created = await insertToken(
    c.env,
    { workspaceId: link.workspace_id, userId: link.user_id },
    `GitLab CI: ${run.project_path} job ${run.job_id}`.slice(0, 120),
    now() + RUN_TOKEN_SECONDS,
    { projectId: link.project_id, previewOnly: !production },
  );
  return c.json(
    {
      token: created.token,
      expiresAt: created.expiresAt,
      project: { id: link.project_id, name: link.name },
      repository: run.project_path,
      branch: run.ref,
      sha: run.sha,
      target: production ? 'production' : 'preview',
    },
    201,
  );
});
