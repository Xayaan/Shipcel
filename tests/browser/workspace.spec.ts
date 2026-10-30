import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

test('create, validate, persist, search, export, and remove a project', async ({
  page,
  request,
}) => {
  const name = `qa-react-${Date.now()}`;
  let id = '';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/app/');
    await expect(
      page.getByRole('heading', { name: 'Overview', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page.getByLabel('Project name', { exact: true }).fill('Invalid Name');
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .last()
      .click();
    await expect(page.getByRole('alert')).toContainText('lowercase');
    await page.getByLabel('Project name', { exact: true }).fill(name);
    await page.getByLabel('SQL database').check();
    // R2 can bill beyond its free tier, so it needs Free-only turned off first.
    await expect(
      page.getByRole('checkbox', { name: /^Free-only/ }),
    ).toBeChecked();
    await expect(page.getByLabel('File storage')).toBeDisabled();
    await page.getByRole('checkbox', { name: /^Free-only/ }).uncheck();
    await page.getByLabel('File storage').check();
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .last()
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Paid features allowed', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Turn on Free-only' }).click();
    await expect(page.getByRole('alert')).toContainText('R2');
    const projects = await (await request.get('/api/projects')).json();
    id = projects.find((p: { name: string }) => p.name === name).id;
    await expect(
      page.getByRole('button', { name: 'Deployments', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Configuration', exact: true })
      .click();
    // Draft bindings: Wrangler creates the resources on the first deploy.
    await expect(page.locator('pre')).toContainText('"binding": "DB"');
    await expect(page.locator('pre')).not.toContainText('database_id');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export starter kit' }).click();
    const download = await downloadPromise;
    const zip = unzipSync(readFileSync((await download.path())!));
    expect(strFromU8(zip[`${name}/wrangler.json`])).toContain(
      '"binding": "FILES"',
    );
    expect(strFromU8(zip[`${name}/wrangler.json`])).not.toContain(
      'bucket_name',
    );
    expect(zip[`${name}/src/main.js`]).toBeTruthy();
    expect(strFromU8(zip[`${name}/README.md`])).toContain('not an import');
    const duplicate = await request.post('/api/projects', {
      data: { name, framework: 'react' },
    });
    expect(duplicate.status()).toBe(409);
    // A reload comes back to the open project (its tab is in the address);
    // the list is one click away.
    await page.reload();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'All projects' }).click();
    await page.getByRole('textbox', { name: 'Search projects' }).fill(name);
    await expect(
      page.getByRole('button', { name: new RegExp(name) }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Search projects' })
      .fill('a-name-that-does-not-exist');
    await expect(
      page.getByRole('heading', { name: 'No matching projects' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Remove project', exact: true })
      .click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(
      page.getByRole('button', { name: new RegExp(name) }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (id) await request.delete(`/api/projects/${id}`);
  }
});

test('WordPress starts from its experimental starter kit, on Workers Paid', async ({
  page,
  request,
}) => {
  const name = `qa-wordpress-${Date.now()}`;
  let id = '';
  try {
    await page.goto('/app/#templates');
    await page.getByRole('button', { name: /Starter kit WordPress/ }).click();
    await page.getByLabel('Project name', { exact: true }).fill(name);
    await expect(
      page
        .getByRole('dialog')
        .getByText('Experimental: WordPress', { exact: false }),
    ).toBeVisible();
    // Its container needs Workers Paid, so the project can't be Free-only.
    await expect(
      page.getByText('Containers need Cloudflare’s Workers Paid plan'),
    ).toBeVisible();
    await page.locator('.free-only-option input').uncheck();
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Export starter kit' }),
    ).toBeVisible();
    const projects = await (await request.get('/api/projects')).json();
    id = projects.find((p: { name: string }) => p.name === name).id;
    const kit = await request.post(`/api/projects/${id}/export`);
    expect(kit.status()).toBe(200);
    expect(kit.headers()['content-type']).toContain('zip');
  } finally {
    if (id) await request.delete(`/api/projects/${id}`);
  }
});

test('a Docker repository is imported from GitHub, on Workers Paid, without a starter kit', async ({
  page,
  request,
}) => {
  const name = `qa-docker-${Date.now()}`;
  let id = '';
  // Fixtures for the GitHub side; not live provider evidence.
  await page.route('**/api/connections', (route) =>
    route.fulfill({
      json: {
        github: { configured: true, connected: true, installUrl: null },
        cloudflare: { configured: true, connected: false, account: null },
        nativeBuildsEnabled: true,
      },
    }),
  );
  await page.route('**/api/connections/github/installations', (route) =>
    route.fulfill({
      json: { installations: [{ id: 1, account: { login: 'qa' } }], total: 1 },
    }),
  );
  await page.route('**/api/connections/github/repositories?*', (route) =>
    route.fulfill({
      json: {
        repositories: [
          {
            id: 1,
            fullName: `qa/${name}`,
            defaultBranch: 'main',
            private: false,
          },
        ],
        nextPage: null,
      },
    }),
  );
  await page.route('**/api/repositories/detect?*', (route) =>
    route.fulfill({
      json: { repository: `qa/${name}`, branch: 'main', framework: 'docker' },
    }),
  );
  await page.route('**/api/projects/*/repository', (route) =>
    route.fulfill({
      json: {
        repository: `qa/${name}`,
        branch: 'main',
        commit: 'b'.repeat(40),
        adapter: 'container',
        resources: [],
        containers: [],
        workerName: name,
        warnings: [],
        issues: [],
        ready: true,
      },
    }),
  );
  try {
    await page.goto('/app/#templates');
    // Every runtime has a starter kit, containers too; a repository imports as it is.
    for (const kit of ['Astro', 'SvelteKit', 'Next.js', 'Python', 'Docker'])
      await expect(
        page.getByRole('button', { name: new RegExp(`Starter kit ${kit}`) }),
      ).toBeVisible();
    await page.getByRole('button', { name: /Starter kit Docker/ }).click();
    await page.getByRole('radio', { name: /^GitHub repository/ }).check();
    await page
      .getByRole('combobox', { name: 'Repository', exact: true })
      .selectOption(`qa/${name}`);
    await expect(
      page.getByRole('status', { name: 'Framework or runtime' }),
    ).toContainText(`Docker / custom runtime, detected from qa/${name}`);
    // Containers need Workers Paid, so this project can't be Free-only.
    await expect(
      page.getByText('Containers need Cloudflare’s Workers Paid plan'),
    ).toBeVisible();
    await page.locator('.free-only-option input').uncheck();
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    // Its badge is its state until the first deploy runs.
    await expect(
      page.getByText('Not deployed', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Export starter kit' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'GitHub deployments' }),
    ).toBeVisible();
    const projects = await (await request.get('/api/projects')).json();
    id = projects.find((p: { name: string }) => p.name === name).id;
    expect((await request.post(`/api/projects/${id}/export`)).status()).toBe(
      409,
    );
  } finally {
    if (id) await request.delete(`/api/projects/${id}`);
  }
});

test('three responsive breakpoints, navigation, and automated accessibility', async ({
  page,
}) => {
  mkdirSync('docs/screenshots', { recursive: true });
  const findings = [];
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 900 : 1100 });
    await page.goto('/app/#overview');
    await expect(
      page.getByRole('heading', { name: 'Overview', exact: true }),
    ).toBeVisible();
    if (width === 375) {
      await expect(page.locator('.sidebar')).toBeHidden();
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.locator('.sidebar')).toBeVisible();
      await page.getByRole('button', { name: 'Close navigation' }).click();
      await expect(page.locator('.sidebar')).toBeHidden();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `docs/screenshots/overview-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    findings.push({
      width,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          html: n.html,
          summary: n.failureSummary,
        })),
      })),
    });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const name of [
    'Projects',
    'App catalog',
    'Activity',
    'Connections',
    'Plan & usage',
    'Getting started',
  ]) {
    await page
      .getByRole('button', {
        name,
        exact: name !== 'Projects' && name !== 'App catalog',
      })
      .first()
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    findings.push({
      page: name,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          html: n.html,
          summary: n.failureSummary,
        })),
      })),
    });
  }
  writeFileSync(
    'docs/accessibility-results.json',
    JSON.stringify(findings, null, 2),
  );
  expect(findings.flatMap((f) => f.violations)).toEqual([]);
});

test('Free-only projects can allow paid features only after confirmation', async ({
  page,
  request,
}) => {
  const name = `qa-free-${Date.now()}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let id = '';
  try {
    await page.goto('/app/');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page.getByLabel('Project name', { exact: true }).fill(name);
    await expect(
      page.getByRole('checkbox', { name: /^Free-only/ }),
    ).toBeChecked();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
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
    const billing = page.getByRole('heading', { name: 'Billing' });
    await expect(billing).toBeVisible();
    await page.getByRole('button', { name: 'Allow paid features' }).click();
    await expect(
      page.getByText('Cloudflare may bill your account'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByText('Free-only', { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Allow paid features' }).click();
    await page.getByRole('button', { name: 'Turn off Free-only' }).click();
    await expect(page.getByRole('status')).toContainText('Free-only is off');
    await expect(
      page.getByText('Paid features allowed', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Turn on Free-only' }).click();
    await expect(page.getByRole('status')).toContainText('Free-only is on');
    const project = (
      (await (await request.get('/api/projects')).json()) as {
        id: string;
        freeOnly: boolean;
      }[]
    ).find((p) => p.id === id)!;
    expect(project.freeOnly).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    if (id) await request.delete(`/api/projects/${id}`);
  }
});
