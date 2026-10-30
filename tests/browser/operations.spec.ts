import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('undeployed projects show an honest Manage empty state', async ({
  page,
  request,
}) => {
  const name = `qa-manage-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();
  try {
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Deploy this project first' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Save runtime secret' }),
    ).toHaveCount(0);
    await expect(
      page.getByText('No operations have been recorded for this project.'),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

// Provider routes below are explicit fixtures. This proves UI behavior, not cloud deployment.
test('operation confirmations, secret clearing, domain and version controls across three widths', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  const name = `qa-operations-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  let secretSaved = false;
  let domainAttached = false;
  let promoted = false;
  let healthChecks = 0;
  const versionId = '10000000-0000-4000-8000-000000000001';
  const zoneId = 'd'.repeat(32);
  try {
    await page.route(`**${root}/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(root.length);
      const method = route.request().method();
      if (path === '/operations/operation-fixture/health') {
        healthChecks++;
        return route.fulfill({ json: { health: 'healthy' } });
      }
      if (method !== 'GET') {
        const body = route.request().postDataJSON();
        expect(body.confirm).toBe(true);
        expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
        writes.push({ method, path, body });
        if (path === '/secrets') secretSaved = true;
        if (path === '/domains') domainAttached = true;
        if (path === '/rollback') promoted = true;
        return route.fulfill({
          json: { id: 'operation-fixture', status: 'succeeded', result: {} },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [{ id: 'job-fixture', status: 'deployed' }],
        '/operations': promoted
          ? [
              {
                id: 'operation-fixture',
                kind: `version.promote:${versionId}`,
                status: 'succeeded',
                error: null,
                created_at: 1791300000,
                health: healthChecks ? 'healthy' : 'pending',
                health_detail: healthChecks
                  ? 'The homepage returned HTTP 200 (https://cc-fixture-worker.example.workers.dev/).'
                  : 'Check 1 of 3 got HTTP 503. Shipcel will check again shortly.',
              },
            ]
          : [],
        '/cloud': {
          worker: 'cc-fixture-worker',
          dashboardUrl: 'https://dash.cloudflare.com/',
          accountId: 'a'.repeat(32),
          bindings: [{ name: 'DB', type: 'd1', id: versionId }],
        },
        '/secrets': secretSaved
          ? [{ name: 'API_KEY', type: 'secret_text' }]
          : [],
        '/zones': {
          zones: [{ id: zoneId, name: 'example.com' }],
          nextPage: null,
        },
        '/domains': domainAttached
          ? [
              {
                id: 'e'.repeat(32),
                hostname: 'app.example.com',
                zone_id: zoneId,
              },
            ]
          : [],
        '/builds': {
          builds: [
            {
              build_uuid: 'build-fixture',
              branch: 'main',
              status: 'success',
              created_at: '2026-10-07T00:00:00Z',
              health: 'build_failed',
              health_detail:
                'The build did not succeed, so Cloudflare kept serving the previous version.',
              health_operation: 'push:build-fixture',
            },
          ],
          nextPage: null,
        },
        '/builds/build-fixture/logs': {
          lines: [
            { at: 1791300000, text: 'Cloning repository' },
            { at: 1791300005, text: 'Installing dependencies' },
          ],
          cursor: 'c1',
          done: true,
          outcome: 'success',
        },
        '/versions': [
          {
            id: versionId,
            number: 1,
            createdAt: '2026-10-07T00:00:00Z',
            message: 'Fixture release',
          },
        ],
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('button', { name: 'Load resources' }).click();
    await expect(page.getByText('DB', { exact: true })).toBeVisible();
    await page
      .getByRole('tab', { name: 'Secrets & variables', exact: true })
      .click();
    await page.getByLabel('Secret name', { exact: true }).fill('API_KEY');
    await page
      .getByLabel('Secret value', { exact: true })
      .fill('fixture-only-value');
    await page.getByRole('button', { name: 'Save runtime secret' }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Secret value', { exact: true })).toHaveValue(
      '',
    );
    expect(writes).toHaveLength(0);
    await page
      .getByLabel('Secret value', { exact: true })
      .fill('fixture-only-value');
    await page.getByRole('button', { name: 'Save runtime secret' }).click();
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Runtime secret saved',
    );
    await expect(page.getByLabel('Secret value', { exact: true })).toHaveValue(
      '',
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      path: '/secrets',
      body: { name: 'API_KEY', value: 'fixture-only-value' },
    });

    // Zones load with the Domains tab.
    await page.getByRole('tab', { name: 'Domains', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Load authorized zones' }),
    ).toHaveCount(0);
    await page
      .getByRole('combobox', { name: 'Cloudflare zone', exact: true })
      .selectOption(zoneId);
    await page.getByLabel('Hostname', { exact: true }).fill('app.example.com');
    await page
      .getByRole('button', { name: 'Connect domain', exact: true })
      .click();
    expect(writes).toHaveLength(1);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Domain attached');
    await expect(
      page.getByText('app.example.com', { exact: true }),
    ).toBeVisible();

    // Builds load with the tab too; Refresh builds loads them again.
    await page
      .getByRole('tab', { name: 'Builds & versions', exact: true })
      .click();
    await expect(page.getByText('Build failed', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Refresh builds', exact: true })
      .click();
    await expect(page.getByText('Build failed', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Cloudflare kept serving the previous version', {
        exact: false,
      }),
    ).toBeVisible();
    // A build's log opens under it.
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(page.getByLabel('Build log')).toContainText(
      'Installing dependencies',
    );
    await expect(page.getByText('Build success.')).toBeVisible();
    await page.getByRole('button', { name: 'Hide the log' }).click();
    await expect(page.getByLabel('Build log')).toHaveCount(0);
    // Versions load with the tab.
    await page
      .getByRole('button', { name: 'Send all traffic to Version 1' })
      .click();
    await expect(dialog).toContainText('Database changes are not rolled back');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Version promoted');
    expect(writes[2]).toMatchObject({ path: '/rollback', body: { versionId } });
    await expect(
      page.getByText('Checking health', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Check 1 of 3 got HTTP 503')).toBeVisible();
    await page.getByRole('button', { name: 'Check health now' }).click();
    await expect(page.getByText('Healthy', { exact: true })).toBeVisible();
    await expect(
      page.getByText('The homepage returned HTTP 200', { exact: false }),
    ).toBeVisible();
    expect(healthChecks).toBe(1);

    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const tab of [
        'Resources',
        'Secrets & variables',
        'Domains',
        'Builds & versions',
        'Database',
      ]) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          (
            await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
      }
      await page.screenshot({
        path: `docs/screenshots/operations-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('D1 migrations are reviewed before they run and can be restored', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-migrations-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const databaseId = '40000000-0000-4000-8000-000000000004';
  const commit = 'f'.repeat(40);
  const sha256 = 'a'.repeat(64);
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  let applied = false;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route(`**${root}/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(root.length);
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        posts.push({ path, body });
        if (path === '/migrations') {
          applied = true;
          return route.fulfill({
            json: {
              id: 'migration-op',
              status: 'succeeded',
              result: {
                binding: 'DB',
                databaseId,
                applied: ['0001_init.sql'],
                bookmark: 'bookmark-before',
              },
            },
          });
        }
        return route.fulfill({
          json: {
            id: 'restore-op',
            status: 'succeeded',
            result: {
              binding: 'DB',
              databaseId,
              restoredTo: 'bookmark-before',
              undoBookmark: 'bookmark-undo',
            },
          },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [{ id: 'job-fixture', status: 'deployed' }],
        '/operations': [],
        '/cloud': {
          worker: 'cc-fixture-worker',
          dashboardUrl: 'https://dash.cloudflare.com/',
          accountId: 'a'.repeat(32),
          bindings: [{ name: 'DB', type: 'd1', id: databaseId }],
        },
        '/migrations': {
          commit,
          binding: 'DB',
          databaseId,
          migrationsDir: 'migrations',
          applied: applied ? ['0001_init.sql'] : [],
          pending: applied
            ? []
            : [
                {
                  name: '0001_init.sql',
                  size: 44,
                  sha256,
                  sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY);',
                },
              ],
          warnings: [],
          restorePoints: applied
            ? [
                {
                  operationId: 'migration-op',
                  bookmark: 'bookmark-before',
                  createdAt: 1791300000,
                },
              ]
            : [],
        },
      };
      if (!(path in data)) return route.continue();
      expect(path !== '/migrations' || url.searchParams.get('binding')).toBe(
        path === '/migrations' ? 'DB' : true,
      );
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await page.getByRole('button', { name: 'Check migrations' }).click();
    await expect(
      page.getByText('0001_init.sql', { exact: true }),
    ).toBeVisible();
    await page.getByText('View SQL').click();
    await expect(
      page.getByText('CREATE TABLE notes (id INTEGER PRIMARY KEY);'),
    ).toBeVisible();
    const apply = page.getByRole('button', { name: 'Apply 1 migration' });
    await expect(apply).toBeDisabled();
    await page
      .getByRole('checkbox', { name: /I reviewed these migrations/ })
      .check();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: 'docs/screenshots/database-migrations-1440.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 375, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: 'docs/screenshots/database-migrations-375.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await apply.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Time Travel restore point');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Applied 1 migration');
    expect(posts[0]).toMatchObject({
      path: '/migrations',
      body: {
        confirm: true,
        binding: 'DB',
        commit,
        migrations: [{ name: '0001_init.sql', sha256 }],
      },
    });
    expect(posts[0].body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(page.getByText('No pending migrations')).toBeVisible();
    await page
      .getByRole('button', { name: 'Restore to before migration-op' })
      .click();
    await expect(dialog).toContainText('overwrites the database');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('bookmark-undo');
    expect(posts[1]).toMatchObject({
      path: '/migrations/restore',
      body: { confirm: true, operationId: 'migration-op' },
    });
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('an interrupted operation can be checked against Cloudflare', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-reconcile-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  let checked = false;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/operations/op-stuck/reconcile') {
        checked = true;
        return route.fulfill({
          json: {
            id: 'op-stuck',
            status: 'succeeded',
            error: null,
            result: { id: 'e'.repeat(32), hostname: 'app.example.com' },
          },
        });
      }
      if (path === '/deployments')
        return route.fulfill({
          json: [{ id: 'job-fixture', status: 'deployed' }],
        });
      if (path === '/operations')
        return route.fulfill({
          json: [
            {
              id: 'op-stuck',
              kind: 'domain.attach:app.example.com',
              status: checked ? 'succeeded' : 'needs_attention',
              error: checked
                ? null
                : 'The provider did not respond. Check its dashboard before retrying a resource operation.',
              created_at: 1791300000,
            },
          ],
        });
      return route.continue();
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(
      page.getByText('needs attention', { exact: true }),
    ).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Check Cloudflare' }).click();
    await expect(page.getByText('succeeded', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Check Cloudflare' }),
    ).toHaveCount(0);
    expect(checked).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('container projects explain that promoting a version keeps the container image', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-container-manage-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'docker', freeOnly: false },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/deployments')
        return route.fulfill({
          json: [{ id: 'job-fixture', status: 'deployed' }],
        });
      if (path === '/operations') return route.fulfill({ json: [] });
      return route.continue();
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Builds & versions', exact: true })
      .click();
    await expect(
      page.getByText(/promoting a version changes the Worker code only/),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('Manage shows the free workers.dev address next to optional custom domains', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-free-address-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/deployments')
        return route.fulfill({
          json: [
            {
              id: 'job-fixture',
              status: 'deployed',
              environment: 'production',
              live_url: 'https://my-app.test-account.workers.dev/',
            },
          ],
        });
      if (path === '/operations') return route.fulfill({ json: [] });
      return route.continue();
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Domains', exact: true }).click();
    await expect(
      page.getByRole('link', {
        name: 'https://my-app.test-account.workers.dev/',
      }),
    ).toBeVisible();
    await expect(page.getByText(/no domain to buy/)).toBeVisible();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('database exports are polled to a download link and point-in-time restore is confirmed', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-backups-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const exportCalls: Record<string, unknown>[] = [];
  let restoreBody: Record<string, unknown> | null = null;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/databases/DB/export') {
        const body = route.request().postDataJSON();
        exportCalls.push(body);
        return route.fulfill({
          json: body.bookmark
            ? {
                status: 'complete',
                filename: 'cc-db-export.sql',
                url: 'https://d1-exports.example/download?token=fixture',
              }
            : { status: 'active', bookmark: 'export-1' },
        });
      }
      if (path === '/databases/DB/restore') {
        restoreBody = route.request().postDataJSON();
        return route.fulfill({
          json: {
            id: 'restore-op',
            status: 'succeeded',
            result: {
              binding: 'DB',
              restoredTo: restoreBody!.timestamp,
              undoBookmark: 'bookmark-undo',
            },
          },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [{ id: 'job-fixture', status: 'deployed' }],
        '/operations': [],
        '/cloud': {
          worker: 'cc-fixture-worker',
          dashboardUrl: 'https://dash.cloudflare.com/',
          accountId: 'a'.repeat(32),
          bindings: [
            {
              name: 'DB',
              type: 'd1',
              id: '40000000-0000-4000-8000-000000000004',
            },
          ],
        },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await expect(page.getByText('7 days on Workers Free')).toBeVisible();
    await page.getByRole('button', { name: 'Export SQL dump' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('cannot serve queries');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    const link = page.getByRole('link', { name: /Download cc-db-export\.sql/ });
    await expect(link).toHaveAttribute(
      'href',
      'https://d1-exports.example/download?token=fixture',
    );
    expect(exportCalls).toHaveLength(2);
    expect(exportCalls[0]).toMatchObject({ confirm: true });
    expect(exportCalls[1]).toMatchObject({
      confirm: true,
      bookmark: 'export-1',
      requestId: exportCalls[0].requestId,
    });
    // One hour ago in the browser's local time, the format of a datetime-local input.
    const past = new Date(Date.now() - 3600_000);
    const local = new Date(past.getTime() - past.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    await page.getByLabel('Restore to', { exact: true }).fill(local);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Restore to this time' }).click();
    await expect(dialog).toContainText('overwrites the database');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('bookmark-undo');
    expect(restoreBody).toMatchObject({
      confirm: true,
      timestamp: new Date(local).toISOString(),
    });
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('scheduled backups list their copies, and are changed and run after confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-scheduled-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const t = Math.floor(Date.now() / 1000);
  const schedule = {
    binding: 'DB',
    cadence: 'daily',
    hour: 3,
    keep: 7,
    bucket: 'cc-fixture-worker-backups',
    nextAt: t + 3600,
  };
  const copy = (id: string, createdAt: number) => ({
    id,
    binding: 'DB',
    status: 'done',
    bytes: 2 * 1024 * 1024,
    error: null,
    createdAt,
  });
  const failed = {
    ...copy('copy-0', t - 2 * 86400),
    status: 'failed',
    bytes: null,
    error: 'Cloudflare couldn’t export the database: D1 is busy.',
  };
  const saved: Record<string, unknown>[] = [];
  let runs = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route(`**${root}/**`, async (route) => {
      const method = route.request().method();
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/backups' && method === 'PUT') {
        saved.push(route.request().postDataJSON());
        return route.fulfill({ json: { ...schedule, keep: saved[0].keep } });
      }
      if (path === '/backups/run') {
        runs += 1;
        return route.fulfill({ status: 202, json: { started: true } });
      }
      const data: Record<string, unknown> = {
        '/deployments': [{ id: 'job-fixture', status: 'deployed' }],
        '/operations': [],
        '/cloud': {
          worker: 'cc-fixture-worker',
          dashboardUrl: 'https://dash.cloudflare.com/',
          accountId: 'a'.repeat(32),
          bindings: [
            {
              name: 'DB',
              type: 'd1',
              id: '40000000-0000-4000-8000-000000000004',
            },
          ],
        },
        '/backups': {
          schedule,
          backups: [
            ...(runs ? [copy('copy-2', t)] : []),
            copy('copy-1', t - 86400),
            failed,
          ],
        },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Scheduled copies' }),
    ).toBeVisible();
    const downloads = page.getByRole('link', { name: /Download the copy of/ });
    await expect(downloads).toHaveAttribute(
      'href',
      `${root}/backups/copy-1/download`,
    );
    await expect(page.getByText('D1 is busy')).toBeVisible();
    // The form starts from the saved schedule.
    await expect(page.getByLabel('Time (UTC)')).toHaveValue('3');
    await page.getByLabel('Copies kept').fill('14');
    await page.getByRole('button', { name: 'Save schedule' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'Copies go on into cc-fixture-worker-backups',
    );
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Backups scheduled');
    expect(saved).toEqual([
      { binding: 'DB', cadence: 'daily', hour: 3, keep: 14, confirm: true },
    ]);
    await page.getByRole('button', { name: 'Back up now' }).click();
    await expect(dialog).toContainText(
      'a new copy in cc-fixture-worker-backups',
    );
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Backed up DB.');
    expect(runs).toBe(1);
    await expect(downloads).toHaveCount(2);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('the Database tab can work on the preview environment', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-preview-db-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const environments: (string | null)[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(root.length);
      if (path === '/migrations') {
        environments.push(url.searchParams.get('environment'));
        return route.fulfill({
          json: {
            commit: 'f'.repeat(40),
            binding: 'DB',
            databaseId: '40000000-0000-4000-8000-000000000099',
            migrationsDir: 'migrations',
            applied: [],
            pending: [],
            warnings: [],
            restorePoints: [],
          },
        });
      }
      // Branch previews bind a staging copy of the database.
      if (path === '/previews') {
        expect(url.searchParams.get('details')).toBe('0');
        return route.fulfill({
          json: {
            status: 'active',
            resources: [
              {
                type: 'd1',
                binding: 'DB',
                name: 'cc-fixture-worker-pv-a1b2c3d4-db',
                id: '40000000-0000-4000-8000-000000000099',
              },
            ],
          },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [
          {
            id: 'job-fixture',
            status: 'deployed',
            environment: 'production',
            adapter: 'configured-worker',
          },
        ],
        '/operations': [],
        '/cloud': {
          worker: 'cc-fixture-worker',
          dashboardUrl: 'https://dash.cloudflare.com/',
          accountId: 'a'.repeat(32),
          bindings: [
            {
              name: 'DB',
              type: 'd1',
              id: '40000000-0000-4000-8000-000000000004',
            },
          ],
        },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Environment' })
      .selectOption('preview');
    await page.getByRole('button', { name: 'Check migrations' }).click();
    await expect(
      page.getByText('40000000-0000-4000-8000-000000000099'),
    ).toBeVisible();
    expect(environments).toEqual(['preview']);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('one-click rollback and a traffic split are confirmed before anything changes', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-rollback-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ids = [3, 2, 1].map((n) => `10000000-0000-4000-8000-00000000000${n}`);
  // Newest first; version 3 serves all traffic.
  let live: Record<string, number> = { [ids[0]]: 100 };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (route.request().method() !== 'GET') {
        const body = route.request().postDataJSON();
        writes.push({ path, body: { ...body, requestId: undefined } });
        if (path === '/rollback') live = { [body.versionId]: 100 };
        if (path === '/traffic')
          live = Object.fromEntries(
            body.versions.map(
              (v: { versionId: string; percentage: number }) => [
                v.versionId,
                v.percentage,
              ],
            ),
          );
        return route.fulfill({
          json: { id: 'operation', status: 'succeeded', result: {} },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [
          {
            id: 'job',
            status: 'deployed',
            environment: 'production',
            adapter: 'direct-upload',
          },
        ],
        '/operations': [],
        '/versions': ids.map((id, i) => ({
          id,
          number: 3 - i,
          createdAt: `2026-10-0${8 - i}T10:00:00Z`,
          message: 'Direct upload from Shipcel',
          live: live[id] ?? null,
        })),
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Builds & versions', exact: true })
      .click();
    // Direct uploads have no Git builds to show.
    await expect(
      page.getByRole('heading', { name: 'Native build history' }),
    ).toHaveCount(0);
    await expect(page.getByText('Live, 100%')).toBeVisible();
    await page.getByRole('button', { name: 'Roll back to Version 2' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('All traffic goes back to Version 2');
    await expect(dialog).toContainText('migrations are not undone');
    expect(writes).toEqual([]);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Rolled back to Version 2',
    );
    expect(writes).toEqual([
      { path: '/rollback', body: { confirm: true, versionId: ids[1] } },
    ]);
    // Version 2 serves everything now; try version 3 on a quarter of traffic.
    await page
      .getByRole('button', { name: 'Split traffic with Version 3' })
      .click();
    await page.getByLabel('Share for Version 3 (%)').fill('25');
    await page.getByRole('button', { name: 'Review split' }).click();
    await expect(dialog).toContainText('75% stays on Version 2');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('Traffic is split')).toBeVisible();
    await expect(page.getByText('Live, 25%')).toBeVisible();
    expect(writes[1]).toEqual({
      path: '/traffic',
      body: {
        confirm: true,
        versions: [
          { versionId: ids[0], percentage: 25 },
          { versionId: ids[1], percentage: 75 },
        ],
      },
    });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('cron schedules are edited, checked and saved after confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-schedules-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let crons = ['0 3 * * *'];
  const writes: unknown[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (route.request().method() === 'PUT' && path === '/schedules') {
        const body = route.request().postDataJSON();
        writes.push({ ...body, requestId: undefined });
        crons = body.crons;
        return route.fulfill({
          json: { id: 'operation', status: 'succeeded', result: {} },
        });
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
        '/schedules': crons.map((cron) => ({
          cron,
          createdOn: null,
          modifiedOn: null,
        })),
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Schedules', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'Schedule 1', exact: true }),
    ).toHaveValue('0 3 * * *');
    const save = page.getByRole('button', { name: 'Save schedules' });
    await expect(save).toBeDisabled();
    await page.getByRole('button', { name: 'Add schedule' }).click();
    await page
      .getByRole('textbox', { name: 'Schedule 2', exact: true })
      .fill('every half hour');
    await expect(save).toBeDisabled();
    await page
      .getByRole('textbox', { name: 'Schedule 2', exact: true })
      .fill('*/30 * * * *');
    await expect(save).toBeEnabled();
    await save.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('0 3 * * *, */30 * * * * (UTC)');
    expect(writes).toEqual([]);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Schedules saved.');
    expect(writes).toEqual([
      { confirm: true, crons: ['0 3 * * *', '*/30 * * * *'] },
    ]);
    // Removing every schedule is confirmed too.
    await page.getByRole('button', { name: 'Remove schedule 2' }).click();
    await page.getByRole('button', { name: 'Remove schedule 1' }).click();
    await expect(page.getByText('No schedules.')).toBeVisible();
    await save.click();
    await expect(dialog).toContainText('Remove every schedule?');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Every schedule was removed.',
    );
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('the data browser pages through tables and asks before SQL that changes data', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-data-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const queries: Record<string, unknown>[] = [];
  const wide = Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [
      `column_${i}`,
      `value ${i}`.repeat(4),
    ]),
  );
  try {
    await page.route(`**${root}/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(root.length);
      if (path === '/databases/DB/query') {
        const body = route.request().postDataJSON();
        queries.push({
          ...body,
          requestId: body.requestId ? 'set' : undefined,
        });
        if (body.confirm)
          return route.fulfill({
            json: {
              id: 'operation',
              status: 'succeeded',
              result: {
                columns: [],
                rows: [],
                truncated: false,
                meta: { changes: 2, rowsRead: 2, rowsWritten: 2 },
              },
            },
          });
        return route.fulfill({
          json: {
            columns: ['one'],
            rows: [{ one: 1 }],
            truncated: false,
            meta: { changes: 0, rowsRead: 1, rowsWritten: 0 },
          },
        });
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
        '/cloud': {
          worker: 'cc-fixture-worker',
          dashboardUrl: 'https://dash.cloudflare.com/',
          accountId: 'a'.repeat(32),
          bindings: [
            {
              name: 'DB',
              type: 'd1',
              id: '40000000-0000-4000-8000-000000000004',
            },
          ],
        },
        '/databases/DB/tables': {
          databaseId: '40000000-0000-4000-8000-000000000004',
          tables: [
            { name: 'notes', type: 'table' },
            { name: 'wide', type: 'table' },
          ],
        },
        '/databases/DB/tables/notes': {
          columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true },
            { name: 'body', type: 'TEXT', primaryKey: false },
          ],
          rows: [
            { id: 1, body: 'first' },
            { id: 2, body: null },
          ],
          nextOffset: url.searchParams.get('offset') === '0' ? 50 : null,
        },
        '/databases/DB/tables/wide': {
          columns: Object.keys(wide).map((n) => ({
            name: n,
            type: 'TEXT',
            primaryKey: false,
          })),
          rows: [wide],
          nextOffset: null,
        },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    await page.getByRole('button', { name: 'notes', exact: true }).click();
    const rows = page.getByRole('region', { name: 'Rows of notes' });
    await expect(rows).toContainText('first');
    await expect(rows.getByText('NULL')).toBeVisible();
    await expect(page.getByText('rows 1–2')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next rows' })).toBeEnabled();
    const sql = page.getByRole('textbox', { name: 'SQL' });
    await sql.fill('SELECT 1 AS one');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Query results' }),
    ).toContainText('1');
    expect(queries).toEqual([
      { sql: 'SELECT 1 AS one', environment: 'production' },
    ]);
    // A change is confirmed first, and recorded with a restore point by the server.
    await sql.fill('DELETE FROM notes WHERE body IS NULL');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'Run this SQL on the production database?',
    );
    await expect(dialog).toContainText('DELETE FROM notes WHERE body IS NULL');
    expect(queries).toHaveLength(1);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('2 rows changed')).toBeVisible();
    expect(queries[1]).toEqual({
      sql: 'DELETE FROM notes WHERE body IS NULL',
      environment: 'production',
      requestId: 'set',
      confirm: true,
    });
    // A wide table scrolls inside its own region, never the page.
    await page.getByRole('button', { name: 'wide', exact: true }).click();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('visitors: how to set up Web Analytics, then page views and Core Web Vitals', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-visitors-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let site = false;
  try {
    await page.route(`**${root}/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(root.length);
      const setup = {
        hosts: ['shop.ada.workers.dev'],
        setup: 'https://dash.cloudflare.com/a/web-analytics',
      };
      if (path === '/web-analytics')
        return route.fulfill({
          json: !site
            ? { site: null, ...setup }
            : {
                ...setup,
                site: { tag: 'site-app', wholeZone: false, beacon: null },
                range: url.searchParams.get('range'),
                bucket: 'hour',
                totals: { pageViews: 1200, visits: 600 },
                series: [
                  { at: '2026-10-15T09:00:00Z', pageViews: 700, visits: 350 },
                  { at: '2026-10-15T10:00:00Z', pageViews: 500, visits: 250 },
                ],
                pages: [{ name: '/pricing', views: 300 }],
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
                  inp: {
                    p75: null,
                    good: 0,
                    needsImprovement: 0,
                    poor: 0,
                    total: 0,
                  },
                  cls: {
                    p75: 0.31,
                    good: 200,
                    needsImprovement: 50,
                    poor: 50,
                    total: 300,
                  },
                },
              },
        });
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
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Visitors', exact: true }).click();
    // No Web Analytics site yet: how to add one, for the app's own address.
    await expect(page.getByText('shop.ada.workers.dev')).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Open Web Analytics/ }),
    ).toHaveAttribute('href', 'https://dash.cloudflare.com/a/web-analytics');
    site = true;
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(
      page.locator('.stat', { hasText: 'Page views per visit' }),
    ).toContainText('2.0');
    await expect(page.getByRole('cell', { name: 'India' })).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'news.ycombinator.com' }),
    ).toBeVisible();
    await expect(
      page.locator('.vital', { hasText: 'Largest Contentful Paint' }),
    ).toContainText('2.14 s, Good');
    await expect(
      page.locator('.vital', { hasText: 'Cumulative Layout Shift' }),
    ).toContainText('0.31, Poor');
    await expect(
      page.locator('.vital', { hasText: 'Interaction to Next Paint' }),
    ).toContainText('Not measured yet');
    await page.getByRole('button', { name: 'Last 30 days' }).click();
    await expect(
      page.getByRole('button', { name: 'Last 30 days' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // The button that was chosen fades from green to white (150 ms) while its text turns
    // dark at once: check colours after the loading and the fade, as a person sees them.
    await expect(
      page.getByRole('button', { name: 'Last 24 hours' }),
    ).toBeEnabled();
    await page.waitForFunction(
      () =>
        !document
          .getAnimations()
          .some((animation) => animation instanceof CSSTransition),
    );
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page
        .locator('.observability')
        .first()
        .screenshot({
          path: `docs/screenshots/visitors-${width}.png`,
          animations: 'disabled',
        });
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('analytics and logs show what Cloudflare reports for the app', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-observability-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const asked: string[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(root.length);
      if (['/analytics', '/logs', '/status-codes'].includes(path))
        asked.push(`${path}${url.search}`);
      if (path === '/analytics')
        return route.fulfill({
          json: {
            range: url.searchParams.get('range'),
            bucket: 'hour',
            totals: {
              requests: 140,
              errors: 10,
              subrequests: 15,
              cpuP50: 1.2,
              cpuP99: 9.5,
              wallP50: 26.4,
              wallP99: 300,
            },
            series: [
              {
                at: '2026-10-08T09:00:00Z',
                requests: 100,
                errors: 10,
                wallP50: 33,
                wallP99: 300,
              },
              {
                at: '2026-10-08T10:00:00Z',
                requests: 40,
                errors: 0,
                wallP50: 10,
                wallP99: 25,
              },
            ],
            hours: [
              { hour: '2026-10-08T09:00:00Z', requests: 100, errors: 10 },
              { hour: '2026-10-08T10:00:00Z', requests: 40, errors: 0 },
            ],
            statuses: { success: 130, scriptThrewException: 10 },
          },
        });
      if (path === '/status-codes')
        return route.fulfill({
          json: {
            hours: 24,
            codes: [
              { status: 200, requests: 120 },
              { status: 500, requests: 10 },
            ],
            series: [
              { at: '2026-10-08T09:00:00Z', requests: 100, errors: 10 },
              { at: '2026-10-08T10:00:00Z', requests: 30, errors: 0 },
            ],
          },
        });
      if (path === '/logs')
        return route.fulfill({
          json: {
            events:
              url.searchParams.get('errors') === '1'
                ? []
                : [
                    {
                      id: 'event-1',
                      timestamp: 1791450000000,
                      level: 'error',
                      message: 'TypeError: x is undefined',
                      trigger: 'GET /api',
                      status: 500,
                      outcome: 'exception',
                      requestId: 'req-1',
                    },
                  ],
          },
        });
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
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Analytics & logs', exact: true })
      .click();
    await expect(page.getByText('10 (7.1%)')).toBeVisible();
    await expect(page.getByText('Threw an exception: 10')).toBeVisible();
    await expect(
      page.locator('.stat', { hasText: 'Response time, median' }),
    ).toContainText('26.4 ms');
    await expect(
      page.locator('.stat', { hasText: 'Response time, 99th percentile' }),
    ).toContainText('300 ms');
    const codes = page.getByRole('list', { name: 'HTTP status codes' });
    await expect(codes).toContainText('500');
    await expect(codes).toContainText('10 (7.7%)');
    await page.getByText('Response time by hour').click();
    await expect(
      page.getByRole('region', { name: 'Response time by hour' }),
    ).toContainText('33 ms');
    await expect(page.getByText('TypeError: x is undefined')).toBeVisible();
    await expect(page.getByText('HTTP 500')).toBeVisible();
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    await expect(
      page.getByRole('button', { name: 'Last 7 days' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('checkbox', { name: 'Errors only' }).check();
    await expect(page.getByText('No logs in this period.')).toBeVisible();
    // Development's StrictMode loads the tab twice; each request is what matters.
    expect([...new Set(asked)].sort()).toEqual(
      [
        '/analytics?range=24h',
        '/status-codes?range=24h',
        '/logs?minutes=60',
        '/analytics?range=7d',
        '/status-codes?range=7d',
        '/logs?minutes=60&errors=1',
      ].sort(),
    );
    await expect(
      page.getByRole('button', { name: 'Last 30 days' }),
    ).toBeVisible();
    // Search, then live: the last few minutes every few seconds.
    await page.getByRole('checkbox', { name: 'Errors only' }).uncheck();
    await page.getByLabel('Search the logs').fill('TypeError');
    const searched = page.waitForRequest((r) =>
      r.url().includes('/logs?minutes=60&q=TypeError'),
    );
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await searched;
    await expect(page.getByText('TypeError: x is undefined')).toBeVisible();
    const polled = page.waitForRequest(
      (r) => r.url().includes('/logs?minutes=5&q=TypeError'),
      { timeout: 9000 },
    );
    await page
      .getByRole('checkbox', { name: /^Live: new events every 5 seconds/ })
      .check();
    await polled;
    await page
      .getByRole('checkbox', { name: /^Live: new events every 5 seconds/ })
      .uncheck();
    await page.getByText('Requests by hour').click();
    await expect(
      page.getByRole('region', { name: 'Requests by hour' }),
    ).toContainText('100');
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page
        .locator('.observability')
        .first()
        .screenshot({
          path: `docs/screenshots/analytics-${width}.png`,
          animations: 'disabled',
        });
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('build variables are set per environment, with secret values leaving the form', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-buildvars-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes: unknown[] = [];
  const lists: string[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.slice(root.length);
      const method = route.request().method();
      if (path.startsWith('/build-variables')) {
        if (method !== 'GET') {
          const body = route.request().postDataJSON();
          writes.push({ method, path, ...body, requestId: undefined });
          return route.fulfill({
            json: { id: 'operation', status: 'succeeded', result: {} },
          });
        }
        lists.push(url.searchParams.get('environment') ?? '');
        return route.fulfill({
          json: {
            variables:
              url.searchParams.get('environment') === 'preview'
                ? [
                    {
                      name: 'API_URL',
                      secret: false,
                      value: 'https://staging.example',
                    },
                  ]
                : [
                    {
                      name: 'API_URL',
                      secret: false,
                      value: 'https://api.example',
                    },
                    { name: 'NPM_TOKEN', secret: true, value: null },
                  ],
          },
        });
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
        '/secrets': [],
        '/previews': { status: 'active', resources: [] },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Secrets & variables', exact: true })
      .click();
    const vars = page.locator('section', {
      has: page.getByRole('heading', { name: 'Build variables' }),
    });
    await expect(vars.getByText('https://api.example')).toBeVisible();
    await expect(vars.getByText('Secret value', { exact: true })).toBeVisible();
    await vars.getByRole('textbox', { name: 'Name' }).fill('SENTRY_TOKEN');
    await vars.getByLabel('Secret', { exact: true }).check();
    const value = vars.getByLabel('Value', { exact: true });
    await value.fill('very-secret-build-value');
    await page.getByRole('button', { name: 'Save variable' }).click();
    // The value is gone from the form before anything is sent.
    await expect(value).toHaveValue('');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'Set SENTRY_TOKEN for production builds?',
    );
    await expect(dialog).toContainText('never shown again');
    await expect(dialog).not.toContainText('very-secret-build-value');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('SENTRY_TOKEN saved.');
    expect(writes[0]).toEqual({
      method: 'PUT',
      path: '/build-variables',
      confirm: true,
      environment: 'production',
      name: 'SENTRY_TOKEN',
      value: 'very-secret-build-value',
      secret: true,
    });
    // The dialog's own title mentions builds too: wait for it to close before reaching
    // for the list of that name.
    await expect(dialog).toBeHidden();
    await page.getByLabel('Builds').selectOption('preview');
    await expect(vars.getByText('https://staging.example')).toBeVisible();
    await vars
      .getByRole('button', { name: 'Remove build variable API_URL' })
      .click();
    await expect(dialog).toContainText(
      'Remove API_URL from branch preview builds?',
    );
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('API_URL removed.');
    expect(writes[1]).toEqual({
      method: 'DELETE',
      path: '/build-variables/API_URL',
      confirm: true,
      environment: 'preview',
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('a notification webhook is saved with a one-time signing secret, tested and removed', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-notify-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const secret = `whsec_${'s'.repeat(43)}`;
  let webhook: Record<string, unknown> | null = null;
  const writes: unknown[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      const method = route.request().method();
      if (path === '/notifications/test') {
        writes.push('test');
        webhook = { ...webhook!, lastStatus: 'sent' };
        return route.fulfill({ json: { status: 'sent', detail: 'HTTP 200' } });
      }
      if (path === '/notifications') {
        if (method === 'PUT') {
          const body = route.request().postDataJSON();
          writes.push(body);
          webhook = {
            host: 'hooks.slack.com',
            events: body.events,
            lastStatus: null,
            lastError: null,
            lastSentAt: null,
          };
          return route.fulfill({
            json: {
              host: 'hooks.slack.com',
              events: body.events,
              signingSecret: secret,
            },
          });
        }
        if (method === 'DELETE') {
          writes.push('delete');
          webhook = null;
          return route.fulfill({ json: { removed: true } });
        }
        return route.fulfill({ json: { webhook } });
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
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Add a webhook' }).click();
    await page
      .getByLabel('Webhook address')
      .fill('https://hooks.slack.com/services/T/B/secret-path');
    await page
      .getByRole('checkbox', { name: 'A direct upload was deployed' })
      .uncheck();
    await page.getByRole('button', { name: 'Save webhook' }).click();
    await expect(page.getByText(secret)).toBeVisible();
    expect(writes[0]).toEqual({
      url: 'https://hooks.slack.com/services/T/B/secret-path',
      events: ['deployment.ready', 'deployment.failed', 'health.unhealthy'],
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: "I've saved it" }).click();
    await expect(page.getByText(secret)).toHaveCount(0);
    await expect(
      page.getByText('hooks.slack.com', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Nothing sent yet.')).toBeVisible();
    // The full address, with its secret path, is never shown again.
    await expect(page.getByText(/secret-path/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Send a test' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Test message delivered (HTTP 200).',
    );
    await expect(
      page.getByText('The last message was delivered.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Remove this webhook?');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByRole('button', { name: 'Add a webhook' }),
    ).toBeVisible();
    expect(writes.slice(1)).toEqual(['test', 'delete']);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('Telegram and email notifications are added; an email waits for its confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-channels-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bot = `123456789:${'A'.repeat(35)}`;
  const settings: Record<string, unknown> = {
    webhook: null,
    telegram: null,
    email: null,
    emailReady: true,
  };
  const writes: Record<string, unknown>[] = [];
  const status = { lastStatus: null, lastError: null, lastSentAt: null };
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      const method = route.request().method();
      if (path === '/notifications/telegram' && method === 'PUT') {
        const body = route.request().postDataJSON();
        writes.push(body);
        settings.telegram = {
          label: '@shop_alerts_bot in Ada',
          events: body.events,
          confirmed: true,
          ...status,
        };
        return route.fulfill({
          json: { label: '@shop_alerts_bot in Ada', events: body.events },
        });
      }
      if (path === '/notifications/email' && method === 'PUT') {
        const body = route.request().postDataJSON();
        writes.push(body);
        settings.email = {
          label: body.address,
          events: body.events,
          confirmed: false,
          ...status,
        };
        return route.fulfill({
          json: { label: body.address, events: body.events, confirmed: false },
        });
      }
      if (path === '/notifications') return route.fulfill({ json: settings });
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
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Add a Telegram chat' }).click();
    await page.getByLabel('Bot token').fill(bot);
    await page.getByRole('button', { name: 'Save Telegram chat' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Telegram set up: @shop_alerts_bot in Ada.',
    );
    await expect(
      page.getByText('@shop_alerts_bot in Ada', { exact: true }),
    ).toBeVisible();
    // The token is gone from the page once saved.
    await expect(page.getByLabel('Bot token')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add an email address' }).click();
    await page.getByLabel('Email address').fill('ada@example.com');
    await page
      .getByRole('checkbox', { name: 'A deployment is live' })
      .uncheck();
    await page.getByRole('button', { name: 'Save email address' }).click();
    await expect(page.getByRole('status')).toContainText(
      'A confirmation link went to ada@example.com.',
    );
    await expect(
      page.getByText(
        'Waiting for confirmation: the link went to this address.',
      ),
    ).toBeVisible();
    expect(writes).toEqual([
      {
        botToken: bot,
        events: [
          'deployment.ready',
          'deployment.failed',
          'upload.deployed',
          'health.unhealthy',
        ],
      },
      {
        address: 'ada@example.com',
        events: ['deployment.failed', 'upload.deployed', 'health.unhealthy'],
      },
    ]);
    // Telegram can be tested; an unconfirmed address can't.
    await expect(page.getByRole('button', { name: 'Send a test' })).toHaveCount(
      1,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
