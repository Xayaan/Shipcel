import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;

// Provider routes below are explicit fixtures. This proves the dashboard behaviour, not a
// live sign-in service.
test('sign-in & realtime: reviewed setup, settings, providers, users and removal', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  const name = `qa-backend-${Date.now()}`;
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
  const app = 'https://cc-fixture-worker.example.workers.dev/';
  const worker = 'cc-fixture-worker-backend';
  const url = `https://${worker}.example.workers.dev`;
  const plan = {
    workerName: worker,
    databaseName: `${worker}-db-…`,
    appSecrets: [
      'CLOUDCEL_AUTH_ISSUER',
      'CLOUDCEL_CLIENT_ID',
      'CLOUDCEL_REALTIME_URL',
      'CLOUDCEL_REALTIME_SECRET',
    ],
  };
  let state: 'off' | 'needs_attention' | 'active' = 'off';
  let interrupt = true;
  let updated = false;
  const settings: Record<string, unknown> = {
    appName: name,
    redirectUris: [`${app}auth/callback`],
    logoutUris: [app],
    githubClientId: null,
    googleClientId: null,
    signin: true,
    realtime: true,
  };
  const ada = {
    id: 'user-aaaaaaaaaa',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada',
    disabled: false,
    createdAt: 1791300000,
    lastSignInAt: 1791300500,
    providers: ['github'],
    passkeys: 1,
  };
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      const method = route.request().method();
      if (method !== 'GET') {
        const body = route.request().postDataJSON();
        expect(body.confirm).toBe(true);
        expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
        writes.push({ method, path, body });
        if (path === '/backend' && method === 'POST') {
          // The first attempt stops part-way, as an interrupted setup would.
          if (interrupt) {
            interrupt = false;
            state = 'needs_attention';
            return route.fulfill({
              status: 502,
              json: {
                id: 'operation-fixture',
                status: 'needs_attention',
                error: 'Cloudflare reported: fixture interruption',
              },
            });
          }
          state = 'active';
        }
        if (path === '/backend' && method === 'DELETE') state = 'off';
        if (path === '/backend/settings') {
          const { requestId: _r, confirm: _c, ...rest } = body;
          Object.assign(settings, rest);
        }
        if (path === '/backend/providers/github')
          settings.githubClientId = method === 'PUT' ? body.clientId : null;
        if (path === `/backend/users/${ada.id}/disable`) ada.disabled = true;
        if (path === '/backend/update') updated = true;
        return route.fulfill({
          json: { id: 'operation-fixture', status: 'succeeded', result: {} },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [
          {
            id: 'job-fixture',
            status: 'deployed',
            environment: 'production',
            live_url: app,
          },
        ],
        '/operations': [],
        '/backend':
          state === 'off'
            ? { status: 'off', latestVersion: 'b2b2b2b2b2b2', plan }
            : state === 'needs_attention'
              ? {
                  status: 'needs_attention',
                  error: 'Cloudflare reported: fixture interruption',
                  url: null,
                  clientId: 'cc_fixtureclientid',
                  version: null,
                  latestVersion: 'b2b2b2b2b2b2',
                  updateAvailable: false,
                  workerName: worker,
                  plan,
                  settings: null,
                }
              : {
                  status: 'active',
                  error: null,
                  url,
                  clientId: 'cc_fixtureclientid',
                  version: updated ? 'b2b2b2b2b2b2' : 'a1a1a1a1a1a1',
                  latestVersion: 'b2b2b2b2b2b2',
                  updateAvailable: !updated,
                  workerName: worker,
                  plan,
                  settings,
                },
        '/backend/users': { total: 1, users: [ada] },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    const dialog = page.getByRole('dialog');
    const confirmChange = () =>
      dialog.getByRole('button', { name: 'Confirm change' }).click();
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Sign-in & realtime', exact: true })
      .click();

    // Off: the plan is shown before anything is created.
    await expect(page.getByText('What Shipcel will create')).toBeVisible();
    await expect(page.getByText(`Worker ${worker}`)).toBeVisible();
    await expect(page.getByText(`D1 database ${worker}-db-…`)).toBeVisible();
    await expect(page.getByText('CLOUDCEL_REALTIME_SECRET')).toBeVisible();
    await page
      .getByRole('button', { name: 'Turn on sign-in & realtime' })
      .click();
    await expect(
      dialog.getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(writes).toHaveLength(0);
    // Focus goes back to what opened the dialog.
    await expect(
      page.getByRole('button', { name: 'Turn on sign-in & realtime' }),
    ).toBeFocused();

    // An interrupted setup is reported, and continuing finishes it.
    await page
      .getByRole('button', { name: 'Turn on sign-in & realtime' })
      .click();
    await confirmChange();
    await expect(page.getByRole('alert')).toContainText('fixture interruption');
    await expect(
      page.getByText('Setup incomplete', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue setup' }).click();
    await confirmChange();
    await expect(page.getByRole('status')).toContainText(
      'Sign-in and realtime are on',
    );
    await expect(page.getByRole('link', { name: url })).toBeVisible();
    // The button that opened it is gone, so focus lands on the current tab.
    await expect(
      page.getByRole('tab', { name: 'Sign-in & realtime', exact: true }),
    ).toBeFocused();
    await expect(page.getByText('cc_fixtureclientid').first()).toBeVisible();
    await expect(
      page.getByText(`${url.replace('https', 'wss')}/realtime/channels/`, {
        exact: true,
      }),
    ).toBeVisible();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /backend',
      'POST /backend',
    ]);

    // Settings are saved as entered, one return address per line.
    await page
      .getByLabel('App name on the sign-in page', { exact: true })
      .fill('Fixture Shop');
    await page
      .getByRole('textbox', {
        name: 'Return addresses after sign-in',
        exact: true,
      })
      .fill(`${app}auth/callback\n\nhttp://localhost:5173/auth/callback\n`);
    await page
      .getByRole('checkbox', { name: 'Allow realtime connections' })
      .uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(dialog).toContainText('Realtime will be turned off');
    await confirmChange();
    await expect(page.getByRole('status')).toContainText(
      'Sign-in settings saved',
    );
    expect(writes[2]).toMatchObject({
      method: 'PUT',
      path: '/backend/settings',
      body: {
        appName: 'Fixture Shop',
        redirectUris: [
          `${app}auth/callback`,
          'http://localhost:5173/auth/callback',
        ],
        logoutUris: [app],
        signin: true,
        realtime: false,
      },
    });
    await expect(
      page.getByRole('checkbox', { name: 'Allow realtime connections' }),
    ).not.toBeChecked();

    // A provider secret is cleared from the form whether or not it is sent.
    await expect(
      page.getByText(`${url}/oauth/github/callback`, { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('GitHub client ID', { exact: true })
      .fill('Iv1.fixture');
    await page
      .getByLabel('GitHub client secret', { exact: true })
      .fill('fixture-only-secret');
    await page.getByRole('button', { name: 'Turn on GitHub sign-in' }).click();
    await expect(dialog).toContainText('Shipcel keeps no copy');
    await page.keyboard.press('Escape');
    await expect(
      page.getByLabel('GitHub client secret', { exact: true }),
    ).toHaveValue('');
    expect(writes).toHaveLength(3);
    await page
      .getByLabel('GitHub client secret', { exact: true })
      .fill('fixture-only-secret');
    await page.getByRole('button', { name: 'Turn on GitHub sign-in' }).click();
    await confirmChange();
    await expect(page.getByRole('status')).toContainText(
      'GitHub sign-in is on',
    );
    expect(writes[3]).toMatchObject({
      method: 'PUT',
      path: '/backend/providers/github',
      body: { clientId: 'Iv1.fixture', clientSecret: 'fixture-only-secret' },
    });
    await expect(page.getByText('Iv1.fixture', { exact: true })).toBeVisible();
    await expect(
      page.getByLabel('GitHub client secret', { exact: true }),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain('fixture-only-secret');

    // Users can be reviewed and disabled.
    await page.getByRole('button', { name: 'Load users' }).click();
    await expect(page.getByText('Ada', { exact: true })).toBeVisible();
    await expect(page.getByText('GitHub, 1 passkey')).toBeVisible();
    await page.getByRole('button', { name: 'Disable Ada' }).click();
    await expect(dialog).toContainText('signed out everywhere');
    await confirmChange();
    await expect(page.getByRole('status')).toContainText('User disabled');
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Enable Ada' }),
    ).toBeVisible();
    expect(writes[4]).toMatchObject({
      method: 'POST',
      path: `/backend/users/${ada.id}/disable`,
    });

    // Updates and secret rotation are confirmed like every other change.
    await page.getByRole('button', { name: 'Install update' }).click();
    await confirmChange();
    await expect(page.getByRole('status')).toContainText('was updated');
    await expect(page.getByText('Install update')).toHaveCount(0);
    await page.getByRole('button', { name: 'Replace secret' }).click();
    await confirmChange();
    await expect(page.getByRole('status')).toContainText(
      'realtime secret was replaced',
    );
    await expect(
      page.getByRole('button', { name: 'Replace secret' }),
    ).toBeFocused();
    expect(writes.slice(5).map((w) => w.path)).toEqual([
      '/backend/update',
      '/backend/realtime-secret',
    ]);

    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({
        path: `docs/screenshots/backend-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Removal needs the Worker name typed, then a confirmation.
    const remove = page.getByRole('button', {
      name: 'Remove sign-in & realtime',
    });
    await expect(remove).toBeDisabled();
    await page.getByLabel(`Type ${worker} to confirm`).fill('wrong-name');
    await expect(remove).toBeDisabled();
    await page.getByLabel(`Type ${worker} to confirm`).fill(worker);
    await remove.click();
    await expect(dialog).toContainText('cannot be undone');
    await confirmChange();
    await expect(page.getByRole('status')).toContainText('were removed');
    expect(writes.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/backend',
      body: { confirmName: worker },
    });
    await expect(page.getByText('What Shipcel will create')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('sign-in & realtime stays removable when its database cannot be read', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-backend-gone-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const worker = 'cc-fixture-worker-backend';
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      const data: Record<string, unknown> = {
        '/deployments': [{ id: 'job-fixture', status: 'deployed' }],
        '/operations': [],
        '/backend': {
          status: 'active',
          error: null,
          url: `https://${worker}.example.workers.dev`,
          clientId: 'cc_fixtureclientid',
          version: 'a1a1a1a1a1a1',
          latestVersion: 'a1a1a1a1a1a1',
          updateAvailable: false,
          workerName: worker,
          plan: {
            workerName: worker,
            databaseName: `${worker}-db-…`,
            appSecrets: ['CLOUDCEL_AUTH_ISSUER'],
          },
          settings: null,
          settingsError: 'Cloudflare reported: database not found',
        },
      };
      if (route.request().method() !== 'GET' || !(path in data))
        return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Sign-in & realtime', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Settings unavailable' }),
    ).toBeVisible();
    await expect(page.getByText('database not found')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Save settings' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load users' })).toHaveCount(
      0,
    );
    await expect(page.getByLabel(`Type ${worker} to confirm`)).toBeVisible();
    expect(await axe(page)).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('the data API opens tables, with who may read and change each, after confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-data-api-${Date.now()}`;
  const response = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await response.json();
  const root = `/api/projects/${project.id}`;
  const worker = 'cc-fixture-worker-backend';
  const app = 'https://cc-fixture-worker.example.workers.dev/';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let view: Record<string, unknown> = {
    binding: null,
    databases: ['DB'],
    tables: {},
    schema: {
      notes: ['id', 'user_id', 'body'],
      posts: ['id', 'author', 'title'],
    },
  };
  const writes: Record<string, unknown>[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/backend/data' && route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        writes.push(body);
        view = { ...view, binding: body.binding, tables: body.tables };
        return route.fulfill({
          json: { id: 'operation-fixture', status: 'succeeded', result: {} },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [
          {
            id: 'job',
            status: 'deployed',
            environment: 'production',
            live_url: app,
          },
        ],
        '/operations': [],
        '/backend': {
          status: 'active',
          error: null,
          url: `https://${worker}.example.workers.dev`,
          clientId: 'cc_fixtureclientid',
          version: 'b2b2b2b2b2b2',
          latestVersion: 'b2b2b2b2b2b2',
          updateAvailable: false,
          workerName: worker,
          plan: {
            workerName: worker,
            databaseName: `${worker}-db-…`,
            appSecrets: ['CLOUDCEL_AUTH_ISSUER'],
          },
          settings: {
            appName: name,
            redirectUris: [`${app}auth/callback`],
            logoutUris: [app],
            githubClientId: null,
            googleClientId: null,
            signin: true,
            realtime: true,
          },
        },
        '/backend/users': { total: 0, users: [] },
        '/backend/data': view,
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page
      .getByRole('tab', { name: 'Sign-in & realtime', exact: true })
      .click();
    const notes = page.getByRole('group', { name: 'notes' });
    await notes.getByRole('checkbox', { name: 'Open to the data API' }).check();
    await notes.getByLabel('Who reads').selectOption('owner');
    await notes.getByLabel('Who changes').selectOption('owner');
    // Saving waits for the column that says whose a row is.
    const save = page.getByRole('button', { name: 'Save data API' });
    await expect(save).toBeDisabled();
    await notes.getByLabel('Owner column').selectOption('user_id');
    await save.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'notes: read by each user, their own rows, changed by each user, their own rows',
    );
    await expect(dialog).toContainText('deployed again with the DB database');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toContainText('Data API saved.');
    expect(writes).toEqual([
      {
        binding: 'DB',
        tables: { notes: { read: 'owner', write: 'owner', owner: 'user_id' } },
        requestId: expect.any(String),
        confirm: true,
      },
    ]);
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Data API' }),
    });
    await expect(section.getByText('On', { exact: true })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
