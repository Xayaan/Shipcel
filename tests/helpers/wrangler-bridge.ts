// Lets the real Wrangler (the pinned version, from node_modules) deploy through the Shipcel
// app in a test: Wrangler talks HTTP, so a local server hands its requests to the app, as
// Shipcel's own address would. Everything Wrangler is sent back is kept, so a test can check
// that no Cloudflare token is in it.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { offlineEnv } from '../../scripts/offline-env.mjs';
import { WRANGLER_VERSION } from '../../shared/local-deploy';
import type { Env } from '../../worker/types';
import app from '../../worker/index';

const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
export const origin = 'https://shipcel.test';

export type Exchange = {
  method: string;
  path: string;
  authorization: string;
  // The length the client declared, or null when it sent the body in chunks.
  contentLength: string | null;
  text: string;
};

// A request as a real client sends it: the body's bytes, and how many there are. (A
// request object built in a test carries no Content-Length of its own.)
export async function sized(init: RequestInit = {}): Promise<RequestInit> {
  if (init.body === undefined || init.body === null) return init;
  const request = new Request(origin, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
  });
  const body = await request.arrayBuffer();
  const headers = new Headers(request.headers);
  headers.set('Content-Length', String(body.byteLength));
  return { ...init, headers, body };
}

export async function bridge(env: Env) {
  const seen: Exchange[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      // Content-Length and Transfer-Encoding go on as the client sent them: Shipcel
      // decides by them how much it is willing to read.
      if (typeof value === 'string' && !['host', 'connection'].includes(name))
        headers.set(name, value);
    const response = await app.fetch(
      new Request(`${origin}${req.url}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method ?? '')
          ? undefined
          : new Uint8Array(Buffer.concat(chunks)),
      }),
      env,
    );
    const text = await response.text();
    seen.push({
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers.authorization ?? '',
      contentLength: req.headers['content-length'] ?? null,
      text,
    });
    res.writeHead(response.status, {
      'Content-Type':
        response.headers.get('Content-Type') ?? 'application/json',
    });
    res.end(text);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const outputs: string[] = [];

  // Runs a Wrangler command line the way the shipcel CLI's shell would, with the
  // environment the CLI gave it. The installed Wrangler stands in for `npx wrangler@…`
  // (the same version), and Shipcel's address for this server.
  function run(
    command: string,
    cwd: string,
    env: Record<string, string | undefined> = {},
  ) {
    const { version } = JSON.parse(
      readFileSync('node_modules/wrangler/package.json', 'utf8'),
    ) as { version: string };
    const prefix = `npx --yes wrangler@${version} `;
    if (version !== WRANGLER_VERSION || !command.startsWith(prefix))
      throw new Error(`Not the pinned Wrangler: ${command}`);
    const args = [
      ...command.slice(prefix.length).matchAll(/"([^"]*)"|(\S+)/g),
    ].map((m) => m[1] ?? m[2]);
    const base = env.CLOUDFLARE_API_BASE_URL ?? '';
    if (!base.startsWith(origin))
      throw new Error(`Wrangler was pointed somewhere else: ${base}`);
    return new Promise<number>((done) =>
      execFile(
        process.execPath,
        [wrangler, ...args],
        {
          cwd,
          timeout: 100000,
          env: {
            ...offlineEnv(cwd),
            ...Object.fromEntries(
              Object.entries(env).filter(([, value]) => value !== undefined),
            ),
            CLOUDFLARE_API_BASE_URL: base.replace(
              origin,
              `http://127.0.0.1:${port}`,
            ),
          } as NodeJS.ProcessEnv,
        },
        (error, stdout, stderr) => {
          outputs.push(`${stdout}${stderr}`);
          done(error ? Number(error.code ?? 1) : 0);
        },
      ),
    );
  }
  return {
    seen,
    outputs,
    run,
    close: () => new Promise((done) => server.close(done)),
  };
}
