// Content for the public site (site/render.ts). Every price and limit comes from the
// provider's official page listed in the same entry's sources, checked on `checkedOn`.
// Inline markup: [label](https://… or /path), `code`, **bold**.

// The plans and their check date live in shared/pricing.ts, for `shipcel pricing` too.
export {
  checkedOn,
  shipcelFree,
  cloudflareFree,
  workersPaid,
} from '../shared/pricing.ts';

export type Source = { label: string; url: string };
export type Table = {
  caption: string;
  columns: string[];
  // The first cell of each row is its label.
  rows: string[][];
  note?: string;
};
export type CostExample = {
  id: string;
  title: string;
  scenario: string;
  assumptions: string[];
  options: { name: string; monthly: string; lines: string[] }[];
  takeaway: string;
};
export type Comparison = {
  slug: string;
  name: string;
  kind: string;
  oneLiner: string;
  // The index table, one short line each: the free plan, what happens when it runs out,
  // and the cheapest paid plan.
  freeTier: string;
  freeStops: string;
  paidEntry: string;
  description: string;
  summary: string;
  // First on the page, in numbers: what the same apps cost on each side, and how far the
  // free plan goes. The note gives the assumptions and when the figures were read.
  shortAnswer?: { verdict: string; tables: Table[]; note: string };
  chooseUs: string[];
  chooseThem: string[];
  tables: Table[];
  examples: CostExample[];
  billing: string[];
  moving: string[];
  sources: Source[];
};
export type Section = {
  id: string;
  title: string;
  paragraphs: string[];
  points?: string[];
};
export type Reason = {
  id: string;
  title: string;
  summary: string;
  details: string[];
  points?: string[];
};

export const cf = {
  access: {
    label: 'Cloudflare Access for Workers',
    url: 'https://developers.cloudflare.com/workers/configuration/cloudflare-access/',
  },
  zeroTrustPlans: {
    label: 'Cloudflare Zero Trust plans',
    url: 'https://www.cloudflare.com/plans/sase-zero-trust/',
  },
  zeroTrustSetup: {
    label: 'Cloudflare Zero Trust: get started',
    url: 'https://developers.cloudflare.com/cloudflare-one/setup/',
  },
  logs: {
    label: 'Cloudflare Workers Logs',
    url: 'https://developers.cloudflare.com/workers/observability/logs/workers-logs/',
  },
  limits: {
    label: 'Cloudflare Workers limits',
    url: 'https://developers.cloudflare.com/workers/platform/limits/',
  },
  pricing: {
    label: 'Cloudflare Workers pricing',
    url: 'https://developers.cloudflare.com/workers/platform/pricing/',
  },
  assets: {
    label: 'Cloudflare static assets billing and limitations',
    url: 'https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/',
  },
  d1Pricing: {
    label: 'Cloudflare D1 pricing',
    url: 'https://developers.cloudflare.com/d1/platform/pricing/',
  },
  d1Limits: {
    label: 'Cloudflare D1 limits',
    url: 'https://developers.cloudflare.com/d1/platform/limits/',
  },
  kv: {
    label: 'Cloudflare Workers KV pricing',
    url: 'https://developers.cloudflare.com/kv/platform/pricing/',
  },
  r2: {
    label: 'Cloudflare R2 pricing',
    url: 'https://developers.cloudflare.com/r2/pricing/',
  },
  builds: {
    label: 'Cloudflare Workers Builds limits and pricing',
    url: 'https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/',
  },
  containers: {
    label: 'Cloudflare Containers pricing',
    url: 'https://developers.cloudflare.com/containers/pricing/',
  },
  workersDev: {
    label: 'Cloudflare workers.dev routing',
    url: 'https://developers.cloudflare.com/workers/configuration/routing/workers-dev/',
  },
  r2Start: {
    label: 'Cloudflare R2: get started (subscription)',
    url: 'https://developers.cloudflare.com/r2/get-started/',
  },
  budgetAlerts: {
    label: 'Cloudflare budget alerts',
    url: 'https://developers.cloudflare.com/billing/manage/budget-alerts/',
  },
  plans: {
    label: 'Cloudflare plans',
    url: 'https://www.cloudflare.com/plans/',
  },
  terms: {
    label: 'Cloudflare Self-Serve Subscription Agreement',
    url: 'https://www.cloudflare.com/terms/',
  },
  customDomains: {
    label: 'Cloudflare Workers custom domains',
    url: 'https://developers.cloudflare.com/workers/configuration/routing/custom-domains/',
  },
  durableObjects: {
    label: 'Cloudflare Durable Objects pricing',
    url: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
  },
} satisfies Record<string, Source>;

const vercel = {
  pricing: { label: 'Vercel pricing', url: 'https://vercel.com/pricing' },
  hobby: {
    label: 'Vercel Hobby plan',
    url: 'https://vercel.com/docs/plans/hobby',
  },
  fairUse: {
    label: 'Vercel fair use guidelines: commercial usage',
    url: 'https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage',
  },
  pro: {
    label: 'Vercel Pro plan',
    url: 'https://vercel.com/docs/plans/pro-plan',
  },
  flatRate: {
    label: 'Vercel Flat Rate CDN',
    url: 'https://vercel.com/docs/pricing/flat-rate-cdn',
  },
  regional: {
    label: 'Vercel regional pricing',
    url: 'https://vercel.com/docs/pricing/regional-pricing',
  },
  functions: {
    label: 'Vercel functions usage and pricing',
    url: 'https://vercel.com/docs/functions/usage-and-pricing',
  },
  spend: {
    label: 'Vercel spend management',
    url: 'https://vercel.com/docs/spend-management',
  },
  storage: {
    label: 'Vercel Marketplace storage',
    url: 'https://vercel.com/docs/marketplace-storage',
  },
  limits: { label: 'Vercel limits', url: 'https://vercel.com/docs/limits' },
  auth: {
    label: 'Vercel Marketplace: authentication',
    url: 'https://vercel.com/marketplace/category/authentication',
  },
  websockets: {
    label: 'Vercel: WebSocket connections in Functions',
    url: 'https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections',
  },
  rollback: {
    label: 'Vercel Instant Rollback',
    url: 'https://vercel.com/docs/instant-rollback',
  },
  protection: {
    label: 'Vercel: protect production deployments for free on every plan',
    url: 'https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan',
  },
  cron: {
    label: 'Vercel cron jobs usage and pricing',
    url: 'https://vercel.com/docs/cron-jobs/usage-and-pricing',
  },
  cli: { label: 'Vercel CLI', url: 'https://vercel.com/docs/cli' },
  env: {
    label: 'Vercel environment variables',
    url: 'https://vercel.com/docs/environment-variables',
  },
  roles: {
    label: 'Vercel access roles',
    url: 'https://vercel.com/docs/rbac/access-roles',
  },
  v0: { label: 'v0 pricing', url: 'https://v0.app/docs/pricing' },
};
const supabase = {
  pricing: { label: 'Supabase pricing', url: 'https://supabase.com/pricing' },
  billing: {
    label: 'Supabase billing FAQ',
    url: 'https://supabase.com/docs/guides/platform/billing-faq',
  },
  costControl: {
    label: 'Supabase cost control (spend cap)',
    url: 'https://supabase.com/docs/guides/platform/cost-control',
  },
  compute: {
    label: 'Supabase compute usage',
    url: 'https://supabase.com/docs/guides/platform/manage-your-usage/compute',
  },
  egress: {
    label: 'Supabase egress',
    url: 'https://supabase.com/docs/guides/platform/manage-your-usage/egress',
  },
  pausing: {
    label: 'Supabase free project pausing',
    url: 'https://supabase.com/docs/guides/platform/free-project-pausing',
  },
  backups: {
    label: 'Supabase backups',
    url: 'https://supabase.com/docs/guides/platform/backups',
  },
  passkeys: {
    label: 'Supabase Auth: passkeys',
    url: 'https://supabase.com/docs/guides/auth/passkeys',
  },
  branching: {
    label: 'Supabase branching usage',
    url: 'https://supabase.com/docs/guides/platform/manage-your-usage/branching',
  },
  tables: {
    label: 'Supabase: tables and the Table Editor',
    url: 'https://supabase.com/docs/guides/database/tables',
  },
  sqlEditor: {
    label: 'Supabase SQL Editor',
    url: 'https://supabase.com/features/sql-editor',
  },
};
const netlify = {
  pricing: {
    label: 'Netlify pricing',
    url: 'https://www.netlify.com/pricing/',
  },
  plans: {
    label: 'Netlify credit-based plans',
    url: 'https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/',
  },
  credits: {
    label: 'Netlify: how credits work',
    url: 'https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/',
  },
  faq: {
    label: 'Netlify billing FAQ for credit-based plans',
    url: 'https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans/',
  },
  packs: {
    label: 'Netlify credit packs',
    url: 'https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/buy-credit-packs/',
  },
  paused: {
    label: 'Netlify: resume paused projects',
    url: 'https://docs.netlify.com/manage/accounts-and-billing/billing/resume-paused-projects/',
  },
  database: {
    label: 'Netlify Database',
    url: 'https://docs.netlify.com/build/data-and-storage/netlify-database/',
  },
  databaseLaunch: {
    label: 'Netlify changelog: Netlify Database (28 April 2026)',
    url: 'https://www.netlify.com/changelog/2026-04-28-netlify-database/',
  },
  identity: {
    label: 'Netlify Identity',
    url: 'https://docs.netlify.com/manage/security/secure-access-to-sites/identity/overview/',
  },
  identityChanges: {
    label: 'Netlify: Auth0 extension and Identity changes',
    url: 'https://www.netlify.com/blog/auth0-extension-identity-changes/',
  },
  forms: {
    label: 'Netlify Forms usage and billing',
    url: 'https://docs.netlify.com/manage/forms/usage-and-billing/',
  },
  splitTesting: {
    label: 'Netlify split testing',
    url: 'https://docs.netlify.com/manage/monitoring/split-testing/',
  },
  deployPreviews: {
    label: 'Netlify Deploy Previews',
    url: 'https://docs.netlify.com/deploy/deploy-types/deploy-previews/',
  },
  branchDeploys: {
    label: 'Netlify branch deploys',
    url: 'https://docs.netlify.com/deploy/deploy-types/branch-deploys/',
  },
  manageDeploys: {
    label: 'Netlify: manage deploys',
    url: 'https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/',
  },
  drop: {
    label: 'Netlify Drop quickstart',
    url: 'https://docs.netlify.com/start/quickstarts/netlify-drop-quickstart/',
  },
  cli: {
    label: 'Netlify CLI',
    url: 'https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/',
  },
  agentRunners: {
    label: 'Netlify Agent Runners',
    url: 'https://docs.netlify.com/build/build-with-ai/agent-runners/overview/',
  },
  aiPricing: {
    label: 'Netlify: pricing for AI features',
    url: 'https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/pricing-for-ai-features/',
  },
  realtime: {
    label: 'Netlify: WebSockets in a serverless world',
    url: 'https://www.netlify.com/blog/web-sockets-in-a-serverless-world/',
  },
  roles: {
    label: 'Netlify roles and permissions',
    url: 'https://docs.netlify.com/manage/accounts-and-billing/team-management/roles-and-permissions/',
  },
};
const firebase = {
  pricing: {
    label: 'Firebase pricing',
    url: 'https://firebase.google.com/pricing',
  },
  plans: {
    label: 'Firebase pricing plans',
    url: 'https://firebase.google.com/docs/projects/billing/firebase-pricing-plans',
  },
  storage: {
    label: 'Firebase Cloud Storage changes (Blaze required)',
    url: 'https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024',
  },
  caps: {
    label: 'Firebase spend caps (preview)',
    url: 'https://firebase.google.com/docs/projects/billing/spend-caps',
  },
  firestore: {
    label: 'Firestore pricing',
    url: 'https://cloud.google.com/firestore/pricing',
  },
  budgets: {
    label: 'Google Cloud budgets and alerts',
    url: 'https://cloud.google.com/billing/docs/how-to/budgets',
  },
};
const render = {
  pricing: { label: 'Render pricing', url: 'https://render.com/pricing' },
  free: { label: 'Render free instances', url: 'https://render.com/docs/free' },
  bandwidth: {
    label: 'Render outbound bandwidth',
    url: 'https://render.com/docs/outbound-bandwidth',
  },
  plans: {
    label: 'Render workspace plans update',
    url: 'https://render.com/changelog/updated-plans-for-render-workspaces',
  },
  compute: {
    label: 'Render compute plans',
    url: 'https://render.com/docs/compute-plans',
  },
};
const railway = {
  pricing: { label: 'Railway pricing', url: 'https://railway.com/pricing' },
  plans: {
    label: 'Railway plans',
    url: 'https://docs.railway.com/pricing/plans',
  },
  trial: {
    label: 'Railway free trial',
    url: 'https://docs.railway.com/pricing/free-trial',
  },
  costControl: {
    label: 'Railway cost control',
    url: 'https://docs.railway.com/pricing/cost-control',
  },
};
const coolify = {
  pricing: { label: 'Coolify pricing', url: 'https://coolify.io/pricing' },
  install: {
    label: 'Coolify installation',
    url: 'https://coolify.io/docs/get-started/installation',
  },
  repo: {
    label: 'Coolify on GitHub',
    url: 'https://github.com/coollabsio/coolify',
  },
  backups: {
    label: 'Coolify database backups',
    url: 'https://coolify.io/docs/databases/backups',
  },
  notifications: {
    label: 'Coolify notifications',
    url: 'https://coolify.io/docs/knowledge-base/notifications',
  },
  variables: {
    label: 'Coolify environment variables',
    url: 'https://coolify.io/docs/knowledge-base/environment-variables',
  },
};
const heroku = {
  pricing: { label: 'Heroku pricing', url: 'https://www.heroku.com/pricing' },
  free: {
    label: 'Heroku: removal of free product plans',
    url: 'https://help.heroku.com/RSBRUH58/removal-of-heroku-free-product-plans-faq',
  },
  eco: {
    label: 'Heroku Eco dyno hours',
    url: 'https://devcenter.heroku.com/articles/eco-dyno-hours',
  },
  postgres: {
    label: 'Heroku Postgres plans',
    url: 'https://devcenter.heroku.com/articles/heroku-postgres-plans',
  },
  billing: {
    label: 'Heroku usage and billing',
    url: 'https://devcenter.heroku.com/articles/usage-and-billing',
  },
  limits: {
    label: 'Heroku limits',
    url: 'https://devcenter.heroku.com/articles/limits',
  },
};

