import { z } from 'zod';
import { parse, type ParseError } from 'jsonc-parser';
import type {
  ContainerRequest,
  ResourceRequest,
} from '../shared/deployment-plan';
import { usesContainers, type FrameworkId } from '../shared/catalog.ts';
import {
  detectSite,
  lockfiles,
  packageManager,
  stripComments,
  type Site,
} from '../shared/site-presets.ts';

import {
  NEXT_CACHE_BINDING,
  NEXT_STATIC_CACHE_DIR,
  PYTHON_WRANGLER_VERSION,
  UV_VERSION,
  WRANGLER_VERSION,
  type OpenNextCache,
} from '../shared/local-deploy.ts';

export { siteFiles, type Site } from '../shared/site-presets.ts';

const manifestSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  packageManager: z.string().optional(),
  workspaces: z.unknown().optional(),
});
const binding = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const safePath = z
  .string()
  .regex(/^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*$/)
  .refine((v) => !v.split('/').includes('..'));
const draftD1 = z
  .object({ binding, migrations_dir: safePath.optional() })
  .strict();
const draftBinding = z.object({ binding }).strict();
// A Postgres or MySQL database added to the project (worker/hyperdrive.ts), bound by the id
// of its Hyperdrive configuration. `localConnectionString` is for Wrangler's local runtime
// only; it stays in the folder.
const hyperdriveBinding = z
  .object({
    binding,
    id: z.string().regex(/^[\w-]{1,128}$/),
    localConnectionString: z.string().optional(),
  })
  .strict();
export type HyperdriveBinding = { binding: string; id: string };
// Framework adapters build from a committed Cloudflare configuration.
// Fixture evidence for each one: docs/framework-verification.json.
const frameworkAdapters: Record<
  string,
  {
    packages: [string, string];
    setup: string;
    // The same step for an app deployed from its folder with the shipcel CLI.
    localSetup: string;
    entry?: string;
    build?: string;
    // Deploy under the configured name; OpenNext binds the Worker to itself by that name.
    keepsName?: boolean;
    extraKeys?: string[];
  }
> = {
  astro: {
    packages: ['astro', '@astrojs/cloudflare'],
    // Entry point written by `wrangler setup` for @astrojs/cloudflare 14.
    entry: '@astrojs/cloudflare/entrypoints/server',
    setup:
      'Configure the Astro Cloudflare adapter once: run `npx wrangler setup` in the repository, review the changes, and commit them with package-lock.json.',
    localSetup:
      'Add the Astro Cloudflare adapter: run `npx astro add cloudflare` in this folder, then deploy again.',
  },
  sveltekit: {
    packages: ['@sveltejs/kit', '@sveltejs/adapter-cloudflare'],
    setup:
      'Configure @sveltejs/adapter-cloudflare in the SvelteKit Vite plugin, then commit a root wrangler.jsonc whose main is .svelte-kit/cloudflare/_worker.js and whose assets directory is .svelte-kit/cloudflare, together with package-lock.json. Wrangler 4.148 automatic setup does not support SvelteKit 3.',
    localSetup:
      'Add the SvelteKit Cloudflare adapter: install @sveltejs/adapter-cloudflare, use it in svelte.config.js (or the SvelteKit Vite plugin), and add a wrangler.jsonc whose main is .svelte-kit/cloudflare/_worker.js and whose assets directory is .svelte-kit/cloudflare. Then deploy again.',
  },
  nextjs: {
    packages: ['next', '@opennextjs/cloudflare'],
    setup:
      'Configure the OpenNext Cloudflare adapter once: run `npx wrangler setup` in the repository, review the changes (wrangler.jsonc, open-next.config.ts, package.json), and commit them with package-lock.json.',
    localSetup:
      'Add the OpenNext Cloudflare adapter: run `npx wrangler setup` in this folder (it adds wrangler.jsonc, open-next.config.ts and the adapter package), then deploy again.',
    build: 'npx opennextjs-cloudflare build',
    keepsName: true,
    extraKeys: ['services', 'images'],
  },
};
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A Worker name the owner chooses; its free address is <name>.<subdomain>.workers.dev.
export const appName = z
  .string()
  .regex(
    workerNamePattern,
    'Use 1 to 63 lowercase letters, numbers, and hyphens, starting and ending with a letter or number.',
  );
const className = z.string().regex(/^[A-Za-z_$][\w$]{0,99}$/);
const buildVars = z.record(z.string(), z.string());
// A registry image with a host and a tag or digest, e.g. docker.io/library/nginx:1.27.
const registryImage =
  /^[a-z0-9.-]+(?::\d+)?(?:\/[\w.-]+)+(?::[\w.-]+(?:@sha256:[a-f0-9]{64})?|@sha256:[a-f0-9]{64})$/i;
