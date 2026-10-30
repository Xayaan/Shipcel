# The shipcel CLI

The `shipcel` command sets up, builds and deploys your site or app to your own Cloudflare account, and manages your projects from a terminal or CI. Its commands follow Vercel's CLI: `shipcel login` signs you in, `shipcel` builds this project and deploys it, `shipcel --prod` deploys to production, and `ls`, `inspect`, `promote`, `rollback`, `logs`, `env`, `domains`, `dev`, `link` and `git connect` work the way you expect.

```sh
shipcel login     # once: GitHub, then Cloudflare
cd my-app
shipcel           # build it here and deploy it
shipcel --prod    # later: deploy to production
```

Your project is built on your computer and deployed from there, so there is nothing to set up in Cloudflare first. That goes for static sites and for apps with code, such as Next.js, SvelteKit or a Worker with a database.

## Install

Every Shipcel serves its own CLI, at `/cli/shipcel.tgz` on its address. It needs Node.js 20 or later.

```sh
npm install -g https://shipcel.com/cli/shipcel.tgz
shipcel --version
```

The dashboard's **API & CLI** page shows these commands with its own address filled in.

Shipcel was called Cloudcel before 23 October 2026. A `cloudcel` command installed before then keeps working, and its `cloudcel upgrade` installs `shipcel` beside it (`npm uninstall -g cloudcel` removes the old one). `shipcel` still reads what the old command saved: the sign-in in `~/.config/cloudcel`, a folder's `.cloudcel/project.json` and `.cloudcelignore`, and `CLOUDCEL_URL` and `CLOUDCEL_TOKEN`.

## Sign in

```sh
shipcel login
```

It signs in to shipcel.com. For a Shipcel you run yourself, give its address the first time, `shipcel login --url https://shipcel.example.com`, and the CLI keeps it with the token. The CLI shows a code and opens one page in your browser, then waits while you go through it:

1. **Sign in with GitHub**, if that browser isn't signed in to Shipcel yet. You come back to the same page.
2. **Approve this computer**: check that the code matches the one in your terminal, and the workspace the page names, then click **Approve**.
3. **Connect Cloudflare**, if the workspace hasn't yet: Cloudflare asks you to approve Shipcel's access, and you come back to the page again. With several Cloudflare accounts you choose the one your apps deploy to; an account without a `workers.dev` subdomain claims one there.

```text
Visit https://shipcel.com/app/#cli-login?code=BCDF-GHJK
Sign in with GitHub there if it asks, check that it shows the code BCDF-GHJK, then approve.
Waiting for you in the browser…
Signed in as ada in ada's workspace.
The token is saved in ~/.config/shipcel/config.json.
Cloudflare: connected to Ada's Account.
Next: run shipcel in your project’s folder to deploy it.
```

The CLI saves a token in `~/.config/shipcel/config.json`, readable only by you; it acts as you in that workspace for 90 days. `shipcel whoami` shows who you are signed in as, the workspace and its Cloudflare account, and `shipcel logout` forgets the token on this computer (revoke it under **API & CLI** to cancel it everywhere).

You don't have to run `login` first: any command signs you in when it needs to, and `shipcel` opens the same page if Cloudflare isn't connected when you deploy. Only a workspace owner can connect Cloudflare.

## Deploy

```sh
shipcel                        # build this project and deploy it
shipcel --prod                 # build it, deploy to production
shipcel deploy ./dist          # or upload a folder that is already built
```

A new app's first deploy goes to production, as on Vercel. After that, `shipcel` deploys a preview, and production stays as it is until you use `--prod`.

The first deploy in a folder sets it up, the way `vercel` does:

```text
Set up and deploy “~/code/my-site”? [Y/n]
Project name [my-site]:
Detected Vite (Build Command: npm run build, Output Directory: dist)
Customize settings? [y/N]
Installing dependencies: npm install
Building: npm run build
Uploading 12 of 12 new files…
Deployed 12 files (12 new) to my-site.
Production: https://my-site.your-name.workers.dev/
```

