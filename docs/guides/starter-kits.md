# Starter kits

A starter kit is a complete new app, generated for your project, in exactly the shape Shipcel's GitHub deployments expect. Run it locally, push it to GitHub, and deploy it, or deploy the static kit straight from the CLI.

## The kits

| Kit               | What you get                                                 | Runs on                     |
| ----------------- | ------------------------------------------------------------ | --------------------------- |
| React             | a Vite frontend and a Hono API                               | Workers + Assets            |
| Vue               | a Vite frontend and a Hono API                               | Workers + Assets            |
| Hono              | a typed API                                                  | Workers                     |
| Postgres API      | a Hono API on a Postgres database, through Hyperdrive        | Workers + Hyperdrive        |
| Astro             | server rendering with `@astrojs/cloudflare`                  | Workers + Assets            |
| SvelteKit         | `@sveltejs/adapter-cloudflare`                               | Workers + Assets            |
| Next.js           | the OpenNext Cloudflare adapter                              | Workers + framework adapter |
| Python            | a Python Worker, run and deployed with pywrangler (needs uv) | Python Workers              |
| Container app     | a Worker in front of a container built from a Dockerfile     | Containers (Workers Paid)   |
| Umami             | web analytics, from its published image                      | Containers + Postgres       |
| n8n               | workflow automation, from its published image                | Containers + Postgres       |
| WordPress         | experimental: WordPress 7.1 in a container                   | Containers + MySQL + R2     |
| Static site       | HTML, CSS and JavaScript                                     | Workers Assets              |
| JavaScript Worker | a minimal Worker on web-standard APIs                        | Workers                     |

Every kit has a home page, a `/api/health` route, a README with its own steps, a check that refuses placeholder resource IDs before deploying, and example GitHub Actions workflows. Package versions are pinned to the versions Shipcel verified the kit with.

## Databases and file storage

When you create a kit project you can add:

- **an SQL database**: Cloudflare D1, bound as `DB`;
- **file storage**: Cloudflare R2, bound as `FILES`. R2 can bill beyond its free tier, so it needs Free-only off.

The kit declares them as draft bindings without IDs. Nothing is created until you deploy: then Wrangler creates them in your account, after you consent on the Deployments tab.

**Container kits** need Cloudflare's Workers Paid plan ($5 a month), so their projects can't be Free-only (the CLI asks before turning it off: `shipcel init umami --yes`). They deploy from GitHub with Cloudflare's builds, which `shipcel git connect` chooses for containers. The **Container app** kit builds its image from its Dockerfile (any language that listens on port 8080). **Umami** and **n8n** are services: Cloudflare pulls their published images from Docker Hub, and their data lives in a Postgres database you host elsewhere (Neon's free plan is enough), whose connection string you set as the `DATABASE_URL` secret with one more secret each; until both are set the app answers 503 and starts no container. Each runs one `basic` container (1 GiB) that sleeps when no one uses it; awake all month it costs about $6.50 beyond what Workers Paid includes, plus CPU, which the budget guard counts. After the first deploy, change Umami's `admin` password, or create n8n's owner account, at once: until then anyone with the address can. Plausible isn't offered (it needs ClickHouse), nor Ghost (it needs MySQL 8 and somewhere to keep uploads).

The **Next.js** kit comes with OpenNext's cache, so pages that revalidate (ISR) and Next.js's data cache keep their entries. With Free-only off, the entries live in an R2 bucket bound as `NEXT_INC_CACHE_R2_BUCKET`, with a Durable Object queue for revalidation and sharded Durable Objects for tags (`open-next.config.ts`); after each production deploy from the terminal or GitHub Actions, Shipcel fills the bucket with the pages Next.js prerendered, so their first visitors are served from the cache. In a Free-only project the kit keeps the cache in the app's own files instead: nothing that can bill, but those pages can't change between deploys. See [OpenNext's caching guide](https://opennext.js.org/cloudflare/caching).

The **Postgres API** kit is different: its `DB` binding is a Hyperdrive configuration for a Postgres database you host elsewhere (Neon, Supabase, PlanetScale, your own server). Add the database to the project first (**Manage → Database**, or `shipcel hyperdrive add DB`), and the exported kit carries its id; exported before that, it carries the placeholder `HYPERDRIVE_ID`, which the kit's deploy check refuses until you replace it. See [Databases and storage](databases-and-storage.md#postgres-and-mysql-through-hyperdrive).

## Create a kit project

- **Dashboard:** **New project** → **Starter kit**, choose the kit and the resources, **Create project**. The project's **Configuration** tab shows its Wrangler configuration, and **Export starter kit** downloads the files as a zip.
- **CLI:** `shipcel init <kit> [folder]` creates the project and writes the files into a new folder, linked to the project. `shipcel init` lists the kits.

```sh
shipcel init react my-app --database
cd my-app && npm install && npm run dev
```

## Run it locally

Each kit's README has the exact commands. Most kits run with `npm install` and `npm run dev`; local D1 and R2 data stay on your computer. The Python kit uses uv and pywrangler; its README covers the one-time `uv lock`.

## Deploy it

- **From GitHub** (every kit): push the folder to a new repository, then open the project's **Deployments** tab and choose that repository. The kit is already in the shape the import adapter expects. See [Deploy from GitHub](deploy-from-github.md).
- **From the CLI** (the static kit): `shipcel deploy public --prod` from the kit's folder.
- **With Wrangler directly**: every README also shows `npm run deploy`, using your own Wrangler login, if you'd rather not use Shipcel to deploy.

A kit is yours: Shipcel doesn't keep a copy or track changes. Exporting again generates the kit afresh for the project's current settings.

## Docker and WordPress

The **Container app** kit is the starting point for anything with a Dockerfile; Container Workers can also be imported from a repository (see [Deploy from GitHub](deploy-from-github.md)).

WordPress is PHP with a MySQL database: Workers run JavaScript, WebAssembly and Python, and D1 is SQLite, not MySQL. What you can do:

1. **Deploy a static copy (works today, on the free plan).** Export the site to files with a static-export plugin such as Simply Static or WP2Static, from a WordPress running anywhere (your computer, any host), then `shipcel deploy ./the-export-folder`, or drag the folder into the dashboard. Pages, posts, images and the theme are served as files, which Cloudflare serves free. Anything that needs PHP when a visitor arrives doesn't come along: comments, forms, search, logins and shops. Use a service for those (a form backend, a search widget), or the next option.
2. **Run WordPress headless (works today).** WordPress stays where it is hosted, as the place where you write and edit, and a front end built with Astro, Next.js or SvelteKit reads its content through the REST API (`/wp-json/wp/v2/posts`) or WPGraphQL. Shipcel deploys the front end; editors keep WordPress, visitors get a Cloudflare site.
3. **WordPress itself on Cloudflare (experimental kit, not yet run end to end).** The **WordPress** kit runs the official image (WordPress 7.1.4, PHP 8.4, Apache) in one container on Cloudflare Containers, with its database in a MySQL you host elsewhere, its uploads in an R2 bucket and its email through Cloudflare's Email Service. The container's disk doesn't last, so themes and plugins are built into the image, and a must-use plugin sends every upload to the Worker in front of WordPress, which keeps it in R2 and serves it from there; mail goes the same way. Nothing needs a storage or mail credential. It needs Workers Paid and bills for the time the container runs. Until it has passed its proof checklist (uploads surviving a restart, plugins, updates, cron, mail, a restored backup), use the first two routes for a site that matters.

## Your own kit

The catalog is one file per kit in Shipcel's repository. [Add a starter kit](add-a-starter-kit.md) shows how to write one, and how to add it to a Shipcel you run yourself.
