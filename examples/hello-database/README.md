# hello-database

A Worker for trying what `shipcel` deploys beyond files: a D1 database, a KV namespace, a Durable Object, a variable, a cron schedule and a static page. It has no dependencies and no build step.

Copy it out of the Shipcel folder first (Shipcel's own dev server watches that folder), then deploy it from its own folder:

```sh
cp -R examples/hello-database ~/hello-database
cd ~/hello-database
shipcel deploy --prod
```

`shipcel` shows what it detected and asks before Cloudflare creates the database (`hello-database-db`) and the namespace (`hello-database-cache`). Both are on Cloudflare's free plan.

Open the app's address: the page calls `/api/check`, which adds a row to the database, writes and reads the namespace, and asks the Durable Object for its next number. `lastScheduledRun` is filled in by the schedule, which runs every fifteen minutes.

```sh
shipcel deploy          # a preview: a new version at its own address
shipcel deploy --prod   # production again; the database and namespace are reused
shipcel ls              # versions
shipcel logs --since 30m
shipcel crons ls
```

See [the CLI guide](../../docs/guides/cli.md#apps-with-code-databases-and-bindings).
