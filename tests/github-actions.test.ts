import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { database, projectInput } from './helpers/database';
import { cloudflareUploads } from './helpers/cloudflare-uploads';
import {
  actionsKey,
  jwks,
  jwksUrl,
  runToken,
  type ActionsKey,
} from './helpers/github-oidc';
import { assetHash, toBase64 } from '../shared/assets';
import { localShipcel, workflowFile } from '../worker/github-actions';
import app from '../worker/index';
import { previewOnlyRun, runTokenAllows } from '../worker/tokens';

// Deploys from GitHub Actions (worker/github-actions.ts, worker/github-oidc.ts). GitHub's OIDC
// tokens are made here, signed with a key of the test's own that the fake GitHub serves as its
// JWKS; GitHub's API and Cloudflare are fakes too. Fixture evidence, not a live run.
const origin = 'https://shipcel.test';
const contents =
  'https://api.github.com/repos/alice/landing/contents/.github/workflows/shipcel.yml';

let github: ActionsKey, stranger: ActionsKey, rotated: ActionsKey;
beforeAll(async () => {
  [github, stranger, rotated] = await Promise.all([
    actionsKey('key-1'),
    actionsKey('key-1'),
    actionsKey('key-2'),
  ]);
});
// A token as GitHub makes one for a push to main of alice/landing.
const oidc = (
  claims: Record<string, unknown> = {},
  options: { key?: ActionsKey; header?: Record<string, unknown> } = {},
) => runToken(options.key ?? github, origin, claims, options.header);

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let fx: ReturnType<typeof cloudflareUploads>;
// What the fake GitHub has and was sent.
let served: ActionsKey[];
let jwksFetches: number;
let repository: Record<string, unknown>;
let workflowPresent: boolean;
let commitStatus: number;
let commits: Record<string, unknown>[];
// Shipcel's app as installed where the person can see it, and the repositories one installation
// was given.
let installations: Record<string, unknown>[];
let chosenRepositories: Record<string, unknown>[];

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  fx = cloudflareUploads();
  served = [github];
  jwksFetches = 0;
  repository = {
    id: 501,
    name: 'landing',
    full_name: 'alice/landing',
    default_branch: 'main',
    private: true,
    permissions: { push: true },
    owner: { id: 42, login: 'alice' },
  };
  workflowPresent = false;
  commitStatus = 201;
  commits = [];
  installations = [
    {
      id: 7,
      account: { id: 42, login: 'alice', type: 'User' },
      repository_selection: 'all',
      html_url: 'https://github.com/settings/installations/7',
    },
  ];
  chosenRepositories = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (url === jwksUrl) {
        jwksFetches++;
        return jwks(served);
      }
      if (url === 'https://api.github.com/repos/alice/landing')
        return Response.json(repository);
      if (url === 'https://api.github.com/user/installations?per_page=100')
        return Response.json({
          total_count: installations.length,
          installations,
        });
      if (
        url ===
        'https://api.github.com/user/installations/7/repositories?per_page=100'
      )
        return Response.json({
          total_count: chosenRepositories.length,
          repositories: chosenRepositories,
        });
      if (url.startsWith(`${contents}?ref=`) && method === 'GET')
        return workflowPresent
          ? Response.json({ type: 'file', sha: 'f'.repeat(40) })
          : Response.json({ message: 'Not Found' }, { status: 404 });
      if (url === contents && method === 'PUT') {
        expect(new Headers(init.headers).get('Authorization')).toBe(
          'Bearer github-access-secret',
        );
        commits.push(JSON.parse(String(init.body)));
        return commitStatus === 201
          ? Response.json(
              {
                commit: {
                  sha: 'c'.repeat(40),
                  html_url: `https://github.com/alice/landing/commit/${'c'.repeat(40)}`,
                },
              },
              { status: 201 },
            )
          : Response.json(
              { message: 'Repository rule violations found' },
              { status: commitStatus },
            );
      }
      if (url.startsWith('https://api.cloudflare.com/'))
        return fx.handler(url, init);
      throw new Error(`Unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  vi.unstubAllGlobals();
});

const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = who.cookie,
) =>
  db.request(
    path,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    cookie,
  );
// A request with an API token, as the CLI makes one.
const withToken = (
  token: string,
  path: string,
  method = 'GET',
  body?: unknown,
) =>
  db.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function project(name = 'landing') {
  const response = await request('/projects', 'POST', {
    ...projectInput(name),
    framework: 'static',
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
const link = (id: string, body: Record<string, unknown> = {}) =>
  request(`/projects/${id}/github-actions`, 'POST', {
    repository: 'alice/landing',
    confirm: true,
    ...body,
  });
type Run = {
  token: string;
  project: { id: string; name: string };
  branch: string;
  target: string;
  error?: string;
};
async function exchange(token: string) {
  const response = await db.request('/github-actions/token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  return { status: response.status, body: (await response.json()) as Run };
}

// A site deployed with a run's token, as `shipcel deploy` does it.
const encode = (text: string) => new TextEncoder().encode(text);
async function deploySite(token: string, id: string, body: object) {
  const content = toBase64(encode('<h1>Hello</h1>'));
  const hash = assetHash(content, '/index.html');
  const created = await withToken(token, `/projects/${id}/uploads`, 'POST', {
    files: [{ path: '/index.html', hash, size: 14 }],
  });
  if (created.status !== 201) return created;
  const { uploadId } = (await created.json()) as { uploadId: string };
  await withToken(token, `/projects/${id}/uploads/${uploadId}/files`, 'POST', {
    files: [{ hash, content }],
  });
  return withToken(
    token,
    `/projects/${id}/uploads/${uploadId}/deploy`,
    'POST',
    {
      requestId: crypto.randomUUID(),
      confirm: true,
      ...body,
    },
  );
}

describe('linking a repository', () => {
  it('adds the workflow to its default branch and records the link', async () => {
    const id = await project();
    const response = await link(id);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      repository: 'alice/landing',
      branch: 'main',
      createdAt: expect.any(Number),
      linkedBy: 'user-1',
      actionsUrl: 'https://github.com/alice/landing/actions',
      workflowUrl:
        'https://github.com/alice/landing/blob/main/.github/workflows/shipcel.yml',
      workflow: 'added',
      commitUrl: `https://github.com/alice/landing/commit/${'c'.repeat(40)}`,
    });
    expect(commits).toHaveLength(1);
    const [commit] = commits as {
      message: string;
      branch: string;
      content: string;
      sha?: string;
    }[];
    expect(commit.message).toBe('Deploy with Shipcel');
    expect(commit.branch).toBe('main');
    expect(commit.sha).toBeUndefined();
    const workflow = Buffer.from(commit.content, 'base64').toString();
    expect(workflow).toBe(workflowFile(origin));
    // The run signs in with GitHub's token and deploys through this Shipcel's own CLI.
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('group: shipcel-${{ github.ref }}');
    expect(workflow).toContain(
      `npx --yes --package=${origin}/cli/shipcel.tgz shipcel deploy`,
    );
    expect(workflow).toContain(`SHIPCEL_URL: ${origin}`);
    const shown = await (
      await request(`/projects/${id}/github-actions`)
    ).json();
    expect(shown).toMatchObject({
      link: { repository: 'alice/landing', branch: 'main', linkedBy: 'user-1' },
      workflow: workflowFile(origin),
    });
    const listed = (await (await request('/projects')).json()) as {
      repository: string;
    }[];
    expect(listed[0].repository).toBe('https://github.com/alice/landing');
  });

  it('is refused on a Shipcel on someone’s own computer, which GitHub’s runners can’t reach', async () => {
    const id = await project();
    const local = 'http://127.0.0.1:5173';
    const env = { ...db.env, APP_ORIGIN: local };
    const headers = {
      'X-Shipcel-Request': '1',
      Cookie: `cloudcel_session=${who.raw}`,
      'Content-Type': 'application/json',
    };
    const connections = await app.request(
      `${local}/api/connections`,
      { headers },
      env,
    );
    expect(await connections.json()).toMatchObject({ githubActions: false });
    const refused = await app.request(
      `${local}/api/projects/${id}/github-actions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ repository: 'alice/landing', confirm: true }),
      },
      env,
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      localShipcel,
    );
    expect(commits).toEqual([]);
    expect(await (await request('/connections')).json()).toMatchObject({
      githubActions: true,
    });
  });

  it('keeps the link’s owner, branch and date when the same repository is connected again', async () => {
    const id = await project();
    expect((await link(id)).status).toBe(201);
    const before = db.sqlite
      .prepare(
        'SELECT user_id, branch, created_at FROM github_actions WHERE project_id=?',
      )
      .get(id) as { user_id: string; branch: string; created_at: number };
    // A teammate connects it again later, with GitHub's default branch renamed meanwhile: the
    // runs keep deploying as the person who linked it, to the branch they chose.
    const teammate = await db.user(2, 'developer');
    db.sqlite
      .prepare('INSERT INTO memberships VALUES (?,?,?)')
      .run(who.workspaceId, teammate.userId, 'developer');
    db.sqlite
      .prepare('UPDATE sessions SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, teammate.userId);
    repository = { ...repository, default_branch: 'trunk' };
    workflowPresent = true;
    const again = await request(
      `/projects/${id}/github-actions`,
      'POST',
      { repository: 'alice/landing', confirm: true },
      teammate.cookie,
    );
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({
      workflow: 'present',
      branch: 'main',
    });
    expect(
      db.sqlite
        .prepare(
          'SELECT user_id, branch, created_at FROM github_actions WHERE project_id=?',
        )
        .get(id),
    ).toEqual(before);
  });

  it('keeps a workflow the repository has already', async () => {
    workflowPresent = true;
    const response = await link(await project());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ workflow: 'present' });
    expect(commits).toEqual([]);
  });

  it('says why when GitHub refuses the commit, with GitHub’s page to add it by hand', async () => {
    const id = await project();
    commitStatus = 409;
    const protectedBranch = (await (await link(id)).json()) as {
      workflow: string;
      reason: string;
      addUrl: string;
    };
    expect(protectedBranch.workflow).toBe('refused');
    expect(protectedBranch.reason).toContain('protected branch');
    const add = new URL(protectedBranch.addUrl);
    expect(add.origin + add.pathname).toBe(
      'https://github.com/alice/landing/new/main',
    );
    expect(add.searchParams.get('filename')).toBe(
      '.github/workflows/shipcel.yml',
    );
    expect(add.searchParams.get('value')).toBe(workflowFile(origin));
    commitStatus = 403;
    const refused = (await (await link(id)).json()) as { reason: string };
    expect(refused.reason).toContain('Contents and Workflows');
    // Linked all the same: the workflow added by hand deploys.
    const shown = (await (
      await request(`/projects/${id}/github-actions`)
    ).json()) as {
      link: unknown;
    };
    expect(shown.link).not.toBeNull();
  });

  it('says when Shipcel’s app isn’t installed on the repository’s owner, or not for the repository', async () => {
    const id = await project();
    commitStatus = 404;
    // Installed only somewhere else the person can see, such as a repository they collaborate on.
    installations = [
      {
        id: 8,
        account: { id: 77, login: 'bob', type: 'User' },
        repository_selection: 'all',
        html_url: 'https://github.com/settings/installations/8',
      },
    ];
    expect(await (await link(id)).json()).toMatchObject({
      workflow: 'refused',
      reason:
        'Shipcel’s GitHub App isn’t installed on alice, so it can’t commit there. Install it on alice and connect again, or add the file by hand.',
      installUrl: 'https://github.com/apps/shipcel-test/installations/new',
    });
    installations = [
      {
        id: 7,
        account: { id: 42, login: 'alice', type: 'User' },
        repository_selection: 'selected',
        html_url: 'https://github.com/settings/installations/7',
      },
    ];
    chosenRepositories = [{ id: 502, full_name: 'alice/blog' }];
    expect(await (await link(id)).json()).toMatchObject({
      workflow: 'refused',
      reason:
        'Shipcel’s GitHub App is installed on alice, but not for landing. Add landing to it and connect again, or add the file by hand.',
      installUrl: 'https://github.com/settings/installations/7',
    });
    // The installation's page is a link in the dashboard and opened by the CLI: only GitHub's
    // own address is passed on.
    installations[0].html_url = 'javascript:alert(1)';
    const odd = (await (await link(id)).json()) as Record<string, unknown>;
    expect(odd.reason).toContain('but not for landing');
    expect(odd).not.toHaveProperty('installUrl');
    installations[0].html_url = 'https://github.com/settings/installations/7';
    // Given the repository, it is the app's permissions that are missing.
    chosenRepositories = [{ id: 501, full_name: 'alice/landing' }];
    const refused = (await (await link(id)).json()) as { reason: string };
    expect(refused.reason).toContain('Contents and Workflows');
    expect(refused).not.toHaveProperty('installUrl');
  });

  it('needs confirmation and write access, and one project per repository', async () => {
    const first = await project();
    expect((await link(first, { confirm: undefined })).status).toBe(400);
    repository = { ...repository, permissions: { push: false } };
    expect((await link(first)).status).toBe(403);
    repository = { ...repository, permissions: { push: true } };
    expect((await link(first)).status).toBe(201);
    const second = await project('landing-two');
    const taken = await link(second);
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toBe(
      'alice/landing deploys landing already. Disconnect it there first.',
    );
    // Viewers can't link.
    const viewer = await db.user(2, 'viewer');
    db.sqlite
      .prepare('INSERT INTO memberships VALUES (?,?,?)')
      .run(who.workspaceId, viewer.userId, 'viewer');
    db.sqlite
      .prepare('UPDATE sessions SET workspace_id=? WHERE user_id=?')
      .run(who.workspaceId, viewer.userId);
    expect(
      (
        await request(
          `/projects/${second}/github-actions`,
          'POST',
          { repository: 'alice/landing', confirm: true },
          viewer.cookie,
        )
      ).status,
    ).toBe(403);
  });

  it('leaves a project that Cloudflare builds from GitHub as it is', async () => {
    const id = await project();
    db.sqlite
      .prepare(
        "INSERT INTO deployment_jobs(id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,idempotency_key,created_at,updated_at,adapter,environment) VALUES ('job-1',?,?,?,'','','','1','alice/landing','main','','','landing','','deployed','finished','key-1',0,0,'static-assets','production')",
      )
      .run(who.workspaceId, id, who.userId);
    const response = await link(id);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      'Cloudflare builds landing from alice/landing. Create another project to deploy with GitHub Actions.',
    );
    expect(commits).toEqual([]);
  });

  it('stops deploying once disconnected, or once its project is deleted', async () => {
    const id = await project();
    await link(id);
    const run = await exchange(await oidc());
    expect(run.status).toBe(201);
    const removed = await request(`/projects/${id}/github-actions`, 'DELETE');
    expect(await removed.json()).toMatchObject({
      removed: true,
      workflowUrl:
        'https://github.com/alice/landing/blob/main/.github/workflows/shipcel.yml',
    });
    expect((await withToken(run.body.token, '/projects')).status).toBe(401);
    const unlinked = await exchange(await oidc());
    expect(unlinked.status).toBe(404);
    expect(unlinked.body.error).toBe(
      'alice/landing isn’t linked to a project in this Shipcel. Link it on the project’s Deployments page, or with shipcel git connect.',
    );
    await link(id);
    const again = await exchange(await oidc());
    expect((await request(`/projects/${id}`, 'DELETE')).status).toBe(200);
    expect((await withToken(again.body.token, '/projects')).status).toBe(401);
    expect(db.sqlite.prepare('SELECT * FROM github_actions').all()).toEqual([]);
    // The repository can deploy another project now.
    expect((await link(await project('landing-two'))).status).toBe(201);
  });
});

describe('a run signing in', () => {
  it('gets a token that deploys its project to production from the production branch, and nothing else', async () => {
    const id = await project();
    const other = await project('other');
    await link(id);
    const run = await exchange(await oidc());
    expect(run.status).toBe(201);
    expect(run.body).toEqual({
      token: expect.stringMatching(/^cc_pat_/),
      expiresAt: expect.any(Number),
      project: { id, name: 'landing' },
      repository: 'alice/landing',
      branch: 'main',
      sha: 'd'.repeat(40),
      target: 'production',
    });
    const token = run.body.token;
    // It sees its own project only.
    const projects = (await (await withToken(token, '/projects')).json()) as {
      id: string;
    }[];
    expect(projects.map((p) => p.id)).toEqual([id]);
    expect((await withToken(token, `/projects/${id}/deployments`)).status).toBe(
      200,
    );
    expect((await withToken(token, '/me')).status).toBe(200);
    for (const [path, method] of [
      [`/projects/${other}/deployments`, 'GET'],
      [`/projects/${other}/uploads`, 'POST'],
      [`/projects/${id}`, 'DELETE'],
      [`/projects/${id}/env`, 'GET'],
      [`/projects/${id}/github-actions`, 'GET'],
      ['/tokens', 'GET'],
      ['/activity', 'GET'],
    ])
      expect(
        (
          await withToken(
            token,
            path,
            method,
            method === 'GET' ? undefined : {},
          )
        ).status,
        path,
      ).toBe(403);
    // It deploys: the first deploy goes to production.
    const deployed = await deploySite(token, id, { publish: true });
    expect(deployed.status).toBe(200);
    expect(await deployed.json()).toMatchObject({
      result: {
        published: true,
        url: 'https://landing.test-account.workers.dev/',
      },
    });
    // The person's own token list doesn't show it.
    expect(await (await request('/tokens')).json()).toEqual([]);
  });

  it('deploys previews only from another branch', async () => {
    const id = await project();
    await link(id);
    const feature = await exchange(
      await oidc({ ref: 'refs/heads/feature/login', run_id: '7002' }),
    );
    expect(feature.body).toMatchObject({
      branch: 'feature/login',
      target: 'preview',
    });
    // Previews start after the first production deploy.
    const early = await deploySite(feature.body.token, id, { preview: true });
    expect(early.status).toBe(403);
    expect(((await early.json()) as { error: string }).error).toBe(
      previewOnlyRun,
    );
    // Refused before Cloudflare is asked anything: no upload session, no empty Worker.
    expect(
      fx.state.calls.some((c) => c.path.endsWith('/assets-upload-session')),
    ).toBe(false);
    const app = {
      'package.json': '{"name":"app"}',
      'wrangler.jsonc': JSON.stringify({
        name: 'landing',
        main: 'src/index.js',
        compatibility_date: '2026-10-07',
      }),
    };
    const plan = (await (
      await withToken(
        feature.body.token,
        `/projects/${id}/local-plan`,
        'POST',
        {
          files: app,
        },
      )
    ).json()) as { issues: string[] };
    expect(plan.issues).toContain(previewOnlyRun);
    const main = await exchange(await oidc());
    expect(
      (await deploySite(main.body.token, id, { publish: true })).status,
    ).toBe(200);
    // Now a preview deploys, and production can't be changed from the branch.
    const preview = await deploySite(feature.body.token, id, { preview: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      result: { preview: true, url: null },
    });
    expect(
      (await deploySite(feature.body.token, id, { publish: true })).status,
    ).toBe(403);
    expect((await deploySite(feature.body.token, id, {})).status).toBe(403);
    // An app Wrangler deploys can't go to production from the branch either.
    const toProduction = (await (
      await withToken(
        feature.body.token,
        `/projects/${id}/local-plan`,
        'POST',
        {
          files: app,
          production: true,
        },
      )
    ).json()) as { issues: string[] };
    expect(toProduction.issues).toContain(previewOnlyRun);
    const asPreview = (await (
      await withToken(
        feature.body.token,
        `/projects/${id}/local-plan`,
        'POST',
        {
          files: app,
        },
      )
    ).json()) as { issues: string[] };
    expect(asPreview.issues).not.toContain(previewOnlyRun);
  });

  it('checks GitHub’s signature, the issuer, this Shipcel as the audience and the times', async () => {
    await link(await project());
    const t = Math.floor(Date.now() / 1000);
    const cases: [string, string][] = [
      ['not-a-token', 'it isn’t a signed token'],
      [await oidc({}, { key: stranger }), 'GitHub’s signature doesn’t match'],
      [
        await oidc({}, { header: { alg: 'HS256' } }),
        'it isn’t signed the way GitHub signs',
      ],
      [
        await oidc({}, { header: { alg: 'none' } }),
        'it isn’t signed the way GitHub signs',
      ],
      [
        await oidc({}, { key: rotated }),
        'GitHub doesn’t list the key that signed it',
      ],
      [
        await oidc({ iss: 'https://evil.example' }),
        'it doesn’t describe a GitHub Actions run',
      ],
      [
        await oidc({ aud: 'https://github.com/alice' }),
        `it was made for another address than ${origin}`,
      ],
      [
        await oidc({ aud: [origin, 'https://other.example'] }),
        `it was made for another address than ${origin}`,
      ],
      [await oidc({ exp: t - 61 }), 'it expired'],
      [await oidc({ nbf: t + 120 }), 'it isn’t valid yet'],
      [await oidc({ iat: t + 120 }), 'it isn’t valid yet'],
      [
        await oidc({ exp: t + 7200 }),
        'it lasts longer than GitHub’s tokens do',
      ],
      [
        await oidc({ repository_id: 501 }),
        'it doesn’t describe a GitHub Actions run',
      ],
    ];
    for (const [token, why] of cases) {
      const run = await exchange(token);
      expect(run.status, why).toBe(401);
      expect(run.body.error).toBe(
        `Shipcel refused GitHub’s token for this run: ${why}.`,
      );
    }
    // Accepted once, and a copy of it after that is refused.
    const token = await oidc({ aud: [origin] });
    expect((await exchange(token)).status).toBe(201);
    const copy = await exchange(token);
    expect(copy.status).toBe(401);
    expect(copy.body.error).toBe(
      'Shipcel refused GitHub’s token for this run: it was used already.',
    );
  });

  it('deploys pushes and manual runs of a branch only', async () => {
    await link(await project());
    const tag = await exchange(
      await oidc({ ref: 'refs/tags/v1.0.0', ref_type: 'tag' }),
    );
    expect(tag.status).toBe(403);
    expect(tag.body.error).toBe(
      'Shipcel deploys branches, and this run is for refs/tags/v1.0.0.',
    );
    const pull = await exchange(
      await oidc({ event_name: 'pull_request_target' }),
    );
    expect(pull.status).toBe(403);
    expect(pull.body.error).toBe(
      'Shipcel deploys pushes and manual runs, and this is a pull_request_target run.',
    );
    expect(
      (await exchange(await oidc({ event_name: 'workflow_dispatch' }))).status,
    ).toBe(201);
  });

  it('is refused for a repository that moved, or when the person who linked it can’t deploy anymore', async () => {
    await link(await project());
    const moved = await exchange(await oidc({ repository_owner_id: '43' }));
    expect(moved.status).toBe(403);
    expect(moved.body.error).toBe(
      'alice/landing has moved to another owner since it was linked. Link it again.',
    );
    db.sqlite
      .prepare("UPDATE memberships SET role='viewer' WHERE user_id=?")
      .run(who.userId);
    const viewer = await exchange(await oidc());
    expect(viewer.status).toBe(403);
    expect(viewer.body.error).toBe(
      'The person who linked alice/landing can no longer deploy in this workspace. Link it again.',
    );
  });

  it('keeps GitHub’s keys for an hour, and fetches them again for a key it doesn’t know', async () => {
    await link(await project());
    vi.useFakeTimers({ toFake: ['Date'] });
    // Past the hour: the keys are fetched again.
    vi.setSystemTime(Date.now() + 3_600_001);
    const fetched = jwksFetches;
    expect((await exchange(await oidc())).status).toBe(201);
    expect((await exchange(await oidc())).status).toBe(201);
    expect(jwksFetches).toBe(fetched + 1);
    // GitHub adds a key. Within the minute it isn't asked again; after it, it is.
    served = [github, rotated];
    expect((await exchange(await oidc({}, { key: rotated }))).status).toBe(401);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await exchange(await oidc({}, { key: rotated }))).status).toBe(201);
    expect(jwksFetches).toBe(fetched + 2);
  });
});

describe('what a run’s token reaches', () => {
  const id = '10000000-0000-4000-8000-000000000001';
  const deploy = '20000000-0000-4000-8000-000000000002';
  it.each([
    ['GET', '/api/me', true],
    ['GET', '/api/connections', true],
    ['GET', '/api/connections/cloudflare/subdomain', true],
    ['GET', '/api/projects', true],
    ['GET', `/api/projects/${id}/deployments`, true],
    ['POST', '/api/local-plan', true],
    ['POST', `/api/projects/${id}/local-plan`, true],
    ['POST', `/api/projects/${id}/local-deploys`, true],
    ['POST', `/api/projects/${id}/local-deploys/${deploy}/finish`, true],
    ['POST', `/api/projects/${id}/uploads`, true],
    ['POST', `/api/projects/${id}/uploads/${deploy}/files`, true],
    ['POST', `/api/projects/${id}/uploads/${deploy}/deploy`, true],
    ['GET', '/api/me/workspaces', false],
    ['GET', '/api/connections/github/installations', false],
    ['POST', '/api/projects', false],
    ['GET', `/api/projects/${id}/uploads`, false],
    ['POST', `/api/projects/${id}/publish`, false],
    ['POST', `/api/projects/${id}/rollback`, false],
    ['POST', `/api/projects/${id}/github-actions`, false],
    ['POST', `/api/projects/${id}/uploads/${deploy}/files/extra`, false],
    ['POST', `/api/projects/${id}x/uploads`, false],
    ['DELETE', `/api/projects/${id}`, false],
    ['GET', `/api/projects/${deploy}/deployments`, false],
  ])('%s %s: %s', (method, path, allowed) => {
    expect(runTokenAllows(id, path, method)).toBe(allowed);
  });
});
