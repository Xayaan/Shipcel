// Next.js through the OpenNext Cloudflare adapter, configured as `wrangler setup` writes it
// (captured with Wrangler 4.148), with its cache in R2 unless the project is Free-only.
import { NEXT_CACHE_BINDING } from '../shared/local-deploy.ts';
import { healthRoute, pageStyles, predeploy, taglineFor } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

// What the App catalog shows.
export const meta = {
  id: 'nextjs',
  name: 'Next.js',
  subtitle: 'Full-stack React framework',
  runtime: 'Workers + framework adapter',
  family: 'JavaScript',
  symbol: 'N',
  color: 'ink',
  description:
    'A Next.js starter kit on the OpenNext Cloudflare adapter, or an import of a repository with the adapter committed. It deploys under the Worker name in its Wrangler configuration. Build and Worker bundle are fixture-verified.',
  docs: 'https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/',
  bindings: true,
} as const satisfies KitMeta;

const nextCacheBindings = {
  r2_buckets: [{ binding: NEXT_CACHE_BINDING }],
  durable_objects: {
    bindings: [
      { name: 'NEXT_CACHE_DO_QUEUE', class_name: 'DOQueueHandler' },
      { name: 'NEXT_TAG_CACHE_DO_SHARDED', class_name: 'DOShardedTagCache' },
    ],
  },
  migrations: [
    { tag: 'v1', new_sqlite_classes: ['DOQueueHandler', 'DOShardedTagCache'] },
  ],
};
// https://opennext.js.org/cloudflare/caching, with the overrides as OpenNext 1.20.14 names them.
const nextCacheConfig = (freeOnly: boolean) =>
  freeOnly
    ? "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\nimport staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';\n\n// The pages Next.js prerenders are served from the app's own files, which go up with each\n// deploy: nothing that can bill. With R2 (a project that isn't Free-only), pages can\n// revalidate: https://opennext.js.org/cloudflare/caching\nexport default defineCloudflareConfig({\n  incrementalCache: staticAssetsIncrementalCache,\n});\n"
    : "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\nimport r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';\nimport { withRegionalCache } from '@opennextjs/cloudflare/overrides/incremental-cache/regional-cache';\nimport doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';\nimport doShardedTagCache from '@opennextjs/cloudflare/overrides/tag-cache/do-sharded-tag-cache';\n\n// ISR and the data cache: entries in R2 with a regional cache in front, revalidation\n// through a Durable Object queue, tags in sharded Durable Objects. Shipcel fills the bucket\n// with the pages Next.js prerendered after each production deploy.\n// https://opennext.js.org/cloudflare/caching\nexport default defineCloudflareConfig({\n  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: 'long-lived' }),\n  queue: doQueue,\n  tagCache: doShardedTagCache({ baseShardSize: 12 }),\n});\n";
// What an exported project contains, beyond what every kit gets.
export const kit: Kit = {
  config: (project) => ({
    main: '.open-next/worker.js',
    compatibility_flags: ['global_fetch_strictly_public'],
    assets: { directory: '.open-next/assets', binding: 'ASSETS' },
    // OpenNext calls the Worker itself by the name it deploys under.
    services: [{ binding: 'WORKER_SELF_REFERENCE', service: project.name }],
    images: { binding: 'IMAGES' },
    observability: { enabled: true },
    // OpenNext's cache (open-next.config.ts): entries in R2, revalidation through a
    // Durable Object queue, tags in sharded Durable Objects, whose classes OpenNext's
    // worker exports. R2 can bill, so a Free-only project keeps the cache in its files.
    ...(project.freeOnly ? {} : nextCacheBindings),
  }),
  scripts: {
    dev: 'next dev',
    build: 'next build',
    preview: 'opennextjs-cloudflare build && opennextjs-cloudflare preview',
    predeploy,
    deploy: 'opennextjs-cloudflare build && opennextjs-cloudflare deploy',
  },
  dependencies: {
    // Next.js 16.4.1 fixes the critical advisories of October 2026 (GHSA-2464-fhr4-w9xw,
    // GHSA-673q-mjm6-r5xr); OpenNext runs it from 1.20.12 (its peer range).
    next: '16.4.3',
    react: '19.3.1',
    'react-dom': '19.3.1',
    '@opennextjs/cloudflare': '1.20.15',
  },
  // OpenNext's minifier holds back glob 10.4.5, whose command line has an advisory
  // (GHSA-5j98-mcp5-4vw2); 10.5.0 fixes it.
  overrides: { '@node-minify/core': { glob: '^10.5.0' } },
  ignore: '.next/\n.open-next/\n',
  files: (project) => {
    const files: Record<string, string> = {};
    const tagline = taglineFor(project, meta.name);
    const health = healthRoute(project);
    files['next.config.mjs'] =
      "/** @type {import('next').NextConfig} */\nexport default {};\n\n// Local Cloudflare bindings for next dev.\nimport('@opennextjs/cloudflare').then((m) => m.initOpenNextCloudflareForDev());\n";
    files['open-next.config.ts'] = nextCacheConfig(project.freeOnly);
    files['app/globals.css'] = pageStyles + '\n';
    files['app/layout.jsx'] =
      `import './globals.css';\n\nexport const metadata = { title: '${project.name}' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
    files['app/page.jsx'] =
      `export default function Home() {\n  return (\n    <main>\n      <span className="eyebrow">Built with Shipcel</span>\n      <h1>Your app. Your infrastructure.</h1>\n      <p>${tagline}</p>\n      <a href="/api/health">Check your API →</a>\n    </main>\n  );\n}\n`;
    files['app/api/health/route.js'] = health;
    files['public/_headers'] =
      '# https://developers.cloudflare.com/workers/static-assets/headers\n/_next/static/*\n  Cache-Control: public,max-age=31536000,immutable\n';
    return files;
  },
  readme: {
    runLocally:
      'Next.js serves the app and reloads it as you edit, with local Cloudflare bindings from OpenNext. `npm run preview` builds it with OpenNext and runs it in Wrangler, as it runs on Cloudflare.\n',
    notes:
      'Next.js runs through the OpenNext Cloudflare adapter. `open-next.config.ts` sets its incremental cache: in R2 (`NEXT_INC_CACHE_R2_BUCKET`), which Shipcel fills with the pages Next.js prerendered after each production deploy, with a Durable Object queue for revalidation and sharded Durable Objects for tags; or, in a Free-only project, in the app’s own files, which can’t revalidate between deploys. Shipcel deploys this app under the name in `wrangler.json`, which OpenNext also uses to call the Worker itself (`WORKER_SELF_REFERENCE`), so rename both together.',
  },
};
