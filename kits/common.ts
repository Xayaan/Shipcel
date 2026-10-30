// What several starter kits share: a Worker's scripts and configuration, the page a new app
// shows, its health route, and the pieces of the container kits.
import type { KitProject } from './types.ts';

// Runs before every deploy: the configuration check every kit gets (scripts/check-config.mjs).
export const predeploy = 'node scripts/check-config.mjs';

// Versions more than one kit pins; `npm run verify:kits` builds every kit with them.
export const HONO = '4.13.14';
export const VITE = '8.3.5';
export const REACT = '19.3.1';
// @cloudflare/containers 0.3.7 (29 Jun 2026), the newest on 29 Oct 2026.
export const CONTAINERS_VERSION = '0.3.7';

// A Worker with no build step, which Wrangler bundles, and how its README says to run it.
export const workerScripts = {
  dev: 'wrangler dev',
  build: 'wrangler deploy --dry-run --outdir dist',
  predeploy,
  deploy: 'wrangler deploy',
};
export const runWorker = 'Wrangler runs your application locally.\n';

// A Vite frontend in the Worker's assets, built before Wrangler runs or deploys it, with the
// API under /api/*.
export const frontendScripts = {
  dev: 'npm run build && wrangler dev',
  build: 'vite build',
  predeploy,
  deploy: 'npm run build && wrangler deploy',
};
export const runFrontend =
  'This builds the frontend and starts Wrangler with local API and resource emulation. Rebuild after frontend changes.\n';
export const frontendAssets = {
  directory: './dist',
  binding: 'ASSETS',
  not_found_handling: 'single-page-application',
  run_worker_first: ['/api/*'],
};
export const frontendIndex = (project: KitProject) =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${project.name}</title></head><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n`;

// A Hono API: under /api/* beside a frontend's assets, or the whole Worker.
export const honoWorker = (project: KitProject, frontend: boolean) =>
  `import { Hono } from 'hono';
const app = new Hono();
app.get('/api/health', c => c.json({ ok: true, app: '${project.name}' }));
${project.database ? '// DB is available at c.env.DB. Add authenticated routes before exposing data.\n' : ''}${project.storage ? '// FILES is available at c.env.FILES. Validate uploads and require authorization.\n' : ''}${frontend ? "app.all('/api/*', c => c.json({ error: 'Not found' }, 404));\napp.all('*', c => c.env.ASSETS.fetch(c.req.raw));" : "app.get('/', c => c.json({ message: 'Your Cloudflare app is ready.', health: '/api/health' }));"}
export default app;
`;

// The page a new app shows, and its health route.
export const pageStyles = `body{margin:0;background:#f4f6f2;color:#193e32;font:17px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:600px;padding:48px}h1{font-size:clamp(36px,8vw,64px);letter-spacing:-3px;line-height:1.08}p{line-height:1.7;color:#52625b}a{color:inherit}code{background:#e4ebdf;padding:5px 8px;border-radius:6px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:2px}`;
export const taglineFor = (project: KitProject, framework: string) =>
  `${project.name} is ready for your next idea. ${framework} on Cloudflare Workers, in your own account.`;
export const healthRoute = (project: KitProject) =>
  `export function GET() {\n  return Response.json({ ok: true, app: '${project.name}' });\n}\n`;

// One container class, its Durable Object binding and the migration that creates it. Wrangler
// builds an image from a Dockerfile, or Cloudflare pulls a registry image.
export const containerConfig = (
  className: string,
  binding: string,
  image: string,
  instanceType: 'lite' | 'basic',
  maxInstances: number,
) => ({
  main: 'src/worker.js',
  containers: [
    {
      class_name: className,
      image,
      instance_type: instanceType,
      max_instances: maxInstances,
    },
  ],
  durable_objects: { bindings: [{ name: binding, class_name: className }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: [className] }],
  observability: { enabled: true },
});
export const containerScripts = {
  // Wrangler runs the container with Docker on this computer.
  dev: 'wrangler dev',
  // The Worker parses; Cloudflare's builds make the image, or Cloudflare pulls it.
  build: 'node --check src/worker.js',
  predeploy,
  deploy: 'wrangler deploy',
};

// A service's Worker passes requests to its container once its secrets are set.
export const unset = (
  names: string[],
) => `const unset = (env) => ${JSON.stringify(names)}.filter((name) => !env[name]);
const setFirst = (missing) =>
  new Response(\`Set the \${missing.join(' and ')} secret\${missing.length > 1 ? 's' : ''} first (README.md has the steps). No container was started.\`, { status: 503 });`;

// Setting up a service on Cloudflare: its database, its secrets, and its first sign-in.
export const serviceSteps = (
  secret: string,
  secretHelp: string,
  firstVisit: string,
) =>
  `1. **A Postgres database.** Create one anywhere that accepts connections from the internet; Neon's free plan is enough. Copy its connection string, ending in \`?sslmode=require\`.
2. **Deploy it.** Push this folder to GitHub, then run \`shipcel git connect\` in it: Cloudflare's builds deploy the Worker, and Cloudflare pulls the image. The project can't be Free-only: containers need Cloudflare's Workers Paid plan ($5 a month).
3. **Its secrets.** In Shipcel (**Manage → Secrets & variables**) or with \`npx wrangler secret put\`, set \`DATABASE_URL\` to the connection string and \`${secret}\` to ${secretHelp}. Until both are set, the app answers 503 and starts no container.
4. **${firstVisit}**

The container sleeps after a while without requests, and the next request wakes it in a few seconds; asleep, it costs nothing. Its disk is temporary, which is why everything is kept in Postgres. Awake all month, its \`basic\` instance (1 GiB) uses about 730 GiB-hours of memory: about $6.50 beyond the 25 GiB-hours Workers Paid includes, plus CPU while it works. Shipcel's budget guard counts container usage.`;
