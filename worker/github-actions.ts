import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { limit, requireIdentity } from './auth';
import { githubGrant, repoSchema, type Repository } from './connections';
import { verifyActionsToken } from './github-oidc';
import { providerApp } from './provider-apps';
import { github, providerPath } from './providers';
import { insertToken } from './tokens';
import {
  AppError,
  appOrigin,
  now,
  reachableFromGitHub,
  type AppEnv,
} from './types';

// Deploys from GitHub with GitHub Actions. Shipcel adds a workflow to the repository that builds
// every push on GitHub and deploys it with the shipcel CLI. The run signs in with GitHub's own
// OIDC token, exchanged here for a token that deploys the linked project for an hour: the
// repository holds no secret, and nothing is set up in Cloudflare.
export const WORKFLOW_PATH = '.github/workflows/shipcel.yml';
const RUN_TOKEN_SECONDS = 3600;
const fullName = z.string().regex(/^[\w-]+\/[\w.-]+$/);
export const localShipcel =
  'GitHub Actions can’t reach a Shipcel on your own computer. Deploy from GitHub with Cloudflare’s own builds instead (shipcel git connect --cloudflare-builds), or from your computer with shipcel deploy.';

// Every branch builds: which one deploys to production is decided when the run signs in. One run
// at a time per branch. Node 24 comes with npm 11, which installs apps npm 10 can't.
export function workflowFile(origin: string) {
  return `# Deploys this repository with Shipcel (${origin}): every push builds here, on GitHub,
# and deploys to your Cloudflare account. The production branch goes to production; other
# branches get a preview. The run signs in with GitHub's own token: no secret is stored.
name: Shipcel
on:
  push:
    branches: ['**']
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
concurrency:
  group: shipcel-\${{ github.ref }}
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          package-manager-cache: false
      - run: npx --yes --package=${origin}/cli/shipcel.tgz shipcel deploy
        env:
          SHIPCEL_URL: ${origin}
`;
}

type Link = {
  project_id: string;
  workspace_id: string;
  repository_id: number;
  owner_id: number;
  repository: string;
  branch: string;
  user_id: string;
  created_at: number;
};
// A branch in a GitHub address, each part encoded (a branch name may hold # or %).
const branchPath = (branch: string) =>
  branch.split('/').map(encodeURIComponent).join('/');
