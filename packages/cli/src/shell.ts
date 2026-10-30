// Runs a command line in a shell, as the person would type it. Its output goes to standard
// error, so standard output stays what the CLI itself reports (--json). A quiet command's
// output is kept back and shown only when it fails: a check the CLI makes on the way, not
// something the person asked to watch.
import { spawn } from 'node:child_process';

export function shell(
  command: string,
  cwd: string,
  env: Record<string, string | undefined> = {},
  quiet = false,
  show: (output: Uint8Array) => void = (output) => {
    process.stderr.write(output);
  },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: quiet
        ? ['ignore', 'pipe', 'pipe']
        : ['inherit', process.stderr, 'inherit'],
      // Names set to undefined are left out of the command's environment.
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    });
    const kept: Uint8Array[] = [];
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Uint8Array) => kept.push(chunk));
    child.on('error', () => resolve(127));
    child.on('close', (code) => {
      if (code !== 0 && kept.length) show(Buffer.concat(kept));
      resolve(code ?? 1);
    });
  });
}
