// shipcel bisect, as on Vercel: a binary search through an app's versions for the first bad
// one. Each version has its own address (its preview address); the person says whether each
// is good, or --run decides it: exit 0 good, 125 skip (as git bisect), anything else bad.
import { CliError, text, type Args, type Io, type Job } from './core.ts';

export type BisectVersion = {
  id: string;
  number?: number;
  createdAt?: string;
  message: string;
  live: number | null;
  previewUrl?: string | null;
};
const short = (id: string) => id.slice(0, 8);
const named = (v: BisectVersion) =>
  `${short(v.id)}${v.message ? `, “${v.message}”` : ''}${v.createdAt ? ` (${v.createdAt.slice(0, 10)})` : ''}`;

// A version's own address: the one its deploy reported, else Cloudflare's pattern beside the
// production workers.dev address (https://<first 8>-<app>.<subdomain>.workers.dev).
export function versionAddress(v: BisectVersion, job: Job | null) {
  if (v.previewUrl) return v.previewUrl.replace(/\/$/, '');
  const live = job?.live_url ? new URL(job.live_url).hostname : null;
  return live?.endsWith('.workers.dev')
    ? `https://${short(v.id)}-${live}`
    : null;
}

export async function bisect(
  io: Io,
  args: Args,
  versions: BisectVersion[],
  job: Job | null,
  find: (ref: string) => BisectVersion,
) {
  const goodRef = text(args.flags.good);
  if (!goodRef)
    throw new CliError(
      'Name a version that worked: shipcel bisect --good <version|url> [--bad <version|url>]. shipcel ls lists them.',
      2,
    );
  const path = text(args.flags.path) ?? '/';
  if (!path.startsWith('/') || /[\s'"\\`$]/.test(path))
    throw new CliError('--path starts with /, such as --path /api/hello.', 2);
  const command = text(args.flags.run);
  if (!command && !io.isTTY)
    throw new CliError(
      'Pass --run <command> to decide each version, or run shipcel bisect in a terminal.',
      2,
    );
  // Oldest first.
  const ordered = [...versions].reverse();
  const good = find(goodRef);
  const badRef = text(args.flags.bad);
  const bad = badRef ? find(badRef) : versions.find((v) => v.live === 100);
  if (!bad)
    throw new CliError(
      'No version serves all of production: name the bad one, --bad <version|url>.',
      2,
    );
  const from = ordered.findIndex((v) => v.id === good.id);
  let to = ordered.findIndex((v) => v.id === bad.id);
  if (from >= to)
    throw new CliError(
      `The good version has to be older than the bad one: ${short(good.id)} is not older than ${short(bad.id)}.`,
      2,
    );
  // Versions known good stay at or before `low`; the first bad one is at `to`.
  let low = from;
  const skipped = new Set<number>();
  const left = () => to - low - 1;
  io.out(
    `Bisecting ${left()} version${left() === 1 ? '' : 's'} between ${short(good.id)} (good) and ${short(bad.id)} (bad).`,
  );
  while (left() > 0) {
    const open = Array.from({ length: left() }, (_, i) => low + 1 + i).filter(
      (i) => !skipped.has(i),
    );
    if (!open.length) break;
    const middle = open[Math.floor(open.length / 2)];
    const version = ordered[middle];
    const base = versionAddress(version, job);
    if (!base) {
      io.out(`Skipping ${named(version)}: it has no address of its own.`);
      skipped.add(middle);
      continue;
    }
    const url = `${base}${path}`;
    io.out(`Version ${named(version)}: ${url}`);
    let verdict: 'good' | 'bad' | 'skip';
    if (command) {
      const code = await io.run(command, io.cwd, { SHIPCEL_BISECT_URL: url });
      verdict = code === 0 ? 'good' : code === 125 ? 'skip' : 'bad';
      io.out(`  ${command} exited ${code}: ${verdict}.`);
    } else {
      if (args.flags.open) await io.open(url).catch(() => {});
      const answer = (await io.ask('Is it good? [y]es, [n]o, [s]kip: '))
        .trim()
        .toLowerCase();
      verdict = /^y/.test(answer) ? 'good' : /^n/.test(answer) ? 'bad' : 'skip';
    }
    if (verdict === 'skip') skipped.add(middle);
    else if (verdict === 'good') low = middle;
    else to = middle;
  }
  const first = ordered[to];
  const before = ordered[to - 1];
  const unsure = [...skipped].filter((i) => i > low && i < to);
  const address = versionAddress(first, job);
  io.out(
    unsure.length
      ? `The first bad version is ${named(first)}, or one of ${unsure.length} skipped before it.`
      : `The first bad version is ${named(first)}.`,
  );
  if (address) io.out(`Its own address: ${address}${path}`);
  if (before && !unsure.length)
    io.out(
      `The version before it, ${short(before.id)}, was good: shipcel rollback ${short(before.id)} goes back to it.`,
    );
}
