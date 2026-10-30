// A JavaScript Worker with no framework.
import { runWorker, workerScripts } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'worker',
  name: 'JavaScript Worker',
  subtitle: 'Custom edge application',
  runtime: 'Workers',
  family: 'JavaScript',
  symbol: 'JS',
  color: 'amber',
  description:
    'A minimal JavaScript Worker using web standard APIs. Node.js compatibility must be checked per dependency.',
  docs: 'https://developers.cloudflare.com/workers/runtime-apis/nodejs/',
  bindings: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  scripts: workerScripts,
  config: () => ({ main: 'src/worker.js' }),
  files: (project) => {
    const files: Record<string, string> = {};
    files['src/worker.js'] = `export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== '/' && path !== '/api/health') return new Response('Not found', { status: 404 });
    return Response.json({ ok: true, app: '${project.name}' });
  },
};
`;
    return files;
  },
  readme: { runLocally: runWorker },
};