const shown = (link: Link, linkedBy: string | null) => ({
  repository: link.repository,
  branch: link.branch,
  createdAt: link.created_at,
  linkedBy,
  actionsUrl: `https://github.com/${link.repository}/actions`,
  workflowUrl: `https://github.com/${link.repository}/blob/${branchPath(link.branch)}/${WORKFLOW_PATH}`,
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

// Why GitHub refused Shipcel's commit with a 403 or 404, from the installations the person's
// token can see: Shipcel's app isn't installed on the repository's owner (seeing one elsewhere,
// such as on a repository they collaborate on, signs them in all the same), or it is but wasn't
// given this repository. Null when neither, or GitHub can't say: then it is the app's permissions.
const installationsSchema = z.object({
  installations: z.array(
    z.object({
      id: z.number().int().positive(),
      account: z.object({ id: z.number().int().positive() }),
      repository_selection: z.string(),
      html_url: z.string().url(),
    }),
  ),
});
async function notInstalled(
  token: string,
  repo: Repository,
  slug: string | null | undefined,
): Promise<{ reason: string; installUrl?: string } | null> {
  const owner = repo.owner.login;
  try {
    const { installations } = installationsSchema.parse(
      await github(token, '/user/installations?per_page=100'),
    );
    const installed = installations.find((i) => i.account.id === repo.owner.id);
    if (!installed)
      return {
        reason: `Shipcel’s GitHub App isn’t installed on ${owner}, so it can’t commit there. Install it on ${owner} and connect again, or add the file by hand.`,
        ...(slug && /^[\w-]+$/.test(slug)
          ? { installUrl: `https://github.com/apps/${slug}/installations/new` }
          : {}),
      };
    if (installed.repository_selection !== 'selected') return null;
    const chosen = z
      .object({
        total_count: z.number(),
        repositories: z.array(z.object({ id: z.number() })),
      })
      .parse(
        await github(
          token,
          `/user/installations/${installed.id}/repositories?per_page=100`,
        ),
      );
    if (
      chosen.repositories.some((r) => r.id === repo.id) ||
      chosen.total_count > chosen.repositories.length
    )
      return null;
    return {
      reason: `Shipcel’s GitHub App is installed on ${owner}, but not for ${repo.name}. Add ${repo.name} to it and connect again, or add the file by hand.`,
      // The dashboard renders it as a link and the CLI opens it: GitHub's own address only.
      ...(installed.html_url.startsWith('https://github.com/')
        ? { installUrl: installed.html_url }
        : {}),
    };
  } catch (error) {
    if (error instanceof AppError || error instanceof z.ZodError) return null;
    throw error;
  }
}

// The workflow on the repository's default branch. One already there is kept, whoever wrote it.
// When GitHub refuses (a protected branch, Shipcel's app not installed for the repository, or
// without permission for workflows), the answer says why, with GitHub's new-file page filled in
// to add it by hand, and the page that installs the app when that is what's missing.
type Added =
  | { workflow: 'added'; commitUrl: string }
  | { workflow: 'present' }
  | {
      workflow: 'refused';
      reason: string;
      addUrl: string;
      installUrl?: string;
    };
async function addWorkflow(
  token: string,
  repo: Repository,
  text: string,
  slug: string | null | undefined,
): Promise<Added> {
  const path = `/repos/${repo.full_name}/contents/${WORKFLOW_PATH}`;
  const present = await github<unknown>(
    token,
    `${path}?ref=${providerPath(repo.default_branch)}`,
  ).then(
    () => true,
    (error: unknown) => {
      if (error instanceof AppError && error.status === 404) return false;
      throw error;
    },
  );
  if (present) return { workflow: 'present' };
  try {
    const result = z
      .object({ commit: z.object({ html_url: z.string().url() }) })
      .parse(
        await github(token, path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Deploy with Shipcel',
            content: btoa(
              String.fromCharCode(...new TextEncoder().encode(text)),
            ),
            branch: repo.default_branch,
          }),
        }),
      );
    return { workflow: 'added', commitUrl: result.commit.html_url };
  } catch (error) {
    if (!(error instanceof AppError) || ![403, 404, 502].includes(error.status))
      throw error;
    const missing =
      error.status === 502 ? null : await notInstalled(token, repo, slug);
    return {
      workflow: 'refused',
      reason:
        error.status === 502
          ? `GitHub didn’t accept a commit to ${repo.default_branch}. A protected branch takes changes through pull requests only.`
          : (missing?.reason ??
            'GitHub didn’t let Shipcel add the workflow: Shipcel’s GitHub App needs read and write access to Contents and Workflows.'),
      addUrl: `https://github.com/${repo.full_name}/new/${branchPath(repo.default_branch)}?filename=${encodeURIComponent(WORKFLOW_PATH)}&value=${encodeURIComponent(text)}`,
      ...(missing?.installUrl ? { installUrl: missing.installUrl } : {}),
    };
  }
}

export const githubActions = new Hono<AppEnv>();

githubActions.get('/projects/:id/github-actions', async (c) => {
  const { who, p } = await project(c, 'view');
  const link = await c.env.DB.prepare(
    'SELECT g.*, u.login AS linkedBy FROM github_actions g LEFT JOIN users u ON u.id=g.user_id WHERE g.project_id=? AND g.workspace_id=?',
  )
    .bind(p.id, who.workspaceId)
    .first<Link & { linkedBy: string | null }>();
  return c.json({
    link: link ? shown(link, link.linkedBy) : null,
    // What Shipcel adds to the repository, shown before it does.
    workflow: workflowFile(appOrigin(c.env, c.req.raw)),
  });
});

