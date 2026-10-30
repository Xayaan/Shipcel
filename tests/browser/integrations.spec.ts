import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Browser fixtures validate UI contracts only; they are not live provider evidence.
test('repository import, explicit launch consent, and deployment status UI', async ({
  page,
  request,
}) => {
  const name = `qa-native-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const accountId = 'a'.repeat(32),
    tokenId = '10000000-0000-4000-8000-000000000001';
  const baseJob = {
    id: 'fixture-job',
    project_id: project.id,
    repository_name: 'test-owner/worker',
    branch: 'main',
    worker_name: 'test-worker',
    status: 'queued',
    step: 'queued',
    error: null,
    account_id: accountId,
    trigger_uuid: null,
    build_uuid: null,
    live_url: null,
    created_at: 0,
    updated_at: 0,
  };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.route('**/api/connections', (route) =>
      route.fulfill({
        json: {
          github: {
            configured: true,
            connected: true,
            installUrl: 'https://github.com/apps/test/installations/new',
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
    await page.route('**/api/connections/github/installations', (route) =>
      route.fulfill({
        json: {
          installations: [{ id: 1, account: { login: 'test-owner' } }],
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
              fullName: 'test-owner/worker',
              defaultBranch: 'main',
              private: true,
            },
          ],
          nextPage: null,
        },
      }),
    );
    await page.route(`**/api/projects/${project.id}/repository`, (route) =>
      route.fulfill({
        json: {
          repository: 'test-owner/worker',
          branch: 'main',
          commit: 'b'.repeat(40),
          adapter: 'configured-worker',
          resources: [
            { type: 'd1', binding: 'DB' },
            { type: 'r2', binding: 'FILES' },
          ],
          warnings: [
            'Wrangler creates and binds these resources during deployment using your build token.',
          ],
          issues: [],
          ready: true,
        },
      }),
    );
    await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
      route.fulfill({ json: [{ id: tokenId, name: 'Test build token' }] }),
    );
    await page.route('**/api/connections/cloudflare/subdomain', (route) =>
      route.fulfill({ json: { subdomain: 'test-account' } }),
    );
    let submissions = 0;
    await page.route(
      `**/api/projects/${project.id}/deployments`,
      async (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({ json: [] });
        const body = route.request().postDataJSON();
        expect(body.confirmCharges).toBe(true);
        expect(body.buildTokenId).toBe(tokenId);
        expect(body.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
        expect(body.inspectedCommit).toBe('b'.repeat(40));
        expect(body.confirmResources).toBe(true);
        expect(body.workerName).toBe('my-app');
        submissions++;
        await route.fulfill({ status: 202, json: baseJob });
      },
    );
    await page.route('**/api/deployments/fixture-job/refresh', (route) =>
      route.fulfill({
        json: {
          ...baseJob,
          status: 'deployed',
          step: 'finished',
          live_url: 'https://test-worker.test-account.workers.dev/',
          trigger_uuid: 'fixture-trigger',
          resources: [
            { type: 'd1', binding: 'DB' },
            { type: 'r2', binding: 'FILES' },
          ],
          observedResources: [
            {
              type: 'd1',
              binding: 'DB',
              id: '50000000-0000-4000-8000-000000000005',
            },
            { type: 'r2', binding: 'FILES', id: 'test-worker-files' },
          ],
        },
      }),
    );
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    const deploy = page.getByRole('button', {
      name: 'Deploy repository',
      exact: true,
    });
    await expect(deploy).toBeDisabled();
    // Repositories and build tokens load by themselves; choosing a repository inspects it.
    await expect(
      page.getByRole('combobox', { name: 'GitHub account' }),
    ).toHaveValue('1');
    await page
      .getByRole('combobox', { name: 'Repository', exact: true })
      .selectOption('test-owner/worker');
    await expect(
      page.getByRole('heading', { name: 'Repository configuration is ready' }),
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Build token', exact: true }),
    ).toHaveValue(tokenId);
    await expect(deploy).toBeDisabled();
    await expect(
      page.getByText('D1 database, DB', { exact: true }),
    ).toBeVisible();
    await page.getByRole('checkbox', { name: /Create a new Worker/ }).check();
    // Charge consent alone is not enough while resources are listed.
    await expect(deploy).toBeDisabled();
    await page
      .getByRole('checkbox', { name: /Create the listed resources/ })
      .check();
    await expect(deploy).toBeEnabled();
    // The free address defaults to the project name and follows the chosen app name.
    const appName = page.getByRole('textbox', { name: 'App name' });
    await expect(appName).toHaveValue(name);
    await appName.fill('My App');
    await expect(deploy).toBeDisabled();
    await appName.fill('my-app');
    await expect(
      page.getByText('https://my-app.test-account.workers.dev', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(deploy).toBeEnabled();
    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);
    await page.screenshot({
      path: 'docs/screenshots/deployment-review-1440.png',
      fullPage: true,
      animations: 'disabled',
    });
    await deploy.click();
    await expect(
      page.getByText('queued', { exact: true }).first(),
    ).toBeVisible();
    expect(submissions).toBe(1);
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(
      page.getByRole('link', { name: 'Open deployed app' }),
    ).toHaveAttribute('href', 'https://test-worker.test-account.workers.dev/');
    await expect(
      page.getByRole('list', { name: 'Deployment resources' }),
    ).toContainText('D1 database, DB, 50000000-0000-4000-8000-000000000005');
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('container repositories list their containers and need billing consent before deploying', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-container-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, framework: 'docker', freeOnly: false },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const accountId = 'a'.repeat(32),
    tokenId = '10000000-0000-4000-8000-000000000001';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.route('**/api/connections', (route) =>
      route.fulfill({
        json: {
          github: {
            configured: true,
            connected: true,
            installUrl: 'https://github.com/apps/test/installations/new',
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
    await page.route('**/api/connections/github/installations', (route) =>
      route.fulfill({
        json: {
          installations: [{ id: 1, account: { login: 'test-owner' } }],
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
              fullName: 'test-owner/boxes',
              defaultBranch: 'main',
              private: true,
            },
          ],
          nextPage: null,
        },
      }),
    );
    await page.route(`**/api/projects/${project.id}/repository`, (route) =>
      route.fulfill({
        json: {
          repository: 'test-owner/boxes',
          branch: 'main',
          commit: 'b'.repeat(40),
          adapter: 'container',
          buildCommand: '',
          workerName: 'boxes',
          resources: [],
          containers: [
            {
              className: 'Site',
              policy: 'default',
              images: ['./Dockerfile'],
              instanceType: 'basic',
              maxInstances: 3,
            },
            {
              className: 'Jobs',
              policy: 'durable_object',
              images: ['./jobs/Dockerfile'],
              instanceType: null,
              maxInstances: null,
            },
          ],
          warnings: [
            'Containers need the Workers Paid plan. Cloudflare bills container vCPU, memory, disk and egress beyond the included amounts to your account; max_instances limits how many instances run at once.',
          ],
          issues: [],
          ready: true,
        },
      }),
    );
    await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
      route.fulfill({ json: [{ id: tokenId, name: 'Test build token' }] }),
    );
    await page.route('**/api/connections/cloudflare/subdomain', (route) =>
      route.fulfill({ json: { subdomain: 'test-account' } }),
    );
    let submitted: Record<string, unknown> | null = null;
    await page.route(
      `**/api/projects/${project.id}/deployments`,
      async (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({ json: [] });
        submitted = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          json: {
            id: 'container-job',
            project_id: project.id,
            repository_name: 'test-owner/boxes',
            branch: 'main',
            adapter: 'container',
            worker_name: 'boxes',
            status: 'queued',
            step: 'queued',
            error: null,
            account_id: accountId,
            trigger_uuid: null,
            build_uuid: null,
            live_url: null,
            resources: [],
            observedResources: [],
            environment: 'production',
            created_at: 0,
            updated_at: 0,
          },
        });
      },
    );
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    await page
      .getByRole('combobox', { name: 'Repository', exact: true })
      .selectOption('test-owner/boxes');
    const containers = page.getByRole('list', { name: 'Containers to deploy' });
    await expect(containers).toContainText(
      'Site, ./Dockerfile, basic instances, up to 3 at once',
    );
    await expect(containers).toContainText(
      'Jobs, ./jobs/Dockerfile, started by its Durable Object (beta)',
    );
    await expect(page.getByText(/Container Worker/).first()).toBeVisible();
    // Containers keep the configured name, so the address is fixed.
    await expect(page.getByRole('textbox', { name: 'App name' })).toHaveCount(
      0,
    );
    await expect(
      page.getByText('https://boxes.test-account.workers.dev', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Build token', exact: true }),
    ).toHaveValue(tokenId);
    const deploy = page.getByRole('button', {
      name: 'Deploy repository',
      exact: true,
    });
    await page.getByRole('checkbox', { name: /Create a new Worker/ }).check();
    // Charge consent alone is not enough while containers are listed.
    await expect(deploy).toBeDisabled();
    await page
      .getByRole('checkbox', { name: /Deploy these containers as boxes/ })
      .check();
    await expect(deploy).toBeEnabled();
    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);
    await deploy.click();
    await expect(
      page.getByText('queued', { exact: true }).first(),
    ).toBeVisible();
    expect(submitted).toMatchObject({
      confirmCharges: true,
      confirmContainers: true,
      inspectedCommit: 'b'.repeat(40),
    });
    expect(submitted!.workerName).toBeUndefined();
    await page.route('**/api/deployments/container-job/refresh', (route) =>
      route.fulfill({
        json: {
          id: 'container-job',
          project_id: project.id,
          repository_name: 'test-owner/boxes',
          branch: 'main',
          adapter: 'container',
          worker_name: 'boxes',
          status: 'building',
          step: 'health_check',
          error: null,
          account_id: accountId,
          trigger_uuid: 'fixture-trigger',
          build_uuid: 'fixture-build',
          live_url: null,
          resources: [],
          observedResources: [],
          environment: 'production',
          created_at: 0,
          updated_at: 0,
        },
      }),
    );
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(
      page.getByText(/Cloudflare is starting the container/),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('an account without a workers.dev subdomain claims one before its first deploy', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-subdomain-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let claimed: Record<string, unknown> | null = null;
  try {
    await page.route('**/api/connections', (route) =>
      route.fulfill({
        json: {
          github: { configured: true, connected: true, installUrl: '' },
          cloudflare: {
            configured: true,
            connected: true,
            account: { id: 'a'.repeat(32), name: 'Test account' },
          },
          nativeBuildsEnabled: true,
        },
      }),
    );
    await page.route('**/api/connections/cloudflare/subdomain', (route) => {
      if (route.request().method() === 'POST') {
        claimed = route.request().postDataJSON();
        return route.fulfill({ json: { subdomain: 'alice' } });
      }
      return route.fulfill({ json: { subdomain: null } });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    await expect(
      page.getByText(/This Cloudflare account has no workers.dev subdomain/),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'workers.dev subdomain' })
      .fill('alice');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole('button', { name: 'Claim alice.workers.dev' }).click();
    await expect(
      page.getByRole('heading', { name: 'Claim alice.workers.dev?' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByText(`https://${name}.alice.workers.dev`, { exact: true }),
    ).toBeVisible();
    expect(claimed).toEqual({ subdomain: 'alice', confirm: true });
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('a deployment that needs attention can be checked and resumed after confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-recover-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await created.json();
  const stuck = {
    id: 'stuck-job',
    project_id: project.id,
    repository_name: 'test-owner/worker',
    branch: 'main',
    worker_name: 'test-worker',
    status: 'needs_attention',
    step: 'intent_create_trigger',
    error:
      'A provider request was interrupted before Shipcel recorded its result. Use Check Cloudflare and resume; Shipcel adopts what was created and will not create duplicates.',
    account_id: 'a'.repeat(32),
    trigger_uuid: null,
    build_uuid: null,
    live_url: null,
    recovery_note: null,
    created_at: 0,
    updated_at: 0,
  };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.route(`**/api/projects/${project.id}/deployments`, (route) =>
      route.fulfill({ json: [stuck] }),
    );
    let bodies: unknown[] = [];
    await page.route('**/api/deployments/stuck-job/reconcile', (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          ...stuck,
          status: 'provisioning',
          step: 'start_build',
          error: null,
          trigger_uuid: 'fixture-trigger',
          recovery_note:
            'Found the build trigger created before the interruption and continued with it.',
        },
      });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    const resume = page.getByRole('button', {
      name: 'Check Cloudflare and resume',
    });
    await resume.click();
    const dialog = page.getByRole('dialog', {
      name: 'Resume this deployment?',
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(bodies).toEqual([]);
    await resume.click();
    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);
    await page.screenshot({
      path: 'docs/screenshots/deployment-recovery-1440.png',
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByText(
        'Found the build trigger created before the interruption',
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    await expect(page.getByText('provisioning', { exact: true })).toBeVisible();
    expect(bodies).toEqual([{ confirm: true }]);
    await expect(resume).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('local connections before setup, and the plan screen, are truthful at mobile and desktop widths', async ({
  page,
}) => {
  // Connections as a local Shipcel shows them before GitHub and Cloudflare are set up,
  // whatever this computer's own setup is.
  const notSetUp = {
    configured: false,
    source: null,
    name: null,
    url: null,
    accountId: null,
    scopes: [],
  };
  await page.route('**/api/connections', (route) =>
    route.fulfill({
      json: {
        github: { configured: false, connected: false, installUrl: null },
        cloudflare: { configured: false, connected: false, account: null },
        nativeBuildsEnabled: false,
      },
    }),
  );
  await page.route('**/api/setup', (route) =>
    route.fulfill({
      json: {
        available: true,
        encryption: true,
        origin: 'http://127.0.0.1:5173',
        github: {
          ...notSetUp,
          callbackUrl: 'http://127.0.0.1:5173/api/auth/github/callback',
        },
        cloudflare: {
          ...notSetUp,
          redirectUrl: 'http://127.0.0.1:5173/api/auth/cloudflare/callback',
        },
      },
    }),
  );
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const screen of ['connections', 'plan']) {
      await page.goto(`/app/#${screen}`);
      if (screen === 'connections') {
        await expect(
          page.getByRole('heading', { name: 'Connections', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('Set up GitHub sign-in')).toBeVisible();
        await expect(page.getByText('Set up Cloudflare sign-in')).toBeVisible();
      } else {
        await expect(
          page.getByRole('heading', { name: 'Free', exact: true }),
        ).toBeVisible();
        // The Free plan matches Cloudflare's Workers Free plan instead of capping below it.
        await expect(
          page.getByText('Up to 100 projects', { exact: false }),
        ).toBeVisible();
        await expect(
          page.getByText('No monthly limit on deployments', { exact: false }),
        ).toBeVisible();
        await expect(
          page.getByRole('link', {
            name: 'Everything Cloudflare’s free plan includes',
          }),
        ).toHaveAttribute('href', '/pricing/');
      }
      await page.screenshot({
        path: `docs/screenshots/${screen}-${width}.png`,
        fullPage: true,
        animations: 'disabled',
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const a11y = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(a11y.violations).toEqual([]);
    }
  }
});

test('hosted sign-in renders without exposing a workspace', async ({
  page,
}) => {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: { user: null, githubConfigured: true, local: false },
    }),
  );
  await page.goto('/app/');
  await expect(
    page.getByRole('link', { name: 'Continue with GitHub' }),
  ).toHaveAttribute('href', '/api/auth/github/start');
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(
    0,
  );
  // Visitors can read what is free and how Shipcel compares before signing in.
  await expect(
    page.getByRole('link', { name: 'What’s free', exact: true }),
  ).toHaveAttribute('href', '/pricing/');
  await expect(
    page.getByRole('link', { name: 'Why Shipcel', exact: true }),
  ).toHaveAttribute('href', '/why/');
});

test('branch previews: staging copies with consent, the previews block, listing, deleting and turning off', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-previews-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, framework: 'worker' },
  });
  const project = await created.json();
  const production = {
    id: 'prod-job',
    project_id: project.id,
    repository_name: 'test-owner/worker',
    branch: 'main',
    account_id: 'a'.repeat(32),
    error: null,
    recovery_note: null,
    trigger_uuid: 'trigger',
    build_uuid: 'build',
    created_at: 0,
    updated_at: 0,
    environment: 'production',
    adapter: 'configured-worker',
    worker_name: 'cc-app-0123456789ab',
    status: 'deployed',
    step: 'finished',
    live_url: 'https://cc-app-0123456789ab.test-account.workers.dev/',
  };
  const staging = [
    {
      type: 'd1',
      binding: 'DB',
      name: 'cc-app-0123456789ab-pv-a1b2c3d4-db',
      id: '60000000-0000-4000-8000-000000000001',
    },
  ];
  const snippet =
    '"preview_urls": true,\n"previews": {\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "cc-app-0123456789ab-pv-a1b2c3d4-db",\n      "database_id": "60000000-0000-4000-8000-000000000001"\n    }\n  ]\n}';
  let status = 'off';
  let previews = [
    {
      id: 'preview-1',
      name: 'feature/login',
      urls: [
        'https://feature-login-cc-app-0123456789ab.test-account.workers.dev',
      ],
      deployedOn: '2026-10-08T10:00:00Z',
      latest: {
        id: 'deployment-1',
        number: 2,
        urls: [],
        createdOn: '2026-10-08T10:00:00Z',
        commit: 'd'.repeat(40),
        pullRequest: 'https://github.com/test-owner/worker/pull/7',
      },
    },
  ];
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.route(`**/api/projects/${project.id}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        `/api/projects/${project.id}`,
        '',
      );
      const method = route.request().method();
      if (path === '/deployments') return route.fulfill({ json: [production] });
      if (path === '/previews/plan')
        return route.fulfill({
          json: {
            commit: 'b'.repeat(40),
            branch: 'main',
            resources: [
              {
                type: 'd1',
                binding: 'DB',
                name: 'cc-app-0123456789ab-pv-…-db',
              },
            ],
            warnings: ['Only trusted collaborators should push branches.'],
            issues: [],
            ready: true,
          },
        });
      if (method !== 'GET')
        writes.push(
          `${method} ${path} ${JSON.stringify({ ...route.request().postDataJSON(), requestId: undefined })}`,
        );
      if (path === '/previews' && method === 'POST') {
        status = status === 'off' ? 'waiting_for_config' : 'active';
        return route.fulfill({
          json: {
            id: 'operation',
            status: 'succeeded',
            result:
              status === 'active'
                ? { status }
                : {
                    status,
                    issues: [
                      'Add a previews block to the Wrangler configuration on the production branch: Cloudflare fails every preview build without one.',
                    ],
                    snippet,
                  },
          },
        });
      }
      if (path === '/previews/preview-1' && method === 'DELETE') {
        previews = [];
        return route.fulfill({ json: { status: 'succeeded' } });
      }
      if (path === '/previews' && method === 'DELETE') {
        status = 'disabled';
        return route.fulfill({ json: { status: 'succeeded' } });
      }
      if (path === '/previews')
        return route.fulfill({
          json:
            status === 'off'
              ? { status }
              : {
                  status,
                  error: null,
                  branch: 'main',
                  resources: staging,
                  snippet,
                  ...(status === 'waiting_for_config'
                    ? {}
                    : {
                        previews,
                        previewsError: null,
                        builds: [
                          {
                            id: 'build-1',
                            branch: 'feature/login',
                            outcome: 'success',
                            status: 'stopped',
                            createdAt: null,
                          },
                        ],
                      }),
                },
        });
      return route.continue();
    });
    await page.route('**/api/connections', (route) =>
      route.fulfill({
        json: {
          github: { configured: true, connected: true, installUrl: null },
          cloudflare: {
            configured: true,
            connected: true,
            account: { id: 'a'.repeat(32), name: 'Test account' },
          },
          nativeBuildsEnabled: true,
        },
      }),
    );
    const axe = async () =>
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations;
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Branch previews' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Review preview setup' }).click();
    await expect(page.getByText('Staging copies to create')).toBeVisible();
    await expect(page.getByText('cc-app-0123456789ab-pv-…-db')).toBeVisible();
    const turnOn = page.getByRole('button', { name: 'Turn on previews' });
    await expect(turnOn).toBeDisabled();
    await page
      .getByRole('checkbox', { name: /Create these staging copies/ })
      .check();
    expect(await axe()).toEqual([]);
    await turnOn.click();
    // The repository needs the previews block first.
    await expect(page.getByText('One step left.')).toBeVisible();
    await expect(page.getByText('Add a previews block')).toBeVisible();
    await expect(
      page.getByText('"database_id": "60000000-0000-4000-8000-000000000001"'),
    ).toBeVisible();
    expect(await axe()).toEqual([]);
    await page.getByRole('button', { name: 'Check again and turn on' }).click();
    await expect(page.getByText('Previews are on.')).toBeVisible();
    expect(writes).toEqual([
      'POST /previews {"confirm":true,"confirmResources":true}',
      'POST /previews {"confirm":true,"confirmResources":false}',
    ]);
    await expect(
      page.getByRole('link', {
        name: /https:\/\/feature-login-cc-app-0123456789ab\.test-account\.workers\.dev/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Pull request' }),
    ).toHaveAttribute('href', 'https://github.com/test-owner/worker/pull/7');
    await expect(page.getByText(/commit ddddddd/)).toBeVisible();
    expect(await axe()).toEqual([]);
    await page
      .getByRole('button', { name: 'Delete preview feature/login' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Its addresses stop working');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('No previews yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Turn off previews' }).click();
    await expect(dialog).toContainText('Production is not affected');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('Previews are off')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Turn previews back on' }),
    ).toBeVisible();
    expect(writes.slice(2)).toEqual([
      'DELETE /previews/preview-1 {"confirm":true}',
      'DELETE /previews {"confirm":true}',
    ]);
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
