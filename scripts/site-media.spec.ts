import {
  test,
  expect,
  type Browser,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// npm run site:media (playwright.media.config.ts): records the front page's tour,
// media/tour.webm, and its poster, media/tour.webp (site/home.ts; npm run media:publish puts them in R2). A walk
// through one project's dashboard: its builds and a build log, analytics, visitors, then
// the budget guard. Every answer that would come from Cloudflare is sample data here, so
// the video shows the dashboard, not anyone's account.

const OUT = 'media';
const SIZE = { width: 1280, height: 800 };
const NAME = 'storefront';
const HOST = 'storefront.ada.workers.dev';
const HOUR = 3600_000;
// Whole seconds, as Cloudflare's timestamps are.
const now = Math.floor(Date.now() / 1000) * 1000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000', '');
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// Hours ending now, busy in the afternoon (UTC) and quiet at night.
const hourly = (hours: number) =>
  Array.from({ length: hours }, (_, i) => {
    const at = Math.floor(now / HOUR) * HOUR - (hours - 1 - i) * HOUR;
    const wave =
      0.55 +
      0.45 * Math.sin(((new Date(at).getUTCHours() - 8) / 24) * 2 * Math.PI);
    return {
      at: iso(at),
      requests: Math.round(900 + 2600 * wave + ((i * 37) % 180)),
      errors: [0, 14, 3, 0, 22, 5][i % 6],
      wallP50: 34 + (i % 7) * 3,
      wallP99: 170 + (i % 5) * 32,
    };
  });

function analytics(range: string) {
  const series = hourly(range === '7d' ? 168 : 24);
  const requests = sum(series.map((s) => s.requests)),
    errors = sum(series.map((s) => s.errors));
  return {
    range,
    bucket: 'hour',
    totals: {
      requests,
      errors,
      subrequests: Math.round(requests * 0.4),
      cpuP50: 1.8,
      cpuP99: 7.4,
      wallP50: 41.2,
      wallP99: 236,
    },
    series,
    hours: series.map((s) => ({
      hour: s.at,
      requests: s.requests,
      errors: s.errors,
    })),
    statuses: { success: requests - errors, scriptThrewException: errors },
  };
}

function statusCodes() {
  const series = hourly(24).map(({ at, requests, errors }) => ({
    at,
    requests,
    errors,
  }));
  const total = sum(series.map((s) => s.requests)),
    errors = sum(series.map((s) => s.errors));
  return {
    hours: 24,
    codes: [
      { status: 200, requests: Math.round(total * 0.94) },
      { status: 304, requests: Math.round(total * 0.045) },
      { status: 404, requests: Math.round(total * 0.012) },
      { status: 500, requests: errors },
    ],
    series,
  };
}

const logEvents = [
  ['GET /', 200, 'log', 'Rendered / in 38 ms'],
  ['GET /api/products', 200, 'log', 'Loaded 24 products from D1'],
  ['POST /api/cart', 200, 'log', 'Cart updated: 2 items'],
  ['GET /products/linen-shirt', 200, 'log', 'Rendered /products/linen-shirt'],
  ['POST /api/checkout', 500, 'error', 'Error: payment provider timed out'],
  ['GET /api/products', 200, 'warn', 'Slow query: 412 ms'],
].map(([trigger, status, level, message], i) => ({
  id: `event-${i}`,
  timestamp: now - (i + 1) * 47_000,
  level,
  message,
  trigger,
  status,
  outcome: level === 'error' ? 'exception' : 'ok',
  requestId: `request-${i}`,
}));

const builds = {
  builds: [
    {
      build_uuid: 'b7c41e2a-5f1d-4c1e-9d0b-2f6a8e3c1a90',
      branch: 'main',
      status: 'running',
      created_at: iso(now - 40_000),
    },
    {
      build_uuid: '5d0f93c1-8a2b-4e6f-b1c3-7d9e0f2a4b68',
      branch: 'checkout-redesign',
      preview: true,
      build_outcome: 'success',
      created_at: iso(now - 2 * HOUR),
    },
    {
      build_uuid: '9a21b6e4-3c5d-4f7a-8b9c-0d1e2f3a4b5c',
      branch: 'main',
      build_outcome: 'success',
      created_at: iso(now - 26 * HOUR),
      health: 'healthy',
      health_detail: `The homepage returned HTTP 200 (https://${HOST}/).`,
    },
  ],
  nextPage: null,
};
// The running build's log, a page per poll.
const buildLog = [
  [
    'Cloning repository...',
    'Detected a Next.js app',
    'Installing dependencies: npm ci',
    'added 412 packages in 18s',
  ],
  [
    'Building: npx opennextjs-cloudflare build',
    'Creating an optimized production build ...',
    '✓ Compiled successfully',
    '✓ Generating static pages (12/12)',
  ],
  [
    'Uploading 64 new assets…',
    'Deploying to Cloudflare Workers',
    `Success: deployed ${NAME}`,
  ],
];
function logPage(cursor: string | null) {
  const index = cursor ? Number(cursor.slice(1)) : 0;
  const lines = buildLog[index] ?? [];
  const done = index >= buildLog.length - 1;
  return {
    lines: lines.map((text, i) => ({
      at: Math.floor(now / 1000) + index * 9 + i,
      text,
    })),
    cursor: `c${index + 1}`,
    done,
    outcome: done ? 'success' : null,
  };
}

const versions = [
  ['Checkout redesign', 2, 100],
  ['Faster product pages', 26, null],
  ['Add a newsletter sign-up', 74, null],
].map(([message, hoursAgo, live], i) => ({
  id: `0000000${i + 1}-1111-4222-8333-444455556666`,
  number: 12 - i,
  createdAt: iso(now - Number(hoursAgo) * HOUR),
  message,
  live,
}));

function visitors(range: string) {
  const series = hourly(24).map((s) => ({
    at: s.at,
    pageViews: Math.round(s.requests * 0.42),
    visits: Math.round(s.requests * 0.17),
  }));
  const pageViews = sum(series.map((s) => s.pageViews));
  const share = (part: number) => Math.round(pageViews * part);
  return {
    site: { tag: 'site', wholeZone: false, beacon: null },
    hosts: [HOST],
    setup: 'https://dash.cloudflare.com/',
    range,
    bucket: 'hour',
    totals: { pageViews, visits: sum(series.map((s) => s.visits)) },
    series,
    pages: [
      ['/', 0.31],
      ['/products/linen-shirt', 0.12],
      ['/products', 0.1],
      ['/cart', 0.07],
      ['/checkout', 0.04],
    ].map(([name, part]) => ({ name, views: share(Number(part)) })),
    referrers: [
      ['google.com', 0.18],
      ['news.ycombinator.com', 0.06],
      ['instagram.com', 0.04],
      ['duckduckgo.com', 0.02],
    ].map(([name, part]) => ({ name, views: share(Number(part)) })),
    countries: [
      ['US', 0.34],
      ['GB', 0.12],
      ['DE', 0.09],
      ['IN', 0.08],
      ['CA', 0.06],
    ].map(([name, part]) => ({ name, views: share(Number(part)) })),
    devices: [
      ['mobile', 0.58],
      ['desktop', 0.38],
      ['tablet', 0.04],
    ].map(([name, part]) => ({ name, views: share(Number(part)) })),
    browsers: [
      ['Chrome', 0.52],
      ['Safari', 0.33],
      ['Firefox', 0.07],
      ['Edge', 0.05],
    ].map(([name, part]) => ({ name, views: share(Number(part)) })),
    vitals: {
      lcp: {
        p75: 1840,
        good: 4120,
        needsImprovement: 410,
        poor: 90,
        total: 4620,
      },
      inp: {
        p75: 96,
        good: 3880,
        needsImprovement: 200,
        poor: 40,
        total: 4120,
      },
      cls: {
        p75: 0.03,
        good: 4400,
        needsImprovement: 180,
        poor: 40,
        total: 4620,
      },
    },
  };
}

// The budget guard mid-month: $10 beyond what Workers Paid includes, alerts only, and well
// under it.
function budget() {
  const today = new Date(now);
  const month = today.toISOString().slice(0, 7);
  const days = Array.from(
    { length: today.getUTCDate() },
    (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`,
  );
  const requests = days.map((_, i) => 960_000 + ((i * 53_000) % 210_000));
  const rows = days.map((_, i) => 2_400_000 + ((i * 310_000) % 700_000));
  let seen = 0;
  const cents = requests.map((r) => {
    seen += r;
    return Math.round((Math.max(0, seen - 10_000_000) / 1e6) * 30);
  });
  const estimate = cents.at(-1) ?? 0;
  return {
    budget: { monthlyCents: 1000, onExceed: 'alert' },
    deployed: true,
    webhook: true,
    plan: { plan: 'paid', source: 'usage', detail: null },
    notEstimated: 'Stored data and Workers CPU time aren’t in the estimate.',
    labels: {
      'workers.requests': 'Workers requests',
      'd1.rowsWritten': 'D1 rows written',
    },
    limits: {
      'workers.requests': { included: 10_000_000, freeDaily: 100_000 },
      'd1.rowsWritten': { included: 50_000_000, freeDaily: 100_000 },
    },
    check: {
      month,
      plan: 'paid',
      estimateCents: estimate,
      projectedCents: Math.round((estimate / days.length) * 31 * 1.6),
      accountCents: estimate,
      meters: [
        {
          meter: 'workers.requests',
          label: 'Workers requests',
          mine: sum(requests),
          account: sum(requests),
          included: 10_000_000,
          cents: estimate,
        },
        {
          meter: 'd1.rowsWritten',
          label: 'D1 rows written',
          mine: sum(rows),
          account: sum(rows),
          included: 50_000_000,
          cents: 0,
        },
      ],
      missing: [],
      daily: {
        days,
        meters: { 'workers.requests': requests, 'd1.rowsWritten': rows },
        cents,
      },
      level: 0,
      state: 'ok',
      checkedAt: Math.floor(now / 1000) - 90,
      readAt: Math.floor(now / 1000) - 90,
      error: null,
    },
  };
}

// What Shipcel's API would have read from Cloudflare for this project.
function sample(path: string, query: URLSearchParams): unknown {
  const range = query.get('range') ?? '24h';
  if (path.startsWith('/builds/') && path.endsWith('/logs'))
    return logPage(query.get('cursor'));
  const answers: Record<string, () => unknown> = {
    '/deployments': () => [
      {
        id: 'job',
        status: 'deployed',
        environment: 'production',
        adapter: 'configured-worker',
        branch: 'main',
        live_url: `https://${HOST}/`,
      },
    ],
    '/operations': () => [],
    '/previews': () => ({ status: 'off' }),
    '/cloud': () => ({
      worker: NAME,
      accountId: 'a'.repeat(32),
      dashboardUrl: 'https://dash.cloudflare.com/',
      bindings: [
        { name: 'DB', type: 'd1', id: '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8' },
        {
          name: 'SESSIONS',
          type: 'kv_namespace',
          namespace_id: 'b'.repeat(32),
        },
      ],
    }),
    '/builds': () => builds,
    '/versions': () => versions,
    '/analytics': () => analytics(range),
    '/status-codes': () => statusCodes(),
    '/logs': () => ({
      events:
        query.get('errors') === '1'
          ? logEvents.filter((e) => e.level === 'error')
          : logEvents,
    }),
    '/web-analytics': () => visitors(range),
    '/budget': () => budget(),
  };
  return answers[path]?.();
}

