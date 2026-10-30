// A Hono API that reads a Postgres database hosted anywhere, through Hyperdrive.
import { HONO, runWorker, workerScripts } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'postgres',
  name: 'Postgres API',
  subtitle: 'Hono + Postgres through Hyperdrive',
  runtime: 'Workers + Hyperdrive',
  family: 'JavaScript',
  symbol: 'Pg',
  color: 'blue',
  description:
    'A typed API on Workers that talks to a Postgres database hosted anywhere (Neon, Supabase, your own server) through Cloudflare Hyperdrive, which pools and caches its connections. Add the database to the project, put its id in the configuration, deploy.',
  docs: 'https://developers.cloudflare.com/hyperdrive/',
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  scripts: workerScripts,
  dependencies: { hono: HONO, postgres: '3.4.9' },
  // The Postgres kit binds a Hyperdrive configuration: the project's, or a placeholder the
  // deploy check refuses. Wrangler's local runtime needs its own database to point at.
  config: (project, extras) => ({
    main: 'src/worker.js',
    compatibility_flags: ['nodejs_compat'],
    hyperdrive: [
      {
        binding: 'DB',
        id:
          extras.hyperdrive?.find((h) => h.binding === 'DB')?.id ??
          'HYPERDRIVE_ID',
        localConnectionString:
          'postgres://postgres:postgres@127.0.0.1:5432/postgres',
      },
    ],
  }),
  files: (project) => {
    const files: Record<string, string> = {};
    files['src/worker.js'] = `import { Hono } from 'hono';
import postgres from 'postgres';
const app = new Hono();
app.get('/api/health', c => c.json({ ok: true, app: '${project.name}' }));
// DB is the Hyperdrive binding: a pooled, cached connection to your Postgres. One client per
// request is fine; the pool lives in Hyperdrive.
app.get('/api/now', async c => {
  const sql = postgres(c.env.DB.connectionString, { max: 5, fetch_types: false, prepare: false });
  try {
    const [row] = await sql\`SELECT now() AS now\`;
    return c.json(row);
  } finally {
    c.executionCtx.waitUntil(sql.end({ timeout: 5 }));
  }
});
app.get('/', c => c.json({ message: 'Your Cloudflare app is ready.', health: '/api/health', database: '/api/now' }));
export default app;
`;
    return files;
  },
  readme: {
    runLocally: runWorker,
    database: `The \`DB\` binding is a Hyperdrive configuration for a Postgres database hosted anywhere (Neon, Supabase, PlanetScale, your own server); Cloudflare pools and caches the connections. Add the database to the project first: \`shipcel hyperdrive add DB\` (it asks for the connection string, which goes to Cloudflare only) or **Manage → Database** in Shipcel, then put the id it shows as \`id\` in wrangler.json. \`HYPERDRIVE_ID\` is a placeholder that the deploy check refuses. Your code reads \`env.DB.connectionString\` (see src/worker.js and GET /api/now). For \`npm run dev\`, \`localConnectionString\` points Wrangler's local runtime at a Postgres on your computer; change it to yours.\n`,
  },
};
