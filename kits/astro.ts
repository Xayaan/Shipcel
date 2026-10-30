// Astro with server rendering through its Cloudflare adapter, configured as `wrangler
// setup` writes it (captured with Wrangler 4.148).
import { healthRoute, pageStyles, predeploy, taglineFor } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'astro',
  name: 'Astro',
  subtitle: 'Content sites & server rendering',
  runtime: 'Workers + Assets',
  family: 'JavaScript',
  symbol: 'A',
  color: 'purple',
  description:
    'An Astro starter kit with the Cloudflare adapter and server rendering, or an import of a repository with the adapter committed. Build and Worker bundle are fixture-verified.',
  docs: 'https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/',
  bindings: true,
} as const satisfies KitMeta;

// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: () => ({
    main: '@astrojs/cloudflare/entrypoints/server',
    compatibility_flags: ['global_fetch_strictly_public'],
    assets: { directory: './dist', binding: 'ASSETS' },
    observability: { enabled: true },
  }),
  scripts: {
    dev: 'astro dev',
    build: 'astro build',
    preview: 'npm run build && wrangler dev',
    predeploy,
    deploy: 'npm run build && wrangler deploy',
  },
  dependencies: { astro: '7.4.4', '@astrojs/cloudflare': '14.4.3' },
  ignore: '.astro/\n',
  files: (project) => {
    const files: Record<string, string> = {};
    const tagline = taglineFor(project, meta.name);
    const health = healthRoute(project);
    files['astro.config.mjs'] =
      "import { defineConfig } from 'astro/config';\n\nimport cloudflare from '@astrojs/cloudflare';\n\nexport default defineConfig({\n  output: 'server',\n  adapter: cloudflare(),\n});\n";
    files['src/pages/index.astro'] =
      `---\nconst name = '${project.name}';\n---\n<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>{name}</title>\n    <style is:global>${pageStyles}</style>\n  </head>\n  <body>\n    <main>\n      <span class="eyebrow">Built with Shipcel</span>\n      <h1>Your app. Your infrastructure.</h1>\n      <p>${tagline}</p>\n      <a href="/api/health">Check your API →</a>\n    </main>\n  </body>\n</html>\n`;
    files['src/pages/api/health.js'] = health;
    return files;
  },
  readme: {
    runLocally:
      "Astro's dev server runs your pages with local stand-ins for Cloudflare bindings. `npm run preview` builds the app and runs it in Wrangler, as it runs on Cloudflare.\n",
    notes:
      'The Cloudflare adapter binds a KV namespace as `SESSION` for Astro sessions and Cloudflare Images as `IMAGES` for image optimization. Wrangler creates the namespace on the first deploy, and Shipcel lists both when it checks the repository. Image transformations count toward Cloudflare Images’ allowance.',
  },
};
