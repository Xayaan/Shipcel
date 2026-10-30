import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  deploymentCommand,
  previewCommand,
  previewsBlock,
  repositoryPlan,
  type StagingResource,
} from '../worker/repository-plan';
import { offlineEnv } from '../scripts/offline-env.mjs';

const run = promisify(execFile);
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');

// Runs the exact native-trigger deploy command, plus --dry-run, with the installed Wrangler.
// A dry run proves argument compatibility and binding parsing only; it is not a live deploy.
async function dryRun(command: string, files: Record<string, string>) {
  const [npx, pinned, ...args] = command.split(' ');
  const { version } = JSON.parse(
    await readFile('node_modules/wrangler/package.json', 'utf8'),
  );
  expect(npx).toBe('npx');
  expect(pinned).toBe(`wrangler@${version}`);
  const cwd = await mkdtemp(join(tmpdir(), 'shipcel-command-'));
  try {
    for (const [name, value] of Object.entries(files)) {
      await mkdir(join(cwd, name, '..'), { recursive: true });
      await writeFile(join(cwd, name), value);
    }
    const { stdout } = await run(
      process.execPath,
      [wrangler, ...args, '--dry-run', '--outdir', '.check'],
      {
        cwd,
        timeout: 60000,
        env: offlineEnv(cwd),
      },
    );
    return stdout;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('native deploy command', () => {
  it('is accepted by the pinned Wrangler CLI with draft D1 and R2 bindings', async () => {
    const stdout = await dryRun(
      deploymentCommand('configured-worker', 'cc-command-check-0123456789ab'),
      {
        'src/index.js':
          'export default { fetch() { return new Response("ok"); } };\n',
        'wrangler.json': JSON.stringify({
          name: 'repository-name',
          main: 'src/index.js',
          compatibility_date: '2026-10-07',
          d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
          r2_buckets: [{ binding: 'FILES' }],
        }),
      },
    );
    expect(stdout).toMatch(/env\.DB\s+D1 Database/);
    expect(stdout).toMatch(/env\.FILES\s+R2 Bucket/);
  }, 60000);
  it('accepts Workers AI, browser rendering, variables, cron schedules and SQLite Durable Objects', async () => {
    const config = {
      name: 'repository-name',
      main: 'src/index.js',
      compatibility_date: '2026-10-07',
      ai: { binding: 'AI' },
      browser: { binding: 'BROWSER' },
      version_metadata: { binding: 'VERSION' },
      vars: { MODE: 'production', RETRIES: 3 },
      placement: { mode: 'smart' },
      triggers: { crons: ['*/30 * * * *'] },
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
    };
    // Shipcel's own review accepts exactly what Wrangler is given here.
    expect(
      repositoryPlan({
        'package.json': '{}',
        'package-lock.json': '{}',
        'wrangler.json': JSON.stringify(config),
      }).issues,
    ).toEqual([]);
    const stdout = await dryRun(
      deploymentCommand('configured-worker', 'cc-command-check-0123456789ab'),
      {
        'src/index.js':
          'import { DurableObject } from "cloudflare:workers";\nexport class Room extends DurableObject {}\nexport default { fetch() { return new Response("ok"); }, scheduled() {} };\n',
        'wrangler.json': JSON.stringify(config),
      },
    );
    expect(stdout).toMatch(/env\.AI\s+AI/);
    expect(stdout).toMatch(/env\.ROOMS \(Room\)\s+Durable Object/);
    expect(stdout).toMatch(/env\.MODE \("production"\)\s+Environment Variable/);
    expect(stdout).toMatch(/env\.BROWSER\s+Browser/);
  }, 60000);
});

// `wrangler preview` has no dry run, so the exact preview trigger command runs against a
// local stand-in for Cloudflare's API (CLOUDFLARE_API_BASE_URL), as in Workers Builds.
// This proves what the pinned Wrangler sends; it is not evidence of Cloudflare's behavior.
// A local stand-in for the parts of Cloudflare's API that `wrangler preview` calls.
function standIn() {
  const requests: {
    method: string;
    path: string;
    contentType?: string;
    body: Buffer;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = req.url ?? '';
    requests.push({
      method: req.method ?? '',
      path,
      contentType: req.headers['content-type'],
      body: Buffer.concat(chunks),
    });
    const send = (status: number, result: unknown, errors: unknown[] = []) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ success: status < 400, errors, messages: [], result }),
      );
    };
    const worker = `/client/v4/accounts/${'a'.repeat(32)}/workers/workers/cc-command-check-0123456789ab`;
    if (path === worker)
      return send(200, {
        id: 'cc-command-check-0123456789ab',
        previews_base_config: {},
      });
    if (req.method === 'GET' && path.startsWith(`${worker}/previews/`))
      return send(404, null, [{ code: 10025, message: 'Preview not found' }]);
    if (req.method === 'POST' && path === `${worker}/previews`)
      return send(200, {
        id: '7a2c0f3e-0000-4000-8000-000000000001',
        slug: 'feature-login',
        name: 'feature/login',
        urls: [
          'https://feature-login-cc-command-check-0123456789ab.test.workers.dev',
        ],
      });
    // Every file is already stored, so the upload session completes at once.
    if (req.method === 'POST' && path.endsWith('/assets-upload-session'))
      return send(200, { jwt: 'completion-jwt', buckets: [] });
    if (req.method === 'POST' && path.endsWith('/deployments'))
      return send(200, {
        id: '9b1d0000-0000-4000-8000-000000000002',
        number: 1,
        urls: [
          'https://9b1d0000-cc-command-check-0123456789ab.test.workers.dev',
        ],
      });
    send(404, null, [
      { code: 10000, message: `Unexpected ${req.method} ${path}` },
    ]);
  });
  return { server, requests };
}

