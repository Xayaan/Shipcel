import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, requireIdentity } from './auth';
import { cloudflare } from './providers';
import { AppError, now, type AppEnv, type Env } from './types';

// Postgres and MySQL through Hyperdrive. Cloudflare hosts neither; Hyperdrive pools and caches
// connections from Workers to a database elsewhere (free: 100,000 queries a day; Workers Paid:
// unlimited). A connection string becomes a Hyperdrive configuration in the customer's account,
// and its id a `hyperdrive` binding in the app's Wrangler configuration, which uploads from a
// computer may carry (worker/wrangler-policy.ts). The password goes to Cloudflare and nowhere
// else: Shipcel keeps the binding, the host and the database name.
export const hyperdrive = new Hono<AppEnv>();

const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;
type Config = {
  id: string;
  project_id: string;
  workspace_id: string;
  binding: string;
  scheme: string;
  host: string;
  database: string;
  created_at: number;
};
const shown = (r: Config) => ({
  id: r.id,
  binding: r.binding,
  scheme: r.scheme,
  host: r.host,
  database: r.database,
  createdAt: r.created_at,
  // What to add to wrangler.json(c), beside the other bindings.
  snippet: `"hyperdrive": [{ "binding": "${r.binding}", "id": "${r.id}" }]`,
});

// The configurations Shipcel made for a project, as created resources for the upload policy.
export async function hyperdriveCreated(env: Env, projectId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, binding FROM hyperdrive_configs WHERE project_id=?',
  )
    .bind(projectId)
    .all<{ id: string; binding: string }>();
  return results.map((r) => ({
    type: 'hyperdrive' as const,
    name: r.binding,
    id: r.id,
  }));
}

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
async function account(c: Context<AppEnv>, workspaceId: string) {
  const grant = await activeGrant(c.env, workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  // A sign-in made before Hyperdrive was asked for (shared/provider-setup.ts) can't make
  // configurations: say so, rather than pass on Cloudflare's 403.
  if (grant.scopes && !/hyperdrive/i.test(grant.scopes))
    throw new AppError(
      409,
      'This Cloudflare sign-in has no Hyperdrive permission. Update the Cloudflare sign-in in Connections (it adds Hyperdrive Write), then try again.',
    );
  return {
    token: await grantToken(c.env, grant),
    root: `/accounts/${grant.account_id}`,
  };
}

// A Postgres or MySQL address with everything Hyperdrive needs.
function origin(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new AppError(400, 'That isn’t a database address.');
  }
  const scheme = (
    {
      'postgres:': 'postgres',
      'postgresql:': 'postgres',
      'mysql:': 'mysql',
    } as const
  )[url.protocol as 'postgres:'];
  if (!scheme)
    throw new AppError(
      400,
      'Hyperdrive takes postgres:// (or postgresql://) and mysql:// addresses.',
    );
  const database = url.pathname.replace(/^\//, '');
  if (!url.hostname || !url.username || !url.password || !database)
    throw new AppError(
      400,
      'The address needs a user, a password, a host and a database name: postgres://user:password@host:5432/database.',
    );
  return {
    scheme,
    host: url.hostname,
    port: url.port ? Number(url.port) : scheme === 'postgres' ? 5432 : 3306,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

hyperdrive.get('/projects/:id/hyperdrive', async (c) => {
  const { p } = await project(c, 'view');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM hyperdrive_configs WHERE project_id=? ORDER BY created_at',
  )
    .bind(p.id)
    .all<Config>();
  return c.json({ configs: results.map(shown) });
});

hyperdrive.post('/projects/:id/hyperdrive', async (c) => {
  const { who, p } = await project(c, 'deploy');
  const input = z
    .object({
      binding: z.string().regex(BINDING),
      connectionString: z.string().min(1).max(2048),
      confirm: z.literal(true),
    })
    .strict()
    .parse(await c.req.json());
  const o = origin(input.connectionString);
  const taken = await c.env.DB.prepare(
    'SELECT id FROM hyperdrive_configs WHERE project_id=? AND binding=?',
  )
    .bind(p.id, input.binding)
    .first();
  if (taken)
    throw new AppError(
      409,
      `${input.binding} already names a database. Remove it first, or use another binding.`,
    );
  const { token, root } = await account(c, who.workspaceId);
  const made = z.object({ id: z.string().min(1).max(128) }).parse(
    await cloudflare(token, `${root}/hyperdrive/configs`, {
      method: 'POST',
      body: JSON.stringify({
        name: `${p.name}-${input.binding}`
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .slice(0, 60),
        origin: o,
      }),
    }),
  );
  const row: Config = {
    id: made.id,
    project_id: p.id,
    workspace_id: who.workspaceId,
    binding: input.binding,
    scheme: o.scheme,
    host: o.host,
    database: o.database,
    created_at: now(),
  };
  await c.env.DB.prepare(
    'INSERT INTO hyperdrive_configs(id,project_id,workspace_id,binding,scheme,host,database,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      row.id,
      row.project_id,
      row.workspace_id,
      row.binding,
      row.scheme,
      row.host,
      row.database,
      who.userId,
      row.created_at,
    )
    .run();
  return c.json(shown(row), 201);
});

hyperdrive.delete('/projects/:id/hyperdrive/:configId', async (c) => {
  const { who, p } = await project(c, 'deploy');
  const configId = z.string().min(1).max(128).parse(c.req.param('configId'));
  const row = await c.env.DB.prepare(
    'SELECT * FROM hyperdrive_configs WHERE id=? AND project_id=?',
  )
    .bind(configId, p.id)
    .first<Config>();
  if (!row) throw new AppError(404, 'No such database here.');
  const { token, root } = await account(c, who.workspaceId);
  await cloudflare(
    token,
    `${root}/hyperdrive/configs/${encodeURIComponent(configId)}`,
    { method: 'DELETE' },
  );
  await c.env.DB.prepare('DELETE FROM hyperdrive_configs WHERE id=?')
    .bind(configId)
    .run();
  return c.json({ removed: true, ...shown(row) });
});
