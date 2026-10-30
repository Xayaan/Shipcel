import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;
const origin = 'http://127.0.0.1:5173';
const notSetUp = {
  configured: false,
  source: null,
  name: null,
  url: null,
  accountId: null,
  scopes: [],
};

// A local Shipcel before any sign-in is set up, signed in to its local workspace.
async function localShipcel(page: Page, setup: Record<string, unknown>) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: {
          login: 'Local workspace',
          workspaceId: 'local',
          role: 'owner',
          local: true,
          workspaces: [],
        },
        githubConfigured: false,
        local: true,
      },
    }),
  );
  await page.route('**/api/connections', (route) =>
    route.fulfill({
      json: {
        github: {
          configured: (setup.github as { configured: boolean }).configured,
          connected: false,
          installUrl: null,
        },
        cloudflare: {
          configured: (setup.cloudflare as { configured: boolean }).configured,
          connected: false,
          account: null,
        },
        nativeBuildsEnabled: false,
      },
    }),
  );
  await page.route('**/api/setup', (route) => route.fulfill({ json: setup }));
}

test('GitHub sign-in is set up in one click: GitHub opens with the app filled in', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await localShipcel(page, {
    available: true,
    encryption: true,
    origin,
    github: { ...notSetUp, callbackUrl: `${origin}/api/auth/github/callback` },
    cloudflare: {
      ...notSetUp,
      redirectUrl: `${origin}/api/auth/cloudflare/callback`,
    },
  });
  const manifest = {
    name: 'Shipcel abc123',
    url: origin,
    redirect_url: `${origin}/api/setup/github/created`,
    callback_urls: [`${origin}/api/auth/github/callback`],
    public: false,
    default_permissions: { contents: 'read', metadata: 'read' },
  };
  let asked: unknown = null;
  await page.route('**/api/setup/github', async (route) => {
    asked = route.request().postDataJSON();
    return route.fulfill({
      json: {
        action:
          'https://github.com/organizations/acme/settings/apps/new?state=s1',
        manifest,
      },
    });
  });
  let posted: { method: string; body: string } | null = null;
  await page.route(
    'https://github.com/organizations/acme/settings/apps/new*',
    (route) => {
      posted = {
        method: route.request().method(),
        body: route.request().postData() ?? '',
      };
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>GitHub</title><h1>Create GitHub App</h1>',
      });
    },
  );
  await page.goto('/app/#connections');
  await expect(page.getByText('Set up GitHub sign-in')).toBeVisible();
  await expect(page.getByText('Set up Cloudflare sign-in')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page
    .getByRole('textbox', { name: 'Create it for an organization' })
    .fill('acme');
  await page
    .getByRole('button', { name: 'Create GitHub App on GitHub' })
    .click();
  await expect(page).toHaveURL(/github\.com\/organizations\/acme/);
  expect(asked).toEqual({ organization: 'acme' });
  expect(posted).not.toBeNull();
  expect(posted!.method).toBe('POST');
  expect(
    JSON.parse(new URLSearchParams(posted!.body).get('manifest')!),
  ).toEqual(manifest);
  expect(errors).toEqual([]);
});

test('Cloudflare sign-in is set up with a temporary token, or by hand', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const setup: {
    github: Record<string, unknown>;
    cloudflare: Record<string, unknown>;
    [key: string]: unknown;
  } = {
    available: true,
    encryption: true,
    origin,
    github: {
      ...notSetUp,
      configured: true,
      source: 'setup',
      name: 'Shipcel abc123',
      url: 'https://github.com/apps/shipcel-abc123',
      callbackUrl: `${origin}/api/auth/github/callback`,
    },
    cloudflare: {
      ...notSetUp,
      redirectUrl: `${origin}/api/auth/cloudflare/callback`,
    },
  };
  await localShipcel(page, setup);
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/setup/cloudflare/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    requests.push({ path, ...body });
    if (path.endsWith('/inspect'))
      return route.fulfill({
        json: {
          accounts: [
            { id: 'a'.repeat(32), name: 'Personal' },
            { id: 'b'.repeat(32), name: 'Acme' },
          ],
          scopes: [
            { id: 'account.read', name: 'Account Read' },
            { id: 'workers_scripts.write', name: 'Workers Scripts Write' },
          ],
          missing: ['Workers Observability Write'],
          ready: true,
        },
      });
    setup.cloudflare = {
      ...setup.cloudflare,
      configured: true,
      source: 'setup',
      name: 'Shipcel local',
      accountId: 'b'.repeat(32),
      scopes: ['account.read', 'workers_scripts.write', 'offline_access'],
    };
    await localShipcel(page, setup);
    return route.fulfill({
      json: { configured: true, refreshTokens: true, scopes: [] },
    });
  });
  await page.goto('/app/#connections');
  await expect(
    page.getByRole('link', { name: 'Open Cloudflare API tokens' }),
  ).toHaveAttribute('href', 'https://dash.cloudflare.com/profile/api-tokens');
  const token = page.getByLabel('Temporary API token');
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('temporary-setup-token-123456');
  await page.getByRole('button', { name: 'Check token' }).click();
  await expect(
    page.getByText(
      'Shipcel will ask for: Account Read, Workers Scripts Write.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Workers Observability Write')).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Account that owns the client' })
    .selectOption('b'.repeat(32));
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Create OAuth client' }).click();
  await expect(
    page.getByText('Cloudflare sign-in is set up.', { exact: false }),
  ).toBeVisible();
  // The token leaves the page once the client exists.
  await expect(page.getByLabel('Temporary API token')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Connect Cloudflare' }),
  ).toBeVisible();
  await expect(page.getByText('Connect GitHub first')).toBeVisible();
  expect(requests).toEqual([
    {
      path: '/api/setup/cloudflare/inspect',
      token: 'temporary-setup-token-123456',
    },
    {
      path: '/api/setup/cloudflare/create',
      token: 'temporary-setup-token-123456',
      accountId: 'b'.repeat(32),
    },
  ]);
  expect(errors).toEqual([]);
});

