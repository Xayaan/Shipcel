import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Browser fixtures validate UI contracts only; they are not live provider evidence.
const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;
const accountId = 'a'.repeat(32),
  tokenId = '10000000-0000-4000-8000-000000000001';

async function connected(page: Page, github = true) {
  await page.route('**/api/connections', (route) =>
    route.fulfill({
      json: {
        github: {
          configured: true,
          connected: github,
          installUrl: 'https://github.com/apps/shipcel-test/installations/new',
        },
        cloudflare: {
          configured: true,
          connected: true,
          account: { id: accountId, name: 'Test account' },
        },
        nativeBuildsEnabled: true,
      },
    }),
  );
}

test('a new project starts from a starter kit or from a GitHub repository, never both', async ({
  page,
  request,
}) => {
  const repo = `landing-${Date.now()}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await connected(page);
  await page.route('**/api/connections/github/installations', (route) =>
    route.fulfill({
      json: {
        installations: [
          { id: 1, account: { login: 'alice' } },
          { id: 2, account: { login: 'acme' } },
        ],
        total: 2,
      },
    }),
  );
  const listed: string[] = [];
  await page.route('**/api/connections/github/repositories?*', (route) => {
    const url = new URL(route.request().url());
    const installation = url.searchParams.get('installation')!;
    const page = url.searchParams.get('page');
    listed.push(`${installation}:${page}`);
    if (installation === '2' && page === '2')
      return route.fulfill({
        json: {
          repositories: [
            {
              id: 22,
              fullName: 'acme/docs',
              defaultBranch: 'main',
              private: false,
            },
          ],
          nextPage: null,
        },
      });
    return route.fulfill({
      json: {
        repositories:
          installation === '1'
            ? [
                {
                  id: 11,
                  fullName: `alice/${repo}`,
                  defaultBranch: 'main',
                  private: true,
                },
                {
                  id: 12,
                  fullName: 'alice/api',
                  defaultBranch: 'main',
                  private: false,
                },
              ]
            : [
                {
                  id: 21,
                  fullName: 'acme/site',
                  defaultBranch: 'main',
                  private: false,
                },
              ],
        nextPage: installation === '2' ? 2 : null,
      },
    });
  });
  const detected: string[] = [];
  await page.route('**/api/repositories/detect?*', (route) => {
    const name = new URL(route.request().url()).searchParams.get('repository')!;
    detected.push(name);
    return route.fulfill({
      json: {
        repository: name,
        branch: 'main',
        framework: name === 'acme/site' ? null : 'astro',
      },
    });
  });
  const inspected: unknown[] = [];
  await page.route('**/api/projects/*/repository', (route) => {
    inspected.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        repository: `alice/${repo}`,
        branch: 'main',
        commit: 'b'.repeat(40),
        adapter: 'astro',
        resources: [],
        warnings: [],
        issues: [],
        ready: true,
      },
    });
  });
  await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
    route.fulfill({ json: [{ id: tokenId, name: 'Builds' }] }),
  );
  await page.route('**/api/connections/cloudflare/subdomain', (route) =>
    route.fulfill({ json: { subdomain: 'alice' } }),
  );
  try {
    await page.goto('/app/');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Create a project' });
    const kit = dialog.getByRole('radio', { name: /^Starter kit/ });
    const github = dialog.getByRole('radio', { name: /^GitHub repository/ });
    const repository = dialog.getByRole('combobox', {
      name: 'Repository',
      exact: true,
    });
    // A starter kit: kit runtimes and resources, no repository.
    await expect(kit).toBeChecked();
    await expect(dialog.getByLabel('SQL database')).toBeVisible();
    await expect(repository).toHaveCount(0);
    await expect(
      dialog.getByRole('textbox', { name: /repository/i }),
    ).toHaveCount(0);
    // A GitHub repository: the repositories load by themselves; kit fields go away.
    await github.check();
    await expect(dialog.getByLabel('SQL database')).toHaveCount(0);
    await expect(
      dialog.getByRole('combobox', { name: 'Starter kit', exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('combobox', { name: 'GitHub account' }),
    ).toHaveValue('1');
    await expect(repository.locator('option')).toHaveText([
      'Select a repository',
      `alice/${repo}, private`,
      'alice/api',
    ]);
    await expect(
      dialog.getByRole('link', { name: /Choose which repositories/ }),
    ).toHaveAttribute(
      'href',
      'https://github.com/apps/shipcel-test/installations/new',
    );
    const create = dialog.getByRole('button', {
      name: 'Create project',
      exact: true,
    });
    await expect(create).toBeDisabled();
    // Another account's repositories replace the list.
    await dialog
      .getByRole('combobox', { name: 'GitHub account' })
      .selectOption('2');
    await expect(repository.locator('option')).toHaveText([
      'Select a repository',
      'acme/site',
    ]);
    await dialog
      .getByRole('button', { name: 'Load more repositories' })
      .click();
    await expect(repository.locator('option')).toHaveText([
      'Select a repository',
      'acme/site',
      'acme/docs',
    ]);
    await expect(
      dialog.getByRole('button', { name: 'Load more repositories' }),
    ).toHaveCount(0);
    // A repository Shipcel can't recognise is said so, and can't be created as a project.
    await repository.selectOption('acme/site');
    await expect(dialog.getByRole('alert')).toContainText(
      'Shipcel couldn’t tell what acme/site runs',
    );
    await expect(create).toBeDisabled();
    await dialog
      .getByRole('combobox', { name: 'GitHub account' })
      .selectOption('1');
    // Another account clears the choice.
    await expect(repository).toHaveValue('');
    await expect(create).toBeDisabled();
    // Choosing a repository fills the name, and Shipcel detects the runtime it uses:
    // there is nothing to choose.
    await repository.selectOption(`alice/${repo}`);
    const runtime = dialog.getByRole('status', {
      name: 'Framework or runtime',
    });
    await expect(runtime).toContainText(`Astro, detected from alice/${repo}`);
    await expect(
      dialog.getByRole('combobox', { name: 'Framework or runtime' }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('textbox', { name: 'Project name' }),
    ).toHaveValue(repo);
    expect(listed).toEqual(['1:1', '2:1', '2:2', '1:1']);
    expect(detected).toEqual(['acme/site', `alice/${repo}`]);
    expect(await axe(page)).toEqual([]);
    // Back to a starter kit: its fields return and the repository is dropped.
    await kit.check();
    await expect(dialog.getByLabel('SQL database')).toBeVisible();
    await expect(repository).toHaveCount(0);
    await github.check();
    await expect(repository).toHaveValue('');
    await expect(create).toBeDisabled();
    // A name the person typed stays when they choose a repository.
    const custom = `qa-${repo}`;
    await dialog.getByRole('textbox', { name: 'Project name' }).fill(custom);
    // A slow answer for an earlier choice doesn't override a later one.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      '**/api/repositories/detect?repository=alice%2Fapi',
      async (route) => {
        await held;
        await route.fulfill({
          json: { repository: 'alice/api', branch: 'main', framework: 'hono' },
        });
      },
    );
    await repository.selectOption('alice/api');
    await expect(dialog.getByText('Reading alice/api…')).toBeVisible();
    await expect(create).toBeDisabled();
    await repository.selectOption(`alice/${repo}`);
    await expect(runtime).toContainText(`Astro, detected from alice/${repo}`);
    release();
    await page.waitForTimeout(300);
    await expect(runtime).toContainText(`Astro, detected from alice/${repo}`);
    await expect(
      dialog.getByRole('textbox', { name: 'Project name' }),
    ).toHaveValue(custom);
    const posted = page.waitForRequest(
      (r) => r.url().endsWith('/api/projects') && r.method() === 'POST',
    );
    await create.click();
    expect((await posted).postDataJSON()).toEqual({
      name: custom,
      framework: 'astro',
      source: 'github',
      repository: `https://github.com/alice/${repo}`,
      database: false,
      storage: false,
      freeOnly: true,
    });
    // The project opens on Deployments with the repository already inspected.
    await expect(page.getByRole('heading', { name: custom })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Deployments', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      page.getByRole('heading', { name: 'Repository configuration is ready' }),
    ).toBeVisible();
    expect(inspected).toEqual([{ repository: `alice/${repo}` }]);
    await expect(
      page.getByRole('combobox', { name: 'Build token', exact: true }),
    ).toHaveValue(tokenId);
    for (const name of [
      'Load GitHub installations',
      'Inspect and link repository',
      'Load Cloudflare build tokens',
      'Export starter kit',
      'Configuration',
    ])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(
        0,
      );
    // Another repository is still one click away.
    await page.getByRole('button', { name: 'Change repository' }).click();
    await expect(
      page.getByRole('combobox', { name: 'Repository', exact: true }),
    ).toBeVisible();
    // Opened from the list later, the project starts on its overview.
    await page.getByRole('button', { name: 'All projects' }).click();
    await page.getByRole('button', { name: new RegExp(custom) }).click();
    await expect(
      page.locator('.tabs').getByRole('button', { name: 'Overview' }),
    ).toHaveAttribute('aria-current', 'page');
    // Its badge is its state until the first deploy runs.
    await expect(
      page
        .locator('.detail-heading')
        .getByText('Not deployed', { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    // Removed by name, so a failure partway leaves nothing behind.
    const created = (
      (await (await request.get('/api/projects')).json()) as {
        id: string;
        name: string;
      }[]
    ).filter((p) => p.name === repo || p.name === `qa-${repo}`);
    for (const p of created) await request.delete(`/api/projects/${p.id}`);
  }
});

