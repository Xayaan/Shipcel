// Sites that deploy without a Wrangler configuration, recognised from their root files like a
// Vercel framework preset. One list for both ways to deploy: Shipcel's GitHub pipeline, where
// Cloudflare builds the site (worker/repository-plan.ts), and the shipcel CLI, which builds
// it on the person's computer. No dependencies: the CLI bundles this file.

// `spa` sends unknown paths to index.html; otherwise they get 404.html.
export type Site = {
  preset: string;
  directory: string;
  spa: boolean;
  // 'npm': Shipcel installs with npm in the build command and turns Cloudflare's own
  // install off, because the repository also has another package manager's lockfile.
  install?: 'npm';
  // The package.json script that builds the site, when it isn't "build" (documentation
  // sites are usually set up with "docs:build").
  script?: string;
};
export type Manifest = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
};

// Files read to recognise a site and find its build folder.
export const siteFiles = [
  'index.html',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
  'vite.config.cjs',
  'astro.config.mjs',
  'astro.config.ts',
  'astro.config.js',
];
export const wranglerFiles = [
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
  'wrangler.config.ts',
  'cloudflare.config.ts',
];
export const lockfiles = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
// Frameworks that render on a server: they need their Cloudflare adapter, not a preset.
// Wrangler's setup adds it for each (Remix aside). Astro renders on a server only when its
// configuration says so (detectSite).
export const serverFrameworks = [
  'next',
  '@sveltejs/kit',
  'nuxt',
  '@remix-run/dev',
  '@react-router/dev',
  '@analogjs/platform',
  '@angular/core',
  '@tanstack/react-start',
  '@solidjs/start',
  '@builder.io/qwik-city',
];

// A relative path inside the project: no leading slash, no `..`.
export const safeRelativePath = (value: string) =>
  /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*$/.test(value) &&
  !value.split('/').includes('..');