export const reasons: Reason[] = [
  {
    id: 'one-platform',
    title: 'One platform instead of a stack of services',
    summary:
      'Your frontend, server code, SQL databases, file storage and key-value data live in one Cloudflare account, on one bill, instead of a hosting plan plus a database plan plus a storage plan.',
    details: [
      'A common setup pairs a hosting platform such as Vercel or Netlify with a database service such as Supabase or Firebase, then adds storage and caching elsewhere, each with its own fee, quotas and invoice.',
      'Cloudflare runs all of these in one account: Workers for server code, static assets for your frontend, D1 for SQL, R2 for files, KV for fast lookups and Containers for Docker. Shipcel creates and connects them, after you review what will be created.',
      'User sign-in and realtime run in the same account too. Shipcel deploys a sign-in service (passkeys, GitHub, Google and email, as standard OpenID Connect) and realtime channels on Durable Objects, so there is no separate sign-in or realtime vendor to pay.',
    ],
    points: [
      'Vercel’s databases are third-party Marketplace services with their own bills, outside Vercel’s spend management.',
      'Supabase hosts your database and sign-in but not your frontend; Firebase’s server-rendered hosting and Cloud Functions need its pay-as-you-go plan.',
      'On Cloudflare one plan covers every app and database in your account: $0, or $5 a month for Workers Paid.',
    ],
  },
  {
    id: 'no-platform-fee',
    title: 'No platform fee and no per-seat pricing',
    summary:
      'Shipcel is free. Cloudflare’s Workers Paid plan is $5 a month per account, not per developer, and covers every app in it.',
    details: [
      'Most platforms charge a monthly fee per developer or per project before any usage: Vercel Pro is $20 per deploying seat, Supabase Pro $25 per organization plus about $10 for each extra project, and Heroku has no free tier.',
      'Shipcel adds nothing to your bill. You pay Cloudflare’s list prices directly, and only beyond what the free plan or Workers Paid includes.',
    ],
  },
  {
    id: 'free-plan',
    title: 'A free plan that is useful, and stops instead of billing',
    summary:
      'Cloudflare’s free plan includes 100,000 requests a day, unlimited static file traffic, 5 GB of SQL storage and 10 GB of files. Workers, D1 and KV stop at their daily limits instead of turning into a bill.',
    details: [
      'Free tiers elsewhere are smaller or conditional: Vercel’s Hobby plan is for non-commercial use and pauses projects that exceed it, Netlify pauses every project when its 300 credits run out, Supabase pauses free projects after a week of low activity, Render deletes free databases after 30 days, and Heroku has no free tier.',
      'Shipcel’s own Free plan adds no limits below Cloudflare’s: up to 100 projects and no monthly cap on deployments. The one exception to “stops instead of billing” is R2 file storage, which bills usage beyond its free tier (never egress) once you have subscribed to it.',
    ],
  },
  {
    id: 'no-bandwidth-bills',
    title: 'No bandwidth bills for static files and storage',
    summary:
      'Static files served by Workers are free and unlimited, Workers responses have no per-gigabyte charge, and R2 has no egress fees, so traffic spikes and large downloads don’t become transfer bills.',
    details: [
      'Data transfer is a common source of unexpected bills: Supabase Pro charges $0.09 per GB of uncached egress beyond 250 GB, Firebase Hosting $0.15 per GB beyond its free tier, Render $0.15 per GB beyond 5 GB (Hobby) or 25 GB (Pro), Railway $0.05 per GB, and Netlify’s 300 free credits cover at most 15 GB.',
      'Vercel Pro now includes 1 TB of transfer and offers flat-rate tiers up to 50 TB from $20 a month, excluding bulk downloads and media-heavy sites. On Cloudflare, static assets and R2 downloads are not metered by the gigabyte at all.',
    ],
  },
  {
    id: 'your-account',
    title: 'Your account, your data, no lock-in',
    summary:
      'Everything Shipcel creates lives in your Cloudflare account. If you stop using Shipcel, your apps, databases and files keep running.',
    details: [
      'Shipcel never hosts your app or holds your data. Apps build on your computer, in your repository’s GitHub Actions or in Cloudflare’s own builds, and everything they create goes into the account you choose.',
      'Removing a project or disconnecting Shipcel leaves your Workers, databases and storage in place, to manage in Cloudflare’s dashboard or with Wrangler.',
    ],
  },
  {
    id: 'safe-changes',
    title: 'Changes you can review and undo',
    summary:
      'Shipcel shows what it will create before it creates it, checks your app after every deploy, and keeps a way back.',
    details: [
      'Infrastructure mistakes are expensive too, so nothing happens to your account without a confirmation, and every change has a record.',
    ],
    points: [
      'Databases, buckets and containers are created only after you review and confirm them.',
      'Every deploy is followed by a homepage health check; failures are reported, not hidden.',
      'Promote an earlier version, apply database migrations with a restore point taken first, export a database, or restore it to any minute in the last 7 days (30 on Workers Paid, Cloudflare’s $5-a-month plan).',
      'Interrupted steps can be checked against Cloudflare and resumed without creating duplicates.',
    ],
  },
  {
    id: 'pay-for-use',
    title: 'Pay for what runs, not for idle servers',
    summary:
      'Workers start on demand in milliseconds and bill CPU time, not waiting time. Containers bill per 10 milliseconds while running and can sleep when idle.',
    details: [
      'There is no server to keep warm: a Worker runs when a request arrives and costs nothing between requests. On Workers Paid you pay for CPU time, not for time spent waiting on a database or another API.',
      'Platforms built on long-running servers bill instance hours whether or not anyone visits, or put free instances to sleep: Render’s free services after 15 minutes, waking in about a minute, and Heroku’s Eco dynos after 30.',
    ],
  },
];

export const notYet = [
  'Shipcel is in alpha. Everything is built and tested, and deploys from GitHub, the terminal and drag-and-drop have gone to real Cloudflare accounts. The budget guard’s pause and the firewall panel have run only against stand-ins for Cloudflare so far.',
  'Sign-in offers passkeys, GitHub, Google, emailed links and passwords (the last two on Workers Paid); phone numbers are not available.',
  'Realtime covers channels, presence, broadcast and the data API’s changes, not every change in D1.',
  'D1 is SQLite: no Postgres extensions, 500 MB per database on the free plan, 10 GB on Workers Paid. Postgres and MySQL run elsewhere, through Hyperdrive.',
  'Next.js runs through the OpenNext adapter: ISR works through its cache in R2; OpenNext’s cache purge isn’t supported.',
  'Previews cover branches and pull requests in your own repository, not pull requests from forks, and not yet Next.js, containers or Python Workers with packages; they use Cloudflare Worker Previews, in beta. Preview addresses are public unless you ask for sign-in with Cloudflare Access, set up once in Cloudflare, which asks for a payment method even on its free plan.',
  'AI agents connect with an API token, or through OAuth from chat apps such as Claude.ai.',
  'Queues and Workflows live in Cloudflare’s dashboard, not in Shipcel yet.',
  'WordPress runs only as an experimental container kit, not yet proven on Cloudflare. Paid support and uptime guarantees are not offered.',
];

export const faqs = [
  {
    q: 'Is Shipcel really free?',
    a: 'Yes. Shipcel’s Free plan costs nothing and needs no card, and paid Shipcel plans are not offered. Your apps run in your own Cloudflare account, so the only infrastructure bill you can get is Cloudflare’s.',
  },
  {
    q: 'Do I need Cloudflare’s Workers Paid plan?',
    a: 'Only for containers, or when an app needs more than the free plan: more than 100,000 requests a day, more than 10 ms of CPU per request, or a database over 500 MB. It costs $5 a month per Cloudflare account and covers every app in it.',
  },
  {
    q: 'Does Shipcel include sign-in and realtime for my users?',
    a: 'Yes. Turn on Manage → Sign-in & realtime and Shipcel deploys a sign-in service and realtime channels into your Cloudflare account. People sign in with a passkey, GitHub, Google or an emailed link, and can add a password; your app uses standard OpenID Connect. Passkeys, GitHub, Google and realtime run on the free plan: a sign-in uses about 5 to 7 of your 100,000 daily requests, and realtime uses Durable Objects, with messages to listeners free. Email and passwords need Workers Paid.',
  },
  {
    q: 'Can people sign in with a password?',
    a: 'Yes, if you allow passwords: once signed in, a person sets one and uses it with their email address from then on. Passwords and email links need Workers Paid: hashing a password safely takes more CPU time than the free plan’s 10 ms per request, and Cloudflare’s Email Service is a Workers Paid feature. Passkeys, GitHub and Google work on the free plan.',
  },
  {
    q: 'Can I deploy without Git?',
    a: 'Yes. Run `shipcel` in your project’s folder: it builds on your computer and deploys, with nothing to set up in Cloudflare first. Or drop a built folder in the dashboard, or ask your AI agent. From the terminal a new app’s first deploy goes live at its free address; a dropped folder stays unpublished, with only its preview address working, until you publish it.',
  },
  {
    q: 'Can an AI agent build and deploy my app?',
    a: 'Yes, the agent you already use. Connect Claude Code, Codex, Cursor or another MCP client to Shipcel with an API token, and it can create projects, deploy, publish and roll back for you. Shipcel runs no AI model and charges nothing for it; your agent’s own plan covers the AI.',
  },
  {
    q: 'Does every pull request get a preview?',
    a: 'For apps deployed from GitHub, yes: turn on branch previews and Cloudflare builds every branch as a Preview of your app and comments its address on the pull request. Previews use staging copies of your databases, so they never touch production data. Cloudflare’s Worker Previews are in beta.',
  },
  {
    q: 'How do I undo a bad deploy?',
    a: 'Roll back in one click from Manage → Builds & versions, or try a new version on a share of your traffic first. Shipcel checks the homepage after each change. Rolling back restores code, not database changes; databases have point-in-time restore.',
  },
  {
    q: 'What happens when my app reaches a free limit?',
    a: 'Worker requests over 100,000 a day get an error page (Cloudflare error 1027), and D1 and KV operations fail, until midnight UTC. Nothing is billed. R2 is different: it is pay-as-you-go beyond its free tier. Workers Paid removes the daily limits.',
  },
  {
    q: 'Do I need a credit card?',
    a: 'Not for Shipcel, and Cloudflare’s plans page says its free plan needs no card. R2 file storage is the exception: you add it through a checkout, which needs a payment method, even though its free tier costs nothing.',
  },
  {
    q: 'Can I make sure I never pay anything?',
    a: 'Yes. Keep your Cloudflare account on the free Workers plan and leave each project’s Free-only mode on, as it is by default. Shipcel then creates nothing that can bill, such as R2 storage or containers, and Workers, D1, KV and Durable Objects stop at their daily limits instead of billing. A custom domain, if you want one, is bought separately.',
  },
  {
    q: 'Can I cap my spending?',
    a: 'On the free plan Workers, D1 and KV simply stop at their limits. Workers Paid has no hard cap: Cloudflare’s budget alerts email you ($10 by default) without stopping anything. Shipcel’s budget guard estimates each app’s cost every five minutes, alerts at 50%, 80% and over the budget you set ($0 beyond what Cloudflare includes, by default), and can pause the app when it goes over.',
  },
  {
    q: 'Can I take card payments in an app on the free plan?',
    a: 'Cloudflare’s Self-Serve Subscription Agreement (section 2.2.1(h)) does not allow processing or collecting credit card information on a web property receiving Cloudflare’s Free Services. If your app takes payments, use your payment provider’s hosted checkout and review Cloudflare’s terms for your setup.',
  },
  {
    q: 'Is a workers.dev address fine for a business?',
    a: 'Cloudflare describes workers.dev addresses as free sites intended for personal or hobby projects that aren’t business-critical. For a business, attach your own domain; Cloudflare sells domains at cost and its free DNS plan costs nothing.',
  },
  {
    q: 'What happens if I stop using Shipcel?',
    a: 'Your apps, databases, files and automatic deploys stay in your Cloudflare account and keep running. Shipcel never holds your data.',
  },
];

