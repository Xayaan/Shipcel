import { describe, expect, it } from 'vitest';
import {
  detectFramework,
  previewsBlock,
  previewsBlockIssues,
  repositoryPlan,
} from '../worker/repository-plan';

// More of Cloudflare's free platform in repository imports: bindings that touch no shared
// data (Workers AI, browser rendering, Images, version metadata), plain variables, Smart
// Placement, cron schedules, and SQLite-backed Durable Objects in the app's own Worker.
const files = (config: Record<string, unknown>, framework?: string) =>
  repositoryPlan(
    {
      'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
      'package-lock.json': '{}',
      'wrangler.json': JSON.stringify({
        name: 'my-app',
        main: 'src/index.js',
        compatibility_date: '2026-10-07',
        ...config,
      }),
    },
    framework,
  );
const issues = (config: Record<string, unknown>) =>
  files(config).issues.join(' ');

describe('Cloudflare products in repository imports', () => {
  it('accepts Workers AI, browser rendering, Images, version metadata, variables and Smart Placement', () => {
    const plan = files({
      ai: { binding: 'AI' },
      browser: { binding: 'BROWSER' },
      images: { binding: 'IMAGES' },
      version_metadata: { binding: 'VERSION' },
      vars: { MODE: 'production', RETRIES: 3, DEBUG: false },
      placement: { mode: 'smart' },
    });
    expect(plan.issues).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('Workers AI');
  });

  it('refuses settings that reach other accounts or data, or that it does not review', () => {
    expect(issues({ ai: { binding: 'AI', remote: true } })).toContain('ai');
    expect(issues({ vars: { NESTED: { a: 1 } } })).toContain('vars');
    expect(issues({ placement: { region: 'aws:us-east-1' } })).toContain(
      'placement',
    );
    expect(issues({ placement: { mode: 'smart', hint: 'wnam' } })).toContain(
      'placement',
    );
    expect(issues({ placement: { mode: 'regional' } })).toContain('placement');
    expect(issues({ queues: { producers: [{ binding: 'Q' }] } })).toContain(
      'Unsupported Wrangler settings',
    );
    // Binding names stay unique across every kind of binding.
    expect(
      issues({ ai: { binding: 'DB' }, d1_databases: [{ binding: 'db' }] }),
    ).toContain('unique');
    expect(issues({ ai: { binding: 'MODE' }, vars: { mode: 'x' } })).toContain(
      'unique',
    );
  });

  it('accepts cron schedules, up to the five a free account allows', () => {
    const plan = files({
      triggers: { crons: ['*/30 * * * *', '0 9 * * MON-FRI'] },
    });
    expect(plan.issues).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('5 cron');
    expect(
      issues({ triggers: { crons: Array(6).fill('* * * * *') } }),
    ).toContain('crons');
    expect(issues({ triggers: { crons: ['every minute'] } })).toContain(
      'crons',
    );
    expect(issues({ triggers: { crons: [], other: 1 } })).toContain('crons');
  });

  it('accepts SQLite-backed Durable Objects in the app’s own Worker', () => {
    const plan = files({
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
    });
    expect(plan.issues).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('Durable Objects');
  });

  it('refuses Durable Objects the free plan or this adapter cannot run safely', () => {
    // Key-value storage classes need Workers Paid.
    expect(
      issues({
        durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
        migrations: [{ tag: 'v1', new_classes: ['Room'] }],
      }),
    ).toContain('key-value storage (new_classes) needs Workers Paid');
    // Another Worker's namespace.
    expect(
      issues({
        durable_objects: {
          bindings: [
            { name: 'ROOMS', class_name: 'Room', script_name: 'other' },
          ],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
      }),
    ).toContain('another Worker');
    // A bound class that no migration creates.
    expect(
      issues({
        durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      }),
    ).toContain('Room');
    // Moving another Worker's stored data.
    expect(
      issues({
        durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
        migrations: [
          {
            tag: 'v1',
            transferred_classes: [
              { from: 'Room', from_script: 'other', to: 'Room' },
            ],
          },
        ],
      }),
    ).toContain('transfer');
  });

  it('warns that deleting a Durable Object class deletes its data', () => {
    const plan = files({
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['Room', 'Old'] },
        { tag: 'v2', deleted_classes: ['Old'] },
      ],
    });
    expect(plan.issues).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('permanently deletes');
  });
});