// Container settings this adapter accepts. SSH access, placement constraints, affinities
// and unsafe settings need separate review.
const defaultContainer = z
  .object({
    class_name: className,
    image: z.string().min(1).max(512),
    name: z.string().min(1).max(200).optional(),
    scheduling_policy: z.literal('default').optional(),
    max_instances: z.number().int().positive().optional(),
    instance_type: z
      .union([
        z.enum([
          'lite',
          'basic',
          'standard-1',
          'standard-2',
          'standard-3',
          'standard-4',
        ]),
        z
          .object({
            vcpu: z.number().positive().optional(),
            memory_mib: z.number().int().positive().optional(),
            disk_mb: z.number().int().positive().optional(),
          })
          .strict(),
      ])
      .optional(),
    image_build_context: safePath.optional(),
    image_vars: buildVars.optional(),
    rollout_step_percentage: z
      .union([z.number(), z.array(z.number())])
      .optional(),
    rollout_active_grace_period: z.number().nonnegative().optional(),
    observability: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
// Durable Object-managed containers (beta): the Durable Object starts its container.
const managedContainer = z
  .object({
    class_name: className,
    scheduling_policy: z.literal('durable_object'),
    name: z.string().min(1).max(200).optional(),
    images: z.record(
      z.string().regex(/^[\w-]{1,64}$/),
      z.union([
        z
          .object({
            dockerfile: z.string().min(1).max(512),
            build_context: safePath.optional(),
            build_vars: buildVars.optional(),
          })
          .strict(),
        z.object({ image: z.string().min(1).max(512) }).strict(),
      ]),
    ),
    observability: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const migration = z
  .object({
    tag: z.string().min(1).max(100),
    new_classes: z.array(className).optional(),
    new_sqlite_classes: z.array(className).optional(),
    renamed_classes: z
      .array(z.object({ from: className, to: className }).strict())
      .optional(),
    deleted_classes: z.array(className).optional(),
  })
  .strict();
const durableObjectExport = z.union([
  z
    .object({
      type: z.literal('durable-object'),
      storage: z.enum(['sqlite', 'legacy-kv']),
      state: z.literal('created').optional(),
      container: z.string().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('durable-object'), state: z.literal('deleted') })
    .strict(),
  z
    .object({
      type: z.literal('durable-object'),
      state: z.literal('renamed'),
      renamed_to: className,
    })
    .strict(),
]);
// Wrangler builds Dockerfile images; any other image is a registry reference (it needs a tag).
function containerImages(entry: unknown) {
  if (!entry || typeof entry !== 'object') return [];
  const c = entry as { image?: unknown; images?: unknown };
  if (typeof c.image === 'string')
    return [{ image: c.image, dockerfile: !c.image.includes(':') }];
  return Object.values(
    c.images && typeof c.images === 'object' ? c.images : {},
  ).flatMap((i: { dockerfile?: unknown; image?: unknown }) =>
    typeof i?.dockerfile === 'string'
      ? [{ image: i.dockerfile, dockerfile: true }]
      : typeof i?.image === 'string'
        ? [{ image: i.image, dockerfile: false }]
        : [],
  );
}
const dockerfilePath = (image: string) => image.replace(/^\.\//, '');
// Dockerfiles the control plane checks at the inspected commit (relative to the root config).
export function containerDockerfiles(source: string | null | undefined) {
  const config = source
    ? parse(source, [], { allowTrailingComma: true })
    : undefined;
  const entries = Array.isArray(config?.containers) ? config.containers : [];
  return [
    ...new Set(
      entries
        .flatMap(containerImages)
        .filter(
          (i: { image: string; dockerfile: boolean }) =>
            i.dockerfile && safePath.safeParse(i.image).success,
        )
        .map((i: { image: string }) => dockerfilePath(i.image)),
    ),
  ].slice(0, 10) as string[];
}
// Containers run as Durable Objects of this Worker. Returns what the review shows and adds
// issues for settings that reach other Workers or that Shipcel has not verified.
function inspectContainers(
  config: Record<string, unknown>,
  files: Record<string, string | null>,
  issues: string[],
  warnings: string[],
  names: Set<string>,
) {
  const entries = Array.isArray(config.containers) ? config.containers : [];
  if (!entries.length || entries.length > 5) {
    issues.push(
      'Declare one to five containers in the Wrangler configuration. Choose another runtime for a repository without containers.',
    );
    return [];
  }
  const containers: ContainerRequest[] = [];
  let built = false,
    pulled = false;
  for (const entry of entries) {
    const managed = entry?.scheduling_policy === 'durable_object';
    const label =
      typeof entry?.class_name === 'string' ? entry.class_name : 'a container';
    const shape = managed ? managedContainer.shape : defaultContainer.shape;
    const unsupported =
      entry && typeof entry === 'object'
        ? Object.keys(entry).filter((key) => !(key in shape))
        : [];
    if (unsupported.length) {
      issues.push(
        `Container ${label} uses settings this adapter does not support: ${unsupported.join(', ')}. SSH access, placement and unsafe settings need separate setup.`,
      );
      continue;
    }
    const parsed = managed
      ? managedContainer.safeParse(entry)
      : defaultContainer.safeParse(entry);
    if (!parsed.success) {
      issues.push(
        `Container settings for ${label} are not valid. Check class_name, the image settings, instance_type and max_instances.`,
      );
      continue;
    }
    const images = containerImages(entry);
    for (const { image, dockerfile } of images) {
      if (!dockerfile) {
        if (registryImage.test(image)) pulled = true;
        else
          issues.push(
            `Use a Dockerfile path or a registry image with a tag for ${label} (${image}).`,
          );
      } else if (!safePath.safeParse(image).success)
        issues.push(
          `Use a Dockerfile path within the repository for ${label} (${image}).`,
        );
      else if (!files[dockerfilePath(image)])
        issues.push(
          `Commit ${image}: Wrangler builds the ${label} image from it, but it is not in the repository at the inspected commit.`,
        );
      else built = true;
    }
    // Wrangler's defaults: lite instances, at most 20 at once.
    const scheduled = managed ? null : defaultContainer.parse(entry);
    const size = scheduled?.instance_type;
    containers.push({
      className: parsed.data.class_name,
      policy: managed ? 'durable_object' : 'default',
      images: images.map((i) => i.image),
      instanceType: !scheduled
        ? null
        : typeof size === 'object'
          ? `custom (${size.vcpu ?? 0.0625} vCPU, ${size.memory_mib ?? 256} MiB memory, ${size.disk_mb ?? 2000} MB disk)`
          : (size ?? 'lite'),
      maxInstances: scheduled ? (scheduled.max_instances ?? 20) : null,
    });
  }
  const bindings = config.durable_objects as { bindings?: unknown } | undefined;
  const durableObjects = z
    .object({
      bindings: z
        .array(z.object({ name: binding, class_name: className }).strict())
        .max(10),
    })
    .strict()
    .safeParse(bindings ?? { bindings: [] });
  if (!durableObjects.success)
    issues.push(
      Array.isArray(bindings?.bindings) &&
        bindings.bindings.some(
          (b: { script_name?: unknown; environment?: unknown }) =>
            b?.script_name !== undefined || b?.environment !== undefined,
        )
        ? 'Durable Object bindings to another Worker (script_name) are not supported: each container must run in this Worker.'
        : 'Use durable_objects.bindings entries with only a binding name and class_name.',
    );
  else {
    for (const b of durableObjects.data.bindings) {
      if (names.has(b.name.toLowerCase()))
        issues.push(
          'Binding names must be unique, including when compared without letter case.',
        );
      names.add(b.name.toLowerCase());
    }
    const unbound = containers.filter(
      (c) =>
        !durableObjects.data.bindings.some((b) => b.class_name === c.className),
    );
    if (unbound.length)
      issues.push(
        `Bind each container class as a Durable Object in durable_objects.bindings so the Worker can reach it (missing: ${unbound.map((c) => c.className).join(', ')}).`,
      );
  }
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  const exported = Object.values(
    config.exports && typeof config.exports === 'object' ? config.exports : {},
  ) as { state?: unknown }[];
  if (
    migrations.some((m) => m?.transferred_classes !== undefined) ||
    exported.some((e) =>
      ['transferred', 'expecting-transfer'].includes(String(e?.state)),
    )
  )
    issues.push(
      "Durable Object transfers between Workers (transferred_classes, or exports in a transfer state) are not supported: they move another Worker's stored data.",
    );
  else if (
    (config.migrations !== undefined &&
      !z.array(migration).max(100).safeParse(config.migrations).success) ||
    (config.exports !== undefined &&
      !z.record(className, durableObjectExport).safeParse(config.exports)
        .success)
  )
    issues.push(
      'Durable Object migrations and exports may only create, rename or delete classes of this Worker. Other exports, such as Workflows, need separate setup.',
    );
  warnings.push(
    'Containers need the Workers Paid plan. Cloudflare bills container vCPU, memory, disk and egress beyond the included amounts to your account; max_instances limits how many instances run at once.',
  );
  if (built)
    warnings.push(
      "Each production deploy builds the Dockerfile images in Workers Builds and pushes them to your account's container registry. Your build token must be allowed to manage Containers; if the first build fails with an authorization error, add that permission to the token in Cloudflare.",
    );
  if (pulled)
    warnings.push(
      'Cloudflare pulls registry images during deployment. Shipcel does not check that the registry allows it or that the image is built for linux/amd64.',
    );
  if (containers.some((c) => c.policy === 'durable_object'))
    warnings.push(
      'Durable Object-managed containers (scheduling_policy durable_object) are a Cloudflare beta. Your Durable Object code starts each container and chooses its instance type.',
    );
  if (config.migrations !== undefined || config.exports !== undefined)
    warnings.push(
      'Wrangler applies Durable Object migrations on every deploy. Deleting a class permanently deletes its stored data.',
    );
  warnings.push(
    'A first container deployment can take several minutes while Cloudflare provisions the image. Shipcel checks the homepage for up to 15 minutes before asking you to review it.',
  );
  return containers;
}
// Settings of Cloudflare's platform this adapter reviews for every runtime.
const platformKeys = [
  'vars',
  'ai',
  'browser',
  'images',
  'version_metadata',
  'placement',
  'triggers',
  'durable_objects',
  'migrations',
  'send_email',
];
// Settings Wrangler reads only while it builds and bundles, on the person's own computer.
// They change nothing about what the Worker can reach, so a local deploy accepts them.
const localBuildKeys = [
  'upload_source_maps',
  'minify',
  'no_bundle',
  'rules',
  'find_additional_modules',
  'preserve_file_names',
  'base_dir',
  'define',
  'alias',
  'tsconfig',
  'jsx_factory',
  'jsx_fragment',
  'build',
  'dev',
  'send_metrics',
  'keep_vars',
  'limits',
];
const bindingOnly = z.object({ binding }).strict();
const varName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const plainVars = (value: unknown) =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.entries(value as object).every(
    ([k, v]) =>
      varName.test(k) && ['string', 'number', 'boolean'].includes(typeof v),
  );
// Five fields (minute hour day month weekday), as Cloudflare's Cron Triggers accept them.
export const cronExpression = z
  .string()
  .max(100)
  .regex(/^[\dA-Za-z*,/?#LW-]+( [\dA-Za-z*,/?#LW-]+){4}$/);
const durableObjectBindings = z
  .object({
    bindings: z
      .array(z.object({ name: binding, class_name: className }).strict())
      .max(10),
  })
  .strict();
// Free-plan Durable Objects store data in SQLite; renaming and deleting stay in this Worker.
const sqliteMigration = z
  .object({
    tag: z.string().min(1).max(100),
    new_sqlite_classes: z.array(className).optional(),
    renamed_classes: z
      .array(z.object({ from: className, to: className }).strict())
      .optional(),
    deleted_classes: z.array(className).optional(),
  })
  .strict();
export type PreviewBindings = {
  ai?: { binding: string };
  browser?: { binding: string };
  images?: { binding: string };
  version_metadata?: { binding: string };
  vars?: Record<string, string | number | boolean>;
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  // The same Hyperdrive databases as production (worker/previews.ts adds them).
  hyperdrive?: HyperdriveBinding[];
};
// Workers AI, browser rendering, Images, version metadata, variables, Smart Placement, cron
// schedules and (outside the container adapter, which reviews its own) Durable Objects.
// Returns the bindings Previews need declared again.
function inspectPlatform(
  config: Record<string, unknown>,
  issues: string[],
  warnings: string[],
  names: Set<string>,
  container: boolean,
): PreviewBindings {
  const found: PreviewBindings = {};
  const claim = (name: string) => {
    if (names.has(name.toLowerCase()))
      issues.push(
        'Binding names must be unique, including when compared without letter case.',
      );
    names.add(name.toLowerCase());
  };
  for (const key of ['ai', 'browser', 'images', 'version_metadata'] as const) {
    if (config[key] === undefined) continue;
    const parsed = bindingOnly.safeParse(config[key]);
    if (!parsed.success) {
      issues.push(`Use ${key} with only a binding name.`);
      continue;
    }
    claim(parsed.data.binding);
    found[key] = { binding: parsed.data.binding };
  }
  if (found.ai)
    warnings.push(
      'Workers AI runs on Cloudflare’s free allocation of 10,000 Neurons a day; on Workers Paid, usage beyond it is billed. Some models need Workers Paid.',
    );
  if (found.browser)
    warnings.push(
      'Browser rendering on the free plan allows 10 minutes a day and 3 browsers at once.',
    );
  // Cloudflare's Email Service, by binding name only: it sends from a domain onboarded for
  // Email Sending. Email Routing's limits to verified addresses aren't reviewed here.
  if (config.send_email !== undefined) {
    const sends = z
      .array(z.object({ name: binding }).strict())
      .max(5)
      .safeParse(config.send_email);
    if (!sends.success)
      issues.push(
        'Use send_email with entries of only a name, such as { "name": "EMAIL" }.',
      );
    else if (sends.data.length) {
      for (const b of sends.data) claim(b.name);
      warnings.push(
        'Cloudflare’s Email Service sends from a domain onboarded for Email Sending in Cloudflare’s dashboard. Workers Paid includes 3,000 emails a month, then $0.35 per 1,000; Workers Free doesn’t send.',
      );
    }
  }
  if (config.vars !== undefined) {
    if (!plainVars(config.vars))
      issues.push(
        'Use vars with names of letters, digits and underscores, and plain text, number or true/false values.',
      );
    else {
      found.vars = config.vars as PreviewBindings['vars'];
      for (const name of Object.keys(found.vars!)) claim(name);
    }
  }
  if (
    config.placement !== undefined &&
    !z
      .object({ mode: z.literal('smart') })
      .strict()
      .safeParse(config.placement).success
  )
    issues.push('Use placement with only mode "smart" (Smart Placement).');
  if (config.triggers !== undefined) {
    const triggers = z
      .object({ crons: z.array(cronExpression).max(5) })
      .strict()
      .safeParse(config.triggers);
    if (!triggers.success)
      issues.push(
        'Use triggers.crons with up to five cron expressions of five fields (minute hour day month weekday), in UTC.',
      );
    else if (triggers.data.crons.length)
      warnings.push(
        'Cloudflare runs cron schedules in UTC, and allows 5 cron triggers per account on the free plan (250 on Workers Paid). Your Worker needs a scheduled() handler; each run counts as a request.',
      );
  }
  if (container) return found;
  if (config.durable_objects === undefined && config.migrations === undefined)
    return found;
  const bound = durableObjectBindings.safeParse(
    config.durable_objects ?? { bindings: [] },
  );
  const raw = (config.durable_objects as { bindings?: unknown } | undefined)
    ?.bindings;
  if (!bound.success) {
    issues.push(
      Array.isArray(raw) &&
        raw.some(
          (b: { script_name?: unknown; environment?: unknown }) =>
            b?.script_name !== undefined || b?.environment !== undefined,
        )
        ? 'Durable Object bindings to another Worker (script_name) are not supported: bind classes of this Worker.'
        : 'Use durable_objects.bindings entries with only a binding name and class_name.',
    );
    return found;
  }
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  if (migrations.some((m) => m?.transferred_classes !== undefined)) {
    issues.push(
      "Durable Object transfers between Workers (transferred_classes) are not supported: they move another Worker's stored data.",
    );
    return found;
  }
  if (migrations.some((m) => m?.new_classes !== undefined)) {
    issues.push(
      'Use new_sqlite_classes for Durable Objects: the free plan stores their data in SQLite, and key-value storage (new_classes) needs Workers Paid.',
    );
    return found;
  }
  const parsed = z
    .array(sqliteMigration)
    .max(100)
    .safeParse(config.migrations ?? []);
  if (!parsed.success) {
    issues.push(
      'Durable Object migrations may only create (new_sqlite_classes), rename or delete classes of this Worker.',
    );
    return found;
  }
  const created = new Set<string>(),
    deleted = new Set<string>();
  for (const m of parsed.data) {
    for (const c of m.new_sqlite_classes ?? []) created.add(c);
    for (const r of m.renamed_classes ?? []) {
      created.delete(r.from);
      created.add(r.to);
    }
    for (const c of m.deleted_classes ?? []) {
      created.delete(c);
      deleted.add(c);
    }
  }
  for (const b of bound.data.bindings) {
    claim(b.name);
    if (!created.has(b.class_name))
      issues.push(
        `Add a migration that creates ${b.class_name} (new_sqlite_classes) before binding it.`,
      );
  }
  if (bound.data.bindings.length)
    found.durable_objects = { bindings: bound.data.bindings };
  warnings.push(
    'Durable Objects run on the free plan with SQLite storage: 100,000 requests and 13,000 GB-seconds a day. Wrangler applies their migrations on every deploy.',
  );
  if (deleted.size)
    warnings.push(
      'Deleting a Durable Object class permanently deletes its stored data.',
    );
  return found;
}

// The `dependencies` array of pyproject.toml's [project] table.
function projectDependencies(source: string) {
  const table = source
    .split(/^\[/m)
    .find((block) => block.startsWith('project]'));
  const list = table?.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1];
  return list ? [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [];
}
const r2BucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// From this compatibility date Python Workers get their `workers` module from the
// workers-py package, which pywrangler includes when it deploys (checked locally with
// Wrangler 4.148: plain Wrangler starts the Worker at 2026-04-20 and fails at 2026-04-21).
const PYTHON_EXTERNAL_SDK = '2026-04-21';
const declaresWorkersPy = (pyproject: string) =>
  /["']workers-py(?=[\s"'<>=!~;[])/.test(pyproject);
// The exact version npm locked for a package (package-lock.json v2 and v3).
function lockedVersion(lock: string | null | undefined, name: string) {
  try {
    const version = JSON.parse(lock ?? '')?.packages?.[`node_modules/${name}`]
      ?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}
const atLeast = (version: string, minimum: string) => {
  const parts = (v: string) => v.split('-')[0].split('.').map(Number);
  const [a, b] = [parts(version), parts(minimum)];
  for (let i = 0; i < 3; i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};
// Strips comments so commented-out examples in open-next.config.ts are ignored.
const code = stripComments;

// The runtime a repository uses, read from its root files, so a new GitHub project starts
// with it; null leaves the choice to the person. Containers and Python come first: their
// Workers often depend on a JavaScript framework too.
export function detectFramework(
  files: Record<string, string | null>,
): FrameworkId | null {
  const object = (source: string | null | undefined) => {
    const errors: ParseError[] = [];
    const value = source
      ? parse(source, errors, { allowTrailingComma: true })
      : null;
    return errors.length ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
      ? null
      : (value as Record<string, unknown>);
  };
  const config = object(files['wrangler.jsonc'] ?? files['wrangler.json']);
  const pkg = manifestSchema.safeParse(object(files['package.json']));
  const dependencies = pkg.success
    ? { ...pkg.data.dependencies, ...pkg.data.devDependencies }
    : {};
  if (Array.isArray(config?.containers) && config.containers.length)
    return 'docker';
  if (typeof config?.main === 'string' && config.main.endsWith('.py'))
    return 'python';
  if (!config && !pkg.success && files['pyproject.toml']) return 'python';
  for (const [dependency, framework] of [
    ['next', 'nextjs'],
    ['astro', 'astro'],
    ['@sveltejs/kit', 'sveltekit'],
    ['react', 'react'],
    ['vue', 'vue'],
    ['hono', 'hono'],
  ] as const)
    if (dependencies[dependency]) return framework;
  if (config && !config.main && config.assets) return 'static';
  // Plain HTML files, published as they are.
  if (!config && !pkg.success && files['index.html']) return 'static';
  return config || pkg.success ? 'worker' : null;
}

// A site deployed without a Wrangler configuration of its own, like a Vercel framework
// preset (shared/site-presets.ts, which the shipcel CLI reads too): Cloudflare builds it,
// then deploys `directory` as static assets with a configuration Shipcel writes during the
// build (deploymentCommand).
// The build variable that turns off Workers Builds' automatic dependency install
// (developers.cloudflare.com/workers/ci-cd/builds/build-image/).
export const skipInstall = {
  SKIP_DEPENDENCY_INSTALL: { value: '1', is_secret: false },
};

function staticSite(
  files: Record<string, string | null>,
  framework?: string,
): { site: Site; issues: string[] } | null {
  let pkg: z.infer<typeof manifestSchema> | undefined;
  if (files['package.json'])
    try {
      pkg = manifestSchema.parse(JSON.parse(files['package.json']));
    } catch {
      return null;
    }
  return detectSite(files, pkg, framework);
}

// The plan for a site without a Wrangler configuration. Any package manager installs it;
// Cloudflare's build runs `npm run build`, which only runs the script.
function sitePlan(
  files: Record<string, string | null>,
  found: { site: Site; issues: string[] },
) {
  const { site } = found;
  const issues = [...found.issues],
    warnings: string[] = [];
  let pkg: z.infer<typeof manifestSchema> | undefined;
  try {
    pkg = manifestSchema.parse(JSON.parse(files['package.json'] || 'null'));
  } catch {
    pkg = undefined;
  }
  const build = site.preset !== 'HTML';
  const script = site.script ?? 'build';
  if (build && !pkg?.scripts?.[script])
    issues.push(
      'Add a build script to package.json that builds the site, for example "build": "vite build".',
    );
  if (pkg?.workspaces !== undefined)
    issues.push(
      'Workspace/monorepo imports need a root-directory adapter. Import a standalone app for now.',
    );
  const managers = new Set(
    lockfiles
      .filter((f) => files[f])
      .map((f) => (f.startsWith('bun.') ? 'bun' : f)),
  );
  // npm's lockfile next to another: install with npm, whichever Cloudflare would pick.
  const npm = managers.size > 1 && managers.has('package-lock.json');
  if (npm)
    warnings.push(
      `This repository has ${[...managers].join(' and ')}. Shipcel installs with npm from package-lock.json and turns off Cloudflare’s own install, so the build doesn’t depend on which one Cloudflare would pick. Remove the lockfile you don’t use.`,
    );
  else if (managers.size > 1)
    issues.push(
      `Keep one package manager’s lockfile; this repository has ${[...managers].join(' and ')}.`,
    );
  else if (pkg && !managers.size)
    warnings.push(
      'Commit a lockfile so every build installs the same dependency versions.',
    );
  warnings.push(
    `No Wrangler configuration needed: Shipcel deploys ${site.directory === '.' ? 'the repository’s files' : `${site.directory}/`} as ${site.spa ? 'a single-page app' : 'a static site'} (${site.preset}), with a configuration it writes during the build. Commit a wrangler.jsonc to change how the site is served.`,
  );
  if (site.directory === '.')
    warnings.push(
      'Every file in the repository is published except .git, .github, node_modules and Wrangler’s own files.',
    );
  warnings.push(
    'Only deploy trusted repositories. Future production-branch changes run with your Cloudflare build token and may change configuration or incur charges.',
  );
  return {
    adapter: 'static-assets',
    buildCommand: build
      ? `${npm ? 'npm install --no-audit --no-fund && ' : ''}npm run ${script}`
      : '',
    resources: [] as ResourceRequest[],
    containers: [] as ContainerRequest[],
    warnings,
    issues,
    workerName: undefined as string | undefined,
    openNextCache: undefined as OpenNextCache | undefined,
    previews: undefined as unknown,
    previewUrls: undefined as boolean | undefined,
    previewBindings: {} as PreviewBindings,
    site: (npm ? { ...site, install: 'npm' } : site) as Site | undefined,
  };
}

// Pure inspection only: no repository code executes in the control plane.
// `local`: the app is built and deployed from a person's computer by the shipcel CLI, not
// by Cloudflare's builds. Any package manager installs it and nothing has to be committed;
// what the Worker may reach is reviewed the same way.
// OpenNext's caches (https://opennext.js.org/cloudflare/caching) as open-next.config.ts
// names them, and the binding each one reads (@opennextjs/cloudflare 1.20.14,
// dist/api/overrides). Shipcel reads the file and never runs it. An R2 cache is filled with
// what Next.js prerendered after a production deploy from the terminal or GitHub Actions
// (packages/cli/src/opennext.ts); a cache in the app's own files goes up with them.
const openNextBindings: Record<
  string,
  { key: 'r2_buckets' | 'kv_namespaces'; binding: string }
> = {
  r2IncrementalCache: { key: 'r2_buckets', binding: NEXT_CACHE_BINDING },
  kvIncrementalCache: { key: 'kv_namespaces', binding: 'NEXT_INC_CACHE_KV' },
  kvNextTagCache: { key: 'kv_namespaces', binding: 'NEXT_TAG_CACHE_KV' },
};
const openNextObjects: Record<string, { binding: string; className: string }> =
  {
    doQueue: { binding: 'NEXT_CACHE_DO_QUEUE', className: 'DOQueueHandler' },
    doShardedTagCache: {
      binding: 'NEXT_TAG_CACHE_DO_SHARDED',
      className: 'DOShardedTagCache',
    },
  };
const incrementalCaches: Record<string, OpenNextCache> = {
  r2IncrementalCache: 'r2',
  kvIncrementalCache: 'kv',
  staticAssetsIncrementalCache: 'static-assets',
};
export function openNextCacheReview(
  source: string,
  config: Record<string, unknown>,
  local: boolean,
) {
  const uses = (name: string) => new RegExp(`\\b${name}\\b`).test(source);
  const sets = (option: string) => new RegExp(`\\b${option}\\s*:`).test(source);
  const issues: string[] = [],
    warnings: string[] = [];
  if (uses('d1NextTagCache'))
    issues.push(
      'OpenNext’s D1 tag cache needs its table made on every deploy, which Shipcel doesn’t do. Use doShardedTagCache (Durable Objects), which needs nothing at deploy.',
    );
  if (sets('cachePurge') || uses('purgeCache'))
    issues.push(
      'OpenNext’s cache purge (cachePurge) needs a zone and an API token as secrets, which Shipcel doesn’t set up yet. Remove it from open-next.config.ts.',
    );
  const caches = Object.keys(incrementalCaches).filter(uses);
  if (sets('incrementalCache') && !caches.length)
    issues.push(
      'Shipcel knows OpenNext’s r2IncrementalCache, kvIncrementalCache and staticAssetsIncrementalCache. Use one of them as incrementalCache.',
    );
  if (caches.length > 1)
    issues.push(
      `open-next.config.ts names more than one incremental cache (${caches.join(', ')}). Keep one.`,
    );
  if (
    sets('tagCache') &&
    !['doShardedTagCache', 'kvNextTagCache', 'd1NextTagCache'].some(uses)
  )
    issues.push(
      'Shipcel knows OpenNext’s doShardedTagCache and kvNextTagCache. Use one of them as tagCache.',
    );
  if (sets('queue') && !['doQueue', 'memoryQueue', 'queueCache'].some(uses))
    issues.push(
      'Shipcel knows OpenNext’s doQueue, memoryQueue and queueCache. Use one of them as queue.',
    );
  for (const [name, { key, binding }] of Object.entries(openNextBindings))
    if (
      uses(name) &&
      !(Array.isArray(config[key]) ? config[key] : []).some(
        (b: { binding?: unknown } | null) => b?.binding === binding,
      )
    )
      issues.push(
        `${name} reads the binding ${binding}: add { "binding": "${binding}" } to ${key} in the Wrangler configuration, and Cloudflare creates it on the first deploy.`,
      );
  const objects = (config.durable_objects as { bindings?: unknown } | undefined)
    ?.bindings;
  for (const [name, { binding, className }] of Object.entries(openNextObjects))
    if (
      uses(name) &&
      !(Array.isArray(objects) ? objects : []).some(
        (b: { name?: unknown; class_name?: unknown } | null) =>
          b?.name === binding && b?.class_name === className,
      )
    )
      issues.push(
        `${name} reads the Durable Object binding ${binding}: add { "name": "${binding}", "class_name": "${className}" } to durable_objects.bindings, with a migration that creates ${className} (new_sqlite_classes). OpenNext's worker exports the class.`,
      );
  const cache = caches.length === 1 ? incrementalCaches[caches[0]] : undefined;
  if (cache === 'r2')
    warnings.push(
      local
        ? `OpenNext keeps ISR and data-cache entries in the R2 bucket bound as ${NEXT_CACHE_BINDING}. After each production deploy Shipcel fills it with the pages Next.js prerendered. R2 is free up to 10 GB-month, 1 million writes and 10 million reads a month.`
        : `OpenNext keeps ISR and data-cache entries in the R2 bucket bound as ${NEXT_CACHE_BINDING}. Cloudflare’s builds deploy it without filling it, so each page is cached on its first request; deploys from GitHub Actions or the terminal fill it with what Next.js prerendered. R2 is free up to 10 GB-month, 1 million writes and 10 million reads a month.`,
    );
  if (cache === 'kv')
    warnings.push(
      'OpenNext keeps entries in a KV namespace, which is eventually consistent: a revalidated page can take up to a minute to reach every location. Shipcel fills only an R2 cache at deploy, so each page is cached on its first request.',
    );
  if (cache === 'static-assets')
    warnings.push(
      'OpenNext serves the pages Next.js prerendered from the app’s own files, which go up with each deploy. That cache can’t change between deploys, so pages that revalidate render again each time.',
    );
  return { cache, issues, warnings };
}

export function repositoryPlan(
  files: Record<string, string | null>,
  framework?: string,
  { local = false }: { local?: boolean } = {},
) {
  const found = staticSite(files, framework);
  if (found) return sitePlan(files, found);
  const issues: string[] = [],
    warnings: string[] = [],
    resources: ResourceRequest[] = [];
  let frameworkAdapter = framework ? frameworkAdapters[framework] : undefined;
  // A folder's own configuration says how it deploys: without the framework's Cloudflare
  // adapter installed it is a plain Worker or site (a static export, for example).
  if (local && frameworkAdapter && files['package.json']) {
    try {
      const manifest = manifestSchema.parse(JSON.parse(files['package.json']));
      if (
        !{ ...manifest.dependencies, ...manifest.devDependencies }[
          frameworkAdapter.packages[1]
        ] &&
        (files['wrangler.json'] || files['wrangler.jsonc'])
      ) {
        frameworkAdapter = undefined;
        framework = undefined;
      }
    } catch {
      /* Reported below as an invalid package.json. */
    }
  }
  // Python Workers: projects with packages, or that declare workers-py, deploy with
  // pywrangler, which needs uv and a pinned Wrangler from package.json. Plain Wrangler runs
  // package-free Workers only before PYTHON_EXTERNAL_SDK or with the runtime's own SDK.
  const python = framework === 'python';
  const pyproject = files['pyproject.toml'] ?? '';
  const pythonPackages =
    python &&
    (projectDependencies(pyproject).length > 0 || declaresWorkersPy(pyproject));
  const npmOptional =
    (python && !pythonPackages && !files['package.json']) ||
    (local && !files['package.json']);
  // Containers deploy under the configured name: Wrangler names container applications after it.
  const container = usesContainers(framework);
  const keepsName = container || Boolean(frameworkAdapter?.keepsName);
  const adapter = python
    ? pythonPackages
      ? 'python-packages'
      : 'python'
    : container
      ? 'container'
      : frameworkAdapter
        ? framework!
        : 'configured-worker';
  let containers: ContainerRequest[] = [];
  let pkg: z.infer<typeof manifestSchema> | undefined;
  // Settings for Worker Previews, reviewed when previews are turned on (previewsBlockIssues).
  let previews: unknown, previewUrls: boolean | undefined;
  // Bindings that touch no shared data, which Previews need declared again.
  let previewBindings: PreviewBindings = {};
  if (!npmOptional)
    try {
      pkg = manifestSchema.parse(JSON.parse(files['package.json'] || 'null'));
    } catch {
      issues.push(
        pythonPackages
          ? 'Commit a package.json with wrangler in devDependencies so pywrangler uses a pinned Wrangler.'
          : 'Commit a valid package.json at the repository root.',
      );
    }
  if (!local && pkg?.workspaces !== undefined)
    issues.push(
      'Workspace/monorepo imports need a root-directory adapter. Import a standalone npm app for now.',
    );
  if (!local && pkg?.packageManager && !/^npm@\d/.test(pkg.packageManager))
    issues.push('This adapter requires npm and package-lock.json.');
  if (!local && !npmOptional && !files['package-lock.json'])
    issues.push(
      'Commit package-lock.json so the native npm build is reproducible.',
    );
  if (pythonPackages) {
    if (!files['uv.lock'])
      issues.push('Commit uv.lock so Python packages install reproducibly.');
    if (!declaresWorkersPy(pyproject))
      issues.push(
        'Add workers-py to a dev dependency group in pyproject.toml; pywrangler comes from it.',
      );
    const wranglerVersion = {
      ...pkg?.dependencies,
      ...pkg?.devDependencies,
    }.wrangler;
    if (pkg && !wranglerVersion)
      issues.push(
        'Add wrangler to package.json devDependencies and commit package-lock.json, so pywrangler uses a pinned Wrangler instead of the latest.',
      );
    else if (wranglerVersion && wranglerVersion !== PYTHON_WRANGLER_VERSION)
      warnings.push(
        `Shipcel verified Python packages with Wrangler ${PYTHON_WRANGLER_VERSION}; other versions are untested.`,
      );
    warnings.push(
      'Only pure-Python and Pyodide-compatible packages work on Python Workers; others fail during the build.',
    );
  }
  if (
    !local &&
    ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'].some(
      (f) => files[f],
    )
  )
    issues.push(
      'Remove competing package-manager lockfiles before using the npm adapter.',
    );
  if (
    ['wrangler.toml', 'wrangler.config.ts', 'cloudflare.config.ts'].some(
      (f) => files[f],
    )
  )
    issues.push(
      local
        ? 'Shipcel reads wrangler.json or wrangler.jsonc. Move the settings of wrangler.toml (or a programmatic configuration) into a wrangler.jsonc, remove the old file, and deploy again.'
        : 'This import path requires root Wrangler JSON/JSONC; TOML and programmatic configuration need a separate adapter.',
    );
  if (files['wrangler.json'] && files['wrangler.jsonc'])
    issues.push('Keep only one root Wrangler JSON/JSONC configuration.');
  const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const setup = frameworkAdapter
    ? local
      ? frameworkAdapter.localSetup
      : frameworkAdapter.setup
    : undefined;
  if (frameworkAdapter) {
    const [core, cloudflare] = frameworkAdapter.packages;
    if (!dependencies[core])
      issues.push(
        `This repository does not depend on ${core}. Choose the runtime that matches the repository.`,
      );
    else if (!dependencies[cloudflare]) issues.push(setup!);
    if (!pkg?.scripts?.build)
      issues.push('Add an npm build script that builds the framework.');
  }
  // pywrangler bundles Python packages during deploy; plain Python needs no build step.
  // A local build runs the script with the project's own package manager.
  let buildCommand = python
    ? ''
    : (frameworkAdapter?.build ??
      (pkg?.scripts?.build
        ? `${local ? packageManager(files, pkg) : 'npm'} run build`
        : ''));
  let workerName: string | undefined;
  let openNextCache: OpenNextCache | undefined;
  const source = files['wrangler.json'] || files['wrangler.jsonc'];
  if (!source) {
    if (!setup || !issues.includes(setup))
      issues.push(
        setup ??
          (local
            ? 'Add a wrangler.jsonc to this folder that names the Worker’s entry point (main) or its static files (assets).'
            : 'Commit a wrangler.json or wrangler.jsonc at the repository root.'),
      );
  } else {
    const errors: ParseError[] = [];
    const config = parse(source, errors, { allowTrailingComma: true });
    if (
      errors.length ||
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config)
    ) {
      issues.push('Wrangler configuration is not valid JSON/JSONC.');
    } else {
      const allowed = new Set([
        '$schema',
        'name',
        'main',
        'compatibility_date',
        'compatibility_flags',
        'assets',
        'observability',
        'workers_dev',
        'd1_databases',
        'r2_buckets',
        'kv_namespaces',
        'hyperdrive',
        'preview_urls',
        'previews',
        ...platformKeys,
        ...(frameworkAdapter?.extraKeys ?? []),
        ...(container ? ['containers', 'exports', 'upload_source_maps'] : []),
        // A Worker may call itself (OpenNext does); checked below.
        ...(local ? [...localBuildKeys, 'services'] : []),
      ]);
      const unsupported = Object.keys(config).filter(
        (key) => !allowed.has(key),
      );
      if (!container && config.containers !== undefined)
        issues.push(
          local
            ? 'This app declares containers, whose images Cloudflare’s builds make and push. Deploy it from GitHub: shipcel git connect.'
            : 'This repository declares containers. Create a project with the Docker / custom runtime to deploy it.',
        );
      else if (unsupported.length)
        issues.push(
          local
            ? `Shipcel doesn’t deploy these Wrangler settings yet: ${unsupported.join(', ')}. It deploys Workers and static assets with new D1, R2 and KV resources (declared by binding name only), Postgres and MySQL through Hyperdrive (shipcel hyperdrive add), variables, Workers AI, browser rendering, Images, cron schedules and SQLite Durable Objects; add a custom domain with shipcel domains add.`
            : 'Unsupported Wrangler settings. This adapter accepts Workers/Assets, draft D1/R2/KV bindings and the Hyperdrive databases added to the project; routes, environments, existing resource IDs and containers require separate setup.',
        );
      if (!config.main && !config.assets)
        issues.push(
          'Wrangler configuration needs a Worker entry point or static assets.',
        );
      // Wrangler resolves these paths itself on the person's computer.
      if (
        !local &&
        config.main &&
        config.main !== frameworkAdapter?.entry &&
        !safePath.safeParse(config.main).success
      )
        issues.push('Use a relative Worker entry point within the repository.');
      if (
        !local &&
        config.assets &&
        (typeof config.assets !== 'object' ||
          !safePath.safeParse(config.assets.directory).success)
      )
        issues.push('Use an assets directory within the repository.');
      if (local && adapter !== 'nextjs' && config.services !== undefined) {
        const services = z
          .array(z.object({ binding, service: z.string() }).strict())
          .max(5)
          .safeParse(config.services);
        if (
          !services.success ||
          services.data.some((s) => s.service !== config.name)
        )
          issues.push(
            'Service bindings may only point to this Worker itself (the name in its configuration). Bindings to other Workers aren’t deployed by Shipcel yet.',
          );
      }
      if (python) {
        if (typeof config.main !== 'string' || !config.main.endsWith('.py'))
          issues.push('Set main to the Python entry point (a .py file).');
        if (
          !Array.isArray(config.compatibility_flags) ||
          !config.compatibility_flags.includes('python_workers')
        )
          issues.push('Add python_workers to compatibility_flags.');
        if (
          !pythonPackages &&
          typeof config.compatibility_date === 'string' &&
          config.compatibility_date >= PYTHON_EXTERNAL_SDK &&
          !config.compatibility_flags?.includes?.('disable_python_external_sdk')
        )
          issues.push(
            `From compatibility date ${PYTHON_EXTERNAL_SDK}, Python Workers get the \`workers\` module from the workers-py package, which pywrangler includes when it deploys; plain Wrangler can't run them. Add a pyproject.toml with workers-py as a dev dependency and commit uv.lock (\`uvx --from workers-py pywrangler init\` sets this up), or use an earlier compatibility date.`,
          );
        if (
          pythonPackages &&
          files['wrangler.json'] &&
          !files['wrangler.jsonc']
        )
          issues.push(
            'pywrangler reads wrangler.jsonc, not wrangler.json: rename the configuration file to wrangler.jsonc.',
          );
      }
      if (config.workers_dev === false)
        issues.push(
          local
            ? 'Remove "workers_dev": false: the app’s free address is its workers.dev address. Turn the address off later with shipcel unpublish.'
            : 'Enable workers_dev for the initial health-checked deployment.',
        );
      if (
        config.preview_urls !== undefined &&
        typeof config.preview_urls !== 'boolean'
      )
        issues.push('Set preview_urls to true or false.');
      else previewUrls = config.preview_urls;
      previews = config.previews;
      const names = new Set<string>(
        config.assets?.binding
          ? [String(config.assets.binding).toLowerCase()]
          : [],
      );
      if (container)
        containers = inspectContainers(config, files, issues, warnings, names);
      previewBindings = inspectPlatform(
        config,
        issues,
        warnings,
        names,
        container,
      );
      for (const [key, type, schema] of [
        ['d1_databases', 'd1', draftD1],
        ['r2_buckets', 'r2', draftBinding],
        ['kv_namespaces', 'kv', draftBinding],
      ] as const) {
        const result = z
          .array(schema)
          .max(5)
          .safeParse(config[key] ?? []);
        if (!result.success) {
          // What each kind is called, and what names one that already exists.
          const [kind, existing] = {
            d1: ['D1 databases', 'database_id or database_name'],
            r2: ['R2 buckets', 'bucket_name'],
            kv: ['KV namespaces', 'id'],
          }[type];
          issues.push(
            local
              ? `Shipcel can’t deploy the ${kind} the way the Wrangler configuration declares them. It creates what an app needs and can’t attach one that already exists yet: give each entry only "binding"${type === 'd1' ? ' (and migrations_dir)' : ''}, without ${existing}, five at most.`
              : `Use at most five draft ${type.toUpperCase()} bindings with only a binding name${type === 'd1' ? ' and optional migrations_dir' : ''}. Existing IDs and resource names are not adopted by this adapter.`,
          );
          continue;
        }
        for (const item of result.data) {
          if (names.has(item.binding.toLowerCase()))
            issues.push(
              'Binding names must be unique, including when compared without letter case.',
            );
          names.add(item.binding.toLowerCase());
          if (type === 'r2' && !/^\w{0,29}[A-Za-z0-9]$/.test(item.binding))
            issues.push(
              'R2 binding names must be at most 30 characters and end with a letter or number so the automatically created bucket name is valid.',
            );
          resources.push({ type, binding: item.binding });
        }
      }
      // Postgres and MySQL through Hyperdrive: bound by the id Shipcel gave the project.
      // Whether the id is this project's is checked where the project is known.
      if (config.hyperdrive !== undefined) {
        const result = z
          .array(hyperdriveBinding)
          .max(5)
          .safeParse(config.hyperdrive);
        if (!result.success)
          issues.push(
            `Hyperdrive entries need a binding name and the id of a Postgres or MySQL database added to this project (${local ? 'shipcel hyperdrive add <BINDING>' : 'Manage → Database'}), five at most; localConnectionString is the only other setting.`,
          );
        else
          for (const item of result.data) {
            if (names.has(item.binding.toLowerCase()))
              issues.push(
                'Binding names must be unique, including when compared without letter case.',
              );
            names.add(item.binding.toLowerCase());
            resources.push({
              type: 'hyperdrive',
              binding: item.binding,
              id: item.id,
            });
          }
      }
      if (keepsName) {
        if (
          typeof config.name !== 'string' ||
          !workerNamePattern.test(config.name)
        )
          issues.push(
            'Set name in the Wrangler configuration to a valid Worker name (lowercase letters, numbers, and hyphens). This adapter deploys under that name.',
          );
        else {
          workerName = config.name;
          issues.push(...bucketNameIssues(config.name, resources));
        }
      }
      if (adapter === 'nextjs') {
        if (workerName) {
          const services = z
            .array(
              z.object({ binding: z.string(), service: z.string() }).strict(),
            )
            .safeParse(config.services ?? []);
          if (
            !services.success ||
            services.data.some(
              (s) =>
                s.binding !== 'WORKER_SELF_REFERENCE' ||
                s.service !== config.name,
            )
          )
            issues.push(
              `WORKER_SELF_REFERENCE must point to this Worker (${config.name}); other service bindings are not supported by this adapter.`,
            );
        }
        const openNext = files['open-next.config.ts'];
        if (!openNext)
          issues.push(
            local
              ? 'Add open-next.config.ts, which the OpenNext setup creates: run `npx wrangler setup` in this folder.'
              : 'Commit open-next.config.ts, which the OpenNext setup creates.',
          );
        else {
          const review = openNextCacheReview(code(openNext), config, local);
          issues.push(...review.issues);
          warnings.push(...review.warnings);
          openNextCache = review.cache;
          // What `opennextjs-cloudflare populateCache` does for this cache: the prerendered
          // entries go into the app's files, where OpenNext reads them. The CLI does it
          // itself after the build; Cloudflare's builds do it with the build command.
          if (openNextCache === 'static-assets' && !local)
            buildCommand += ` && mkdir -p .open-next/assets/${NEXT_STATIC_CACHE_DIR} && cp -R .open-next/cache/. .open-next/assets/${NEXT_STATIC_CACHE_DIR}/`;
        }
      }
    }
  }
  if (adapter === 'astro') {
    // The adapter adds these bindings at build time (dist/server/wrangler.json), outside the committed config.
    if (!resources.some((r) => r.type === 'kv' && r.binding === 'SESSION'))
      resources.push({ type: 'kv', binding: 'SESSION', source: 'adapter' });
    warnings.push(
      'Astro sessions use a KV namespace bound as SESSION by default. Wrangler creates it during deployment unless the repository disables or replaces Astro sessions.',
    );
    warnings.push(
      'The Astro Cloudflare adapter binds Cloudflare Images as IMAGES for image optimization by default. Image transformations beyond the free allowance may be billed; set imageService in astro.config to change this.',
    );
  }
  if (adapter === 'nextjs') {
    warnings.push(
      `Next.js deploys under the Worker name in the Wrangler configuration${workerName ? ` (${workerName})` : ''}, so WORKER_SELF_REFERENCE reaches the same Worker. That name must not already exist in the selected account.`,
    );
    warnings.push(
      `The OpenNext adapter binds Cloudflare Images as IMAGES for image optimization. Image transformations beyond the free allowance may be billed.${openNextCache ? '' : " OpenNext's incremental cache is not configured, so ISR and data cache entries are not persisted."}`,
    );
    // Checked locally on new create-next-app projects that Wrangler had set up. OpenNext
    // 1.20.9 to 1.20.11 (8-14 Oct 2026, Wrangler 4.148) built Next.js 16.4.0, but every
    // request failed, because 16.4 reads a manifest those releases don't bundle; 1.20.13 runs
    // 16.4.2 (23 Oct, Wrangler 4.152). With Cache Components on, which the template turns on,
    // a request never answers on any 1.20 release tried, 1.20.13 included, so the whole line
    // counts as unable; from 1.21 on nothing is known, and it passes. A folder is stopped
    // before it deploys, where the fix takes a minute; a repository gets the note with its
    // review.
    const next = lockedVersion(files['package-lock.json'], 'next');
    const openNext = lockedVersion(
      files['package-lock.json'],
      '@opennextjs/cloudflare',
    );
    const broken: string[] = [];
    if (openNext && !atLeast(openNext, '1.21.0')) {
      if (next && atLeast(next, '16.4.0') && !atLeast(openNext, '1.20.13'))
        broken.push(
          `OpenNext ${openNext} builds Next.js ${next}, but every request then fails with "Unexpected loadManifest(/.next/server/preview-props.json) call!". OpenNext 1.20.13 runs it: update OpenNext${local ? ' (npm install @opennextjs/cloudflare@latest)' : ''}.`,
        );
      const config = code(
        files['next.config.ts'] ??
          files['next.config.mjs'] ??
          files['next.config.js'] ??
          '',
      );
      const on = (option: string) =>
        new RegExp(`\\b${option}\\s*:\\s*true\\b`).test(config);
      if (on('cacheComponents'))
        broken.push(
          `next.config turns on cacheComponents, and with OpenNext ${openNext} a request then never gets an answer on Cloudflare. Remove cacheComponents${on('partialPrefetching') ? ' (and partialPrefetching, which needs it)' : ''} until an OpenNext release supports it.`,
        );
    }
    (local ? issues : warnings).push(...broken);
    // Next.js's advisories of 22 Oct 2026: remote code execution through image optimization
    // and `use cache` (GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr, critical) and a denial of
    // service with Server Actions (GHSA-p3m5-59mp-jv5r), fixed in 16.4.1 and 15.5.28.
    const fixed = next && atLeast(next, '16.0.0') ? '16.4.1' : '15.5.28';
    if (next && atLeast(next, '10.0.0') && !atLeast(next, fixed))
      warnings.push(
        `Next.js ${next} has critical security advisories (GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr: remote code execution). Next.js ${fixed} fixes them${local ? ` (npm install next@${fixed.split('.').slice(0, 2).join('.')})` : ''}.`,
      );
  }
  if (resources.length)
    warnings.push(
      local
        ? 'Wrangler creates these resources in your Cloudflare account during the deploy and binds them to the app. Later deploys reuse them. Database migrations are not applied automatically.'
        : 'Wrangler creates and binds these resources during deployment using your build token. Future deploys reuse Worker bindings. Database migrations are not applied automatically.',
    );
  if (!local)
    warnings.push(
      'Only deploy trusted repositories. Future production-branch changes run with your Cloudflare build token and may change configuration or incur charges.',
    );
  if (container && workerName)
    warnings.push(
      `Containers deploy under the Worker name in the Wrangler configuration (${workerName}), which Wrangler also uses to name the container applications. That name must not already exist in the selected account.`,
    );
  return {
    adapter,
    buildCommand,
    resources,
    containers,
    warnings,
    issues,
    workerName,
    openNextCache,
    previews,
    previewUrls,
    previewBindings,
    site: undefined as Site | undefined,
  };
}

// Wrangler names the buckets it creates `<Worker>-<binding>`; R2 allows 63 characters.
export function bucketNameIssues(
  workerName: string,
  resources: ResourceRequest[],
) {
  return resources
    .filter(
      (r) =>
        r.type === 'r2' &&
        !r2BucketPattern.test(
          `${workerName}-${r.binding.toLowerCase().replaceAll('_', '-')}`,
        ),
    )
    .map(
      (r) =>
        `The bucket Wrangler would create for ${r.binding} (${workerName}-…) exceeds R2 naming limits. Use a shorter Worker name or binding.`,
    );
}

// Wrangler names automatically created resources `${worker}-${binding}`; R2 bucket names allow 63 characters.
export function generatedWorkerName(
  project: string,
  id: string,
  resources: ResourceRequest[],
) {
  const suffix = Math.max(
    0,
    ...resources
      .filter((r) => r.type === 'r2')
      .map((r) => r.binding.length + 1),
  );
  return `cc-${project.slice(0, 47 - suffix)}-${id.replace(/-/g, '').slice(0, 12)}`;
}

// Why an adapter cannot have branch previews, or null when it can.
export function previewRefusal(adapter: string) {
  if (adapter === 'nextjs')
    return 'Previews are not available for Next.js yet: OpenNext calls its own Worker through the WORKER_SELF_REFERENCE service binding, and service bindings from a Preview always reach production.';
  if (adapter === 'container')
    return 'Previews are not available for containers yet: Cloudflare gives every Preview its own container application (partly supported, and containers need Workers Paid), which Shipcel has not verified.';
  if (adapter === 'python-packages')
    return 'Previews are not available for Python Workers with packages yet: Shipcel has not verified pywrangler with Worker Previews.';
  if (adapter === 'direct-upload')
    return 'Branch previews come from Git branches. This project deploys by direct upload, and every upload already gets its own preview address.';
  return null;
}
// Every other branch deploys as a Worker Preview of the production Worker; Workers Builds
// comments its address on the pull request. The Preview is named after the branch.
export function previewCommand(
  adapter: string,
  workerName: string,
  site?: Site,
) {
  deploymentCommand(adapter, workerName, site);
  if (previewRefusal(adapter)) throw new Error('Previews are not available');
  return `${adapter === 'static-assets' ? siteSetup(workerName, site) : ''}npx wrangler@${WRANGLER_VERSION} preview --worker-name ${workerName}`;
}

// A database, namespace or bucket Shipcel created for previews, so they never touch
// production data. `id` is the D1 UUID, the KV namespace ID, or the R2 bucket name.
export type StagingResource = {
  type: ResourceRequest['type'];
  binding: string;
  name: string;
  id: string;
};
// `<worker>-pv-<suffix>-<binding>`, within R2's 63 characters. The random suffix, recorded
// before anything is created, is the proof that a resource with this name is Shipcel's.
export function stagingName(worker: string, suffix: string, binding: string) {
  const tail = `-pv-${suffix}-${binding.toLowerCase().replaceAll('_', '-')}`;
  return `${worker.slice(0, 63 - tail.length).replace(/-+$/, '')}${tail}`;
}
// The `previews` block that binds the staging copies. Astro's adapter binds Cloudflare
// Images at build time; Previews only get bindings declared here.
export function previewsBlock(
  staging: StagingResource[],
  adapter: string,
  extras: PreviewBindings = {},
) {
  const of = (type: StagingResource['type']) =>
    staging.filter((s) => s.type === type);
  return {
    ...extras,
    ...(of('d1').length && {
      d1_databases: of('d1').map((s) => ({
        binding: s.binding,
        database_name: s.name,
        database_id: s.id,
      })),
    }),
    ...(of('kv').length && {
      kv_namespaces: of('kv').map((s) => ({ binding: s.binding, id: s.id })),
    }),
    ...(of('r2').length && {
      r2_buckets: of('r2').map((s) => ({
        binding: s.binding,
        bucket_name: s.name,
      })),
    }),
    ...(adapter === 'astro' &&
      !extras.images && { images: { binding: 'IMAGES' } }),
  };
}
// What to paste at the top level of wrangler.json(c). preview_urls keeps the workers.dev
// Preview addresses on across production deploys.
export const previewsSnippet = (
  staging: StagingResource[],
  adapter: string,
  extras: PreviewBindings = {},
) =>
  `"preview_urls": true,\n"previews": ${JSON.stringify(previewsBlock(staging, adapter, extras), null, 2)}`;

const previewListKey = {
  d1: 'd1_databases',
  kv: 'kv_namespaces',
  r2: 'r2_buckets',
} as const;
const previewKeys = new Set([
  ...Object.values(previewListKey),
  'vars',
  'ai',
  'browser',
  'images',
  'version_metadata',
  'durable_objects',
  'observability',
  'hyperdrive',
]);
// Problems with the committed `previews` block; none means Previews can build and bind only
// the staging copies. Wrangler fails every preview build without a block.
export function previewsBlockIssues(
  block: unknown,
  staging: StagingResource[],
  // The Hyperdrive databases production binds; previews reach the same ones.
  hyperdrive: HyperdriveBinding[] = [],
) {
  if (block === undefined)
    return [
      'Add a previews block to the Wrangler configuration on the production branch: Cloudflare fails every preview build without one.',
    ];
  if (!block || typeof block !== 'object' || Array.isArray(block))
    return ['The previews setting must be an object.'];
  const settings = block as Record<string, unknown>;
  const issues: string[] = [];
  const unsupported = Object.keys(settings).filter((k) => !previewKeys.has(k));
  if (unsupported.length)
    issues.push(
      `Shipcel does not review ${unsupported.join(', ')} in previews yet. Remove ${unsupported.length > 1 ? 'them' : 'it'}.`,
    );
  if (
    settings.vars !== undefined &&
    (!settings.vars ||
      typeof settings.vars !== 'object' ||
      Array.isArray(settings.vars) ||
      Object.values(settings.vars).some(
        (v) => !['string', 'number', 'boolean'].includes(typeof v),
      ))
  )
    issues.push('Preview vars must be plain text, numbers or true/false.');
  for (const key of ['ai', 'browser', 'images', 'version_metadata'])
    if (
      settings[key] !== undefined &&
      !bindingOnly.safeParse(settings[key]).success
    )
      issues.push(`Use ${key} with only a binding name in previews.`);
  // Each Preview gets its own namespace for this Worker's classes; never another Worker's.
  if (
    settings.durable_objects !== undefined &&
    !durableObjectBindings.safeParse(settings.durable_objects).success
  )
    issues.push(
      'durable_objects in previews may only bind classes of this Worker, with a binding name and class_name.',
    );
  if (
    settings.observability !== undefined &&
    (typeof settings.observability !== 'object' ||
      Array.isArray(settings.observability))
  )
    issues.push('Preview observability settings must be an object.');
  // There is no staging copy of a database hosted elsewhere: previews bind the same
  // Hyperdrive configurations as production, by the same ids.
  if (settings.hyperdrive !== undefined) {
    const entries = z
      .array(hyperdriveBinding)
      .max(5)
      .safeParse(settings.hyperdrive);
    if (
      !entries.success ||
      entries.data.some(
        (e) =>
          !hyperdrive.some((h) => h.binding === e.binding && h.id === e.id),
      )
    )
      issues.push(
        'hyperdrive in previews may only list the bindings and ids of the top-level hyperdrive setting: the Hyperdrive databases added to this project.',
      );
  }
  for (const [type, key] of Object.entries(previewListKey) as [
    StagingResource['type'],
    string,
  ][]) {
    const entries = settings[key] ?? [];
    if (!Array.isArray(entries)) {
      issues.push(`${key} in previews must be a list.`);
      continue;
    }
    const expected = staging.filter((s) => s.type === type);
    for (const entry of entries as Record<string, unknown>[]) {
      const match = expected.find((s) => s.binding === entry?.binding);
      const bound =
        type === 'd1'
          ? entry?.database_id === match?.id &&
            [undefined, match?.name].includes(entry?.database_name as string)
          : type === 'kv'
            ? entry?.id === match?.id
            : entry?.bucket_name === match?.name;
      if (!match || !bound)
        issues.push(
          `previews binds ${typeof entry?.binding === 'string' ? entry.binding : 'a binding'} to a resource Shipcel did not create for previews, so previews could change data you rely on. Use the block below.`,
        );
    }
    for (const s of expected)
      if (
        !(entries as Record<string, unknown>[]).some(
          (e) => e?.binding === s.binding,
        )
      )
        issues.push(
          `previews does not bind ${s.binding}, so Previews would run without it. Use the block below.`,
        );
  }
  return issues;
}

// For a site without a Wrangler configuration, the shell step that writes one: the build
// folder served as static assets, and for the repository root an .assetsignore that keeps
// Git, CI and dependency folders private. Values are validated, so nothing in them reaches
// the shell unquoted.
function siteSetup(workerName: string, site?: Site) {
  if (
    !site ||
    !(site.directory === '.' || safePath.safeParse(site.directory).success)
  )
    throw new Error('Invalid site');
  // preview_urls and an empty previews block: branch previews need both (previewsBlockIssues).
  const config = JSON.stringify({
    name: workerName,
    compatibility_date: '2026-10-07',
    assets: {
      directory: site.directory,
      not_found_handling: site.spa ? 'single-page-application' : '404-page',
    },
    preview_urls: true,
    previews: {},
  });
  return `printf '%s' '${config}' > wrangler.jsonc && ${
    site.directory === '.'
      ? "printf '%s\\n' .git .github node_modules .wrangler wrangler.jsonc .assetsignore >> .assetsignore && "
      : ''
  }`;
}

export function deploymentCommand(
  adapter: string,
  workerName: string,
  site?: Site,
) {
  if (!/^[a-z0-9-]{1,63}$/.test(workerName))
    throw new Error('Invalid Worker name');
  if (
    ![
      'configured-worker',
      'python',
      'python-packages',
      'container',
      'static-assets',
    ].includes(adapter) &&
    !frameworkAdapters[adapter]
  )
    throw new Error('Unknown deployment adapter');
  // pywrangler bundles Python packages, then runs the repository's pinned Wrangler.
  if (adapter === 'python-packages')
    return `pipx run --spec uv==${UV_VERSION} uv run pywrangler deploy --no-autoconfig --x-provision --x-auto-create --name ${workerName}`;
  if (adapter === 'static-assets')
    return `${siteSetup(workerName, site)}npx wrangler@${WRANGLER_VERSION} deploy --no-autoconfig --name ${workerName}`;
  return `npx wrangler@${WRANGLER_VERSION} deploy --no-autoconfig --x-provision --x-auto-create --name ${workerName}`;
}