githubActions.post('/projects/:id/github-actions', async (c) => {
  const { who, p } = await project(c, 'deploy');
  const { repository } = z
    .object({ repository: fullName, confirm: z.literal(true) })
    .strict()
    .parse(await c.req.json());
  // A project deploys one way: a repository on another Git host keeps it (worker/git-sources.ts).
  const elsewhere = await c.env.DB.prepare(
    'SELECT host, repository FROM git_sources WHERE project_id=?',
  )
    .bind(p.id)
    .first<{ host: string; repository: string }>();
  if (elsewhere)
    throw new AppError(
      409,
      `${p.name} deploys from ${elsewhere.host}/${elsewhere.repository}. Disconnect it there first, or give this repository a project of its own.`,
    );
  const origin = appOrigin(c.env, c.req.raw);
  if (!reachableFromGitHub(origin)) throw new AppError(409, localShipcel);
  // A project deploys one way: one Cloudflare builds from GitHub keeps that.
  const job = await c.env.DB.prepare(
    "SELECT adapter, repository_name FROM deployment_jobs WHERE project_id=? AND environment='production' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(p.id)
    .first<{ adapter: string; repository_name: string }>();
  if (job && job.adapter !== 'direct-upload')
    throw new AppError(
      409,
      `Cloudflare builds ${p.name} from ${job.repository_name}. Create another project to deploy with GitHub Actions.`,
    );
  const { token } = await githubGrant(c);
  const repo = repoSchema.parse(await github(token, `/repos/${repository}`));
  if (!repo.permissions?.push && !repo.permissions?.admin)
    throw new AppError(403, 'You need write access to deploy this repository.');
  if (repo.archived)
    throw new AppError(409, 'Archived repositories cannot be deployed.');
  const taken = await c.env.DB.prepare(
    'SELECT g.project_id, g.workspace_id, p.name FROM github_actions g JOIN projects p ON p.id=g.project_id WHERE g.repository_id=?',
  )
    .bind(repo.id)
    .first<{ project_id: string; workspace_id: string; name: string }>();
  if (taken && taken.project_id !== p.id)
    throw new AppError(
      409,
      taken.workspace_id === who.workspaceId
        ? `${repo.full_name} deploys ${taken.name} already. Disconnect it there first.`
        : `${repo.full_name} deploys a project in another Shipcel workspace already. Disconnect it there first.`,
    );
  const added = await addWorkflow(
    token,
    repo,
    workflowFile(origin),
    (await providerApp(c.env, 'github').catch(() => null))?.slug,
  );
  // Connected again with the same repository, the link stays as it was made: its runs keep
  // deploying as the person who linked it, to the branch they chose.
  const kept = await c.env.DB.prepare(
    'SELECT g.*, u.login AS linkedBy FROM github_actions g LEFT JOIN users u ON u.id=g.user_id WHERE g.project_id=? AND g.repository_id=?',
  )
    .bind(p.id, repo.id)
    .first<Link & { linkedBy: string | null }>();
  if (kept) return c.json({ ...shown(kept, kept.linkedBy), ...added }, 201);
  const link: Link = {
    project_id: p.id,
    workspace_id: who.workspaceId,
    repository_id: repo.id,
    owner_id: repo.owner.id,
    repository: repo.full_name,
    branch: repo.default_branch,
    user_id: who.userId,
    created_at: now(),
  };
  try {
    await c.env.DB.batch([
      // A link left by a project deleted before links were removed with it.
      c.env.DB.prepare(
        'DELETE FROM github_actions WHERE repository_id=? AND project_id NOT IN (SELECT id FROM projects)',
      ).bind(link.repository_id),
      c.env.DB.prepare(
        'INSERT INTO github_actions(project_id,workspace_id,repository_id,owner_id,repository,branch,user_id,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET repository_id=excluded.repository_id, owner_id=excluded.owner_id, repository=excluded.repository, branch=excluded.branch, user_id=excluded.user_id, created_at=excluded.created_at',
      ).bind(
        link.project_id,
        link.workspace_id,
        link.repository_id,
        link.owner_id,
        link.repository,
        link.branch,
        link.user_id,
        link.created_at,
      ),
      c.env.DB.prepare(
        'UPDATE projects SET repository=? WHERE id=? AND workspace_id=?',
      ).bind(`https://github.com/${repo.full_name}`, p.id, who.workspaceId),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: github_actions\.repository_id/.test(
        error.message,
      )
    )
      throw new AppError(
        409,
        `${repo.full_name} was just linked to another project.`,
      );
    throw error;
  }
  return c.json({ ...shown(link, who.login), ...added }, 201);
});

// The workflow stays in the repository (Shipcel changes nothing there); its runs stop deploying.
githubActions.delete('/projects/:id/github-actions', async (c) => {
  const { who, p } = await project(c, 'deploy');
  const link = await c.env.DB.prepare(
    'SELECT * FROM github_actions WHERE project_id=? AND workspace_id=?',
  )
    .bind(p.id, who.workspaceId)
    .first<Link>();
  if (!link)
    throw new AppError(404, 'This project doesn’t deploy from GitHub Actions.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM github_actions WHERE project_id=?').bind(
      p.id,
    ),
    c.env.DB.prepare(
      'UPDATE api_tokens SET revoked_at=? WHERE project_id=? AND revoked_at IS NULL',
    ).bind(now(), p.id),
  ]);
  return c.json({ removed: true, ...shown(link, null) });
});