async function answer(route: Route, root: string) {
  const url = new URL(route.request().url());
  const data =
    route.request().method() === 'GET'
      ? sample(url.pathname.slice(root.length), url.searchParams)
      : undefined;
  return data === undefined ? route.continue() : route.fulfill({ json: data });
}

// A pointer that follows the mouse, a caption at the bottom (Playwright's video shows
// neither by itself) and a title card, which also covers the dashboard while it loads.
function overlay(logo: string) {
  const build = () => {
    const card = document.createElement('div');
    card.id = 'tour-card';
    Object.assign(card.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483645',
      display: 'grid',
      placeItems: 'center',
      background: '#143a2e',
      color: '#fff',
      textAlign: 'center',
      pointerEvents: 'none',
      transition: 'opacity 0.5s',
    });
    card.innerHTML = `<div><div style="display:flex;align-items:center;justify-content:center;gap:16px;font:800 48px/1 Manrope,system-ui,sans-serif">${logo.replace('width="32" height="32"', 'width="56" height="56"')}Shipcel</div><p id="tour-card-title" style="margin:28px 0 0;font:600 28px/1.3 'DM Sans',system-ui,sans-serif">A tour of the dashboard</p><p id="tour-card-line" style="margin:12px 0 0;color:#c9ee9e;font:500 19px/1.4 'DM Sans',system-ui,sans-serif">With sample data</p></div>`;
    document.body.appendChild(card);
    const pointer = document.createElement('div');
    pointer.id = 'tour-pointer';
    pointer.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3l14 9-7 1.2L9 20z" fill="#fff" stroke="#143a2e" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(pointer.style, {
      position: 'fixed',
      left: '-40px',
      top: '-40px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.35))',
    });
    const caption = document.createElement('div');
    caption.id = 'tour-caption';
    Object.assign(caption.style, {
      position: 'fixed',
      left: '50%',
      bottom: '28px',
      transform: 'translateX(-50%)',
      zIndex: '2147483646',
      pointerEvents: 'none',
      padding: '11px 20px',
      borderRadius: '999px',
      background: 'rgb(20 58 46 / 0.94)',
      color: '#fff',
      font: '600 18px/1.3 "DM Sans", system-ui, sans-serif',
      whiteSpace: 'nowrap',
      boxShadow: '0 12px 30px -12px rgb(0 0 0 / 0.45)',
      opacity: '0',
      transition: 'opacity 0.3s',
    });
    document.body.appendChild(pointer);
    document.body.appendChild(caption);
    addEventListener(
      'mousemove',
      (e) => {
        pointer.style.left = `${e.clientX - 4}px`;
        pointer.style.top = `${e.clientY - 2}px`;
      },
      true,
    );
  };
  // As soon as there is a body: the dashboard's scripts take a moment in development.
  if (document.body) build();
  else
    new MutationObserver((_, watcher) => {
      if (!document.body) return;
      watcher.disconnect();
      build();
    }).observe(document, { childList: true, subtree: true });
}

