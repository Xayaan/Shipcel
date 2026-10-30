// Apps with code or bindings (a Wrangler configuration, or a framework that renders on a
// server): what the CLI sends Shipcel to review, and the Wrangler command it runs to deploy.
// Wrangler runs on this computer and reaches Cloudflare through Shipcel for that one
// deploy, so nothing has to be set up in Cloudflare and no Cloudflare token is kept here.
import {
  localPlanContents,
  localPlanFiles,
  localPlanLimit,
  reducedLockfile,
  WRANGLER_VERSION,
} from '../../../shared/local-deploy.ts';
import type { Manifest } from '../../../shared/site-presets.ts';

type Files = {
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
};
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// The root files Shipcel's review reads: contents for the ones it parses, "present" for
// the ones that only need to exist, and for package-lock.json the two versions it checks.
export async function planFiles(fs: Files, dir: string) {
  const files: Record<string, string | null> = {};
  for (const name of localPlanFiles) {
    const path = `${dir}/${name}`;
    if (!(await fs.exists(path))) files[name] = null;
    else if (name === 'package-lock.json')
      files[name] =
        reducedLockfile(decode(await fs.readFile(path))) ?? 'present';
    else if (!localPlanContents.includes(name)) files[name] = 'present';
    else if ((await fs.size(path)) > localPlanLimit(name))
      throw new Error(
        `${name} is larger than ${localPlanLimit(name) / 1000} KB, which is more than Shipcel reads.`,
      );
    else files[name] = decode(await fs.readFile(path));
  }
  return files;
}

// Always the Wrangler Shipcel is verified with, never the project's own: Wrangler's setup
// installs the newest one into a project, and Shipcel lets through only the calls it has
// seen that version make. npx runs the project's copy when it is this version, and fetches
// it once otherwise.
const wrangler = `npx --yes wrangler@${WRANGLER_VERSION}`;

// The command that deploys to production, or uploads a version that serves no traffic,
// with the same flags as Shipcel's GitHub deployments.
export function wranglerCommand(workerName: string, production: boolean) {
  if (!/^[a-z0-9-]{1,63}$/.test(workerName))
    throw new Error(`${workerName} is not a Worker name.`);
  return production
    ? `${wrangler} deploy --no-autoconfig --x-provision --x-auto-create --name ${workerName}`
    : `${wrangler} versions upload --x-provision --x-auto-create --name ${workerName} --message "Preview from Shipcel"`;
}

// Wrangler's own setup: it adds a framework's Cloudflare adapter and writes the Wrangler
// configuration. The person has agreed by the time it runs, so it asks nothing more.
export const setupCommand = `${wrangler} setup --yes`;

// Which framework a dry run of Wrangler's setup recognised, from the report it writes
// (WRANGLER_OUTPUT_FILE_PATH: one JSON object per line). "static" is its answer for a
// framework it has no adapter for.
export function setupFramework(report: string): string | null {
  for (const line of report.split('\n')) {
    try {
      const entry = JSON.parse(line) as {
        type?: unknown;
        summary?: { frameworkId?: unknown };
      };
      if (
        entry.type === 'autoconfig' &&
        typeof entry.summary?.frameworkId === 'string'
      )
        return entry.summary.frameworkId;
    } catch {
      /* Not a line of the report. */
    }
  }
  return null;
}

// Setup changes files in the project and nothing else. An adapter's installer may want
// more: OpenNext's offers a bucket for its cache, and Wrangler opens its own Cloudflare
// sign-in in the browser to create it. With a token that is good for nothing, and none of
// the person's own credentials, such a step fails at once and setup carries on. What the
// app needs is created during the deploy, after Shipcel's review.
export function setupEnv(): Record<string, string | undefined> {
  return {
    CLOUDFLARE_API_TOKEN: 'shipcel-setup-has-no-cloudflare-access',
    CLOUDFLARE_ACCOUNT_ID: undefined,
    CLOUDFLARE_API_KEY: undefined,
    CLOUDFLARE_EMAIL: undefined,
    CLOUDFLARE_API_BASE_URL: undefined,
    WRANGLER_API_ENVIRONMENT: undefined,
    WRANGLER_SEND_METRICS: 'false',
    CI: 'true',
  };
}

// Points Wrangler at Shipcel for this deploy. Anything on this computer that would make it
// talk to Cloudflare as someone else is taken out of its way; CI stops it from asking
// questions the deploy has already answered.
export function wranglerEnv(
  origin: string,
  session: { apiPath: string; token: string; accountId: string },
): Record<string, string | undefined> {
  return {
    CLOUDFLARE_API_BASE_URL: `${origin}${session.apiPath}`,
    CLOUDFLARE_API_TOKEN: session.token,
    CLOUDFLARE_ACCOUNT_ID: session.accountId,
    CLOUDFLARE_API_KEY: undefined,
    CLOUDFLARE_EMAIL: undefined,
    WRANGLER_API_ENVIRONMENT: undefined,
    WRANGLER_SEND_METRICS: 'false',
    CI: 'true',
  };
}

// The package managers a folder's lockfiles name. Wrangler's setup and shipcel choose
// between several differently (Wrangler takes pnpm or Yarn over npm), so a folder with more
// than one is stopped before setup.
const LOCKFILE_MANAGERS: Record<string, string> = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'Yarn',
  'bun.lock': 'Bun',
  'bun.lockb': 'Bun',
};
export function lockfileManagers(files: Record<string, string | null>) {
  return [
    ...new Set(
      Object.keys(LOCKFILE_MANAGERS)
        .filter((name) => files[name])
        .map((name) => LOCKFILE_MANAGERS[name]),
    ),
  ];
}

// Angular's server renders only for the hosts it is told about (its protection against
// requests that claim another host, since Angular 21.1.5), and Wrangler's setup tells it
// only localhost: on Cloudflare every page it renders would answer 400. The account's
// workers.dev addresses (production and previews alike end in .<subdomain>.workers.dev) go
// into angular.json's security.allowedHosts, which the build adds to the server's list.
// The new file, or null when there is nothing to change.
export function allowWorkersDev(angularJson: string, subdomain: string) {
  const host = `*.${subdomain}.workers.dev`;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(angularJson);
  } catch {
    return null;
  }
  const object = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  let changed = false;
  const projects = Object.fromEntries(
    Object.entries(object(config.projects) ?? {}).map(([name, value]) => {
      const project = object(value);
      const architect = object(project?.architect);
      const build = object(architect?.build);
      const options = object(build?.options);
      // Only an app that renders on a server.
      if (!project || !architect || !build || !options || !options.ssr)
        return [name, value];
      const security = object(options.security) ?? {};
      const hosts = Array.isArray(security.allowedHosts)
        ? (security.allowedHosts as unknown[])
        : [];
      if (hosts.includes(host)) return [name, value];
      changed = true;
      return [
        name,
        {
          ...project,
          architect: {
            ...architect,
            build: {
              ...build,
              options: {
                ...options,
                security: { ...security, allowedHosts: [...hosts, host] },
              },
            },
          },
        },
      ];
    }),
  );
  return changed
    ? { host, text: `${JSON.stringify({ ...config, projects }, null, 2)}\n` }
    : null;
}

// How an app builds before Wrangler deploys it, for `shipcel build`: Next.js through its
// OpenNext adapter, anything else through its build script.
export function appBuildCommand(pkg: Manifest | null, manager: string) {
  const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (dependencies.next && dependencies['@opennextjs/cloudflare'])
    return 'npx opennextjs-cloudflare build';
  return pkg?.scripts?.build ? `${manager} run build` : null;
}
