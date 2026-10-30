// A fake GitHub and Cloudflare for deploying a repository from GitHub: the repository and its
// files, whether Shipcel's and Cloudflare's GitHub apps can read it, build tokens, and the
// Workers Builds steps of the pipeline. It records what it was asked to create.

export const account = 'a'.repeat(32);
export const commit = 'b'.repeat(40);
export const buildToken = {
  build_token_uuid: '10000000-0000-4000-8000-000000000001',
  build_token_name: 'Shipcel builds',
};

export function gitProviders() {
  const state = {
    repo: {
      id: 50,
      name: 'site',
      full_name: 'ada/site',
      default_branch: 'main',
      private: false,
      archived: false,
      permissions: { push: true },
      owner: { id: 7, login: 'ada', type: 'User' },
    },
    // The repository's root files at its head commit.
    files: {
      'package.json': JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^8.0.0' },
      }),
      'package-lock.json': '{}',
    } as Record<string, string>,
    // Shipcel's own GitHub app is installed on the repository.
    installed: true,
    // Its installations the person can see (GitHub's /user/installations).
    installations: [
      {
        id: 3,
        account: { id: 7, login: 'ada', type: 'User' },
        repository_selection: 'all',
        html_url: 'https://github.com/settings/installations/3',
      },
    ] as Record<string, unknown>[],
    // Cloudflare's GitHub app can read it (the Builds API's configuration autofill).
    cloudflareReads: true,
    tokens: [buildToken],
    subdomain: 'test-account' as string | null,
    // Cloudflare's reason for refusing to connect the repository, when it does.
    refusal: '',
    outcome: 'success',
    workers: new Map<string, string>(),
    triggers: [] as Record<string, unknown>[],
    builds: [] as Record<string, unknown>[],
    calls: [] as { method: string; url: string }[],
    // Files Shipcel committed through GitHub's Contents API (the GitHub Actions workflow), and
    // GitHub's answer to a commit: 201, or a refusal such as 409 for a protected branch.
    commits: [] as { path: string; message: string; branch: string }[],
    commitStatus: 201,
  };
  const cf = (result: unknown) => Response.json({ success: true, result });
  const missing = (code: number, message: string) =>
    Response.json(
      { success: false, errors: [{ code, message }] },
      { status: 404 },
    );
  const handler = async (
    raw: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(raw));
    const method = init.method || 'GET';
    state.calls.push({ method, url: url.href });
    const { repo } = state;
    if (url.origin === 'https://api.github.com') {
      if (url.pathname === '/user/installations')
        return Response.json({
          total_count: state.installations.length,
          installations: state.installations,
        });
      const base = `/repos/${repo.full_name}`;
      if (!state.installed || !url.pathname.startsWith(base))
        return Response.json({ message: 'Not Found' }, { status: 404 });
      const rest = url.pathname.slice(base.length);
      if (rest === '') return Response.json(repo);
      if (rest === `/commits/${repo.default_branch}`)
        return Response.json({ sha: commit });
      const file = rest.match(/^\/contents\/(.+)$/)?.[1];
      if (file !== undefined && method === 'PUT') {
        if (state.commitStatus !== 201)
          return Response.json(
            { message: 'Repository rule violations found' },
            { status: state.commitStatus },
          );
        const body = JSON.parse(String(init.body)) as {
          message: string;
          branch: string;
          content: string;
        };
        state.files[file] = Buffer.from(body.content, 'base64').toString();
        state.commits.push({
          path: file,
          message: body.message,
          branch: body.branch,
        });
        return Response.json(
          {
            commit: {
              sha: 'c'.repeat(40),
              html_url: `https://github.com/${repo.full_name}/commit/${'c'.repeat(40)}`,
            },
          },
          { status: 201 },
        );
      }
      const source = file === undefined ? undefined : state.files[file];
      if (source === undefined)
        return Response.json({ message: 'Not Found' }, { status: 404 });
      return Response.json({
        type: 'file',
        encoding: 'base64',
        size: source.length,
        content: btoa(source),
      });
    }
    // The deployed app's homepage, for the health check.
    if (url.hostname.endsWith('.workers.dev')) return new Response('ok');
    const path = url.pathname.replace(`/client/v4/accounts/${account}`, '');
    if (url.origin !== 'https://api.cloudflare.com' || path === url.pathname)
      throw new Error(`Unexpected provider URL ${url.href}`);
    if (
      path ===
      `/builds/repos/github/${repo.owner.id}/${repo.id}/config_autofill`
    )
      return state.cloudflareReads
        ? cf({ build_command: 'npm run build' })
        : missing(12000, 'Not found');
    if (path === '/builds/tokens') return cf(state.tokens);
    if (path === '/workers/subdomain')
      return state.subdomain
        ? cf({ subdomain: state.subdomain })
        : missing(10007, 'There is not a workers.dev subdomain');
    if (path === '/workers/scripts' && method === 'GET')
      return cf([...state.workers.keys()].map((id) => ({ id })));
    const script = path.match(/^\/workers\/scripts\/([a-z0-9-]+)$/)?.[1];
    if (script && method === 'PUT') {
      state.workers.set(script, 'c'.repeat(32));
      return cf({ tag: 'c'.repeat(32) });
    }
    if (path === '/builds/repos/connections' && method === 'PUT')
      return state.refusal
        ? Response.json(
            { success: false, errors: [{ message: state.refusal }] },
            { status: 400 },
          )
        : cf({ repo_connection_uuid: '20000000-0000-4000-8000-000000000002' });
    if (path === '/builds/triggers' && method === 'POST') {
      state.triggers.push(JSON.parse(String(init.body)));
      return cf({ trigger_uuid: '30000000-0000-4000-8000-000000000003' });
    }
    if (/^\/builds\/triggers\/[0-9a-f-]+\/environment_variables$/.test(path))
      return cf({});
    if (/^\/builds\/triggers\/[0-9a-f-]+\/builds$/.test(path)) {
      state.builds.push(JSON.parse(String(init.body)));
      return cf({ build_uuid: '40000000-0000-4000-8000-000000000004' });
    }
    if (/^\/builds\/builds\/[0-9a-f-]+$/.test(path))
      return cf({ build_outcome: state.outcome });
    if (/^\/workers\/scripts\/[a-z0-9-]+\/settings$/.test(path))
      return cf({ bindings: [] });
    throw new Error(`Unexpected provider request ${method} ${url.href}`);
  };
  return { state, handler };
}
