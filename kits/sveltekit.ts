// SvelteKit 3 with its Cloudflare adapter. Wrangler's automatic setup doesn't support
// SvelteKit 3, so its configuration is committed here.
import { healthRoute, pageStyles, predeploy, taglineFor } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'sveltekit',
  name: 'SvelteKit',
  subtitle: 'Full-stack Svelte apps',
  runtime: 'Workers + Assets',
  family: 'JavaScript',
  symbol: 'S',
  color: 'orange',
  description:
    'A SvelteKit starter kit with @sveltejs/adapter-cloudflare, or an import of a repository with the adapter and a Wrangler configuration committed. Build and Worker bundle are fixture-verified.',
  docs: 'https://developers.cloudflare.com/workers/framework-guides/web-apps/svelte/',
  bindings: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: () => ({
    main: '.svelte-kit/cloudflare/_worker.js',
    assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
    observability: { enabled: true },
  }),
  scripts: {
    dev: 'vite dev',
    build: 'vite build',
    preview: 'npm run build && wrangler dev',
    predeploy,
    deploy: 'npm run build && wrangler deploy',
  },
  dependencies: {
    '@sveltejs/kit': '3.1.1',
    '@sveltejs/adapter-cloudflare': '8.0.2',
    '@sveltejs/vite-plugin-svelte': '7.3.1',
    svelte: '5.57.3',
    vite: '8.3.5',
  },
  ignore: '.svelte-kit/\n',
  files: (project) => {
    const files: Record<string, string> = {};
    const tagline = taglineFor(project, meta.name);
    const health = healthRoute(project);
    files['vite.config.js'] =
      "import adapter from '@sveltejs/adapter-cloudflare';\nimport { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\n// SvelteKit 3 takes its configuration through the Vite plugin.\nexport default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] });\n";
    files['src/app.html'] =
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <style>${pageStyles}</style>\n    %sveltekit.head%\n  </head>\n  <body>\n    <div style="display: contents">%sveltekit.body%</div>\n  </body>\n</html>\n`;
    files['src/routes/+page.svelte'] =
      `<svelte:head>\n  <title>${project.name}</title>\n</svelte:head>\n\n<main>\n  <span class="eyebrow">Built with Shipcel</span>\n  <h1>Your app. Your infrastructure.</h1>\n  <p>${tagline}</p>\n  <a href="/api/health">Check your API →</a>\n</main>\n`;
    files['src/routes/api/health/+server.js'] = health;
    files['static/.gitkeep'] = '';
    return files;
  },
  readme: {
    runLocally:
      'Vite serves the app and reloads it as you edit. `npm run preview` builds it and runs it in Wrangler, as it runs on Cloudflare.\n',
    notes:
      'SvelteKit 3 takes its adapter through the Vite plugin in `vite.config.js`. Wrangler’s automatic setup doesn’t support SvelteKit 3, so this configuration is committed for you: keep `main` and the assets directory in `wrangler.json` pointing at `.svelte-kit/cloudflare`.',
  },
};
