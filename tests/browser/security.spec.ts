import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Manage → Security with the app's security routes faked; worker/firewall.ts has its own
// tests with Cloudflare faked. This proves the panel's behaviour, not Cloudflare's.
test('the Security tab changes zone settings, rules and the rate limit only after confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-security-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  type Rule = {
    id: string;
    action: string;
    summary: string;
    enabled: boolean;
    ours: boolean;
  };
  let zone = {
    id: 'f'.repeat(32),
    name: 'example.com',
    hosts: ['shop.example.com'],
    managed: true,
    bots: false,
    aiBots: false,
    underAttack: false,
    rules: [
      {
        id: '8'.repeat(32),
        action: 'block',
        summary: 'block: Made in the dashboard',
        enabled: true,
        ours: false,
      },
    ] as Rule[],
    rateLimits: [] as (Rule & { requests: number; period: number })[],
    denied: [] as string[],
  };
  let zones = [zone];
  const state = () => ({ workersDev: true, zones });
  const ruleId = '1'.padStart(32, '0');
  const writes: { method: string; path: string; body: unknown }[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      const method = route.request().method();
      if (path.startsWith('/security')) {
        if (method === 'GET') return route.fulfill({ json: state() });
        const body = route.request().postDataJSON();
        writes.push({ method, path, body });
        if (path === '/security') {
          const { confirm: _confirm, ...changes } = body;
          zone = { ...zone, ...changes };
        } else if (path === '/security/rules') {
          zone = {
            ...zone,
            rules: [
              ...zone.rules,
              {
                id: ruleId,
                action: 'block',
                summary: 'block countries CN, RU',
                enabled: true,
                ours: true,
              },
            ],
          };
          zones = [zone];
          return route.fulfill({
            status: 201,
            json: {
              added: [{ zone: 'example.com', id: ruleId }],
              summary: 'block countries CN, RU',
              ...state(),
            },
          });
        } else if (path === `/security/rules/${ruleId}`) {
          zone = { ...zone, rules: zone.rules.filter((r) => r.id !== ruleId) };
          zones = [zone];
          return route.fulfill({ json: { removed: ruleId } });
        } else if (path === '/security/rate-limit')
          zone = {
            ...zone,
            rateLimits: [
              {
                id: '2'.padStart(32, '0'),
                action: 'block',
                summary: `at most ${body.requests} requests per 10 seconds per visitor to ${body.path}`,
                enabled: true,
                ours: true,
                requests: body.requests,
                period: 10,
              },
            ],
          };
        zones = [zone];
        return route.fulfill({ json: state() });
      }
      const data: Record<string, unknown> = {
        '/deployments': [
          {
            id: 'job',
            status: 'deployed',
            environment: 'production',
            adapter: 'configured-worker',
          },
        ],
        '/operations': [],
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    const axe = async () =>
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Security', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Security', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('For shop.example.com, in the zone example.com.'),
    ).toBeVisible();
    // A rule made elsewhere is listed, and can't be removed here.
    await expect(page.getByText('block: Made in the dashboard')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Remove rule block: Made/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/also answers at its workers\.dev/),
    ).toBeVisible();
    await axe();

    // A zone setting: asked first, then sent with consent.
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Turn on Bot Fight Mode' }).click();
    await expect(dialog).toContainText('Turn Bot Fight Mode on?');
    await expect(dialog).toContainText('every host name in example.com');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Turn on Bot Fight Mode' }).click();
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Bot Fight Mode is on.',
    );
    expect(writes[0]).toEqual({
      method: 'PUT',
      path: '/security',
      body: { bots: true, confirm: true },
    });
    await expect(
      page.getByRole('button', { name: 'Turn off Bot Fight Mode' }),
    ).toBeVisible();

    // A rule, added and removed.
    const countries = page.getByRole('textbox', {
      name: 'Countries',
      exact: true,
    });
    await countries.fill('CN, RU');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(dialog).toContainText('Block these countries?');
    await expect(dialog).toContainText('CN, RU, on shop.example.com.');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Rule added: block countries CN, RU.',
    );
    expect(writes[1]).toEqual({
      method: 'POST',
      path: '/security/rules',
      body: {
        action: 'block',
        match: 'country',
        values: ['CN', 'RU'],
        confirm: true,
      },
    });
    await expect(countries).toHaveValue('');
    await page
      .getByRole('button', { name: 'Remove rule block countries CN, RU' })
      .click();
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Rule removed.');
    expect(writes[2]).toEqual({
      method: 'DELETE',
      path: `/security/rules/${ruleId}`,
      body: { confirm: true },
    });
    await expect(page.getByText('block countries CN, RU')).toHaveCount(0);

    // The rate limit.
    await page
      .getByRole('textbox', { name: 'Path', exact: true })
      .fill('/login');
    await page.getByLabel('Requests per 10 seconds').fill('20');
    await page.getByRole('button', { name: 'Save rate limit' }).click();
    await expect(dialog).toContainText(
      'At most 20 requests per 10 seconds per visitor to /login',
    );
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Rate limit set.');
    expect(writes[3]).toEqual({
      method: 'PUT',
      path: '/security/rate-limit',
      body: { path: '/login', requests: 20, confirm: true },
    });
    await expect(
      page.getByText(
        'at most 20 requests per 10 seconds per visitor to /login',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Remove the rate limit' }),
    ).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await axe();

    // Without a custom domain, the panel says what a firewall needs.
    zones = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page.getByText('This app has no custom domain yet.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add rule' })).toHaveCount(0);
    await axe();
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
