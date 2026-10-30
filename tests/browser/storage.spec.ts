import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;

test('KV keys and R2 objects are browsed, edited, uploaded and deleted after confirmation', async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const name = `qa-storage-${Date.now()}`;
  const project = await (
    await request.post('/api/projects', { data: { name, framework: 'worker' } })
  ).json();
  const root = `/api/projects/${project.id}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes: Record<string, unknown>[] = [];
  const kv: Record<string, string> = {
    'config:theme': 'dark',
    blob: '\u0000binary',
  };
  const objects: Record<string, string> = {
    'index.html': '<h1>hi</h1>',
    'images/a.png': 'png',
  };
  const listed: string[] = [];
  try {
    await page.route(`**${root}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.slice(root.length);
      const environment = url.searchParams.get('environment');
      if (path === '/storage')
        return route.fulfill({
          json:
            environment === 'preview'
              ? { kv: [{ binding: 'CACHE', id: 'f'.repeat(32) }], r2: [] }
              : {
                  kv: [{ binding: 'CACHE', id: 'e'.repeat(32) }],
                  r2: [{ binding: 'FILES', bucket: 'files' }],
                },
        });
      if (path === '/storage/kv/CACHE/keys') {
        listed.push(`kv:${environment}`);
        return route.fulfill({
          json: {
            keys: Object.keys(kv)
              .sort()
              .map((k) => ({
                name: k,
                expiration: k === 'config:theme' ? 1893456000 : null,
              })),
            cursor: null,
          },
        });
      }
      if (path === '/storage/kv/CACHE/value' && req.method() === 'GET') {
        const key = url.searchParams.get('key')!;
        const text = /[\u0000-\u0008]/.test(kv[key]) ? null : kv[key];
        return route.fulfill({
          json: { key, text, size: kv[key].length, truncated: false },
        });
      }
      if (path === '/storage/kv/CACHE/value') {
        const body = req.postDataJSON();
        writes.push({
          method: req.method(),
          ...body,
          requestId: body.requestId ? 'set' : undefined,
        });
        if (req.method() === 'PUT') kv[body.key] = body.value;
        else delete kv[body.key];
        return route.fulfill({
          json: { id: 'op', status: 'succeeded', result: { key: body.key } },
        });
      }
      if (path === '/storage/r2/FILES/objects') {
        const prefix = url.searchParams.get('prefix') ?? '';
        listed.push(`r2:${prefix}`);
        const keys = Object.keys(objects)
          .filter((k) => k.startsWith(prefix))
          .sort();
        return route.fulfill({
          json: {
            objects: keys
              .filter((k) => !k.slice(prefix.length).includes('/'))
              .map((k) => ({
                key: k,
                size: objects[k].length,
                lastModified: '2026-10-01T00:00:00.000Z',
                contentType: 'text/plain',
              })),
            folders: [
              ...new Set(
                keys
                  .filter((k) => k.slice(prefix.length).includes('/'))
                  .map(
                    (k) => `${prefix}${k.slice(prefix.length).split('/')[0]}/`,
                  ),
              ),
            ],
            cursor: null,
          },
        });
      }
      if (path === '/storage/r2/FILES/object' && req.method() === 'GET') {
        const key = url.searchParams.get('key')!;
        return route.fulfill({
          body: objects[key],
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${key.split('/').pop()}"`,
          },
        });
      }
      if (path === '/storage/r2/FILES/object' && req.method() === 'PUT') {
        const form = req.postData() ?? '';
        writes.push({
          method: 'PUT',
          multipart: (req.headers()['content-type'] ?? '').startsWith(
            'multipart/form-data',
          ),
          key: /name="key"\r\n\r\n([^\r]*)/.exec(form)?.[1],
          confirm: /name="confirm"\r\n\r\n([^\r]*)/.exec(form)?.[1],
          file: /filename="([^"]*)"/.exec(form)?.[1],
        });
        objects['images/new.txt'] = 'new';
        return route.fulfill({
          json: { id: 'op', status: 'succeeded', result: { key: 'k' } },
        });
      }
      if (path === '/storage/r2/FILES/object') {
        const body = req.postDataJSON();
        writes.push({
          method: req.method(),
          ...body,
          requestId: body.requestId ? 'set' : undefined,
        });
        delete objects[body.key];
        return route.fulfill({
          json: { id: 'op', status: 'succeeded', result: { key: body.key } },
        });
      }
      const data: Record<string, unknown> = {
        '/deployments': [
          {
            id: 'job',
            status: 'deployed',
            environment: 'production',
            adapter: 'configured-worker',
          },
        ],
        '/operations': [],
        '/cloud': {
          worker: 'cc-fixture-worker',
          dashboardUrl: 'https://dash.cloudflare.com/',
          accountId: 'a'.repeat(32),
          bindings: [
            { name: 'CACHE', type: 'kv_namespace', id: 'e'.repeat(32) },
            { name: 'FILES', type: 'r2_bucket', id: 'files' },
          ],
        },
        '/previews': { status: 'active', resources: [{ type: 'kv' }] },
      };
      if (!(path in data)) return route.continue();
      return route.fulfill({ json: data[path] });
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.getByRole('tab', { name: 'Storage', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'CACHE, KV', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    // KV: open, edit and save a value; binary values are offered as downloads.
    await page.getByRole('button', { name: 'Open config:theme' }).click();
    await expect(page.locator('.storage-value pre')).toHaveText('dark');
    await page.getByRole('button', { name: 'Edit value' }).click();
    await page.getByRole('textbox', { name: 'Value' }).fill('light');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Save config:theme in CACHE?');
    expect(writes).toEqual([]);
    expect(await axe(page)).toEqual([]);
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('config:theme was saved.')).toBeVisible();
    await expect(page.locator('.storage-value pre')).toHaveText('light');
    await page.getByRole('button', { name: 'Open blob' }).click();
    await expect(page.getByText('This value isn’t text (7 B).')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      `${root}/storage/kv/CACHE/download?environment=production&key=blob`,
    );
    await page.getByRole('button', { name: 'Delete blob' }).click();
    await expect(dialog).toContainText('Delete blob from CACHE?');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('blob was deleted.')).toBeVisible();
    await expect(page.locator('.storage-value')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open blob' })).toHaveCount(
      0,
    );
    expect(writes).toEqual([
      {
        method: 'PUT',
        key: 'config:theme',
        value: 'light',
        environment: 'production',
        requestId: 'set',
        confirm: true,
      },
      {
        method: 'DELETE',
        key: 'blob',
        environment: 'production',
        requestId: 'set',
        confirm: true,
      },
    ]);

    // R2: folders, downloads, uploads and deletions.
    await page.getByRole('button', { name: 'FILES, R2', exact: true }).click();
    await expect(page.getByText('index.html', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'images/', exact: true }).click();
    await expect(page.getByText('a.png', { exact: true })).toBeVisible();
    // React's development mode loads each view twice.
    expect([...new Set(listed.filter((l) => l.startsWith('r2:')))]).toEqual([
      'r2:',
      'r2:images/',
    ]);
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download images/a.png' }).click();
    // Chromium fetches downloads outside page routing; the server tests cover the response.
    expect((await download).url()).toBe(
      new URL(
        `${root}/storage/r2/FILES/object?environment=production&key=images%2Fa.png`,
        page.url(),
      ).href,
    );
    // Files over 25 MB are for Wrangler.
    await page.getByLabel('File to upload').setInputFiles({
      name: 'large.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(25 * 1048576 + 1),
    });
    await expect(page.getByText('Files up to 25 MB')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Upload', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('File to upload').setInputFiles({
      name: 'new.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('new'),
    });
    await expect(page.getByRole('textbox', { name: 'Key' })).toHaveValue(
      'images/new.txt',
    );
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(dialog).toContainText('Upload images/new.txt to FILES?');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('images/new.txt was uploaded.')).toBeVisible();
    await expect(page.getByText('new.txt', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete images/a.png' }).click();
    await expect(dialog).toContainText('Delete images/a.png from FILES?');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByText('images/a.png was deleted.')).toBeVisible();
    await expect(page.getByText('a.png', { exact: true })).toHaveCount(0);
    expect(writes.slice(2)).toEqual([
      {
        method: 'PUT',
        multipart: true,
        key: 'images/new.txt',
        confirm: 'true',
        file: 'new.txt',
      },
      {
        method: 'DELETE',
        key: 'images/a.png',
        environment: 'production',
        requestId: 'set',
        confirm: true,
      },
    ]);
    await page.getByRole('button', { name: 'FILES', exact: true }).click();
    await expect(page.getByText('index.html', { exact: true })).toBeVisible();

    // Previews have their own staging copies.
    await page
      .getByRole('combobox', { name: 'Environment' })
      .selectOption('preview');
    await expect(
      page.getByRole('button', { name: 'CACHE, KV', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'FILES, R2', exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => listed.at(-1)).toBe('kv:preview');

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
