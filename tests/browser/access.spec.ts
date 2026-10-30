import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;

test('preview addresses ask reviewers to sign in through Cloudflare Access after confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-access-${Date.now()}`;
  const project = await (
    await request.post('/api/projects', { data: { name, framework: 'worker' } })
  ).json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes: Record<string, unknown>[] = [];
  const state = {
    organization: null as { authDomain: string } | null,
    organizationError: 'Cloudflare reported: not found' as string | null,
    loginMethods: [] as { name: string; type: string }[],
    protection: null as Record<string, unknown> | null,
    missing: false,
  };
  try {
    await page.route(`**${root}/**`, async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.slice(root.length);
      if (path === '/access' && req.method() === 'GET')
        return route.fulfill({ json: state });
      if (path === '/access') {
        const body = req.postDataJSON();
        writes.push({
          method: req.method(),
          ...body,
          requestId: body.requestId ? 'set' : undefined,
        });
        if (req.method() === 'PUT') {
          if (body.addLoginMethod)
            state.loginMethods = [{ name: 'One-time PIN', type: 'onetimepin' }];
          state.protection = {
            emails: body.emails,
            domains: body.domains,
            otherRules: 0,
            sessionDuration: '24h',
          };
        } else state.protection = null;
        return route.fulfill({
          json: { id: 'op', status: 'succeeded', result: {} },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [
          {
            id: 'job',
            status: 'deployed',
            environment: 'production',
            adapter: 'direct-upload',
            live_url: 'https://qa.example.workers.dev',
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
    await page.getByRole('tab', { name: 'Domains', exact: true }).click();

    // Without a Zero Trust organization, the section explains the one step in Cloudflare.
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Who can open previews' }),
    });
    await expect(section).toContainText('asks for a payment method');
    await expect(
      section.getByRole('link', { name: 'Open Cloudflare Zero Trust' }),
    ).toHaveAttribute('href', 'https://one.dash.cloudflare.com/');
    await expect(section).toContainText('Cloudflare reported: not found');
    state.organization = { authDomain: 'acme.cloudflareaccess.com' };
    state.organizationError = null;
    await section.getByRole('button', { name: 'Check again' }).click();
    await expect(section).toContainText('no login method yet');

    await section
      .getByRole('textbox', { name: 'People who can open previews' })
      .fill('Ada@Example.com, grace@example.com');
    await section
      .getByRole('textbox', { name: 'Everyone with an email address at' })
      .fill('@example.org');
    await section.getByRole('button', { name: 'Ask for sign-in' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Ask reviewers to sign in?');
    await expect(dialog).toContainText(
      'People: ada@example.com, grace@example.com.',
    );
    await expect(dialog).toContainText('One-time PIN');
    expect(writes).toEqual([]);
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByText('Preview addresses now ask reviewers to sign in.'),
    ).toBeVisible();
    await expect(section).toContainText(
      'ada@example.com, grace@example.com, anyone at example.org',
    );
    await expect(section).toContainText('on acme.cloudflareaccess.com');

    // Changing who may sign in keeps the login methods the organization now has.
    await section.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(
      section.getByRole('textbox', { name: 'People who can open previews' }),
    ).toHaveValue('ada@example.com\ngrace@example.com');
    await expect(section).toContainText('Reviewers sign in with One-time PIN.');
    await section
      .getByRole('textbox', { name: 'People who can open previews' })
      .fill('ada@example.com');
    await section.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toContainText('Change who can open previews?');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(section).toContainText(
      'ada@example.com, anyone at example.org',
    );

    await section.getByRole('button', { name: 'Remove sign-in' }).click();
    await expect(dialog).toContainText('Make preview addresses public again?');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByText('Preview addresses are public again.'),
    ).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Ask for sign-in' }),
    ).toBeVisible();
    expect(writes).toEqual([
      {
        method: 'PUT',
        emails: ['ada@example.com', 'grace@example.com'],
        domains: ['example.org'],
        addLoginMethod: true,
        requestId: 'set',
        confirm: true,
      },
      {
        method: 'PUT',
        emails: ['ada@example.com'],
        domains: ['example.org'],
        addLoginMethod: false,
        requestId: 'set',
        confirm: true,
      },
      { method: 'DELETE', requestId: 'set', confirm: true },
    ]);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await axe(page)).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('the rest of the Domains tab works when Access can’t be read', async ({
  page,
  request,
}) => {
  const name = `qa-access-denied-${Date.now()}`;
  const project = await (
    await request.post('/api/projects', { data: { name, framework: 'worker' } })
  ).json();
  const root = `/api/projects/${project.id}`;
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/access')
        return route.fulfill({
          status: 403,
          json: {
            error:
              'The provider denied access. Check the app installation and granted permissions.',
          },
        });
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
        // Custom domains work; only Access can't be read.
        '/domains': [],
        '/zones': {
          zones: [{ id: 'f'.repeat(32), name: 'example.com' }],
          nextPage: null,
        },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Domains', exact: true }).click();
    // The domains and zones load with the tab.
    await expect(
      page.getByRole('combobox', { name: 'Cloudflare zone', exact: true }),
    ).toContainText('example.com');
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Who can open previews' }),
    });
    await expect(section.getByRole('alert')).toContainText(
      'The provider denied access',
    );
    // Only this section reports it; custom domains stay usable.
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Refresh domains' }),
    ).toBeEnabled();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('a custom domains error stays in its own section', async ({
  page,
  request,
}) => {
  const name = `qa-domains-denied-${Date.now()}`;
  const project = await (
    await request.post('/api/projects', { data: { name, framework: 'worker' } })
  ).json();
  const root = `/api/projects/${project.id}`;
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/zones')
        return route.fulfill({
          status: 403,
          json: { error: 'Cloudflare denied access to this account’s zones.' },
        });
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
        '/domains': [],
        '/access': {
          organization: null,
          organizationError: null,
          loginMethods: [],
          protection: null,
        },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Domains', exact: true }).click();
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Custom domains' }),
    });
    await expect(section.getByRole('alert')).toContainText(
      'Cloudflare denied access to this account’s zones.',
    );
    await expect(page.getByRole('alert')).toHaveCount(1);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
