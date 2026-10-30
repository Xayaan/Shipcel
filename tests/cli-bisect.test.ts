import { describe, expect, it } from 'vitest';
import { bisect, type BisectVersion } from '../packages/cli/src/bisect';
import { parseArgs, type Io, type Job } from '../packages/cli/src/core';

// shipcel bisect (packages/cli/src/bisect.ts): a binary search through versions, each tried
// at its own address.
const versions: BisectVersion[] = Array.from({ length: 8 }, (_, i) => {
  const n = 8 - i;
  return {
    id: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4222-8333-444455556666`,
    number: n,
    createdAt: `2026-10-${String(10 + n).padStart(2, '0')}T10:00:00Z`,
    message: `Release ${n}`,
    live: n === 8 ? 100 : null,
  };
});
const job = { live_url: 'https://shop.ada.workers.dev/' } as Job;
const find = (ref: string) => {
  const found = versions.find((v) => v.id.startsWith(ref));
  if (!found) throw new Error(`No version ${ref}`);
  return found;
};
// Version n's address, and n back from an address.
const numberOf = (url: string) => Number(new URL(url).hostname[0]);

function io(answer: (url: string) => number | string, tty = false) {
  const out: string[] = [];
  const tried: number[] = [];
  let last = '';
  const fake = {
    isTTY: tty,
    cwd: '/work',
    out: (line: string) => {
      out.push(line);
      const url = line.match(/(https:\/\/\S+)$/)?.[1];
      if (url && line.startsWith('Version ')) last = url;
    },
    run: async (
      _command: string,
      _cwd: string,
      env?: Record<string, string | undefined>,
    ) => {
      const url = env!.SHIPCEL_BISECT_URL!;
      tried.push(numberOf(url));
      return answer(url) as number;
    },
    ask: async () => {
      tried.push(numberOf(last));
      return answer(last) as string;
    },
    open: async () => {},
  } as unknown as Io;
  return { io: fake, out, tried };
}
const args = (...argv: string[]) => parseArgs(['bisect', ...argv]);

describe('shipcel bisect', () => {
  it('finds the first bad version with --run, in a few steps, and says what to roll back to', async () => {
    // Releases 5 and later are broken.
    const t = io((url) => (numberOf(url) >= 5 ? 1 : 0));
    await bisect(
      t.io,
      args('--good', '11111111', '--run', 'npm test', '--path', '/api/health'),
      versions,
      job,
      find,
    );
    expect(t.out[0]).toBe(
      'Bisecting 6 versions between 11111111 (good) and 88888888 (bad).',
    );
    expect(t.out).toContain(
      'Version 55555555, “Release 5” (2026-10-15): https://55555555-shop.ada.workers.dev/api/health',
    );
    expect(t.tried.length).toBeLessThanOrEqual(3);
    expect(t.out.slice(-3)).toEqual([
      'The first bad version is 55555555, “Release 5” (2026-10-15).',
      'Its own address: https://55555555-shop.ada.workers.dev/api/health',
      'The version before it, 44444444, was good: shipcel rollback 44444444 goes back to it.',
    ]);
  });

  it('asks in a terminal, and treats skipped versions as unknown', async () => {
    const t = io(
      (url) => (numberOf(url) === 4 ? 's' : numberOf(url) >= 5 ? 'n' : 'y'),
      true,
    );
    await bisect(
      t.io,
      args('--good', '11111111', '--bad', '77777777'),
      versions,
      job,
      find,
    );
    expect(t.out).toContain(
      'The first bad version is 55555555, “Release 5” (2026-10-15), or one of 1 skipped before it.',
    );
    // With a skipped one in between, it doesn't promise the version before was good.
    expect(t.out.join('\n')).not.toContain('shipcel rollback');
  });

  it('treats --run’s exit 125 as a skip, as git bisect does', async () => {
    const t = io((url) =>
      numberOf(url) === 4 ? 125 : numberOf(url) >= 5 ? 1 : 0,
    );
    await bisect(
      t.io,
      args('--good', '11111111', '--run', 'npm test'),
      versions,
      job,
      find,
    );
    expect(t.out).toContain('  npm test exited 125: skip.');
    expect(t.out.join('\n')).toContain('or one of 1 skipped before it');
  });

  it('skips versions without an address of their own, and refuses what it can’t do', async () => {
    // A custom domain says nothing about version addresses; only uploads report their own.
    const own = versions.map((v) =>
      Number(v.id[0]) === 3
        ? { ...v, previewUrl: 'https://33333333-shop.ada.workers.dev/' }
        : v,
    );
    const t = io((url) => (numberOf(url) >= 5 ? 1 : 0));
    await bisect(
      t.io,
      args('--good', '11111111', '--run', 'npm test'),
      own,
      { live_url: 'https://shop.example.com/' } as Job,
      (ref) => own.find((v) => v.id.startsWith(ref))!,
    );
    expect(t.out.filter((l) => l.startsWith('Skipping '))).not.toHaveLength(0);
    expect(t.tried).toEqual([3]);
    for (const [argv, message] of [
      [[], 'Name a version that worked'],
      [
        ['--good', '88888888', '--run', 'x'],
        'has to be older than the bad one',
      ],
      [['--good', '11111111'], 'Pass --run <command>'],
      [
        ['--good', '11111111', '--run', 'x', '--path', 'api'],
        '--path starts with /',
      ],
    ] as const)
      await expect(
        bisect(io(() => 0).io, args(...argv), versions, job, find),
      ).rejects.toThrow(message);
  });
});
