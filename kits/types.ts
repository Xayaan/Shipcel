// The two halves of a starter kit: its entry in the App catalog, and what a project exported
// from it contains. docs/guides/add-a-starter-kit.md walks through both with an example.

// The project a kit is exported for, as much of it as a kit needs.
export interface KitProject {
  name: string;
  // The SQL database (D1, bound as DB) and the file storage (R2, bound as FILES) chosen when
  // the project was made; only kits with `bindings` offer them.
  database: boolean;
  storage: boolean;
  // Nothing Cloudflare can bill for: no R2 buckets or containers.
  freeOnly: boolean;
}

// What the project has beyond its settings: the Hyperdrive databases added to it
// (worker/hyperdrive.ts), so an exported kit carries their ids.
export type KitExtras = { hyperdrive?: { binding: string; id: string }[] };

// A kit's entry in the App catalog.
export interface KitMeta {
  // Lowercase letters and digits: the kit's file name, and the framework of its projects.
  id: string;
  name: string;
  // A few words under the name.
  subtitle: string;
  // Where it runs on Cloudflare, such as 'Workers + Assets'.
  runtime: string;
  family: 'JavaScript' | 'Static' | 'Python' | 'Containers' | 'Services';
  // One to three characters for its icon, and the icon's colour.
  symbol: string;
  color: 'amber' | 'blue' | 'green' | 'ink' | 'orange' | 'purple';
  // A sentence or two for the catalog card: what it is, and what it needs.
  description: string;
  // The guide to running it on Cloudflare.
  docs: string;
  // Offers a D1 database and R2 storage, which Shipcel adds as draft bindings.
  bindings?: true;
  // Runs containers: it needs Workers Paid, can't be Free-only, and Cloudflare's builds make
  // its image.
  containers?: true;
}

// What a project exported from the kit contains, beyond what every kit gets: Wrangler in its
// devDependencies, the configuration check, the common .gitignore lines, the README's common
// sections and the optional GitHub workflows.
export interface Kit {
  // package.json's scripts: dev, build, predeploy (the configuration check) and deploy.
  scripts: Record<string, string>;
  // Exact versions, which `npm run verify:kits` installs and builds.
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  // Added to the Wrangler configuration after its name, compatibility date and workers_dev.
  // The D1 and R2 draft bindings follow it when the project asks for them.
  config: (project: KitProject, extras: KitExtras) => Record<string, unknown>;
  // pywrangler reads wrangler.jsonc; every other kit gets wrangler.json.
  configFile?: 'wrangler.json' | 'wrangler.jsonc';
  // .gitignore lines beyond node_modules, dist, .wrangler and the env files.
  ignore?: string;
  // The app's own files, by path.
  files: (project: KitProject) => Record<string, string>;
  readme: {
    // Under "Run locally": what `npm run dev` does.
    runLocally: string;
    // Under "Configure resources", for a kit that brings its own database (the Postgres
    // kit's Hyperdrive); without it, the README describes the D1 draft binding, or none.
    database?: string;
    // What to open after deploying to check it: `/api/health` unless this says otherwise.
    verify?: string;
    // A section of its own, "<name> on Cloudflare": what to know before production.
    notes?: string;
  };
}
