import { Hono } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, requireIdentity } from './auth';
import { providerApp } from './provider-apps';
import { AppError, appOrigin, reachableFromGitHub, type AppEnv } from './types';
import { cloudflare, github, providerPath } from './providers';
import { workersSubdomain } from './health';

export const connections = new Hono<AppEnv>();
export const accountSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  name: z.string().max(200),
});
export const repoSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().regex(/^[\w.-]+$/),
  full_name: z.string().regex(/^[\w-]+\/[\w.-]+$/),
  default_branch: z.string().min(1).max(255),
  private: z.boolean(),
  archived: z.boolean().optional(),
  permissions: z
    .object({ push: z.boolean().optional(), admin: z.boolean().optional() })
    .optional(),
  owner: z.object({
    id: z.number().int().positive(),
    login: z.string().regex(/^[\w-]+$/),
    type: z.string().optional(),
  }),
});
export type Repository = z.infer<typeof repoSchema>;
export async function githubGrant(c: Parameters<typeof requireIdentity>[0]) {
  const who = requireIdentity(c);
  const grant = await activeGrant(c.env, who.workspaceId, 'github');
  if (!grant)
    throw new AppError(409, 'Sign in and connect the GitHub App first.');
  return { grant, token: await grantToken(c.env, grant) };
}
connections.get('/', async (c) => {
  const who = requireIdentity(c);
  const [gh, cf, githubApp, cloudflareApp] = await Promise.all([
    activeGrant(c.env, who.workspaceId, 'github'),
    activeGrant(c.env, who.workspaceId, 'cloudflare'),
    // A secret sealed with another key can't be read: it counts as not set up.
    providerApp(c.env, 'github').catch(() => null),
    providerApp(c.env, 'cloudflare').catch(() => null),
  ]);
  return c.json({
    github: {
      configured: Boolean(githubApp),
      connected: !!gh,
      installUrl:
        githubApp?.slug && /^[\w-]+$/.test(githubApp.slug)
          ? `https://github.com/apps/${githubApp.slug}/installations/new`
          : null,
    },
    cloudflare: {
      configured: Boolean(cloudflareApp),
      connected: !!cf,
      account: cf?.account_id
        ? { id: cf.account_id, name: cf.account_name }
        : null,
    },
    nativeBuildsEnabled: c.env.NATIVE_BUILDS_ENABLED === 'true',
    githubActions: reachableFromGitHub(appOrigin(c.env, c.req.raw)),
  });
});
connections.get('/github/installations', async (c) => {
  const { token } = await githubGrant(c);
  const data = await github<{ installations: unknown[]; total_count: number }>(
    token,
    '/user/installations?per_page=100',
  );
  const installations = z
    .array(
      z.object({
        id: z.number().int().positive(),
        account: z.object({ login: z.string() }),
      }),
    )
    .parse(data.installations);
  return c.json({ installations, total: data.total_count });
});
connections.get('/github/repositories', async (c) => {
  const installation = z.coerce
    .number()
    .int()
    .positive()
    .parse(c.req.query('installation'));
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(c.req.query('page') || '1');
  const { token } = await githubGrant(c);
  // This endpoint independently validates both the GitHub user's access and this App's installation.
  const data = await github<{ repositories: unknown[]; total_count: number }>(
    token,
    `/user/installations/${installation}/repositories?per_page=50&page=${page}`,
  );
  const repositories = z
    .array(repoSchema)
    .parse(data.repositories)
    .filter(
      (r) => !r.archived && (r.permissions?.push || r.permissions?.admin),
    );
  return c.json({
    repositories: repositories.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private,
    })),
    nextPage: page * 50 < data.total_count ? page + 1 : null,
  });
});
connections.get('/cloudflare/accounts', async (c) => {
  const who = requireIdentity(c, 'owner');
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant) throw new AppError(409, 'Connect Cloudflare first.');
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(c.req.query('page') || '1');
  const accounts = z
    .array(accountSchema)
    .parse(
      await cloudflare(
        await grantToken(c.env, grant),
        `/accounts?per_page=50&page=${page}`,
      ),
    );
  return c.json({
    accounts,
    nextPage: accounts.length === 50 ? page + 1 : null,
  });
});
connections.post('/cloudflare/account', async (c) => {
  const who = requireIdentity(c, 'owner');
  const { accountId } = z
    .object({ accountId: z.string().regex(/^[a-f0-9]{32}$/) })
    .strict()
    .parse(await c.req.json());
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant) throw new AppError(409, 'Connect Cloudflare first.');
  const inFlight = await c.env.DB.prepare(
    "SELECT id FROM deployment_jobs WHERE workspace_id=? AND status IN ('queued','provisioning','building') LIMIT 1",
  )
    .bind(who.workspaceId)
    .first();
  if (inFlight)
    throw new AppError(
      409,
      'Wait for the current deployment before changing accounts.',
    );
  const account = accountSchema.parse(
    await cloudflare(await grantToken(c.env, grant), `/accounts/${accountId}`),
  );
  if (account.id !== accountId)
    throw new AppError(403, 'The provider returned a different account.');
  await c.env.DB.prepare(
    "UPDATE provider_grants SET account_id=?,account_name=? WHERE id=? AND workspace_id=? AND status='active'",
  )
    .bind(account.id, account.name, grant.id, who.workspaceId)
    .run();
  return c.json({ account });
});
connections.get('/cloudflare/build-tokens', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  const tokens = z
    .array(
      z.object({ build_token_uuid: z.string(), build_token_name: z.string() }),
    )
    .parse(
      await cloudflare(
        await grantToken(c.env, grant),
        `/accounts/${grant.account_id}/builds/tokens`,
      ),
    );
  return c.json(
    tokens.map((t) => ({ id: t.build_token_uuid, name: t.build_token_name })),
  );
});
// Registers a build token for Workers Builds: a user API token the owner created (Workers
// Builds accepts only user tokens, and OAuth can't create one). Cloudflare checks the token and
// gives its ID; it goes to the Builds API with the owner's connection and is never stored.
const pasteAsShown = 'Paste the API token exactly as Cloudflare showed it.';
const buildTokenValue = z
  .string()
  .trim()
  .min(20, pasteAsShown)
  .max(200, pasteAsShown)
  .regex(/^[\w.-]+$/, pasteAsShown);