async function previewRun(
  config: Record<string, unknown>,
  entry = 'export default { fetch() { return new Response("ok"); } };\n',
) {
  const { server, requests } = standIn();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const cwd = await mkdtemp(join(tmpdir(), 'shipcel-preview-'));
  try {
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src/index.js'), entry);
    await writeFile(
      join(cwd, 'wrangler.json'),
      JSON.stringify({
        name: 'repository-name',
        main: 'src/index.js',
        compatibility_date: '2026-10-07',
        ...config,
      }),
    );
    const [npx, pinned, ...args] = previewCommand(
      'configured-worker',
      'cc-command-check-0123456789ab',
    ).split(' ');
    const { version } = JSON.parse(
      await readFile('node_modules/wrangler/package.json', 'utf8'),
    );
    expect([npx, pinned]).toEqual(['npx', `wrangler@${version}`]);
    const outcome = await run(process.execPath, [wrangler, ...args], {
      cwd,
      timeout: 60000,
      env: {
        ...offlineEnv(cwd),
        CLOUDFLARE_API_TOKEN: 'mock-api-token',
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
        // Workers Builds names the Preview after the branch it builds.
        WORKERS_CI_BRANCH: 'feature/login',
      },
    }).then(
      ({ stdout }) => ({ ok: true, output: stdout }),
      (error: { stdout?: string; stderr?: string }) => ({
        ok: false,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      }),
    );
    return { ...outcome, requests };
  } finally {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('preview trigger command', () => {
  const staging: StagingResource[] = [
    {
      type: 'd1',
      binding: 'DB',
      name: 'cc-command-check-0123456789ab-pv-a1b2c3d4-db',
      id: '60000000-0000-4000-8000-000000000001',
    },
    {
      type: 'kv',
      binding: 'CACHE',
      name: 'cc-command-check-0123456789ab-pv-a1b2c3d4-cache',
      id: '0123456789abcdef0123456789abcdef',
    },
  ];

  it('creates a Preview named after the branch, bound only to the staging copies', async () => {
    const { ok, output, requests } = await previewRun({
      d1_databases: [{ binding: 'DB' }],
      kv_namespaces: [{ binding: 'CACHE' }],
      preview_urls: true,
      previews: previewsBlock(staging, 'configured-worker'),
    });
    expect(output).not.toContain('Unexpected');
    expect(ok).toBe(true);
    const created = requests.find(
      (r) => r.method === 'POST' && r.path.endsWith('/previews'),
    )!;
    expect(JSON.parse(created.body.toString())).toMatchObject({
      name: 'feature/login',
    });
    const deployment = requests.find((r) => r.path.endsWith('/deployments'))!;
    expect(deployment.path).toContain(
      '/previews/7a2c0f3e-0000-4000-8000-000000000001/deployments',
    );
    const form = await new Response(new Uint8Array(deployment.body), {
      headers: { 'Content-Type': deployment.contentType! },
    }).formData();
    const metadata = JSON.parse(String(form.get('metadata')));
    expect(metadata.env).toEqual({
      DB: {
        type: 'd1',
        database_id: '60000000-0000-4000-8000-000000000001',
        database_name: 'cc-command-check-0123456789ab-pv-a1b2c3d4-db',
      },
      CACHE: {
        type: 'kv_namespace',
        namespace_id: '0123456789abcdef0123456789abcdef',
      },
    });
    expect(output).toContain(
      'https://feature-login-cc-command-check-0123456789ab.test.workers.dev',
    );
  }, 60000);

  it('gives each Preview Workers AI and its own Durable Object namespace from the generated block', async () => {
    const config = {
      ai: { binding: 'AI' },
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
    };
    const plan = repositoryPlan({
      'package.json': '{}',
      'package-lock.json': '{}',
      'wrangler.json': JSON.stringify({
        name: 'repository-name',
        main: 'src/index.js',
        compatibility_date: '2026-10-07',
        ...config,
      }),
    });
    const { ok, output, requests } = await previewRun(
      {
        ...config,
        preview_urls: true,
        previews: previewsBlock([], 'configured-worker', plan.previewBindings),
      },
      'import { DurableObject } from "cloudflare:workers";\nexport class Room extends DurableObject {}\nexport default { fetch() { return new Response("ok"); } };\n',
    );
    expect(output).not.toContain('Unexpected');
    expect(ok).toBe(true);
    const deployment = requests.find((r) => r.path.endsWith('/deployments'))!;
    const form = await new Response(new Uint8Array(deployment.body), {
      headers: { 'Content-Type': deployment.contentType! },
    }).formData();
    expect(JSON.parse(String(form.get('metadata'))).env).toEqual({
      AI: { type: 'ai' },
      ROOMS: { type: 'durable_object_namespace', class_name: 'Room' },
    });
  }, 60000);

  it('fails a preview build without a previews block, which is why Shipcel asks for one', async () => {
    const { ok, output, requests } = await previewRun({
      d1_databases: [{ binding: 'DB' }],
    });
    expect(ok).toBe(false);
    expect(output).toContain('previews');
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  }, 60000);
});

// A site without a Wrangler configuration: the trigger's command writes one, then deploys.
// The exact command runs in a shell with the installed Wrangler, plus --dry-run.
async function shellDryRun(command: string, files: Record<string, string>) {
  const { version } = JSON.parse(
    await readFile('node_modules/wrangler/package.json', 'utf8'),
  );
  expect(command).toContain(`npx wrangler@${version} deploy `);
  const cwd = await mkdtemp(join(tmpdir(), 'shipcel-site-'));
  try {
    for (const [name, value] of Object.entries(files)) {
      await mkdir(join(cwd, name, '..'), { recursive: true });
      await writeFile(join(cwd, name), value);
    }
    const local = command.replace(
      `npx wrangler@${version}`,
      `"${process.execPath}" "${wrangler}"`,
    );
    const { stdout } = await run(
      'sh',
      ['-c', `${local} --dry-run --outdir .check`],
      {
        cwd,
        timeout: 60000,
        env: offlineEnv(cwd),
      },
    );
    const written = async (name: string) =>
      readFile(join(cwd, name), 'utf8').catch(() => null);
    return {
      stdout,
      config: await written('wrangler.jsonc'),
      ignored: await written('.assetsignore'),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('the command for a site without a Wrangler configuration', () => {
  const vite = { preset: 'Vite', directory: 'dist', spa: true };
  it('writes a configuration that serves the build folder, then deploys it', async () => {
    const command = deploymentCommand('static-assets', 'cc-site-check', vite);
    expect(command).toBe(
      `printf '%s' '{"name":"cc-site-check","compatibility_date":"2026-10-07","assets":{"directory":"dist","not_found_handling":"single-page-application"},"preview_urls":true,"previews":{}}' > wrangler.jsonc && npx wrangler@4.156.0 deploy --no-autoconfig --name cc-site-check`,
    );
    const result = await shellDryRun(command, {
      'package.json': '{}',
      'dist/index.html': '<h1>ok</h1>',
      'dist/assets/app.js': 'console.log(1)',
    });
    expect(JSON.parse(result.config!).assets).toEqual({
      directory: 'dist',
      not_found_handling: 'single-page-application',
    });
    expect(result.stdout).toContain('--dry-run: exiting now.');
  }, 60000);
  it('publishes a plain HTML repository without .git, .github or node_modules', async () => {
    const html = { preset: 'HTML', directory: '.', spa: false };
    const result = await shellDryRun(
      deploymentCommand('static-assets', 'cc-site-check', html),
      {
        'index.html': '<h1>ok</h1>',
        '.git/config': '[core]',
        'node_modules/left-over/index.js': 'x',
      },
    );
    expect(JSON.parse(result.config!).assets).toEqual({
      directory: '.',
      not_found_handling: '404-page',
    });
    expect(result.ignored?.split('\n')).toEqual(
      expect.arrayContaining([
        '.git',
        '.github',
        'node_modules',
        '.wrangler',
        'wrangler.jsonc',
        '.assetsignore',
      ]),
    );
    expect(result.stdout).toContain('--dry-run: exiting now.');
  }, 60000);
  it('previews with the same configuration', () => {
    expect(previewCommand('static-assets', 'cc-site-check', vite)).toBe(
      `printf '%s' '{"name":"cc-site-check","compatibility_date":"2026-10-07","assets":{"directory":"dist","not_found_handling":"single-page-application"},"preview_urls":true,"previews":{}}' > wrangler.jsonc && npx wrangler@4.156.0 preview --worker-name cc-site-check`,
    );
  });
  it('refuses settings that could reach the shell', () => {
    expect(() => deploymentCommand('static-assets', 'cc-site-check')).toThrow();
    for (const directory of ["dist' && curl x '", '../out', '/etc', 'a b'])
      expect(() =>
        deploymentCommand('static-assets', 'cc-site-check', {
          ...vite,
          directory,
        }),
      ).toThrow();
  });
});

it('previews a site without a Wrangler configuration from the configuration Shipcel writes', async () => {
  const { server, requests } = standIn();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const cwd = await mkdtemp(join(tmpdir(), 'shipcel-site-preview-'));
  try {
    await mkdir(join(cwd, 'dist'));
    await writeFile(join(cwd, 'dist/index.html'), '<h1>preview</h1>');
    const { version } = JSON.parse(
      await readFile('node_modules/wrangler/package.json', 'utf8'),
    );
    const command = previewCommand(
      'static-assets',
      'cc-command-check-0123456789ab',
      {
        preset: 'Vite',
        directory: 'dist',
        spa: true,
      },
    ).replace(`npx wrangler@${version}`, `"${process.execPath}" "${wrangler}"`);
    const outcome = await run('sh', ['-c', command], {
      cwd,
      timeout: 60000,
      env: {
        ...offlineEnv(cwd),
        CLOUDFLARE_API_TOKEN: 'mock-api-token',
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
        WORKERS_CI_BRANCH: 'feature/login',
      },
    }).then(
      ({ stdout }) => ({ ok: true, output: stdout }),
      (error: { stdout?: string; stderr?: string }) => ({
        ok: false,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      }),
    );
    expect(outcome.output).not.toContain('Unexpected');
    expect(outcome.ok).toBe(true);
    expect(
      requests.some((r) => r.method === 'POST' && r.path.endsWith('/previews')),
    ).toBe(true);
    // The Preview serves the build folder, as a single-page app.
    const deployment = requests.find((r) => r.path.endsWith('/deployments'))!;
    const form = await new Response(new Uint8Array(deployment.body), {
      headers: { 'Content-Type': deployment.contentType! },
    }).formData();
    expect(JSON.parse(String(form.get('metadata'))).assets).toMatchObject({
      jwt: 'completion-jwt',
      config: { not_found_handling: 'single-page-application' },
    });
    expect(outcome.output).toContain(
      'https://feature-login-cc-command-check-0123456789ab.test.workers.dev',
    );
  } finally {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60000);