// Unauthenticated: a run of the workflow exchanges GitHub's token for one that deploys the
// linked project. Pushes and manual runs of a branch only; the production branch deploys to
// production, other branches a preview.
export const actionsToken = new Hono<AppEnv>();

actionsToken.post('/github-actions/token', async (c) => {
  await limit(
    c.env,
    `actions-token:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`,
    60,
  );
  const { token } = z
    .object({ token: z.string().min(1).max(8000) })
    .strict()
    .parse(await c.req.json());
  const run = await verifyActionsToken(
    c.env,
    token,
    appOrigin(c.env, c.req.raw),
  );
  if (run.ref_type !== 'branch' || !run.ref.startsWith('refs/heads/'))
    throw new AppError(
      403,
      `Shipcel deploys branches, and this run is for ${run.ref}.`,
    );
  if (run.event_name !== 'push' && run.event_name !== 'workflow_dispatch')
    throw new AppError(
      403,
      `Shipcel deploys pushes and manual runs, and this is a ${run.event_name} run.`,
    );
  const link = await c.env.DB.prepare(
    'SELECT g.*, p.name, m.role FROM github_actions g JOIN projects p ON p.id=g.project_id AND p.workspace_id=g.workspace_id LEFT JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id WHERE g.repository_id=?',
  )
    .bind(Number(run.repository_id))
    .first<Link & { name: string; role: string | null }>();
  if (!link)
    throw new AppError(
      404,
      `${run.repository} isn’t linked to a project in this Shipcel. Link it on the project’s Deployments page, or with shipcel git connect.`,
    );
  if (String(link.owner_id) !== run.repository_owner_id)
    throw new AppError(
      403,
      `${run.repository} has moved to another owner since it was linked. Link it again.`,
    );
  if (link.role !== 'owner' && link.role !== 'developer')
    throw new AppError(
      403,
      `The person who linked ${run.repository} can no longer deploy in this workspace. Link it again.`,
    );
  const branch = run.ref.slice('refs/heads/'.length);
  const production = branch === link.branch;
  // Earlier runs' tokens, expired a day ago or more.
  await c.env.DB.prepare(
    'DELETE FROM api_tokens WHERE project_id IS NOT NULL AND expires_at<?',
  )
    .bind(now() - 86400)
    .run();
  const created = await insertToken(
    c.env,
    { workspaceId: link.workspace_id, userId: link.user_id },
    `GitHub Actions: ${run.repository} run ${run.run_id}`.slice(0, 120),
    now() + RUN_TOKEN_SECONDS,
    { projectId: link.project_id, previewOnly: !production },
  );
  return c.json(
    {
      token: created.token,
      expiresAt: created.expiresAt,
      project: { id: link.project_id, name: link.name },
      repository: run.repository,
      branch,
      sha: run.sha,
      target: production ? 'production' : 'preview',
    },
    201,
  );
});
