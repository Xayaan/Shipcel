# Databases and storage

Your app's data lives in your Cloudflare account: SQL in D1, files in R2, and key-value data in KV. Shipcel creates them when you deploy, after you consent, and gives you a place to browse, change, back up and restore them. A Postgres or MySQL database hosted elsewhere connects through Hyperdrive.

## Adding a database or storage

- **Starter kits:** tick **SQL database** (D1, bound as `DB`) or **File storage** (R2, bound as `FILES`) when you create the project.
- **Your own repository:** declare draft bindings, without IDs, in its Wrangler configuration. Wrangler creates them on the first deploy:

```json
{
  "d1_databases": [{ "binding": "DB", "migrations_dir": "migrations" }],
  "kv_namespaces": [{ "binding": "CACHE" }],
  "r2_buckets": [{ "binding": "FILES" }]
}
```

The Deployments tab lists each one as **Resources to create**, and nothing is created until you consent. Cloudflare names them after the deployed Worker. Existing resource IDs are refused, so an app never attaches to data it didn't create.

## D1: the SQL database

**Manage → Database** has three parts:

- **Data:** browse tables 50 rows at a time, and run SQL. A single `SELECT` or `EXPLAIN` runs at once (up to 200 rows shown). Anything that changes data asks first, then records a restore point, so you can undo it.
- **Migrations:** Shipcel reads the `.sql` files in the binding's `migrations_dir` at the deployed commit, shows which haven't run, and applies them in order after you review them. Each run records a restore point first.
- **Backups:** **Export** downloads the whole database as SQL (Cloudflare pauses the database's queries while an export runs). **Restore** puts the database back to any minute in the past 30 days (7 on Workers Free) with D1 Time Travel, and keeps an undo point. **Scheduled copies** keeps copies in R2 for as long as you choose (below).

With branch previews on, the same tools also work on the previews' separate copy of the database.

## Scheduled backups to R2

**Manage → Database → Scheduled copies** copies the production database into an R2 bucket in your Cloudflare account every day or every week, at the hour (UTC) you pick, and keeps the newest copies, from 1 to 90. Each copy is Cloudflare's own SQL export of the database, the same file **Export** gives you, and any of them downloads from the list.

- The first time, Shipcel makes a bucket named after the Worker, ending in `-backups`, and keeps copies only there. If a bucket of that name exists already, it asks you to rename or remove it first.
- Cloudflare pauses the database's queries while it exports, usually for seconds, so pick a quiet hour. **Back up now** makes a copy at once.
- A copy can be up to 300 MB, the most one upload through Cloudflare's API takes. For a larger database, keep copies with `wrangler d1 export`; Time Travel covers the last 30 days either way.
- A copy that fails says why and stays listed for a month; the next one runs at its usual time.
- A copy that can't start (the project is Free-only or paused by the budget guard, isn't deployed, or Cloudflare was disconnected) says why on the schedule, and Shipcel tries again an hour later.
- Stopping backups, or removing the project, makes no more copies. Those made stay in the bucket until you delete them; started again, copies go on into the same bucket. While backups run, Free-only can't be turned back on.
- R2 stores 10 GB free, then bills $0.015 per GB-month, so backups need Free-only off.

To bring a copy back, run it against a database without those tables, such as a new one:

```sh
npx wrangler d1 create my-app-copy
npx wrangler d1 execute my-app-copy --remote --file=2026-10-30T03-00-12Z-1a2b3c4d.sql
```

The file creates the tables and inserts the rows. Within the last 30 days, **Restore** (Time Travel) is quicker and needs no file.

## KV and R2: the storage browser

**Manage → Storage** lists the KV namespaces and R2 buckets the deployed Worker binds:

- **KV:** list keys by prefix, open a value (text up to 64 KB), download it, set or delete one. Setting a value keeps the key's metadata and expiration.
- **R2:** browse objects folder by folder, download them, upload files up to 25 MB, and delete them.

Every change asks first and is recorded in the project's operations. Viewers can't open the browser; it shows your data.

## Postgres and MySQL through Hyperdrive

Cloudflare doesn't host Postgres or MySQL, but Hyperdrive pools and caches connections from your Worker to a database hosted anywhere: Neon, Supabase, PlanetScale (which you can create from the Cloudflare dashboard, on the Cloudflare bill), or your own server. Shipcel turns a connection string into a Hyperdrive configuration in your account; the password goes to Cloudflare and nowhere else, and Shipcel keeps only the binding, host and database name.

1. **Manage → Database → Postgres and MySQL**, or `shipcel hyperdrive add DB` (it asks for the connection string, `postgres://user:password@host:5432/database` or `mysql://…`, without showing it).
2. Put the snippet it shows in your Wrangler configuration, beside the other bindings:

```json
{ "hyperdrive": [{ "binding": "DB", "id": "the configuration id" }] }
```

3. Deploy. Your code reads `env.DB.connectionString` and connects with any Postgres or MySQL driver (`postgres`, `pg`, `mysql2`), with `nodejs_compat` in `compatibility_flags`. The **Postgres API** starter kit is this, ready to run.

A `hyperdrive` entry is accepted only for a database added to the same project, so an app never reaches a database it wasn't given. Branch previews bind the same database (there is no staging copy of a database hosted elsewhere); list it under `previews` too. Removing the database from Shipcel removes the Hyperdrive configuration; the database itself stays where it is hosted.

## Free limits and billing

D1 and KV stop at their free daily limits on Workers Free instead of billing you. R2 is pay-as-you-go beyond its free tier, so it needs Free-only off: see [Free-only and billing](free-only-and-billing.md). Hyperdrive is free up to 100,000 queries a day (10 configurations) and unlimited on Workers Paid (25); the Postgres or MySQL database behind it is billed by whoever hosts it.

## Your data stays yours

Removing a project from Shipcel never deletes its databases, namespaces or buckets: they stay in your Cloudflare account, where you can delete them yourself.
