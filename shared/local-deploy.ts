// Apps with code and bindings, deployed from a person's computer: the shipcel CLI reads
// these root files and sends them to Shipcel, which reviews them with the same planner as
// a GitHub repository (worker/repository-plan.ts), then lets Wrangler deploy through it.
// No dependencies: the CLI bundles this file.
import { lockfiles, siteFiles, wranglerFiles } from './site-presets.ts';

// The Wrangler the CLI runs: the version Shipcel is verified with, and the one its GitHub
// deployments run. 4.152.0 and earlier have advisories (through miniflare: sharp, then undici).
export const WRANGLER_VERSION = '4.156.0';
// Python Workers with packages deploy with pywrangler and the Wrangler their package.json pins.
// They were verified with this one (28 Oct 2026, on the Mac, Node 24.22.1: their fixtures need
// uv); another is reported as untested until npm run verify:frameworks passes them with it.
export const PYTHON_WRANGLER_VERSION = '4.154.0';
// The uv that runs pywrangler for Python packages (pipx installs it in the build). pywrangler
// from workers-py 1.17 refuses uv before 0.13.4 (28 Oct 2026).
export const UV_VERSION = '0.13.6';

// Read in full. The other files only need to exist, so the CLI sends "present" for them.
export const localPlanContents = [
  'package.json',
  'wrangler.json',
  'wrangler.jsonc',
  'open-next.config.ts',
  'next.config.ts',
  'next.config.mjs',
  'next.config.js',
  'pyproject.toml',
  ...siteFiles.filter((name) => name !== 'index.html'),
];
export const localPlanFiles = [
  ...new Set([
    ...localPlanContents,
    'index.html',
    'uv.lock',
    ...lockfiles,
    ...wranglerFiles,
  ]),
];
// The largest file the review reads, and the two packages whose locked versions it needs.
// Files it reads as text rather than JSON (framework configurations, pyproject.toml) get
// a smaller limit: they are searched with patterns, and a real one is a few kilobytes.
export const LOCAL_PLAN_FILE_BYTES = 200_000;
const LOCAL_PLAN_TEXT_BYTES = 50_000;
export const localPlanLimit = (name: string) =>
  /\.jsonc?$/.test(name) ? LOCAL_PLAN_FILE_BYTES : LOCAL_PLAN_TEXT_BYTES;
export const lockedPackages = ['next', '@opennextjs/cloudflare'];

// OpenNext's incremental cache in R2: the binding it reads and the prefix of its keys
// (@opennextjs/cloudflare 1.20.14, dist/api/overrides). After a production deploy from the
// terminal or GitHub Actions, the CLI fills the app's bucket with what Next.js prerendered.
export const NEXT_CACHE_BINDING = 'NEXT_INC_CACHE_R2_BUCKET';
export const NEXT_CACHE_PREFIX = 'incremental-cache';
// The entries one deploy fills, at most: each is a call on the workspace's Cloudflare
// connection, which Cloudflare allows 1,200 of every five minutes. The rest of a larger
// site's pages are cached on their first request.
export const NEXT_CACHE_ENTRIES = 500;
// Where its cache in the app's own files lives (`staticAssetsIncrementalCache`).
export const NEXT_STATIC_CACHE_DIR = 'cdn-cgi/_next_cache';
export type OpenNextCache = 'r2' | 'kv' | 'static-assets';

// package-lock.json can be megabytes; the review only reads which versions of these
// packages it locks. Null when the lockfile isn't JSON.
export function reducedLockfile(source: string): string | null {
  try {
    const packages = (
      JSON.parse(source) as { packages?: Record<string, { version?: unknown }> }
    ).packages;
    return JSON.stringify({
      packages: Object.fromEntries(
        lockedPackages.flatMap((name) => {
          const version = packages?.[`node_modules/${name}`]?.version;
          return typeof version === 'string'
            ? [[`node_modules/${name}`, { version }]]
            : [];
        }),
      ),
    });
  } catch {
    return null;
  }
}

// What Shipcel's review of a folder says (POST /api/local-plan and
// /api/projects/:id/local-plan).
export type LocalPlan = {
  framework: string | null;
  adapter: string;
  buildCommand: string;
  resources: { type: 'd1' | 'r2' | 'kv'; binding: string }[];
  // Postgres or MySQL databases the app binds through Hyperdrive; nothing is created.
  hyperdrive?: { binding: string; id: string }[];
  warnings: string[];
  issues: string[];
  workerName?: string;
  // A Next.js app's incremental cache, when open-next.config.ts sets one.
  openNextCache?: OpenNextCache;
  // With a project: the Worker's name, whether this deploy creates it, whether it goes to
  // production, and the resources Cloudflare creates now.
  first?: boolean;
  production?: boolean;
  create?: { type: 'd1' | 'r2' | 'kv'; binding: string; name: string }[];
};
