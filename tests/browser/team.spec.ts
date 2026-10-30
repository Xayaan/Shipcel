import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;
const personal = {
  id: 'personal-1',
  name: "ada's workspace",
  role: 'owner',
  kind: 'personal',
};
const acme = { id: 'team-1', name: 'Acme', role: 'owner', kind: 'team' };
// A GitHub-signed-in person; the rest of the dashboard talks to the local API.
async function signedIn(
  page: Page,
  state: { workspaceId: string; role: string; workspaces: unknown[] },
) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: {
          login: 'ada',
          local: false,
          workspaceId: state.workspaceId,
          role: state.role,
          workspaces: state.workspaces,
        },
        githubConfigured: true,
        local: false,
      },
    }),
  );
}

test('owners switch workspaces, invite people with a one-time link and manage roles', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = {
    workspaceId: 'personal-1',
    role: 'owner',
    workspaces: [acme, personal],
  };
  await signedIn(page, state);
  const writes: unknown[] = [];
  let members = [
    { userId: 'gh-1', login: 'ada', role: 'owner', you: true },
    { userId: 'gh-2', login: 'grace', role: 'developer', you: false },
  ];
  let pending: unknown[] = [];
  await page.route('**/api/auth/workspace', async (route) => {
    const body = route.request().postDataJSON();
    writes.push({ switch: body.workspaceId });
    state.workspaceId = body.workspaceId;
    return route.fulfill({ json: body });
  });
  await page.route('**/api/workspace/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/workspace/members')
      return route.fulfill({ json: members });
    if (path.startsWith('/api/workspace/members/')) {
      writes.push({ method, path, body: route.request().postDataJSON() });
      if (method === 'DELETE')
        members = members.filter((m) => !path.endsWith(m.userId));
      else
        members = members.map((m) =>
          path.endsWith(m.userId)
            ? { ...m, role: route.request().postDataJSON().role }
            : m,
        );
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/workspace/invitations' && method === 'POST') {
      const body = route.request().postDataJSON();
      writes.push({ invite: body });
      pending = [
        {
          id: 'inv-1',
          login: body.login,
          role: body.role,
          createdAt: 1791400000,
          expiresAt: 1792000000,
        },
      ];
      return route.fulfill({
        status: 201,
        json: {
          id: 'inv-1',
          login: body.login,
          role: body.role,
          expiresAt: 1792000000,
          link: `http://127.0.0.1:5173/app/#invite?code=${'c'.repeat(43)}`,
        },
      });
    }
    if (path === '/api/workspace/invitations/inv-1') {
      writes.push({ cancel: 'inv-1' });
      pending = [];
      return route.fulfill({ json: { revoked: true } });
    }
    return route.fulfill({ json: pending });
  });
  await page.goto('/app/#team');
  // The switcher lists every workspace with the role there.
  const switcher = page.getByRole('combobox', { name: 'Workspace' });
  await expect(switcher).toHaveValue('personal-1');
  await switcher.selectOption('team-1');
  await expect(
    page.getByRole('heading', { name: 'People in Acme' }),
  ).toBeVisible();
  expect(writes[0]).toEqual({ switch: 'team-1' });
  await expect(page.getByText('@grace', { exact: true })).toBeVisible();
  await page.getByLabel('GitHub username').fill('@linus');
  await page
    .getByRole('combobox', { name: 'Role', exact: true })
    .selectOption('viewer');
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  await expect(page.getByText(`#invite?code=${'c'.repeat(43)}`)).toBeVisible();
  expect(writes[1]).toEqual({ invite: { login: 'linus', role: 'viewer' } });
  await expect(page.getByText('Waiting to join')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: "I've sent it" }).click();
  await page
    .getByRole('button', { name: 'Cancel the invitation for @linus' })
    .click();
  await expect(page.getByText('Waiting to join')).toHaveCount(0);
  await page.getByLabel('Role of @grace').selectOption('viewer');
  await expect(page.getByText('@grace is now viewer.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove @grace' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Remove @grace from Acme?');
  await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByText('@grace was removed.')).toBeVisible();
  expect(writes.slice(2)).toEqual([
    { cancel: 'inv-1' },
    {
      method: 'PUT',
      path: '/api/workspace/members/gh-2',
      body: { role: 'viewer' },
    },
    { method: 'DELETE', path: '/api/workspace/members/gh-2', body: null },
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

test('an invitation link joins the workspace it was made for', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = {
    workspaceId: 'personal-2',
    role: 'owner',
    workspaces: [{ ...personal, id: 'personal-2', name: "grace's workspace" }],
  };
  await signedIn(page, state);
  let accepted = false;
  const code = 'c'.repeat(43);
  await page.route(`**/api/invitations/${code}**`, async (route) => {
    if (route.request().method() === 'POST') {
      accepted = true;
      state.workspaceId = 'team-1';
      state.workspaces = [{ ...acme, role: 'developer' }, ...state.workspaces];
      return route.fulfill({ json: { workspaceId: 'team-1' } });
    }
    return route.fulfill({
      json: {
        workspaceName: 'Acme',
        role: 'developer',
        invitedBy: 'ada',
        login: 'grace',
        accepted: false,
        expired: false,
      },
    });
  });
  await page.goto(`/app/#invite?code=${code}`);
  await expect(page.getByText('@ada invited you to join')).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Join Acme' }).click();
  await expect(page).toHaveURL(/#overview$/);
  expect(accepted).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveValue(
    'team-1',
  );
  expect(errors).toEqual([]);
});

test('viewers read without being offered changes', async ({ page }) => {
  await signedIn(page, {
    workspaceId: 'team-1',
    role: 'viewer',
    workspaces: [{ ...acme, role: 'viewer' }, personal],
  });
  await page.goto('/app/#projects');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Projects' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(
    0,
  );
  await page.goto('/app/#templates');
  await page.locator('.catalog-card').first().click();
  await expect(page.getByText('Viewers can’t create projects.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