export const costExamples: CostExample[] = [
  {
    id: 'small-commercial-app',
    title: 'A small commercial app',
    scenario:
      'One developer runs a paid product: a web frontend and API, a 2 GB database and 20 GB of user files, with about 300,000 page views a month.',
    options: [
      {
        name: 'Vercel Pro + Supabase Pro',
        monthly: '$45',
        lines: [
          'Vercel Pro: $20 for one developer, with $20 of usage, enough here; Hobby can’t be used commercially.',
          'Supabase Pro: $25, including one Micro database (8 GB disk, 100 GB of files).',
        ],
      },
      {
        name: 'Shipcel + Cloudflare',
        monthly: '$5.15',
        lines: [
          'Shipcel: $0.',
          'Workers Paid: $5, needed because the 2 GB database is over D1’s 500 MB free limit per database; it includes 10 million requests and 5 GB of D1 storage.',
          'R2: 10 GB free, then 10 GB × $0.015 = $0.15.',
        ],
      },
    ],
    assumptions: [
      'About 300,000 page views a month is roughly 10,000 a day, well inside the included requests.',
      'Usage stays inside Vercel Pro’s $20 credit and Supabase Pro’s quotas.',
      'US dollars before tax.',
    ],
    takeaway:
      'About $5 a month instead of $45, roughly a ninth, mostly because there is no per-seat fee and the database comes with the same account.',
  },
  {
    id: 'side-projects',
    title: 'Five side projects with databases',
    scenario: 'Five small apps, each with its own database and light traffic.',
    options: [
      {
        name: 'Vercel Hobby + Supabase Pro',
        monthly: '$65',
        lines: [
          'Vercel Hobby: $0, for non-commercial use only.',
          'Supabase Free allows 2 active projects, so five need Pro: $25 with one Micro database, plus about $10 for each of the other four.',
        ],
      },
      {
        name: 'Shipcel + Cloudflare',
        monthly: '$0',
        lines: [
          'Shipcel: $0.',
          'Cloudflare’s free plan: five Workers and five D1 databases (up to 10 per account), each under 500 MB.',
        ],
      },
    ],
    assumptions: [
      'Each app stays within Cloudflare’s free daily limits.',
      'Supabase bills Micro compute at $0.01344 an hour, about $10 a month per project, and Pro includes $10 of compute credit.',
    ],
    takeaway:
      '$0 instead of $65 a month. On Supabase Free you could keep two of the five, and they pause after a week of low activity.',
  },
  {
    id: 'downloads',
    title: 'An app serving 1 TB of downloads a month',
    scenario:
      'A product stores 100 GB of files and serves 1 TB of downloads a month.',
    options: [
      {
        name: 'Supabase Pro Storage',
        monthly: '$47.50 to $92.50',
        lines: [
          '$25 base fee; 100 GB of files included.',
          'Egress: 250 GB included; the other 750 GB costs $0.03 per GB from Supabase’s CDN cache ($22.50) or $0.09 per GB uncached ($67.50).',
        ],
      },
      {
        name: 'Cloudflare R2',
        monthly: '$1.35',
        lines: [
          'Storage: 90 GB beyond the free 10 GB × $0.015 = $1.35.',
          'Egress: $0, because R2 has no egress fees.',
          'Reads: about 1 million downloads, inside the 10 million free reads a month.',
        ],
      },
    ],
    assumptions: [
      'An average file of 1 MB.',
      'Storage costs only; the app’s own compute is separate on both.',
    ],
    takeaway:
      'About $1.35 a month instead of $47.50 to $92.50 for the same files and downloads.',
  },
  {
    id: 'always-on-api',
    title: 'An always-on API with a 1 GB database',
    scenario:
      'A small API that must answer immediately at any hour, with a 1 GB SQL database.',
    options: [
      {
        name: 'Heroku',
        monthly: '$12',
        lines: [
          'Basic dyno $7 (Eco dynos sleep after 30 minutes without traffic).',
          'Postgres Essential-0 $5 (1 GB).',
        ],
      },
      {
        name: 'Render',
        monthly: '$13.30',
        lines: [
          'Web service `0.5c-512mb` $7 (free instances sleep after 15 minutes).',
          'Postgres $6 plus 1 GB of storage at $0.30.',
        ],
      },
      {
        name: 'Shipcel + Cloudflare',
        monthly: '$5',
        lines: [
          'Workers Paid $5, because a 1 GB D1 database is over the free plan’s 500 MB per database.',
          'Workers start per request in milliseconds; nothing sleeps.',
        ],
      },
    ],
    assumptions: [
      'Under 10 million requests a month.',
      'The API can run as a Worker (JavaScript, TypeScript or Python). A Docker image would run as a Cloudflare Container, billed by use on Workers Paid.',
    ],
    takeaway: '$5 a month instead of $12 to $13.30, with nothing that sleeps.',
  },
];

export const pricingSources: Source[] = [
  cf.pricing,
  cf.limits,
  cf.assets,
  cf.d1Pricing,
  cf.d1Limits,
  cf.kv,
  cf.r2,
  cf.r2Start,
  cf.builds,
  cf.containers,
  cf.budgetAlerts,
  cf.plans,
  cf.terms,
  cf.workersDev,
  vercel.pro,
  vercel.fairUse,
  supabase.pricing,
  supabase.compute,
  supabase.egress,
  netlify.plans,
  firebase.pricing,
  render.free,
  render.bandwidth,
  railway.pricing,
  heroku.pricing,
  heroku.postgres,
];

const us = 'Shipcel + Cloudflare';
const cfFreeLine =
  'Cloudflare’s free plan is never billed for Workers, D1 or KV: over a daily limit, requests and queries fail until midnight UTC. R2 file storage bills usage beyond its free tier (never egress).';
const cfPaidLine =
  'Workers Paid ($5 a month per account) has no hard spending cap. Budget alerts email you when usage passes an amount ($10 by default) but don’t stop anything; per-Worker CPU and subrequest limits can stop runaway code. Shipcel’s budget guard alerts over each app’s budget ($0 by default) and can pause the app, minutes after the budget is crossed.';

