// Independent, credential-free framework adapter checks. Deploy commands only run with --dry-run;
// fixtures with a `route` are then run locally in Wrangler and must answer it with ok: true.
// Usage: npm run verify:frameworks [-- <fixture name>]
// Container fixtures need a running Docker daemon: Wrangler builds images even in a dry run.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, dirname, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { applyEdits, modify } from 'jsonc-parser';
import { offlineEnv } from './offline-env.mjs';
import { UV_VERSION } from '../shared/local-deploy.ts';
import {
  containerDockerfiles,
  deploymentCommand,
  repositoryPlan,
  siteFiles,
} from '../worker/repository-plan.ts';

const run = promisify(execFile);
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const wranglerVersion = JSON.parse(
  await readFile('node_modules/wrangler/package.json', 'utf8'),
).version;
const root = await mkdtemp(join(tmpdir(), 'shipcel-frameworks-'));
// adapter: a Shipcel import path that must pass end to end. setup 'wrangler' runs the
// one-time `wrangler setup` a user commits; 'committed' fixtures carry their configuration.
// probe: Wrangler automatic setup evidence for frameworks or paths that stay gated.
const svelteFiles = {
  'src/app.html':
    '<!doctype html><html lang="en"><head><meta charset="utf-8"/>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>',
  'src/routes/+page.svelte': '<h1>Shipcel SvelteKit fixture</h1>',
  'src/routes/api/health/+server.js':
    "export function GET() { return Response.json({ framework: 'sveltekit', ok: true }); }\n",
  'static/.gitkeep': '',
};
const svelteDependencies = {
  '@sveltejs/kit': '3.1.1',
  '@sveltejs/vite-plugin-svelte': '7.3.1',
  svelte: '5.57.3',
  vite: '8.3.5',
};
// A static site served by busybox httpd on the port the Worker forwards to.
const containerImage = {
  Dockerfile:
    'FROM busybox:1.37.0\nCOPY www /www\nEXPOSE 8080\nCMD ["httpd", "-f", "-v", "-p", "8080", "-h", "/www"]\n',
  'www/index.html': '<h1>Shipcel container fixture</h1>\n',
};
const fixtures = {
  astro: {
    kind: 'adapter',
    framework: 'astro',
    setup: 'wrangler',
    dependencies: { astro: '7.4.4' },
    scripts: { build: 'astro build' },
    // Also exercises a repository-declared draft D1 binding next to the adapter defaults.
    draftBindings: { d1_databases: [{ binding: 'DB' }] },
    route: '/api/health',
    files: {
      'public/.gitkeep': '',
      'astro.config.mjs':
        "import { defineConfig } from 'astro/config'; export default defineConfig({ output: 'server' });\n",
      'src/pages/index.astro':
        '<!doctype html><html lang="en"><head><title>Shipcel Astro</title></head><body><h1>Shipcel Astro fixture</h1></body></html>',
      'src/pages/api/health.js':
        "export function GET() { return Response.json({ framework: 'astro', ok: true }); }\n",
    },
  },
  sveltekit: {
    kind: 'adapter',
    framework: 'sveltekit',
    setup: 'committed',
    route: '/api/health',
    dependencies: {
      ...svelteDependencies,
      '@sveltejs/adapter-cloudflare': '8.0.2',
    },
    devDependencies: { wrangler: wranglerVersion },
    scripts: { build: 'vite build' },
    files: {
      ...svelteFiles,
      // SvelteKit 3 takes configuration through the Vite plugin; svelte.config.js is rejected.
      'vite.config.js':
        "import adapter from '@sveltejs/adapter-cloudflare';\nimport { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] });\n",
      'wrangler.jsonc':
        JSON.stringify(
          {
            $schema: 'node_modules/wrangler/config-schema.json',
            name: 'shipcel-check-sveltekit',
            main: '.svelte-kit/cloudflare/_worker.js',
            compatibility_date: '2026-10-06',
            observability: { enabled: true },
            assets: { binding: 'ASSETS', directory: '.svelte-kit/cloudflare' },
            d1_databases: [{ binding: 'DB' }],
          },
          null,
          2,
        ) + '\n',
    },
  },
  'sveltekit-autoconfig': {
    kind: 'probe',
    framework: 'sveltekit',
    dependencies: svelteDependencies,
    scripts: { build: 'vite build' },
    files: {
      ...svelteFiles,
      'vite.config.js':
        "import { sveltekit } from '@sveltejs/kit/vite'; import { defineConfig } from 'vite'; export default defineConfig({ plugins: [sveltekit()] });\n",
    },
  },
  // Plain Wrangler runs package-free Python Workers only before compatibility date 2026-04-21;
  // from then on the `workers` module comes from workers-py through pywrangler (below).
  python: {
    kind: 'adapter',
    framework: 'python',
    setup: 'committed',
    npm: false,
    route: '/',
    files: {
      'src/entry.py':
        'from workers import WorkerEntrypoint, Response\n\n\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        return Response.json({"runtime": "python", "ok": True})\n',
      'wrangler.json': JSON.stringify({
        name: 'shipcel-check-python',
        main: 'src/entry.py',
        compatibility_date: '2026-04-20',
        compatibility_flags: ['python_workers'],
        d1_databases: [{ binding: 'DB' }],
      }),
    },
  },
  // Needs pipx and network access to PyPI, like the Workers Builds image.
  'python-fastapi': {
    kind: 'adapter',
    framework: 'python',
    setup: 'committed',
    route: '/',
    devDependencies: { wrangler: wranglerVersion },
    prepare: [['pipx', ['run', '--spec', `uv==${UV_VERSION}`, 'uv', 'lock']]],
    files: {
      'pyproject.toml':
        '[project]\nname = "shipcel-check-fastapi"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["fastapi"]\n\n[dependency-groups]\ndev = ["workers-py", "workers-runtime-sdk"]\n',
      'src/entry.py':
        'from workers import WorkerEntrypoint\nfrom fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\nasync def root():\n    return {"runtime": "python", "framework": "fastapi", "ok": True}\n\n\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        import asgi\n\n        return await asgi.fetch(app, request, self.env)\n',
      'wrangler.jsonc': JSON.stringify({
        name: 'shipcel-check-fastapi',
        main: 'src/entry.py',
        compatibility_date: '2026-10-07',
        compatibility_flags: ['python_workers'],
        d1_databases: [{ binding: 'DB' }],
      }),
    },
  },
  // Default scheduling policy with @cloudflare/containers, next to a draft D1 binding.
  container: {
    kind: 'adapter',
    framework: 'docker',
    setup: 'committed',
    dependencies: { '@cloudflare/containers': '0.3.7' },
    devDependencies: { wrangler: wranglerVersion },
    files: {
      ...containerImage,
      'src/index.js':
        "import { Container, getContainer } from '@cloudflare/containers';\n\nexport class Site extends Container {\n  defaultPort = 8080;\n  sleepAfter = '2m';\n}\n\nexport default {\n  fetch(request, env) {\n    return getContainer(env.SITE).fetch(request);\n  },\n};\n",
      'wrangler.jsonc': JSON.stringify(
        {
          name: 'shipcel-check-container',
          main: 'src/index.js',
          compatibility_date: '2026-10-07',
          containers: [
            {
              class_name: 'Site',
              image: './Dockerfile',
              max_instances: 2,
              instance_type: 'lite',
            },
          ],
          durable_objects: { bindings: [{ name: 'SITE', class_name: 'Site' }] },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['Site'] }],
          d1_databases: [{ binding: 'DB' }],
        },
        null,
        2,
      ),
    },
  },
  // The layout of Cloudflare's containers template: the Durable Object starts its container.
  'container-managed': {
    kind: 'adapter',
    framework: 'docker',
    setup: 'committed',
    devDependencies: { wrangler: wranglerVersion },
    files: {
      ...containerImage,
      // Different content from the other container fixture: identical images share an ID,
      // and one fixture's cleanup would remove the image the other is still using.
      'www/index.html': '<h1>Shipcel managed container fixture</h1>\n',
      'src/index.js':
        "import { DurableObject } from 'cloudflare:workers';\n\nexport class Site extends DurableObject {\n  async fetch(request) {\n    const container = this.ctx.container;\n    if (!container.running)\n      container.start({ image: container.images.base, instance: 'lite' });\n    const url = new URL(request.url);\n    return container.getTcpPort(8080).fetch(`http://container${url.pathname}`);\n  }\n}\n\nexport default {\n  fetch(request, env) {\n    return env.SITE.getByName('site').fetch(request);\n  },\n};\n",
      'wrangler.jsonc': JSON.stringify(
        {
          $schema: 'node_modules/wrangler/config-schema.json',
          name: 'shipcel-check-container-managed',
          main: 'src/index.js',
          compatibility_date: '2026-10-07',
          compatibility_flags: ['nodejs_compat'],
          containers: [
            {
              class_name: 'Site',
              scheduling_policy: 'durable_object',
              images: { base: { dockerfile: './Dockerfile' } },
            },
          ],
          durable_objects: { bindings: [{ name: 'SITE', class_name: 'Site' }] },
          upload_source_maps: true,
          exports: { Site: { type: 'durable-object', storage: 'sqlite' } },
        },
        null,
        2,
      ),
    },
  },
  // Sites without a Wrangler configuration (static-assets): Shipcel's deploy command writes
  // one. `page` is text the served page must contain; `hidden` paths must not be served.
  'vite-react': {
    kind: 'adapter',
    framework: 'react',
    dependencies: { react: '19.3.1', 'react-dom': '19.3.1' },
    devDependencies: { vite: '8.3.5', '@vitejs/plugin-react': '6.1.2' },
    scripts: { build: 'vite build' },
    // A client-side route: the single-page app fallback serves index.html.
    route: '/dashboard/settings',
    page: 'Shipcel Vite fixture',
    files: {
      'index.html':
        '<!doctype html><html lang="en"><head><title>Shipcel Vite fixture</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
      'src/main.jsx':
        "import { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render(<h1>Shipcel Vite fixture</h1>);\n",
      'vite.config.js':
        "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
    },
  },
  html: {
    kind: 'adapter',
    framework: 'static',
    npm: false,
    route: '/about',
    page: 'Shipcel HTML fixture: about',
    hidden: ['/.git/config', '/wrangler.jsonc'],
    files: {
      'index.html':
        '<!doctype html><html lang="en"><head><title>Shipcel HTML fixture</title></head><body><h1>Shipcel HTML fixture</h1></body></html>\n',
      'about.html':
        '<!doctype html><html lang="en"><head><title>About</title></head><body><h1>Shipcel HTML fixture: about</h1></body></html>\n',
      '.git/config': '[core]\n',
    },
  },
  // OpenNext 1.20.9 to 1.20.11 built Next.js 16.4.0, but every request then failed
  // (preview-props.json); 1.20.12 and later support 16.4.1 and later only, which fix
  // Next.js's critical advisories of October 2026.
  nextjs: {
    kind: 'adapter',
    framework: 'nextjs',
    setup: 'wrangler',
    route: '/api/health',
    dependencies: { next: '16.4.3', react: '19.3.1', 'react-dom': '19.3.1' },
    scripts: { build: 'next build' },
    files: {
      'next.config.mjs': 'export default {};\n',
      'app/layout.jsx':
        "export default function Layout({children}) { return <html lang='en'><body>{children}</body></html>; }\n",
      'app/page.jsx':
        'export default function Page() { return <h1>Shipcel Next.js fixture</h1>; }\n',
      'app/api/health/route.js':
        "export function GET() { return Response.json({ framework: 'nextjs', ok: true }); }\n",
    },
  },
};
// Files the control plane reads at the pinned commit (see inspectRepository).
const inspectedFiles = [
  'package.json',
  'package-lock.json',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
  'wrangler.config.ts',
  'cloudflare.config.ts',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'open-next.config.ts',
  'pyproject.toml',
  'uv.lock',
  ...siteFiles,
];
const resourceTypes = {
  'D1 Database': 'd1',
  'R2 Bucket': 'r2',
  'KV Namespace': 'kv',
  Queue: 'queue',
};
const env = {
  ...offlineEnv(root),
  PIPX_HOME: join(root, 'pipx'),
  PIPX_BIN_DIR: join(root, 'pipx', 'bin'),
  UV_CACHE_DIR: join(root, 'uv-cache'),
};
const selected = Object.entries(fixtures).filter(
  ([name]) => !process.argv[2] || name === process.argv[2],
);
const results = [];