describe('previews for these apps', () => {
  it('carries stateless bindings, variables and Durable Objects into the previews block', () => {
    const plan = files({
      ai: { binding: 'AI' },
      browser: { binding: 'BROWSER' },
      vars: { MODE: 'production' },
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }],
    });
    const block = previewsBlock([], 'configured-worker', plan.previewBindings);
    expect(block).toEqual({
      ai: { binding: 'AI' },
      browser: { binding: 'BROWSER' },
      vars: { MODE: 'production' },
      // Each Preview gets its own namespace and storage for these classes.
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
    });
    expect(previewsBlockIssues(block, [])).toEqual([]);
  });

  it('refuses a previews Durable Object binding to another Worker', () => {
    expect(
      previewsBlockIssues(
        {
          durable_objects: {
            bindings: [
              { name: 'ROOMS', class_name: 'Room', script_name: 'production' },
            ],
          },
        },
        [],
      ).join(' '),
    ).toContain('durable_objects');
  });
});

describe('Next.js versions OpenNext runs', () => {
  // A repository after `wrangler setup`, with the versions npm locked.
  const nextPlan = (
    next: string,
    openNext: string,
    extra: Record<string, string> = {},
    local = false,
  ) =>
    repositoryPlan(
      {
        ...extra,
        'package.json': JSON.stringify({
          scripts: { build: 'next build' },
          dependencies: { next, '@opennextjs/cloudflare': openNext },
        }),
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': {},
            'node_modules/next': { version: next },
            'node_modules/@opennextjs/cloudflare': { version: openNext },
          },
        }),
        'wrangler.jsonc': JSON.stringify({
          name: 'my-next',
          main: '.open-next/worker.js',
          compatibility_date: '2026-10-07',
          assets: { directory: '.open-next/assets', binding: 'ASSETS' },
          services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'my-next' }],
        }),
        'open-next.config.ts':
          "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\nexport default defineCloudflareConfig({});\n",
      },
      'nextjs',
      { local },
    );
  it('warns that OpenNext before 1.20.13 fails at request time with Next.js 16.4', () => {
    // 1.20.9, 1.20.10 and 1.20.11 were each run, and 1.20.13 ran 16.4.2; 1.20.12 wasn't tried.
    for (const openNext of ['1.20.9', '1.20.10', '1.20.11', '1.20.12']) {
      const plan = nextPlan('16.4.0', openNext);
      expect(plan.issues).toEqual([]);
      expect(plan.warnings.join(' ')).toContain('preview-props.json');
      expect(plan.warnings.join(' ')).toContain('OpenNext 1.20.13 runs it');
      expect(plan.warnings.join(' ')).not.toContain('16.3.8');
    }
  });
  it('stays quiet about it before Next.js 16.4, and from OpenNext 1.20.13 on', () => {
    for (const [next, openNext] of [
      ['16.3.8', '1.20.9'],
      ['16.3.8', '1.20.10'],
      ['16.3.8', '1.20.11'],
      ['16.4.2', '1.20.13'],
      ['16.4.2', '1.20.30'],
      ['16.4.0', '1.21.0'],
      ['16.4.0', '2.0.0'],
      ['15.5.27', '1.20.9'],
    ])
      for (const local of [false, true]) {
        const plan = nextPlan(next, openNext, {}, local);
        expect(
          [...plan.issues, ...plan.warnings].join(' '),
          `${next} + ${openNext}`,
        ).not.toContain('preview-props.json');
      }
  });
  it('stops a folder whose Next.js version or settings OpenNext can’t run, before it deploys', () => {
    // From a computer the fix takes a minute, and a deploy would answer errors.
    const version = nextPlan('16.4.0', '1.20.10', {}, true);
    expect(version.issues).toEqual([
      'OpenNext 1.20.10 builds Next.js 16.4.0, but every request then fails with "Unexpected loadManifest(/.next/server/preview-props.json) call!". OpenNext 1.20.13 runs it: update OpenNext (npm install @opennextjs/cloudflare@latest).',
    ]);
    // Cache Components, which new Next.js apps turn on: a request never gets an answer.
    const config = (body: string) => ({
      'next.config.ts': `const nextConfig = {\n${body}\n};\nexport default nextConfig;\n`,
    });
    const cached = nextPlan(
      '16.3.8',
      '1.20.10',
      config('  cacheComponents: true,'),
      true,
    );
    expect(cached.issues).toEqual([
      'next.config turns on cacheComponents, and with OpenNext 1.20.10 a request then never gets an answer on Cloudflare. Remove cacheComponents until an OpenNext release supports it.',
    ]);
    expect(
      nextPlan('16.4.0', '1.20.10', config('  cacheComponents : true'), true)
        .issues,
    ).toHaveLength(2);
    // Still so with OpenNext 1.20.13 and Next.js 16.4.2 (run 23 Oct 2026).
    expect(
      nextPlan('16.4.2', '1.20.13', config('  cacheComponents: true,'), true)
        .issues,
    ).toEqual([
      'next.config turns on cacheComponents, and with OpenNext 1.20.13 a request then never gets an answer on Cloudflare. Remove cacheComponents until an OpenNext release supports it.',
    ]);
    // The new template's other setting needs it, so it is named too.
    expect(
      nextPlan(
        '16.3.8',
        '1.20.10',
        config('  cacheComponents: true,\n  partialPrefetching: true,'),
        true,
      ).issues,
    ).toEqual([
      'next.config turns on cacheComponents, and with OpenNext 1.20.10 a request then never gets an answer on Cloudflare. Remove cacheComponents (and partialPrefetching, which needs it) until an OpenNext release supports it.',
    ]);
    // Off, commented out, another file's name for it, or an OpenNext that may have fixed it.
    for (const [body, openNext] of [
      ['  cacheComponents: false,', '1.20.10'],
      ['  // cacheComponents: true,', '1.20.10'],
      ['  /* cacheComponents: true, */', '1.20.10'],
      ['  xcacheComponents: true,', '1.20.10'],
      ['  cacheComponents: true,', '1.21.0'],
    ])
      expect(
        [body, nextPlan('16.3.8', openNext, config(body), true).issues],
        body,
      ).toEqual([body, []]);
    // In a repository's review both are notes, as before.
    const repository = nextPlan(
      '16.4.0',
      '1.20.10',
      config('  cacheComponents: true,'),
    );
    expect(repository.issues).toEqual([]);
    expect(repository.warnings.join(' ')).toContain('cacheComponents');
    // The JavaScript forms of the file are read too.
    for (const name of ['next.config.mjs', 'next.config.js'])
      expect(
        nextPlan(
          '16.3.8',
          '1.20.10',
          { [name]: 'export default { cacheComponents: true };' },
          true,
        ).issues,
      ).toHaveLength(1);
  });
  it('names the fixed release for Next.js versions with the critical advisories of 22 Oct 2026', () => {
    for (const [next, fixed, install] of [
      ['16.4.0', '16.4.1', '16.4'],
      ['16.3.8', '16.4.1', '16.4'],
      ['16.0.0', '16.4.1', '16.4'],
      ['15.5.27', '15.5.28', '15.5'],
      ['14.2.30', '15.5.28', '15.5'],
      ['10.0.0', '15.5.28', '15.5'],
    ]) {
      const advisory = `Next.js ${next} has critical security advisories (GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr: remote code execution). Next.js ${fixed} fixes them`;
      const repository = nextPlan(next, '1.20.13');
      expect(repository.warnings, next).toContain(`${advisory}.`);
      expect(repository.issues, next).toEqual([]);
      // From a computer, with the command that installs it; the deploy isn't stopped for it.
      const folder = nextPlan(next, '1.20.13', {}, true);
      expect(folder.warnings, next).toContain(
        `${advisory} (npm install next@${install}).`,
      );
    }
    for (const next of ['16.4.1', '16.4.2', '15.5.28', '9.5.5'])
      expect(nextPlan(next, '1.20.13').warnings.join(' '), next).not.toContain(
        'security advisories',
      );
  });
});