test('a GitHub project asks for GitHub to be connected first', async ({
  page,
}) => {
  await connected(page, false);
  await page.goto('/app/');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a project' });
  await dialog.getByRole('radio', { name: /^GitHub repository/ }).check();
  await expect(
    dialog.getByText('Connect GitHub to choose a repository'),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Create project', exact: true }),
  ).toBeDisabled();
  expect(await axe(page)).toEqual([]);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Open Connections' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#connections$/);
  await expect(
    page.getByRole('heading', { name: 'Connections', exact: true }),
  ).toBeVisible();
});

test('Deployments recovers from a repository it can’t read and from missing build tokens', async ({
  page,
  request,
}) => {
  const name = `qa-gone-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: {
      name,
      framework: 'worker',
      source: 'github',
      repository: 'https://github.com/alice/gone',
    },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await connected(page);
  await page.route('**/api/connections/github/installations', (route) =>
    route.fulfill({
      json: {
        installations: [{ id: 1, account: { login: 'alice' } }],
        total: 1,
      },
    }),
  );
  await page.route('**/api/connections/github/repositories?*', (route) =>
    route.fulfill({
      json: {
        repositories: [
          {
            id: 1,
            fullName: 'alice/site',
            defaultBranch: 'main',
            private: false,
          },
        ],
        nextPage: null,
      },
    }),
  );
  const inspected: string[] = [];
  await page.route(`**/api/projects/${project.id}/repository`, (route) => {
    const { repository } = route.request().postDataJSON();
    inspected.push(repository);
    return repository === 'alice/gone'
      ? route.fulfill({
          status: 403,
          json: { error: 'You need write access to deploy this repository.' },
        })
      : route.fulfill({
          json: {
            repository,
            branch: 'main',
            commit: 'c'.repeat(40),
            adapter: 'configured-worker',
            resources: [],
            warnings: [],
            issues: [],
            ready: true,
          },
        });
  });
  const tokenAnswers = [
    { status: 502, json: { error: 'Cloudflare is unavailable.' } },
    { status: 200, json: [] },
    { status: 200, json: [{ id: tokenId, name: 'Builds' }] },
  ];
  await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
    route.fulfill(tokenAnswers.shift()!),
  );
  await page.route('**/api/connections/cloudflare/subdomain', (route) =>
    route.fulfill({ json: { subdomain: 'alice' } }),
  );
  try {
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    // The saved repository can't be read: the list of repositories shows instead.
    await expect(page.getByRole('alert').first()).toContainText('write access');
    const repository = page.getByRole('combobox', {
      name: 'Repository',
      exact: true,
    });
    await repository.selectOption('alice/site');
    await expect(
      page.getByRole('heading', { name: 'Repository configuration is ready' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect
      .poll(() => inspected)
      .toEqual(['alice/gone', 'alice/site', 'alice/site']);
    // Build tokens: an error, then none yet, then one, chosen by itself.
    await expect(
      page.getByText('Cloudflare didn’t list the build tokens', {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByText('Cloudflare needs a build token first', { exact: false }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'check for build tokens' }).click();
    await expect(
      page.getByRole('combobox', { name: 'Build token', exact: true }),
    ).toHaveValue(tokenId);
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

test('a GitHub account without the app on any repository is sent to GitHub to choose some', async ({
  page,
}) => {
  await connected(page);
  await page.route('**/api/connections/github/installations', (route) =>
    route.fulfill({ json: { installations: [], total: 0 } }),
  );
  await page.goto('/app/');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a project' });
  await dialog.getByRole('radio', { name: /^GitHub repository/ }).check();
  await expect(
    dialog.getByText('Shipcel can’t see any repositories yet'),
  ).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: /Choose which repositories/ }),
  ).toHaveAttribute(
    'href',
    'https://github.com/apps/shipcel-test/installations/new',
  );
  await expect(
    dialog.getByRole('button', { name: 'Create project', exact: true }),
  ).toBeDisabled();
  expect(await axe(page)).toEqual([]);
});

test('a link to a project opens it, on the tab it names', async ({
  page,
  request,
}) => {
  const name = `qa-link-${Date.now()}`;
  const project = await (
    await request.post('/api/projects', {
      data: { name, framework: 'static' },
    })
  ).json();
  try {
    await connected(page, false);
    await page.goto(`/app/#projects/${project.id}/deployments`);
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.tabs').getByRole('button', { name: 'Deployments' }),
    ).toHaveAttribute('aria-current', 'page');
    // Following a link within the dashboard changes only the address's fragment.
    await page.goto(`/app/#projects/${project.id}`);
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.tabs').getByRole('button', { name: 'Overview' }),
    ).toHaveAttribute('aria-current', 'page');
    // A project from another workspace, or one that was removed.
    await page.goto('/app/#projects/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('status')).toContainText(
      'That project isn’t in this workspace',
    );
    await expect(
      page.getByRole('heading', { name: 'Projects', exact: true }),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('a site without a Wrangler configuration shows what Shipcel deploys', async ({
  page,
  request,
}) => {
  const name = `qa-site-${Date.now()}`;
  const project = await (
    await request.post('/api/projects', {
      data: {
        name,
        framework: 'react',
        source: 'github',
        repository: 'https://github.com/alice/landing',
      },
    })
  ).json();
  await connected(page);
  await page.route(`**/api/projects/${project.id}/repository`, (route) =>
    route.fulfill({
      json: {
        repository: 'alice/landing',
        branch: 'main',
        commit: 'd'.repeat(40),
        adapter: 'static-assets',
        buildCommand: 'npm run build',
        site: { preset: 'Vite', directory: 'dist', spa: true },
        resources: [],
        warnings: [
          'No Wrangler configuration needed: Shipcel deploys dist/ as a single-page app (Vite), with a configuration it writes during the build. Commit a wrangler.jsonc to change how the site is served.',
        ],
        issues: [],
        ready: true,
      },
    }),
  );
  await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
    route.fulfill({ json: [{ id: tokenId, name: 'Builds' }] }),
  );
  await page.route('**/api/connections/cloudflare/subdomain', (route) =>
    route.fulfill({ json: { subdomain: 'alice' } }),
  );
  try {
    await page.goto(`/app/#projects/${project.id}/deployments`);
    await expect(
      page.getByRole('heading', { name: 'Repository configuration is ready' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Adapter: Static site (Vite), no Wrangler configuration needed',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Builds with npm run build, then serves dist/ as a single-page app.',
      ),
    ).toBeVisible();
    expect(await axe(page)).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
