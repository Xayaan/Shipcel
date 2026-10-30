// React with Vite, served from the Worker's assets, and a Hono API under /api/*.
import {
  frontendAssets,
  frontendIndex,
  frontendScripts,
  HONO,
  honoWorker,
  pageStyles,
  REACT,
  runFrontend,
  VITE,
} from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'react',
  name: 'React',
  subtitle: 'Vite frontend + Hono API',
  runtime: 'Workers + Assets',
  family: 'JavaScript',
  symbol: '⚛',
  color: 'blue',
  description:
    'A full-stack starting point with a React frontend, a Worker API, and optional SQL and file storage.',
  docs: 'https://developers.cloudflare.com/workers/framework-guides/web-apps/react/',
  bindings: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  scripts: frontendScripts,
  dependencies: { hono: HONO, react: REACT, 'react-dom': REACT },
  devDependencies: { vite: VITE },
  config: () => ({ main: 'src/worker.js', assets: frontendAssets }),
  files: (project) => {
    const files: Record<string, string> = {
      'src/worker.js': honoWorker(project, true),
      'index.html': frontendIndex(project),
      'src/style.css': pageStyles,
    };
    files['src/main.js'] = `import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
const e = React.createElement;
createRoot(document.getElementById('root')).render(e('main', null,
  e('span', { className: 'eyebrow' }, 'Built with Shipcel'),
  e('h1', null, 'Your app. Your infrastructure.'),
  e('p', null, '${project.name} is ready for your next idea. React on the frontend, Hono on the backend, and Cloudflare underneath.'),
  e('a', { href: '/api/health' }, 'Check your API →')
));
`;
    return files;
  },
  readme: { runLocally: runFrontend },
};