connections.post('/cloudflare/build-tokens', async (c) => {
  const who = requireIdentity(c, 'owner');
  if (c.env.NATIVE_BUILDS_ENABLED !== 'true')
    throw new AppError(
      503,
      'Cloud operations are disabled until provider setup is verified.',
    );
  const parsed = z
    .object({ token: buildTokenValue })
    .strict()
    .safeParse(await c.req.json());
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message);
  const { token } = parsed.data;
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  let verified: { id: string; status: string };
  try {
    verified = z
      .object({ id: z.string().min(1).max(100), status: z.string() })
      .parse(await cloudflare(token, '/user/tokens/verify'));
  } catch (error) {
    // Only a refusal is about the token; a rate limit or an outage says so itself.
    if (!(error instanceof AppError) || ![400, 401, 403].includes(error.status))
      throw error;
    throw new AppError(
      400,
      'Cloudflare didn’t accept this token. Paste a user API token from My Profile → API Tokens: Workers Builds doesn’t take account-owned tokens.',
    );
  }
  if (verified.status !== 'active')
    throw new AppError(400, `This token is ${verified.status}, not active.`);
  const created = z
    .object({
      build_token_uuid: z.string().uuid(),
      build_token_name: z.string(),
    })
    .parse(
      await cloudflare(
        await grantToken(c.env, grant),
        `/accounts/${grant.account_id}/builds/tokens`,
        {
          method: 'POST',
          body: JSON.stringify({
            build_token_name: 'Shipcel builds',
            build_token_secret: token,
            cloudflare_token_id: verified.id,
          }),
        },
        { errorDetail: true },
      ),
    );
  return c.json({
    id: created.build_token_uuid,
    name: created.build_token_name,
  });
});
// Whether Cloudflare's own GitHub app, which Workers Builds clones repositories with, can read
// them: asked through the Builds API's configuration autofill (GET …/builds/repos/github/
// {owner id}/{repository id}/config_autofill), which reads a repository with that app. For each
// GitHub account Shipcel's app is installed on, up to its first five repositories; or the
// repository a project deploys. Cloudflare links its app to the account through its dashboard
// (Workers & Pages → Create application → GitHub); which repositories it reads is set on GitHub.
const repositoryAccess = (owner: { login: string; type?: string }) =>
  owner.type === 'Organization'
    ? `https://github.com/organizations/${owner.login}/settings/installations`
    : 'https://github.com/settings/installations';
