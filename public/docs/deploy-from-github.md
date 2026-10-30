# Deploy from GitHub

Connect a repository and every push deploys. Shipcel adds a GitHub Actions workflow to the repository: GitHub builds each push and deploys it to your Cloudflare account through Shipcel. Pushes to the default branch go to production, and other branches get a preview. Nothing is set up in Cloudflare, and the repository holds no secret: each run signs in with GitHub's own token for that run.

## Before you start

On **Connections**, once:

- **GitHub is connected**, and Shipcel's GitHub App can see the repository. You need push access to it. The app asks for read and write access to the repository's contents and workflows, which is what lets it add the workflow file.
- **Cloudflare is connected**, with the account your apps deploy to. With one Cloudflare account, Shipcel deploys to it; with several, you choose one.
- **The account has a `workers.dev` subdomain.** If it doesn't, the first deploy says so, and Deployments offers to claim one.

The **Deploying from GitHub** box there says when that's done. GitHub's runners reach Shipcel over the internet, so a Shipcel running on your own computer deploys pushes with [Cloudflare's own builds](#builds-by-cloudflare) instead.

## Connect a repository

On a project's **Deployments** tab, under **Deploy from GitHub**:

1. Choose the repository. The one the project was created with is chosen already; **Change repository** picks another.
2. **What Shipcel adds** shows the workflow, `.github/workflows/shipcel.yml`, before anything changes.
3. Tick the box and click **Connect repository**.

Shipcel commits the workflow to the default branch. That commit is a push too, so GitHub starts the first deploy straight away: **Runs on GitHub** opens its progress. Every deploy then appears in the project's deploy history, as one from your computer would.

From the terminal, `shipcel git connect` in the repository's folder does the same. See [Deploy every push](cli.md#deploy-every-push).

### If GitHub refuses the commit

A protected default branch takes changes through pull requests only, and a GitHub App without permission for workflows can't add one. The repository is linked anyway, and **Add it on GitHub** opens GitHub's new-file page with the workflow filled in: commit it there, or propose it in a pull request. A `.github/workflows/shipcel.yml` the repository has already is kept as it is.

Shipcel's GitHub App commits only where it is installed. When it isn't installed on the repository's owner, or was given other repositories than this one, Shipcel says so and links GitHub's page for it: install it there, or add the repository, then **connect again**, and Shipcel adds the workflow.

## What happens on each push

```yaml
name: Shipcel
on:
  push:
    branches: ['**']
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
concurrency:
  group: shipcel-${{ github.ref }}
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          package-manager-cache: false
      - run: npx --yes --package=https://shipcel.com/cli/shipcel.tgz shipcel deploy
        env:
          SHIPCEL_URL: https://shipcel.com
```

(From a Shipcel you run yourself, the workflow names its address instead.)

- GitHub checks out the commit and sets up Node.js 24, which comes with npm 11.
- `shipcel deploy`, the CLI your Shipcel serves, asks GitHub for a token that names this run (`id-token: write`), and Shipcel exchanges it for one that deploys this project only, for an hour. Shipcel checks GitHub's signature, that the token was made for your Shipcel and the linked repository, and that it is used only once.
- It then builds and deploys the way `shipcel` does on your computer: a site as files, and an app with code or bindings through Wrangler. See [The CLI](cli.md).
- **The default branch** deploys to production. **Any other branch** deploys a preview: a new version with its own address, while production keeps serving the current one. A branch's run can't change production, and previews start after the first production deploy.
- Runs of one branch go one at a time. Pushes and manual runs (**Run workflow** on GitHub) deploy; tags and pull requests don't.
- Runs use the repository's GitHub Actions minutes: free for public repositories, and GitHub's plans include minutes for private ones.
- Variables the build needs go in the workflow's `env` or in the repository's GitHub Actions variables. Secrets for the running app are set in Shipcel: see [Environment variables](environment-variables.md).

Deploys act for the person who connected the repository. If they leave the workspace or become a viewer, runs stop until someone else connects it again. So does a repository moved to another owner.

## Disconnect

**Disconnect repository** (or `shipcel git disconnect`) stops the repository's pushes from deploying. Shipcel changes nothing in the repository: delete `.github/workflows/shipcel.yml` there too, or its runs fail.

## What a repository needs

### Sites: nothing to add

A site that builds to static files deploys as it is, like a framework preset on Vercel: Shipcel recognises the tool that builds it, runs its build, and writes the Wrangler configuration while it deploys.

| Built with                                                    | Shipcel serves                                                      | Unknown paths                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| Vite (React, Vue, Svelte, Preact, Solid or plain)             | `dist`, or the `build.outDir` in `vite.config`                      | go to `index.html` (single-page app) |
| Create React App                                              | `build`                                                             | go to `index.html`                   |
| Vue CLI                                                       | `dist`                                                              | go to `index.html`                   |
| Astro, without a server adapter                               | `dist`                                                              | get `404.html`                       |
| Gatsby                                                        | `public`                                                            | get `404.html`                       |
| Plain HTML, CSS and JavaScript, with `index.html` at the root | the repository's files, except `.git`, `.github` and `node_modules` | get `404.html`                       |

- The build runs `npm run build`, so `package.json` needs a `build` script. Dependencies install from the repository's lockfile, whichever of npm, pnpm, Yarn and Bun made it; without a lockfile they still install, but each build may get newer versions.
- Keep one lockfile. Two from different package managers have to be fixed first.
- To serve the site differently, commit your own `wrangler.jsonc`: Shipcel then uses it as it is.

### Apps: a Wrangler configuration

Apps with server code or Cloudflare bindings (a Worker, D1, KV, R2…) deploy with their own configuration, from the repository's root:

- `package.json` with a `build` script if the app needs building, and a committed lockfile.
- A root `wrangler.json` or `wrangler.jsonc`. TOML and programmatic configurations aren't read.
- Resource bindings as drafts, without IDs: Wrangler creates them on the first deploy. Existing resource IDs are refused, so a new app never attaches to someone else's data.

### Frameworks

| Framework | What to commit                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Astro     | for server rendering: `@astrojs/cloudflare`, set up once with `npx wrangler setup` (a static Astro site needs nothing)                                      |
| SvelteKit | `@sveltejs/adapter-cloudflare` and a `wrangler.jsonc` whose `main` is `.svelte-kit/cloudflare/_worker.js`                                                   |
| Next.js   | `@opennextjs/cloudflare` 1.20.13 or later, set up once with `npx wrangler setup`, and Next.js 16.4.1 or later; Cache Components don't run on Cloudflare yet |
| Python    | a Python Worker with `python_workers` in `compatibility_flags`; Python packages deploy with [Cloudflare's own builds](#builds-by-cloudflare)                |

The [starter kits](starter-kits.md) are already in these shapes. Containers, queues, routes and Python packages deploy only with [Cloudflare's own builds](#builds-by-cloudflare) for now.

## Builds by Cloudflare

For what GitHub Actions can't deploy yet (containers, whose images Cloudflare's builds make; queues; routes; Python Workers with packages) and for a Shipcel on your own computer, Cloudflare can build every push itself instead, with Workers Builds. It needs two things once per Cloudflare account: Cloudflare's own GitHub app, and a build token. On a hosted Shipcel, **Cloudflare's own builds (optional)** at the bottom of Connections sets up both; on your own computer they are on the GitHub and Cloudflare cards. Then connect the repository with **Build with Cloudflare instead** on the project's Deployments tab, or with `shipcel git connect --cloudflare-builds`.

### Connect GitHub in Cloudflare

Shipcel checks whether Cloudflare can read your repositories. If it can't, **Connect GitHub in Cloudflare** opens Cloudflare's **Create application** page for your account. There, choose **GitHub**, sign in to GitHub if asked, give _Cloudflare Workers and Pages_ your account and its repositories, then **Install & Authorize**. When Cloudflare lists your repositories you're done: nothing needs creating. This is how [Cloudflare's docs](https://developers.cloudflare.com/workers/ci-cd/builds/) connect a repository to Workers Builds, through the dashboard, which links its GitHub app to your Cloudflare account. When you come back, Shipcel checks again by itself. **Repository access on GitHub** opens the app's settings to add another repository later.

### Add a build token

Cloudflare runs these builds with a build token: an API token of yours that Workers Builds keeps. Cloudflare only accepts user API tokens for this and doesn't let apps create one ([Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)), so you make it once per Cloudflare account:

1. **Create the token in Cloudflare** opens Cloudflare's token page with the permissions filled in: Workers Scripts, KV, R2, D1 and Workers Routes (edit), Account Settings, User Details and Memberships (read). Choose **Continue to summary**, then **Create Token**, and copy it.
2. Paste it under **API token** and click **Add build token**.

Shipcel checks the token with Cloudflare, registers it with Workers Builds as _Shipcel builds_ and keeps no copy. Only workspace owners can add one. Revoking the API token in Cloudflare stops the builds that use it.

### Deploy with Cloudflare's builds

Deployments reviews the repository at its latest commit: the branch and commit, the adapter, the D1 databases, R2 buckets and KV namespaces to create (each needing your consent), containers with their instance size and limits, and anything to fix first. Choose the app's free address, tick the consent box and click **Deploy repository**. Shipcel creates the Worker, connects the repository, creates a build trigger for the default branch and starts the first build, which Cloudflare runs. From then on Cloudflare builds and deploys every push to the default branch. If a step can't finish, **Check Cloudflare and resume** checks what already exists and continues without creating anything twice. A project deploys one way: one Cloudflare builds isn't deployed with GitHub Actions too.

## After the first deploy

- **Previews**: with GitHub Actions every branch gets a preview by itself. With Cloudflare's builds, turn branch previews on from the Deployments tab. See [Previews and rollbacks](previews-and-rollbacks.md#branch-previews-github).
- **Secrets** for the running app: see [Environment variables](environment-variables.md).
- **Deploy again**: run the workflow on GitHub (Actions → Shipcel → **Run workflow**). With Cloudflare's builds: Manage → Builds & versions, or `shipcel redeploy`.
- A project deploys one repository. To deploy another, create another project.
