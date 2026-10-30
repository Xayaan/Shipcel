import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Overview → Billing → Budget guard: the budget and what happens over it, then a paused app
// (Cloudflare's side is answered by the test) resumed after confirmation.

const violations = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;

const view = (state: 'ok' | 'paused') => ({
  budget: { monthlyCents: 2500, onExceed: 'pause' },
  deployed: true,
  webhook: false,
  plan: { plan: 'paid', source: 'usage', detail: null },
  notEstimated:
    'Stored data, Workers CPU time, and storage operations of Durable Objects that use key-value storage (not SQLite) aren’t in the estimate.',
  labels: {
    'd1.rowsRead': 'D1 rows read',
    'd1.rowsWritten': 'D1 rows written',
    'do.requests': 'Durable Object requests and alarms',
    'do.rowsWritten': 'Durable Object rows written',
  },
  limits: {
    'do.requests': { included: 1_000_000, freeDaily: 100_000 },
    'do.rowsWritten': { included: 50_000_000, freeDaily: 100_000 },
  },
  check: {
    month: '2026-10',
    plan: 'paid',
    estimateCents: 10600,
    projectedCents: 900000,
    accountCents: 12000,
    meters: [
      {
        meter: 'do.requests',
        label: 'Durable Object requests and alarms',
        mine: 41_000_000,
        account: 41_000_000,
        included: 1_000_000,
        cents: 600,
      },
      {
        meter: 'do.rowsWritten',
        label: 'Durable Object rows written',
        mine: 150_000_000,
        account: 150_000_000,
        included: 50_000_000,
        cents: 10000,
      },
    ],
    missing: [
      { meters: ['d1.rowsRead', 'd1.rowsWritten'], reason: 'unknown field' },
    ],
    // A loop that started on the 14th.
    daily: {
      days: ['2026-10-13', '2026-10-14', '2026-10-15'],
      meters: {
        'do.requests': [20_000, 15_000_000, 26_000_000],
        'do.rowsWritten': [1_000, 60_000_000, 90_000_000],
      },
      cents: [0, 3210, 10600],
    },
    level: 100,
    state,
    checkedAt: Math.floor(Date.now() / 1000) - 120,
    readAt: Math.floor(Date.now() / 1000) - 120,
    error: null,
  },
});

test('sets a budget, shows a paused app, and resumes it after confirmation', async ({
  page,
  request,
}) => {
  const name = `qa-budget-${Date.now()}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let id = '';
  try {
    await page.goto('/app/');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page.getByLabel('Project name', { exact: true }).fill(name);
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .last()
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    id = (
      (await (await request.get('/api/projects')).json()) as {
        id: string;
        name: string;
      }[]
    ).find((p) => p.name === name)!.id;
    // The default: $0 beyond what Cloudflare includes, alerts only.
    await expect(
      page.getByRole('heading', { name: 'Budget guard' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Nothing is deployed yet. The guard starts with the first deploy.',
      ),
    ).toBeVisible();
    const amount = page.getByLabel(
      'Monthly budget beyond what Cloudflare includes, in dollars',
    );
    await expect(amount).toHaveValue('0');
    await expect(
      page.getByRole('radio', { name: /^Alert only/ }),
    ).toBeChecked();
    await amount.fill('25');
    await page.getByRole('radio', { name: /^Pause the app/ }).check();
    await page.getByRole('button', { name: 'Save budget' }).click();
    await expect(page.locator('.toast')).toHaveText('Budget saved.');
    expect(
      (
        (await (await request.get(`/api/projects/${id}/budget`)).json()) as {
          budget: unknown;
        }
      ).budget,
    ).toEqual({ monthlyCents: 2500, onExceed: 'pause' });

    // Deployed, over the budget and paused (Cloudflare's side answered here).
    let state: 'ok' | 'paused' = 'paused';
    let resumed = 0;
    await page.route(`**/api/projects/${id}/budget`, (route) =>
      route.fulfill({ json: view(state) }),
    );
    await page.route(`**/api/projects/${id}/budget/resume`, async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({ confirm: true });
      resumed += 1;
      state = 'ok';
      await route.fulfill({ json: view('ok') });
    });
    await page.goto(`/app/#projects/${id}`);
    const alert = page.locator('.budget-alert.paused');
    await expect(alert).toContainText('Paused for going over its budget.');
    await expect(
      page.getByRole('row', { name: /Durable Object rows written/ }),
    ).toContainText('$100.00');
    await expect(page.getByText('Workers Paid', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/Cloudflare didn’t report D1 rows read, D1 rows written/),
    ).toBeVisible();
    await expect(
      page.getByText(/add a webhook in Manage → Notifications/),
    ).toBeVisible();
    // Day by day: what the month had cost by each day, then one meter's use.
    await expect(
      page.getByRole('heading', { name: 'This month, day by day' }),
    ).toBeVisible();
    await page.getByText('Estimated cost so far, by day').click();
    await expect(
      page.getByRole('region', { name: 'Estimated cost so far, by day' }),
    ).toContainText('$32.10');
    const usage = page.getByRole('combobox', { name: 'Usage' });
    await expect(usage).toHaveValue('do.requests');
    await usage.selectOption('do.rowsWritten');
    await page.getByText('Durable Object rows written, by day').click();
    await expect(
      page.getByRole('region', {
        name: 'Durable Object rows written, by day',
      }),
    ).toContainText('90,000,000');
    await expect(
      page.getByText(/Workers Paid includes 50,000,000 a month/),
    ).toBeVisible();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await violations(page)).toEqual([]);
      await page.locator('.budget-guard').screenshot({
        path: `docs/screenshots/budget-${width}.png`,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Resuming asks first, and can be cancelled.
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByText(/^Resume this app\?/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(resumed).toBe(0);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.getByRole('button', { name: 'Resume the app' }).click();
    await expect(page.locator('.toast')).toHaveText(
      'The app is running again.',
    );
    expect(resumed).toBe(1);
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pause now' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (id) await request.delete(`/api/projects/${id}`);
  }
});

test('a budget form that loads late keeps what was typed', async ({
  page,
  request,
}) => {
  // In development React runs the guard's load twice; the second answer comes after
  // typing has started here, and must not reset the amount.
  const name = `qa-budget-late-${Date.now()}`;
  let loads = 0;
  await page.route('**/api/projects/*/budget', async (route) => {
    if (route.request().method() === 'GET' && ++loads === 2)
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  let id = '';
  try {
    await page.goto('/app/');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page.getByLabel('Project name', { exact: true }).fill(name);
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .last()
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    id = (
      (await (await request.get('/api/projects')).json()) as {
        id: string;
        name: string;
      }[]
    ).find((p) => p.name === name)!.id;
    const amount = page.getByLabel(
      'Monthly budget beyond what Cloudflare includes, in dollars',
    );
    await expect(amount).toHaveValue('0');
    await amount.fill('25');
    await expect.poll(() => loads).toBe(2);
    await page.waitForTimeout(1800);
    await expect(amount).toHaveValue('25');
  } finally {
    if (id) await request.delete(`/api/projects/${id}`);
  }
});