export const comparisons: Comparison[] = [
  {
    slug: 'vercel',
    name: 'Vercel',
    kind: 'Frontend cloud, the reference host for Next.js',
    oneLiner:
      'Vercel is the most polished home for Next.js, from $20 per developer a month for commercial use. Shipcel deploys to your own Cloudflare account, with databases included and no per-seat fee.',
    freeTier:
      'Hobby: non-commercial; 100 GB of transfer and 1 million function calls a month',
    freeStops: 'The project pauses, usually for 30 days',
    paidEntry: 'Pro $20 a month per developer, with $20 of usage',
    description:
      'Shipcel vs Vercel: free plans, commercial use, per-seat pricing, bandwidth, databases and spend controls compared, with sources, and where Vercel is the better choice.',
    summary:
      'Vercel builds and serves web apps on its own platform and is the reference host for Next.js. Shipcel uses Cloudflare’s build system and network inside your own account, adds databases and file storage from the same account, and charges nothing itself. The main differences are commercial use on the free plan, per-seat pricing, and where your database lives.',
    shortAnswer: {
      verdict:
        'A small commercial site costs $0 a month on Shipcel + Cloudflare and $20 on Vercel; a busy app about $5.60 against about $40. A free Vercel site pauses for 30 days once it passes 100 GB of transfer in a month; Cloudflare serves files without limit, and its daily limits reset every night.',
      tables: [
        {
          caption: 'What you pay a month',
          columns: ['', us, 'Vercel'],
          rows: [
            [
              'A personal site: 20,000 page views a month, no server code',
              '**$0.** Static files are free and unlimited, with no transfer charge.',
              '**$0** on Hobby, for personal projects only: 40 GB of transfer, inside the 100 GB included.',
            ],
            [
              'A small business site: 50,000 page views and 150,000 API calls a month',
              '**$0.** Files are free; 150,000 Worker requests are 5,000 a day, inside the free 100,000.',
              '**$20.** Hobby doesn’t allow commercial use, so Pro: $20 for one developer, with 100 GB of transfer and 500,000 requests inside the included 1 TB and 1 million, and the API calls inside the $20 credit.',
            ],
            [
              'A busy app: 1 million page views, 8 million requests for pages and files, 2 TB of transfer, 3 million API calls',
              '**$5.60.** Workers Paid $5 (10 million requests and 30 million CPU-milliseconds included) plus 30 million more CPU-milliseconds at $0.02 a million; no charge for transfer.',
              '**About $40.** $20 for one developer, plus the $20 Flat Rate CDN tier (10 million requests, 50 TB) once the included 1 million requests and 1 TB are passed; about $6 of function usage is covered by the $20 credit.',
            ],
            [
              'Add a 2 GB SQL database to any of these',
              '**+$0 to $5.** Workers Paid, if you don’t pay it already: D1 is included, with 5 GB and 25 billion rows read a month.',
              '**+$25.** Vercel has no database of its own: a Marketplace one, for example Supabase Pro at $25, billed by that company.',
            ],
          ],
        },
        {
          caption: 'How far the free plan goes',
          columns: ['', `${us} free plans`, 'Vercel Hobby'],
          rows: [
            [
              'Page views a month, at 2 MB a page',
              '**No limit:** static files are free and unlimited',
              '**About 50,000:** 100 GB of Fast Data Transfer',
            ],
            [
              'Server and API requests',
              '**100,000 a day**, about 3 million a month',
              '**1 million a month**, and 4 hours of CPU',
            ],
            [
              'Commercial use',
              'Allowed by Shipcel; Cloudflare positions its free plans for personal projects',
              'Not allowed: personal, non-commercial use only',
            ],
            [
              'When you go over',
              'Server requests fail until midnight UTC; files keep serving; nothing is billed',
              'The project is paused, usually for 30 days; extra usage can’t be bought',
            ],
          ],
        },
      ],
      note: 'Assumptions: 2 MB a page view (the page, scripts, styles and images), about 10 requests a view, 20 ms of CPU per API call, Vercel in its US regions, US dollars before tax. Vercel’s Hobby, Pro, Flat Rate CDN and Fluid compute pages and Cloudflare’s Workers pricing page were read on 28 October 2026.',
    },
    chooseUs: [
      'You run a commercial app and want to start free: Vercel’s Hobby plan is for personal, non-commercial use, so a paying product needs Pro at $20 per deploying seat.',
      'You want your database and files in the same account and bill: Vercel’s databases are Marketplace services from other companies, billed separately and outside Vercel’s spend management.',
      'You want a free plan that keeps serving: a Hobby project that exceeds its included usage is paused, usually for 30 days, while Cloudflare’s daily limits reset every night.',
      'You want to own the infrastructure: your apps, databases and files stay in your Cloudflare account if you stop using Shipcel.',
    ],
    chooseThem: [
      'You build with Next.js and want every feature supported natively. Shipcel runs Next.js through the OpenNext adapter, with ISR through its cache in R2.',
      'You want mature built-in tooling: observability, analytics, firewall rules and enterprise features such as single sign-on.',
      'You want previews for Next.js apps or for pull requests from forks. Shipcel’s previews (Cloudflare Worker Previews, in beta) cover branches and pull requests in your own repository, not Next.js yet.',
      'You want login-protected previews without setting up another product: Vercel Authentication is free on every plan. Shipcel uses Cloudflare Access, which you set up once in Cloudflare’s Zero Trust dashboard: free for 50 people, but Cloudflare asks for a payment method.',
      'You need a proven service today. Shipcel is in alpha.',
    ],
    tables: [
      {
        caption: 'Free plans',
        columns: ['', `${us} free plans`, 'Vercel Hobby'],
        rows: [
          ['Price', '$0', '$0'],
          [
            'Commercial use',
            'Shipcel allows it. Cloudflare has no general ban but positions its free plans for personal and hobby projects, and its terms forbid collecting card details on sites using Free services',
            'Not allowed: personal, non-commercial use only',
          ],
          [
            'Requests',
            '100,000 Worker requests a day; static files unlimited',
            '1 million CDN requests and 1 million function invocations a month',
          ],
          [
            'Compute',
            '10 ms of CPU per request',
            '4 CPU-hours and 360 GB-hours of memory a month',
          ],
          [
            'Transfer',
            'No per-gigabyte charge; static files free and unlimited',
            '100 GB of Fast Data Transfer a month',
          ],
          [
            'SQL database',
            'D1 included: 5 GB, 5 million rows read a day',
            'Not included: Marketplace providers with their own plans',
          ],
          [
            'File storage',
            'R2: 10 GB free (R2 is added through a checkout that needs a payment method)',
            'Blob: 1 GB',
          ],
          [
            'When you exceed it',
            'Requests fail until midnight UTC; nothing is billed',
            'The project is paused, usually for 30 days; extra usage can’t be bought',
          ],
          [
            'Organization repositories',
            'Supported',
            'Can’t connect repositories owned by a GitHub organization',
          ],
        ],
      },
      {
        caption: 'Paid plans',
        columns: ['', `${us} Workers Paid`, 'Vercel Pro'],
        rows: [
          [
            'Price',
            '$5 a month per Cloudflare account; Shipcel $0',
            '$20 a month per deploying seat, including $20 of usage credit',
          ],
          [
            'Transfer',
            'No per-gigabyte charge for Workers responses; static files and R2 egress free',
            'Flat Rate CDN: 1 TB and 1 million CDN requests included; 50 TB tiers from $20 a month, excluding bulk downloads and media-heavy sites. On demand: $0.15 to $0.35 per GB',
          ],
          [
            'Requests',
            '10 million a month included, then $0.30 per million',
            'Function invocations $0.60 per million; CDN requests $2.00 to $3.20 per million on demand',
          ],
          [
            'Compute',
            '30 million CPU-ms a month included, then $0.02 per million CPU-ms',
            'Active CPU $0.128 to $0.221 an hour; memory $0.0106 to $0.0183 per GB-hour',
          ],
          [
            'SQL database',
            'D1 included: 25 billion rows read, 50 million written and 5 GB a month',
            'A separate Marketplace bill (for example Neon or Supabase)',
          ],
          [
            'Spending control',
            'No hard cap from Cloudflare. Shipcel’s budget guard alerts over a budget ($0 by default) and can pause the app; Cloudflare’s budget alerts email you',
            'Spend management on by default with a $200 alert; pausing production is optional and can lag by minutes',
          ],
        ],
      },
      {
        caption: 'Features',
        columns: ['', 'Shipcel', 'Vercel'],
        rows: [
          [
            'Deploy from GitHub',
            'Yes, with GitHub Actions in your repository',
            'Yes',
          ],
          [
            'Preview URLs',
            'Every branch and pull request in your repository, with the address commented on the pull request (Cloudflare Worker Previews, beta); not yet for Next.js or containers',
            'Every push and pull request',
          ],
          [
            'Deploy without Git',
            'Drag and drop, the shipcel CLI, or your own AI agent through MCP',
            'The vercel CLI',
          ],
          [
            'AI building',
            'Your own AI agent (Claude Code, Codex, Cursor and others) through Shipcel’s MCP server; Shipcel runs no model and charges nothing for it',
            'v0: 7 messages a day on Free',
          ],
          [
            'Rollback',
            'One click to any earlier version, or a share of traffic on a new version first',
            'Instant Rollback; Hobby can only roll back to the previous deployment',
          ],
          [
            'Teams',
            'Shared workspaces with owner, developer and viewer roles, free',
            'Hobby is for one person; Pro charges $20 per deploying seat, and Viewer seats are free',
          ],
          [
            'Environment variables',
            'Runtime secrets, and build variables for production and for branch previews',
            'Production, Preview and Development values, with per-branch Preview values',
          ],
          [
            'Protected previews',
            'Sign-in through Cloudflare Access, in your account; Zero Trust’s free plan covers 50 people, and Cloudflare asks for a payment method to set it up',
            'Vercel Authentication, free on every plan since September 2026',
          ],
          [
            'Cron jobs',
            'Cloudflare Cron Triggers, set in your Wrangler configuration or in Manage → Schedules; 5 per account on the free plan',
            '100 per project; on Hobby each runs at most once a day',
          ],
          [
            'Next.js',
            'Through OpenNext, with ISR through its cache in R2',
            'Native, including ISR, image optimization and middleware',
          ],
          [
            'Python',
            'Python Workers (Pyodide-compatible packages)',
            'Python 3.12 to 3.14 functions',
          ],
          [
            'Containers',
            'Cloudflare Containers on Workers Paid',
            'Container images in beta, run as functions',
          ],
          [
            'SQL database',
            'D1 (SQLite) in your account',
            'Marketplace partners',
          ],
          [
            'Sign-in for your users',
            'Built in: passkeys, GitHub, Google and email, as standard OpenID Connect',
            'Third-party Marketplace providers such as Clerk and Auth0',
          ],
          [
            'Realtime',
            'Channels with presence and broadcast on Durable Objects',
            'WebSocket connections served by Vercel Functions',
          ],
          [
            'Logs and analytics',
            'Request analytics and Workers Logs in Manage; the free plan keeps 200,000 log events a day for 3 days',
            'Built in',
          ],
          ['Where it runs', 'Your Cloudflare account', 'Vercel’s platform'],
        ],
      },
    ],
    examples: [costExamplesRef('small-commercial-app')],
    billing: [
      'Vercel Hobby is never billed: projects pause when they exceed the included usage.',
      'Vercel Pro turns on spend management by default with a $200 on-demand budget that sends alerts. Pausing production at the budget is a separate, optional switch that can lag by several minutes; without it, on-demand usage is uncapped. Seats, add-ons and Marketplace databases aren’t counted.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'Commit a Wrangler configuration and import the repository; Shipcel checks it and lists anything missing.',
      'Next.js apps need the OpenNext adapter, added once with `npx wrangler setup`. ISR needs OpenNext’s cache: the Next.js starter kit sets it up in R2, and Shipcel fills it at each production deploy.',
      'Environment variables become Worker secrets in Manage → Runtime secrets.',
      'Move your domain’s DNS to Cloudflare, then attach it in Manage → Domains.',
    ],
    sources: [
      vercel.pricing,
      vercel.hobby,
      vercel.fairUse,
      vercel.pro,
      vercel.flatRate,
      vercel.regional,
      vercel.functions,
      vercel.spend,
      vercel.storage,
      vercel.limits,
      vercel.auth,
      vercel.websockets,
      vercel.rollback,
      vercel.protection,
      cf.access,
      cf.zeroTrustPlans,
      cf.zeroTrustSetup,
      vercel.cron,
      vercel.cli,
      vercel.v0,
      vercel.env,
      vercel.roles,
      supabase.pricing,
      cf.logs,
      cf.pricing,
      cf.durableObjects,
      cf.limits,
      cf.assets,
      cf.d1Pricing,
      cf.r2,
      cf.budgetAlerts,
      cf.plans,
      cf.terms,
    ],
  },
  {
    slug: 'netlify',
    name: 'Netlify',
    kind: 'Web platform with credit-based pricing',
    oneLiner:
      'Netlify’s plans run on monthly credits; when the 300 free credits run out, every project is paused. Cloudflare’s free plan resets every day and serves static files without limit.',
    freeTier: '300 credits a month, about 15 GB of bandwidth',
    freeStops: 'Every project on the team pauses until next month',
    paidEntry: 'Personal $9 a month (1,000 credits); Pro $20 (3,000 credits)',
    description:
      'Shipcel vs Netlify: credit-based plans, bandwidth, pausing, databases and spending controls compared with sources, and where Netlify is the better choice.',
    summary:
      'Netlify bills everything in credits: production deploys, compute, bandwidth and web requests all draw on one monthly balance. Shipcel deploys to your Cloudflare account, where static files are never metered and the free plan resets daily instead of running down over the month.',
    shortAnswer: {
      verdict:
        'Netlify’s 300 free credits buy about 15 GB of bandwidth, around 7,500 views of a 2 MB page, and then every project pauses until next month; Cloudflare serves files without limit. A personal site that fits Cloudflare’s free plan needs Netlify’s $9 plan, and a busy app that costs about $5.60 on Workers Paid costs about $290 in Netlify credits.',
      tables: [
        {
          caption: 'What you pay a month',
          columns: ['', us, 'Netlify'],
          rows: [
            [
              'A personal site: 20,000 page views a month, 4 deploys',
              '**$0.** Static files are free and unlimited, and deploys cost nothing.',
              '**$9.** About 920 credits: 40 GB of bandwidth at 20 credits a GB, 300,000 requests, and 15 credits a deploy. Free’s 300 credits run out at about 7,500 page views, so the Personal plan (1,000 credits).',
            ],
            [
              'A small business site: 50,000 page views, 150,000 API calls, 10 deploys',
              '**$0.** Files are free; 150,000 Worker requests are 5,000 a day, inside the free 100,000.',
              '**$20.** About 2,300 credits, 2,000 of them for 100 GB of bandwidth: the Pro plan’s 3,000.',
            ],
            [
              'A busy app: 1 million page views, 8 million requests for pages and files, 2 TB of transfer, 3 million API calls, 30 deploys',
              '**$5.60.** Workers Paid $5 (10 million requests and 30 million CPU-milliseconds included) plus 30 million more CPU-milliseconds at $0.02 a million; no charge for transfer.',
              '**About $290.** About 43,000 credits, 40,000 of them for 2 TB of bandwidth: Pro’s 3,000 plus 27 packs of 1,500 credits at $10. With auto recharge off, the default, every project pauses instead.',
            ],
            [
              'Add a 2 GB SQL database to any of these',
              '**+$0 to $5.** Workers Paid, if you don’t pay it already: D1 is included, with 5 GB.',
              '**+$0.** Netlify Database: 3 databases of 5 GB on Free.',
            ],
          ],
        },
        {
          caption: 'How far the free plan goes',
          columns: ['', `${us} free plans`, 'Netlify Free'],
          rows: [
            [
              'Page views a month, at 2 MB a page',
              '**No limit:** static files are free and unlimited',
              '**About 7,500:** 300 credits buy 15 GB at 20 credits a GB, if they buy nothing else',
            ],
            [
              'Production deploys',
              '**Free**, with 3,000 build minutes a month',
              '**15 credits each:** 20 deploys spend every credit',
            ],
            [
              'Server and API requests',
              '**100,000 a day**, about 3 million a month',
              '2 credits per 10,000 web requests, and compute at 10 credits per GB-hour, from the same 300',
            ],
            [
              'When you run out',
              'Server requests fail until midnight UTC; files keep serving; nothing is billed',
              'Every project on the team pauses until the next cycle; Free can’t buy credits',
            ],
          ],
        },
      ],
      note: 'Assumptions: 2 MB a page view (the page, scripts, styles and images), about 10 requests a view, functions at 1 GB of memory for 0.1 s a call, 20 ms of CPU per API call on Cloudflare, US dollars before tax. Netlify’s pricing page (credits per GB, per 10,000 requests, per deploy and per GB-hour, and its credit packs) and Cloudflare’s Workers pricing page were read on 28 October 2026.',
    },
    chooseUs: [
      'You serve meaningful traffic for free: 300 Netlify credits cover at most 15 GB of bandwidth (20 credits per GB) or 1.5 million web requests, and then every project on the team pauses until next month.',
      'You deploy often: each Netlify production deploy costs 15 credits; deploys cost nothing on Cloudflare (you get 3,000 build minutes a month).',
      'You want SQL, file storage and key-value data from the same account: D1, R2 and KV are included in Cloudflare’s plans.',
      'You need containers: Netlify doesn’t run long-lived servers or containers; Cloudflare Containers run on Workers Paid.',
    ],
    chooseThem: [
      'You want built-in form handling (unlimited and free on credit plans) without wiring it yourself.',
      'You want a separate database branch for each deploy preview (20 on Free). Shipcel’s previews share one staging copy of your data.',
      'You want managed Postgres: Netlify Database, generally available since April 2026, with 3 databases of 5 GB on Free.',
      'You want AI agents that run on the platform itself: Netlify’s Agent Runners work from its dashboard, with model usage billed in credits. Shipcel works with the agent on your own computer.',
      'You need a proven service today. Shipcel is in alpha.',
    ],
    tables: [
      {
        caption: 'Free plans',
        columns: ['', `${us} free plans`, 'Netlify Free'],
        rows: [
          ['Price', '$0', '$0'],
          [
            'How usage is counted',
            'Daily limits per service, reset at midnight UTC',
            '300 credits a month shared by deploys, compute, bandwidth and requests',
          ],
          [
            'Bandwidth',
            'No per-gigabyte charge; static files free and unlimited',
            '20 credits per GB (about 15 GB if credits buy nothing else)',
          ],
          [
            'Requests',
            '100,000 Worker requests a day; static files unlimited',
            '2 credits per 10,000 web requests',
          ],
          [
            'Production deploys',
            'Free; 3,000 build minutes a month',
            '15 credits each',
          ],
          [
            'When you run out',
            'Requests fail until midnight UTC; nothing is billed',
            'Every project on the team is paused until the next cycle; Free can’t buy credits',
          ],
          ['Members', 'Personal workspace', 'One member'],
        ],
      },
      {
        caption: 'Paid plans',
        columns: ['', `${us} Workers Paid`, 'Netlify Pro'],
        rows: [
          [
            'Price',
            '$5 a month per account',
            'From $20 a month for 3,000 credits, unlimited members',
          ],
          [
            'Extra usage',
            'Published per-unit rates; no bandwidth charges for static files or R2',
            '1,500 credits for $10, about $0.133 per GB of bandwidth',
          ],
          [
            'When you run out',
            'Nothing stops; usage beyond the included amounts is billed',
            'Projects pause at zero credits unless auto recharge is on (off by default)',
          ],
        ],
      },
      {
        caption: 'Features',
        columns: ['', 'Shipcel', 'Netlify'],
        rows: [
          [
            'Deploy from GitHub',
            'Yes, with GitHub Actions in your repository; no deploy credits',
            'Yes; 15 credits per production deploy',
          ],
          [
            'Pull request previews',
            'Cloudflare Worker Previews (beta), with the address commented on the pull request; previews share one staging copy of your data',
            'Deploy Previews, unmetered, each with its own database branch',
          ],
          [
            'Drag and drop',
            'Into your own Cloudflare account; new apps stay unpublished until you publish',
            'Netlify Drop; drops made without signing in are password-protected until claimed',
          ],
          [
            'Command line',
            '`shipcel`: signs in, builds on your computer and deploys',
            'Netlify CLI',
          ],
          [
            'AI agents',
            'Your own AI agent (Claude Code, Codex, Cursor and others) through Shipcel’s MCP server; Shipcel runs no model and charges nothing for it',
            'Agent Runners in the dashboard; model usage is billed at 180 credits per $1',
          ],
          [
            'Rollback',
            'One click to any earlier version',
            'Publish any earlier deploy; Free keeps deploys for 30 days',
          ],
          [
            'Split testing',
            'Two versions can share traffic by percentage',
            'Can’t be added to new projects since August 2026',
          ],
          ['Forms', 'Not built in', 'Netlify Forms, free and unlimited'],
          [
            'Sign-in for your users',
            'Built in: passkeys, GitHub, Google and email, as standard OpenID Connect',
            'Netlify Identity: email, GitHub, GitLab, Bitbucket and Google; its 2025 deprecation was reversed in February 2026',
          ],
          [
            'SQL database',
            'D1 (SQLite) in your account',
            'Netlify Database (serverless Postgres, generally available since April 2026): 3 databases of 5 GB on Free',
          ],
          [
            'Realtime',
            'Channels with presence and broadcast on Durable Objects',
            'Not built in',
          ],
          [
            'Teams',
            'Shared workspaces with owner, developer and viewer roles, free',
            'Free is the Team Owner only; Pro adds unlimited members',
          ],
          ['Where it runs', 'Your Cloudflare account', 'Netlify’s platform'],
        ],
      },
    ],
    examples: [],
    billing: [
      'Netlify Free is never billed: when credits run out, projects pause.',
      'Paid Netlify plans pause at zero credits unless auto recharge is turned on, so with auto recharge off the plan price is effectively a cap.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'Static sites move as they are: commit a Wrangler configuration that points at your build output.',
      'Netlify Functions become Worker routes. Scheduled functions become a `scheduled()` handler run by Cron Triggers, listed in your Wrangler configuration or set in Manage → Schedules.',
      'Forms need a replacement service or library. For user sign-in, turn on Manage → Sign-in & realtime.',
    ],
    sources: [
      netlify.pricing,
      netlify.plans,
      netlify.credits,
      netlify.faq,
      netlify.packs,
      netlify.paused,
      netlify.database,
      netlify.databaseLaunch,
      netlify.deployPreviews,
      netlify.branchDeploys,
      netlify.drop,
      netlify.cli,
      netlify.agentRunners,
      netlify.aiPricing,
      netlify.manageDeploys,
      netlify.splitTesting,
      netlify.forms,
      netlify.identity,
      netlify.identityChanges,
      netlify.realtime,
      netlify.roles,
      cf.pricing,
      cf.limits,
      cf.assets,
      cf.builds,
      cf.durableObjects,
      cf.budgetAlerts,
    ],
  },
  {
    slug: 'supabase',
    name: 'Supabase',
    kind: 'Postgres backend: database, sign-in, storage, realtime',
    oneLiner:
      'Supabase is a Postgres backend with sign-in and realtime. Shipcel hosts your whole app in your own Cloudflare account, with SQLite databases, file storage, sign-in and realtime included, and no per-project compute fees.',
    freeTier:
      '2 active projects; 500 MB database each; paused after a week of low activity',
    freeStops: 'Never billed; restrictions after a notice and a grace period',
    paidEntry:
      'Pro from $25 a month per organization, plus about $10 a month for each extra project',
    description:
      'Shipcel vs Supabase: free tiers, project limits, database and file pricing, sign-in, realtime, egress and spend caps compared with sources, and when Supabase’s Postgres is the better choice.',
    summary:
      'Supabase is a backend: Postgres with sign-in, row-level security, realtime and Edge Functions, but not your frontend. Shipcel deploys your whole app, frontend and API, into your Cloudflare account, with D1 (SQLite) databases, R2 file storage, KV, and a sign-in and realtime service that runs in the same account. The main differences are Postgres versus SQLite, how access rules are written, and where everything runs. Many apps can use both: Shipcel for hosting, Supabase for data.',
    chooseUs: [
      'You want your frontend, API, database and files in one account and on one bill.',
      'Your data fits SQLite: D1 databases hold up to 500 MB each on the free plan and 10 GB on Workers Paid.',
      'You run several small apps: Supabase Free allows 2 active projects and Pro adds about $10 a month of compute per extra project; on Cloudflare each extra app and database costs nothing beyond its usage.',
      'You don’t want projects paused for inactivity: Workers and D1 databases don’t sleep.',
      'You serve many files: R2 has no egress fees, while Supabase Pro charges $0.09 per GB of uncached egress beyond 250 GB.',
      'You want sign-in and realtime without a monthly-user quota: passkey, GitHub, Google and email sign-in and realtime channels run in your account and count against Cloudflare’s request allowances.',
    ],
    chooseThem: [
      'You need Postgres: extensions such as PostGIS and pgvector, complex queries, or an existing Postgres schema.',
      'You need phone sign-in, access rules written as Postgres policies, or a realtime stream of every database change. Shipcel’s rules are set per table (everyone, signed-in users or each row’s owner), and its realtime carries the changes made through its data API.',
      'You want a spreadsheet-style table editor and GraphQL over your data. Shipcel has a table browser, a SQL console and a REST data API, but no GraphQL.',
      'You want to self-host the same stack: Supabase is open source and runs with Docker Compose.',
    ],
    tables: [
      {
        caption: 'Free plans',
        columns: ['', `${us} free plans`, 'Supabase Free'],
        rows: [
          ['Price', '$0', '$0'],
          [
            'Projects',
            'Up to 100 Shipcel projects; up to 10 D1 databases per account',
            '2 active projects (paused ones don’t count)',
          ],
          [
            'Database',
            'D1 (SQLite): 500 MB per database, 5 GB in total; 5 million rows read and 100,000 written a day',
            'Postgres: 500 MB per project, read-only above that',
          ],
          [
            'File storage',
            'R2: 10 GB, 1 million writes and 10 million reads a month (R2 is added through a checkout that needs a payment method)',
            '1 GB; uploads up to 50 MB',
          ],
          [
            'Egress',
            'No egress fees for static files or R2',
            '5 GB uncached and 5 GB cached a month',
          ],
          [
            'Inactivity',
            'Nothing pauses',
            'Paused after a week of low activity; restorable for a year',
          ],
          ['Backups', 'Point-in-time restore for 7 days', 'Not included'],
          [
            'Sign-in',
            'Included: passkeys, GitHub and Google. No monthly user limit; a sign-in uses about 5 to 7 of your 100,000 daily Worker requests',
            '50,000 monthly active users',
          ],
          [
            'Realtime',
            'Included: channels with presence and broadcast on Durable Objects. Connections and incoming messages count toward 100,000 requests a day; messages to listeners are free and idle connections hibernate',
            '200 concurrent connections, 2 million messages a month',
          ],
          [
            'When you exceed it',
            'Requests fail until midnight UTC; nothing is billed (R2 bills beyond its free tier)',
            'Never billed; restrictions after a notice and grace period',
          ],
        ],
      },
      {
        caption: 'Paid plans',
        columns: ['', `${us} Workers Paid`, 'Supabase Pro'],
        rows: [
          [
            'Base price',
            '$5 a month per Cloudflare account; Shipcel $0',
            '$25 a month per organization, with $10 of compute credit (one Micro project)',
          ],
          [
            'Each extra project',
            'No fixed fee; usage only',
            'About $10 a month of Micro compute ($0.01344 an hour)',
          ],
          [
            'Database storage',
            'D1: 5 GB included, then $0.75 per GB-month; up to 10 GB per database',
            '8 GB of disk per project, then $0.125 per GB-month',
          ],
          [
            'File storage',
            'R2: 10 GB free, then $0.015 per GB-month',
            '100 GB included, then $0.0213 per GB-month',
          ],
          [
            'Egress',
            'None for static files or R2',
            '250 GB uncached included, then $0.09 per GB; 250 GB cached, then $0.03 per GB',
          ],
          [
            'Backups',
            'Point-in-time restore for 30 days, included; scheduled copies in R2 at R2’s storage price',
            'Daily backups kept 7 days; point-in-time recovery from about $100 a month',
          ],
          [
            'Spending control',
            'No hard cap from Cloudflare. Shipcel’s budget guard alerts over a budget ($0 by default) and can pause the app; Cloudflare’s budget alerts email you',
            'Spend cap on by default for usage items; compute and add-ons are always billed',
          ],
        ],
      },
      {
        caption: 'Features',
        columns: ['', 'Shipcel', 'Supabase'],
        rows: [
          [
            'Hosts your frontend',
            'Yes: static files and server code on Workers',
            'No; Edge Functions only',
          ],
          ['SQL database', 'D1 (SQLite)', 'Postgres with extensions'],
          [
            'Sign-in',
            'Passkeys, GitHub, Google, email links and passwords, as standard OpenID Connect; no phone',
            'Yes, including email and password, magic links, phone, and passkeys in beta',
          ],
          [
            'Row-level security',
            'Per table, through the data API: everyone, signed-in users or each row’s owner',
            'Yes, as Postgres policies',
          ],
          [
            'Realtime',
            'Channels with presence and broadcast on Durable Objects, and the changes made through the data API',
            'Broadcast, presence and database changes',
          ],
          [
            'File storage',
            'R2, S3-compatible, with a file browser for uploads (up to 25 MB), downloads and deletions',
            'Supabase Storage, S3-compatible',
          ],
          [
            'Server code',
            'Workers in JavaScript, TypeScript or Python; containers on Workers Paid',
            'Edge Functions in TypeScript (Deno-compatible)',
          ],
          [
            'Preview environments',
            'Every branch and pull request (Cloudflare Worker Previews, beta), on staging copies of your data',
            'Branching on paid plans: a database per pull request at $0.01344 per branch-hour',
          ],
          [
            'Rollback',
            'One click for code; point-in-time restore for databases',
            'Point-in-time recovery is a paid add-on; Free has no backups',
          ],
          [
            'Table and SQL editor',
            'A table browser and SQL console, with a restore point before each change',
            'Table Editor and SQL Editor in Studio, on Free',
          ],
        ],
      },
    ],
    examples: [costExamplesRef('side-projects'), costExamplesRef('downloads')],
    billing: [
      'Supabase Free is never billed: over quota you get a notice and a grace period, then restrictions such as read-only databases.',
      'Supabase Pro’s spend cap is on by default and blocks usage items (disk, egress, monthly active users, storage, function invocations, realtime) at the plan quota. Compute for every project and add-ons such as point-in-time recovery, custom domains and IPv4 are always billed, so the total bill isn’t capped.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'You can keep Supabase for data, and sign-in if you prefer it, and use Shipcel only for hosting: your Worker calls Supabase over HTTPS like any client.',
      'Moving data from Postgres to D1 means converting the schema to SQLite: types, defaults and functions differ, and row-level security policies become the data API’s per-table rules (everyone, signed-in users or each row’s owner) or checks in your own code.',
      'Both stores are S3-compatible, so tools such as rclone can copy files from Supabase Storage to R2.',
    ],
    sources: [
      supabase.pricing,
      supabase.billing,
      supabase.costControl,
      supabase.compute,
      supabase.egress,
      supabase.pausing,
      supabase.backups,
      supabase.passkeys,
      supabase.branching,
      supabase.tables,
      supabase.sqlEditor,
      cf.d1Pricing,
      cf.d1Limits,
      cf.r2,
      cf.r2Start,
      cf.pricing,
      cf.durableObjects,
      cf.budgetAlerts,
    ],
  },
  {
    slug: 'firebase',
    name: 'Firebase',
    kind: 'Google’s app backend: Firestore, sign-in, hosting, functions',
    oneLiner:
      'Firebase’s free Spark plan can’t run Cloud Functions or Cloud Storage, and its spending caps exclude Firestore and Hosting. Cloudflare’s free plan runs server code, SQL and static files, and stops at its limits.',
    freeTier:
      'Spark: Firestore 1 GiB and 50,000 reads a day; Hosting 360 MB a day; no Functions',
    freeStops: 'The product is shut off for the rest of the month',
    paidEntry: 'Blaze: pay as you go beyond the free quotas, no monthly fee',
    description:
      'Shipcel vs Firebase: Spark and Blaze plans, Firestore and Hosting pricing, functions, spending caps and realtime compared with sources, and when Firebase is the better choice.',
    summary:
      'Firebase is Google’s backend for mobile and web apps: Firestore with realtime listeners and offline support, sign-in, hosting and Cloud Functions. Its free Spark plan now excludes Cloud Functions and Cloud Storage, and Blaze bills usage with budget alerts that don’t stop spending. Shipcel deploys web apps with server code, SQL databases, file storage, sign-in and realtime channels into your own Cloudflare account, where the free plan includes server code.',
    chooseUs: [
      'You want server code on a free plan: Cloud Functions require Blaze, while Cloudflare’s free plan runs 100,000 Worker requests a day.',
      'You want file storage without per-gigabyte download fees: Cloud Storage requires Blaze and charges $0.12 per GiB of egress; R2 has no egress fees.',
      'You want predictable hosting costs: Firebase Hosting allows 360 MB of transfer a day on Spark and charges $0.15 per GB beyond the free tier on Blaze; Cloudflare doesn’t meter static files.',
      'You prefer SQL: D1 is a relational SQLite database; Firestore is a document database billed per document read and write.',
    ],
    chooseThem: [
      'You build a mobile app and want offline sync, realtime listeners and push messaging from one SDK.',
      'You need sign-in methods Shipcel doesn’t offer yet, such as email and password, phone numbers or anonymous accounts.',
      'You want Google Cloud products such as Cloud Run, BigQuery and Pub/Sub alongside your app.',
      'You need a proven service today. Shipcel is in alpha.',
    ],
    tables: [
      {
        caption: 'Free plans',
        columns: ['', `${us} free plans`, 'Firebase Spark'],
        rows: [
          ['Price', '$0', '$0'],
          [
            'Server code',
            '100,000 Worker requests a day',
            'Cloud Functions not available (Blaze only)',
          ],
          [
            'Database',
            'D1 (SQL): 5 GB, 5 million rows read and 100,000 written a day',
            'Firestore (documents): 1 GiB, 50,000 reads, 20,000 writes and 20,000 deletes a day',
          ],
          [
            'File storage',
            'R2: 10 GB free (R2 is added through a checkout that needs a payment method)',
            'Cloud Storage not available (Blaze only, since February 2026)',
          ],
          [
            'Hosting',
            'Static files free and unlimited',
            '10 GB stored, 360 MB of transfer a day',
          ],
          [
            'Sign-in',
            'Included: passkeys, GitHub and Google. No monthly user limit; a sign-in uses about 5 to 7 of your 100,000 daily Worker requests',
            '50,000 monthly active users (50 for SAML and OpenID Connect providers)',
          ],
          [
            'Realtime',
            'Included: channels with presence and broadcast on Durable Objects. Connections and incoming messages count toward 100,000 requests a day; messages to listeners are free and idle connections hibernate',
            'Realtime Database: 100 simultaneous connections; Firestore listeners billed as document reads',
          ],
          [
            'When you exceed it',
            'Requests fail until midnight UTC',
            'The product is shut off for the rest of the month; Hosting after a short grace period',
          ],
        ],
      },
      {
        caption: 'Paid plans',
        columns: ['', `${us} Workers Paid`, 'Firebase Blaze'],
        rows: [
          [
            'Base price',
            '$5 a month per account',
            'No fee; pay as you go beyond the free quotas',
          ],
          [
            'Database',
            'D1: 25 billion rows read and 50 million written a month included; 5 GB included',
            'Firestore (us-central1): $0.03 per 100,000 reads, $0.09 per 100,000 writes, $0.15 per GiB-month',
          ],
          [
            'Transfer',
            'No per-gigabyte charge for static files, Workers responses or R2',
            'Hosting $0.15 per GB; Cloud Storage $0.12 per GiB',
          ],
          [
            'Server code',
            '10 million requests a month included, then $0.30 per million',
            '2 million invocations free, then $0.40 per million, plus compute',
          ],
          [
            'Spending control',
            'No hard cap from Cloudflare. Shipcel’s budget guard alerts over a budget ($0 by default) and can pause the app; Cloudflare’s budget alerts email you',
            'Budget alerts don’t stop usage; spend caps are a preview for four services, not Firestore or Hosting',
          ],
        ],
      },
    ],
    examples: [],
    billing: [
      'On Spark, Firebase shuts a product off for the rest of the month when its quota is used up.',
      'On Blaze, Google Cloud budget alerts never cap usage. Firebase’s spend caps are in preview, cover only AI Logic, App Hosting, Cloud Functions and Extensions, and Firebase notes they are not hard caps.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'Firestore documents need a relational schema in D1, or a key-value design in KV for simple lookups.',
      'Firebase Hosting sites move as static assets; Cloud Functions become Worker routes.',
      'Keep Firebase Authentication if you rely on it: your Worker can verify Firebase ID tokens.',
    ],
    sources: [
      firebase.pricing,
      firebase.plans,
      firebase.storage,
      firebase.caps,
      firebase.firestore,
      firebase.budgets,
      cf.pricing,
      cf.limits,
      cf.d1Pricing,
      cf.r2,
      cf.durableObjects,
      cf.budgetAlerts,
    ],
  },
  {
    slug: 'render',
    name: 'Render',
    kind: 'Cloud platform for web services, databases and workers',
    oneLiner:
      'Render runs always-on servers and managed Postgres; its free web services sleep after 15 minutes and free databases are deleted after 30 days. Workers never sleep and D1 databases are permanent.',
    freeTier:
      'Free web services sleep after 15 minutes; free Postgres is deleted 30 days after creation',
    freeStops:
      'Services sleep when idle; the free database is deleted after 30 days',
    paidEntry:
      'Pro workspace $25 a month flat; web services from $7 and Postgres from $6 a month',
    description:
      'Shipcel vs Render: free instances, sleeping, databases, bandwidth and spending controls compared with sources, and when Render is the better choice.',
    summary:
      'Render runs your code as long-running servers and containers, alongside managed Postgres and Key Value. That suits apps built around a server process. Shipcel deploys to Cloudflare Workers, which start in milliseconds per request instead of running a server, so nothing sleeps on the free plan and you pay for requests and CPU time rather than instance hours. Docker workloads can run as Cloudflare Containers on Workers Paid.',
    chooseUs: [
      'You want a free tier that doesn’t sleep: Render’s free web services spin down after 15 minutes without traffic and take about a minute to start again.',
      'You want a free database that lasts: Render’s free Postgres is deleted 30 days after creation (after a 14-day grace period); D1 databases on Cloudflare’s free plan are permanent.',
      'You serve real traffic: Render includes 5 GB of bandwidth on Hobby and 25 GB on Pro, then charges $0.15 per GB; Cloudflare doesn’t meter static files.',
      'Your app can run as Workers (JavaScript, TypeScript or Python) on SQLite.',
    ],
    chooseThem: [
      'Your app is a long-running server, such as Rails, Django or a WebSocket server, that you don’t want to adapt to Workers.',
      'You need managed Postgres or Redis-compatible Key Value.',
      'You need persistent disks attached to a service; Cloudflare container disks are ephemeral.',
      'You want background workers and cron jobs as services in the same dashboard.',
    ],
    tables: [
      {
        caption: 'Free plans',
        columns: ['', `${us} free plans`, 'Render Hobby (free)'],
        rows: [
          ['Price', '$0', '$0'],
          [
            'Compute',
            '100,000 Worker requests a day; no idle time',
            '750 instance hours a month; web services sleep after 15 minutes idle and take about a minute to wake',
          ],
          [
            'Database',
            'D1: 5 GB in total, permanent',
            'Postgres: 1 GB, deleted 30 days after creation, no backups',
          ],
          [
            'Bandwidth',
            'No per-gigabyte charge; static files free and unlimited',
            '5 GB a month',
          ],
          ['Builds', '3,000 minutes a month', '500 minutes a month'],
        ],
      },
      {
        caption: 'Paid plans',
        columns: ['', `${us} Workers Paid`, 'Render'],
        rows: [
          [
            'Base price',
            '$5 a month per account',
            'Hobby workspace $0 or Pro $25 a month, plus each service',
          ],
          [
            'Web service',
            'Included requests and CPU time; nothing runs while idle',
            'From $7 a month (`0.5c-512mb`), always on',
          ],
          [
            'Database',
            'D1: 5 GB included, then $0.75 per GB-month',
            'Postgres from $6 a month plus $0.30 per GB of storage',
          ],
          [
            'Bandwidth',
            'No per-gigabyte charge',
            '$0.15 per GB beyond 5 GB (Hobby) or 25 GB (Pro)',
          ],
          [
            'Spending control',
            'No hard cap from Cloudflare. Shipcel’s budget guard alerts over a budget ($0 by default) and can pause the app; Cloudflare’s budget alerts email you',
            'A cap on build-minute spending and usage alerts',
          ],
        ],
      },
    ],
    examples: [costExamplesRef('always-on-api')],
    billing: [
      'Without a payment method, Render spins services down for the rest of the month when bandwidth runs out; with one, overage is billed.',
      'Render’s only spending limit is a cap on build minutes; compute and bandwidth are billed as used, with email alerts.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'HTTP services written for Node.js often run as Workers with the `nodejs_compat` flag; frameworks with a Cloudflare adapter import directly.',
      'Docker services can run as Cloudflare Containers on Workers Paid, behind a Worker that routes requests to them.',
      'Postgres data needs converting to SQLite for D1, or keep Postgres and connect to it from Workers.',
    ],
    sources: [
      render.pricing,
      render.free,
      render.bandwidth,
      render.plans,
      render.compute,
      cf.pricing,
      cf.limits,
      cf.d1Pricing,
      cf.containers,
      cf.budgetAlerts,
    ],
  },
  {
    slug: 'railway',
    name: 'Railway',
    kind: 'Usage-based platform for services and databases',
    oneLiner:
      'Railway bills containers by the vCPU and memory they use, from $5 a month. Cloudflare bills Workers by requests and CPU time, with a free plan of 100,000 requests a day.',
    freeTier:
      'A one-time $5 trial, then $1 of usage a month for one project with three services',
    freeStops:
      'Usage stops at $1 a month; paid plans set a hard limit that stops workloads',
    paidEntry:
      'Hobby $5 a month including $5 of usage; Pro $20 a month including $20',
    description:
      'Shipcel vs Railway: free usage, compute and egress rates, sleeping, and spending limits compared with sources, and when Railway is the better choice.',
    summary:
      'Railway deploys services and databases from Docker images or templates and bills the CPU, memory, egress and volumes they use. Shipcel deploys to Cloudflare Workers, which cost nothing while idle, with D1, R2 and KV in the same account. For Docker workloads, Cloudflare Containers run on Workers Paid.',
    chooseUs: [
      'You want a real free plan: after Railway’s one-time $5 trial, its Free plan gives $1 of usage a month (one project, three services, no custom domains). Cloudflare’s free plan includes 100,000 requests a day and 5 GB of D1 storage.',
      'Your traffic is low or spiky: Workers cost nothing between requests, while a Railway service bills memory ($10 per GB-month) and CPU while it runs, unless you enable its optional sleep mode.',
      'You serve a lot of traffic: Railway charges $0.05 per GB of egress; Cloudflare doesn’t meter static files, Workers responses or R2 downloads.',
    ],
    chooseThem: [
      'You deploy existing Docker images or long-running servers in any language, with Postgres, MySQL, Redis or MongoDB from templates.',
      'You need persistent volumes ($0.15 per GB-month) attached to services.',
      'You want a hard spending limit: Railway can take workloads offline at an amount you set (minimum $10); Workers Paid has no hard cap.',
    ],
    tables: [
      {
        caption: 'Plans and rates',
        columns: ['', us, 'Railway'],
        rows: [
          [
            'Free',
            'Cloudflare’s free plan: 100,000 requests a day, 5 GB of D1, 10 GB of R2',
            'One-time $5 trial, then $1 of usage a month; one project, three services',
          ],
          [
            'Entry plan',
            'Workers Paid $5 a month per account',
            'Hobby $5 a month including $5 of usage; Pro $20 including $20, unlimited seats',
          ],
          [
            'Compute',
            '30 million CPU-ms a month included, then $0.02 per million CPU-ms; nothing billed while idle',
            '$20 per vCPU-month and $10 per GB-month of memory while running',
          ],
          [
            'Egress',
            'No per-gigabyte charge for Workers, static files or R2',
            '$0.05 per GB',
          ],
          [
            'Storage',
            'D1 5 GB included, then $0.75 per GB-month; R2 $0.015 per GB-month',
            'Volumes $0.15 per GB-month; object storage $0.015 per GB-month with free egress',
          ],
          [
            'Spending control',
            'No hard cap from Cloudflare. Shipcel’s budget guard alerts over a budget ($0 by default) and can pause the app; Cloudflare’s budget alerts email you',
            'Alerts and an optional hard limit that takes workloads offline',
          ],
        ],
      },
    ],
    examples: [],
    billing: [
      'Railway’s hard limit stops all workloads when reached (minimum $10), with warnings at 75%, 90% and 100%.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'HTTP services often run as Workers with the `nodejs_compat` flag, or as Cloudflare Containers on Workers Paid when they need a full Linux environment.',
      'Databases from templates need a replacement: D1 for SQL that fits SQLite, or keep your database and connect from Workers.',
    ],
    sources: [
      railway.pricing,
      railway.plans,
      railway.trial,
      railway.costControl,
      cf.pricing,
      cf.limits,
      cf.containers,
      cf.r2,
      cf.budgetAlerts,
    ],
  },
  {
    slug: 'heroku',
    name: 'Heroku',
    kind: 'Classic platform: dynos and add-ons',
    oneLiner:
      'Heroku has had no free tier since November 2022; its cheapest dynos cost $5 a month and sleep after 30 minutes. Cloudflare’s free plan runs your app without sleeping.',
    freeTier: 'None since November 2022',
    freeStops: 'No free plan',
    paidEntry:
      'Eco dynos $5 a month for 1,000 hours (they sleep); Basic $7; Postgres from $5',
    description:
      'Shipcel vs Heroku: free tiers, dyno sleeping, Postgres plans and spending controls compared with sources, and when Heroku is the better choice.',
    summary:
      'Heroku runs apps as dynos with a marketplace of add-ons such as Postgres and Key-Value Store. It removed its free plans in November 2022. Shipcel deploys to Cloudflare Workers, which need no always-on process, with D1, R2 and KV in the same account and a free plan that doesn’t sleep.',
    chooseUs: [
      'You want to start at $0: Heroku has no free tier.',
      'You don’t want apps to sleep: Eco dynos sleep after 30 minutes without web traffic and stop for the rest of the month when the account’s 1,000 hours run out.',
      'You want SQL without a paid add-on: Postgres Essential-0 is $5 a month for 1 GB; D1 includes 5 GB on the free plan.',
    ],
    chooseThem: [
      'You run a classic server app (Rails, Django, Node.js or Java) with Procfile processes and want the add-on marketplace.',
      'You need managed Postgres or Redis with Heroku’s operational tooling.',
    ],
    tables: [
      {
        caption: 'Plans',
        columns: ['', us, 'Heroku'],
        rows: [
          [
            'Free',
            'Cloudflare’s free plan: 100,000 requests a day, D1, KV and R2 free tiers',
            'None',
          ],
          [
            'Cheapest always-on app',
            'Workers Paid $5 a month per account (the free plan doesn’t sleep either)',
            'Basic dyno $7 a month',
          ],
          [
            'Sleeping',
            'Never',
            'Eco dynos ($5 for 1,000 hours a month) sleep after 30 minutes idle',
          ],
          [
            'SQL database',
            'D1: 5 GB free; 5 GB included on Workers Paid',
            'Postgres Essential-0 $5 a month (1 GB)',
          ],
          [
            'Bandwidth',
            'No per-gigabyte charge',
            'Soft limit of 2 TB per app a month',
          ],
          [
            'Spending control',
            'No hard cap from Cloudflare. Shipcel’s budget guard alerts over a budget ($0 by default) and can pause the app; Cloudflare’s budget alerts email you',
            'No built-in cap; a billing-alarm add-on is in invite-only alpha',
          ],
        ],
      },
    ],
    examples: [costExamplesRef('always-on-api')],
    billing: [
      'Heroku bills dynos and add-ons per second up to each resource’s monthly price, with no built-in account spending cap.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'Web processes often run as Workers with the `nodejs_compat` flag; Python apps can run as Python Workers if their packages are Pyodide-compatible.',
      'Long-running or native workloads can run as Cloudflare Containers on Workers Paid.',
      'Config vars become Worker secrets in Manage → Runtime secrets.',
    ],
    sources: [
      heroku.pricing,
      heroku.free,
      heroku.eco,
      heroku.postgres,
      heroku.billing,
      heroku.limits,
      cf.pricing,
      cf.limits,
      cf.d1Pricing,
      cf.containers,
      cf.budgetAlerts,
    ],
  },
  {
    slug: 'coolify',
    name: 'Coolify',
    kind: 'Open-source platform on servers you run',
    oneLiner:
      'Coolify deploys apps, databases and 360+ one-click services to Linux servers you run, free when you host it yourself. Shipcel deploys to your own Cloudflare account, with no server to patch or size.',
    freeTier:
      'Self-hosted: free forever, on servers you pay for and look after',
    freeStops: 'Nothing stops it; the server’s size is the limit',
    paidEntry:
      'Coolify Cloud $5 a month for 2 servers you bring, then $3 a server',
    description:
      'Shipcel vs Coolify: what each runs on, what you look after, costs, backups, notifications and shared variables compared with sources, and when Coolify is the better choice.',
    summary:
      'Coolify installs on a Linux server (2 cores, 2 GB of memory and 10 GB of disk at least) and runs your apps there in Docker, built from Git with Nixpacks, Railpack, a Dockerfile or Docker Compose, beside databases and one-click services. You keep the server updated, backed up and big enough. Shipcel deploys to Cloudflare’s network in your own account: a Worker starts per request and costs nothing while idle, and there’s no machine to look after. Long-running Docker services run as Cloudflare Containers on Workers Paid.',
    chooseUs: [
      'You don’t want to run a server: no operating system updates, disks, Docker upgrades or capacity to plan. Cloudflare runs Workers in its own data centres, near your visitors.',
      'Your traffic is small or uneven: Cloudflare’s free plan includes 100,000 requests a day and a Worker costs nothing between requests, where a server is paid for all month.',
      'You want a database, files and sign-in without hosting them: D1, R2 and KV in your account, scheduled copies of D1 in R2, and Shipcel’s sign-in and data API.',
    ],
    chooseThem: [
      'You run long-lived Docker services or anything that needs a full Linux machine: Docker Compose stacks, 360+ one-click services, and Postgres, MySQL, MongoDB or Redis next to your app.',
      'You already have servers, or your data must stay on hardware you choose.',
      'You want an open-source platform today: Coolify is Apache-2.0; Shipcel’s license isn’t chosen yet.',
    ],
    tables: [
      {
        caption: 'What runs where, and what it costs',
        columns: ['', us, 'Coolify'],
        rows: [
          [
            'Runs on',
            'Cloudflare’s network, in your account; no server',
            'Your Linux servers, amd64 or arm64, at least 2 cores, 2 GB of memory and 10 GB of disk',
          ],
          [
            'The platform',
            'Free, as a launch offer',
            'Free self-hosted; Cloud $5 a month for 2 servers, then $3 a month a server',
          ],
          [
            'Compute',
            'Workers: 100,000 requests a day free; Workers Paid $5 a month',
            'The servers, billed by whoever rents them to you',
          ],
          [
            'Deploys from',
            'GitHub, GitLab, Bitbucket and Gitea, your terminal, drag and drop, AI agents',
            'GitHub, GitLab, Bitbucket and Gitea, with Nixpacks, Railpack, a Dockerfile, Docker Compose or an image',
          ],
          [
            'Databases',
            'D1 (SQLite) in your account; Postgres or MySQL hosted elsewhere, through Hyperdrive',
            'Postgres, MySQL, MariaDB, MongoDB, Redis and others, on your server',
          ],
          [
            'Backups',
            'Time Travel restore (30 days on Workers Paid), and daily or weekly copies in R2',
            'Scheduled dumps of Postgres, MySQL, MariaDB, MongoDB, ClickHouse and SQLite, on the server and in S3-compatible storage',
          ],
          [
            'Notifications',
            'Webhook, Telegram and email',
            'Email, Discord, Telegram, Slack or Mattermost, Pushover and webhooks',
          ],
          [
            'Shared variables',
            'A secret set on several projects at once',
            'Team, project, environment and server variables, referenced from an app’s',
          ],
          ['License', 'Not chosen yet', 'Apache-2.0'],
        ],
      },
    ],
    examples: [],
    billing: [
      'Coolify itself costs nothing when you host it. Coolify Cloud runs it for you for $5 a month with 2 servers connected and $3 a month for each one after; the servers stay yours to rent, and a team on Cloud has its own subscription.',
      cfFreeLine,
      cfPaidLine,
    ],
    moving: [
      'An app Nixpacks or a Dockerfile builds, serving HTTP, often runs as a Worker with the `nodejs_compat` flag, or unchanged as a Cloudflare Container on Workers Paid.',
      'A database on the Coolify server moves to D1 if it fits SQLite, or stays where it is and is reached through Hyperdrive (Postgres and MySQL).',
      'One-click services are few on Shipcel (Umami and n8n as starter kits) where Coolify has hundreds.',
    ],
    sources: [
      coolify.pricing,
      coolify.install,
      coolify.repo,
      coolify.backups,
      coolify.notifications,
      coolify.variables,
      cf.pricing,
      cf.limits,
      cf.containers,
    ],
  },
];

