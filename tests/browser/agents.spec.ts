import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;

test('the AI agents page shows working settings for each agent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/tokens', (route) => route.fulfill({ json: [] }));
  await page.goto('/app/#agents');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Build with AI agents' }),
  ).toBeVisible();
  const endpoint = 'http://127.0.0.1:5173/mcp';
  await expect(
    page.getByText(
      `claude mcp add --transport http --scope user shipcel ${endpoint} --header "Authorization: Bearer $SHIPCEL_TOKEN"`,
    ),
  ).toBeVisible();
  // The .mcp.json settings read the token from the environment.
  await expect(page.getByText('"Bearer ${SHIPCEL_TOKEN}"')).toBeVisible();
  expect(await axe(page)).toEqual([]);

  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Codex', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(`url = "${endpoint}"`)).toBeVisible();
  await expect(
    page.getByText('bearer_token_env_var = "SHIPCEL_TOKEN"'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cursor', exact: true }).click();
  await expect(page.getByText('"Bearer ${env:SHIPCEL_TOKEN}"')).toBeVisible();
  await page.getByRole('button', { name: 'Other agents', exact: true }).click();
  await expect(page.getByText(`URL: ${endpoint}`)).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // The endpoint these settings point at is the real MCP server: it wants a token.
  const unauthenticated = await page.request.post('/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()['www-authenticate']).toMatch(/^Bearer /);

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(await axe(page)).toEqual([]);
  }
  await page.getByRole('button', { name: 'Create a token' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'API & CLI' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
