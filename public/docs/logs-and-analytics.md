# Logs and analytics

See how your app is doing: requests, errors, response times and CPU time from Cloudflare's analytics, HTTP status codes and recent requests and exceptions from Workers Logs, and notifications when a deploy or a health check fails.

## Analytics

**Manage → Analytics & logs** shows, for the last 24 hours, 7 days (by hour) or 30 days (by day):

- requests and errors, as a chart and a table;
- response time (from the request to the response, waiting on databases and other services included) and CPU time: an approximate median and the highest 99th percentile, in milliseconds, with a chart of response time over the period;
- outcomes in plain words, such as exceptions or exceeded CPU limits;
- **HTTP status codes**: how many requests got each status, and 4xx and 5xx over time. These come from Workers Logs, so they cover at most the days it keeps (3 on Workers Free, 7 on Workers Paid) and only requests that ran the app's code.

The numbers come from Cloudflare's GraphQL Analytics for your app's Worker. Every chart has the same numbers in a table under it. `shipcel metrics --since 30d` prints the totals in the terminal.

The project's **Billing** panel charts the month day by day: the estimated cost so far against the budget, and each kind of usage (requests, rows read and written…) against Workers Free's daily limits or Workers Paid's monthly allowance.

## Visitors

**Manage → Visitors** shows Cloudflare Web Analytics for the app: page views and visits over time, top pages, referrers, countries, devices and browsers, and Core Web Vitals (Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift at the 75th percentile, with how many page views were good, needed improvement or were poor). It is free and uses no cookies; Cloudflare samples the numbers and leaves out bots.

Web Analytics counts visitors with a small script in your pages, so it needs two things once:

1. **A Web Analytics site in Cloudflare** for the app's address (`<app>.<subdomain>.workers.dev`, or a custom domain). Shipcel can't add it for you (Cloudflare asks for a permission Shipcel doesn't request): open Web Analytics in Cloudflare's dashboard and add the site; the Visitors tab links there. Shipcel then finds it by the app's addresses. A site set up for a whole zone works too: only the app's addresses are counted.
2. **Cloudflare's script in the app's pages**, just before `</body>` (in a framework app, its root layout), then a deploy. Once the site exists, the Visitors tab shows the script to copy until page views arrive.

## Logs

The same tab lists recent events from Workers Logs, with a period, an errors-only filter, and a search box (Workers Logs' full-text search: an error message, a path, a request ID). Turn on **Live** to add new events every five seconds while you watch; Workers Logs has an event a few seconds after it happens. From the terminal:

```sh
shipcel logs                     # the last hour
shipcel logs --since 1d --errors
shipcel logs --follow            # new events every few seconds; Ctrl+C stops
```

Workers Logs records events while observability is on for the Worker:

- **Apps deployed from a folder** (the CLI, drag and drop or an AI agent): the first deploy turns Workers Logs on, as Cloudflare's dashboard does for every new Worker, and later deploys keep whatever the Worker is set to. Only `_worker.js` runs code, so a site without one has nothing to log.
- **GitHub projects**: add `"observability": { "enabled": true }` to the Wrangler configuration.

Workers Free includes 200,000 log events a day, kept for 3 days. Workers Paid includes 20 million a month, kept for 7 days, then charges $0.60 per million more ([Cloudflare's Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)). To turn logs off, turn off Workers Logs in the Worker's settings in Cloudflare's dashboard; later deploys keep it off.

## Build logs

For apps that deploy every push with GitHub Actions, each run is on GitHub (**Runs on GitHub** on the Deployments tab) and each deploy is in the project's history. For apps Cloudflare's own builds deploy, **Manage → Builds & versions** lists those builds; **Logs** under a build shows its log from Cloudflare's Workers Builds, and while the build is still running, new lines appear every few seconds. Only the app's recent builds (its last 150) can be opened.

## Deploy notifications

**Manage → Notifications** sends a project's events to up to three places, each set up on its own:

- **A webhook:** Slack, Discord or any HTTPS endpoint. Each delivery is signed: check `X-Shipcel-Signature` (`sha256=` and the HMAC-SHA256 of `timestamp.body` with your signing secret, shown once) and `X-Shipcel-Timestamp`.
- **Telegram:** messages from your own bot. Create one with @BotFather and paste its token, then send the bot a message or add it to your group or channel: Shipcel finds the chat from the bot's latest update and says hello there before saving. If the bot has a webhook of its own, give the chat id instead (a number, or `@` and a channel's name). The token is stored encrypted.
- **Email:** to any address, once someone with that inbox opens the confirmation link and presses **Confirm**; until then nothing is sent to it. A workspace sends at most five confirmation emails an hour. Each email has a link that stops them. The emails come from the sender a hosted Shipcel sets up for Cloudflare's Email Service ([Self-hosting](self-hosting.md#host-it)).

The events:

- `deployment.ready` and `deployment.failed` for GitHub deployments and builds,
- `upload.deployed` for uploads and previews,
- `health.unhealthy` and `health.healthy` from the checks after deploys and promotions,
- `budget.alert`, `budget.paused` and `budget.resumed` from the [budget guard](free-only-and-billing.md#the-budget-guard). These go to each place whatever events it was set to send.

Failed deliveries are retried twice. Notifications are set up in the dashboard only, because they send data out of Shipcel.

## Operations history

Every change Shipcel makes for a project (deploys, secrets, domains, rollbacks, migrations…) is recorded with its result under **Manage**. If one was interrupted, **Check Cloudflare** looks at your account and records what actually happened.