function costExamplesRef(id: string) {
  const found = costExamples.find((e) => e.id === id);
  if (!found) throw new Error(`Unknown cost example ${id}`);
  return found;
}

// Front page. It names no other company: comparisons live on /compare/. `icon` names a
// drawing in site/home.ts.
export const platformFeatures = [
  {
    icon: 'git',
    title: 'Deploy with a git push',
    text: 'Every push to your production branch deploys. Every pull request gets its own preview address, on staging copies of your data.',
  },
  {
    icon: 'globe',
    title: 'Free address, custom domains',
    text: 'Every app gets `your-app.your-name.workers.dev` for free, and your own domain takes a few clicks.',
  },
  {
    icon: 'database',
    title: 'Databases, files and key-value data',
    text: 'D1 SQL, R2 files and KV, created after you review them, with migrations, exports and restore; Postgres or MySQL through Hyperdrive.',
  },
  {
    icon: 'key',
    title: 'Sign-in and realtime',
    text: 'Passkey, GitHub, Google and email sign-in, and realtime channels with presence, in your account. Standard OpenID Connect, so any library works.',
  },
  {
    icon: 'chart',
    title: 'Analytics and logs',
    text: 'Requests, errors and response times, visitors and Core Web Vitals, build logs and live logs, from Cloudflare’s own data.',
  },
  {
    icon: 'undo',
    title: 'Changes you can check and undo',
    text: 'A health check after every deploy, one-click rollback, and a share of traffic for a new version before it gets it all.',
  },
  {
    icon: 'layers',
    title: 'Your framework, your language',
    text: 'Next.js, Astro, SvelteKit, React, Vue, Hono and static sites, plus Python Workers and Docker containers.',
  },
  {
    icon: 'users',
    title: 'Built for teams',
    text: 'Owner, developer and viewer roles, API tokens for CI, and a record of every change.',
  },
];

