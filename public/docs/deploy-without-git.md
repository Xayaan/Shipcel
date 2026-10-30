# Deploy without Git

Deploy a site or an app straight from your computer to your Cloudflare account: run `shipcel` in its folder, drop a built folder on the dashboard, or ask your AI agent. There's no repository and no build on Cloudflare's side, so nothing needs setting up in Cloudflare first.

## What you can deploy

Two kinds of project deploy this way. **An app with code and bindings** (Next.js, SvelteKit, Astro with its adapter, or any Worker with a `wrangler.jsonc`, including D1, KV and R2) deploys from the terminal only: `shipcel` builds it and runs Wrangler for you, see [The CLI](cli.md#apps-with-code-databases-and-bindings). **A site** is a folder such as `dist`, `build` or `out`, with:

- static files, served by Workers Static Assets. Requests for them are free and run no code;
- an optional `_worker.js`: an ES module that handles every request no file matches, for an API or server-side logic. It reaches the files as `env.ASSETS` and your secrets as `env.<NAME>`;
- optional `_redirects` and `_headers` files, with the same rules as other static hosts;
- `404.html` for unknown paths. With a single `index.html` and no `404.html`, unknown paths go to `index.html`, for single-page apps.

Limits: 20,000 files, 24 MiB a file, 1 MiB for `_worker.js` and 64 KiB for `_redirects` or `_headers`. Hidden files and `node_modules` are left out. A folder of files can't replace an app that Wrangler deploys: that project keeps deploying with `shipcel` from its folder.

## From the dashboard

1. Create a project with **New project** (a starter kit project works: its kit export is separate).
2. Open its **Deployments** tab and drop the folder on **Or drag and drop a folder**, or click **Choose a folder**.
3. Review the files. Leave **Publish now** off to keep the app unpublished at first, or tick it, then click **Deploy** and confirm.

## From the terminal

```sh
shipcel                        # builds this project and deploys it
shipcel --prod                 # production, for every deploy after the first
shipcel deploy ./dist --prod   # or a folder that is already built
```

In a project's folder the CLI recognises the framework (Vite, Create React App, Vue CLI, Astro, Gatsby, Docusaurus, VitePress, Eleventy, Hugo, Jekyll and others, or any `build` script once you name its output folder), runs the build on your computer and deploys what it wrote. The first deploy creates and links a project, and goes to production; later deploys are previews unless you pass `--prod`. See [The CLI](cli.md) for every option.

## Published, or unpublished first

From the CLI, a new app's first deploy goes to production and is published at its main address, as on Vercel. To check it before it gets its main address, deploy it as a preview first: `shipcel --target preview` creates the app **unpublished**. Its preview address, `https://<version>-<app>.<subdomain>.workers.dev`, works for anyone you share it with, but its main address doesn't answer yet. The dashboard's drag and drop starts unpublished too, unless you tick **Publish now**. Publish with **Publish** on the Deployments tab, `shipcel promote <version>` or `shipcel --prod`; `shipcel unpublish` turns the main address off again. Unpublished means unlisted, not private: to require a sign-in, see [Previews and rollbacks](previews-and-rollbacks.md).

## Each deploy is a version

Shipcel uploads only the files Cloudflare doesn't already have, then creates a new version of the app's Worker:

- **from the dashboard**, the new version goes live straight away;
- **from the CLI**, a new app's first version goes live; after that a deploy without `--prod` is a preview: it gets its own address and production keeps serving the current version until you promote it.

Every version stays available for rollback. See [Previews and rollbacks](previews-and-rollbacks.md).

## Moving to Git later

A project deployed by upload stays an upload project: the Deployments tab offers uploads only. To deploy the same app from GitHub on every push, give its repository a project of its own: `shipcel git connect --name <another-name>` in its folder, or **New project** → **GitHub repository**.
