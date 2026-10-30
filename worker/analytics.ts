import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv, Env } from './types';

// Shipcel's own visitor analytics, with PostHog. /analytics.js loads PostHog on the public site
// and starts it cookieless: nothing is stored in the browser, and PostHog counts visitors with a
// daily server-side hash. On the dashboard, whose pages show tokens and secret values, no
// third-party script runs at all: /analytics.js gives it a small sender of Shipcel's own, which
// posts page views and a few named events the same cookieless way. Every request goes through
// /ingest on this origin, so the Content-Security-Policy stays 'self' and blockers of PostHog's
// hosts don't stop them; /ingest forwards only what PostHog's loader asks for, as PostHog's
// Cloudflare proxy guide does, with the visitor's address and without their cookies or
// credentials. Without POSTHOG_KEY nothing loads, so a Shipcel on someone's computer, or in
// tests, sends nothing anywhere.
export const analytics = new Hono<AppEnv>();

const MAX_BODY = 1024 * 1024;
// Cloudflare's cache for this location (the DOM's CacheStorage type, also in scope, lacks it).
const edgeCache = () => (caches as unknown as { default: Cache }).default;
// What PostHog's loader asks for, and nothing else: its scripts, this project's remote settings,
// and the endpoints events and flags go to. Anything else on PostHog's hosts (other projects'
// site apps, say) stays off this origin.
const SCRIPT = /^\/static\/[\w.-]+(?:\/[\w.-]+)*\.js(?:\.map)?$/;
const EVENTS = new Set(['/e/', '/i/v0/e/', '/batch/', '/flags/', '/decide/']);
// The request headers PostHog needs; the rest, credentials included, never leave this origin.
const REQUEST_HEADERS = [
  'Accept',
  'Accept-Language',
  'Content-Type',
  'Origin',
  'Referer',
  'User-Agent',
];
// The response headers a browser needs; PostHog's own policies (HSTS, CORS) stay PostHog's.
const RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Cache-Control',
  'ETag',
  'Last-Modified',
];

function posthog(env: Env) {
  const key = env.POSTHOG_KEY;
  // A project key is public, but it goes into a script: only its own characters are allowed.
  if (!key || !/^phc_[A-Za-z0-9]{20,}$/.test(key)) return null;
  const region = env.POSTHOG_REGION?.toLowerCase() === 'eu' ? 'eu' : 'us';
  return {
    key,
    api: `${region}.i.posthog.com`,
    assets: `${region}-assets.i.posthog.com`,
    ui: `https://${region}.posthog.com`,
  };
}

// The public site: PostHog's own script, cookieless, no recordings or surveys.
const siteLoader = (ph: NonNullable<ReturnType<typeof posthog>>) => {
  const config = {
    ui_host: ph.ui,
    defaults: '2026-08-30',
    cookieless_mode: 'always',
    disable_session_recording: true,
    disable_surveys: true,
    capture_exceptions: true,
    autocapture: true,
  };
  return `// PostHog for this site, cookieless and sent through /ingest (Shipcel's worker/analytics.ts).
(function () {
  if (window.posthog && window.posthog.__loaded) return;
  var config = ${JSON.stringify(config)};
  // The page's own address, whichever it was reached at: its security policy allows no other.
  config.api_host = location.origin + '/ingest';
  var script = document.createElement('script');
  script.src = '/ingest/static/array.js';
  script.async = true;
  script.onload = function () {
    window.posthog.init(${JSON.stringify(ph.key)}, config);
  };
  document.head.appendChild(script);
})();
`;
};

// The dashboard: no third-party script. A page view at load, then the events src/posthog.ts
// sends, each cookieless the way PostHog's own script marks them, with nothing that identifies
// anyone and never the address's fragment, which carries sign-in and invitation codes.
const dashboardSender = (ph: NonNullable<ReturnType<typeof posthog>>) =>
  `// Shipcel's own sender for the dashboard: cookieless events through /ingest, no third-party script.
(function () {
  if (window.__shipcelAnalytics) return;
  var key = ${JSON.stringify(ph.key)};
  var send = function (event, properties) {
    try {
      var body = JSON.stringify({
        api_key: key,
        event: event,
        distinct_id: '$posthog_cookieless',
        timestamp: new Date().toISOString(),
        properties: Object.assign(
          {
            $cookieless_mode: true,
            $lib: 'shipcel-dashboard',
            $current_url: location.origin + location.pathname,
            $host: location.host,
            $pathname: location.pathname,
          },
          properties || {},
        ),
      });
      var url = location.origin + '/ingest/e/';
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  };
  window.__shipcelAnalytics = { send: send };
  send('$pageview');
})();
`;

analytics.get('/analytics.js', (c) => {
  const headers = {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  };
  const ph = posthog(c.env);
  if (!ph) return c.body('', 200, headers);
  return c.body(
    `(function () {
  var dashboard = location.pathname === '/app' || location.pathname.indexOf('/app/') === 0;
  if (dashboard) {
${dashboardSender(ph)}
  } else {
${siteLoader(ph)}
  }
})();
`,
    200,
    headers,
  );
});

analytics.use(
  '/ingest/*',
  bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => c.text('Request too large.', 413),
  }),
);

analytics.all('/ingest/*', async (c) => {
  const ph = posthog(c.env);
  const url = new URL(c.req.url);
  // Hono matched the decoded path; the raw one must spell it the same way.
  if (!ph || !url.pathname.startsWith('/ingest/'))
    return c.text('Not found.', 404);
  const path = url.pathname.slice('/ingest'.length);
  const method = c.req.method;
  // PostHog's scripts and remote settings come from its asset host, events go to its API host.
  const toAssets =
    SCRIPT.test(path) ||
    path === `/array/${ph.key}/config` ||
    path === `/array/${ph.key}/config.js`;
  const allowed = toAssets
    ? method === 'GET' || method === 'HEAD'
    : EVENTS.has(path) && method === 'POST';
  if (!allowed) return c.text('Not found.', 404);
  const target = `https://${toAssets ? ph.assets : ph.api}${path}${url.search}`;
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  // Bodies PostHog had compressed came out of the runtime compressed twice, and broke as scripts:
  // they come uncompressed, and Cloudflare's edge compresses them for the browser itself.
  headers.set('Accept-Encoding', 'identity');
  // PostHog places visitors, and counts them cookieless, by their address.
  const ip = c.req.header('CF-Connecting-IP');
  if (ip) headers.set('X-Forwarded-For', ip);
  const cache = toAssets && method === 'GET' && typeof caches !== 'undefined';
  if (cache) {
    const hit = await edgeCache()
      .match(c.req.url)
      .catch(() => undefined);
    if (hit) return hit;
  }
  const answer = await fetch(target, {
    method,
    headers,
    body: method === 'POST' ? await c.req.arrayBuffer() : undefined,
    redirect: 'manual',
  });
  const kept = new Headers({ 'X-Content-Type-Options': 'nosniff' });
  for (const name of RESPONSE_HEADERS) {
    const value = answer.headers.get(name);
    if (value) kept.set(name, value);
  }
  const response = new Response(answer.body, {
    status: answer.status,
    headers: kept,
  });
  if (cache && answer.ok)
    c.executionCtx.waitUntil(
      edgeCache()
        .put(c.req.url, response.clone())
        .catch(() => {}),
    );
  return response;
});
