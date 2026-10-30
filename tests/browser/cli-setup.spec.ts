import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Browser fixtures validate UI contracts only; they are not live provider evidence.
const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;
const code = 'BCDF-GHJK';
const accounts = [
  { id: 'a'.repeat(32), name: 'Alice’s Account' },
  { id: 'b'.repeat(32), name: 'Studio' },
];
const alice = {
  login: 'alice',
  workspaceId: 'personal-1',
  role: 'owner',
  local: false,
  workspaces: [
    {
      id: 'personal-1',
      name: 'alice’s workspace',
      role: 'owner',
      kind: 'personal',
    },
  ],
};

// The pages the shipcel CLI opens, with Shipcel's API as fixtures: who is signed in, the
// pending CLI sign-in, and the Cloudflare connection, each changed as the person goes on.
async function fixtures(page: Page) {
  const state = {
    user: null as typeof alice | null,
    local: false,
    githubConfigured: true,
    login: {
      code,
      host: 'ada-laptop',
      status: 'pending',
      createdAt: 1791400000,
      expiresAt: 1791400600,
      mine: false,
    } as Record<string, unknown>,
    loginError: '',
    cloudflare: {
      configured: true,
      connected: false,
      account: null as { id: string; name: string } | null,
    },
    subdomain: 'alice' as string | null,
    writes: [] as string[],
  };
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: state.user,
        githubConfigured: state.githubConfigured,
        local: state.local,
      },
    }),
  );
  await page.route('**/api/cli/login/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      const choice = path.split('/').pop()!;
      state.writes.push(`${choice} ${request.postData()}`);
      state.login = {
        ...state.login,
        status: choice === 'approve' ? 'approved' : 'denied',
        mine: true,
      };
      return route.fulfill({ json: { [`${choice}d`]: true } });
    }
    return state.loginError
      ? route.fulfill({ status: 403, json: { error: state.loginError } })
      : route.fulfill({ json: state.login });
  });
  await page.route('**/api/connections', (route) =>
    route.fulfill({
      json: {
        github: { configured: true, connected: true, installUrl: null },
        cloudflare: state.cloudflare,
        nativeBuildsEnabled: true,
      },
    }),
  );
  await page.route('**/api/connections/cloudflare/accounts**', (route) =>
    route.fulfill({ json: { accounts, nextPage: null } }),
  );
  await page.route('**/api/connections/cloudflare/account', (route) => {
    const { accountId } = route.request().postDataJSON() as {
      accountId: string;
    };
    state.writes.push(`account ${accountId}`);
    state.cloudflare = {
      ...state.cloudflare,
      account: accounts.find((a) => a.id === accountId)!,
    };
    return route.fulfill({ json: { account: state.cloudflare.account } });
  });
  await page.route('**/api/connections/cloudflare/subdomain', (route) => {
    if (route.request().method() === 'POST') {
      state.writes.push(`subdomain ${route.request().postData()}`);
      state.subdomain = (
        route.request().postDataJSON() as { subdomain: string }
      ).subdomain;
    }
    return route.fulfill({ json: { subdomain: state.subdomain } });
  });
  return state;
}