// Strips comments, so commented-out examples in a configuration file are ignored.
export function stripComments(source: string) {
  // Block comments in one pass: a pattern would rescan the rest of the file for every
  // comment that is opened and never closed.
  let text = '';
  for (let from = 0; ;) {
    const open = source.indexOf('/*', from);
    const close = open === -1 ? -1 : source.indexOf('*/', open + 2);
    if (close === -1) {
      text += source.slice(from);
      break;
    }
    text += source.slice(from, open);
    from = close + 2;
  }
  return text.replace(/\/\/.*$/gm, '');
}
const literal = (value: string | undefined) =>
  value === undefined ? undefined : /^(['"`])([^'"`]*)\1$/.exec(value)?.[2];
const setting = (source: string, key: string) =>
  new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`).exec(source)?.[1]?.trim();

// package.json as far as presets read it; null when it isn't that shape.
export function parseManifest(source: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pkg = value as Record<string, unknown>;
  const strings = (v: unknown) =>
    v === undefined ||
    (!!v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.values(v).every((entry) => typeof entry === 'string'));
  if (
    !strings(pkg.scripts) ||
    !strings(pkg.dependencies) ||
    !strings(pkg.devDependencies) ||
    (pkg.packageManager !== undefined && typeof pkg.packageManager !== 'string')
  )
    return null;
  return pkg as Manifest;
}

// The package manager a project uses: the one package.json names, or its lockfile's. npm's
// lockfile wins next to another's, as in Shipcel's GitHub builds.
export function packageManager(
  files: Record<string, string | null | undefined>,
  pkg: Manifest | undefined,
) {
  const named = /^(npm|pnpm|yarn|bun)@/.exec(pkg?.packageManager ?? '')?.[1];
  if (named) return named;
  if (files['package-lock.json']) return 'npm';
  if (files['pnpm-lock.yaml']) return 'pnpm';
  if (files['yarn.lock']) return 'yarn';
  if (files['bun.lock'] || files['bun.lockb']) return 'bun';
  return 'npm';
}

// The preset for a project's root files (name → contents, null or absent when the file
// doesn't exist) and its parsed package.json. Null when the project isn't one: it has its own
// Wrangler configuration, a server framework, or nothing recognisable.
export function detectSite(
  files: Record<string, string | null | undefined>,
  pkg: Manifest | undefined,
  framework?: string,
): { site: Site; issues: string[] } | null {
  if (
    wranglerFiles.some((f) => files[f]) ||
    [
      'python',
      'docker',
      'umami',
      'n8n',
      'wordpress',
      'nextjs',
      'sveltekit',
    ].includes(framework ?? '')
  )
    return null;
  const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (serverFrameworks.some((d) => dependencies[d])) return null;
  const issues: string[] = [];
  if (dependencies.astro) {
    // Astro builds static files unless a server adapter or server output is configured.
    const config = stripComments(
      files['astro.config.mjs'] ??
        files['astro.config.ts'] ??
        files['astro.config.js'] ??
        '',
    );
    if (
      Object.keys(dependencies).some((d) =>
        /^@astrojs\/(cloudflare|node|vercel|netlify)$/.test(d),
      ) ||
      /\boutput\s*:\s*['"`](server|hybrid)['"`]/.test(config)
    )
      return null;
    return {
      site: { preset: 'Astro (static)', directory: 'dist', spa: false },
      issues,
    };
  }
  if (framework === 'astro') return null;
  if (dependencies['react-scripts'])
    return {
      site: { preset: 'Create React App', directory: 'build', spa: true },
      issues,
    };
  if (dependencies['@vue/cli-service'])
    return {
      site: { preset: 'Vue CLI', directory: 'dist', spa: true },
      issues,
    };
  if (dependencies.gatsby)
    return {
      site: { preset: 'Gatsby', directory: 'public', spa: false },
      issues,
    };
  if (dependencies['@docusaurus/core'])
    return {
      site: { preset: 'Docusaurus', directory: 'build', spa: false },
      issues,
    };
  // VitePress and VuePress build the folder their command names (`vitepress build docs`),
  // and write the site inside it.
  for (const [dependency, preset, hidden] of [
    ['vitepress', 'VitePress', '.vitepress'],
    ['vuepress', 'VuePress', '.vuepress'],
  ] as const) {
    if (!dependencies[dependency]) continue;
    const script = ['build', 'docs:build'].find((name) =>
      new RegExp(`\\b${dependency}\\s+build\\b`).test(
        pkg?.scripts?.[name] ?? '',
      ),
    );
    const source = new RegExp(
      `\\b${dependency}\\s+build(?:\\s+([^\\s-][^\\s]*))?`,
    ).exec(pkg?.scripts?.[script ?? 'build'] ?? '')?.[1];
    const directory = [
      source?.replace(/^\.\//, '').replace(/\/+$/, ''),
      hidden,
      'dist',
    ]
      .filter((part) => part && part !== '.')
      .join('/');
    if (!safeRelativePath(directory))
      issues.push(
        `Shipcel couldn’t read which folder ${preset} builds from the build script. Commit a wrangler.jsonc whose assets.directory is your build folder.`,
      );
    return {
      site: {
        preset,
        directory: safeRelativePath(directory) ? directory : `${hidden}/dist`,
        spa: false,
        ...(script && script !== 'build' ? { script } : {}),
      },
      issues,
    };
  }
  if (dependencies['@11ty/eleventy'])
    return {
      site: { preset: 'Eleventy', directory: '_site', spa: false },
      issues,
    };
  if (dependencies.vite) {
    // build.outDir (default dist) is relative to Vite's root (default the repository).
    const config = stripComments(
      ['ts', 'js', 'mjs', 'mts', 'cjs']
        .map((ext) => files[`vite.config.${ext}`])
        .find(Boolean) ?? '',
    );
    const [outDir, root] = [setting(config, 'outDir'), setting(config, 'root')];
    const [dir, base] = [literal(outDir), literal(root)];
    let directory = 'dist';
    if ((outDir && dir === undefined) || (root && base === undefined))
      issues.push(
        'Shipcel couldn’t read where Vite writes the build: build.outDir or root in vite.config isn’t a plain string. Commit a wrangler.jsonc whose assets.directory is your build folder.',
      );
    else {
      directory = [base, dir ?? 'dist']
        .filter((part) => part && part !== '.' && part !== './')
        .map((part) => part!.replace(/^\.\//, '').replace(/\/+$/, ''))
        .join('/');
      if (!safeRelativePath(directory) || directory.startsWith('/'))
        issues.push(
          'Vite’s build folder must be inside the repository: set build.outDir to a relative folder such as dist.',
        );
    }
    return { site: { preset: 'Vite', directory, spa: true }, issues };
  }
  // Build tools with one conventional output folder.
  for (const [dependency, preset, directory, spa] of [
    ['parcel', 'Parcel', 'dist', false],
    ['hexo', 'Hexo', 'public', false],
    ['gridsome', 'Gridsome', 'dist', false],
    ['ember-cli', 'Ember', 'dist', true],
    ['@stencil/core', 'Stencil', 'www', false],
    ['umi', 'UmiJS', 'dist', true],
    ['preact-cli', 'Preact CLI', 'build', true],
  ] as const)
    if (dependencies[dependency])
      return { site: { preset, directory, spa }, issues };
  // A plain website: HTML files at the root, published as they are.
  if (files['index.html'] && !pkg?.scripts?.build)
    return { site: { preset: 'HTML', directory: '.', spa: false }, issues };
  return null;
}