async function say(page: Page, text: string) {
  await page.evaluate((t) => {
    const caption = document.getElementById('tour-caption');
    if (!caption) throw new Error('No caption overlay');
    caption.textContent = t;
    caption.style.opacity = t ? '1' : '0';
  }, text);
}
async function titleCard(page: Page, text: [string, string] | null) {
  await page.evaluate((t) => {
    const card = document.getElementById('tour-card');
    if (!card) throw new Error('No title card');
    if (t) {
      document.getElementById('tour-card-title')!.textContent = t[0];
      document.getElementById('tour-card-line')!.textContent = t[1];
    }
    card.style.opacity = t ? '1' : '0';
  }, text);
  await page.waitForTimeout(600);
}
async function into(target: Locator, block: 'start' | 'center' = 'center') {
  await target.evaluate(
    (el, b) => el.scrollIntoView({ behavior: 'smooth', block: b }),
    block,
  );
  await target.page().waitForTimeout(800);
}
async function point(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('Nothing to point at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 20,
  });
  await page.waitForTimeout(300);
}
async function press(page: Page, target: Locator) {
  await point(page, target);
  await target.click();
  await page.waitForTimeout(800);
}

async function openContext(browser: Browser, root: string, video?: string) {
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    ...(video ? { recordVideo: { dir: video, size: SIZE } } : {}),
  });
  await context.route(`**${root}/**`, (route) => answer(route, root));
  return context;
}