It asks to link an existing project when you have one (by the folder's name first), or creates one, named after the folder or `--name`. `--yes` takes every default without asking. The folder is linked to the project in `.shipcel/project.json`, with what it detected, so later deploys ask nothing and commands in that folder know which project you mean (`--project <name>` overrides it). In a Git repository the CLI adds `.shipcel` to `.gitignore`: the link holds IDs from your own workspace.

### What it builds

In a project's folder, the CLI recognises the framework from `package.json` and builds it with your package manager (npm, pnpm, Yarn or Bun, from `packageManager` or the lockfile). It installs dependencies only when `node_modules` is missing.

| Framework                           | Build command        | Folder it deploys                 | Unknown paths   |
| ----------------------------------- | -------------------- | --------------------------------- | --------------- |
| Vite                                | `npm run build`      | `dist`, or `build.outDir` you set | to `index.html` |
| Create React App                    | `npm run build`      | `build`                           | to `index.html` |
| Vue CLI                             | `npm run build`      | `dist`                            | to `index.html` |
| Astro, without a server adapter     | `npm run build`      | `dist`                            | `404.html`      |
| Gatsby                              | `npm run build`      | `public`                          | `404.html`      |
| Docusaurus                          | `npm run build`      | `build`                           | `404.html`      |
| VitePress, VuePress                 | `npm run docs:build` | `docs/.vitepress/dist` (see note) | `404.html`      |
| Eleventy                            | `npm run build`      | `_site`                           | `404.html`      |
| Parcel, Gridsome                    | `npm run build`      | `dist`                            | `404.html`      |
| Hexo                                | `npm run build`      | `public`                          | `404.html`      |
| Stencil                             | `npm run build`      | `www`                             | `404.html`      |
| Ember, UmiJS                        | `npm run build`      | `dist`                            | to `index.html` |
| Preact CLI                          | `npm run build`      | `build`                           | to `index.html` |
| Anything else with a `build` script | `npm run build`      | the folder you name               | `404.html`      |

These are the presets Shipcel's [GitHub deployments](deploy-from-github.md#what-a-repository-needs) use, so a site builds the same either way. Vite has been built end to end through Shipcel; the others follow each tool's default output folder. For VitePress and VuePress, Shipcel reads the folder from the script that builds the docs (`build` or `docs:build`): `vitepress build docs` writes `docs/.vitepress/dist`.

Site generators that aren't Node projects are recognised by their own files and built with the tool on your computer:

| Generator | Recognised by                                  | Build command              | Folder   |
| --------- | ---------------------------------------------- | -------------------------- | -------- |
| Hugo      | `hugo.toml`, or `config.toml` with `layouts/`  | `hugo --gc --minify`       | `public` |
| Jekyll    | `_config.yml`                                  | `bundle exec jekyll build` | `_site`  |
| Zola      | `config.toml` with `content/` and `templates/` | `zola build`               | `public` |
| MkDocs    | `mkdocs.yml`                                   | `mkdocs build`             | `site`   |

- **Change what it runs** by answering `y` to _Customize settings?_, or with `--build-command "<command>"` and `--output <folder>` at any time. They are saved with the link.
- **A framework the CLI doesn't know** but with a `build` script: it asks for the output folder (in scripts, pass `--output`).
- **`shipcel build`** builds without deploying, and **`shipcel deploy --prebuilt`** deploys what the last build wrote.
- **A build that fails** stops the deploy: the build's own output is in your terminal, and nothing is uploaded.
- **A static export of a server framework** (a Next.js export, say) is a folder of files: name it, `shipcel --output out`, and it is uploaded like any site from then on.
- **A folder without a `package.json`** or a generator's files is uploaded as it is, and so is any folder you name: `shipcel deploy ./dist`.

### Apps with code, databases and bindings

A project with a `wrangler.jsonc` (or `wrangler.json`), or a framework that renders on a server, is an app: it has code that runs on Cloudflare, and maybe a database. `shipcel` deploys it from its folder too. You don't write the `wrangler.jsonc` for a framework app: `shipcel` (or `shipcel deploy --prod`) adds it, with the framework's Cloudflare adapter, and then deploys.

```text
$ shipcel
Set up and deploy “~/code/shop”? [Y/n]
Project name [shop]:
Detected Next.js (OpenNext) (Build Command: npx opennextjs-cloudflare build)
This deploy creates the D1 database shop-db in your Cloudflare account. Go ahead? [Y/n]
Building: npx opennextjs-cloudflare build
Deploying shop with Wrangler 4.156.0…
Deployed shop to production.
Production: https://shop.your-name.workers.dev/
```

1. **Shipcel reviews the configuration**, the same way it reviews a GitHub repository: what the app binds, and what Cloudflare would create for it. Anything it can't deploy is listed before anything is built.
2. **The app builds on your computer**, with your package manager.
3. **Wrangler deploys it.** Wrangler is Cloudflare's own tool; the CLI runs it for you, always version 4.156.0 through `npx`, which is the one Shipcel is verified with (a newer Wrangler in your project isn't used for the deploy). For this one deploy it reaches your Cloudflare account through Shipcel, with a token that is good for nothing else, so you don't sign Wrangler in and no Cloudflare token is kept on your computer.

What deploys this way: Workers and static assets; D1 databases, KV namespaces and R2 buckets declared with only a binding name (Cloudflare creates them, named `<app>-<binding>`, after you agree; later deploys reuse them); variables; Workers AI, browser rendering, Images; Workers' rate limiter (`ratelimits`); cron schedules; SQLite Durable Objects; and a service binding of the app to itself. A Free-only project refuses R2. Workers Logs stay on unless your configuration turns `observability` off.

A Next.js app with OpenNext's cache in R2 (`r2IncrementalCache` in `open-next.config.ts`, bound as `NEXT_INC_CACHE_R2_BUCKET`) gets its cache filled after each production deploy: the CLI sends the pages Next.js prerendered through the same deploy, into that bucket only, at the keys OpenNext reads (`Filled OpenNext’s cache with the 12 entries Next.js prerendered.`). Up to 500 entries a deploy go in; the rest are cached on their first request, and a preview fills nothing, since it shares production's bucket. With OpenNext's cache in the app's own files (`staticAssetsIncrementalCache`), the entries are copied into `.open-next/assets` before Wrangler uploads them.

