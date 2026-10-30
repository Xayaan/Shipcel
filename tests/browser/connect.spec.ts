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
// Cloudflare links its GitHub app to the account through its own dashboard; repository access
// is changed on GitHub.
const connect = `https://dash.cloudflare.com/${accountId}/workers-and-pages/create`,
  repositories = 'https://github.com/settings/installations';

// A workspace owner signed in with GitHub, with GitHub and Cloudflare connected. `githubActions`:
// a Shipcel GitHub's runners can reach, which deploys pushes with GitHub Actions.
async function signedIn(
  page: Page,
  account: { id: string; name: string } | null = {
    id: accountId,
    name: 'Alice’s Account',
  },
  githubActions = false,
) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: {
          login: 'alice',
          workspaceId: 'personal-1',
          role: 'owner',
          local: false,
          workspaces: [],
        },
        githubConfigured: true,
        local: false,
      },
    }),
  );
  let chosen = account;
  await page.route('**/api/connections', (route) =>
    route.fulfill({
      json: {
        github: {
          configured: true,
          connected: true,
          installUrl: 'https://github.com/apps/shipcel-test/installations/new',
        },
        cloudflare: { configured: true, connected: true, account: chosen },
        nativeBuildsEnabled: true,
        githubActions,
      },
    }),
  );
  return {
    choose(next: { id: string; name: string }) {
      chosen = next;
    },
  };
}

test('connecting GitHub and Cloudflare walks through everything Cloudflare’s builds need, once', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signedIn(page);
  let readable = false,
    checks = 0;
  await page.route('**/api/connections/cloudflare/github', (route) => {
    checks++;
    return route.fulfill({
      json: {
        connectUrl: connect,
        accounts: [
          {
            login: 'alice',
            repository: 'alice/landing',
            readable,
            checked: [{ repository: 'alice/landing', readable }],
            repositoriesUrl: repositories,
          },
        ],
      },
    });
  });
  let tokens: { id: string; name: string }[] = [];
  const sent: unknown[] = [];
  await page.route('**/api/connections/cloudflare/build-tokens', (route) => {
    if (route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON());
      tokens = [{ id: tokenId, name: 'Shipcel builds' }];
      return route.fulfill({ json: tokens[0] });
    }
    return route.fulfill({ json: tokens });
  });
  await page.goto('/app/#connections');
  const summary = page.getByRole('region', { name: 'Deploying from GitHub' });
  await expect(summary).toContainText('2 steps left');
  // GitHub: Cloudflare's own GitHub app, connected through Cloudflare's dashboard.
  const app = page.getByRole('group', { name: 'Cloudflare’s GitHub app' });
  await expect(
    app.getByRole('link', { name: 'Connect GitHub in Cloudflare' }),
  ).toHaveAttribute('href', connect);
  await expect(app).toContainText('choose GitHub');
  await expect(
    app.getByRole('link', { name: 'Repository access on GitHub' }),
  ).toHaveAttribute('href', repositories);
  // It says which repository it asked Cloudflare about.
  await expect(app).toContainText('alice/landing: not yet');
  // Coming back from Cloudflare checks again by itself.
  readable = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(app).toContainText('Cloudflare can read alice’s repositories');
  expect(checks).toBeGreaterThanOrEqual(2);
  await expect(summary).toContainText('1 step left');
  // Cloudflare: the build token, made once from a pre-filled Cloudflare page.
  const token = page.getByRole('group', { name: 'Build token' });
  const create = token.getByRole('link', {
    name: 'Create the token in Cloudflare',
  });
  const href = new URL((await create.getAttribute('href'))!);
  expect(href.origin + href.pathname).toBe(
    'https://dash.cloudflare.com/profile/api-tokens',
  );
  expect(JSON.parse(href.searchParams.get('permissionGroupKeys')!)).toEqual(
    expect.arrayContaining([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'workers_kv_storage', type: 'edit' },
      { key: 'workers_r2', type: 'edit' },
      { key: 'd1', type: 'edit' },
      { key: 'workers_routes', type: 'edit' },
      { key: 'account_settings', type: 'read' },
    ]),
  );
  expect(href.searchParams.get('name')).toBe('Shipcel builds');
  expect(await axe(page)).toEqual([]);
  const field = token.getByLabel('API token');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(' user-api-token-0123456789abcdef ');
  await token.getByRole('button', { name: 'Add build token' }).click();
  await expect(token).toContainText('Shipcel builds');
  await expect(field).toHaveCount(0);
  expect(sent).toEqual([{ token: 'user-api-token-0123456789abcdef' }]);
  await expect(summary).toContainText('Ready');
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
});

