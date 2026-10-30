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
import {
  actionsKey,
  jwks,
  runToken,
  type ActionsKey,
} from './helpers/github-oidc';

// Repositories on GitLab, Bitbucket and Gitea that deploy a project from their own CI
// (worker/git-sources.ts). GitLab.com jobs sign in with GitLab's ID token, with the claims GitLab
// documents (docs.gitlab.com/ci/secrets/id_token_authentication/); the tokens here are the
// test's own, signed with its own key, served as GitLab's.
const origin = 'https://shipcel.test';
const GITLAB_KEYS = 'https://gitlab.com/oauth/discovery/keys';

let gitlab: ActionsKey, stranger: ActionsKey;
beforeAll(async () => {
  [gitlab, stranger] = await Promise.all([
    actionsKey('gl-1'),
    actionsKey('gl-1'),
  ]);
});
// A token as GitLab.com makes one for a push to main of ada/shop (project 9001, namespace 77).
const job = (claims: Record<string, unknown> = {}, key = gitlab) =>
  runToken(key, origin, {
    iss: 'https://gitlab.com',
    sub: 'project_path:ada/shop:ref_type:branch:ref:main',
    project_id: '9001',
    project_path: 'ada/shop',
    namespace_id: '77',
    namespace_path: 'ada',
    ref: 'main',
    ref_type: 'branch',
    ref_protected: 'true',
    pipeline_source: 'push',
    pipeline_id: '5001',
    job_id: '6001',
    sha: 'e'.repeat(40),
    user_id: '12',
    user_login: 'ada',
    // GitHub's claims, which the helper adds, aren't in GitLab's tokens.
    repository: undefined,
    repository_id: undefined,
    repository_owner_id: undefined,
    event_name: undefined,
    run_id: undefined,
    ...claims,
  });

