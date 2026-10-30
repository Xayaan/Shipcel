import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = [
  '/',
  '/features/',
  '/pricing/',
  '/why/',
  '/compare/',
  '/compare/vercel/',
  '/compare/supabase/',
  '/compare/netlify/',
  '/compare/firebase/',
  '/compare/render/',
  '/compare/railway/',
  '/compare/heroku/',
  '/compare/coolify/',
];

// The tour lives in R2 at media.shipcel.com (npm run media:publish); here the recording in
// media/ answers for it, so no journey needs the network or the upload.
test.beforeEach(async ({ page }) => {
  await page.route('https://media.shipcel.com/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({
      path: `media/${name}`,
      contentType: name.endsWith('.webm') ? 'video/webm' : 'image/webp',
    });
  });
});

test('the front page states the free plan and Cloudflare free limits, and leads to the dashboard', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'From side project to enterprise, on your own Cloudflare',
  );
  const free = page.getByRole('region', {
    name: 'What the free plan includes',
  });
  await expect(free).toContainText('Up to 100 projects');
  await expect(free).toContainText('100,000 requests a day');
  await expect(free).toContainText('instead of billing you');
  await page.getByRole('link', { name: 'Start free' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeVisible();
});

test('the front page demo pauses and stands still for reduced motion; the tour waits to be played', async ({
  page,
}) => {
  await page.goto('/');
  const production = page
    .locator('.demo-stage')
    .getByText('Production: https://shop.ada.workers.dev/');
  const site = page.locator('.demo-site');
  const playState = () =>
    site.evaluate((el) => getComputedStyle(el).animationPlayState);
  // It plays: the live address is printed within one loop.
  await expect(production).toBeVisible({ timeout: 20000 });
  const pause = page.getByLabel('Pause the animation');
  await pause.check();
  expect(await playState()).toBe('paused');
  await pause.uncheck();
  expect(await playState()).toBe('running');
  // Reduced motion: nothing moves, the whole story shows, and there is nothing to pause.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(pause).toBeHidden();
  expect(await site.evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'none',
  );
  await expect(production).toBeVisible();
  await expect(site).toBeVisible();
  await expect(page.locator('.demo-stats')).toBeVisible();
  // The tour: a poster until it's played, with its steps in words.
  await page.getByRole('link', { name: 'Watch the tour' }).click();
  await expect(page).toHaveURL(/#tour$/);
  const video = page.locator('#tour video');
  await expect(video).toHaveAttribute(
    'poster',
    'https://media.shipcel.com/tour.webp',
  );
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(page.locator('#tour-steps li')).toHaveCount(4);
  const decoded = await video.evaluate(async (v: HTMLVideoElement) => {
    v.preload = 'auto';
    v.load();
    await new Promise((resolve, reject) => {
      v.onloadeddata = resolve;
      v.onerror = () => reject(new Error('The tour video does not play.'));
    });
    return [v.videoWidth, v.videoHeight, Math.round(v.duration)];
  });
  expect(decoded.slice(0, 2)).toEqual([1280, 800]);
  expect(decoded[2]).toBeGreaterThan(20);
});

test('public pages are accessible, fit a phone screen, and link to each other', async ({
  page,
}) => {
  test.setTimeout(120000);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of pages) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${path} at ${width}px`,
      ).toBe(true);
      const a11y = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(a11y.violations, `${path} at ${width}px`).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Compare' })
    .click();
  await page.getByRole('link', { name: 'Vercel', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Shipcel vs Vercel',
  );
  await page.screenshot({
    path: 'docs/screenshots/site-compare-vercel-1440.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto('/');
  await page.screenshot({
    path: 'docs/screenshots/site-home-1440.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('unknown paths get a 404 page that leads home', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Page not found',
  );
  await expect(
    page.getByRole('link', { name: 'Go to the home page' }),
  ).toHaveAttribute('href', '/');
});

test('the docs: every guide is accessible, fits a phone, and leads to the next', async ({
  page,
}) => {
  test.setTimeout(180000);
  const docs = [
    '/docs/',
    ...[
      ...(await (await page.request.get('/docs/')).text()).matchAll(
        /href="(\/docs\/[a-z-]+\/)"/g,
      ),
    ].map((m) => m[1]),
  ].filter((path, i, all) => all.indexOf(path) === i);
  // The index and its 18 guides.
  expect(docs.length).toBe(19);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of docs) {
      expect((await page.goto(path))?.status(), path).toBe(200);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${path} at ${width}px`,
      ).toBe(true);
      const a11y = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(a11y.violations, `${path} at ${width}px`).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Docs' })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Shipcel docs',
  );
  await page
    .getByRole('link', { name: /^The shipcel CLI/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'The shipcel CLI',
  );
  await expect(
    page.getByRole('navigation', { name: 'Docs' }).getByRole('link', {
      name: 'The shipcel CLI',
    }),
  ).toHaveAttribute('aria-current', 'page');
  await page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Secrets' })
    .click();
  await expect(page).toHaveURL(/\/docs\/cli\/#secrets$/);
  await page
    .getByRole('navigation', { name: 'More guides' })
    .getByRole('link', { name: /Next/ })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Deploy from GitHub',
  );
  await page.screenshot({
    path: 'docs/screenshots/site-docs-1440.png',
    fullPage: true,
    animations: 'disabled',
  });
});
