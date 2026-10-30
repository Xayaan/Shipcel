// Exports every starter kit from the local dev server (npm run dev), then installs, builds,
// checks the native import plan, dry-runs the exact native deploy command, and runs the app
// locally in Wrangler (pywrangler for Python), requesting / and /api/health.
// Usage: npm run verify:kits [-- <framework>]
// The Python kit needs pipx and network access to PyPI, like the Workers Builds image.
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import { offlineEnv } from './offline-env.mjs';
import { UV_VERSION } from '../shared/local-deploy.ts';
import {
  allowsBindings,
  frameworks as catalog,
  usesContainers,
} from '../shared/catalog.ts';
import {
  containerDockerfiles,
  deploymentCommand,
  repositoryPlan,
} from '../worker/repository-plan.ts';

const run = promisify(execFile);
const base = 'http://127.0.0.1:5173';
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const root = await mkdtemp(join(tmpdir(), 'shipcel-kits-'));
const env = {
  ...offlineEnv(root),
  NEXT_TELEMETRY_DISABLED: '1',
  PIPX_HOME: join(root, 'pipx'),
  PIPX_BIN_DIR: join(root, 'pipx', 'bin'),
  UV_CACHE_DIR: join(root, 'uv-cache'),
};
const uv = ['pipx', 'run', '--spec', `uv==${UV_VERSION}`, 'uv'];
// Every kit in the App catalog (kits/index.ts).
const frameworks = catalog.map((f) => f.id);
// A kit that offers a D1 database and R2 storage is checked with both.
const withResources = frameworks.filter(allowsBindings);
const results = [];
// Containers run locally only with Docker, and the Docker kit's image builds only with it. A
// service's image comes from Docker Hub, so its deploy dry run needs no Docker.
const docker = await run('docker', [
  'version',
  '--format',
  '{{.Server.Version}}',
])
  .then(() => true)
  .catch(() => false);

