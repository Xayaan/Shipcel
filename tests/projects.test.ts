import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import app from '../worker/index';
import { database } from './helpers/database';
import { projectNameFrom, projectSchema } from '../shared/validation';
import {
  allowsBindings,
  frameworks,
  hasKit,
  usesContainers,
  type Project,
} from '../shared/catalog';
import { generateConfig, generateKit } from '../worker/kits';
import { repositoryPlan } from '../worker/repository-plan';

const base: Project = {
  id: 'test',
  name: 'test-app',
  framework: 'react',
  source: 'kit',
  repository: '',
  database: false,
  storage: false,
  freeOnly: true,
  createdAt: '2026-10-07T00:00:00Z',
};
const input = {
  name: 'test-app',
  framework: 'react',
  repository: '',
  database: false,
  storage: false,
};

describe('project boundaries', () => {
  it('accepts planning for every runtime in the catalog', () => {
    // Containers need Workers Paid, so their projects can't be Free-only.
    for (const f of frameworks)
      expect(
        projectSchema.safeParse({
          ...input,
          framework: f.id,
          freeOnly: !usesContainers(f.id),
        }).success,
      ).toBe(true);
    expect(
      projectSchema.safeParse({ ...input, framework: 'docker' }).success,
    ).toBe(false);
  });
  it.each([
    '../secret',
    'test;ls',
    '$(whoami)',
    'hello world',
    '<script>',
    'a--b',
    '-hello',
    'Uppercase',
    'a'.repeat(49),
  ])('rejects unsafe project name %s', (name) => {
    expect(projectSchema.safeParse({ ...input, name }).success).toBe(false);
  });
  it.each([
    'javascript:alert(1)',
    'https://github.com.evil.test/a/b',
    'https://github.com/a/b?token=secret',
    'https://user:password@github.com/a/b',
    'https://github.com/a/b/tree/main',
  ])('rejects misleading repository URL %s', (repository) => {
    expect(projectSchema.safeParse({ ...input, repository }).success).toBe(
      false,
    );
  });
  it('rejects resource combinations not supported by a kit', () => {
    for (const framework of ['static', 'wordpress', 'docker'])
      expect(
        projectSchema.safeParse({ ...input, framework, database: true })
          .success,
      ).toBe(false);
    // Framework kits declare draft D1 and R2 bindings like the JavaScript kits.
    for (const framework of ['astro', 'sveltekit', 'nextjs', 'python'])
      expect(
        projectSchema.safeParse({ ...input, framework, database: true })
          .success,
      ).toBe(true);
  });
  it('starts a project from a starter kit or from a GitHub repository, never both', () => {
    // Without a source, a repository means the project comes from GitHub.
    expect(projectSchema.parse(input).source).toBe('kit');
    expect(
      projectSchema.parse({ ...input, repository: 'https://github.com/a/b' })
        .source,
    ).toBe('github');
    const github = {
      ...input,
      source: 'github',
      repository: 'https://github.com/a/b',
    };
    expect(projectSchema.safeParse(github).success).toBe(true);
    // A GitHub project needs its repository, and a runtime that can be imported.
    expect(
      projectSchema.safeParse({ ...github, repository: '' }).error?.issues[0]
        .message,
    ).toContain('Choose a GitHub repository');
    expect(
      projectSchema.safeParse({ ...github, framework: 'wordpress' }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({
        ...input,
        framework: 'wordpress',
        repository: 'https://github.com/a/b',
      }).success,
    ).toBe(false);
    // A starter kit starts without one; link it in Deployments after pushing the kit.
    expect(projectSchema.safeParse({ ...github, source: 'kit' }).success).toBe(
      false,
    );
    expect(projectSchema.safeParse({ ...input, source: 'zip' }).success).toBe(
      false,
    );
  });
  it('rejects fields for credentials rather than silently storing them', () => {
    expect(
      projectSchema.safeParse({ ...input, apiToken: 'secret' }).success,
    ).toBe(false);
  });
});

describe('portable starter kits', () => {
  for (const framework of frameworks.filter((f) => hasKit(f.id))) {
    it(`generates a coherent ${framework.id} project`, () => {
      const project = { ...base, framework: framework.id };
      const files = generateKit(project);
      // pywrangler reads wrangler.jsonc, so the Python kit is configured there.
      const config = JSON.parse(
        files['wrangler.json'] ?? files['wrangler.jsonc'],
      );
      const pkg = JSON.parse(files['package.json']);
      expect(config.name).toBe(project.name);
      expect(pkg.scripts.predeploy).toContain('check-config');
      expect(pkg.scripts.build).toBeTruthy();
      expect(files['README.md']).toContain('not an import');
      // The free address needs no domain purchase.
      expect(files['README.md']).toContain(
        `https://${project.name}.<your-subdomain>.workers.dev`,
      );
      expect(files['docs/deploy.workflow.yml']).toContain(
        '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      );
      expect(files['docs/deploy.workflow.yml']).not.toContain('pull_request');
      // Kits whose entry point is source code ship it; framework kits point at the
      // adapter's entry point or build output.
      if (config.main?.startsWith('src/'))
        expect(files[config.main]).toBeTruthy();
      if (framework.id === 'static') {
        expect(config.main).toBeUndefined();
        expect(files['public/404.html']).toBeTruthy();
      }
    });
  }
  // A container kit's Worker, run with a stand-in for @cloudflare/containers that answers with
  // what the container would be started with.
  async function containerWorker(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'shipcel-container-kit-'));
    const stand = join(dir, 'node_modules/@cloudflare/containers');
    mkdirSync(stand, { recursive: true });
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/worker.js'), files['src/worker.js']);
    writeFileSync(
      join(stand, 'package.json'),
      JSON.stringify({
        name: '@cloudflare/containers',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(stand, 'index.js'),
      `export class Container {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.envVars = {}; }
  async fetch(request) {
    return Response.json({ port: this.defaultPort, sleepAfter: this.sleepAfter, envVars: this.envVars, url: request.url });
  }
}
export const getContainer = (binding, name) => binding.get(name ?? 'cf-singleton-container');
`,
    );
    return (await import(pathToFileURL(join(dir, 'src/worker.js')).href)) as {
      default: {
        fetch(r: Request, env: Record<string, unknown>): Promise<Response>;
      };
      [name: string]: unknown;
    };
  }
  type ContainerClass = new (
    ctx: unknown,
    env: Record<string, unknown>,
  ) => { fetch(r: Request): Promise<Response> };
  // The Worker's environment, with the Durable Object binding handing out one instance.
  const containerEnv = (
    module: Record<string, unknown>,
    className: string,
    binding: string,
    secrets: Record<string, string>,
  ) => {
    const env: Record<string, unknown> = { ...secrets };
    const instance = new (module[className] as ContainerClass)({}, env);
    env[binding] = { get: () => instance };
    return env;
  };

  it('starts a container app: a Worker in front of a container built from its Dockerfile', async () => {
    const files = generateKit({
      ...base,
      framework: 'docker',
      freeOnly: false,
    });
    expect(JSON.parse(files['wrangler.json'])).toMatchObject({
      main: 'src/worker.js',
      containers: [
        {
          class_name: 'AppContainer',
          image: './Dockerfile',
          instance_type: 'lite',
          max_instances: 2,
        },
      ],
      durable_objects: {
        bindings: [{ name: 'APP', class_name: 'AppContainer' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['AppContainer'] }],
    });
    expect(files['Dockerfile']).toMatch(/^FROM node:24-alpine$/m);
    expect(files['Dockerfile']).toContain('CMD ["node", "server.mjs"]');
    expect(files['container/server.mjs']).toContain('.listen(8080)');
    expect(JSON.parse(files['package.json']).dependencies).toEqual({
      '@cloudflare/containers': '0.3.7',
    });
    // The repository Shipcel's GitHub deployment reviews, once its lockfile is committed.
    const plan = repositoryPlan(
      { ...files, 'package-lock.json': '{}' },
      'docker',
    );
    expect(plan.issues).toEqual([]);
    expect(plan.adapter).toBe('container');
    expect(plan.containers).toHaveLength(1);
    // The Worker answers its own health check, so checking it starts no container.
    const worker = await containerWorker(files);
    const env = containerEnv(worker, 'AppContainer', 'APP', {});
    const health = await worker.default.fetch(
      new Request('https://test-app.example.workers.dev/api/health'),
      env,
    );
    expect(await health.json()).toEqual({ ok: true, app: 'test-app' });
    const page = await worker.default.fetch(
      new Request('https://test-app.example.workers.dev/'),
      env,
    );
    expect(await page.json()).toMatchObject({
      port: 8080,
      sleepAfter: '10m',
      envVars: { APP_NAME: 'test-app' },
    });
  });

  it('runs Umami and n8n from their published images, with their data in Postgres', async () => {
    const umami = generateKit({ ...base, framework: 'umami', freeOnly: false });
    const n8n = generateKit({ ...base, framework: 'n8n', freeOnly: false });
    expect(JSON.parse(umami['wrangler.json']).containers).toEqual([
      {
        class_name: 'Umami',
        image: 'docker.io/umamisoftware/umami:3.4.1',
        instance_type: 'basic',
        max_instances: 1,
      },
    ]);
    expect(JSON.parse(n8n['wrangler.json']).containers).toEqual([
      {
        class_name: 'N8n',
        image: 'docker.io/n8nio/n8n:2.46.3',
        instance_type: 'basic',
        max_instances: 1,
      },
    ]);
    // Nothing to build: Cloudflare pulls the image.
    for (const [files, framework] of [
      [umami, 'umami'],
      [n8n, 'n8n'],
    ] as const) {
      expect(files['Dockerfile']).toBeUndefined();
      const plan = repositoryPlan(
        { ...files, 'package-lock.json': '{}' },
        framework,
      );
      expect(plan.issues).toEqual([]);
      expect(plan.adapter).toBe('container');
    }
    const database =
      'postgresql://ada:p%40ss@db.example.com:6543/apps?sslmode=require';
    // Umami reads its database and secret from the Worker's secrets.
    const u = await containerWorker(umami);
    const uEnv = containerEnv(u, 'Umami', 'UMAMI', {
      DATABASE_URL: database,
      APP_SECRET: 's'.repeat(40),
    });
    expect(
      await (
        await u.default.fetch(
          new Request('https://stats.example.workers.dev/script.js'),
          uEnv,
        )
      ).json(),
    ).toMatchObject({
      port: 3000,
      envVars: {
        DATABASE_URL: database,
        APP_SECRET: 's'.repeat(40),
        DISABLE_TELEMETRY: '1',
      },
    });
    // n8n gets the same database as its own settings, its key, and its public address.
    const n = await containerWorker(n8n);
    const nEnv = containerEnv(n, 'N8n', 'N8N', {
      DATABASE_URL: database,
      N8N_ENCRYPTION_KEY: 'k'.repeat(40),
    });
    expect(
      await (
        await n.default.fetch(
          new Request('https://flows.example.workers.dev/home'),
          nEnv,
        )
      ).json(),
    ).toMatchObject({
      port: 5678,
      envVars: {
        DB_TYPE: 'postgresdb',
        DB_POSTGRESDB_HOST: 'db.example.com',
        DB_POSTGRESDB_PORT: '6543',
        DB_POSTGRESDB_DATABASE: 'apps',
        DB_POSTGRESDB_USER: 'ada',
        DB_POSTGRESDB_PASSWORD: 'p@ss',
        DB_POSTGRESDB_SSL_ENABLED: 'true',
        N8N_ENCRYPTION_KEY: 'k'.repeat(40),
        WEBHOOK_URL: 'https://flows.example.workers.dev/',
        N8N_PROXY_HOPS: '1',
      },
    });
    // Until its secrets are set, a service starts nothing and says what to set.
    for (const [module, className, binding] of [
      [u, 'Umami', 'UMAMI'],
      [n, 'N8n', 'N8N'],
    ] as const) {
      const missing = await module.default.fetch(
        new Request('https://app.example.workers.dev/'),
        containerEnv(module, className, binding, {}),
      );
      expect(missing.status).toBe(503);
      expect(await missing.text()).toContain('DATABASE_URL');
    }
    // What each service needs, in its README.
    expect(umami['README.md']).toContain('change the password');
    expect(n8n['README.md']).toContain('owner account');
  });

  it('runs WordPress in a container, with MySQL elsewhere and its uploads and email through the Worker', async () => {
    const files = generateKit({
      ...base,
      framework: 'wordpress',
      freeOnly: false,
    });
    expect(JSON.parse(files['wrangler.json'])).toMatchObject({
      containers: [
        {
          class_name: 'WordPress',
          image: './Dockerfile',
          instance_type: 'basic',
          max_instances: 1,
        },
      ],
      durable_objects: {
        bindings: [{ name: 'WORDPRESS', class_name: 'WordPress' }],
      },
      r2_buckets: [{ binding: 'UPLOADS' }],
      send_email: [{ name: 'EMAIL' }],
    });
    expect(files['Dockerfile']).toMatch(
      /^FROM wordpress:7\.1\.4-php8\.4-apache$/m,
    );
    expect(files['wp-content/mu-plugins/shipcel.php']).toContain(
      'uploads.shipcel.internal',
    );
    expect(files['wp-content/mu-plugins/shipcel.php']).toContain('pre_wp_mail');
    for (const folder of ['themes', 'plugins'])
      expect(files[`wp-content/${folder}/README.md`]).toBeTruthy();
    const plan = repositoryPlan(
      { ...files, 'package-lock.json': '{}' },
      'wordpress',
    );
    expect(plan.issues).toEqual([]);
    expect(plan.adapter).toBe('container');
    expect(plan.warnings.join(' ')).toContain('Email Service');
    // Email Service bindings are reviewed by name only.
    const config = JSON.parse(files['wrangler.json']);
    expect(
      repositoryPlan(
        {
          ...files,
          'package-lock.json': '{}',
          'wrangler.json': JSON.stringify({
            ...config,
            send_email: [{ name: 'EMAIL', destination_address: 'a@b.example' }],
          }),
        },
        'wordpress',
      ).issues.join(' '),
    ).toContain('send_email');

    const worker = await containerWorker(files);
    const objects = new Map<string, { body: string; type?: string }>();
    const sent: Record<string, unknown>[] = [];
    const secrets = {
      DATABASE_URL: 'mysql://ada:p%40ss@mysql.example.com/blog',
      WP_SECRET: 'w'.repeat(40),
      WP_MAIL_FROM: 'blog@example.com',
    };
    const env = containerEnv(worker, 'WordPress', 'WORDPRESS', secrets);
    env.UPLOADS = {
      async put(
        key: string,
        body: ReadableStream | string,
        options?: { httpMetadata?: { contentType?: string } },
      ) {
        objects.set(key, {
          body: await new Response(body).text(),
          type: options?.httpMetadata?.contentType,
        });
      },
      async get(key: string) {
        const found = objects.get(key);
        return found
          ? {
              body: new Response(found.body).body,
              httpEtag: '"e1"',
              writeHttpMetadata: (headers: Headers) =>
                found.type && headers.set('Content-Type', found.type),
            }
          : null;
      },
      async delete(key: string) {
        objects.delete(key);
      },
    };
    env.EMAIL = {
      send: async (message: Record<string, unknown>) => void sent.push(message),
    };
    // The container is started with the database, eight keys from one secret, and its address.
    const started = (await (
      await worker.default.fetch(
        new Request('https://blog.example.workers.dev/wp-admin/'),
        env,
      )
    ).json()) as { port: number; envVars: Record<string, string> };
    expect(started.port).toBe(80);
    expect(started.envVars).toMatchObject({
      WORDPRESS_DB_HOST: 'mysql.example.com:3306',
      WORDPRESS_DB_USER: 'ada',
      WORDPRESS_DB_PASSWORD: 'p@ss',
      WORDPRESS_DB_NAME: 'blog',
    });
    const keys = Object.keys(started.envVars).filter((k) =>
      /_(KEY|SALT)$/.test(k),
    );
    expect(keys).toHaveLength(8);
    for (const k of keys) expect(started.envVars[k]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(keys.map((k) => started.envVars[k])).size).toBe(8);
    expect(started.envVars.WORDPRESS_CONFIG_EXTRA).toContain(
      "define('WP_HOME', 'https://blog.example.workers.dev');",
    );
    expect(started.envVars.WORDPRESS_CONFIG_EXTRA).toContain(
      'MYSQLI_CLIENT_SSL',
    );
    expect(started.envVars.WORDPRESS_CONFIG_EXTRA).toContain(
      'DISALLOW_FILE_MODS',
    );
    // The same secret gives the same keys every time the container starts.
    const again = (await (
      await worker.default.fetch(
        new Request('https://blog.example.workers.dev/'),
        containerEnv(worker, 'WordPress', 'WORDPRESS', secrets),
      )
    ).json()) as { envVars: Record<string, string> };
    for (const k of keys) expect(again.envVars[k]).toBe(started.envVars[k]);
    // The container's uploads go to R2 through the Worker, and come back from it.
    const handlers = (
      worker.WordPress as {
        outboundByHost: Record<
          string,
          (r: Request, e: unknown) => Promise<Response>
        >;
      }
    ).outboundByHost;
    const store = handlers['uploads.shipcel.internal'];
    expect(
      (
        await store(
          new Request('http://uploads.shipcel.internal/2026/10/photo%201.jpg', {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: 'jpeg-bytes',
          }),
          env,
        )
      ).status,
    ).toBe(204);
    expect(objects.get('2026/10/photo 1.jpg')).toEqual({
      body: 'jpeg-bytes',
      type: 'image/jpeg',
    });
    expect(
      await (
        await store(
          new Request('http://uploads.shipcel.internal/2026/10/photo%201.jpg'),
          env,
        )
      ).text(),
    ).toBe('jpeg-bytes');
    // (A URL's own `..` segments are gone before the Worker sees the path.)
    for (const bad of ['..%2Fwp-config.php', '', 'a//b', '.%2Fx'])
      expect(
        (
          await store(
            new Request(`http://uploads.shipcel.internal/${bad}`, {
              method: 'PUT',
              body: 'x',
            }),
            env,
          )
        ).status,
      ).toBe(400);
    // Visitors get uploads from R2 without waking the container.
    const served = await worker.default.fetch(
      new Request(
        'https://blog.example.workers.dev/wp-content/uploads/2026/10/photo%201.jpg',
      ),
      env,
    );
    expect(served.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await served.text()).toBe('jpeg-bytes');
    expect(
      (
        await worker.default.fetch(
          new Request(
            'https://blog.example.workers.dev/wp-content/uploads/none.png',
          ),
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await store(
          new Request('http://uploads.shipcel.internal/2026/10/photo%201.jpg', {
            method: 'DELETE',
          }),
          env,
        )
      ).status,
    ).toBe(204);
    expect(objects.size).toBe(0);
    // wp_mail goes out through Cloudflare's Email Service, from the address the owner set.
    const mail = handlers['mail.shipcel.internal'];
    expect(
      (
        await mail(
          new Request('http://mail.shipcel.internal/send', {
            method: 'POST',
            body: JSON.stringify({
              to: ['ada@example.com'],
              subject: 'Hello',
              text: 'Welcome',
            }),
          }),
          env,
        )
      ).status,
    ).toBe(204);
    expect(sent).toEqual([
      {
        from: 'blog@example.com',
        to: ['ada@example.com'],
        subject: 'Hello',
        text: 'Welcome',
      },
    ]);
    expect(
      (
        await mail(
          new Request('http://mail.shipcel.internal/send', {
            method: 'POST',
            body: '{}',
          }),
          { ...env, WP_MAIL_FROM: undefined },
        )
      ).status,
    ).toBe(503);
    // Without its database and secret it starts nothing.
    const unset = await worker.default.fetch(
      new Request('https://blog.example.workers.dev/'),
      containerEnv(worker, 'WordPress', 'WORDPRESS', {}),
    );
    expect(unset.status).toBe(503);
    expect(await unset.text()).toContain('WP_SECRET');
    expect(files['README.md']).toContain('Experimental');
  });

  it('keeps containers and services out of Free-only projects', () => {
    for (const framework of ['docker', 'umami', 'n8n', 'wordpress'])
      expect(
        projectSchema.safeParse({ ...input, framework, freeOnly: true })
          .success,
      ).toBe(false);
  });

  it('gives the Next.js kit OpenNext’s cache: in R2 with Durable Objects, or in its own files when Free-only', () => {
    const files = (freeOnly: boolean, storage = false) =>
      generateKit({ ...base, framework: 'nextjs', freeOnly, storage });
    const config = (f: Record<string, string>) =>
      JSON.parse(f['wrangler.json']);
    const paid = files(false);
    expect(config(paid)).toMatchObject({
      r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET' }],
      durable_objects: {
        bindings: [
          { name: 'NEXT_CACHE_DO_QUEUE', class_name: 'DOQueueHandler' },
          {
            name: 'NEXT_TAG_CACHE_DO_SHARDED',
            class_name: 'DOShardedTagCache',
          },
        ],
      },
      migrations: [
        {
          tag: 'v1',
          new_sqlite_classes: ['DOQueueHandler', 'DOShardedTagCache'],
        },
      ],
    });
    expect(paid['open-next.config.ts']).toContain(
      'withRegionalCache(r2IncrementalCache',
    );
    expect(paid['open-next.config.ts']).toContain('queue: doQueue');
    // The project's own bucket comes after the cache's, not in its place.
    expect(config(files(false, true)).r2_buckets).toEqual([
      { binding: 'NEXT_INC_CACHE_R2_BUCKET' },
      { binding: 'FILES' },
    ]);
    // Free-only: R2 can bill, so the prerendered pages go up with the app's files instead.
    const free = files(true);
    expect(config(free).r2_buckets).toBeUndefined();
    expect(config(free).durable_objects).toBeUndefined();
    expect(free['open-next.config.ts']).toContain(
      'staticAssetsIncrementalCache',
    );
    // Both pass the review a deploy from the folder gets, and say which cache it fills.
    for (const [kitFiles, cache] of [
      [paid, 'r2'],
      [free, 'static-assets'],
    ] as const) {
      const plan = repositoryPlan(kitFiles, 'nextjs', { local: true });
      expect(plan.issues).toEqual([]);
      expect(plan.openNextCache).toBe(cache);
    }
  });
  it('starts Astro, SvelteKit, Next.js and Python apps the way their import adapters expect', () => {
    const kit = (framework: Project['framework']) =>
      generateKit({ ...base, framework });
    const config = (files: Record<string, string>) =>
      JSON.parse(files['wrangler.json'] ?? files['wrangler.jsonc']);
    const astro = kit('astro');
    expect(astro['astro.config.mjs']).toContain('adapter: cloudflare()');
    expect(config(astro).main).toBe('@astrojs/cloudflare/entrypoints/server');
    expect(JSON.parse(astro['package.json']).dependencies).toMatchObject({
      astro: '7.4.4',
      '@astrojs/cloudflare': '14.4.3',
    });
    expect(astro['src/pages/index.astro']).toContain('test-app');
    expect(astro['src/pages/api/health.js']).toContain('GET');
    const svelte = kit('sveltekit');
    expect(svelte['vite.config.js']).toContain(
      'sveltekit({ adapter: adapter() })',
    );
    expect(config(svelte)).toMatchObject({
      main: '.svelte-kit/cloudflare/_worker.js',
      assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
    });
    expect(svelte['src/routes/+page.svelte']).toContain('test-app');
    expect(svelte['src/routes/api/health/+server.js']).toContain('GET');
    const next = kit('nextjs');
    // OpenNext binds the Worker to itself under the name it deploys with.
    expect(config(next)).toMatchObject({
      main: '.open-next/worker.js',
      services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'test-app' }],
      assets: { directory: '.open-next/assets', binding: 'ASSETS' },
    });
    expect(next['open-next.config.ts']).toContain('defineCloudflareConfig');
    expect(next['next.config.mjs']).toContain('initOpenNextCloudflareForDev');
    // Next.js 16.4.1 fixes the critical advisories of 22 Oct 2026; OpenNext runs it from 1.20.12.
    expect(JSON.parse(next['package.json']).dependencies).toMatchObject({
      next: '16.4.3',
      '@opennextjs/cloudflare': '1.20.15',
    });
    // OpenNext's minifier holds back glob 10.4.5 (GHSA-5j98-mcp5-4vw2): the kit pins the fix.
    expect(JSON.parse(next['package.json']).overrides).toEqual({
      '@node-minify/core': { glob: '^10.5.0' },
    });
    expect(JSON.parse(astro['package.json']).overrides).toBeUndefined();
    expect(JSON.parse(next['package.json']).scripts.deploy).toBe(
      'opennextjs-cloudflare build && opennextjs-cloudflare deploy',
    );
    expect(next['app/page.jsx']).toContain('test-app');
    expect(next['app/api/health/route.js']).toContain('GET');
    const python = kit('python');
    expect(config(python)).toMatchObject({
      main: 'src/entry.py',
      compatibility_flags: ['python_workers'],
    });
    expect(python['src/entry.py']).toContain('WorkerEntrypoint');
    // From compatibility date 2026-04-21 the `workers` module comes from workers-py,
    // which pywrangler vendors; pywrangler reads only wrangler.jsonc or wrangler.toml.
    expect(python['wrangler.json']).toBeUndefined();
    expect(python['pyproject.toml']).toContain('dependencies = []');
    expect(python['pyproject.toml']).toContain('"workers-py"');
    expect(python['pyproject.toml']).toContain('"workers-runtime-sdk"');
    expect(JSON.parse(python['package.json'])).toMatchObject({
      devDependencies: { wrangler: '4.156.0' },
      scripts: {
        dev: 'uv run pywrangler dev',
        deploy: 'uv run pywrangler deploy',
      },
    });
    expect(python['scripts/check-config.mjs']).toContain('wrangler.jsonc');
    expect(python['.gitignore']).toContain('python_modules/');
    expect(python['.gitignore']).toContain('.venv-workers/');
    expect(python['README.md']).toContain('uv lock');
    for (const files of [astro, svelte, next, python])
      expect(files['README.md']).toContain('npm run dev');
    // Build output and caches stay out of the repository.
    expect(astro['.gitignore']).toContain('.astro/');
    expect(svelte['.gitignore']).toContain('.svelte-kit/');
    expect(next['.gitignore']).toContain('.open-next/');
    expect(python['.gitignore']).toContain('__pycache__/');
    // Each README explains what is particular about its framework on Cloudflare.
    expect(astro['README.md']).toContain('## Astro on Cloudflare');
    expect(astro['README.md']).toContain('`SESSION`');
    expect(next['README.md']).toContain('incremental cache');
    expect(svelte['README.md']).toContain('Vite plugin');
    expect(python['README.md']).toContain('pywrangler');
    for (const files of [astro, svelte, next])
      expect(files['README.md']).toContain('`npm run preview`');
    // Kits with a database say how to reach it.
    expect(
      generateKit({ ...base, framework: 'python', database: true })[
        'src/entry.py'
      ],
    ).toContain('self.env.DB');
  });
  it('refuses unverified runtime kits', () => {
    for (const framework of frameworks.filter((f) => !hasKit(f.id)))
      expect(() => generateKit({ ...base, framework: framework.id })).toThrow(
        'not ready',
      );
  });
  it('declares draft database/storage bindings without credentials or adopted resource IDs', () => {
    const files = generateKit({ ...base, database: true, storage: true });
    const config = JSON.parse(files['wrangler.json']);
    expect(config.d1_databases).toEqual([
      { binding: 'DB', migrations_dir: 'migrations' },
    ]);
    expect(config.r2_buckets).toEqual([{ binding: 'FILES' }]);
    expect(files['scripts/check-config.mjs']).toContain('process.exit(1)');
    expect(files['migrations/0001_initial.sql']).toContain('CREATE TABLE');
    expect(files['README.md']).not.toContain('REPLACE_WITH');
    expect(config).not.toHaveProperty('account_id');
  });
  it('adds a manual D1 backup workflow only to kits with a database', () => {
    const withDatabase = generateKit({ ...base, database: true });
    const workflow = withDatabase['docs/backup.workflow.yml'];
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('wrangler d1 export');
    expect(workflow).toContain('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workflow).toMatch(/#\s+schedule:/);
    expect(workflow).not.toContain('pull_request');
    expect(withDatabase['README.md']).toContain('backup.workflow.yml');
    expect(generateKit(base)['docs/backup.workflow.yml']).toBeUndefined();
  });
  it('generates kits that the native repository import accepts as committed', () => {
    for (const framework of frameworks.filter((f) => hasKit(f.id))) {
      const resources = allowsBindings(framework.id);
      const files = generateKit({
        ...base,
        framework: framework.id,
        database: resources,
        storage: resources,
      });
      // Users commit the lockfiles their first npm install and uv lock produce.
      const plan = repositoryPlan(
        {
          ...files,
          'package-lock.json': '{"lockfileVersion":3}',
          ...(framework.id === 'python' ? { 'uv.lock': 'version = 1' } : {}),
        },
        framework.id,
      );
      expect(plan.issues, framework.id).toEqual([]);
      expect(plan.adapter, framework.id).toBe(
        framework.id === 'python'
          ? 'python-packages'
          : ['astro', 'sveltekit', 'nextjs'].includes(framework.id)
            ? framework.id
            : usesContainers(framework.id)
              ? 'container'
              : 'configured-worker',
      );
      const drafts = plan.resources.filter((r) => !('source' in r));
      expect(drafts, framework.id).toEqual(
        resources
          ? [
              { type: 'd1', binding: 'DB' },
              { type: 'r2', binding: 'FILES' },
            ]
          : framework.id === 'postgres'
            ? [{ type: 'hyperdrive', binding: 'DB', id: 'HYPERDRIVE_ID' }]
            : framework.id === 'wordpress'
              ? [{ type: 'r2', binding: 'UPLOADS' }]
              : [],
      );
    }
  });
  it('starts a Postgres API on Hyperdrive, with the configuration id left for the person to add', () => {
    const files = generateKit({ ...base, framework: 'postgres' });
    const config = JSON.parse(files['wrangler.json']);
    expect(config.hyperdrive).toEqual([
      {
        binding: 'DB',
        id: 'HYPERDRIVE_ID',
        // Wrangler's local runtime needs a database of its own; the placeholder is one.
        localConnectionString:
          'postgres://postgres:postgres@127.0.0.1:5432/postgres',
      },
    ]);
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config.d1_databases).toBeUndefined();
    const pkg = JSON.parse(files['package.json']);
    expect(pkg.dependencies.postgres).toMatch(/^\d/);
    expect(pkg.dependencies.hono).toMatch(/^\d/);
    expect(files['src/worker.js']).toContain('c.env.DB.connectionString');
    expect(files['src/worker.js']).toContain("'/api/health'");
    // The deploy check refuses the placeholder; the README says where the id comes from.
    expect(files['scripts/check-config.mjs']).toContain('HYPERDRIVE_ID');
    expect(files['README.md']).toContain('shipcel hyperdrive add DB');
    expect(files['README.md']).toContain('Manage → Database');
    expect(files['README.md']).not.toContain('No SQL database selected');
    // With the configuration added to the project, the export carries its id.
    const added = generateKit(
      { ...base, framework: 'postgres' },
      { hyperdrive: [{ binding: 'DB', id: 'a'.repeat(32) }] },
    );
    expect(JSON.parse(added['wrangler.json']).hyperdrive[0].id).toBe(
      'a'.repeat(32),
    );
  });
  it('routes API requests to the Worker before SPA fallback', () => {
    const config = generateConfig(base);
    expect(config.assets).toMatchObject({
      run_worker_first: ['/api/*'],
      not_found_handling: 'single-page-application',
    });
  });
});

describe('local alpha API guard', () => {
  it('refuses public hosts without relying on a configuration flag', async () => {
    expect(
      (await app.request('https://shipcel.example/api/projects')).status,
    ).toBe(403);
  });
  it('refuses localhost lookalike hosts', async () => {
    expect(
      (await app.request('http://localhost.evil.test/api/projects')).status,
    ).toBe(403);
  });
  it('refuses cross-origin reads and writes', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(
        (
          await app.request('http://localhost/api/projects', {
            method,
            headers: { Origin: 'https://evil.test' },
          })
        ).status,
      ).toBe(403);
    }
  });
  it('refuses cross-site requests when Origin is missing', async () => {
    expect(
      (
        await app.request('http://localhost/api/status', {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
  });
  it('refuses opaque null origins', async () => {
    expect(
      (
        await app.request('http://localhost/api/status', {
          headers: { Origin: 'null' },
        })
      ).status,
    ).toBe(403);
  });
  it('returns accurate capabilities on the same local origin', async () => {
    const response = await app.request('http://127.0.0.1:5173/api/status', {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cloudflareConnected: false,
      deploymentEnabled: false,
    });
  });
  it('rejects non-JSON create requests', async () => {
    expect(
      (
        await app.request('http://localhost/api/projects', {
          method: 'POST',
          body: 'name=test',
        })
      ).status,
    ).toBe(415);
  });
  it('rejects malformed or invalid JSON before accessing storage', async () => {
    for (const body of ['{', JSON.stringify({ ...input, name: '../x' })]) {
      expect(
        (
          await app.request('http://localhost/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        ).status,
      ).toBe(400);
    }
  });
  it('bounds request sizes', async () => {
    const response = await app.request('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(9000) }),
    });
    expect(response.status).toBe(413);
  });
  it('does not disclose internal errors or credentials', async () => {
    const response = await app.request('http://localhost/api/projects');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('TypeError');
  });
});

describe('project names from repositories', () => {
  it.each([
    ['landing', 'landing'],
    ['My_Cool.Repo', 'my-cool-repo'],
    ['--Royal--Protocol--', 'royal-protocol'],
    ['2026-site', 'app-2026-site'],
    ['ab', 'ab-app'],
    ['.github', 'github'],
    ['日本', 'app'],
    ['x'.repeat(60), 'x'.repeat(48)],
    [`a${'-b'.repeat(30)}`, `a${'-b'.repeat(23)}`],
  ])('names a project after %s', (repository, name) => {
    expect(projectNameFrom(repository)).toBe(name);
    expect(projectSchema.safeParse({ ...input, name }).success).toBe(true);
  });
});

describe('project sources', () => {
  it('returns where each project starts', async () => {
    const db = database();
    try {
      const who = await db.user(1);
      const created = await db.request(
        '/projects',
        {
          method: 'POST',
          body: JSON.stringify({
            ...input,
            name: 'from-github',
            source: 'github',
            repository: 'https://github.com/alice/sample',
          }),
        },
        who.cookie,
      );
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        source: 'github',
        repository: 'https://github.com/alice/sample',
      });
      await db.request(
        '/projects',
        {
          method: 'POST',
          body: JSON.stringify({ ...input, name: 'from-kit' }),
        },
        who.cookie,
      );
      const listed = (await (
        await db.request('/projects', {}, who.cookie)
      ).json()) as Project[];
      expect(Object.fromEntries(listed.map((p) => [p.name, p.source]))).toEqual(
        { 'from-github': 'github', 'from-kit': 'kit' },
      );
    } finally {
      db.close();
    }
  });
  it('exports starter kits only for projects that start from one', async () => {
    const db = database();
    try {
      const who = await db.user(1);
      const created = (await (
        await db.request(
          '/projects',
          {
            method: 'POST',
            body: JSON.stringify({
              ...input,
              name: 'from-github',
              repository: 'https://github.com/alice/sample',
            }),
          },
          who.cookie,
        )
      ).json()) as Project;
      const exported = await db.request(
        `/projects/${created.id}/export`,
        { method: 'POST' },
        who.cookie,
      );
      expect(exported.status).toBe(409);
      expect(((await exported.json()) as { error: string }).error).toContain(
        'GitHub repository',
      );
      expect(
        (await db.request(`/projects/${created.id}/config`, {}, who.cookie))
          .status,
      ).toBe(409);
    } finally {
      db.close();
    }
  });
  it('treats existing projects that name a repository as GitHub projects', () => {
    const sqlite = new DatabaseSync(':memory:');
    const files = readdirSync('migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const added = files.findIndex((f) => f.startsWith('0026_'));
    expect(added).toBeGreaterThan(0);
    for (const file of files.slice(0, added))
      sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
    const insert = sqlite.prepare(
      "INSERT INTO projects (id, name, framework, repository, database_enabled, storage_enabled, free_only, created_at, workspace_id) VALUES (?, ?, 'react', ?, 0, 0, 1, '2026-10-08T00:00:00Z', 'local')",
    );
    insert.run('a', 'linked', 'https://github.com/alice/sample');
    insert.run('b', 'exported', '');
    for (const file of files.slice(added))
      sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
    expect(
      sqlite.prepare('SELECT name, source FROM projects ORDER BY id').all(),
    ).toEqual([
      { name: 'linked', source: 'github' },
      { name: 'exported', source: 'kit' },
    ]);
    sqlite.close();
  });
});
