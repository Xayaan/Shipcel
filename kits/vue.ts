// Vue with Vite, served from the Worker's assets, and a Hono API under /api/*.
import {
  frontendAssets,
  frontendIndex,
  frontendScripts,
  HONO,
  honoWorker,
  pageStyles,
  runFrontend,
  VITE,
} from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'vue',
  name: 'Vue',
  subtitle: 'Vite frontend + Hono API',
  runtime: 'Workers + Assets',
  family: 'JavaScript',
  symbol: 'V',
  color: 'green',
  description:
    'A Vue application with a Hono backend and optional D1 and R2 bindings.',
  docs: 'https://developers.cloudflare.com/workers/framework-guides/web-apps/vue/',
  bindings: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  scripts: frontendScripts,
  dependencies: { hono: HONO, vue: '3.5.44' },
  devDependencies: { vite: VITE },
  config: () => ({ main: 'src/worker.js', assets: frontendAssets }),
  files: (project) => {
    const files: Record<string, string> = {
      'src/worker.js': honoWorker(project, true),
      'index.html': frontendIndex(project),
      'src/style.css': pageStyles,
    };
    files['src/main.js'] = `import { createApp, h } from 'vue';
import './style.css';
createApp({ render: () => h('main', [
  h('span', { class: 'eyebrow' }, 'Built with Shipcel'),
  h('h1', 'Your app. Your infrastructure.'),
  h('p', '${project.name} is ready for your next idea. Vue on the frontend, Hono on the backend, and Cloudflare underneath.'),
  h('a', { href: '/api/health' }, 'Check your API →')
]) }).mount('#root');
`;
    return files;
  },
  readme: { runLocally: runFrontend },
};