- **A framework without its Cloudflare adapter yet** (a new Next.js, SvelteKit, React Router, Nuxt, Angular, TanStack Start, Qwik City, SolidStart or Analog app, or Astro with server output): the CLI adds the adapter and the `wrangler.jsonc` for you, by running Wrangler's own setup, and carries on to the deploy. It changes files in your folder (`package.json`, the framework's configuration, a new `wrangler.jsonc`), so it asks once first; in scripts it runs with `--yes`. Setup can't sign in to Cloudflare or create anything there: what the app needs is created during the deploy, after the review. Before it changes anything the CLI checks that Wrangler has an adapter for the framework; for one it doesn't know (Remix 2, for example) it stops and says so, instead of deploying the app's static files without its code.
- **Next.js today**: Cloudflare's adapter, OpenNext, runs Next.js 16.4 from its release 1.20.13, but not Cache Components yet. A new `create-next-app` project turns `cacheComponents` and `partialPrefetching` on, and Shipcel stops it before deploying with the change to make: remove both from `next.config.ts`. (Checked on 23 October 2026 with Next.js 16.4.2 and OpenNext 1.20.13: with them on, every page request hangs; without them, the app answers. Earlier OpenNext releases, checked on 8–14 October, failed every 16.4 request: update OpenNext.) Next.js before 16.4.1 (15.5.28 on 15.x) has critical security advisories, published on 22 October: Shipcel's review says so, with the release that fixes them.
- **Angular** renders pages only for the hosts it is told about, and Wrangler's setup tells it only `localhost`. After setup the CLI adds your workers.dev addresses (`*.<subdomain>.workers.dev`, production and previews) to `security.allowedHosts` in `angular.json`; add a custom domain there too when you attach one, or its pages answer 400 ("Header "host" … is not allowed").
- **Not running on Cloudflare yet** (checked 15 October 2026): **SolidStart 2** sets up, builds and deploys, but every request fails ("No such module "@manifest/ssr/…""; it asks for Node.js 24, and was built on 22.13, so that may be why); **Analog 2.8** serves its API routes and prerendered pages, but its server-rendered pages fail, because Angular 22 refuses hosts it isn't told about and Analog has no setting for them yet. The CLI's check of the home page after a deploy reports the failure.
- **Node.js and npm.** Current templates ask for newer Node.js than many computers have: SvelteKit 3 22.17, Nuxt's `create-nuxt` 22.21, Angular 22 and Analog 22.22.3, SolidStart 2 24. npm 10 (the npm that comes with Node.js 22) can't install some of today's apps at all: it stops with "Cannot read properties of null (reading 'edgesOut')" (Nuxt 4.6, Angular 21) or "Unable to resolve reference" (Analog). npm 11 installs them: `npm install -g npm@11`, or Node.js 24, which comes with it.
- **One package manager per folder.** A folder with lockfiles for two package managers (some templates ship a `pnpm-lock.yaml` and tell you to run `npm install`) is stopped before setup: Wrangler's setup would use pnpm or Yarn and the CLI npm. Delete the lockfile of the one you don't use.
- **`wrangler.toml`**: move its settings into a `wrangler.jsonc` first.
- **Not from a computer yet**: containers (Cloudflare's builds make their images), Python Workers with packages, routes, queues, and bindings to databases that already exist or to other Workers. These deploy from GitHub with Cloudflare's own builds: `shipcel git connect --cloudflare-builds` ([Deploy every push](#deploy-every-push)). Add a custom domain with `shipcel domains add`.
- **A Worker needs no `package.json`**: a folder with a `wrangler.jsonc` and its code is an app. `examples/hello-database` in Shipcel's repository is one, with a D1 database, a KV namespace, a Durable Object and a schedule: copy it somewhere and run `shipcel deploy --prod` in it to see the whole path.
- **A larger example**: `examples/bittensor-light-client` runs a Bittensor (Finney) light client in a Durable Object (smoldot, built to WebAssembly) and serves Finney's JSON-RPC from what it verifies itself, old blocks included, from an archive node, checked wherever a proof can. It has one npm dependency, which the CLI installs. It needs Workers Paid, because a Durable Object on Workers Free gets 10 ms of CPU per request; its README has the details and its limits. It doesn't run on Cloudflare yet: its Durable Object went over 128 MB of memory, and the smoldot patches that reduce it are still to be confirmed there. To keep it to yourself, set its `RPC_KEY` secret (`shipcel env add RPC_KEY`).
- **A deploy Wrangler didn't finish** can be run again: a database it had already created is used, not made twice.

### Previews and production

- **A new app's first deploy is its production deploy**, published at `https://<app>.<subdomain>.workers.dev`.
- **After that, a deploy is a preview**: a new version with its own address, `https://<version>-<app>.<subdomain>.workers.dev`, while production keeps serving the current version.
- **`--prod`** deploys the new version to production and publishes the app's address.
- **After a deploy the CLI asks the new version for its home page.** If it answers a server error, it says so ("Heads up: … answers 500") with where to look and how to go back, instead of ending on "Deployed": an app can build and deploy and still fail every request (a framework its Cloudflare adapter can't run yet, for one).
- **An app with a Durable Object has no preview addresses**: Cloudflare doesn't give them to such a Worker. A preview of it is still uploaded as a version, which `shipcel promote` makes production; the CLI says "Preview: none" instead of showing an address that wouldn't answer.
- **`--target preview`** or **`--target production`** says which, whatever the default would be. A site asked for as a preview on its first deploy is created unpublished: only its preview address works, for anyone you share it with, until you run `shipcel promote` or deploy with `--prod`.

The output names the new version, its preview address, production, and a link to the project in the dashboard:

```text
Deployed 3 files (1 new, 2 skipped) to hello-shipcel as a preview.
Inspect: https://shipcel.com/app/#projects/…/deployments
Preview: https://1a2b3c4d-hello-shipcel.your-name.workers.dev
Production: https://hello-shipcel.your-name.workers.dev/ (unchanged). To make this version production: shipcel promote 1a2b3c4d
```

### What a folder can contain

Whether the CLI built it or you did, what deploys is a folder of files as the build tool leaves it (`dist`, `build`, `out`…). Shipcel uploads only the files Cloudflare doesn't already have, so later deploys are quick.

- `_worker.js` (optional): an ES module that handles requests no file matches, such as an API. Without it no code runs; files are served directly and static requests are free.
- `_redirects` and `_headers` work as on other static hosts.
- `404.html` is used for unknown paths. Without one, a single-page app's unknown paths go to `index.html`: the framework says so, or for a folder you upload, a single `index.html` does. `--no-spa` turns that off and `--spa` turns it on.
- `.shipcelignore` lists files to leave out, one pattern a line: `*.map`, `/drafts/`, `**/tmp/**`. `node_modules`, `.git` and hidden files are always left out, except `/.well-known`.

Limits: 20,000 files, 24 MiB a file, 1 MiB for `_worker.js` and 64 KiB for `_redirects` or `_headers`. If the folder has no `index.html`, the CLI suggests the build folder it finds instead (pass `--yes` to deploy it anyway). An app with a database or other bindings needs a Wrangler configuration: see [Apps with code, databases and bindings](#apps-with-code-databases-and-bindings).

## Deploy every push

```sh
shipcel git connect            # this folder's GitHub repository (its origin remote)
shipcel git connect --repo ada/my-site
shipcel git ls                 # how the project deploys
shipcel git disconnect         # its pushes stop deploying
```

A repository on GitLab, Bitbucket, Gitea or Forgejo deploys from its own CI instead: `git connect` links it and writes the CI file (see [Deploy from GitLab, Bitbucket or Gitea](other-git-hosts.md)).

`git connect` makes every push to the repository deploy, like `vercel git connect`. Shipcel adds a workflow to the repository (`.github/workflows/shipcel.yml`): GitHub Actions builds each push and deploys it with `shipcel deploy`, signed in with GitHub's own token for the run, so no secret is stored and nothing is set up in Cloudflare. Pushes to the default branch deploy to production; other branches get a preview. When you set up a new project in a repository's folder, `shipcel` offers it too: _Connect ada/my-site so every push deploys, built by GitHub Actions?_

```text
Connecting GitHub repository: https://github.com/ada/my-site
Created the project my-site.
Add a workflow to ada/my-site (.github/workflows/shipcel.yml) so GitHub Actions builds every push and deploys it to my-site? … [y/N] y
Added the workflow to ada/my-site: https://github.com/ada/my-site/commit/…
Every push deploys now: main to production, other branches as previews. Follow the runs: https://github.com/ada/my-site/actions
Run git pull to bring the workflow into this folder.
```

Adding the workflow is a push too, so the first deploy starts right away. A project you deploy from your computer can deploy every push as well: both upload the same way. If GitHub refuses the commit (a protected branch, or Shipcel's GitHub App without permission for workflows), the repository is linked anyway and the CLI opens GitHub's new-file page with the workflow filled in. When the app isn't installed on the repository's owner, or not for the repository, the CLI says so and opens GitHub's page for that instead; run `shipcel git connect` again afterwards and it adds the workflow. GitHub's runners reach Shipcel over the internet, so this needs a hosted Shipcel; with a Shipcel on your own computer, `git connect` says so.

`git disconnect` changes nothing in the repository: delete the workflow there too, as it says.

**Cloudflare's own builds.** For containers, queues, routes and Python Workers with packages, which `shipcel deploy` can't deploy yet, `git connect --cloudflare-builds` has Cloudflare build and deploy every push to the default branch instead. That needs two things once per Cloudflare account, which the CLI checks for you: Cloudflare's own GitHub app able to read the repository (the CLI opens Cloudflare's **Create application** page and says what to click), and a build token (the CLI opens Connections, where you create and paste it once). Cloudflare doesn't let an app do either for you: see [Builds by Cloudflare](deploy-from-github.md#builds-by-cloudflare). With both in place it shows the plan, asks once, and follows the first deployment to its address. A project deploys one way there: give the repository a project of its own with `--name`. If Cloudflare's dashboard already shows the repository but the CLI keeps waiting, `--skip-checks` starts anyway and reports what Cloudflare answers.

## Previews, production and rollback

```sh
shipcel ls                                   # versions, newest first
shipcel inspect 1a2b3c4d                     # one version (or its preview address)
shipcel promote 1a2b3c4d                     # make it production
shipcel rollback                             # back to the previous production version
shipcel rollback https://5e6f7a8b-hello-shipcel.your-name.workers.dev
```

`shipcel ls` lists the 25 newest versions with their status (**Production**, **Preview** or **Earlier production**) and preview addresses. Versions are named by the first eight characters of their ID, and every command that takes one also takes its preview address.

`promote` sends all production traffic to a version and publishes the app if it wasn't public yet. `rollback` without a version goes back to the most recent earlier version that served production; previews never did, so it skips them. Database changes are not undone. Both ask before they change anything; in scripts, pass `--yes`.

For a GitHub project, `shipcel redeploy` starts a new Cloudflare build of the production branch at its latest commit.

## Projects

```sh
shipcel link                     # link this folder to a project (asks which)
shipcel link --project my-site
shipcel project ls               # or: shipcel projects
shipcel project add my-site      # create a project
shipcel project inspect          # the linked project: source, Worker, production address
shipcel rm my-site               # remove a project from Shipcel
shipcel open                     # the project in the dashboard
shipcel open --app               # the app itself
shipcel activity                 # what changed in your workspace recently
```

Removing a project removes it from Shipcel only. Its Worker, data and domains stay in your Cloudflare account, so nothing breaks unexpectedly; delete them in Cloudflare if you no longer need them.

## Start from a starter kit

```sh
shipcel init                     # lists the kits
shipcel init static my-site      # creates the project and writes its files to ./my-site
cd my-site && shipcel deploy public --prod
```

`init` creates a project from a [starter kit](starter-kits.md) and writes the kit into a new folder linked to it. `--database` adds a D1 database to kits that support one. The static kit deploys straight from its `public` folder; the others deploy with `shipcel` from their folder (the Python kit, which has packages, deploys from GitHub).

## Secrets

```sh
shipcel env add API_KEY                          # asks for the value, without showing it
printf %s "$API_KEY" | shipcel env add API_KEY   # or reads it from standard input
shipcel env ls                                   # names only
shipcel env rm API_KEY
```

Secrets are your app's Worker secrets: your code reads them as `env.API_KEY`. They go straight to Cloudflare; Shipcel never stores them. Setting or removing one deploys it with the current code (`env update` is the same as `env add`).

```sh
shipcel env pull                 # the names, into .env.local (.dev.vars for a Wrangler project)
```

Cloudflare never returns a secret's value, so `env pull` (or `shipcel pull`) writes each name with an empty value for you to fill in for local development. Build variables that aren't secret come with their values, and whatever the file already holds stays. For a GitHub project, `--build` manages its build variables instead (`--preview` for branch previews' builds, `--plain` for a value that may be shown). More in [Environment variables](environment-variables.md).

## Domains

```sh
shipcel domains add app.example.com
shipcel domains ls
shipcel domains rm app.example.com
```

The hostname must be in a zone of the Cloudflare account; Shipcel picks the most specific zone that covers it and Cloudflare issues the certificate. See [Domains](domains.md).

## Coming from Vercel

| Shipcel                         | Vercel                   | What it does                     |
| ------------------------------- | ------------------------ | -------------------------------- |
| `shipcel login`                 | `vercel login`           | Sign in and connect Cloudflare   |
| `shipcel`                       | `vercel`                 | Build this project and deploy it |
| `shipcel --prod`                | `vercel --prod`          | Deploy to production             |
| `shipcel build`                 | `vercel build`           | Build without deploying          |
| `shipcel dev`                   | `vercel dev`             | Run the project on your computer |
| `shipcel git connect`           | `vercel git connect`     | Deploy every push                |
| `shipcel promote <version>`     | `vercel promote`         | Make a preview production        |
| `shipcel rollback`              | `vercel rollback`        | Back to the previous production  |
| `shipcel ls`                    | `vercel ls`              | Versions and their addresses     |
| `shipcel inspect <version>`     | `vercel inspect`         | One version's details            |
| `shipcel logs --follow`         | `vercel logs`            | Requests and errors              |
| `shipcel env add <NAME>`        | `vercel env add`         | Add a secret                     |
| `shipcel env pull`              | `vercel env pull`        | Variable names for local use     |
| `shipcel rolling-release start` | `vercel rolling-release` | Shift production gradually       |
| `shipcel crons add "<cron>"`    | `vercel crons add`       | Add a schedule                   |

## Postgres and MySQL

```sh
shipcel hyperdrive add DB        # asks for postgres://user:password@host:5432/database (hidden)
shipcel hyperdrive ls
shipcel hyperdrive rm DB
```

`add` makes a Hyperdrive configuration in your Cloudflare account for a Postgres or MySQL database hosted anywhere, and prints the `hyperdrive` entry to put in your Wrangler configuration; your code reads `env.DB.connectionString`. The connection string can also be piped in: `printf %s "$DATABASE_URL" | shipcel hyperdrive add DB`. The password goes to Cloudflare only. See [Databases and storage](databases-and-storage.md#postgres-and-mysql-through-hyperdrive).

## Logs

```sh
shipcel logs                     # the last hour
shipcel logs --since 2h --errors
shipcel logs --follow            # keeps printing new events; Ctrl+C stops
```

Logs come from Cloudflare's Workers Logs, which records requests while observability is on for the Worker. The first deploy turns it on (see [Logs and analytics](logs-and-analytics.md#logs)). `--since` takes 5 minutes to 3 days (`30m`, `2h`, `1d`).

## Run it locally

```sh
shipcel dev
```

Runs the project's own `dev` (or `start`) script when `package.json` has one, with your package manager. A Worker without one runs in Wrangler's local runtime, and so does a folder of files.

## Gradual releases, schedules and numbers

```sh
shipcel rolling-release start --dpl 1a2b3c4d             # 10% of production traffic
shipcel rolling-release approve --dpl 1a2b3c4d --percent 50
shipcel rolling-release complete --dpl 1a2b3c4d          # all of it
shipcel rolling-release abort                            # all of it back
shipcel crons add "0 10 * * *"                           # also: crons ls, crons rm
shipcel metrics --since 30d                              # requests, errors, response and CPU time
shipcel budget                                           # this month's cost vs its budget
shipcel budget check                                     # read it from Cloudflare now
shipcel curl /api/hello --deployment 1a2b3c4d            # request one version
shipcel httpstat /                                       # where a request's time goes
```

`shipcel budget` shows what the budget guard last read: the month's cost beyond what Cloudflare includes, meter by meter, against the project's budget, and whether the app is paused. An owner sets the budget, and pauses or resumes the app, in the dashboard; see [Free-only and billing](free-only-and-billing.md#the-budget-guard).

A rolling release splits production between the new version and the one serving now, which is what Cloudflare's gradual deployments allow. Schedules (up to five, in UTC) call your app's `scheduled()` handler; an app whose Wrangler configuration lists `triggers.crons` gets those on every deploy instead. `shipcel alias` is `shipcel domains` under Vercel's name: a custom domain always serves production.

## AI agents and the API

```sh
shipcel mcp                      # how to connect Claude Code, Codex or Cursor
shipcel mcp --write              # add Shipcel to .mcp.json in this folder (no token in it)
shipcel agent init               # deploy notes for coding agents, in AGENTS.md
shipcel api /projects            # call Shipcel's API as you (--method, --data)
shipcel upgrade                  # install the CLI this Shipcel serves
```

## Storage

```sh
shipcel storage ls                          # the app's KV namespaces and R2 buckets
shipcel storage ls FILES photos/            # objects (or keys) under a prefix
shipcel storage get CACHE config:theme      # print a KV text value
shipcel storage get FILES photos/cat.png    # save an R2 object, to cat.png here
shipcel storage put FILES photos/cat.png ./cat.png
shipcel storage put CACHE greeting --value hello
shipcel storage rm FILES photos/cat.png
```

Storage is named by its binding, the name your code uses (with only one, it can be left out). `--preview` works on the previews' staging copies. KV takes text values up to 1 MB and R2 files up to 25 MB here; use Wrangler for larger ones. Every change asks first (`--yes` in scripts) and is recorded with its key, never its value. `shipcel blob` is the same command, under Vercel's name.

## DNS, cache and redirects

```sh
shipcel dns ls                                   # the zones of your Cloudflare account
shipcel dns ls example.com                       # a zone's records, with their IDs
shipcel dns add example.com www CNAME shop.example.net --proxied
shipcel dns add example.com @ MX 10 mail.example.com
shipcel dns rm example.com <record id>
shipcel cache purge                              # everything cached for the app's custom domains
shipcel cache purge https://shop.example.com/logo.png
shipcel redirects add /old /new                  # into the app's _redirects (301 by default)
shipcel redirects ls                             # and checks it against Workers' limits
shipcel redirects rm /old
```

`shipcel dns` works on every zone in the connected Cloudflare account: A, AAAA, CNAME, TXT and MX records, checked before Cloudflare is asked, and each change asks first. A Worker's custom domain is added with `shipcel domains add` instead, because Cloudflare manages its record.

`shipcel cache purge` empties Cloudflare's cache for the app's custom domains. The cache belongs to a domain, so a `workers.dev` address has none to purge, and an app's static files get fresh with every deploy anyway: purging matters for what the app caches itself on a custom domain. It needs the Cloudflare connection's **Cache Purge** permission: Cloudflare sign-ins set up from 21 October 2026 ask for it, and an older one has to be set up again on Connections (it can't be added to an existing one yet). Cloudflare's Free plan allows 5 such purges a minute.

`shipcel redirects` edits the `_redirects` file that Workers reads from the app's static files: `public/_redirects` or `static/_redirects` in most frameworks, or the folder's own file for a folder of files (`--file` names another). One rule a line, `/from /to 301`; Workers takes 2,000 static and 100 dynamic redirects (with `*` or `:name`). They apply to static files from the next deploy, not to requests the app's code answers.

## Security

```sh
shipcel security                                 # the firewall of the zones of the app's custom domains
shipcel security managed on                      # Cloudflare's Free Managed Ruleset
shipcel security bots on                         # Bot Fight Mode
shipcel security ai-bots on                      # block AI crawlers
shipcel security under-attack on                 # a challenge page for every visitor, during an attack
shipcel security block country CN,RU             # rules match the app's own host names
shipcel security challenge path /wp-admin
shipcel security block ip 203.0.113.7 198.51.100.0/24
shipcel security rm <rule id>
shipcel security rate-limit /api 100             # at most 100 requests per 10 seconds per visitor
shipcel security rate-limit off
```

Cloudflare's DDoS protection covers every app, at its `workers.dev` address and its custom domains, with nothing to set up and nothing to pay. Cloudflare's firewall belongs to a domain's zone, so `shipcel security`, like **Manage → Security** in the dashboard, works on the zones of the app's custom domains: an app with only a `workers.dev` address has DDoS protection but no firewall rules. An app that still answers at its `workers.dev` address can be reached there without the zone's firewall; `shipcel unpublish` turns that address off.

- **Settings for the whole zone**, every host name in it: Cloudflare's Free Managed Ruleset (Cloudflare deploys it on Free zones; `managed off` turns its rule off and keeps it), Bot Fight Mode (no rule can make an exception, so it may challenge API clients and mobile apps), AI crawler blocking, and Under Attack mode (turning it off sets the zone's security level back to Cloudflare's default, _medium_).
- **Rules** block or challenge countries (two-letter codes), IP addresses or ranges, or a path and everything below it, on the app's own host names only. Cloudflare's Free plan allows 5 rules per zone, shared with whatever else uses the zone.
- **A rate limit** blocks a visitor (an IP address, counted in each Cloudflare data center) for 10 seconds after more than the given number of requests in 10 seconds to a path and everything below it. Cloudflare's Free plan allows one per zone and matches the path alone, so it counts that path on every host name in the zone.

Shipcel marks what it makes with the app's ID, and changes or removes only that: rules made in Cloudflare's dashboard, or for another app, are listed and left alone. It needs the Cloudflare connection's **Zone WAF**, **Bot Management** and **Zone Settings** permissions. Cloudflare sign-ins set up from 23 October 2026 ask for them; an older one has to be set up again on Connections. Where one is missing, the rest is still shown.

## Find the version that broke it

```sh
shipcel bisect --good 1a2b3c4d                    # in a terminal: say whether each is good
shipcel bisect --good 1a2b3c4d --bad 9f8e7d6c --path /api/health --run "./check.sh"
```

`shipcel bisect` halves the versions between a good one and a bad one (the version serving all of production, unless `--bad` says) until it finds the first bad one, then says which version to roll back to. Each version is tried at its own address. With `--run`, your command decides: it gets the address as `SHIPCEL_BISECT_URL` and exits 0 for good, 125 to skip, and anything else for bad. Versions of a Worker with a Durable Object have no address of their own, so they are skipped.

## Your account: tokens, teams, usage and alerts

```sh
shipcel tokens ls                 # your API tokens; the one this computer uses is marked
shipcel tokens add "CI deploy"    # approve it in your browser; the terminal shows it once
shipcel tokens rm "CI deploy"     # revoke it (by name or prefix)
shipcel teams ls                  # your workspaces, and the one this sign-in works in
shipcel usage                     # this month's cost beyond what Cloudflare includes, per app
shipcel alerts --all              # what needs attention: budgets, health checks, failed deploys
shipcel webhooks ls --all         # each project's webhook and how its last delivery went
shipcel pricing d1                # Shipcel's and Cloudflare's plans and limits
```

`shipcel tokens add` opens the same page as `shipcel login`: check the code against your terminal and approve the token there, and the terminal shows it once. It expires after 90 days, or `--expires` 1 to 365; a token that never expires is made in the dashboard, under **API & CLI**. `shipcel tokens rm` revokes one; revoking the token this computer signs in with also signs it out.

`shipcel usage` is the whole workspace at a glance, from the budget guard's readings (every five minutes): each deployed app's cost this month beyond what Cloudflare includes, where it would end the month, its budget, and the Cloudflare account's figure. `shipcel budget` shows one app in detail.

`shipcel alerts` lists what needs attention, newest first: apps at 50% or 80% of their budget, over it, paused for it or on course to go over; usage the guard can't read; a failed health check; a failed deploy. In a linked folder it shows that project's; `--all` shows every project's.

`shipcel webhooks ls` shows, to a workspace owner, where each project's webhook sends and how the last delivery went. Webhooks are added, tested and removed in the dashboard, under **Manage → Notifications**, and teams are made and people invited under **Team**: a token can't send your projects' events somewhere new or change who is in a team. `shipcel pricing` works signed out.

## In CI

Create a token with `shipcel tokens add "CI deploy"` or under **API & CLI** in the dashboard, store it as a secret in your CI, and deploy without signing in:

```sh
SHIPCEL_URL=https://shipcel.com SHIPCEL_TOKEN=cc_pat_… \
  npx --yes --package=https://shipcel.com/cli/shipcel.tgz \
  shipcel deploy ./dist --prod --project my-site
```

A token always comes with the address of its Shipcel, so a token for a Shipcel you run yourself never goes anywhere else: set `SHIPCEL_URL` to that address and take the CLI from there. In a checkout of your project, `shipcel --prod --yes --project my-site` builds it in CI the same way it does on your computer. CI has to reach the address, so it needs a hosted Shipcel, not one running on your own computer.

In GitHub Actions no token is needed: the workflow `shipcel git connect` adds gives its runs `id-token: write`, and `shipcel deploy` there exchanges GitHub's token for the run for one that deploys the linked project only, for an hour, to production from the default branch and as a preview from any other.

A token acts as you in its workspace. It can deploy and manage projects, and list or revoke your tokens, but it can't create a token by itself (`shipcel tokens add` is approved in a browser), connect accounts, turn Free-only off, protect previews, add webhooks or manage teams.

## Options and environment

| Option                 | What it does                                                   |
| ---------------------- | -------------------------------------------------------------- |
| `--cwd <folder>`       | Run as if in another folder                                    |
| `--project <name\|id>` | The project, instead of the linked one                         |
| `--target <where>`     | `preview` or `production`, whatever the default would be       |
| `--prebuilt`           | Deploy what the last build wrote, without building             |
| `--build-command <c>`  | The command that builds the site (`""` for none)               |
| `--output <folder>`    | The folder the build writes                                    |
| `--token <token>`      | A token, instead of the saved one or `SHIPCEL_TOKEN`           |
| `--url <address>`      | The Shipcel address, instead of the saved one or `SHIPCEL_URL` |
| `--yes`, `-y`          | Don't ask; required for changes in scripts                     |
| `--json`               | Machine-readable output                                        |
| `--help`, `-h`         | Help; `shipcel help <command>` for one command                 |
| `--version`, `-v`      | The CLI's version                                              |

`SHIPCEL_CONFIG_DIR` moves the config folder.

## Coming from Vercel

| Vercel                                            | Shipcel                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `vercel login`                                    | `shipcel login` (GitHub, then Cloudflare)                            |
| `vercel`                                          | `shipcel` (the first deploy is production, as there)                 |
| `vercel --prod`, `vercel --target`                | `shipcel --prod`, `shipcel --target`                                 |
| `vercel build`, `vercel deploy --prebuilt`        | `shipcel build`, `shipcel deploy --prebuilt`                         |
| `vercel dev`                                      | `shipcel dev`                                                        |
| `vercel git connect`, `vercel git disconnect`     | `shipcel git connect`, `shipcel git ls`, `shipcel git disconnect`    |
| `vercel ls`, `vercel inspect`                     | `shipcel ls`, `shipcel inspect`                                      |
| `vercel promote`, `vercel rollback`               | `shipcel promote`, `shipcel rollback`                                |
| `vercel rolling-release`                          | `shipcel rolling-release` (two versions at a time)                   |
| `vercel redeploy`                                 | `shipcel redeploy` (GitHub projects)                                 |
| `vercel logs`, `vercel metrics`                   | `shipcel logs`, `shipcel metrics`                                    |
| Spend Management (dashboard)                      | `shipcel budget`; budgets and pausing in the dashboard               |
| `vercel env ls/add/update/rm/pull`, `vercel pull` | `shipcel env ls/add/update/rm/pull`, `shipcel pull`                  |
| `vercel domains ls/add/rm`, `vercel alias`        | `shipcel domains ls/add/rm`, `shipcel alias`                         |
| `vercel crons ls/add`                             | `shipcel crons ls/add/rm`                                            |
| `vercel curl`, `vercel httpstat`                  | `shipcel curl`, `shipcel httpstat`                                   |
| `vercel link`, `vercel project`, `vercel remove`  | `shipcel link`, `shipcel project`, `shipcel rm`                      |
| `vercel init`                                     | `shipcel init`                                                       |
| `vercel open`, `vercel activity`                  | `shipcel open`, `shipcel activity`                                   |
| `vercel mcp`, `vercel agent init`, `vercel api`   | `shipcel mcp`, `shipcel agent init`, `shipcel api`                   |
| `vercel upgrade`, `vercel telemetry`              | `shipcel upgrade`, `shipcel telemetry` (none is sent)                |
| `vercel switch`, `vercel teams list`              | `shipcel switch` (signs in to another workspace), `shipcel teams ls` |
| `vercel tokens ls`, `add`, `rm`                   | the same (`add` is approved in your browser)                         |
| `vercel usage`, `vercel alerts`                   | `shipcel usage`, `shipcel alerts`                                    |
| `vercel webhooks list`, `vercel pricing`          | `shipcel webhooks ls`, `shipcel pricing`                             |
| `vercel blob`, `vercel dns`, `vercel cache purge` | `shipcel storage` (or `blob`), `shipcel dns`, `shipcel cache purge`  |
| `vercel redirects`, `vercel bisect`               | `shipcel redirects` (applied with the next deploy), `shipcel bisect` |
| `vercel firewall`                                 | `shipcel security` (for the app's custom domains)                    |
| `vercel logout`, `vercel whoami`                  | the same                                                             |

Different from Vercel:

- **Your project is built on your computer**, not on Shipcel's servers. Shipcel has none: everything runs in your Cloudflare account. Deploys on every push are built by GitHub Actions, or by Cloudflare's own builds ([Deploy every push](#deploy-every-push)).
- **`env pull` brings names, not secret values**: Cloudflare never returns a secret.
- **A sign-in works in one workspace.** `shipcel switch` signs in again; teams and invitations are managed in the dashboard, and a new token is approved in the browser (`shipcel tokens add`).
- **A custom domain serves production.** There are no per-deployment aliases: promote a version, then add the domain.

Not available, and why: adding a webhook and `deploy-hooks` (a token can't create standing integrations: use the dashboard), `certs` (Cloudflare manages certificates for your domains), `git disconnect` for Cloudflare's own builds (Cloudflare holds that connection: remove it in its dashboard), `env run`, and Vercel-only products such as Flags, Sandbox, AI Gateway, Marketplace integrations and `buy`. Databases are in the dashboard's Manage tab.
