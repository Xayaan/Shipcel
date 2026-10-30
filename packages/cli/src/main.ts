// Entry point: connects the CLI to the real process, file system, browser and terminal.
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { run, type Io } from './cli.ts';
import { readSecret } from './secret.ts';
import { shell } from './shell.ts';

const io: Io = {
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  hostname: hostname(),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  fetch: globalThis.fetch,
  // Opens the browser without a shell, so the address can't run anything.
  open: (url) =>
    new Promise((resolve) => {
      const [command, args] =
        process.platform === 'darwin'
          ? ['open', [url]]
          : process.platform === 'win32'
            ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
            : ['xdg-open', [url]];
      execFile(command, args, () => resolve());
    }),
  // A build or install command, as the person would type it.
  run: (command, cwd, env, quiet) => shell(command, cwd, env, quiet),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ask: async (question) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  // Nothing typed is shown (./secret.ts); Ctrl+C stops the command, as it would anywhere else.
  askSecret: async (question) => {
    const value = await readSecret(question, process.stdin, process.stdout);
    if (value === null) process.exit(130);
    return value;
  },
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
  fs: {
    readFile: async (path) => new Uint8Array(await readFile(path)),
    writeFile: async (path, data, mode) => {
      await writeFile(path, data, mode ? { mode } : undefined);
      if (mode) await chmod(path, mode);
    },
    mkdir: async (path, mode) => {
      await mkdir(path, { recursive: true, ...(mode ? { mode } : {}) });
    },
    remove: (path) => rm(path, { force: true }),
    readdir: async (path) =>
      (await readdir(path, { withFileTypes: true }))
        .map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    size: async (path) => (await stat(path)).size,
    exists: async (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
  },
};

// Output piped into a command that stops reading (shipcel ls | head) ends quietly, as
// other command-line tools do, instead of with a stack trace.
for (const stream of [process.stdout, process.stderr])
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    process.exit(process.exitCode ?? 0);
  });

process.exitCode = await run(process.argv.slice(2), io);
