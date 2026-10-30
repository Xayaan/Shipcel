import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetHash } from '../../shared/assets';

const axe = async (page: Page) =>
  (
    await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
  ).violations;
const base64 = (text: string) => Buffer.from(text).toString('base64');

// Cloudflare is not involved: the upload routes are fixtures. This proves the dashboard's
// folder handling, hashing and requests, not a live deployment.
test('drag-and-drop deploys a built folder unpublished, then publishes it', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = `qa-upload-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, framework: 'static' },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: string };
  const root = `/api/projects/${project.id}`;
  // A built site, as a build tool leaves it.
  const dir = mkdtempSync(join(tmpdir(), 'shipcel-upload-'));
  const site = join(dir, 'dist');
  mkdirSync(join(site, 'assets'), { recursive: true });
  mkdirSync(join(site, 'node_modules'), { recursive: true });
  const index = '<h1>Hello</h1>';
  const script = 'console.log(1)';
  writeFileSync(join(site, 'index.html'), index);
  writeFileSync(join(site, 'assets', 'app.js'), script);
  writeFileSync(join(site, 'node_modules', 'left-over.js'), 'x');
  writeFileSync(join(site, '_redirects'), '/old /new 301');
  const bodies: Record<string, unknown> = {};
  let deployed = false;
  let published = false;
  const job = () => ({
    id: 'upload-job',
    project_id: project.id,
    adapter: 'direct-upload',
    environment: 'production',
    status: 'deployed',
    worker_name: name,
    live_url: published ? `https://${name}.test.workers.dev/` : null,
    repository_name: '',
    branch: '',
    resources: [],
    observedResources: [],
  });
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      const method = route.request().method();
      if (method === 'POST') bodies[path] = route.request().postDataJSON();
      if (path === '/deployments')
        return route.fulfill({ json: deployed ? [job()] : [] });
      if (path === '/uploads' && method === 'POST') {
        const files = (bodies[path] as { files: { hash: string }[] }).files;
        return route.fulfill({
          status: 201,
          json: {
            uploadId: 'up-1',
            workerName: name,
            missing: files.map((f) => f.hash),
            buckets: [files.map((f) => f.hash)],
            maxRequestBytes: 34 * 1024 * 1024,
            expiresAt: 0,
          },
        });
      }
      if (path === '/uploads/up-1/files')
        return route.fulfill({ json: { received: 2, missing: [] } });
      if (path === '/uploads/up-1/deploy') {
        deployed = true;
        return route.fulfill({
          json: {
            id: 'op',
            status: 'succeeded',
            result: {
              workerName: name,
              versionId: '0000000a-0000-4000-8000-000000000000',
              previewUrl: `https://0000000a-${name}.test.workers.dev`,
              url: null,
              published: false,
            },
          },
        });
      }
      if (path === '/uploads')
        return route.fulfill({
          json: deployed
            ? [
                {
                  id: 'up-1',
                  status: 'deployed',
                  files: 2,
                  bytes: 28,
                  createdAt: 1791400000,
                  versionId: '0000000a-0000-4000-8000-000000000000',
                  url: null,
                  previewUrl: `https://0000000a-${name}.test.workers.dev`,
                  published: false,
                },
              ]
            : [],
        });
      if (path === '/publish') {
        published = true;
        return route.fulfill({
          json: { id: 'op2', status: 'succeeded', result: { published: true } },
        });
      }
      return route.continue();
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Or drag and drop a folder' }),
    ).toBeVisible();
    await page.getByLabel('Folder to deploy').setInputFiles(site);
    await expect(page.getByText(/^2 files/)).toBeVisible();
    await expect(page.getByText(/1 skipped/)).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: /Single-page app/ }),
    ).toBeChecked();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(
      'stays unpublished until you publish it: only its preview address works',
    );
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByText('Not published: only the preview address below works'),
    ).toBeVisible();
    await expect(
      page
        .getByRole('link', {
          name: `https://0000000a-${name}.test.workers.dev`,
        })
        .first(),
    ).toBeVisible();
    // Exactly the built files, hashed the way Cloudflare expects; node_modules skipped.
    const manifest = bodies['/uploads'] as {
      files: { path: string; hash: string; size: number }[];
      workerName: string;
    };
    expect(manifest.workerName).toBe(name);
    expect(manifest.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [
        {
          path: '/assets/app.js',
          hash: assetHash(base64(script), '/assets/app.js'),
          size: script.length,
        },
        {
          path: '/index.html',
          hash: assetHash(base64(index), '/index.html'),
          size: index.length,
        },
      ],
    );
    const sent = bodies['/uploads/up-1/files'] as {
      files: { hash: string; content: string }[];
    };
    expect(sent.files.map((f) => f.content).sort()).toEqual(
      [base64(script), base64(index)].sort(),
    );
    expect(bodies['/uploads/up-1/deploy']).toMatchObject({
      confirm: true,
      spa: true,
      publish: false,
      redirects: '/old /new 301',
    });
    // Now the project deploys by upload: publish it.
    await expect(
      page.getByRole('heading', { name: 'Direct uploads' }),
    ).toBeVisible();
    await expect(
      page.getByText('Not published: only preview addresses work.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(dialog).toContainText('Anyone with the address');
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByRole('link', { name: `https://${name}.test.workers.dev/` }),
    ).toBeVisible();
    expect(bodies['/publish']).toMatchObject({ confirm: true });
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

// An app with code or bindings is deployed by Wrangler from its folder (fixtures again:
// tests/local-deploys.test.ts covers the deploy itself). The dashboard says how to deploy
// it and takes no dropped folder, which would replace the app's code and bindings.
test('an app deployed by Wrangler says how to deploy it again, and takes no dropped folder', async ({
  page,
  request,
}) => {
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = `qa-app-${Date.now()}`;
  const created = await request.post('/api/projects', {
    data: { name, framework: 'nextjs' },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: string };
  const root = `/api/projects/${project.id}`;
  try {
    await page.route(`**${root}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(root.length);
      if (path === '/deployments')
        return route.fulfill({
          json: [
            {
              id: 'app-job',
              project_id: project.id,
              adapter: 'direct-upload',
              localAdapter: 'nextjs',
              environment: 'production',
              status: 'deployed',
              worker_name: name,
              live_url: `https://${name}.test.workers.dev/`,
              repository_name: '',
              branch: '',
              resources: [{ type: 'd1', binding: 'DB' }],
              observedResources: [],
            },
          ],
        });
      if (path === '/uploads')
        return route.fulfill({
          json: [
            {
              id: 'u1',
              status: 'deployed',
              files: 14,
              bytes: 2048,
              createdAt: 1760313600,
              versionId: '0000000a-0000-4000-8000-000000000000',
              url: `https://${name}.test.workers.dev/`,
              previewUrl: `https://0000000a-${name}.test.workers.dev`,
              published: true,
            },
          ],
        });
      return route.continue();
    });
    await page.goto('/app/#projects');
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page
      .getByRole('button', { name: 'Deployments', exact: true })
      .click();
    const panel = page.locator('.direct-upload');
    await expect(
      panel.getByRole('heading', { name: 'Deploys from your computer' }),
    ).toBeVisible();
    await expect(panel).toContainText(
      'This project is a Next.js app on OpenNext. It is built on your computer and deployed by Wrangler',
    );
    await expect(panel.getByText('shipcel --prod')).toBeVisible();
    // No way to drop a folder on it, and no GitHub pipeline offered either.
    await expect(panel.getByText('Drop a folder here')).toBeHidden();
    await expect(
      panel.getByRole('button', { name: 'Choose a folder' }),
    ).toBeHidden();
    await expect(
      page.getByRole('heading', { name: 'GitHub deployments' }),
    ).toHaveCount(0);
    // Its history loads with the project, without a deploy from this page first.
    await expect(
      panel.getByRole('heading', { name: 'Deploys', exact: true }),
    ).toBeVisible();
    await expect(panel).toContainText('14 files, 2.0 KB, live version');
    await expect(panel.getByRole('link', { name: 'preview' })).toHaveAttribute(
      'href',
      `https://0000000a-${name}.test.workers.dev`,
    );
    await expect(
      panel.getByRole('link', { name: `https://${name}.test.workers.dev/` }),
    ).toBeVisible();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({
        path: `docs/screenshots/app-deploys-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});
