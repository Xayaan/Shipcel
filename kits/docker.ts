// A Worker in front of a container built from the kit's Dockerfile, started on the first
// request.
import {
  containerConfig,
  CONTAINERS_VERSION,
  containerScripts,
  pageStyles,
} from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'docker',
  name: 'Docker / custom runtime',
  subtitle: 'Node, PHP, Go, Ruby & more',
  runtime: 'Containers + Durable Objects',
  family: 'Containers',
  symbol: '▧',
  color: 'blue',
  description:
    'A Worker that routes requests to Linux containers built from a Dockerfile: a starter kit, or an import of a Container Worker. Cloudflare’s builds make the image. Needs the Workers Paid plan; container disk is temporary. Configuration is fixture-verified; image builds need Docker.',
  docs: 'https://developers.cloudflare.com/containers/',
  containers: true,
} as const satisfies KitMeta;

// The container's scripts, with a build that checks both the Worker and the server.
const scripts = {
  ...containerScripts,
  build: 'node --check src/worker.js && node --check container/server.mjs',
};

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: () =>
    containerConfig('AppContainer', 'APP', './Dockerfile', 'lite', 2),
  scripts,
  dependencies: { '@cloudflare/containers': CONTAINERS_VERSION },
  ignore: '',
  files: (project) => {
    const files: Record<string, string> = {};
    files['src/worker.js'] =
      `import { Container, getContainer } from '@cloudflare/containers';

// One container, built from ./Dockerfile, started on the first request and stopped ten
// minutes after the last one. Its disk is temporary: keep data in D1, R2 or a database.
export class AppContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  envVars = { APP_NAME: '${project.name}' };
}

export default {
  async fetch(request, env) {
    // The Worker answers its health check itself, so checking it wakes no container.
    if (new URL(request.url).pathname === '/api/health')
      return Response.json({ ok: true, app: '${project.name}' });
    return getContainer(env.APP).fetch(request);
  },
};
`;
    files['Dockerfile'] =
      `# The container Cloudflare runs for this app. Cloudflare's builds make the image from this
# file on deploy (or Wrangler, with Docker running on your computer).
FROM node:24-alpine
WORKDIR /app
COPY container/server.mjs .
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
`;
    files['container/server.mjs'] = `import { createServer } from 'node:http';

// Any language works in a container: this is Node's own HTTP server, on the port the Worker
// sends requests to.
const page = \`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${project.name}</title><style>${pageStyles}</style></head><body><main><span class="eyebrow">Built with Shipcel</span><h1>Your container. Your infrastructure.</h1><p>\${process.env.APP_NAME} answers from a Linux container in your Cloudflare account.</p><a href="/api/container">Ask the container →</a></main></body></html>\`;
createServer((request, response) => {
  if (request.url === '/api/container') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, from: 'container', node: process.version }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(page);
}).listen(8080);
`;
    return files;
  },
  readme: {
    runLocally:
      'Wrangler builds the image with Docker and runs the container on your computer, so start Docker first.\n',
    notes:
      'The Worker in `src/worker.js` starts one container from `Dockerfile` on the first request and stops it ten minutes after the last one (`sleepAfter`); it answers `/api/health` itself, so checks don’t wake the container. Change `container/server.mjs`, or the whole Dockerfile: any language that listens on port 8080 works. The container’s disk is temporary: what it writes is gone when it stops, so keep data in D1, R2 or a database elsewhere. Containers need Cloudflare’s Workers Paid plan ($5 a month), which includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month; this kit’s `lite` instance (256 MiB) uses a quarter of a GiB-hour each hour it is awake. Push the folder to GitHub and run `shipcel git connect`: Cloudflare’s builds make the image from the Dockerfile. `npm run deploy` from your computer needs Docker running.',
  },
};