let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      if (String(url) === GITLAB_KEYS) return jwks([gitlab]);
      throw new Error(`Unexpected fetch of ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

const request = (
  path: string,
  method = 'GET',
  body?: unknown,
  cookie: string | undefined = who.cookie,
) =>
  db.request(
    path,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    cookie,
  );
async function project(name = 'shop') {
  const response = await request('/projects', 'POST', {
    ...projectInput(name),
    framework: 'static',
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
// The project a job's CI file names: the one linked last.
let named = '';
const connect = (id: string, body: Record<string, unknown> = {}) => {
  named = id;
  return request(`/projects/${id}/git-source`, 'PUT', {
    provider: 'gitlab',
    host: 'gitlab.com',
    repository: 'ada/shop',
    branch: 'main',
    ...body,
  });
};
type Exchanged = {
  token: string;
  project: { id: string; name: string };
  repository: string;
  branch: string;
  target: string;
  error?: string;
};
async function exchange(token: string, project = named) {
  const response = await db.request('/git-sources/token', {
    method: 'POST',
    body: JSON.stringify({ token, project }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Exchanged,
  };
}
const bearer = (token: string, path: string, method = 'GET') =>
  db.request(path, { method, headers: { Authorization: `Bearer ${token}` } });

describe('repositories on other Git hosts', () => {
  it('links a GitLab, Bitbucket or Gitea repository, one source per project', async () => {
    const id = await project();
    const linked = await connect(id);
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({
      provider: 'gitlab',
      host: 'gitlab.com',
      repository: 'ada/shop',
      branch: 'main',
      signIn: 'id-token',
    });
    expect(
      await (await request(`/projects/${id}/git-source`)).json(),
    ).toMatchObject({ source: { repository: 'ada/shop', provider: 'gitlab' } });
    // Bitbucket, Gitea or Forgejo, and GitLab on another host, deploy with a deploy token.
    for (const [provider, host, repository] of [
      ['bitbucket', 'bitbucket.org', 'ada/shop'],
      ['gitea', 'codeberg.org', 'ada/shop'],
      ['gitlab', 'gitlab.example.com', 'team/sub/shop'],
    ]) {
      const changed = await connect(id, { provider, host, repository });
      expect([provider, changed.status]).toEqual([provider, 200]);
      expect(((await changed.json()) as { signIn: string }).signIn).toBe(
        'deploy-token',
      );
    }
    // What isn't a repository on a host is refused.
    for (const bad of [
      { host: 'https://gitlab.com' },
      { repository: 'shop' },
      { repository: '../x/y' },
      { branch: 'a..b' },
      { provider: 'svn' },
      { provider: 'bitbucket', host: 'example.com' },
    ])
      expect([bad, (await connect(id, bad)).status]).toEqual([bad, 400]);
    // Another project can't deploy the same repository.
    expect((await connect(id)).status).toBe(200);
    const other = await project('shop-two');
    const taken = await connect(other);
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain('the project shop');
    // Another workspace learns only that it's taken.
    const stranger = await db.user(2);
    const theirs = await db.request(
      '/projects',
      {
        method: 'POST',
        body: JSON.stringify({
          ...projectInput('theirs'),
          framework: 'static',
        }),
      },
      stranger.cookie,
    );
    const squat = await request(
      `/projects/${((await theirs.json()) as { id: string }).id}/git-source`,
      'PUT',
      {
        provider: 'gitlab',
        host: 'gitlab.com',
        repository: 'ada/shop',
        branch: 'main',
      },
      stranger.cookie,
    );
    expect(squat.status).toBe(409);
    expect(await squat.text()).toContain('a project in another workspace');
    // While it does, GitHub can't deploy the project too.
    const github = await request(`/projects/${id}/github-actions`, 'POST', {
      repository: 'ada/shop',
      confirm: true,
    });
    expect(github.status).toBe(409);
    expect(await github.text()).toContain('deploys from gitlab.com/ada/shop');
    // Unlinked, its jobs deploy nothing.
    expect((await request(`/projects/${id}/git-source`, 'DELETE')).status).toBe(
      200,
    );
    expect(await (await request(`/projects/${id}/git-source`)).json()).toEqual({
      source: null,
    });
    expect((await exchange(await job())).status).toBe(404);
    // A deleted project leaves no link behind, and the repository can deploy another.
    expect((await connect(id)).status).toBe(200);
    expect((await request(`/projects/${id}`, 'DELETE')).status).toBe(200);
    expect(
      db.sqlite.prepare('SELECT project_id FROM git_sources').all(),
    ).toEqual([]);
    expect((await connect(other)).status).toBe(200);
  });

  it('deploys a GitLab.com job’s branch: production from the protected default branch, previews from others', async () => {
    const id = await project();
    await connect(id);
    const main = await exchange(await job());
    expect(main.status).toBe(201);
    expect(main.body).toMatchObject({
      project: { id, name: 'shop' },
      repository: 'ada/shop',
      branch: 'main',
      target: 'production',
    });
    // Its token deploys this project, and nothing else.
    expect((await bearer(main.body.token, '/projects')).status).toBe(200);
    expect(
      (await bearer(main.body.token, `/projects/${id}/git-source`, 'DELETE'))
        .status,
    ).toBe(403);
    const feature = await exchange(
      await job({ ref: 'feature/cart', ref_protected: 'false' }),
    );
    expect(feature.body).toMatchObject({
      branch: 'feature/cart',
      target: 'preview',
    });
    // An unprotected default branch deploys a preview: anyone who can push could otherwise
    // replace production.
    expect(
      (await exchange(await job({ ref_protected: 'false' }))).body.target,
    ).toBe('preview');
  });

  it('pins the GitLab project of the first job, and refuses what isn’t a push to a branch of it', async () => {
    const id = await project();
    await connect(id);
    expect((await exchange(await job())).status).toBe(201);
    // The path belongs to another GitLab project now (renamed or transferred): refused.
    const moved = await exchange(await job({ project_id: '9002' }));
    expect(moved.status).toBe(403);
    expect(moved.body.error).toContain('Link it again');
    for (const [claims, status] of [
      [{ ref_type: 'tag', ref: 'v1.0' }, 403],
      [{ pipeline_source: 'merge_request_event' }, 403],
      [{ project_path: 'eve/shop', project_id: '9003' }, 404],
      [{ aud: 'https://elsewhere.test' }, 401],
      [{ iss: 'https://token.actions.githubusercontent.com' }, 401],
      [{ exp: Math.floor(Date.now() / 1000) - 600 }, 401],
    ] as const)
      expect([claims, (await exchange(await job(claims))).status]).toEqual([
        claims,
        status,
      ]);
    expect((await exchange(await job({}, stranger))).status).toBe(401);
    // A job deploys only the project its CI file names, so a link someone else made to the
    // same path gets nothing from it.
    const elsewhere = await exchange(await job(), 'another-project');
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error).toContain('another project');
    // Each token signs in once.
    const once = await job();
    expect((await exchange(once)).status).toBe(201);
    expect((await exchange(once)).status).toBe(401);
  });

  it('makes a project’s deploy token, approved in the browser, that deploys only that project', async () => {
    const id = await project();
    const started = await db.request('/cli/login', {
      method: 'POST',
      body: JSON.stringify({
        token: {
          name: 'Bitbucket: ada/shop',
          expiresInDays: 365,
          projectId: id,
        },
      }),
    });
    expect(started.status).toBe(201);
    const { code, deviceSecret } = (await started.json()) as {
      code: string;
      deviceSecret: string;
    };
    // The approval page says what approving makes, and for which project.
    expect(await (await request(`/cli/login/${code}`)).json()).toMatchObject({
      token: {
        name: 'Bitbucket: ada/shop',
        expiresInDays: 365,
        project: { id, name: 'shop' },
      },
    });
    expect((await request('/cli/login/approve', 'POST', { code })).status).toBe(
      200,
    );
    const polled = (await (
      await db.request('/cli/login/poll', {
        method: 'POST',
        body: JSON.stringify({ deviceSecret }),
      })
    ).json()) as { token: string };
    expect((await bearer(polled.token, '/projects')).status).toBe(200);
    expect((await bearer(polled.token, `/projects/${id}/budget`)).status).toBe(
      403,
    );
    // It is listed with its project, so it can be revoked.
    const tokens = (await (await request('/tokens')).json()) as {
      name: string;
      project?: string;
    }[];
    expect(tokens).toContainEqual(
      expect.objectContaining({ name: 'Bitbucket: ada/shop', project: 'shop' }),
    );
    // A project of another workspace can't be named.
    const intruder = await db.user(2);
    const foreign = await db.request('/cli/login', {
      method: 'POST',
      body: JSON.stringify({
        token: { name: 'x', expiresInDays: 30, projectId: id },
      }),
    });
    const other = (await foreign.json()) as { code: string };
    expect(
      (
        await db.request(
          '/cli/login/approve',
          { method: 'POST', body: JSON.stringify({ code: other.code }) },
          intruder.cookie,
        )
      ).status,
    ).toBe(404);
  });
});