function parseBindings(output) {
  return [
    ...output.matchAll(/^env\.(\w+)(?: \([^)]*\))?\s{2,}(\S.*?)\s*$/gm),
  ].map(([line, name, resource]) => ({
    name,
    resource,
    target: line.match(/^env\.\w+ \(([^)]*)\)/)?.[1],
  }));
}

// Local runs start one at a time: started together, two Wrangler dev servers could take
// the same free port for an internal socket ("Address already in use (socket
// \"direct:1:default\")", seen on 28 Oct 2026 with every fixture running at once).
let localRuns = Promise.resolve();
function runLocallyInTurn(...args) {
  const run = localRuns.then(() => runLocally(...args));
  localRuns = run.catch(() => {});
  return run;
}

// Serves the built fixture the way Wrangler runs it (pywrangler for Python packages) and
// requests its route, which must answer JSON with ok: true.
async function runLocally(cwd, adapter, route, port, log, fixture = {}) {
  const [command, ...args] =
    adapter === 'python-packages'
      ? [
          'pipx',
          'run',
          '--spec',
          `uv==${UV_VERSION}`,
          'uv',
          'run',
          'pywrangler',
          'dev',
        ]
      : [process.execPath, wrangler, 'dev'];
  const child = spawn(
    command,
    [...args, '--port', String(port), '--ip', '127.0.0.1'],
    { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  try {
    let answer = null;
    for (let second = 0; second < 180 && !answer; second++) {
      if (child.exitCode !== null)
        throw new Error(`The local run stopped: ${output.slice(-1500)}`);
      await new Promise((done) => setTimeout(done, 1000));
      answer = await fetch(`http://127.0.0.1:${port}${route}`).catch(
        () => null,
      );
    }
    if (!answer) throw new Error('The local run never answered');
    const body = await answer.text();
    // A site answers its page; an app answers JSON with ok: true.
    if (
      answer.status !== 200 ||
      (fixture.page
        ? !body.includes(fixture.page)
        : JSON.parse(body)?.ok !== true)
    )
      throw new Error(
        `${route} answered ${answer.status}: ${body.slice(0, 300)}`,
      );
    for (const path of fixture.hidden ?? []) {
      const hidden = await fetch(`http://127.0.0.1:${port}${path}`);
      if (hidden.status !== 404)
        throw new Error(`${path} was served (${hidden.status})`);
    }
    return fixture.page
      ? JSON.stringify({
          route,
          status: answer.status,
          page: fixture.page,
          hidden: fixture.hidden ?? [],
        })
      : body;
  } finally {
    log.push(`$ ${[command, ...args].join(' ')} (local run)`, output);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already stopped. */
    }
  }
}

async function verify(check, fixture) {
  const { framework } = fixture;
  const cwd = join(root, check);
  const log = [];
  async function command(cmd, args, timeout = 300000) {
    log.push(`$ ${[cmd, ...args].join(' ')}`);
    try {
      const result = await run(cmd, args, {
        cwd,
        env,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      });
      log.push(result.stdout, result.stderr);
      return result.stdout;
    } catch (error) {
      log.push(error.stdout || '', error.stderr || '', error.message);
      throw error;
    }
  }
  const read = (name) => readFile(join(cwd, name), 'utf8').catch(() => null);
  const record = {
    check,
    framework,
    kind: fixture.kind,
    wrangler: wranglerVersion,
  };
  try {
    await mkdir(cwd, { recursive: true });
    if (fixture.npm !== false)
      await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: `shipcel-check-${check}`,
          version: '1.0.0',
          private: true,
          type: 'module',
          dependencies: fixture.dependencies,
          devDependencies: fixture.devDependencies,
          scripts: fixture.scripts,
        }),
      );
    for (const [name, value] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), value);
    }
    if (fixture.npm !== false)
      await command('npm', ['install', '--no-audit', '--no-fund']);
    for (const [cmd, args] of fixture.prepare ?? []) await command(cmd, args);
    if (fixture.kind === 'probe') {
      await command(process.execPath, [
        wrangler,
        'setup',
        '--yes',
        '--build',
        '--no-install-wrangler',
      ]);
      const output = await command(process.execPath, [
        wrangler,
        'deploy',
        '--dry-run',
        '--outdir',
        '.bundle-check',
        '--name',
        `cc-check-${check}`,
      ]);
      Object.assign(record, {
        result: 'passed',
        dryRunBindings: parseBindings(output),
        note: 'Automatic setup and dry run passed. This path remains gated until a Shipcel adapter is implemented and verified.',
      });
      return;
    }
    if (fixture.setup === 'wrangler') {
      // The one-time setup a user runs and commits before importing the repository.
      await command(process.execPath, [
        wrangler,
        'setup',
        '--yes',
        '--no-install-wrangler',
      ]);
      const configName = (await read('wrangler.jsonc'))
        ? 'wrangler.jsonc'
        : 'wrangler.json';
      let configText = await read(configName);
      for (const [key, value] of Object.entries(fixture.draftBindings || {}))
        configText = applyEdits(
          configText,
          modify(configText, [key], value, { formattingOptions: {} }),
        );
      await writeFile(join(cwd, configName), configText);
    }
    const files = Object.fromEntries(
      await Promise.all(inspectedFiles.map(async (f) => [f, await read(f)])),
    );
    for (const path of containerDockerfiles(
      files['wrangler.jsonc'] ?? files['wrangler.json'],
    ))
      files[path] = await read(path);
    const plan = repositoryPlan(files, framework);
    record.plan = plan;
    if (plan.issues.length)
      throw new Error(`Shipcel plan rejected: ${plan.issues.join(' ')}`);
    // Workers Builds starts from the committed files: clean install, build, deploy.
    await rm(join(cwd, 'node_modules'), { recursive: true, force: true });
    for (const generated of [
      'dist',
      '.astro',
      '.svelte-kit',
      '.next',
      '.open-next',
      '.wrangler',
      '.venv',
      '.venv-workers',
      'python_modules',
    ])
      await rm(join(cwd, generated), { recursive: true, force: true });
    if (fixture.npm !== false)
      await command('npm', ['ci', '--no-audit', '--no-fund']);
    if (plan.buildCommand) {
      const [buildCmd, ...buildArgs] = plan.buildCommand.split(' ');
      await command(buildCmd, buildArgs);
    }
    // Adapters that keep their configured name (Next.js) deploy under it.
    const workerName = plan.workerName ?? `cc-check-${check}-0123456789ab`;
    const deploy = deploymentCommand(plan.adapter, workerName, plan.site);
    const [program, pinned, ...deployArgs] = deploy.split(' ');
    const dryRun = ['--dry-run', '--outdir', '.bundle-check'];
    let output;
    if (plan.adapter === 'static-assets') {
      // The trigger's shell step writes the configuration, then deploys with Wrangler.
      const pinnedWrangler = `npx wrangler@${wranglerVersion}`;
      if (!deploy.includes(`${pinnedWrangler} deploy `))
        throw new Error(`Deploy command is not pinned to ${wranglerVersion}`);
      output = await command('sh', [
        '-c',
        `${deploy.replace(pinnedWrangler, `"${process.execPath}" "${wrangler}"`)} ${dryRun.join(' ')}`,
      ]);
    } else if (program === 'npx') {
      if (pinned !== `wrangler@${wranglerVersion}`)
        throw new Error(`Deploy command is not pinned to ${wranglerVersion}`);
      output = await command(process.execPath, [
        wrangler,
        ...deployArgs,
        ...dryRun,
      ]);
    } else {
      // Other commands (pywrangler) run exactly as the trigger would, plus --dry-run.
      output = await command(program, [pinned, ...deployArgs, ...dryRun]);
      const used = output.match(/wrangler (\d+\.\d+\.\d+)/)?.[1];
      if (used !== wranglerVersion)
        throw new Error(
          `The deploy used Wrangler ${used}, not ${wranglerVersion}`,
        );
    }
    const bindings = parseBindings(output);
    const selfReference = bindings.find(
      (b) => b.name === 'WORKER_SELF_REFERENCE',
    );
    if (selfReference && selfReference.target !== workerName)
      throw new Error(
        `WORKER_SELF_REFERENCE targets ${selfReference.target}, not the deployed Worker ${workerName}`,
      );
    const created = bindings.filter((b) => resourceTypes[b.resource]);
    const unreviewed = created.filter(
      (b) =>
        !plan.resources.some(
          (r) => r.binding === b.name && r.type === resourceTypes[b.resource],
        ),
    );
    const missing = plan.resources.filter(
      (r) =>
        !r.source &&
        !created.some(
          (b) => b.name === r.binding && resourceTypes[b.resource] === r.type,
        ),
    );
    if (unreviewed.length || missing.length)
      throw new Error(
        `Dry-run bindings differ from the reviewed plan (unreviewed: ${unreviewed.map((b) => b.name).join(', ') || 'none'}; missing: ${missing.map((r) => r.binding).join(', ') || 'none'})`,
      );
    // Containers: Wrangler names default-policy applications after the deployed Worker, and
    // removes each image it built ("Untagged: <image>:wrangler-…") once the dry run ends.
    if (plan.containers.length) {
      const listed = [...output.matchAll(/^- (\S+) \(([^)]*)\)$/gm)].map(
        ([, name, source]) => ({
          name,
          source: source === 'durable_object' ? source : basename(source),
        }),
      );
      for (const c of plan.containers) {
        const expected =
          c.policy === 'default'
            ? `${workerName}-${c.className.toLowerCase()}`
            : c.className;
        if (!listed.some((l) => l.name === expected))
          throw new Error(
            `Container ${c.className} was not listed as ${expected} by the dry run`,
          );
      }
      const built = [
        ...output.matchAll(/^Untagged: (\S+):wrangler-\S+$/gm),
      ].map(([, image]) => image);
      if (built.length < plan.containers.length)
        throw new Error('Docker did not build every container image');
      record.containers = listed;
      record.builtImages = built;
      record.docker = (
        await command('docker', ['version', '--format', '{{.Server.Version}}'])
      ).trim();
    }
    if (fixture.route)
      record.localRun = {
        route: fixture.route,
        answer: JSON.parse(
          await runLocallyInTurn(
            cwd,
            plan.adapter,
            fixture.route,
            8820 + Object.keys(fixtures).indexOf(check),
            log,
            fixture,
          ),
        ),
      };
    // Resolved npm versions, when the repository has npm files.
    const lock = JSON.parse(
      (await read('package-lock.json')) ?? '{"packages":{}}',
    );
    const manifest = JSON.parse((await read('package.json')) ?? '{}');
    Object.assign(record, {
      result: 'passed',
      resolved: Object.fromEntries(
        Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
        }).map((name) => [
          name,
          lock.packages[`node_modules/${name}`]?.version ?? null,
        ]),
      ),
      buildCommand: plan.buildCommand,
      deployCommand: deploy,
      dryRunBindings: bindings,
    });
  } catch (error) {
    Object.assign(record, {
      result: 'failed',
      error: String(error.message).split('\n')[0],
    });
    if (fixture.kind === 'adapter') throw error;
  } finally {
    results.push(record);
    console.log(
      `${check} (${fixture.kind}): ${record.result}${record.error ? ` — ${record.error}` : ''}`,
    );
    await writeFile(
      `docs/framework-verification/${check}.log`,
      log.join('\n').replaceAll(root, '<temporary-directory>'),
    );
  }
}

try {
  await mkdir('docs/framework-verification', { recursive: true });
  const checks = await Promise.allSettled(
    selected.map(([check, fixture]) => verify(check, fixture)),
  );
  results.sort((a, b) => a.check.localeCompare(b.check));
  await writeFile(
    'docs/framework-verification.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        liveDeploymentTested: false,
        note: 'Dry runs prove configuration, bundling and binding declarations only. No Cloudflare resources were created.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  if (checks.some((c) => c.status === 'rejected')) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