// Cloudflare answers 404 with code 12000 for a repository its app can't read; any other refusal
// is passed on with Cloudflare's own message.
async function cloudflareReads(
  token: string,
  accountId: string,
  repo: Repository,
) {
  try {
    await cloudflare(
      token,
      `/accounts/${accountId}/builds/repos/github/${repo.owner.id}/${repo.id}/config_autofill`,
      {},
      { errorDetail: true, missingCodes: [12000] },
    );
    return true;
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return false;
    throw error;
  }
}
const CHECKED_PER_ACCOUNT = 5;
connections.get('/cloudflare/github', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  const accountId: string = grant.account_id;
  const { token } = await githubGrant(c);
  const named = c.req.query('repository');
  let found: {
    account: { login: string; type?: string };
    repos: Repository[];
  }[];
  if (named !== undefined) {
    const [owner, name] = z
      .string()
      .regex(/^[\w-]+\/[\w.-]+$/)
      .parse(named)
      .split('/');
    const repo = repoSchema.parse(
      await github(
        token,
        `/repos/${providerPath(owner)}/${providerPath(name)}`,
      ),
    );
    found = [{ account: repo.owner, repos: [repo] }];
  } else {
    const installations = z
      .array(
        z.object({
          id: z.number().int().positive(),
          account: z.object({
            id: z.number().int().positive(),
            login: z.string().regex(/^[\w-]+$/),
            type: z.string().optional(),
          }),
        }),
      )
      .parse(
        (
          await github<{ installations: unknown }>(
            token,
            '/user/installations?per_page=100',
          )
        ).installations,
      )
      .slice(0, 5);
    found = await Promise.all(
      installations.map(async (i) => {
        const data = await github<{ repositories: unknown[] }>(
          token,
          `/user/installations/${i.id}/repositories?per_page=${CHECKED_PER_ACCOUNT}`,
        );
        return {
          account: i.account,
          repos: z.array(repoSchema).parse(data.repositories),
        };
      }),
    );
  }
  const cf = await grantToken(c.env, grant);
  return c.json({
    connectUrl: `https://dash.cloudflare.com/${accountId}/workers-and-pages/create`,
    accounts: await Promise.all(
      found.map(async ({ account, repos }) => {
        const checked = await Promise.all(
          repos.map(async (repo) => ({
            repository: repo.full_name,
            readable: await cloudflareReads(cf, accountId, repo),
          })),
        );
        return {
          login: account.login,
          repository: checked[0]?.repository ?? null,
          // Cloudflare's app is linked once it can read any of them; the list says which.
          readable: checked.length ? checked.some((r) => r.readable) : null,
          checked,
          repositoriesUrl: repositoryAccess(account),
        };
      }),
    ),
  });
});
// The selected account's workers.dev subdomain: apps are free at <app>.<subdomain>.workers.dev.
connections.get('/cloudflare/subdomain', async (c) => {
  const who = requireIdentity(c, 'deploy');
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  return c.json({
    subdomain: await workersSubdomain(
      await grantToken(c.env, grant),
      grant.account_id,
    ),
  });
});
// Registers a workers.dev subdomain for an account that has none. Never changes an existing
// one: that would move the address of every Worker in the account.
connections.post('/cloudflare/subdomain', async (c) => {
  const who = requireIdentity(c, 'owner');
  if (c.env.NATIVE_BUILDS_ENABLED !== 'true')
    throw new AppError(
      503,
      'Cloud operations are disabled until provider setup is verified.',
    );
  if (!who.sessionHash)
    throw new AppError(401, 'Sign in with GitHub to change your account.');
  const input = z
    .object({
      subdomain: z
        .string()
        .regex(
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
          'Use lowercase letters, numbers, and hyphens, starting and ending with a letter or number.',
        ),
      confirm: z.literal(true),
    })
    .strict()
    .parse(await c.req.json());
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  const token = await grantToken(c.env, grant);
  const current = await workersSubdomain(token, grant.account_id);
  if (current)
    throw new AppError(
      409,
      `This account already uses ${current}.workers.dev. Change it in Cloudflare if you must; every Worker's address moves with it.`,
    );
  const result = z
    .object({ subdomain: z.string().regex(/^[a-z0-9-]{1,63}$/) })
    .parse(
      await cloudflare(
        token,
        `/accounts/${grant.account_id}/workers/subdomain`,
        { method: 'PUT', body: JSON.stringify({ subdomain: input.subdomain }) },
        { errorDetail: true },
      ),
    );
  return c.json({ subdomain: result.subdomain });
});
connections.delete('/:provider', async (c) => {
  const who = requireIdentity(c, 'owner');
  const provider = z
    .enum(['github', 'cloudflare'])
    .parse(c.req.param('provider'));
  // Sever local access immediately, even if upstream revocation is unavailable.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE provider_grants SET status='disconnected', encrypted_tokens=NULL, revision=revision+1 WHERE workspace_id=? AND provider=? AND status IN ('active','reconnect_required')",
    ).bind(who.workspaceId, provider),
    c.env.DB.prepare(
      "UPDATE deployment_jobs SET status='needs_attention', error='Shipcel access was disconnected. Check Cloudflare for any operation already in progress.' WHERE workspace_id=? AND status IN ('queued','provisioning','building')",
    ).bind(who.workspaceId),
    c.env.DB.prepare(
      'DELETE FROM oauth_states WHERE workspace_id=? AND provider=?',
    ).bind(who.workspaceId, provider),
  ]);
  return c.json({
    ok: true,
    notice:
      'Shipcel credentials were removed. Running apps and native Cloudflare build triggers remain in your account. Revoke the app in the provider dashboard to remove its upstream grant.',
  });
});