test('a refused build token is explained where it was pasted', async ({
  page,
}) => {
  await signedIn(page);
  await page.route('**/api/connections/cloudflare/github', (route) =>
    route.fulfill({ json: { connectUrl: connect, accounts: [] } }),
  );
  await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          json: { error: 'Cloudflare didn’t accept this token.' },
        })
      : route.fulfill({ json: [] }),
  );
  await page.goto('/app/#connections');
  const token = page.getByRole('group', { name: 'Build token' });
  const add = token.getByRole('button', { name: 'Add build token' });
  await expect(add).toBeDisabled();
  await token.getByLabel('API token').fill('account-token-0123456789abcdef');
  await add.click();
  await expect(token.getByRole('alert')).toHaveText(
    'Cloudflare didn’t accept this token.',
  );
});

test('Cloudflare accounts are listed without asking when there are several', async ({
  page,
}) => {
  const owner = await signedIn(page, null);
  await page.route('**/api/connections/cloudflare/github', (route) =>
    route.fulfill({ json: { connectUrl: connect, accounts: [] } }),
  );
  await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/connections/cloudflare/accounts?*', (route) =>
    route.fulfill({
      json: {
        accounts: [
          { id: accountId, name: 'Alice’s Account' },
          { id: 'b'.repeat(32), name: 'Studio' },
        ],
        nextPage: null,
      },
    }),
  );
  let picked: unknown = null;
  const names: Record<string, string> = {
    [accountId]: 'Alice’s Account',
    ['b'.repeat(32)]: 'Studio',
  };
  await page.route('**/api/connections/cloudflare/account', (route) => {
    picked = route.request().postDataJSON();
    const id = (picked as { accountId: string }).accountId;
    owner.choose({ id, name: names[id] });
    return route.fulfill({ json: { account: { id, name: names[id] } } });
  });
  await page.goto('/app/#connections');
  const accounts = page.getByLabel('Deployment account');
  await expect(accounts).toBeVisible();
  await accounts.selectOption('b'.repeat(32));
  await page.getByRole('button', { name: 'Use this account' }).click();
  await expect(page.getByText('Deploying to Studio')).toBeVisible();
  expect(picked).toEqual({ accountId: 'b'.repeat(32) });
  // Changing it lists the accounts again.
  await page.getByRole('button', { name: 'Change account' }).click();
  await accounts.selectOption(accountId);
  await page.getByRole('button', { name: 'Use this account' }).click();
  await expect(page.getByText('Deploying to Alice’s Account')).toBeVisible();
  expect(picked).toEqual({ accountId });
});

