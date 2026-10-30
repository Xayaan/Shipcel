# Add a starter kit

The App catalog is the `kits/` folder in Shipcel's repository: one TypeScript file per starter kit. A new kit is a new file there, a line on each of the two lists in `kits/index.ts`, and the checks below. The same steps add a kit to a Shipcel you run yourself; it appears in your catalog after your next deploy.

## What a kit file holds

A kit file exports two things. `meta` is what the App catalog shows. `kit` is what a project exported from it contains, beyond what every kit gets: `package.json` with the Wrangler that Shipcel runs, a configuration check that runs before each deploy and refuses placeholder IDs, the common `.gitignore` lines, a README with the steps every app shares, and example GitHub workflows.

The Hono kit, `kits/hono.ts`, is the smallest:

```ts
import { HONO, honoWorker, runWorker, workerScripts } from './common.ts';
import type { Kit, KitMeta } from './types.ts';

export const meta = {
  id: 'hono',
  name: 'Hono',
  subtitle: 'Fast, lightweight API',
  runtime: 'Workers',
  family: 'JavaScript',
  symbol: 'H',
  color: 'orange',
  description:
    'A typed API on Workers. Add a D1 database and an R2 bucket without wiring bindings by hand.',
  docs: 'https://developers.cloudflare.com/workers/framework-guides/web-apps/hono/',
  bindings: true,
} as const satisfies KitMeta;

export const kit: Kit = {
  scripts: workerScripts,
  dependencies: { hono: HONO },
  config: () => ({ main: 'src/worker.js' }),
  files: (project) => ({ 'src/worker.js': honoWorker(project, false) }),
  readme: { runLocally: runWorker },
};
```

`kits/types.ts` describes every field, with comments.

## Write yours

1. **Name it.** Copy `kits/hono.ts` to `kits/<id>.ts`. The id is lowercase letters and digits; it becomes the framework of every project made from the kit, so don't change it later.
2. **Fill in `meta`.** `name`, `subtitle`, `description` and `docs` are what people read in the catalog: say what the app is and what it needs, such as Workers Paid. `symbol` (up to three characters) and `color` make its icon. Add `bindings: true` when the app can take a D1 database and R2 storage: the person ticks them when creating the project, and Shipcel adds them as draft bindings, `DB` and `FILES`, that Wrangler creates on the first deploy. Add `containers: true` when it runs a container: the project then can't be Free-only.
3. **Fill in `kit`.**
   - `scripts`: `dev`, `build`, `predeploy` (always `predeploy` from `common.ts`) and `deploy`.
   - `dependencies` and `devDependencies`: exact versions only, the ones you verified.
   - `config(project, extras)`: what the Wrangler configuration needs beyond its name, compatibility date and `workers_dev`, such as `main`, `assets` or `compatibility_flags`.
   - `files(project)`: the app's own files, by path. `project.name`, `database`, `storage` and `freeOnly` are all a kit can vary on.
   - `readme.runLocally`: what `npm run dev` does. Add `notes` for what to know before production, especially anything that costs money or isn't proven yet.
4. **List it** in `kits/index.ts`: import the file, then add its `meta` to `catalog`, where its place is its place in the dashboard, and its `kit` to `kits`. TypeScript refuses a kit that is on one list and not the other.

`kits/common.ts` has what several kits share: the scripts and README lines for a plain Worker (`workerScripts`, `runWorker`) and a Vite frontend (`frontendScripts`, `runFrontend`, `frontendAssets`), a Hono API (`honoWorker`), the page a new app shows with its `/api/health` route, and the pieces of the container kits.

## Guidelines

- **It works out of the box.** The exported project installs, builds and runs with no edits, and answers `/api/health` with `{ ok: true }`. A kit with no such route says what to open instead in `readme.verify`, as the static site does.
- **No credentials, no account IDs.** Resources are draft bindings that Wrangler creates, or a placeholder the configuration check refuses, as the Postgres kit's Hyperdrive ID is. Secrets are named in the README and set in Shipcel or with `wrangler secret put`.
- **It says what it costs.** Anything that can bill, such as R2, containers or Email Sending, is in the description or the notes, and a container kit has `containers: true`.
- **One kit, one file.** Put what only your kit uses in its own file; move a piece to `common.ts` once a second kit needs it.
- **Declarations at the top level.** The dashboard and the `shipcel` CLI import every kit's `meta`, so a kit's top level should only declare things. When a value has to be computed, such as a spread or a function call, give it a `const` of its own, as `kits/docker.ts` does with its scripts; then the kit's templates stay out of those bundles.
- **Plain words.** The catalog card and the README say what the app does and what to do, in the dashboard's names, without marketing.

## Check it

```sh
npm test       # names a kit that isn't listed, has an empty field or a loose version
npm run check  # TypeScript, the two lists included
npm run dev    # then, in a second terminal:
npm run verify:kits -- <id>
```

`verify:kits` exports the kit from the dashboard you just started, installs it, builds it, dry-runs the exact deploy command, then runs the app in Wrangler and requests `/` and `/api/health`. A Python kit needs pipx. Without Docker running, a container kit's local run, and the image build of one with a Dockerfile, are reported as "needs Docker" rather than checked. Then open the App catalog: your kit is there, and a project made from it downloads.

A pull request with a kit includes its `verify:kits` output, and says what you ran on a real Cloudflare account and what you didn't.
