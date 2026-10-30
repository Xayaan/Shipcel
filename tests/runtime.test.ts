// Runs control-plane code in workerd (Miniflare) where Node and the Workers runtime differ.
// Unit tests run in Node, which accepts fetch options the Workers runtime rejects.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf: Miniflare;
const seen: string[] = [];

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { providerJSON } from './worker/providers.ts';
export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('target');
    try {
      return Response.json({ ok: true, body: await providerJSON(target) });
    } catch (error) {
      return Response.json({ ok: false, status: error.status, message: error.message });
    }
  },
};`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'providers',
          modules: [
            {
              type: 'ESModule',
              path: 'index.js',
              contents: bundle.outputFiles[0].text,
            },
          ],
          compatibilityDate: '2026-10-07',
          outboundService: (request: Request) => {
            seen.push(request.url);
            if (request.url.endsWith('/json')) return Response.json({ id: 7 });
            if (request.url.endsWith('/redirect'))
              return new Response(null, {
                status: 302,
                headers: { Location: 'https://elsewhere.example/steal' },
              });
            return new Response('missing', { status: 404 });
          },
        },
      ],
    } as never),
  );
}, 60000);
afterAll(() => mf?.dispose());

const run = async (target: string) =>
  (await (
    await mf.dispatchFetch(`http://local/?target=${encodeURIComponent(target)}`)
  ).json()) as {
    ok: boolean;
    body?: unknown;
    status?: number;
  };

describe('provider transport in the Workers runtime', () => {
  it('reaches providers (the Workers runtime rejects redirect: "error")', async () => {
    expect(await run('https://api.cloudflare.test/json')).toEqual({
      ok: true,
      body: { id: 7 },
    });
  });
  it('never follows a provider redirect, so credentials cannot leak to another host', async () => {
    const result = await run('https://api.cloudflare.test/redirect');
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(seen).not.toContain('https://elsewhere.example/steal');
  });
});
