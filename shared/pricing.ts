// Shipcel's and Cloudflare's plans, as the public site (site/content.ts, which re-exports
// them) and `shipcel pricing` show them. Every price and limit comes from Cloudflare's
// official pages (the site's /pricing/ lists them), checked on `checkedOn`.
// Inline markup: `code`, **bold**.

export const checkedOn = '8 October 2026';

// Shipcel's Free plan (worker/plans.ts, migration 0014).
export const shipcelFree = [
  '**Up to 100 projects**, as many Workers as Cloudflare’s free plan allows in one account',
  '**Free-only mode, on by default:** nothing a project can be billed for, such as R2 storage or containers, is created',
  '**A budget guard for every app:** alerts at 50%, 80% and over a budget you set ($0 beyond what Cloudflare includes, by default), and an optional pause',
  'Deploys from GitHub on every push, and a preview address for every branch and pull request, on staging copies of your data',
  'Deploys without Git: `shipcel` from your terminal, drag and drop, or your own AI agent through MCP',
  'A free address for every app, `your-app.your-name.workers.dev`, and custom domains when you want them',
  'D1 SQL databases, R2 file storage and KV, created in your account after you review them',
  'Sign-in for your users (passkeys, GitHub, Google, email) and realtime channels, in your account',
  'Database migrations, exports and point-in-time restore',
  'Health checks after every deploy, one-click rollback, traffic splitting, and recovery of interrupted steps',
  'Fourteen starter kits, including Next.js, Python, containers, Umami, n8n and WordPress (experimental), and imports of existing repositories (containers need Workers Paid, Cloudflare’s $5-a-month plan)',
  'No monthly limit on deployments; one setup runs at a time, like Cloudflare’s single free build',
];

// What apps get in the customer's Cloudflare account. Free and Workers Paid columns.
export const cloudflareFree = [
  {
    service: 'Server code (Workers)',
    free: '100,000 requests a day, 10 ms CPU time per request',
    paid: '10 million requests and 30 million CPU-milliseconds a month included, then $0.30 per million requests and $0.02 per million CPU-milliseconds; up to 5 minutes of CPU per request (30 seconds by default)',
  },
  {
    service: 'Static files',
    free: 'Free and unlimited requests',
    paid: 'Free and unlimited requests',
  },
  {
    service: 'D1 SQL databases',
    free: '5 GB in total, up to 10 databases of 500 MB; 5 million rows read and 100,000 rows written a day; 7 days of point-in-time restore',
    paid: '25 billion rows read and 50 million written a month included, then $0.001 and $1.00 per million; 5 GB included, then $0.75 per GB-month; databases up to 10 GB; 30 days of restore',
  },
  {
    service: 'Postgres and MySQL through Hyperdrive',
    free: '100,000 queries a day to a database hosted elsewhere, which bills you itself',
    paid: 'Unlimited queries',
  },
  {
    service: 'KV key-value data',
    free: '100,000 reads and 1,000 writes a day; 1 GB stored',
    paid: '10 million reads and 1 million writes a month included, then $0.50 and $5.00 per million; 1 GB, then $0.50 per GB-month',
  },
  {
    service: 'R2 file storage',
    free: '10 GB stored, 1 million writes and 10 million reads a month; no egress fees. R2 bills usage beyond this even on the free plan',
    paid: 'After the free amounts: $0.015 per GB-month, $4.50 per million writes, $0.36 per million reads; no egress fees',
  },
  {
    service: 'Durable Objects (realtime)',
    free: '100,000 requests and 13,000 GB-seconds a day; idle WebSocket connections hibernate at no cost',
    paid: '1 million requests and 400,000 GB-seconds a month included, then $0.15 per million requests and $12.50 per million GB-seconds; outgoing WebSocket messages are free',
  },
  {
    service: 'Builds',
    free: '3,000 build minutes a month, one build at a time',
    paid: '6,000 minutes a month included, then $0.005 a minute; six builds at a time',
  },
  {
    service: 'Email sending',
    free: 'Not offered',
    paid: '3,000 a month, then $0.35 per 1,000',
  },
  {
    service: 'Containers',
    free: 'Not available',
    paid: '25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month included; beyond that, billed in 10 ms increments while running',
  },
];

export const workersPaid = [
  '**Workers Paid** is Cloudflare’s plan, charged by Cloudflare: $5 a month per Cloudflare account, not per developer, covering every app in that account. Shipcel charges nothing.',
  'It removes the free plan’s daily caps; usage beyond the included amounts is billed at the table’s rates.',
  'Workers Paid has no hard spending cap: Cloudflare’s budget alerts email you ($10 by default) but stop nothing.',
  'Shipcel’s **budget guard** estimates each app’s cost every five minutes, alerts at 50%, 80% and over the budget you set ($0 by default), and can pause an app that goes over.',
];
