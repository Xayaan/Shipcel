// OpenNext's incremental cache for a Next.js app, filled the way `opennextjs-cloudflare
// populateCache` fills it (@opennextjs/cloudflare 1.20.14, dist/cli/commands/populate-cache.js):
// every file Next.js prerendered under .open-next/cache becomes one entry, at the key
// OpenNext's runtime reads (computeCacheKey, dist/api/overrides/internal.js). OpenNext writes
// them through a Worker it runs in the account; Shipcel writes them through the deploy's own
// session, which lets them into the app's cache bucket and nowhere else
// (worker/wrangler-api.ts).
import { createHash } from 'node:crypto';
import {
  NEXT_CACHE_ENTRIES,
  NEXT_CACHE_PREFIX,
  NEXT_STATIC_CACHE_DIR,
} from '../../../shared/local-deploy.ts';
import { join, type Io } from './core.ts';

const CACHE_DIR = '.open-next/cache';
// Four at a time; Shipcel paces a deploy's entries and answers 429 when they come faster.
const AT_ONCE = 4;

export type CacheEntry = { file: string; key: string };

export function cacheKey(
  key: string,
  buildId: string,
  type: 'cache' | 'fetch',
  prefix = NEXT_CACHE_PREFIX,
) {
  const hash = createHash('sha256').update(key).digest('hex');
  return `${prefix}/${buildId}/${hash}.${type}`.replace(/\/+/g, '/');
}

async function files(io: Io, dir: string, at = ''): Promise<string[]> {
  if (!(await io.fs.exists(dir))) return [];
  const found: string[] = [];
  for (const entry of await io.fs.readdir(dir))
    if (entry.dir)
      found.push(
        ...(await files(io, join(dir, entry.name), `${at}${entry.name}/`)),
      );
    else if (entry.file) found.push(`${at}${entry.name}`);
  return found;
}

// `<build id>/<route>.cache` for a page, `__fetch/<build id>/<key>` for a fetch() Next.js
// cached while it prerendered; the key is the rest of the path, after a slash.
export async function cacheEntries(
  io: Io,
  root: string,
): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = [];
  for (const path of await files(io, join(root, CACHE_DIR))) {
    const parts = path.split('/');
    const fetched = parts[0] === '__fetch';
    const [buildId, ...key] = fetched ? parts.slice(1) : parts;
    if (!fetched && !path.endsWith('.cache')) continue;
    if (!buildId || !key.length) continue;
    const route = `/${key.join('/')}`;
    entries.push({
      file: join(root, CACHE_DIR, path),
      key: cacheKey(
        fetched ? route : route.slice(0, -'.cache'.length),
        buildId,
        fetched ? 'fetch' : 'cache',
      ),
    });
  }
  return entries;
}

// A cache in the app's own files: the entries go where OpenNext's staticAssetsIncrementalCache
// reads them, before Wrangler uploads the files.
export async function copyStaticCache(io: Io, root: string) {
  const paths = await files(io, join(root, CACHE_DIR));
  const target = join(root, '.open-next/assets', NEXT_STATIC_CACHE_DIR);
  for (const path of paths) {
    const to = join(target, path);
    await io.fs.mkdir(to.slice(0, to.lastIndexOf('/')));
    await io.fs.writeFile(
      to,
      await io.fs.readFile(join(root, CACHE_DIR, path)),
    );
  }
  return paths.length;
}

type Session = {
  token: string;
  apiPath: string;
  accountId: string;
  cache?: { bucket: string };
};

// Sends the entries through the deploy's session, a few at a time. Shipcel answers 429 when
// a deploy sends them faster than its pace: that entry waits and goes again. Resolves with
// how many went in, and the first refusal, if any stopped the rest.
export async function fillCache(
  io: Io,
  origin: string,
  session: Session,
  entries: CacheEntry[],
) {
  const bucket = session.cache!.bucket;
  const base = `${origin}${session.apiPath}/accounts/${session.accountId}/r2/buckets/${bucket}/objects`;
  const queue = entries.slice(0, NEXT_CACHE_ENTRIES);
  let filled = 0;
  let refused: string | null = null;
  async function send(entry: CacheEntry) {
    const body = new Uint8Array(await io.fs.readFile(entry.file));
    for (let attempt = 0; attempt < 5; attempt++) {
      let response: Response;
      try {
        response = await io.fetch(`${base}/${entry.key}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${session.token}`,
            'Content-Type': 'application/json',
            'Content-Length': String(body.byteLength),
          },
          body,
        });
      } catch {
        await io.sleep(2000 * (attempt + 1));
        continue;
      }
      if (response.ok) {
        filled++;
        return;
      }
      if (response.status === 429 || response.status >= 500) {
        await io.sleep(response.status === 429 ? 15000 : 2000 * (attempt + 1));
        continue;
      }
      const answer = (await response.json().catch(() => null)) as {
        errors?: { message?: string }[];
      } | null;
      refused =
        answer?.errors?.[0]?.message ?? `Shipcel answered ${response.status}.`;
      return;
    }
    refused ??= 'Shipcel kept asking to wait.';
  }
  async function worker() {
    while (queue.length && !refused) await send(queue.shift()!);
  }
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return { filled, refused, left: entries.length - filled };
}
