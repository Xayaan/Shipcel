import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { now } from '../worker/types';

// Manage → Visitors: Cloudflare Web Analytics for the app. Shipcel finds the Web Analytics
// site for the app's addresses (the owner adds it in Cloudflare) and reads page views,
// visits, top lists and Core Web Vitals from GraphQL. Cloudflare is faked here.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>,
  projectId: string;
const account = 'a'.repeat(32),
  tag = 'c'.repeat(32),
  worker = 'cc-test-app-worker',
  host = `${worker}.ada.workers.dev`;
const calls: { url: string; body: unknown }[] = [];
let sites: unknown[], graphql: unknown, sitesStatus: number;
const cf = (result: unknown, info?: Record<string, unknown>) =>
  Response.json({
    success: true,
    result,
    ...(info ? { result_info: info } : {}),
  });
const request = (path: string, cookie = who.cookie) =>
  db.request(`/projects/${projectId}${path}`, {}, cookie);
const group = (count: number, dimensions?: Record<string, string>) => ({
  count,
  sum: { visits: Math.round(count / 2) },
  ...(dimensions ? { dimensions } : {}),
});

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput()) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const row = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: account,
    repository_id: '50',
    repository_name: 'alice/sample',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: worker,
    build_command: '',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: tag,
  };
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${Object.keys(row).join(',')}) VALUES (${Object.keys(
        row,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(row));
  calls.length = 0;
  sitesStatus = 200;
  sites = [
    {
      site_tag: 'site-other',
      site_token: 'token-other',
      rules: [{ host: 'someone-else.example' }],
    },
    {
      site_tag: 'site-app',
      site_token: 'token-app',
      auto_install: false,
      rules: [{ host }],
    },
  ];
  graphql = {
    data: {
      viewer: {
        accounts: [
          {
            total: [group(1200)],
            series: [
              group(700, { datetimeHour: '2026-10-15T09:00:00Z' }),
              group(500, { datetimeHour: '2026-10-15T10:00:00Z' }),
            ],
            pages: [
              group(900, { requestPath: '/' }),
              group(300, { requestPath: '/pricing' }),
            ],
            referrers: [
              group(400, { refererHost: host }),
              group(200, { refererHost: 'news.ycombinator.com' }),
              group(50, { refererHost: '' }),
            ],
            countries: [group(800, { countryName: 'IN' })],
            devices: [group(1000, { deviceType: 'desktop' })],
            browsers: [group(700, { userAgentBrowser: 'Chrome' })],
            vitals: [
              {
                count: 300,
                sum: {
                  lcpGood: 240,
                  lcpNeedsImprovement: 40,
                  lcpPoor: 20,
                  lcpTotal: 300,
                  inpGood: 100,
                  inpNeedsImprovement: 0,
                  inpPoor: 0,
                  inpTotal: 100,
                  clsGood: 290,
                  clsNeedsImprovement: 10,
                  clsPoor: 0,
                  clsTotal: 300,
                },
                // Microseconds for LCP and INP; negative means no value.
                quantiles: {
                  largestContentfulPaintP75: 2_140_000,
                  interactionToNextPaintP75: -1,
                  cumulativeLayoutShiftP75: 0.04,
                },
              },
            ],
          },
        ],
      },
    },
    errors: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string | URL | Request, init: RequestInit = {}) => {
      const url = String(raw),
        path = new URL(url).pathname.replace('/client/v4', '');
      calls.push({
        url,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      const root = `/accounts/${account}`;
      if (path === `${root}/workers/scripts`) return cf([{ id: worker, tag }]);
      if (path === `${root}/workers/subdomain`) return cf({ subdomain: 'ada' });
      if (path === `${root}/workers/domains`)
        return cf([
          { hostname: 'Shop.Example.com', service: worker, zone_id: 'z' },
          {
            hostname: 'blog.example.com',
            service: 'another-app',
            zone_id: 'z',
          },
        ]);
      if (path === `${root}/rum/site_info/list`)
        return sitesStatus === 200
          ? cf(sites, { total_count: sites.length })
          : Response.json(
              { success: false, errors: [{ code: 10000, message: 'nope' }] },
              { status: sitesStatus },
            );
      if (path === '/graphql') return Response.json(graphql);
      throw new Error(`Unexpected ${url}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('visitors', () => {
  it('explains how to add a Web Analytics site when the app has none', async () => {
    sites = [sites[0]];
    const response = await request('/web-analytics?range=24h');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      site: null,
      hosts: [host, 'shop.example.com'],
      setup: `https://dash.cloudflare.com/${account}/web-analytics`,
    });
    expect(calls.some((c) => c.url.endsWith('/graphql'))).toBe(false);
  });

  it('reads page views, visits, top lists and Core Web Vitals for the app’s site', async () => {
    const response = await request('/web-analytics?range=24h');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      site: {
        tag: 'site-app',
        wholeZone: false,
        beacon: `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "token-app"}'></script>`,
      },
      range: '24h',
      bucket: 'hour',
      totals: { pageViews: 1200, visits: 600 },
      series: [
        { at: '2026-10-15T09:00:00Z', pageViews: 700, visits: 350 },
        { at: '2026-10-15T10:00:00Z', pageViews: 500, visits: 250 },
      ],
      pages: [
        { name: '/', views: 900 },
        { name: '/pricing', views: 300 },
      ],
      // The app linking to itself, and no referrer at all, aren't referrers.
      referrers: [{ name: 'news.ycombinator.com', views: 200 }],
      countries: [{ name: 'IN', views: 800 }],
      devices: [{ name: 'desktop', views: 1000 }],
      browsers: [{ name: 'Chrome', views: 700 }],
      vitals: {
        lcp: {
          p75: 2140,
          good: 240,
          needsImprovement: 40,
          poor: 20,
          total: 300,
        },
        inp: { p75: null, good: 100, total: 100 },
        cls: { p75: 0.04, good: 290, needsImprovement: 10, total: 300 },
      },
    });
    const sent = calls.find((c) => c.url.endsWith('/graphql'))!.body as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(sent.variables).toMatchObject({
      account,
      site: 'site-app',
      hosts: [host, 'shop.example.com'],
    });
    const span =
      Date.parse(String(sent.variables.until)) -
      Date.parse(String(sent.variables.since));
    expect(span).toBe(24 * 3600 * 1000);
    // Bots aren't counted, nor addresses that aren't the app's.
    expect(sent.query).toContain('requestHost_in: $hosts');
    expect(sent.query).toContain('bot: 0');
    expect(sent.query).toContain('orderBy: [datetimeHour_ASC]');
    expect(sent.query).toContain('rumWebVitalsEventsAdaptiveGroups');
  });

  it('finds a site made for the zone a custom domain is in, and goes by day over a month', async () => {
    sites = [
      {
        site_tag: 'site-zone',
        site_token: 'token-zone',
        auto_install: true,
        ruleset: { zone_name: 'example.com', enabled: true },
        rules: [],
      },
    ];
    const response = await request('/web-analytics?range=30d');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      site: { tag: 'site-zone', wholeZone: true },
      bucket: 'day',
    });
    const sent = calls.find((c) => c.url.endsWith('/graphql'))!.body as {
      query: string;
    };
    expect(sent.query).toContain('orderBy: [date_ASC]');
    expect(sent.query).toContain('dimensions { date }');
  });

  it('passes on what Cloudflare says, and stays inside the workspace', async () => {
    graphql = { data: null, errors: [{ message: 'not authorized' }] };
    const failed = await request('/web-analytics?range=24h');
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain('not authorized');
    sitesStatus = 403;
    const denied = await request('/web-analytics?range=24h');
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('Reconnect Cloudflare');
    expect((await request('/web-analytics?range=1y')).status).toBe(400);
    const other = await db.user(2);
    expect(
      (await request('/web-analytics?range=24h', other.cookie)).status,
    ).toBe(404);
  });
});
