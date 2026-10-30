# shipcel

Set up, build and deploy to your own Cloudflare account through [Shipcel](https://shipcel.com), from your terminal or CI. The commands follow Vercel's CLI: `shipcel login` signs you in, `shipcel` builds this project and deploys a preview, `shipcel --prod` deploys to production, and `ls`, `inspect`, `promote`, `rollback`, `logs`, `env`, `domains`, `link` and `git connect` work the way you'd expect.

Install it from npm, or from shipcel.com with `npm install -g https://shipcel.com/cli/shipcel.tgz` (it needs Node.js 20 or later):

```sh
npm install -g shipcel
shipcel login     # once: GitHub, then Cloudflare
cd my-site
shipcel           # build it here and deploy it
shipcel --prod    # later: deploy to production
```

A Shipcel you run yourself serves its own CLI at `/cli/shipcel.tgz`: install it from there, and sign in once with `shipcel login --url <its address>`. Its dashboard's **API & CLI** page shows these commands with its address.

`login` shows a code and opens one page in your browser. There you sign in with GitHub (if that browser isn't signed in yet), check the code and approve, and connect Cloudflare if the workspace hasn't yet; each sign-in comes back to the same page, and the CLI carries on by itself. It keeps a token in `~/.config/shipcel/config.json` (readable only by you).

In a project's folder, `shipcel` recognises the framework, builds on your computer and deploys the result, so nothing has to be set up in Cloudflare. A site (Vite, Create React App, Vue CLI, Astro, Gatsby, Docusaurus, VitePress, Eleventy, Hugo, Jekyll and others) is uploaded as files. An app with code or bindings (Next.js on OpenNext, SvelteKit, Astro with its adapter, or any Worker with a `wrangler.jsonc`, with its D1, KV and R2 bindings) is deployed by Wrangler, which the CLI runs for you: for that one deploy Wrangler reaches your Cloudflare account through Shipcel with a token that is good for nothing else. A framework app that has no Cloudflare adapter yet gets it, and its `wrangler.jsonc`, added on the way (the CLI asks once; `--yes` in scripts). The first time, it shows what it detected and lets you change it; `--build-command` and `--output` override it, `shipcel build` builds without deploying and `--prebuilt` skips the build.

A new app's first deploy goes to production, as on Vercel, at its free `https://<app>.<subdomain>.workers.dev` address. After that `shipcel` deploys a preview and `--prod` deploys to production; `--target preview` or `--target production` says which either way.

`shipcel git connect` makes Cloudflare build and deploy every push to the folder's GitHub repository instead. Cloudflare's builds need its own GitHub app and a build token, once per account: the CLI checks both, opens the page for whichever is missing, and continues when it's done.

## Previews and production

Like Vercel's preview deployments, `shipcel deploy` without `--prod` uploads a new version with its own address, `https://<version>-<app>.<subdomain>.workers.dev`, while production keeps serving the current version. Then:

- `shipcel promote <version|preview url>` makes that version production (and publishes the app if it wasn't public yet);
- `shipcel rollback` sends production back to the most recent earlier version that served production (previews never did), or `shipcel rollback <version>` to a given one. Database changes are not undone;
- `shipcel ls` lists the 25 newest versions with their status and preview addresses, and `shipcel inspect <version|url>` shows one.

Under the hood these are Cloudflare Worker versions and deployments in your account: a preview is a version uploaded without deploying it (as `wrangler versions upload` does), and production is the deployment that sends it all traffic.

## What it deploys

A folder of built static files, as your build tool leaves it (`dist`, `build`, `out`…): the one the CLI just built, or the one you name. Shipcel uploads only files Cloudflare doesn't already have, so later deploys are quick. In the folder:

- `_worker.js` (optional): an ES module that handles requests no file matches. Without it no code runs: Cloudflare serves the files directly, and static file requests are free. Secrets set with `shipcel env add` reach it as `env.NAME`, and stay across deploys.
- `_redirects` and `_headers` work like on other static hosts (Cloudflare's [static assets rules](https://developers.cloudflare.com/workers/static-assets/redirects/)).
- `404.html` is used for unknown paths. Without one, a single-page app's unknown paths go to `index.html` (the framework says so; for a folder you upload, a single `index.html` does); `--no-spa` turns that off.
- `.shipcelignore` lists files to leave out (`*.map`, `/drafts/`, `**/tmp/**`). `node_modules`, `.git` and hidden files are always left out, except `/.well-known`.

Containers, Python Workers with packages, routes and queues deploy from GitHub instead: `shipcel git connect`, or the Shipcel dashboard. A framework that has no Cloudflare adapter yet is offered Wrangler's own setup first.

## Commands

| Shipcel                                                   | Vercel                   | What it does                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shipcel [deploy] [folder]`                               | `vercel [deploy]`        | Build this project, or take a built folder, and deploy it: a new app to production, later deploys as previews (`--project`, `--name`, `--target`, `--prebuilt`, `--build-command`, `--output`, `--spa`) |
| `shipcel deploy --prod`                                   | `vercel --prod`          | Deploy to production and publish its address                                                                                                                                                            |
| `shipcel build`                                           | `vercel build`           | Build without deploying; `shipcel deploy --prebuilt` deploys the result                                                                                                                                 |
| `shipcel git connect`                                     | `vercel git connect`     | Have Cloudflare build and deploy every push to this folder's GitHub repository                                                                                                                          |
| `shipcel promote <version\|url>`                          | `vercel promote`         | Make a version (such as a preview) production                                                                                                                                                           |
| `shipcel rollback [version\|url]`                         | `vercel rollback`        | Send production back to the previous production version, or the one given                                                                                                                               |
| `shipcel redeploy`                                        | `vercel redeploy`        | Build a GitHub project's production branch again                                                                                                                                                        |
| `shipcel list` / `ls [project]`                           | `vercel ls`              | Versions, newest first, with their status and preview addresses                                                                                                                                         |
| `shipcel inspect <version\|url>`                          | `vercel inspect`         | One version's details                                                                                                                                                                                   |
| `shipcel logs [--since 2h] [--errors] [--follow]`         | `vercel logs`            | Requests and errors from Workers Logs                                                                                                                                                                   |
| `shipcel open [--app]`                                    | `vercel open`            | The project in the dashboard, or the app itself                                                                                                                                                         |
| `shipcel publish` / `unpublish`                           | –                        | Turn the app's public `workers.dev` address on or off                                                                                                                                                   |
| `shipcel init [kit] [folder]`                             | `vercel init`            | Create a project from a starter kit and write its files to a new folder                                                                                                                                 |
| `shipcel link [--project <name>]`                         | `vercel link`            | Link this folder to a project                                                                                                                                                                           |
| `shipcel project ls\|add\|rm\|inspect`                    | `vercel project`         | Manage projects (`shipcel projects` lists them too)                                                                                                                                                     |
| `shipcel remove` / `rm <name>`                            | `vercel remove`          | Remove a project from Shipcel; its Worker and data stay in your Cloudflare account                                                                                                                      |
| `shipcel env ls\|add <NAME>\|rm <NAME>`                   | `vercel env`             | The app's secrets; `--build` for a GitHub project's build variables                                                                                                                                     |
| `shipcel domains ls\|add <host>\|rm <host>`               | `vercel domains`         | Custom domains in your Cloudflare zones                                                                                                                                                                 |
| `shipcel activity`                                        | `vercel activity`        | What changed in your workspace recently                                                                                                                                                                 |
| `shipcel dev`                                             | `vercel dev`             | Run the project on your computer: its dev script, or Wrangler's local runtime                                                                                                                           |
| `shipcel rolling-release start\|approve\|complete\|abort` | `vercel rolling-release` | Move production to a version a share at a time                                                                                                                                                          |
| `shipcel crons ls\|add\|rm`                               | `vercel crons`           | Cron schedules for the app's `scheduled()` handler                                                                                                                                                      |
| `shipcel metrics [--since 7d]`                            | `vercel metrics`         | Requests, errors and CPU time                                                                                                                                                                           |
| `shipcel curl [path]`, `httpstat [path]`                  | same                     | Request the app or one version (`--deployment`), or time a request                                                                                                                                      |
| `shipcel env pull [file]`, `shipcel pull`                 | same                     | The names of the app's variables, into `.env.local` or `.dev.vars`; secret values are never readable                                                                                                    |
| `shipcel alias ls\|set\|rm`                               | `vercel alias`           | The same as `domains`: a custom domain serves production                                                                                                                                                |
| `shipcel mcp [--write]`, `shipcel agent init`             | same                     | Connect an AI agent to Shipcel; deploy notes in `AGENTS.md`                                                                                                                                             |
| `shipcel api <path>`                                      | `vercel api`             | Call Shipcel's API as you                                                                                                                                                                               |
| `shipcel upgrade`, `switch`, `telemetry`                  | same                     | Install the CLI this Shipcel serves; sign in to another workspace; no telemetry is sent                                                                                                                 |
| `shipcel login` / `logout` / `whoami`                     | same                     | Sign in with GitHub and connect Cloudflare through the browser, sign out, show who you are                                                                                                              |
| `shipcel help [command]`, `--version`                     | same                     | Help for one command; the CLI's version                                                                                                                                                                 |

Options that work everywhere: `--cwd <folder>`, `--token <token>`, `--url <address>`, `--yes` (`-y`), `--json`, `--help` (`-h`), `--version` (`-v`). A command that changes something asks first in a terminal; in scripts it needs `--yes`.

What isn't there, and why: `env pull` (Cloudflare never returns secret values; keep local ones in `.dev.vars`), `dev` (run `npx wrangler dev` in a project with a Wrangler configuration), `teams`/`switch` (a token belongs to one workspace: sign in again to use another), and Vercel-only products (Blob, Edge Config, Flags, Firewall). For storage and databases, use the dashboard's Manage tab.

## Secrets

```sh
shipcel env add API_KEY                         # asks for the value without showing it
printf %s "$API_KEY" | shipcel env add API_KEY  # or reads it from standard input
shipcel env ls                                  # names only
shipcel env rm API_KEY --yes
```

A secret goes straight to Cloudflare as a Worker secret; Shipcel never stores it. Setting one deploys it with the current code, like `wrangler secret put`.

## In CI

Create a token under **API & CLI** in the dashboard and set it as a secret:

```sh
SHIPCEL_URL=https://shipcel.com SHIPCEL_TOKEN=cc_pat_… \
  npx --yes --package=https://shipcel.com/cli/shipcel.tgz shipcel deploy ./dist --prod --project my-site
```

A token always comes with its Shipcel's address, so one for a Shipcel you run yourself never goes anywhere else: set `SHIPCEL_URL` to that address, and take the CLI from there.

A token acts as you in your workspace. It can deploy and manage projects, but it can't create tokens, connect accounts, turn Free-only off, protect previews or add webhooks.

## Development

The source is TypeScript in `src/` (`cli.ts` the commands, `site.ts` what a project builds, `git.ts` reading Git remotes, `main.ts` the process wiring; framework presets are shared with the server in `shared/site-presets.ts`); `npm run cli:build` (from the repository root) bundles it into `dist/shipcel.js` with no runtime dependencies and packs it as `public/cli/shipcel.tgz`, which Shipcel serves at `/cli/shipcel.tgz`. `npm run cli:build -- --check` fails when either is stale. The package is not published to the npm registry. Tests are in `tests/cli.test.ts`.