// Four ways to start (front page). No other company is named.
export const startOptions = [
  {
    icon: 'agent',
    title: 'Build with your AI agent',
    text: 'Connect Claude Code, Codex, Cursor or another agent to Shipcel’s MCP server. Describe what you want; it builds, deploys and shows you the preview. Shipcel runs no model, so there is nothing extra to pay. Agents start at [llms.txt](/llms.txt).',
  },
  {
    icon: 'git',
    title: 'Deploy from Git',
    text: 'Connect a GitHub repository: every push deploys, and every pull request gets its own preview address, commented on the pull request.',
  },
  {
    icon: 'terminal',
    title: 'Deploy from your terminal',
    text: 'Run `shipcel` in your project: it builds on your computer and deploys, a static site or an app with server code and a database. It works in CI with a token, too.',
  },
  {
    icon: 'upload',
    title: 'Drag and drop',
    text: 'Drop a built folder in the dashboard. A new app stays unpublished, with only its preview address working, until you choose to publish.',
  },
];

export type FeatureItem = {
  title: string;
  text: string;
  // Built: implemented and tested (Shipcel is in alpha). Beta: rests on a Cloudflare beta.
  status: 'Built' | 'Beta' | 'Not yet';
};
// The /features/ page: everything Shipcel does, and what it doesn't do yet.
export const featureGroups: {
  id: string;
  title: string;
  items: FeatureItem[];
}[] = [
  {
    id: 'start',
    title: 'Start your way',
    items: [
      {
        title: 'Your own AI agent',
        text: 'An MCP server for Claude Code, Codex, Cursor and other agents: create projects, deploy files, publish, roll back, set secrets. Agents sign in with an API token you can revoke.',
        status: 'Built',
      },
      {
        title: 'Deploys from GitHub',
        text: 'Every push builds with GitHub Actions and deploys to your account: the production branch to production, other branches as previews.',
        status: 'Built',
      },
      {
        title: 'The shipcel command',
        text: '`shipcel` from a terminal or CI: signs in through the browser (or a token), recognises Vite, Create React App, Vue CLI, Astro, Gatsby, Docusaurus, VitePress, Eleventy, Hugo, Jekyll and more, builds on your computer and uploads only changed files. A new app’s first deploy goes to production; later ones are previews until you say otherwise.',
        status: 'Built',
      },
      {
        title: 'Apps with code, from your terminal',
        text: '`shipcel` also deploys Next.js, SvelteKit, React Router, Nuxt, Angular, TanStack Start, Qwik City, Astro with server output and any Worker with a Wrangler configuration, with its bindings, adding the framework’s Cloudflare adapter when it has none. Run live for React Router, Next.js, SvelteKit and a Worker with D1, KV and a Durable Object; the others in Cloudflare’s local runtime.',
        status: 'Beta',
      },
      {
        title: 'Drag and drop',
        text: 'Drop a built folder in the dashboard; a new app stays unpublished until you publish it.',
        status: 'Built',
      },
      {
        title: 'Starter kits and imports',
        text: 'Fourteen starter kits (React, Vue, Hono, a Postgres API on Hyperdrive, a static site, a JavaScript Worker, Astro, SvelteKit, Next.js, Python, a container app, Umami and n8n as services, and WordPress, experimental), and imports of existing repositories for the same frameworks and for Docker containers (containers need Workers Paid).',
        status: 'Built',
      },
      {
        title: 'Workers AI, Durable Objects and more',
        text: 'Imports can use Workers AI, SQLite-backed Durable Objects, browser rendering, Images, variables, Smart Placement and cron schedules, all on the free plan.',
        status: 'Built',
      },
    ],
  },
  {
    id: 'previews',
    title: 'Previews and releases',
    items: [
      {
        title: 'A preview for every branch and pull request',
        text: 'Cloudflare Worker Previews, with the address commented on the pull request. Previews bind staging copies of your databases, namespaces and buckets, never production data.',
        status: 'Beta',
      },
      {
        title: 'One-click rollback',
        text: 'Send all traffic back to an earlier version from Manage, the CLI or your agent.',
        status: 'Built',
      },
      {
        title: 'Traffic splitting',
        text: 'Give a new version a share of traffic first; Shipcel checks that version before you send it everything.',
        status: 'Built',
      },
      {
        title: 'Health checks and recovery',
        text: 'A homepage check after every deploy, and interrupted steps checked against Cloudflare before anything is repeated.',
        status: 'Built',
      },
      {
        title: 'Free addresses and custom domains',
        text: '`your-app.your-name.workers.dev` for every app, and your own domains attached in a few clicks.',
        status: 'Built',
      },
      {
        title: 'Protected previews',
        text: 'Ask reviewers to sign in before they open preview addresses, with Cloudflare Access in your account. Zero Trust’s free plan covers 50 people; Cloudflare asks for a payment method when you set it up.',
        status: 'Built',
      },
    ],
  },
  {
    id: 'data',
    title: 'Data',
    items: [
      {
        title: 'SQL databases, files and key-value data',
        text: 'D1, R2 and KV created in your account after you review them.',
        status: 'Built',
      },
      {
        title: 'Migrations, exports and point-in-time restore',
        text: 'Reviewed migrations with a restore point first, SQL exports, and restore to any moment in Time Travel’s window.',
        status: 'Built',
      },
      {
        title: 'Scheduled backups',
        text: 'Daily or weekly copies of a D1 database in an R2 bucket of your account, each downloadable.',
        status: 'Built',
      },
      {
        title: 'Table browser and SQL console',
        text: 'Page through your D1 tables and run SQL; queries that change data are confirmed, with a restore point recorded before each one.',
        status: 'Built',
      },
      {
        title: 'File and key-value browser',
        text: 'Browse R2 folders and KV keys, open and edit text values, upload files up to 25 MB, download and delete. Changes are confirmed and recorded without their contents.',
        status: 'Built',
      },
      {
        title: 'Data API and row-level security',
        text: 'REST over the D1 tables you open, read and changed by everyone, signed-in users or each row’s owner, with each change on realtime.',
        status: 'Built',
      },
    ],
  },
  {
    id: 'users',
    title: 'Sign-in and realtime',
    items: [
      {
        title: 'Sign-in for your users',
        text: 'Passkeys, GitHub, Google, email links and optional passwords, as standard OpenID Connect, in your account with no monthly user limit. Email and passwords need Workers Paid.',
        status: 'Built',
      },
      {
        title: 'Realtime channels',
        text: 'Broadcast and presence on Durable Objects, with listeners free and idle connections hibernating.',
        status: 'Built',
      },
      {
        title: 'Phone sign-in',
        text: 'Codes by text message need an SMS service, which Shipcel doesn’t set up.',
        status: 'Not yet',
      },
    ],
  },
  {
    id: 'operate',
    title: 'Operate',
    items: [
      {
        title: 'Runtime secrets',
        text: 'Set and remove secrets; values go only to Cloudflare and are never shown again.',
        status: 'Built',
      },
      {
        title: 'Build variables',
        text: 'Variables your build command reads, set separately for production and branch preview builds; secret values go only to Cloudflare.',
        status: 'Built',
      },
      {
        title: 'Shared variables',
        text: 'One secret set on several projects at once; the value goes only to Cloudflare.',
        status: 'Built',
      },
      {
        title: 'Deploy notifications',
        text: 'A webhook (Slack, Discord or any HTTPS endpoint), a Telegram chat through your own bot, or a confirmed email address, when a deploy goes live or fails or a health check fails.',
        status: 'Built',
      },
      {
        title: 'Firewall for your domains',
        text: 'Cloudflare’s DDoS protection covers every app. For an app with a custom domain, Manage → Security and `shipcel security` turn on Cloudflare’s Free Managed Ruleset, Bot Fight Mode, AI crawler blocking and Under Attack mode, and add rules by country, IP or path and a rate limit, all free. Tested against a stand-in for Cloudflare, not yet a live zone.',
        status: 'Beta',
      },
      {
        title: 'Free-only mode',
        text: 'On by default: Shipcel creates nothing in a project that Cloudflare can bill for.',
        status: 'Built',
      },
      {
        title: 'Budget guard',
        text: 'Every five minutes Shipcel estimates each app’s cost beyond what Cloudflare includes, from Cloudflare’s analytics, and alerts at 50%, 80% and over its budget ($0 by default). An owner can have it pause an app over budget: production answers 503 and schedules stop, data kept, until resumed. Tested against a stand-in for Cloudflare, not yet a live account.',
        status: 'Beta',
      },
      {
        title: 'API tokens',
        text: 'For the CLI, agents and scripts; shown once, revocable, and unable to change billing or connections.',
        status: 'Built',
      },
      {
        title: 'Cron schedules',
        text: 'Run your Worker on a schedule: listed in your Wrangler configuration, or set in Manage → Schedules.',
        status: 'Built',
      },
      {
        title: 'Analytics and logs',
        text: 'Requests, errors and CPU time by hour, and recent log lines and errors from Workers Logs, in Manage.',
        status: 'Built',
      },
      {
        title: 'Queues and Workflows in Shipcel',
        text: 'Available in Cloudflare’s dashboard for your account; not yet in Shipcel’s imports or dashboard.',
        status: 'Not yet',
      },
      {
        title: 'Teams and roles',
        text: 'Shared workspaces with owners, developers and viewers, joined by invitation links; no seat fees.',
        status: 'Built',
      },
      {
        title: 'Forms and image optimization',
        text: 'Not built in; use a form service or library, and Cloudflare Images separately.',
        status: 'Not yet',
      },
    ],
  },
];