test('a Cloudflare OAuth client made by hand can be entered instead', async ({
  page,
}) => {
  await localShipcel(page, {
    available: true,
    encryption: true,
    origin,
    github: { ...notSetUp, callbackUrl: `${origin}/api/auth/github/callback` },
    cloudflare: {
      ...notSetUp,
      redirectUrl: `${origin}/api/auth/cloudflare/callback`,
    },
  });
  let saved: unknown = null;
  await page.route('**/api/setup/cloudflare', async (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { configured: true, scopes: [] } });
  });
  await page.goto('/app/#connections');
  await page.getByText('Create the OAuth client yourself instead').click();
  await expect(
    page.getByText(`${origin}/api/auth/cloudflare/callback`),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Client ID' }).fill('hand-made');
  await page.getByLabel('Client secret').fill('hand-made-secret');
  await page
    .getByRole('textbox', { name: 'Scopes, as Cloudflare lists them' })
    .fill('account.read offline_access');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Cloudflare sign-in is set up.')).toBeVisible();
  expect(saved).toEqual({
    clientId: 'hand-made',
    clientSecret: 'hand-made-secret',
    scopes: 'account.read offline_access',
  });
  await expect(page.getByLabel('Client secret')).toHaveValue('');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(await axe(page)).toEqual([]);
  }
});

test('setup asks for the encryption key before anything else', async ({
  page,
}) => {
  await localShipcel(page, {
    available: true,
    encryption: false,
    origin,
    github: { ...notSetUp, callbackUrl: `${origin}/api/auth/github/callback` },
    cloudflare: {
      ...notSetUp,
      redirectUrl: `${origin}/api/auth/cloudflare/callback`,
    },
  });
  await page.goto('/app/#connections');
  await expect(page.getByText('Add an encryption key first')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Create GitHub App on GitHub' }),
  ).toHaveCount(0);
});

test('an older Cloudflare client that can’t create Workers is updated from Connections', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const configured = {
    ...notSetUp,
    configured: true,
    source: 'setup',
    name: 'Shipcel local',
    accountId: 'a'.repeat(32),
    redirectUrl: `${origin}/api/auth/cloudflare/callback`,
  };
  const setup: {
    github: Record<string, unknown>;
    cloudflare: Record<string, unknown>;
    [key: string]: unknown;
  } = {
    available: true,
    encryption: true,
    origin,
    github: {
      ...notSetUp,
      configured: true,
      source: 'setup',
      callbackUrl: `${origin}/api/auth/github/callback`,
    },
    cloudflare: {
      ...configured,
      scopes: [
        'account-settings.read',
        'workers-scripts.edit',
        'offline_access',
      ],
      outdated: ['Workers Scripts Write'],
    },
  };
  await localShipcel(page, setup);
  let sent: unknown = null;
  await page.route('**/api/setup/cloudflare/update', async (route) => {
    sent = route.request().postDataJSON();
    setup.cloudflare = {
      ...configured,
      scopes: [
        'account-settings.read',
        'workers-scripts.write',
        'offline_access',
      ],
      outdated: [],
    };
    await localShipcel(page, setup);
    return route.fulfill({ json: { updated: 'in place', reconnect: true } });
  });
  await page.goto('/app/#connections');
  const update = page.getByRole('region', {
    name: 'Update Cloudflare sign-in',
  });
  await expect(update).toContainText('can’t create them');
  await expect(
    update.getByRole('link', { name: 'Open Cloudflare API tokens' }),
  ).toHaveAttribute('href', 'https://dash.cloudflare.com/profile/api-tokens');
  expect(await axe(page)).toEqual([]);
  const field = update.getByLabel('Temporary API token');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill('temporary-setup-token-123456');
  await update.getByRole('button', { name: 'Update OAuth client' }).click();
  await expect(
    page.getByText('Connect Cloudflare again', { exact: false }).first(),
  ).toBeVisible();
  expect(sent).toEqual({ token: 'temporary-setup-token-123456' });
  await expect(
    page.getByRole('region', { name: 'Update Cloudflare sign-in' }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
