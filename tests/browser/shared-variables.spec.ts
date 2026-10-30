import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('a shared variable is set on chosen projects after confirmation, and shows who missed a value', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const stamp = Date.now();
  const made = await Promise.all(
    ['alpha', 'beta'].map(async (name) => {
      const response = await request.post('/api/projects', {
        data: { name: `qa-shared-${name}-${stamp}`, framework: 'worker' },
      });
      return (await response.json()) as { id: string; name: string };
    }),
  );
  const [alpha, beta] = made;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let variables: unknown[] = [];
  const writes: Record<string, unknown>[] = [];
  try {
    await page.route('**/api/shared-variables**', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        writes.push(body);
        variables = [
          {
            name: 'API_KEY',
            updatedAt: 2,
            projects: [
              { id: alpha.id, name: alpha.name, current: true },
              { id: beta.id, name: beta.name, current: false },
            ],
          },
        ];
        return route.fulfill({
          json: {
            name: 'API_KEY',
            results: [
              { projectId: alpha.id, status: 'set' },
              {
                projectId: beta.id,
                status: 'failed',
                error:
                  'Deploy this project to create its Cloudflare Worker first.',
              },
            ],
          },
        });
      }
      return route.fulfill({ json: { variables } });
    });
    await page.goto('/app/#variables');
    await expect(
      page.getByRole('heading', { name: 'Shared variables', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('No shared variables yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Add a shared variable' }).click();
    await page.getByLabel('Name').fill('API_KEY');
    await page.getByLabel('Value').fill('sk_test_value');
    await page.getByRole('checkbox', { name: alpha.name }).check();
    await page.getByRole('checkbox', { name: beta.name }).check();
    await page.getByRole('button', { name: 'Set on 2 projects' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Set API_KEY on 2 projects?');
    await expect(dialog).toContainText('Shipcel doesn’t keep the value.');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    // What happened on each project, and the variable with the one that missed it.
    const outcome = page.getByRole('status');
    await expect(outcome).toContainText(`${alpha.name}: set`);
    await expect(outcome).toContainText(
      `${beta.name}: not changed. Deploy this project`,
    );
    await expect(page.getByText(`${beta.name} (out of date)`)).toBeVisible();
    expect(writes).toEqual([
      {
        requestId: expect.any(String),
        confirm: true,
        value: 'sk_test_value',
        projectIds: [alpha.id, beta.id],
      },
    ]);
    // The value isn't on the page any more.
    await expect(page.getByLabel('Value')).toHaveCount(0);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    for (const p of made) await request.delete(`/api/projects/${p.id}`);
  }
});