export const noCode = [
  '**Set up for you:** Workers, builds, databases, storage, domains, secrets, sign-in and realtime, created and connected in your account. You never configure Cloudflare by hand.',
  '**Reviewed first:** every change is shown before it happens, and recorded afterwards.',
  '**Daily work in the dashboard:** secrets, domains, rollbacks, migrations, backups and previews.',
  '**Ready to deploy:** starter kits deploy as they are, and the CLI recognises your framework.',
];

export const tiers = [
  {
    name: 'Hobby',
    price: '$0',
    unit: 'on Cloudflare’s free plan',
    points: [
      '100,000 requests a day and unlimited static file traffic',
      '5 GB of SQL storage and 10 GB of files',
      'Sign-in and realtime for your users',
      'Up to 100 projects, and nothing sleeps',
    ],
  },
  {
    name: 'Growth',
    price: '$5',
    unit: 'a month to Cloudflare (Workers Paid), per account, plus usage',
    points: [
      '10 million requests and 30 million CPU-milliseconds a month included',
      'No daily caps; extra usage at Cloudflare’s published rates',
      'Containers, 10 GB databases and up to 5 minutes of CPU per request',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Your contract',
    unit: 'with Cloudflare',
    points: [
      'Apps run in your own Cloudflare account, so your agreement with Cloudflare covers them',
      'Your data stays in your account; Shipcel never holds it',
      'Teams with owner, developer and viewer roles; single sign-on and support plans to come',
    ],
  },
];