// New projects from GitHub start with the runtime their repository uses; people can change it.
describe('runtime detection for GitHub projects', () => {
  const pkg = (
    dependencies: Record<string, string>,
    devDependencies: Record<string, string> = {},
  ) => JSON.stringify({ dependencies, devDependencies });
  const worker = JSON.stringify({ name: 'app', main: 'src/index.js' });
  it.each([
    ['nextjs', { 'package.json': pkg({ next: '16.3.8', react: '19.3.0' }) }],
    [
      'astro',
      { 'package.json': pkg({ astro: '7.3.6', '@astrojs/react': '5.0.0' }) },
    ],
    [
      'sveltekit',
      { 'package.json': pkg({}, { '@sveltejs/kit': '3.0.1', svelte: '5' }) },
    ],
    // The React and Vue kits pair a Vite frontend with a Hono API.
    ['react', { 'package.json': pkg({ react: '19.3.0', hono: '4.13.13' }) }],
    ['vue', { 'package.json': pkg({ vue: '3.5.0', hono: '4.13.13' }) }],
    [
      'hono',
      { 'package.json': pkg({ hono: '4.13.13' }), 'wrangler.json': worker },
    ],
    ['worker', { 'package.json': pkg({}), 'wrangler.json': worker }],
    [
      'static',
      {
        'wrangler.json': JSON.stringify({
          name: 'site',
          assets: { directory: './public' },
        }),
      },
    ],
  ])('detects %s', (framework, repository) => {
    expect(detectFramework(repository)).toBe(framework);
  });
  it('detects Python Workers by their entry point or project file', () => {
    expect(
      detectFramework({
        'package.json': pkg({}, { wrangler: '4.148.0' }),
        'wrangler.jsonc': '{ "main": "src/entry.py" }',
      }),
    ).toBe('python');
    expect(
      detectFramework({ 'pyproject.toml': '[project]\nname = "app"' }),
    ).toBe('python');
  });
  it('detects Container Workers before the framework that serves them', () => {
    expect(
      detectFramework({
        'package.json': pkg({ hono: '4.13.13' }),
        'wrangler.jsonc': `{
          // Requests go to the container's Durable Object.
          "main": "src/index.ts",
          "containers": [{ "class_name": "App", "image": "./Dockerfile" }],
        }`,
      }),
    ).toBe('docker');
  });
  it('takes a repository of plain HTML files for a static site', () => {
    expect(detectFramework({ 'index.html': 'present' })).toBe('static');
    // A build that produces the HTML is recognised by its tools instead.
    expect(
      detectFramework({
        'index.html': 'present',
        'package.json': JSON.stringify({ devDependencies: { vite: '8.3.3' } }),
      }),
    ).toBe('worker');
  });
  it('leaves the choice to the person when nothing is recognisable', () => {
    expect(detectFramework({})).toBeNull();
    expect(detectFramework({ 'package.json': '{ not json' })).toBeNull();
    expect(detectFramework({ 'wrangler.json': '[]' })).toBeNull();
  });
});

