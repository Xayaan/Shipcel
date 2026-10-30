// A static site in the Worker's assets, with no server code.
import { pageStyles, runWorker, workerScripts } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'static',
  name: 'Static site',
  subtitle: 'HTML, CSS & JavaScript',
  runtime: 'Workers Assets',
  family: 'Static',
  symbol: '</>',
  color: 'amber',
  description:
    'A portable static website served by Workers Static Assets. No server runtime or database required.',
  docs: 'https://developers.cloudflare.com/workers/static-assets/',
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  scripts: workerScripts,
  config: () => ({
    assets: { directory: './public', not_found_handling: '404-page' },
  }),
  files: (project) => {
    const files: Record<string, string> = {};
    files['public/index.html'] =
      `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${project.name}</title><link rel="stylesheet" href="/style.css"></head><body><main><span class="eyebrow">Built with Shipcel</span><h1>Your site.<br>Your infrastructure.</h1><p>${project.name} is ready for your next idea. Edit this page and deploy it to your own Cloudflare account.</p></main></body></html>\n`;
    files['public/style.css'] = pageStyles;
    files['public/404.html'] =
      '<!doctype html><html lang="en"><title>Not found</title><h1>Page not found</h1><a href="/">Go home</a></html>\n';
    return files;
  },
  readme: { runLocally: runWorker, verify: 'the homepage' },
};
