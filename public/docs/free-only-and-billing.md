# Free-only and billing

Shipcel's Free plan costs nothing, and your apps use Cloudflare's free allowance in your own account. Free-only, on by default for every project, makes sure Shipcel never creates anything Cloudflare can bill for. The budget guard watches what every deployed app costs, alerts, and can pause an app that goes over its budget.

## Who bills what

- **Shipcel Free** is $0 a month, with no card.
- **Cloudflare** bills your account directly for usage beyond its free allowance, at its own prices. Shipcel adds no markup.

On Workers Free, Workers, D1 and KV stop at their daily limits until midnight UTC instead of billing you, so an app can't run up a bill there. Some products always can: R2 storage beyond its free tier, and containers, which need the Workers Paid plan.

R2 does have a free allowance every month (on 14 October 2026: 10 GB-month of Standard storage, 1 million Class A and 10 million Class B operations, and no egress charge). It works differently from the Workers Free plan, though: R2 is a subscription of its own, added through a checkout in Cloudflare's dashboard, and Cloudflare bills usage beyond the allowance every month instead of stopping the bucket. That is why a Free-only project, which promises nothing can bill, leaves R2 out, while D1 and KV, which stop at their limits, are allowed.

## Free-only

While a project's Free-only is on, Shipcel refuses anything that can bill:

- R2 file storage, when you create the project, review a repository, deploy or turn on previews;
- containers: a Docker project can't be created Free-only.

Everything else works and stops at Cloudflare's free limits while your account stays on Workers Free.

Turning Free-only off is an owner's decision, made in the dashboard: the project's **Billing** panel asks you to confirm that Cloudflare may bill for R2 and containers. API tokens, the CLI and AI agents can't turn it off. You can turn it back on while the project uses nothing billable. To use R2, your Cloudflare account also needs its R2 subscription.

## Cloudflare's free allowance

Cloudflare's current limits are on its pricing pages and on Shipcel's pricing page, with the date they were checked. Roughly: 100,000 Worker requests a day with 10 ms of CPU time each, unlimited static file requests, 5 million D1 rows read and 100,000 written a day with 5 GB stored, 100,000 KV reads and 1,000 writes a day, 3,000 build minutes a month, and 10 GB of R2 storage. Prices and limits change; check Cloudflare's own pages before you rely on them.

## Workers Paid

If you upgrade your Cloudflare account to Workers Paid ($5 a month), Cloudflare's limits rise and usage beyond them is billed. Free-only still keeps R2 and containers out of a project until you turn it off.

Cloudflare has no spending cap on Workers Paid. A bug such as a Durable Object alarm that sets itself again can make millions of requests and row writes an hour, and Cloudflare bills every one. That is what the budget guard is for.

## The budget guard

Every five minutes, for each deployed project, Shipcel reads Cloudflare's own analytics for the month so far and estimates what the project costs beyond what Cloudflare includes. The project's **Billing** panel shows the estimate, meter by meter, with its budget.

- **What it counts.** Worker requests; Durable Object requests and alarms, rows read and written, and running time; D1 rows read and written; KV reads, writes, deletes and lists; R2 operations; containers' CPU time, memory and disk, from the usage Cloudflare bills them by. It prices what the whole account used beyond what Workers Paid includes, at Cloudflare's prices (checked 14 October 2026; containers 29 October 2026), and gives each project its share by use. Cloudflare's container analytics don't say which app a container belongs to, so every project that deploys containers counts all of the account's: with two such apps, each is alerted early, never late. The $5 Workers Paid subscription isn't counted. Not in the estimate: stored data, Workers CPU time, containers' network egress, and the storage operations of Durable Objects that use key-value storage rather than SQLite. When Cloudflare doesn't report a product, the panel says so: the estimate may be low.
- **The budget.** $0 a month beyond what Cloudflare includes, until an owner sets another in the Billing panel.
- **Alerts.** At half the budget, four fifths of it, and over it; and when the rate of the last few minutes would take the month over it (at most every six hours). Alerts show in the Billing panel and as a badge on the project, and go to the project's webhook (Manage → Notifications) whatever events it was set to send: Slack, Discord or any HTTPS endpoint. The guard also says when it can't read a project's usage for an hour, at most once a day, since it can't alert or pause then.
- **Over the budget: alert only, or pause.** Alert only is the default: the app keeps running. With **Pause the app**, Shipcel switches production to a stand-in version that answers 503, keeps every Durable Object class and so its data, lets an alarm that fires end there (it isn't set again), puts off queue messages, and keeps the app's secrets; the cron schedules are removed. While the app is paused, production deploys, rollbacks, secrets and schedules wait. If a new version goes live some other way (a push build, Wrangler), the guard pauses it again at its next reading while the month's estimate stays over a budget that pauses.
- **Resuming.** In the Billing panel, once the budget allows it: raise the budget, or switch to alerts only. Production goes back to the versions it served before the pause and the schedules come back. If the bug is still there it will cost money again, so deploy the fix right after.
- **Pause now.** An owner can pause an app at once from the Billing panel, whatever the estimate.
- **Who decides.** Budgets, pausing and resuming belong to a workspace owner in the dashboard. API tokens, the CLI and AI agents can read the guard's reading and ask for a new one (`shipcel budget`, `shipcel budget check`), not change it, so an agent can't raise a budget to get past it.
- **Your plan.** On Workers Free, Workers, Durable Objects, D1 and KV stop at their daily limits, so only R2 can cost anything. Shipcel reads the plan with Cloudflare's Billing Read permission when Cloudflare offers it to Shipcel's sign-in; without it, the guard estimates as if the account were on Workers Paid, which still shows $0 on Workers Free unless R2 is used. A day far past a free limit shows the account is on Workers Paid.

What the guard can't do:

- It is an estimate from Cloudflare's analytics, which are sampled and arrive a few minutes late. Cloudflare's invoice is what counts.
- It reads every five minutes, so a pause comes minutes after the budget is crossed, not at once. A loop running for those minutes still costs something; a $0 budget keeps that small.
- It runs where Shipcel runs. A hosted Shipcel checks around the clock. A Shipcel on your computer checks while `npm run dev` runs, and not while the computer sleeps.
- It watches projects deployed through Shipcel. The Billing panel's **Whole account** figure includes other Workers in the account, but the guard doesn't alert on or pause them.

The surest way not to be billed is still a Free-only project on an account that stays on Workers Free: then nothing Shipcel deploys can cost money.

On Workers Paid, also turn on Cloudflare's own budget alert, which works whether or not Shipcel is running: in Cloudflare's dashboard, **Manage Account → Billing → Billable Usage → Create budget alert** (pay-as-you-go accounts). It emails you once when the account's usage-based spend for the billing period passes the amount you set. Like the guard's alerts, it doesn't stop anything by itself.