test('Deployments never asks for setup: it points to Connections', async ({
  page,
  request,
}) => {
  const name = `qa-ready-${Date.now()}`;
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
  await signedIn(page);
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
        warnings: [],
        issues: [],
        ready: true,
      },
    }),
  );
  const probes: string[] = [];
  await page.route('**/api/connections/cloudflare/github?*', (route) => {
    probes.push(new URL(route.request().url()).searchParams.get('repository')!);
    return route.fulfill({
      json: {
        connectUrl: connect,
        accounts: [
          {
            login: 'alice',
            repository: 'alice/landing',
            readable: false,
            repositoriesUrl: repositories,
          },
        ],
      },
    });
  });
  await page.route('**/api/connections/cloudflare/build-tokens', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/connections/cloudflare/subdomain', (route) =>
    route.fulfill({ json: { subdomain: 'alice' } }),
  );
  try {
    await page.goto(`/app/#projects/${project.id}/deployments`);
    await expect(
      page.getByRole('link', { name: 'Connections', exact: true }),
    ).toHaveAttribute('href', '#connections');
    await expect(page.getByLabel('API token')).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Connect GitHub in Cloudflare' }),
    ).toHaveAttribute('href', connect);
    await expect(
      page.getByRole('link', { name: 'Repository access on GitHub' }),
    ).toHaveAttribute('href', repositories);
    // StrictMode runs effects twice in development: only which repository counts.
    expect([...new Set(probes)]).toEqual(['alice/landing']);
    // GitHub's runners can't reach a Shipcel on this computer: no GitHub Actions offered.
    await expect(
      page.getByRole('region', { name: 'Deploy from GitHub' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Deploy repository' }),
    ).toBeDisabled();
    expect(await axe(page)).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('with GitHub Actions, Connections asks for GitHub and Cloudflare only, and checks Cloudflare’s own builds once opened', async ({
  page,
}) => {
  await signedIn(page, undefined, true);
  const checked: string[] = [];
  await page.route('**/api/connections/cloudflare/github', (route) => {
    checked.push('app');
    return route.fulfill({ json: { connectUrl: connect, accounts: [] } });
  });
  await page.route('**/api/connections/cloudflare/build-tokens', (route) => {
    checked.push('tokens');
    return route.fulfill({ json: [] });
  });
  await page.goto('/app/#connections');
  const summary = page.getByRole('region', { name: 'Deploying from GitHub' });
  await expect(summary).toContainText('Ready');
  await expect(summary).toContainText(
    'Connect a project’s repository on its Deployments tab: Shipcel adds a GitHub Actions workflow, and every push deploys.',
  );
  const app = page.getByRole('group', { name: 'Cloudflare’s GitHub app' });
  await expect(app).toBeHidden();
  expect(checked).toEqual([]);
  expect(await axe(page)).toEqual([]);
  await page.getByText('Cloudflare’s own builds (optional)').click();
  await expect(app).toBeVisible();
  await expect(page.getByRole('group', { name: 'Build token' })).toBeVisible();
  await expect.poll(() => new Set(checked).size).toBe(2);
  expect(await axe(page)).toEqual([]);
});

test('connecting a repository adds the workflow, says how pushes deploy, and disconnects', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = await (
    await request.post('/api/projects', {
      data: {
        name: `qa-actions-${Date.now()}`,
        framework: 'react',
        source: 'github',
        repository: 'https://github.com/alice/landing',
      },
    })
  ).json();
  await signedIn(page, undefined, true);
  const shown = {
    repository: 'alice/landing',
    branch: 'main',
    linkedBy: 'alice',
    actionsUrl: 'https://github.com/alice/landing/actions',
    workflowUrl:
      'https://github.com/alice/landing/blob/main/.github/workflows/shipcel.yml',
  };
  let link: typeof shown | null = null;
  let answer: Record<string, string> = {
    workflow: 'added',
    commitUrl: `https://github.com/alice/landing/commit/${'c'.repeat(40)}`,
  };
  const sent: unknown[] = [];
  await page.route(`**/api/projects/${project.id}/github-actions`, (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      sent.push(route.request().postDataJSON());
      link = shown;
      return route.fulfill({ status: 201, json: { ...shown, ...answer } });
    }
    if (method === 'DELETE') {
      link = null;
      return route.fulfill({ json: { removed: true, ...shown } });
    }
    return route.fulfill({
      json: {
        link,
        workflow: "name: Shipcel\non:\n  push:\n    branches: ['**']\n",
      },
    });
  });
  // Cloudflare's own builds ask for nothing until they are opened.
  const builds: string[] = [];
  await page.route(`**/api/projects/${project.id}/repository`, (route) => {
    builds.push('inspect');
    return route.fulfill({ status: 409, json: { error: 'Not asked for.' } });
  });
  await page.route('**/api/connections/cloudflare/build-tokens', (route) => {
    builds.push('tokens');
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/connections/cloudflare/subdomain', (route) =>
    route.fulfill({ json: { subdomain: 'alice' } }),
  );
  try {
    await page.goto(`/app/#projects/${project.id}/deployments`);
    const section = page.getByRole('region', { name: 'Deploy from GitHub' });
    await expect(section.locator('.chosen-repository')).toContainText(
      'alice/landing',
    );
    await expect(
      section.getByText('What Shipcel adds: .github/workflows/shipcel.yml'),
    ).toBeVisible();
    const connectRepository = section.getByRole('button', {
      name: 'Connect repository',
    });
    await expect(connectRepository).toBeDisabled();
    await section
      .getByRole('checkbox', { name: /Add the workflow to alice\/landing/ })
      .check();
    expect(await axe(page)).toEqual([]);
    await connectRepository.click();
    await expect(section).toContainText(
      'Every push to alice/landing builds on GitHub and deploys here: main to production, other branches as previews.',
    );
    await expect(section).toContainText(
      'Shipcel added the workflow to main, so GitHub is deploying it now.',
    );
    expect(sent).toEqual([{ repository: 'alice/landing', confirm: true }]);
    await expect(
      section.getByRole('link', { name: 'Runs on GitHub' }),
    ).toHaveAttribute('href', shown.actionsUrl);
    await expect(
      section.getByRole('link', { name: 'The workflow' }),
    ).toHaveAttribute('href', shown.workflowUrl);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await axe(page)).toEqual([]);
    }
    // Disconnecting asks first.
    await section
      .getByRole('button', { name: 'Disconnect repository' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm change' })
      .click();
    await expect(connectRepository).toBeVisible();
    // A refusal says why, with GitHub's page to add the workflow by hand.
    answer = {
      workflow: 'refused',
      reason:
        'GitHub didn’t accept a commit to main. A protected branch takes changes through pull requests only.',
      addUrl:
        'https://github.com/alice/landing/new/main?filename=.github%2Fworkflows%2Fshipcel.yml&value=name',
    };
    await section.getByRole('checkbox', { name: /Add the workflow/ }).check();
    await connectRepository.click();
    await expect(section.locator('.setup-warning')).toContainText(
      'A protected branch takes changes through pull requests only.',
    );
    await expect(
      section.getByRole('link', { name: 'Add it on GitHub' }),
    ).toHaveAttribute('href', answer.addUrl);
    // Refused because Shipcel's app isn't installed for the repository: GitHub's page for that,
    // and connecting again from there adds the workflow.
    await section
      .getByRole('button', { name: 'Disconnect repository' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm change' })
      .click();
    answer = {
      workflow: 'refused',
      reason:
        'Shipcel’s GitHub App isn’t installed on alice, so it can’t commit there. Install it on alice and connect again, or add the file by hand.',
      addUrl:
        'https://github.com/alice/landing/new/main?filename=.github%2Fworkflows%2Fshipcel.yml&value=name',
      installUrl: 'https://github.com/apps/shipcel/installations/new',
    };
    await section.getByRole('checkbox', { name: /Add the workflow/ }).check();
    await connectRepository.click();
    await expect(
      section.getByRole('link', { name: 'GitHub’s page for that' }),
    ).toHaveAttribute('href', answer.installUrl);
    expect(await axe(page)).toEqual([]);
    answer = {
      workflow: 'added',
      commitUrl: `https://github.com/alice/landing/commit/${'c'.repeat(40)}`,
    };
    await section.getByRole('button', { name: 'connect again' }).click();
    await expect(section).toContainText(
      'Shipcel added the workflow to main, so GitHub is deploying it now.',
    );
    expect(sent.at(-1)).toEqual({ repository: 'alice/landing', confirm: true });
    expect(builds).toEqual([]);
    // Cloudflare's own builds are still there, folded away.
    await page.getByText('Build with Cloudflare instead').click();
    await expect.poll(() => builds.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('with GitHub Actions, a project deployed by upload can deploy every push too, and one Cloudflare builds keeps that', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = await (
    await request.post('/api/projects', {
      data: { name: `qa-upload-actions-${Date.now()}`, framework: 'static' },
    })
  ).json();
  await signedIn(page, undefined, true);
  const job = {
    id: 'job-1',
    project_id: project.id,
    environment: 'production',
    status: 'deployed',
    step: 'finished',
    worker_name: 'site',
    account_id: accountId,
    live_url: 'https://site.alice.workers.dev/',
    resources: [],
    observedResources: [],
    created_at: 0,
    updated_at: 0,
  };
  let adapter = 'direct-upload';
  await page.route(`**/api/projects/${project.id}/deployments`, (route) =>
    route.fulfill({
      json: [
        {
          ...job,
          adapter,
          repository_name: adapter === 'direct-upload' ? '' : 'alice/site',
          branch: adapter === 'direct-upload' ? '' : 'main',
        },
      ],
    }),
  );
  await page.route(`**/api/projects/${project.id}/github-actions`, (route) =>
    route.fulfill({ json: { link: null, workflow: 'name: Shipcel\n' } }),
  );
  try {
    await page.goto(`/app/#projects/${project.id}/deployments`);
    await expect(
      page.getByRole('region', { name: 'Deploy from GitHub' }),
    ).toBeVisible();
    await expect(page.getByText('Build with Cloudflare instead')).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('heading', { name: 'GitHub deployments' }),
    ).toHaveCount(0);
    // Cloudflare builds it now: the page is opened again.
    adapter = 'static-assets';
    await page.goto('/app/#projects');
    await page.goto(`/app/#projects/${project.id}/deployments`);
    await expect(
      page.getByRole('heading', { name: 'GitHub deployments' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Deploy from GitHub' }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
