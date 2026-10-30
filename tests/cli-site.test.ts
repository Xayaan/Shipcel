import { describe, expect, it } from 'vitest';
import {
  detect,
  outputDirectory,
  packageManager,
} from '../packages/cli/src/site';
import { githubRepository, parseRemotes } from '../packages/cli/src/git';
import {
  allowWorkersDev,
  appBuildCommand,
  lockfileManagers,
  planFiles,
  setupCommand,
  setupEnv,
  setupFramework,
  wranglerCommand,
  wranglerEnv,
} from '../packages/cli/src/app';
import { shell } from '../packages/cli/src/shell';
import { reducedLockfile } from '../shared/local-deploy';
import { parseManifest, stripComments } from '../shared/site-presets';
import { repositoryPlan } from '../worker/repository-plan';

const pkg = (value: Record<string, unknown>) => JSON.stringify(value);
const vite = pkg({
  scripts: { build: 'vite build' },
  devDependencies: { vite: '^8.0.0' },
});

describe('what the CLI builds, from a project’s root files', () => {
  it('recognises the presets Shipcel’s GitHub deployments use, with the same folders', () => {
    const cases: [Record<string, unknown>, string, string, boolean][] = [
      [{ devDependencies: { vite: '8' } }, 'Vite', 'dist', true],
      [
        { dependencies: { 'react-scripts': '5' } },
        'Create React App',
        'build',
        true,
      ],
      [
        { devDependencies: { '@vue/cli-service': '5' } },
        'Vue CLI',
        'dist',
        true,
      ],
      [{ dependencies: { astro: '7' } }, 'Astro (static)', 'dist', false],
      [{ dependencies: { gatsby: '^3.14.0' } }, 'Gatsby', 'public', false],
      [
        { dependencies: { '@docusaurus/core': '3' } },
        'Docusaurus',
        'build',
        false,
      ],
      [
        { devDependencies: { '@11ty/eleventy': '3' } },
        'Eleventy',
        '_site',
        false,
      ],
      [{ devDependencies: { parcel: '2' } }, 'Parcel', 'dist', false],
      [{ dependencies: { hexo: '7' } }, 'Hexo', 'public', false],
      [{ dependencies: { gridsome: '0.7' } }, 'Gridsome', 'dist', false],
      [{ devDependencies: { 'ember-cli': '6' } }, 'Ember', 'dist', true],
      [{ devDependencies: { '@stencil/core': '4' } }, 'Stencil', 'www', false],
      [{ dependencies: { umi: '4' } }, 'UmiJS', 'dist', true],
      [{ devDependencies: { 'preact-cli': '3' } }, 'Preact CLI', 'build', true],
      // A documentation site inside an app is the app: the more specific one wins.
      [
        { devDependencies: { vite: '8', parcel: '2', hexo: '7' } },
        'Vite',
        'dist',
        true,
      ],
    ];
    for (const [manifest, preset, directory, spa] of cases) {
      const files = {
        'package.json': pkg({ ...manifest, scripts: { build: 'build-it' } }),
        'package-lock.json': 'present',
      };
      expect(detect(files)).toEqual({
        kind: 'site',
        settings: {
          preset,
          installCommand: 'npm install',
          buildCommand: 'npm run build',
          outputDirectory: directory,
          spa,
        },
      });
      // The pipeline that builds in Cloudflare reads the same files the same way.
      expect(repositoryPlan(files).site).toMatchObject({
        preset,
        directory,
        spa,
      });
    }
  });

  it('builds documentation sites from the folder and script their own command names', () => {
    const docs = (
      scripts: Record<string, string>,
      dependency = 'vitepress',
    ) => ({
      'package.json': pkg({ scripts, devDependencies: { [dependency]: '1' } }),
      'pnpm-lock.yaml': 'present',
    });
    for (const [files, preset, buildCommand, directory] of [
      [
        docs({ 'docs:build': 'vitepress build docs' }),
        'VitePress',
        'pnpm run docs:build',
        'docs/.vitepress/dist',
      ],
      [
        docs({ build: 'vitepress build' }),
        'VitePress',
        'pnpm run build',
        '.vitepress/dist',
      ],
      [
        docs({ build: 'vitepress build ./guide/ --base /x/' }),
        'VitePress',
        'pnpm run build',
        'guide/.vitepress/dist',
      ],
      [
        docs({ 'docs:build': 'vuepress build docs' }, 'vuepress'),
        'VuePress',
        'pnpm run docs:build',
        'docs/.vuepress/dist',
      ],
      // VitePress brings Vite along; it is still a VitePress site.
      [
        {
          'package.json': pkg({
            scripts: { build: 'vitepress build site' },
            devDependencies: { vitepress: '1', vite: '8' },
          }),
        },
        'VitePress',
        'npm run build',
        'site/.vitepress/dist',
      ],
    ] as const) {
      expect(detect(files)).toMatchObject({
        kind: 'site',
        settings: {
          preset,
          buildCommand,
          outputDirectory: directory,
          spa: false,
        },
      });
      // Cloudflare's builds run the same script and serve the same folder.
      const plan = repositoryPlan({
        ...files,
        'pnpm-lock.yaml': null,
        'package-lock.json': 'present',
      });
      expect(plan.site).toMatchObject({ preset, directory });
      expect(plan.buildCommand).toBe(buildCommand.replace('pnpm', 'npm'));
      expect(plan.issues).toEqual([]);
    }
    // A folder outside the project, or no script that builds the docs.
    expect(
      detect(docs({ build: 'vitepress build ../elsewhere' })),
    ).toMatchObject({
      kind: 'other',
      note: 'Shipcel couldn’t read where VitePress writes the build.',
    });
    expect(
      repositoryPlan({
        ...docs({ build: 'vitepress build ../elsewhere' }),
        'pnpm-lock.yaml': null,
        'package-lock.json': 'present',
      }).issues.join(' '),
    ).toContain('couldn’t read which folder VitePress builds');
    expect(detect(docs({ dev: 'vitepress dev docs' }))).toMatchObject({
      kind: 'problem',
    });
  });

  it('recognises site generators that aren’t Node projects, by their own files', () => {
    const present = (...names: string[]) =>
      Object.fromEntries(names.map((name) => [name, 'present']));
    for (const [files, preset, buildCommand, directory] of [
      [present('hugo.toml'), 'Hugo', 'hugo --gc --minify', 'public'],
      [
        present('config.yaml', 'content', 'themes'),
        'Hugo',
        'hugo --gc --minify',
        'public',
      ],
      [
        present('config.toml', 'content', 'templates'),
        'Zola',
        'zola build',
        'public',
      ],
      [present('_config.yml'), 'Jekyll', 'jekyll build', '_site'],
      [
        present('_config.yml', 'Gemfile'),
        'Jekyll',
        'bundle exec jekyll build',
        '_site',
      ],
      [present('mkdocs.yml'), 'MkDocs', 'mkdocs build', 'site'],
    ] as const)
      expect(detect(files)).toEqual({
        kind: 'site',
        settings: {
          preset,
          installCommand: null,
          buildCommand,
          outputDirectory: directory,
          spa: false,
        },
      });
    // A config.toml alone says nothing; a Hugo site with both folders is Hugo.
    expect(detect(present('config.toml'))).toEqual({ kind: 'none' });
    expect(detect(present('config.toml', 'content'))).toEqual({ kind: 'none' });
    expect(
      detect(present('config.toml', 'content', 'templates', 'layouts')),
    ).toMatchObject({ settings: { preset: 'Hugo' } });
    // With a package.json, the project's own build script decides.
    expect(
      detect({
        ...present('_config.yml'),
        'package.json': pkg({ scripts: { build: 'make site' } }),
      }),
    ).toMatchObject({ kind: 'other' });
  });

  it('reads Vite’s build folder, and asks when it can’t', () => {
    expect(
      detect({
        'package.json': vite,
        'vite.config.ts':
          "export default { root: 'web', build: { outDir: 'out' } }",
      }),
    ).toMatchObject({ kind: 'site', settings: { outputDirectory: 'web/out' } });
    expect(
      detect({
        'package.json': vite,
        'vite.config.js': 'export default { build: { outDir: folder() } }',
      }),
    ).toEqual({
      kind: 'other',
      settings: {
        preset: 'Vite',
        installCommand: 'npm install',
        buildCommand: 'npm run build',
        outputDirectory: '',
        spa: true,
      },
      note: 'Shipcel couldn’t read where Vite writes the build.',
    });
  });

  it('uses the project’s own package manager, npm’s lockfile winning next to another', () => {
    const commands = (files: Record<string, string>) => {
      const found = detect({ 'package.json': vite, ...files });
      return found.kind === 'site'
        ? [found.settings.installCommand, found.settings.buildCommand]
        : null;
    };
    expect(commands({ 'pnpm-lock.yaml': 'present' })).toEqual([
      'pnpm install',
      'pnpm run build',
    ]);
    expect(commands({ 'yarn.lock': 'present' })).toEqual([
      'yarn install',
      'yarn run build',
    ]);
    expect(commands({ 'bun.lockb': 'present' })).toEqual([
      'bun install',
      'bun run build',
    ]);
    expect(
      commands({ 'yarn.lock': 'present', 'package-lock.json': 'present' }),
    ).toEqual(['npm install', 'npm run build']);
    expect(commands({})).toEqual(['npm install', 'npm run build']);
    // package.json's own choice comes first.
    expect(
      packageManager(
        { 'package-lock.json': 'present' },
        { packageManager: 'pnpm@10.2.0' },
      ),
    ).toBe('pnpm');
    expect(packageManager({}, { packageManager: 'deno@2' })).toBe('npm');
  });

  it('builds any project with a build script once its output folder is named', () => {
    expect(
      detect({
        'package.json': pkg({
          scripts: { build: 'node build.mjs' },
          devDependencies: { metalsmith: '2' },
        }),
        'yarn.lock': 'present',
      }),
    ).toEqual({
      kind: 'other',
      settings: {
        preset: 'Other',
        installCommand: 'yarn install',
        buildCommand: 'yarn run build',
        outputDirectory: '',
        spa: false,
      },
    });
  });

  it('leaves folders with nothing to build as they are', () => {
    expect(detect({})).toEqual({ kind: 'none' });
    expect(detect({ 'index.html': 'present' })).toEqual({ kind: 'none' });
    // Tooling only, no build: plain HTML, or nothing recognisable.
    expect(
      detect({
        'package.json': pkg({ devDependencies: { prettier: '3' } }),
        'index.html': 'present',
      }),
    ).toEqual({ kind: 'none' });
    expect(detect({ 'package.json': '{}' })).toEqual({ kind: 'none' });
    expect(detect({ 'package.json': 'not json' })).toEqual({ kind: 'none' });
  });

  it('says so when a preset has no build script', () => {
    const found = detect({
      'package.json': pkg({ dependencies: { gatsby: '3' } }),
    });
    expect(found.kind).toBe('problem');
    expect(found.kind === 'problem' && found.message).toContain(
      'Gatsby site, but package.json has no build script',
    );
  });

  it('doesn’t take server frameworks or Wrangler projects for static sites', () => {
    for (const [dependency, name] of [
      ['next', 'Next.js'],
      ['@sveltejs/kit', 'SvelteKit'],
      ['nuxt', 'Nuxt'],
      ['@remix-run/dev', 'Remix'],
      ['@react-router/dev', 'React Router'],
      ['@angular/core', 'Angular'],
      ['@tanstack/react-start', 'TanStack Start'],
      ['@solidjs/start', 'SolidStart'],
      ['@builder.io/qwik-city', 'Qwik City'],
    ]) {
      const found = detect({
        'package.json': pkg({
          scripts: { build: 'x' },
          dependencies: { [dependency]: '1', vite: '8' },
        }),
      });
      expect(found).toMatchObject({ kind: 'server', framework: name });
    }
    // Analog is built on Angular: named for itself.
    expect(
      detect({
        'package.json': pkg({
          scripts: { build: 'x' },
          dependencies: { '@angular/core': '21', '@analogjs/platform': '2' },
        }),
      }),
    ).toMatchObject({ kind: 'server', framework: 'Analog' });
    for (const config of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'])
      expect(detect({ 'package.json': vite, [config]: 'present' }).kind).toBe(
        'wrangler',
      );
    // Astro renders on a server with a server adapter, or with server output: Wrangler's
    // setup adds Cloudflare's adapter. Without either it is a static site.
    const astro = { scripts: { build: 'astro build' } };
    for (const [dependencies, config] of [
      [{ astro: '7', '@astrojs/cloudflare': '14' }, undefined],
      [{ astro: '7', '@astrojs/node': '10' }, undefined],
      [{ astro: '7' }, "export default defineConfig({ output: 'server' });"],
    ] as const)
      expect(
        detect({
          'package.json': pkg({ ...astro, dependencies }),
          ...(config ? { 'astro.config.mjs': config } : {}),
        }),
      ).toMatchObject({ kind: 'server', framework: 'Astro' });
    expect(
      detect({
        'package.json': pkg({ ...astro, dependencies: { astro: '7' } }),
        'astro.config.mjs': '// output: "server"\nexport default {};',
      }).kind,
    ).toBe('site');
  });

  it('accepts output folders inside the project only', () => {
    expect(outputDirectory('dist')).toBe('dist');
    expect(outputDirectory(' ./build/web/ ')).toBe('build/web');
    expect(outputDirectory('.')).toBe('.');
    expect(outputDirectory('./')).toBe('.');
    for (const bad of ['', '..', '../site', 'a/../../b', '/var/www', 'a b'])
      expect(outputDirectory(bad)).toBeNull();
  });

  it('reads package.json like the server does', () => {
    expect(parseManifest('{"scripts":{"build":"x"}}')).toEqual({
      scripts: { build: 'x' },
    });
    for (const bad of [
      'null',
      '[]',
      '"text"',
      '{"scripts":{"build":1}}',
      '{"dependencies":[]}',
      '{"devDependencies":"x"}',
      '{"packageManager":3}',
      '{',
    ])
      expect(parseManifest(bad)).toBeNull();
    // What the server refuses to read as a manifest gets no preset from it either.
    expect(
      repositoryPlan({ 'package.json': '{"scripts":{"build":1}}' }).site,
    ).toBeUndefined();
  });
});

describe('what the CLI gives Wrangler to deploy an app', () => {
  // A folder as a map of paths to contents.
  const folder = (entries: Record<string, string>) => ({
    exists: async (path: string) => path in entries,
    size: async (path: string) => entries[path].length,
    readFile: async (path: string) => new TextEncoder().encode(entries[path]),
  });

  it('sends the files a review reads, and of a lockfile only what it needs', async () => {
    const lock = JSON.stringify({
      packages: {
        'node_modules/next': { version: '16.3.8', integrity: 'sha512-x' },
        'node_modules/left-pad': { version: '1.3.0' },
      },
    });
    const files = await planFiles(
      folder({
        '/app/package.json': '{"name":"app"}',
        '/app/wrangler.jsonc': '{"name":"app"}',
        '/app/package-lock.json': lock,
        '/app/pnpm-lock.yaml': 'lockfileVersion: 9',
        '/app/.env': 'SECRET=1',
        '/app/src/index.ts': 'export default {}',
      }),
      '/app',
    );
    expect(files).toMatchObject({
      'package.json': '{"name":"app"}',
      'wrangler.jsonc': '{"name":"app"}',
      'wrangler.json': null,
      'pnpm-lock.yaml': 'present',
      'package-lock.json':
        '{"packages":{"node_modules/next":{"version":"16.3.8"}}}',
    });
    // Nothing else in the folder is read, let alone sent.
    expect(JSON.stringify(files)).not.toMatch(/SECRET|left-pad|export default/);
    expect(reducedLockfile('not json')).toBeNull();
    await expect(
      planFiles(folder({ '/app/wrangler.jsonc': ' '.repeat(200_001) }), '/app'),
    ).rejects.toThrow('wrangler.jsonc is larger than 200 KB');
    // Next.js's own configuration is sent in whichever form the project has it: the
    // review looks there for settings its Cloudflare adapter can't run yet.
    for (const name of ['next.config.ts', 'next.config.mjs', 'next.config.js'])
      expect(
        (
          await planFiles(
            folder({ [`/app/${name}`]: 'module.exports = {};' }),
            '/app',
          )
        )[name],
      ).toBe('module.exports = {};');
    // A framework's configuration is read as text, and only a small one.
    await expect(
      planFiles(folder({ '/app/vite.config.ts': ' '.repeat(50_001) }), '/app'),
    ).rejects.toThrow('vite.config.ts is larger than 50 KB');
  });

  it('takes comments out of a configuration in one pass, however it is written', () => {
    expect(
      stripComments(
        'a /* one */ b /* two\nlines */ c // rest\nd /* never closed // x\ne',
      ),
    ).toBe('a  b  c \nd /* never closed \ne');
    expect(stripComments('/**/x/*/ y */z')).toBe('xz');
    expect(stripComments('no comments')).toBe('no comments');
    // Thousands of comments opened and never closed don't slow it down.
    const started = Date.now();
    expect(stripComments('/* x '.repeat(40_000))).toHaveLength(200_000);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('takes a folder with a Wrangler configuration for an app, with or without a package.json', () => {
    expect(detect({ 'wrangler.jsonc': 'present' })).toEqual({
      kind: 'wrangler',
      settings: {
        preset: 'Other',
        installCommand: null,
        buildCommand: null,
        outputDirectory: '',
        spa: false,
      },
    });
    expect(
      detect({ 'wrangler.toml': 'present', 'index.html': 'present' }).kind,
    ).toBe('wrangler');
    expect(
      detect({
        'package.json': pkg({ scripts: { build: 'node build.js' } }),
        'wrangler.json': 'present',
      }),
    ).toMatchObject({
      kind: 'wrangler',
      settings: {
        installCommand: 'npm install',
        buildCommand: 'npm run build',
      },
    });
    // Without either, a folder is what it was: files to upload.
    expect(detect({ 'index.html': 'present' }).kind).toBe('none');
  });

  it('runs a quiet command without showing what it prints, unless it fails', async () => {
    const shown: string[] = [];
    const show = (output: Uint8Array) =>
      shown.push(new TextDecoder().decode(output));
    const node = (script: string) => `"${process.execPath}" -e "${script}"`;
    const cwd = process.cwd();
    expect(
      await shell(node("console.log('all fine')"), cwd, {}, true, show),
    ).toBe(0);
    expect(shown).toEqual([]);
    expect(
      await shell(
        node("console.log('to out'); console.error('to err'); process.exit(3)"),
        cwd,
        {},
        true,
        show,
      ),
    ).toBe(3);
    expect(shown.join('')).toContain('to out');
    expect(shown.join('')).toContain('to err');
    // The environment it is given: names added, and names taken out.
    process.env.CLOUDCEL_SHELL_TEST = 'inherited';
    try {
      const check =
        "process.exit(process.env.ADDED === 'x' && process.env.CLOUDCEL_SHELL_TEST === undefined ? 0 : 5)";
      expect(
        await shell(
          node(check),
          cwd,
          { ADDED: 'x', CLOUDCEL_SHELL_TEST: undefined },
          true,
          show,
        ),
      ).toBe(0);
      expect(await shell(node(check), cwd, { ADDED: 'x' }, true, show)).toBe(5);
    } finally {
      delete process.env.CLOUDCEL_SHELL_TEST;
    }
    // A command that isn't there fails like any other.
    expect(
      await shell('shipcel-no-such-command-here', cwd, {}, true, show),
    ).not.toBe(0);
  });

  it('always runs the Wrangler Shipcel is verified with, and sets a project up without reaching Cloudflare', () => {
    // The flags Shipcel's GitHub deployments use. A project's own Wrangler is never run.
    expect(wranglerCommand('my-app', true)).toBe(
      'npx --yes wrangler@4.156.0 deploy --no-autoconfig --x-provision --x-auto-create --name my-app',
    );
    expect(wranglerCommand('my-app', false)).toBe(
      'npx --yes wrangler@4.156.0 versions upload --x-provision --x-auto-create --name my-app --message "Preview from Shipcel"',
    );
    // A name is only ever a Worker name: nothing else reaches the shell.
    for (const name of [
      'my app',
      'x; rm -rf ~',
      '$(id)',
      '',
      'a'.repeat(64),
      'App',
    ])
      expect(() => wranglerCommand(name, true)).toThrow('is not a Worker name');
    // What a dry run of the setup reports (the lines are Wrangler 4.148's own): a framework
    // it has an adapter for, or "static" for one it would deploy as files.
    const report = (frameworkId: string, config: object) =>
      `${JSON.stringify({ type: 'wrangler-session', version: 1, wrangler_version: '4.156.0', command_line_args: ['setup', '--yes', '--dry-run'] })}\n${JSON.stringify({ type: 'autoconfig', version: 1, command: 'setup', summary: { scripts: {}, wranglerConfig: config, outputDir: 'public', frameworkId, buildCommand: 'npm run build' } })}\n`;
    expect(
      setupFramework(
        report('react-router', { name: 'app', main: './workers/app.ts' }),
      ),
    ).toBe('react-router');
    expect(
      setupFramework(
        report('static', { name: 'app', assets: { directory: 'public' } }),
      ),
    ).toBe('static');
    for (const unreadable of [
      '',
      'not json\n',
      '{"type":"wrangler-session"}\n',
      '{"type":"autoconfig","summary":{}}\n',
      '{"type":"autoconfig","summary":{"frameworkId":7}}\n',
      '{"type":"deploy","summary":{"frameworkId":"next"}}\n',
    ])
      expect([unreadable, setupFramework(unreadable)]).toEqual([
        unreadable,
        null,
      ]);
    // Setup asks nothing more, and can neither sign in to Cloudflare nor use a sign-in or
    // token the person has on this computer.
    expect(setupCommand).toBe('npx --yes wrangler@4.156.0 setup --yes');
    const env = setupEnv();
    expect(env).toMatchObject({
      CLOUDFLARE_API_TOKEN: 'shipcel-setup-has-no-cloudflare-access',
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    });
    for (const name of [
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_KEY',
      'CLOUDFLARE_EMAIL',
      'CLOUDFLARE_API_BASE_URL',
      'WRANGLER_API_ENVIRONMENT',
    ])
      expect([name, name in env && env[name] === undefined]).toEqual([
        name,
        true,
      ]);
  });

  it('points Wrangler at Shipcel with the deploy’s own token, and nothing of the person’s', () => {
    expect(
      wranglerEnv('https://shipcel.example', {
        apiPath: '/api/wrangler/abc/client/v4',
        token: 'session-token',
        accountId: 'a'.repeat(32),
      }),
    ).toEqual({
      CLOUDFLARE_API_BASE_URL:
        'https://shipcel.example/api/wrangler/abc/client/v4',
      CLOUDFLARE_API_TOKEN: 'session-token',
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_KEY: undefined,
      CLOUDFLARE_EMAIL: undefined,
      WRANGLER_API_ENVIRONMENT: undefined,
      WRANGLER_SEND_METRICS: 'false',
      CI: 'true',
    });
  });

  it('builds an app the way its deploy would', () => {
    expect(
      appBuildCommand(
        { dependencies: { next: '16', '@opennextjs/cloudflare': '1' } },
        'pnpm',
      ),
    ).toBe('npx opennextjs-cloudflare build');
    expect(
      appBuildCommand(
        { scripts: { build: 'next build' }, dependencies: { next: '16' } },
        'pnpm',
      ),
    ).toBe('pnpm run build');
    expect(appBuildCommand({ scripts: { dev: 'x' } }, 'npm')).toBeNull();
    expect(appBuildCommand(null, 'npm')).toBeNull();
  });
});

describe('the GitHub repository a folder’s Git remotes name', () => {
  it('reads remotes from .git/config', () => {
    expect(
      parseRemotes(
        [
          '[core]',
          '\trepositoryformatversion = 0',
          '[remote "origin"]',
          '\turl = git@github.com:ada/site.git',
          '\tfetch = +refs/heads/*:refs/remotes/origin/*',
          '[branch "main"]',
          '\tremote = origin',
          '\turl = https://example.com/not-a-remote',
          '[remote "upstream"]',
          '  url=https://github.com/team/site',
          '',
        ].join('\r\n'),
      ),
    ).toEqual([
      { name: 'origin', url: 'git@github.com:ada/site.git' },
      { name: 'upstream', url: 'https://github.com/team/site' },
    ]);
    expect(parseRemotes('')).toEqual([]);
  });

  it('names GitHub repositories in every form git writes, and nothing else', () => {
    for (const remote of [
      'https://github.com/ada/my-site.git',
      'https://github.com/ada/my-site',
      'https://github.com/ada/my-site/',
      'git@github.com:ada/my-site.git',
      'ssh://git@github.com/ada/my-site.git',
      'ssh://git@ssh.github.com:443/ada/my-site.git',
      'git://github.com/ada/my-site.git',
      // A remote can carry a token; it never appears in what the CLI prints.
      'https://x-access-token:ghs_secret@github.com/ada/my-site.git',
    ])
      expect(githubRepository(remote)).toBe('ada/my-site');
    expect(githubRepository('https://github.com/ada/site.js.git')).toBe(
      'ada/site.js',
    );
    for (const remote of [
      'https://gitlab.com/ada/my-site.git',
      'git@bitbucket.org:ada/my-site.git',
      'https://github.com.evil.example/ada/my-site.git',
      'https://github.com/ada',
      'https://github.com/ada/my-site/extra',
      '/srv/git/my-site.git',
      'not a url',
    ])
      expect(githubRepository(remote)).toBeNull();
  });
});

describe('after Wrangler’s setup', () => {
  it('adds the account’s workers.dev addresses to an Angular server’s hosts once', () => {
    const angular = {
      version: 1,
      projects: {
        shop: {
          architect: {
            build: {
              options: {
                ssr: { entry: 'src/server.ts' },
                security: { allowedHosts: ['shop.example.com'] },
              },
            },
          },
        },
      },
    };
    const first = allowWorkersDev(JSON.stringify(angular), 'ada');
    expect(first?.host).toBe('*.ada.workers.dev');
    expect(
      JSON.parse(first!.text).projects.shop.architect.build.options.security,
    ).toEqual({ allowedHosts: ['shop.example.com', '*.ada.workers.dev'] });
    expect(first!.text.endsWith('}\n')).toBe(true);
    // Run again, nothing to add; a file that isn't JSON is left alone.
    expect(allowWorkersDev(first!.text, 'ada')).toBeNull();
    expect(allowWorkersDev('{ not json', 'ada')).toBeNull();
    expect(
      allowWorkersDev(JSON.stringify({ projects: { x: 'odd' } }), 'ada'),
    ).toBeNull();
  });

  it('names each package manager a folder’s lockfiles belong to once', () => {
    expect(
      lockfileManagers({
        'package-lock.json': '{}',
        'pnpm-lock.yaml': 'present',
        'yarn.lock': null,
      }),
    ).toEqual(['npm', 'pnpm']);
    expect(
      lockfileManagers({ 'bun.lock': 'present', 'bun.lockb': 'present' }),
    ).toEqual(['Bun']);
    expect(lockfileManagers({})).toEqual([]);
  });
});
