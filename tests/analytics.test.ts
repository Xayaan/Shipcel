import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from './helpers/database';
import app from '../worker/index';
import { capture } from '../src/posthog';

// Shipcel's own visitor analytics: PostHog, loaded by /analytics.js and sent through /ingest on
// Shipcel's own origin (PostHog's Cloudflare proxy guide), cookieless. PostHog is faked here.
const KEY = `phc_${'a1'.repeat(20)}`;
let db: ReturnType<typeof database>;
let sent: Request[];

beforeEach(() => {
  db = database();
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input, init));
      return new Response('ok', {
        headers: { 'Content-Type': 'text/plain', 'Set-Cookie': 'ph=1' },
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

const at = (
  path: string,
  env: Record<string, string> = {},
  init: RequestInit = {},
) => app.request(`https://shipcel.test${path}`, init, { ...db.env, ...env });

// Runs the loader as a page at `origin` would, then as array.js finishing its load: returns
// what it gave posthog.init and the script it asked for.
async function load(
  path: string,
  env: Record<string, string>,
  origin = 'https://shipcel.test',
) {
  const code = await (await at('/analytics.js', env)).text();
  const added: { src: string; async: boolean; onload: () => void }[] = [];
  const window: { posthog?: unknown } = {};
  const document = {
    createElement: () => ({}) as never,
    head: { appendChild: (element: never) => added.push(element) },
  };
  new Function('window', 'document', 'location', code)(window, document, {
    origin,
    host: origin.replace('https://', ''),
    pathname: path,
  });
  const init = vi.fn();
  window.posthog = { init };
  added[0]?.onload();
  return { added, init, window };
}

describe("Shipcel's own visitor analytics", () => {
  it('loads and forwards nothing without a PostHog key', async () => {
    const script = await at('/analytics.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('Content-Type')).toContain('javascript');
    const { added } = await load('/', {});
    expect(added).toEqual([]);
    expect(
      (await at('/ingest/e/', {}, { method: 'POST', body: '{}' })).status,
    ).toBe(404);
    expect(sent).toEqual([]);
  });

  it('starts PostHog cookieless, through this origin, with no recordings', async () => {
    const { added, init } = await load('/', { POSTHOG_KEY: KEY });
    expect(added.map((s) => [s.src, s.async])).toEqual([
      ['/ingest/static/array.js', true],
    ]);
    expect(init).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({
        api_host: 'https://shipcel.test/ingest',
        ui_host: 'https://us.posthog.com',
        cookieless_mode: 'always',
        disable_session_recording: true,
        autocapture: true,
      }),
    );
  });

  // The pages' Content-Security-Policy allows only their own origin: sent anywhere else, every
  // request would be blocked.
  it('sends through the address the page is on, whatever APP_ORIGIN says', async () => {
    const { init } = await load(
      '/',
      { POSTHOG_KEY: KEY, APP_ORIGIN: 'https://shipcel.com' },
      'https://www.shipcel.com',
    );
    expect(init.mock.calls[0][1].api_host).toBe(
      'https://www.shipcel.com/ingest',
    );
  });

  // The dashboard shows tokens and secret values, so no third-party script runs there: its
  // page views and named events go through a sender of Shipcel's own, cookieless.
  it('loads no third-party script on the dashboard: its events go first-party, cookieless', async () => {
    const { added, init, window } = await load('/app/', { POSTHOG_KEY: KEY });
    expect(added).toEqual([]);
    expect(init).not.toHaveBeenCalled();
    const analytics = (
      window as { __shipcelAnalytics?: { send(e: string, p?: object): void } }
    ).__shipcelAnalytics;
    expect(analytics).toBeDefined();
    analytics!.send('project_created', { framework: 'react' });
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ['POST', 'https://shipcel.test/ingest/e/'],
      ['POST', 'https://shipcel.test/ingest/e/'],
    ]);
    const events = await Promise.all(
      sent.map(async (r) => JSON.parse(await r.text())),
    );
    expect(events[0]).toMatchObject({
      api_key: KEY,
      event: '$pageview',
      distinct_id: '$posthog_cookieless',
      properties: {
        $cookieless_mode: true,
        $current_url: 'https://shipcel.test/app/',
      },
    });
    expect(events[1]).toMatchObject({
      event: 'project_created',
      distinct_id: '$posthog_cookieless',
      properties: { $cookieless_mode: true, framework: 'react' },
    });
    // A failing send never reaches the page.
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    expect(() => analytics!.send('project_deleted')).not.toThrow();
  });

  it('takes the region case-insensitively', async () => {
    const { init } = await load('/', {
      POSTHOG_KEY: KEY,
      POSTHOG_REGION: 'EU',
    });
    expect(init.mock.calls[0][1].ui_host).toBe('https://eu.posthog.com');
  });

  it('forwards only the paths and methods PostHog’s loader uses', async () => {
    const env = { POSTHOG_KEY: KEY };
    const refused = await Promise.all([
      at('/ingest/site_app/1/phc_other/abcdef/', env),
      at(`/ingest/array/phc_${'b2'.repeat(20)}/config.js`, env),
      at('/ingest/static/evil.html', env),
      at('/ingest/e/', env, { method: 'PUT', body: '{}' }),
      at('/ingest/e/', env, { method: 'DELETE' }),
      // An encoded spelling: Hono matches the decoded path, so the raw one is checked too.
      app.request(
        'https://shipcel.test/%69ngest/e/',
        { method: 'POST', body: '{}' },
        { ...db.env, ...env },
      ),
    ]);
    for (const answer of refused) expect(answer.status).toBe(404);
    expect(sent).toEqual([]);
    for (const path of [
      '/ingest/e/',
      '/ingest/i/v0/e/',
      '/ingest/batch/',
      '/ingest/flags/?v=2',
      '/ingest/decide/?v=3',
    ])
      expect(
        (await at(path, env, { method: 'POST', body: '{}' })).status,
        path,
      ).toBe(200);
    expect(
      (await at('/ingest/static/1.441.0/exception-autocapture.js', env)).status,
    ).toBe(200);
    expect((await at(`/ingest/array/${KEY}/config`, env)).status).toBe(200);
  });

  it('forwards only the request headers PostHog needs', async () => {
    await at(
      '/ingest/e/',
      { POSTHOG_KEY: KEY },
      {
        method: 'POST',
        body: '{}',
        headers: {
          'User-Agent': 'Browser/1',
          Accept: '*/*',
          'Proxy-Authorization': 'Basic x',
          'X-Real-IP': '198.51.100.1',
          Forwarded: 'for=198.51.100.1',
          'True-Client-IP': '198.51.100.1',
          'CF-Access-Jwt-Assertion': 'jwt',
        },
      },
    );
    const [forwarded] = sent;
    expect(forwarded.headers.get('User-Agent')).toBe('Browser/1');
    expect(forwarded.headers.get('Accept')).toBe('*/*');
    for (const name of [
      'Proxy-Authorization',
      'X-Real-IP',
      'Forwarded',
      'True-Client-IP',
      'CF-Access-Jwt-Assertion',
    ])
      expect(forwarded.headers.get(name), name).toBeNull();
  });

  it('passes on only the response headers a browser needs, marked nosniff', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('ok', {
        headers: {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'public, max-age=300',
          ETag: '"x"',
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
          'Access-Control-Allow-Origin': 'https://evil.example',
          'Access-Control-Allow-Credentials': 'true',
          'Set-Cookie': 'ph=1',
        },
      }),
    );
    const answer = await at('/ingest/static/array.js', { POSTHOG_KEY: KEY });
    expect(answer.headers.get('Content-Type')).toBe('text/javascript');
    expect(answer.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(answer.headers.get('ETag')).toBe('"x"');
    expect(answer.headers.get('X-Content-Type-Options')).toBe('nosniff');
    for (const name of [
      'Strict-Transport-Security',
      'Access-Control-Allow-Origin',
      'Access-Control-Allow-Credentials',
      'Set-Cookie',
    ])
      expect(answer.headers.get(name), name).toBeNull();
  });

  it('refuses a body without a known length once it passes 1 MB, without reading it all', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream({
      pull(controller) {
        pulled++;
        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const answer = await app.request(
      'https://shipcel.test/ingest/e/',
      { method: 'POST', body, duplex: 'half' } as RequestInit,
      { ...db.env, POSTHOG_KEY: KEY },
    );
    expect(answer.status).toBe(413);
    // 1 MB is 16 chunks: it stopped there, not at the end of 4 MB.
    expect(pulled).toBeLessThan(32);
    expect(sent).toEqual([]);
  });

  it('refuses a key that is not a PostHog project key', async () => {
    const { added } = await load('/', { POSTHOG_KEY: `${KEY}'};alert(1)//` });
    expect(added).toEqual([]);
  });

  it('forwards events with the visitor’s address, never their cookies or credentials', async () => {
    const answer = await at(
      '/ingest/e/?ip=0&_=1',
      { POSTHOG_KEY: KEY },
      {
        method: 'POST',
        body: 'batch',
        headers: {
          'CF-Connecting-IP': '203.0.113.7',
          'X-Forwarded-For': '198.51.100.1',
          Cookie: 'cloudcel_session=secret',
          Authorization: 'Bearer cc_pat_secret',
        },
      },
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get('Set-Cookie')).toBeNull();
    expect(sent).toHaveLength(1);
    const [forwarded] = sent;
    expect(forwarded.url).toBe('https://us.i.posthog.com/e/?ip=0&_=1');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('X-Forwarded-For')).toBe('203.0.113.7');
    expect(forwarded.headers.get('Cookie')).toBeNull();
    expect(forwarded.headers.get('Authorization')).toBeNull();
    expect(await forwarded.text()).toBe('batch');
  });

  // PostHog compresses what it sends, and the runtime and Cloudflare's edge compress responses
  // too: a body compressed by PostHog came out compressed twice, and broke as a script.
  it('asks PostHog for uncompressed bodies, which the edge compresses once itself', async () => {
    const env = { POSTHOG_KEY: KEY };
    await at(`/ingest/array/${KEY}/config.js`, env, {
      headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' },
    });
    await at('/ingest/e/', env, {
      method: 'POST',
      body: 'batch',
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    expect(sent.map((r) => r.headers.get('Accept-Encoding'))).toEqual([
      'identity',
      'identity',
    ]);
  });

  it('takes PostHog’s scripts and settings from its asset host', async () => {
    await at('/ingest/static/array.js', { POSTHOG_KEY: KEY });
    await at(`/ingest/array/${KEY}/config.js`, { POSTHOG_KEY: KEY });
    expect(sent.map((r) => r.url)).toEqual([
      'https://us-assets.i.posthog.com/static/array.js',
      `https://us-assets.i.posthog.com/array/${KEY}/config.js`,
    ]);
  });

  it('uses PostHog’s EU hosts for an EU project', async () => {
    const env = { POSTHOG_KEY: KEY, POSTHOG_REGION: 'eu' };
    const { init } = await load('/', env);
    expect(init.mock.calls[0][1].ui_host).toBe('https://eu.posthog.com');
    await at('/ingest/flags/?v=2', env, { method: 'POST', body: '{}' });
    await at('/ingest/static/array.js', env);
    expect(sent.map((r) => r.url)).toEqual([
      'https://eu.i.posthog.com/flags/?v=2',
      'https://eu-assets.i.posthog.com/static/array.js',
    ]);
  });

  it('sends dashboard events through the first-party sender, and never breaks the page', () => {
    const page = globalThis as { __shipcelAnalytics?: unknown };
    expect(() => capture('project_created')).not.toThrow();
    const send = vi.fn();
    page.__shipcelAnalytics = { send };
    capture('project_created', { framework: 'react' });
    expect(send).toHaveBeenCalledWith('project_created', {
      framework: 'react',
    });
    send.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => capture('project_deleted')).not.toThrow();
    delete page.__shipcelAnalytics;
  });

  it('refuses a body over 1 MB without forwarding it', async () => {
    const answer = await at(
      '/ingest/e/',
      { POSTHOG_KEY: KEY },
      { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) },
    );
    expect(answer.status).toBe(413);
    expect(sent).toEqual([]);
  });
});
