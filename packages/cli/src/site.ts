// How a project folder is built before it deploys: the framework preset recognised from its
// root files (the same presets Shipcel's GitHub deployments use), the package manager's
// install and build commands, and the folder the build writes.
import {
  detectSite,
  lockfiles,
  packageManager,
  parseManifest,
  safeRelativePath,
  serverFrameworks,
  siteFiles,
  wranglerFiles,
} from '../../../shared/site-presets.ts';

export { packageManager };

export type Settings = {
  preset: string;
  // Shell commands run in the project's folder; null skips the step.
  installCommand: string | null;
  buildCommand: string | null;
  // The folder the build writes, relative to the project's folder ("." is the folder itself).
  outputDirectory: string;
  // Send unknown paths to index.html.
  spa: boolean;
};

// What a folder's files say. `settings` has no outputDirectory when Shipcel can't tell
// where the build goes; the person then names it.
export type Detection =
  | { kind: 'site'; settings: Settings }
  | { kind: 'other'; settings: Settings; note?: string }
  // Not something the CLI builds and uploads, unless the person names an output folder.
  | { kind: 'server'; settings: Settings; framework: string }
  | { kind: 'wrangler'; settings: Settings }
  | { kind: 'problem'; message: string }
  // Nothing to build: the folder deploys as it is.
  | { kind: 'none' };

// Site generators that aren't Node projects, recognised by their own files and folders.
// The CLI builds them with the tool installed on this computer.
const generatorFiles = [
  'hugo.toml',
  'hugo.yaml',
  'hugo.yml',
  'hugo.json',
  'config.toml',
  'config.yaml',
  'config.yml',
  '_config.yml',
  '_config.yaml',
  'mkdocs.yml',
  'Gemfile',
  'content',
  'archetypes',
  'layouts',
  'themes',
  'templates',
];
function generator(
  files: Record<string, string | null | undefined>,
): Settings | null {
  const has = (...names: string[]) => names.some((name) => files[name]);
  const site = (
    preset: string,
    buildCommand: string,
    outputDirectory: string,
  ): Settings => ({
    preset,
    installCommand: null,
    buildCommand,
    outputDirectory,
    spa: false,
  });
  if (has('_config.yml', '_config.yaml'))
    return site(
      'Jekyll',
      files.Gemfile ? 'bundle exec jekyll build' : 'jekyll build',
      '_site',
    );
  if (has('mkdocs.yml')) return site('MkDocs', 'mkdocs build', 'site');
  const hugo = site('Hugo', 'hugo --gc --minify', 'public');
  if (has('hugo.toml', 'hugo.yaml', 'hugo.yml', 'hugo.json')) return hugo;
  // Older Hugo sites and Zola sites both keep a config.toml next to content/.
  if (!has('config.toml', 'config.yaml', 'config.yml') || !has('content'))
    return null;
  if (has('archetypes', 'layouts', 'themes')) return hugo;
  return files['config.toml'] && has('templates')
    ? site('Zola', 'zola build', 'public')
    : null;
}

// The root files detection reads. Lockfiles and Wrangler files only need to exist.
export const detectionFiles = [
  'package.json',
  ...siteFiles,
  ...lockfiles,
  ...wranglerFiles,
  ...generatorFiles,
];
export const readInFull = (name: string) =>
  name === 'package.json' ||
  (siteFiles.includes(name) && name !== 'index.html');

const frameworkNames: Record<string, string> = {
  next: 'Next.js',
  '@sveltejs/kit': 'SvelteKit',
  nuxt: 'Nuxt',
  '@remix-run/dev': 'Remix',
  '@react-router/dev': 'React Router',
  '@analogjs/platform': 'Analog',
  '@angular/core': 'Angular',
  '@tanstack/react-start': 'TanStack Start',
  '@solidjs/start': 'SolidStart',
  '@builder.io/qwik-city': 'Qwik City',
};

export function detect(
  files: Record<string, string | null | undefined>,
): Detection {
  if (!files['package.json']) {
    // A Worker needs no package.json: its Wrangler configuration makes the folder an app.
    if (wranglerFiles.some((f) => files[f]))
      return {
        kind: 'wrangler',
        settings: {
          preset: 'Other',
          installCommand: null,
          buildCommand: null,
          outputDirectory: '',
          spa: false,
        },
      };
    const settings = generator(files);
    return settings ? { kind: 'site', settings } : { kind: 'none' };
  }
  const pkg = parseManifest(files['package.json']);
  if (!pkg) return { kind: 'none' };
  const manager = packageManager(files, pkg);
  const other: Settings = {
    preset: 'Other',
    installCommand: `${manager} install`,
    buildCommand: pkg.scripts?.build ? `${manager} run build` : null,
    outputDirectory: '',
    spa: false,
  };
  if (wranglerFiles.some((f) => files[f]))
    return { kind: 'wrangler', settings: other };
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const server = serverFrameworks.find((d) => dependencies[d]);
  if (server)
    return {
      kind: 'server',
      settings: other,
      framework: frameworkNames[server],
    };
  const found = detectSite(files, pkg);
  // Astro with server output or a server adapter: Wrangler's setup adds Cloudflare's.
  if (!found && dependencies.astro)
    return { kind: 'server', settings: other, framework: 'Astro' };
  // Plain HTML at the root needs no build: the folder deploys as it is.
  if (found?.site.preset === 'HTML') return { kind: 'none' };
  // Documentation sites are often built by a script named docs:build.
  const script = found?.site.script ?? 'build';
  if (!pkg.scripts?.[script])
    return found
      ? {
          kind: 'problem',
          message: `This looks like a ${found.site.preset} site, but package.json has no build script. Add one, for example "build": "vite build".`,
        }
      : { kind: 'none' };
  if (!found) return { kind: 'other', settings: other };
  const settings = {
    ...other,
    preset: found.site.preset,
    spa: found.site.spa,
    buildCommand: `${manager} run ${script}`,
  };
  return found.issues.length
    ? {
        kind: 'other',
        settings,
        note: `Shipcel couldn’t read where ${found.site.preset} writes the build.`,
      }
    : {
        kind: 'site',
        settings: { ...settings, outputDirectory: found.site.directory },
      };
}

// An output folder as typed: inside the project, "." for the project's own folder.
export function outputDirectory(value: string): string | null {
  const dir = value
    .trim()
    .replace(/^\.\/(?=.)/, '')
    .replace(/\/+$/, '');
  if (dir === '.' || dir === '') return dir === '.' ? '.' : null;
  return safeRelativePath(dir) ? dir : null;
}