test('the page shipcel login opens signs in with GitHub, approves the code and connects Cloudflare, each coming back to it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await fixtures(page);
  state.subdomain = null;
  // Not signed in: the page itself offers GitHub, and asks to come back with the code.
  await page.goto(`/app/#cli-login?code=${code}`);
  await expect(
    page.getByRole('heading', { name: 'Sign in the Shipcel CLI' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Continue with GitHub' }),
  ).toHaveAttribute(
    'href',
    `/api/auth/github/start?return=${encodeURIComponent(`cli-login:${code}`)}`,
  );
  // No dashboard around it, and nothing to approve before signing in.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByText('Then check the code')).toContainText(code);
  expect(await axe(page)).toEqual([]);

  // GitHub sends the browser back to the same page, signed in.
  state.user = alice;
  await page.goto(`/app/?connection=success#cli-login?code=${code}`);
  await expect(page.getByText('Signed in as alice')).toContainText(
    'in alice’s workspace',
  );
  await expect(page).toHaveURL(`/app/#cli-login?code=${code}`);
  await expect(page.getByLabel(`Code ${code}`)).toBeVisible();
  await expect(page.getByText(/Requested from ada-laptop/)).toBeVisible();
  await expect(
    page.getByText(/acts as you in alice’s workspace for 90 days/),
  ).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(
    page.getByText('The CLI on ada-laptop is signed in.'),
  ).toBeVisible();
  expect(state.writes).toEqual([`approve ${JSON.stringify({ code })}`]);

  // The same page carries on to Cloudflare, and comes back here again.
  await expect(
    page.getByRole('link', { name: 'Connect Cloudflare' }),
  ).toHaveAttribute(
    'href',
    `/api/auth/cloudflare/start?return=${encodeURIComponent(`cli-login:${code}`)}`,
  );
  await expect(page.getByText('You’re all set.')).toHaveCount(0);
  state.cloudflare = { configured: true, connected: true, account: null };
  state.login = { ...state.login, status: 'delivered' };
  await page.goto(`/app/?connection=success#cli-login?code=${code}`);
  // The code is used by now: the person who approved it is told so, not asked again.
  await expect(
    page.getByText('The CLI on ada-laptop is signed in.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  // A connection that reaches several accounts: one is chosen here.
  const picker = page.getByLabel(/Which one do apps deploy to/);
  await expect(
    page.getByRole('button', { name: 'Use this account' }),
  ).toBeDisabled();
  await picker.selectOption({ label: 'Studio' });
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Use this account' }).click();
  await expect(page.getByText('Apps deploy to Studio.')).toBeVisible();
  // An account without a workers.dev subdomain claims one before the CLI can deploy.
  await expect(page.getByText('You’re all set.')).toHaveCount(0);
  const claim = page.getByRole('button', { name: /^Claim / });
  await expect(claim).toBeDisabled();
  await page.getByLabel('workers.dev subdomain').fill('Studio-Apps');
  await claim.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Claim studio-apps.workers.dev?');
  await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(
    page.getByText('You’re all set. Go back to your terminal.'),
  ).toBeVisible();
  expect(state.writes.slice(1)).toEqual([
    `account ${accounts[1].id}`,
    `subdomain ${JSON.stringify({ subdomain: 'studio-apps', confirm: true })}`,
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
});

test('the setup page the CLI opens before a deploy only connects Cloudflare, and says who can', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await fixtures(page);
  state.user = alice;
  await page.goto('/app/?connection=declined#cli-setup');
  await expect(
    page.getByRole('heading', { name: 'Finish setting up the CLI' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Authorization was declined; nothing was connected.',
  );
  // No code: nothing to approve.
  await expect(
    page.getByRole('heading', { name: 'Approve this computer' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Connect Cloudflare' }),
  ).toHaveAttribute('href', '/api/auth/cloudflare/start?return=cli-setup');
  expect(await axe(page)).toEqual([]);
  // Connected, with the only account chosen for them: done.
  state.cloudflare = {
    configured: true,
    connected: true,
    account: accounts[0],
  };
  await page.goto('/app/?connection=success#cli-setup');
  await expect(page.getByText('Apps deploy to Alice’s Account.')).toBeVisible();
  await expect(
    page.getByText('You’re all set. Go back to your terminal.'),
  ).toBeVisible();
  expect(await axe(page)).toEqual([]);
  // A developer can't connect accounts: the page says who can.
  state.user = { ...alice, role: 'developer' };
  state.cloudflare = { configured: true, connected: false, account: null };
  await page.reload();
  await expect(
    page.getByText('Ask one of its owners to connect it.'),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Connect Cloudflare' }),
  ).toHaveCount(0);
  await expect(page.getByText('You’re all set.')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the CLI’s page explains a code that can’t be approved, and a Shipcel that isn’t set up', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await fixtures(page);
  // A local Shipcel without its GitHub App yet: the local workspace can't approve a CLI.
  state.local = true;
  state.githubConfigured = false;
  state.user = {
    ...alice,
    login: 'Local workspace',
    workspaceId: 'local',
    local: true,
  };
  await page.goto(`/app/#cli-login?code=${code}`);
  await expect(
    page.getByText('This Shipcel has no GitHub sign-in yet.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connections' })).toHaveAttribute(
    'href',
    '/app/#connections',
  );
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
  // Once it is set up, the local workspace still signs in with GitHub first.
  state.githubConfigured = true;
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Continue with GitHub' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  // Signed in, with a code someone else used, or that ran out.
  state.user = alice;
  state.login = { ...state.login, status: 'delivered', mine: false };
  await page.reload();
  await expect(
    page.getByText('This code was already used or has expired.'),
  ).toBeVisible();
  state.login = { ...state.login, status: 'expired' };
  await page.reload();
  await expect(
    page.getByText('This code was already used or has expired.'),
  ).toBeVisible();
  // Denying says so, and the page doesn't call the terminal set up.
  state.login = { ...state.login, status: 'pending' };
  state.cloudflare = {
    configured: true,
    connected: true,
    account: accounts[0],
  };
  await page.reload();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(
    page.getByText('Denied. The CLI won’t get access.'),
  ).toBeVisible();
  await expect(page.getByText('You’re all set.')).toHaveCount(0);
  expect(state.writes).toEqual([`deny ${JSON.stringify({ code })}`]);
  // A viewer can't approve a CLI: Shipcel's reason is shown where the code would be.
  state.loginError =
    'Viewers can’t change projects. Ask a workspace owner for developer access.';
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Viewers can’t change');
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('the page shipcel tokens add opens approves a named token, without the Cloudflare step', async ({
  page,
}) => {
  const state = await fixtures(page);
  state.user = alice;
  state.login = {
    ...state.login,
    host: 'build-box',
    token: { name: 'CI deploy', expiresInDays: 30 },
  };
  await page.goto(`/app/#cli-login?code=${code}&token=1`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Create an API token' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Approve the token' }),
  ).toBeVisible();
  await expect(
    page.getByText(/only approve a token you asked for yourself/),
  ).toContainText(
    'creates the token CI deploy, which acts as you in alice’s workspace for 30 days',
  );
  // Nothing about Cloudflare: a token doesn't need it, and the connection is unchanged.
  await expect(
    page.getByRole('heading', { name: /Connect Cloudflare/ }),
  ).toHaveCount(0);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await axe(page)).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText(
    'Created the token CI deploy. Your terminal shows it once',
  );
  await expect(
    page.getByText('You’re all set. Go back to your terminal.'),
  ).toBeVisible();
  expect(state.writes).toEqual([`approve {"code":"${code}"}`]);
});
