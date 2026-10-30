import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;

// The token routes are fixtures: local mode has no GitHub session to create real tokens.
test('API tokens are shown once, listed by prefix, and revoked after confirmation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const token = `cc_pat_${'x'.repeat(43)}`;
  let tokens: Record<string, unknown>[] = [];
  const writes: string[] = [];
  await page.route('**/api/tokens**', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      writes.push(`POST ${route.request().postData()}`);
      const created = {
        id: 'token-1',
        name: 'Laptop',
        prefix: token.slice(0, 12),
        createdAt: 1791400000,
        lastUsedAt: null,
        expiresAt: 1791400000 + 90 * 86400,
      };
      tokens = [created];
      return route.fulfill({ status: 201, json: { ...created, token } });
    }
    if (method === 'DELETE') {
      writes.push(`DELETE ${new URL(route.request().url()).pathname}`);
      tokens = [];
      return route.fulfill({ json: { revoked: true } });
    }
    return route.fulfill({ json: tokens });
  });
  await page.goto('/app/#developers');
  await expect(page.getByRole('heading', { name: 'API tokens' })).toBeVisible();
  // The CLI comes from this Shipcel, not a package registry.
  await expect(
    page.getByText('npm install -g http://127.0.0.1:5173/cli/shipcel.tgz'),
  ).toBeVisible();
  // Setting up starts in the terminal: sign in, then run it in the project's folder.
  await expect(
    page.getByText('shipcel login --url http://127.0.0.1:5173'),
  ).toBeVisible();
  await expect(page.getByText('builds it here and deploys it')).toBeVisible();
  await expect(
    page.getByText(
      'npx --yes --package=http://127.0.0.1:5173/cli/shipcel.tgz shipcel deploy ./dist --prod --project my-site',
    ),
  ).toBeVisible();
  // The commands match Vercel's; the CLI guide lists them side by side.
  await expect(page.getByRole('link', { name: 'CLI guide' })).toHaveAttribute(
    'href',
    '/docs/cli/#coming-from-vercel',
  );
  const cli = await page.request.get('/cli/shipcel.tgz');
  expect(cli.status()).toBe(200);
  expect((await cli.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  await expect(page.getByText('No API tokens yet.')).toBeVisible();
  await page.getByLabel('Token name').fill('Laptop');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText(token, { exact: true })).toBeVisible();
  await expect(page.getByText('Copy your new token now.')).toBeVisible();
  expect(writes[0]).toBe(
    `POST ${JSON.stringify({ name: 'Laptop', expiresInDays: 90 })}`,
  );
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: "I've saved it" }).click();
  await expect(page.getByText(token, { exact: true })).toHaveCount(0);
  await expect(page.getByText(`${token.slice(0, 12)}…`)).toBeVisible();
  await page.getByRole('button', { name: 'Revoke Laptop' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('stops working at once');
  await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByText('No API tokens yet.')).toBeVisible();
  expect(writes[1]).toBe('DELETE /api/tokens/token-1');
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