test('records the front page tour and its poster', async ({
  browser,
  request,
}) => {
  const listed = (await (await request.get('/api/projects')).json()) as {
    id: string;
    name: string;
  }[];
  for (const p of listed.filter((p) => p.name === NAME))
    await request.delete(`/api/projects/${p.id}`);
  const created = await request.post('/api/projects', {
    data: {
      name: NAME,
      framework: 'nextjs',
      repository: 'https://github.com/ada/storefront',
      database: true,
      storage: false,
    },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: string };
  const root = `/api/projects/${project.id}`;
  const manage = `/app/#projects/${project.id}/operations`;
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  try {
    const context = await openContext(
      browser,
      root,
      test.info().outputPath('video'),
    );
    await context.addInitScript(
      overlay,
      readFileSync('public/favicon.svg', 'utf8'),
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<body style="margin:0;background:#143a2e"></body>');
    await page.goto(manage);
    await expect(
      page.getByRole('heading', { name: NAME, exact: true }),
    ).toBeVisible();
    await page.mouse.move(640, 300);
    await page.waitForTimeout(1800);
    await titleCard(page, null);

    // 1. Builds, with a log as it runs, and versions to roll back to.
    await say(page, 'Every push builds and deploys, with a live log');
    await press(
      page,
      page.getByRole('button', { name: 'Builds & versions', exact: true }),
    );
    await expect(page.getByText('b7c41e2a')).toBeVisible();
    await press(
      page,
      page.getByRole('button', { name: 'Logs', exact: true }).first(),
    );
    await into(page.locator('.build-log'));
    await expect(page.getByText(`Success: deployed ${NAME}`)).toBeVisible({
      timeout: 15000,
    });
    await page.waitForTimeout(900);
    await say(page, 'Every deploy is a version: roll back in one click');
    const rollback = page.getByRole('button', {
      name: /^Roll back to Version 11/,
    });
    await into(rollback);
    await point(page, rollback);
    await page.waitForTimeout(1500);

    // 2. Analytics and logs.
    const analyticsTab = page.getByRole('button', {
      name: 'Analytics & logs',
      exact: true,
    });
    await into(analyticsTab);
    await say(page, 'Requests, errors and response times');
    await press(page, analyticsTab);
    await expect(page.locator('.stat').first()).toBeVisible();
    await page.waitForTimeout(1400);
    await press(page, page.getByRole('button', { name: 'Last 7 days' }));
    await page.waitForTimeout(1200);
    await into(page.getByText('HTTP status codes', { exact: true }), 'start');
    await page.waitForTimeout(900);
    await say(page, 'Logs, searchable and live');
    await into(page.getByText('Error: payment provider timed out'));
    await page.waitForTimeout(1600);

    // 3. Visitors.
    const visitorsTab = page.getByRole('button', {
      name: 'Visitors',
      exact: true,
    });
    await into(visitorsTab);
    await say(page, 'Visitors, top pages and Core Web Vitals');
    await press(page, visitorsTab);
    await expect(
      page.locator('.stat', { hasText: 'Page views per visit' }),
    ).toBeVisible();
    await page.waitForTimeout(1400);
    await into(page.getByRole('heading', { name: 'Core Web Vitals' }));
    await page.waitForTimeout(1800);

    // 4. The budget guard.
    const overview = page
      .locator('.tabs')
      .getByRole('button', { name: 'Overview', exact: true });
    await into(overview);
    await say(page, 'A budget for every app, with alerts');
    await press(page, overview);
    const guard = page.getByRole('heading', { name: 'Budget guard' });
    await expect(guard).toBeVisible();
    await into(guard, 'start');
    await page.waitForTimeout(1800);
    await into(page.getByRole('heading', { name: 'This month, day by day' }));
    await page.waitForTimeout(1600);
    const amount = page.getByLabel(
      'Monthly budget beyond what Cloudflare includes, in dollars',
    );
    await into(amount);
    await press(page, amount);
    await amount.fill('');
    await amount.pressSequentially('25', { delay: 160 });
    await page.waitForTimeout(600);
    await point(page, page.getByRole('radio', { name: /^Pause the app/ }));
    await say(page, 'Alert only, or pause an app that goes over');
    await page.waitForTimeout(2200);
    await say(page, '');
    await titleCard(page, [
      'Free, in your own Cloudflare account',
      'Start on Cloudflare’s free plan',
    ]);
    await page.waitForTimeout(2400);
    await context.close();
    copyFileSync(await page.video()!.path(), `${OUT}/tour.webm`);

    // The poster: the analytics view, without the pointer or a caption.
    const still = await openContext(browser, root);
    const view = await still.newPage();
    await view.goto(manage);
    await view
      .getByRole('button', { name: 'Analytics & logs', exact: true })
      .click();
    await expect(view.locator('.stat').first()).toBeVisible();
    await view.waitForTimeout(800);
    const png = Buffer.from(await view.screenshot()).toString('base64');
    const webp = await view.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', 0.86).split(',')[1];
    }, png);
    writeFileSync(`${OUT}/tour.webp`, Buffer.from(webp, 'base64'));
    await still.close();
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