// Like Vercel's framework presets: a site without a Wrangler configuration deploys its
// build output as static files, with a configuration Shipcel writes during the build.
describe('sites without a Wrangler configuration', () => {
  const vite = (extra: Record<string, string | null> = {}) => ({
    'package.json': JSON.stringify({
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { react: '19.3.0', 'react-dom': '19.3.0' },
      devDependencies: { vite: '8.3.3' },
    }),
    'package-lock.json': 'present',
    'index.html': 'present',
    ...extra,
  });
  const plan = (files: Record<string, string | null>, framework = 'react') =>
    repositoryPlan(files, framework);
  it('deploys a Vite app’s build folder as a single-page app', () => {
    const p = plan(vite());
    expect(p.issues).toEqual([]);
    expect(p.adapter).toBe('static-assets');
    expect(p.buildCommand).toBe('npm run build');
    expect(p.site).toEqual({ preset: 'Vite', directory: 'dist', spa: true });
    expect(p.resources).toEqual([]);
    expect(p.warnings.join(' ')).toContain('No Wrangler configuration needed');
  });
  it('reads where Vite writes the build, and refuses what it can’t read', () => {
    expect(
      plan(
        vite({
          'vite.config.ts':
            "export default defineConfig({ root: 'app', build: { outDir: 'public-build' } })",
        }),
      ).site,
    ).toMatchObject({ directory: 'app/public-build' });
    expect(
      plan(
        vite({
          'vite.config.ts':
            "// build: { outDir: 'nope' }\nexport default defineConfig({ plugins: [react()] })",
        }),
      ).site,
    ).toMatchObject({ directory: 'dist' });
    expect(
      plan(
        vite({
          'vite.config.js':
            "export default { build: { outDir: resolve(__dirname, 'out') } }",
        }),
      ).issues.join(' '),
    ).toContain('where Vite writes the build');
    expect(
      plan(
        vite({
          'vite.config.mjs': "export default { build: { outDir: '../out' } }",
        }),
      ).issues.join(' '),
    ).toContain('inside the repository');
  });
  it.each([
    ['react-scripts', 'Create React App', 'build', true],
    ['@vue/cli-service', 'Vue CLI', 'dist', true],
    ['gatsby', 'Gatsby', 'public', false],
  ])('knows %s', (dependency, preset, directory, spa) => {
    const p = plan({
      'package.json': JSON.stringify({
        scripts: { build: 'build' },
        dependencies: { [dependency]: '1.0.0' },
      }),
      'package-lock.json': 'present',
    });
    expect(p.issues).toEqual([]);
    expect(p.site).toEqual({ preset, directory, spa });
  });
  it('deploys an Astro site without a server adapter as static files', () => {
    const astro = {
      'package.json': JSON.stringify({
        scripts: { build: 'astro build' },
        dependencies: { astro: '7.3.6' },
      }),
      'package-lock.json': 'present',
    };
    const p = plan(astro, 'astro');
    expect(p.issues).toEqual([]);
    expect(p.adapter).toBe('static-assets');
    expect(p.site).toEqual({
      preset: 'Astro (static)',
      directory: 'dist',
      spa: false,
    });
    // Server output needs the Cloudflare adapter, set up once.
    const server = plan(
      {
        ...astro,
        'astro.config.mjs': "export default defineConfig({ output: 'server' })",
      },
      'astro',
    );
    expect(server.adapter).toBe('astro');
    expect(server.issues.join(' ')).toContain('npx wrangler setup');
  });
  it('serves a plain HTML site from the repository root, with no build', () => {
    const p = plan({ 'index.html': 'present' }, 'static');
    expect(p.issues).toEqual([]);
    expect(p.buildCommand).toBe('');
    expect(p.site).toEqual({ preset: 'HTML', directory: '.', spa: false });
  });
  it('builds whichever package manager’s lockfile the repository has', () => {
    for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
      const files: Record<string, string | null> = vite({
        [lockfile]: 'present',
      });
      delete files['package-lock.json'];
      const p = plan(files);
      expect(p.issues, lockfile).toEqual([]);
      expect(p.buildCommand).toBe('npm run build');
    }
    // npm's lockfile next to another: Shipcel installs with npm itself, so the build
    // doesn't depend on which one Cloudflare's own install would pick.
    const mixed = plan(vite({ 'yarn.lock': 'present' }));
    expect(mixed.issues).toEqual([]);
    expect(mixed.buildCommand).toBe(
      'npm install --no-audit --no-fund && npm run build',
    );
    expect(mixed.site).toMatchObject({ install: 'npm' });
    expect(mixed.warnings.join(' ')).toContain(
      'package-lock.json and yarn.lock',
    );
    // Without npm's lockfile, two others are ambiguous.
    const other: Record<string, string | null> = vite({
      'yarn.lock': 'present',
      'pnpm-lock.yaml': 'present',
    });
    delete other['package-lock.json'];
    expect(plan(other).issues.join(' ')).toContain('one package manager');
    // Without a lockfile it still deploys, with a warning.
    const unlocked: Record<string, string | null> = vite();
    delete unlocked['package-lock.json'];
    expect(plan(unlocked).issues).toEqual([]);
    expect(plan(unlocked).warnings.join(' ')).toContain('Commit a lockfile');
  });
  it('asks for a build script when the site needs building', () => {
    expect(
      plan({
        ...vite(),
        'package.json': JSON.stringify({ devDependencies: { vite: '8.3.3' } }),
      }).issues.join(' '),
    ).toContain('build script');
  });
  it('uses the repository’s own Wrangler configuration when it has one', () => {
    const configured = plan(
      vite({
        'wrangler.jsonc': JSON.stringify({
          name: 'mine',
          compatibility_date: '2026-10-07',
          assets: { directory: './dist' },
        }),
      }),
    );
    expect(configured.adapter).toBe('configured-worker');
    expect(configured.site).toBeUndefined();
    expect(
      plan(vite({ 'wrangler.toml': 'name = "mine"' })).issues.join(' '),
    ).toContain('Wrangler JSON/JSONC');
  });
  it('reports a runtime chosen for the wrong repository instead of guessing', () => {
    const p = plan(vite(), 'nextjs');
    expect(p.adapter).toBe('nextjs');
    expect(p.issues.join(' ')).toContain('does not depend on next');
    expect(plan(vite(), 'python').adapter).not.toBe('static-assets');
  });
  it('leaves server-rendered frameworks to their adapters', () => {
    for (const [dependency, framework] of [
      ['@sveltejs/kit', 'worker'],
      ['next', 'react'],
      ['nuxt', 'vue'],
    ])
      expect(
        plan(
          vite({
            'package.json': JSON.stringify({
              scripts: { build: 'vite build' },
              dependencies: { [dependency]: '1.0.0', vite: '8.3.3' },
            }),
          }),
          framework,
        ).adapter,
        dependency,
      ).not.toBe('static-assets');
  });
  it('refuses monorepos and counts Bun’s two lockfile names as one', () => {
    expect(
      plan({
        ...vite(),
        'package.json': JSON.stringify({
          workspaces: ['apps/*'],
          scripts: { build: 'vite build' },
          devDependencies: { vite: '8.3.3' },
        }),
      }).issues.join(' '),
    ).toContain('monorepo');
    const bun: Record<string, string | null> = vite({
      'bun.lock': 'present',
      'bun.lockb': 'present',
    });
    delete bun['package-lock.json'];
    expect(plan(bun).issues).toEqual([]);
  });
  it('still explains what to add for a repository it doesn’t recognise', () => {
    const p = plan(
      {
        'package.json': JSON.stringify({
          scripts: { build: 'tsc' },
          dependencies: { express: '5.0.0' },
        }),
        'package-lock.json': 'present',
        // An unknown build that also has a root page is not a plain HTML site.
        'index.html': 'present',
      },
      'worker',
    );
    expect(p.adapter).toBe('configured-worker');
    expect(p.issues.join(' ')).toContain(
      'Commit a wrangler.json or wrangler.jsonc',
    );
  });
});