// Serves the built app the way Wrangler runs it on Cloudflare (pywrangler for Python) and
// checks that it answers. Dry runs only bundle: this is what caught a Next.js release that
// fails on every request and Python Workers that couldn't import their SDK.
async function runLocally(cwd, adapter, framework, port) {
  const [command, ...args] =
    adapter === 'python-packages'
      ? [...uv, 'run', 'pywrangler', 'dev']
      : [
          process.execPath,
          join(cwd, 'node_modules/wrangler/bin/wrangler.js'),
          'dev',
        ];
  const child = spawn(
    command,
    [...args, '--port', String(port), '--ip', '127.0.0.1'],
    { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const address = `http://127.0.0.1:${port}`;
  try {
    let home = null;
    for (let second = 0; second < 120 && !home; second++) {
      if (child.exitCode !== null)
        throw new Error(`The local run stopped: ${output.slice(-2000)}`);
      await new Promise((done) => setTimeout(done, 1000));
      home = await fetch(`${address}/`).catch(() => null);
    }
    if (!home)
      throw new Error(`The local run never answered: ${output.slice(-2000)}`);
    if (home.status !== 200)
      throw new Error(
        `/ answered ${home.status}: ${(await home.text()).slice(0, 500)}`,
      );
    if (framework !== 'static') {
      const health = await fetch(`${address}/api/health`);
      const body = await health.json().catch(() => null);
      if (health.status !== 200 || body?.ok !== true)
        throw new Error(`/api/health answered ${health.status}`);
    }
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* Already stopped. */
    }
  }
}

try {
  for (const [index, framework] of frameworks
    .filter((f) => !process.argv[2] || f === process.argv[2])
    .entries()) {
    const name = `qa-kit-${framework}-${Date.now()}`;
    const resources = withResources.includes(framework);
    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        framework,
        database: resources,
        storage: resources,
        // R2 and containers can bill, so Free-only projects refuse them.
        freeOnly: !resources && !usesContainers(framework),
      }),
    });
    if (!response.ok)
      throw new Error(`Create failed: ${await response.text()}`);
    const project = await response.json();
    try {
      const archive = await fetch(`${base}/api/projects/${project.id}/export`, {
        method: 'POST',
      });
      if (!archive.ok)
        throw new Error(`Export failed: ${await archive.text()}`);
      const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
      for (const [path, data] of Object.entries(files)) {
        if (path.includes('..') || path.startsWith('/'))
          throw new Error('Unsafe archive path');
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), data);
      }
      const cwd = join(root, name);
      const options = {
        cwd,
        env,
        timeout: 600000,
        maxBuffer: 64 * 1024 * 1024,
      };
      const read = (file) =>
        readFile(join(cwd, file), 'utf8').catch(() => null);
      // The lockfiles a person commits after their first install.
      await run('npm', ['install', '--no-fund', '--no-audit'], options);
      if (await read('pyproject.toml'))
        await run(uv[0], [...uv.slice(1), 'lock'], options);
      // The committed repository Shipcel would inspect, with the Dockerfiles its configuration
      // names, as inspectRepository reads them.
      const committed = Object.fromEntries(
        await Promise.all(
          [
            'package.json',
            'package-lock.json',
            'wrangler.json',
            'wrangler.jsonc',
            'open-next.config.ts',
            'pyproject.toml',
            'uv.lock',
          ].map(async (file) => [file, await read(file)]),
        ),
      );
      for (const path of containerDockerfiles(
        committed['wrangler.jsonc'] ?? committed['wrangler.json'],
      ))
        committed[path] = await read(path);
      const plan = repositoryPlan(committed, framework);
      if (plan.issues.length)
        throw new Error(`Native import plan rejected: ${plan.issues}`);
      // The build Workers Builds runs: the adapter's command (OpenNext for Next.js), none
      // for Python.
      if (plan.buildCommand) {
        const [command, ...args] = plan.buildCommand.split(' ');
        await run(command, args, options);
      }
      // The exact deploy command, with the repository's own Wrangler for `npx wrangler`.
      const deploy = deploymentCommand(
        plan.adapter,
        plan.workerName ?? `cc-kit-${framework}-0123456789ab`,
      ).split(' ');
      const [command, ...args] =
        deploy[0] === 'npx'
          ? [process.execPath, wrangler, ...deploy.slice(2)]
          : deploy;
      const containers = usesContainers(framework);
      // A kit whose configuration names a Dockerfile builds its image from it.
      const builds =
        containers &&
        containerDockerfiles(
          committed['wrangler.jsonc'] ?? committed['wrangler.json'],
        ).length > 0;
      let dryRun = 'needs Docker';
      if (docker || !builds) {
        const { stdout } = await run(
          command,
          [...args, '--dry-run', '--outdir', '.worker-check'],
          options,
        );
        for (const binding of resources
          ? ['env.DB  ', 'env.FILES  ']
          : framework === 'postgres'
            ? ['env.DB (']
            : containers
              ? ['Durable Object', 'The following containers are available']
              : [])
          if (!stdout.includes(binding))
            throw new Error(`Dry run is missing ${binding.trim()}`);
        dryRun = 'passed';
      }
      let localRun = 'needs Docker';
      if (docker || !containers) {
        await runLocally(cwd, plan.adapter, framework, 8800 + index);
        localRun = 'passed';
      }
      // The Postgres kit ships a placeholder Hyperdrive id, which its guard refuses until the
      // person puts in the id of a database added to the project. Check the refusal, then
      // stand in for that id.
      const kitConfigFile = (await read('wrangler.jsonc'))
        ? 'wrangler.jsonc'
        : 'wrangler.json';
      const kitConfig = JSON.parse(await read(kitConfigFile));
      let hyperdriveGuard = 'not applicable';
      if (kitConfig.hyperdrive?.some((h) => h.id === 'HYPERDRIVE_ID')) {
        hyperdriveGuard = await run('npm', ['run', 'predeploy'], options)
          .then(() => 'failed')
          .catch(() => 'passed');
        if (hyperdriveGuard !== 'passed')
          throw new Error('Placeholder Hyperdrive id did not block deployment');
        kitConfig.hyperdrive = kitConfig.hyperdrive.map((h) => ({
          ...h,
          id: h.id === 'HYPERDRIVE_ID' ? '0'.repeat(32) : h.id,
        }));
        await writeFile(join(cwd, kitConfigFile), JSON.stringify(kitConfig));
      }
      await run('npm', ['run', 'predeploy'], options);
      const configFile = (await read('wrangler.jsonc'))
        ? 'wrangler.jsonc'
        : 'wrangler.json';
      const config = JSON.parse(await read(configFile));
      let placeholderBlocked = 'not applicable';
      if (framework !== 'static') {
        config.d1_databases = [
          {
            binding: 'DB',
            database_id: 'REPLACE_WITH_YOUR_D1_DATABASE_ID',
          },
        ];
        await writeFile(join(cwd, configFile), JSON.stringify(config));
        placeholderBlocked = await run('npm', ['run', 'predeploy'], options)
          .then(() => 'failed')
          .catch(() => 'passed');
        if (placeholderBlocked !== 'passed')
          throw new Error('Placeholder D1 ID did not block deployment');
      }
      results.push({
        framework,
        adapter: plan.adapter,
        buildCommand: plan.buildCommand,
        draftResources: plan.resources,
        install: 'passed',
        build: plan.buildCommand ? 'passed' : 'not needed',
        nativePlan: 'passed',
        nativeDeployDryRun: dryRun,
        localRun,
        placeholderGuard: placeholderBlocked,
        hyperdriveGuard,
      });
      console.log(
        `${framework}: install, build, native plan, deploy dry run (${dryRun}), local run (${localRun}), and configuration guard passed`,
      );
    } finally {
      await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' });
    }
  }
  // A run of one kit (npm run verify:kits -- <framework>) leaves the recorded results alone.
  if (!process.argv[2])
    await writeFile(
      'docs/starter-kit-verification.json',
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          liveDeploymentTested: false,
          note: 'Builds, deploy dry runs, and local runs in Wrangler (pywrangler for Python) that request / and /api/health. No Cloudflare resources were created.',
          results,
        },
        null,
        2,
      ) + '\n',
    );
} finally {
  await rm(root, { recursive: true, force: true });
}
