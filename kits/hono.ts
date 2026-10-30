// A Hono API that is the whole Worker.
import { HONO, honoWorker, runWorker, workerScripts } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'hono',
  name: 'Hono',
  subtitle: 'Fast, lightweight API',
  runtime: 'Workers',
  family: 'JavaScript',
  symbol: 'H',
  color: 'orange',
  description:
    'A typed API on Workers. Add a D1 database and an R2 bucket without wiring bindings by hand.',
  docs: 'https://developers.cloudflare.com/workers/framework-guides/web-apps/hono/',
  bindings: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  scripts: workerScripts,
  dependencies: { hono: HONO },
  config: () => ({ main: 'src/worker.js' }),
  files: (project) => ({ 'src/worker.js': honoWorker(project, false) }),
  readme: { runLocally: runWorker },
};
