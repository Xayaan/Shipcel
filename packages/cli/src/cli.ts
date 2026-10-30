// The shipcel command-line tool. Its commands follow Vercel's CLI (login, deploy, --prod,
// build, link, git connect, list, inspect, promote, rollback, logs, env, domains…) so they
// feel familiar, and so does setting up: signing in, connecting Cloudflare and the first
// deploy all start in the terminal. It talks only to Shipcel's HTTP API
// (docs/contracts/direct-deploy-and-tokens.md) and deploys into the user's own Cloudflare
// account through their Shipcel workspace. A project is built on this computer, so a deploy
// needs no build service set up in Cloudflare. Everything it touches outside the process
// comes through `Io`, so it can be tested without a network or a home directory.
import { unzipSync } from 'fflate';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_RULES_BYTES,
  MAX_WORKER_BYTES,
  assetHash,
  assetPathProblem,
  toBase64,
} from '../../../shared/assets.ts';
import { frameworks, usesContainers } from '../../../shared/catalog.ts';
import type { RepositoryInspection } from '../../../shared/deployment-plan.ts';
import {
  WRANGLER_VERSION,
  type LocalPlan,
} from '../../../shared/local-deploy.ts';
import { projectNameFrom as projectName } from '../../../shared/names.ts';
import { parseManifest } from '../../../shared/site-presets.ts';
import {
  allowWorkersDev,
  appBuildCommand,
  lockfileManagers,
  planFiles,
  setupCommand,
  setupEnv,
  setupFramework,
  wranglerCommand,
  wranglerEnv,
} from './app.ts';
import {
  CliError,
  ago,
  baseUrl,
  browserApproval,
  change,
  client,
  configDir,
  confirmed,
  dashboard,
  decode,
  join,
  parent,
  parseArgs,
  production,
  readConfig,
  resolve,
  table,
  text,
  writeConfig,
  yes,
  type Args,
  type Client,
  type Io,
  type Job,
  type Project,
} from './core.ts';
import {
  alerts,
  dnsCommand,
  pricing,
  teams,
  tokens,
  usage,
  webhooks,
} from './account.ts';
import { storage } from './storage.ts';
import { cacheEntries, copyStaticCache, fillCache } from './opennext.ts';
import { bisect } from './bisect.ts';
import { cache, redirects, security } from './edge.ts';
import {
  agentInit,
  apiCall,
  budget,
  crons,
  curl,
  dev,
  envPull,
  mcp,
  metrics,
  rollingRelease,
  upgrade,
} from './commands.ts';
import { githubRepository, parseRemotes, remoteRepository } from './git.ts';
import {
  detect,
  detectionFiles,
  outputDirectory,
  packageManager,
  readInFull,
  type Detection,
  type Settings,
} from './site.ts';

export { parseArgs, type Io };
export const VERSION = '0.4.2';

const HELP = `shipcel ${VERSION} — deploy to your own Cloudflare account through Shipcel.
The commands follow Vercel's CLI.

Usage: shipcel [command] [options]

Deploy
  shipcel [deploy] [folder]       Build this project and deploy it: a new app goes to
                                   production, later deploys are previews
      --prod                       Deploy to production and publish its address
      --target preview|production  Say which, whatever the default would be
      --prebuilt                   Skip the build: deploy what the last build wrote
      --project <name|id>          The project (default: the one linked to this folder)
      --name <app name>            The app's name on a first deploy (its workers.dev address)
      --spa / --no-spa             Send unknown paths to index.html
  shipcel build                   Build this project without deploying it
  shipcel promote <version|url>   Make a version the production one
  shipcel rollback [version|url]  Send production back to the previous (or given) version
  shipcel redeploy                Build the production branch again (GitHub projects)
  shipcel list | ls [project]     Versions, newest first, and what production serves
  shipcel inspect <version|url>   One version's details
  shipcel logs                    Recent requests and errors (--since 2h, --errors, --follow)
  shipcel open                    The project in the dashboard (--app: the app itself)
  shipcel publish | unpublish     Turn the app's public workers.dev address on or off
  shipcel bisect --good <version> Find the first bad version between a good and a bad one
  shipcel rolling-release start | approve | complete | abort | status
                                   Move production to a version a share at a time
  shipcel metrics                 Requests, errors, response and CPU time (--since 24h | 7d | 30d)
  shipcel budget [check]          This month's cost beyond what Cloudflare includes,
                                   against the app's budget (check: read it now)
  shipcel curl | httpstat [path]  Request the app, or time a request to it
  shipcel dev                     Run this project on your computer

Projects
  shipcel init [kit] [folder]     Start from a starter kit: a project and its files
  shipcel link                    Link this folder to a project (--project <name>)
  shipcel git connect             Deploy every push to this folder's GitHub repository
  shipcel project ls | add <name> | rm <name> | inspect [name]
  shipcel remove | rm <name>      Remove a project from Shipcel
  shipcel env ls | add <NAME> | rm <NAME> | pull     The app's secrets and variables
  shipcel domains ls | add <hostname> | rm <hostname>     (alias: the same)
  shipcel hyperdrive ls | add <BINDING> | rm <BINDING>   Postgres or MySQL, hosted anywhere
  shipcel crons ls | add "<schedule>" | rm "<schedule>"
  shipcel activity                What changed in your workspace recently

Account and tools
  shipcel login [--url <address>] Sign in with GitHub and connect Cloudflare (in your browser)
  shipcel logout                  Forget the token on this computer
  shipcel whoami                  Who you are signed in as
  shipcel switch                  Sign in to another workspace
  shipcel mcp                     Connect your AI agent to Shipcel (--write: .mcp.json)
  shipcel agent init              Deploy notes for coding agents, in AGENTS.md
  shipcel api <path>              Call Shipcel's API as you (--method, --data)
  shipcel tokens ls | add <name> | rm <name>
                                   API tokens: list, create (approved in your browser), revoke
  shipcel teams ls                Your workspaces, and the one this sign-in works in
  shipcel usage                   This month's cost beyond what Cloudflare includes, per app
  shipcel alerts                  What needs attention: budgets, health checks, failed deploys
  shipcel webhooks ls             Each project's webhook and its last delivery (--all)
  shipcel pricing [word]          Shipcel's and Cloudflare's plans and limits
  shipcel storage ls | get | put | rm   The app's KV namespaces and R2 buckets (--preview)
  shipcel dns ls [domain] | add <domain> <name> <type> <value> | rm <domain> <id>
                                   DNS records of your Cloudflare account's zones
  shipcel cache purge [url…]      Empty the cache of the app's custom domains
  shipcel security [ls] | managed|bots|ai-bots|under-attack on|off
                   | block|challenge country|ip|path <values> | rm <rule id>
                   | rate-limit <path> <requests>|off
                                   Cloudflare's firewall for the app's custom domains
  shipcel redirects ls | add /from /to | rm /from
                                   The app's _redirects, applied with its next deploy
  shipcel upgrade                 Install the CLI this Shipcel serves

Options: --cwd <folder>, --token <token>, --url <address>, --yes (-y), --json,
         --help (-h), --version (-v). Run shipcel help <command> for details.
Environment: SHIPCEL_URL, SHIPCEL_TOKEN (for CI), SHIPCEL_CONFIG_DIR.`;

const COMMAND_HELP: Record<string, string> = {
  deploy: `shipcel [deploy] [folder] [options]

In a project's folder, Shipcel recognises the framework, builds on this computer and
deploys the result. A site (Vite, Create React App, Vue CLI, Astro, Gatsby and others) is
uploaded as files. An app with code that runs on Cloudflare (Next.js, SvelteKit, Astro with
its adapter, Hono, or any project with a wrangler.jsonc, including its databases and other
bindings) is deployed by Wrangler, which runs here and reaches your Cloudflare account
through Shipcel, so nothing needs setting up in Cloudflare. The first time, it shows what
it found; a site's settings are kept in .shipcel/project.json. A folder of files that are
already built (shipcel deploy dist) is uploaded as it is.

A new app's first deploy goes to production, as on Vercel. After that a deploy is a
preview (a new version with its own address, while production keeps serving the current
one) unless you pass --prod.

  --prod                 Deploy to production and publish its workers.dev address
  --target <where>       preview or production, whatever the default would be
  --prebuilt             Skip installing and building: deploy what the last build wrote
  --build-command <cmd>  The command that builds the site ("" for none)
  --output <folder>      The folder the build writes, such as dist
  --project <name|id>    The project (default: the one linked to this folder)
  --name <app name>      The app's name on a first deploy (its workers.dev address)
  --yes, -y              No questions: create and link a project named after the folder
  --spa / --no-spa       Send unknown paths to index.html
  --json                 Print the result as JSON

A site's folder may contain _worker.js (handles requests no file matches), _redirects,
_headers, 404.html and .shipcelignore. A framework that renders on a server and has no
Cloudflare adapter yet is offered Wrangler's setup, which adds it to the project.
Containers, queues, routes and Python packages deploy only with Cloudflare's own builds:
shipcel git connect --cloudflare-builds.`,
  build: `shipcel build [--build-command <cmd>] [--output <folder>]

Installs the project's dependencies if node_modules is missing, then runs its build, as
shipcel deploy does before deploying. Deploy the result with shipcel deploy --prebuilt.`,
  git: `shipcel git connect [--repo <owner/name>] [--name <project>] [--yes]
shipcel git ls | disconnect

Connects this folder's GitHub repository (its origin remote) so every push deploys.
Shipcel adds a workflow to the repository (.github/workflows/shipcel.yml): GitHub
Actions builds each push and deploys it with shipcel deploy, signed in with GitHub's
own token, so no secret is stored and nothing is set up in Cloudflare. Pushes to the
default branch deploy to production; other branches get a preview. git ls says how the
project deploys; git disconnect stops its pushes from deploying.

A repository on GitLab, Bitbucket, Gitea or Forgejo deploys from its own CI instead: the
command links it and writes .gitlab-ci.yml, bitbucket-pipelines.yml or
.gitea/workflows/shipcel.yml for you to commit. A GitLab.com job signs in with GitLab's ID
token (production while the branch is protected); the others with a deploy token from
shipcel tokens add --project.

  --repo <owner/name>    The repository, instead of this folder's remote; on another host,
                         with the host first: gitlab.com/group/project
  --provider <name>      gitlab or gitea, for a host Shipcel can't tell from its name
  --branch <name>        The branch that deploys to production (another host's repository)
  --name <project>       The project to connect it to (created if it doesn't exist)
  --yes, -y              Don't ask before adding the workflow
  --cloudflare-builds    Build with Cloudflare's own builds instead, for containers,
                         queues, routes and Python packages. They need Cloudflare's GitHub
                         app and a build token once per account; Shipcel checks both.
  --build-token <name>   With --cloudflare-builds: the build token, when there are several
  --skip-checks          With --cloudflare-builds: start even if Cloudflare's check says
                         it can't read the repository`,
  promote: `shipcel promote <version|preview url> [--yes]

Sends all production traffic to a version, such as a preview, and publishes the app's
workers.dev address if it wasn't public yet.`,
  rollback: `shipcel rollback [version|preview url] [--yes]

Without a version, production goes back to the most recent earlier version that served
production. Database changes are not undone.`,
  redeploy: `shipcel redeploy [--yes]

Starts a new Cloudflare build of a GitHub project's production branch, at its latest
commit. Projects deployed by upload deploy again with shipcel deploy --prod.`,
  list: `shipcel list | ls [project] [--json]

The 25 newest versions: production ones, previews, and their addresses.`,
  inspect: `shipcel inspect <version|preview url> [--json]

A version's ID, time, traffic, preview address and message.`,
  logs: `shipcel logs [--since 60m] [--errors] [--follow] [--json]

Requests and errors from Workers Logs (needs observability turned on for the Worker).
--since takes minutes, hours or days (5m to 3d). --follow keeps printing new events.`,
  open: `shipcel open [--app]

Opens the project in the Shipcel dashboard, or with --app the app itself.`,
  init: `shipcel init [kit] [folder] [--database]

Creates a project from a starter kit and writes its files to a new folder, linked to
the project. Kits: ${frameworks.map((k) => k.id).join(', ')}.`,
  link: `shipcel link [--project <name|id>] [--yes]

Links this folder (or --cwd) to a project, in .shipcel/project.json. With --yes and no
project, links to (or creates) the project named after the folder.`,
  project: `shipcel project ls
shipcel project add <name> [--framework <kit>]
shipcel project rm <name> [--yes]
shipcel project inspect [name]`,
  remove: `shipcel remove | rm <name> [--yes]

Removes the project from Shipcel. Its Worker, data and domains stay in your Cloudflare
account; delete them there if you no longer need them.`,
  env: `shipcel env ls
shipcel env add | update <NAME>   Reads the value from a prompt or from standard input
shipcel env rm <NAME> [--yes]
shipcel env pull [file]           The variables' names, into .env.local (or .dev.vars)

The app's secrets (Worker secrets). Setting one deploys it with the current code.
Cloudflare never returns a secret's value, so env pull writes each name with an empty
value for you to fill in for local development; build variables that aren't secret come
with their values, and what the file already holds stays. shipcel pull does the same.
With --build, the build variables of a GitHub project instead (--preview for branch
previews' builds, --plain for a value that may be shown).`,
  pull: `shipcel pull [file]

The same as shipcel env pull: the names of the app's variables, written to .env.local
(.dev.vars in a folder with a Wrangler configuration).`,
  dev: `shipcel dev

Runs this project on your computer: its own dev (or start) script when package.json has
one; Wrangler's local runtime for a Worker or a folder of files otherwise.`,
  alias: `shipcel alias ls
shipcel alias set <domain>            The same as shipcel domains add <domain>
shipcel alias set <version> <domain>  The version must be the production one
shipcel alias rm <domain>

A custom domain always serves the app's production version. To put a preview behind a
domain, promote it first: shipcel promote <version>.`,
  crons: `shipcel crons ls
shipcel crons add "<schedule>"    Five fields: minute hour day month weekday, in UTC
shipcel crons rm "<schedule>" [--yes]

Cron schedules (up to five) on which Cloudflare calls the app's scheduled() handler. An
app deployed with a Wrangler configuration that lists triggers.crons gets those on every
deploy instead.`,
  'rolling-release': `shipcel rolling-release status
shipcel rolling-release start --dpl <version|url> [--percent 10]
shipcel rolling-release approve --dpl <version|url> --percent <more>
shipcel rolling-release complete --dpl <version|url>
shipcel rolling-release abort

Moves production to a version gradually: a share of traffic goes to it while the rest
stays on the version that serves now. complete sends everything; abort sends everything
back. Database changes are not undone.`,
  metrics: `shipcel metrics [--since 24h | 7d | 30d] [--json]

Requests, errors, subrequests, response time and CPU time of the app, from Cloudflare's
analytics.`,
  budget: `shipcel budget [--json]
shipcel budget check [--json]

What the app costs this month beyond what Cloudflare includes, estimated from Cloudflare's
analytics, against its budget ($0 unless an owner sets one). Shipcel reads it every five
minutes and alerts in the dashboard and the project's webhook; check reads it now. An
owner sets the budget, and whether going over it pauses the app, in the dashboard.`,
  curl: `shipcel curl [path] [--deployment <version|url>]
shipcel httpstat [path] [--deployment <version|url>]

Requests the app with curl: production, or one version's preview address. httpstat
shows where the time went (DNS, connect, TLS, first byte, total).`,
  api: `shipcel api <path> [--method GET|POST|PUT|PATCH|DELETE] [--data '<json>']

Calls Shipcel's API with your sign-in and prints the answer, for scripts: shipcel api
/projects. Tokens can't manage tokens, connections or billing switches.`,
  mcp: `shipcel mcp [--write] [--json]

Shows how to connect your AI agent (Claude Code, Codex, Cursor) to Shipcel's MCP
server. --write adds it to .mcp.json in this folder. No token is written: the agent reads
it from SHIPCEL_TOKEN.`,
  agent: `shipcel agent init

Adds notes on deploying with Shipcel to AGENTS.md, for coding agents that work in this
folder.`,
  upgrade: `shipcel upgrade [--dry-run] [--yes]

Installs the CLI this Shipcel serves, which is the one that matches it.`,
  switch: `shipcel switch

A sign-in works in one workspace. This signs in again: choose the workspace on the page
that opens.`,
  domains: `shipcel domains ls
shipcel domains add <hostname>    The hostname must be in a Cloudflare zone of the account
shipcel domains rm <hostname> [--yes]`,
  hyperdrive: `shipcel hyperdrive ls [--json]
shipcel hyperdrive add <BINDING>   Reads the connection string from a prompt or standard input
shipcel hyperdrive rm <BINDING> [--yes]

Postgres and MySQL through Cloudflare Hyperdrive, which pools and caches connections from
Workers to a database hosted anywhere (Neon, Supabase, PlanetScale, your own server). The
connection string (postgres://user:password@host:5432/database, or mysql://) goes to
Cloudflare, which keeps the password; Shipcel keeps the binding, host and database name.
add prints the entry to put in wrangler.json(c); your code reads env.<BINDING>.connectionString
(with nodejs_compat in compatibility_flags). Free up to 100,000 queries a day on Cloudflare's
free plan; unlimited on Workers Paid. The database itself is billed by its host.`,
  activity: `shipcel activity [--json]

Projects created, kits exported and projects removed, newest first.`,
  tokens: `shipcel tokens ls [--json]
shipcel tokens add <name> [--expires <days>] [--project <name>] [--json]
shipcel tokens rm <name|prefix> [--yes]

Your API tokens in this workspace, for CI, scripts and AI agents. add opens the page
shipcel login uses: approve the token there, and the terminal shows it once. It expires
after 90 days, or --expires 1 to 365; a token that never expires is made in the dashboard.
--project makes a deploy token, which deploys that project and nothing else, for CI that
signs in with a secret. rm revokes one; revoking the token this computer signs in with signs
it out.`,
  teams: `shipcel teams ls [--json]

The workspaces you belong to, your role in each, and the one this sign-in works in
(shipcel switch signs in to another). Owners make teams and invite people in the dashboard,
under Team.`,
  usage: `shipcel usage [--json]

What each deployed app has cost this month beyond what Cloudflare includes, where it would
end the month, and its budget, from the budget guard's latest readings (every five
minutes). Also the whole Cloudflare account's figure. shipcel budget shows one app's.`,
  alerts: `shipcel alerts [--project <name>] [--all] [--json]

What needs attention, newest first: apps at 50% or 80% of their budget, over it, paused for
it or on course to go over; usage the guard can't read; failed health checks; failed
deploys. The linked project's, or every project's with --all or outside a linked folder.`,
  webhooks: `shipcel webhooks ls [--project <name>] [--all] [--json]

Each project's webhook: where it sends, which events, and how the last delivery went
(workspace owners). Webhooks are added, tested and removed in the dashboard, under Manage →
Notifications: an API token can't send a project's events somewhere new.`,
  bisect: `shipcel bisect --good <version|url> [--bad <version|url>] [--path /api/x]
               [--run "<command>"] [--open]

A binary search through the app's versions, newest bad one by default (the one serving all
of production), for the first bad one. Each version is tried at its own address (its
preview address). In a terminal, say whether each is good; --open opens it in your browser.
With --run, the command decides: it gets the address as SHIPCEL_BISECT_URL and exits 0 for
good, 125 to skip, anything else for bad. Versions of a Worker with a Durable Object have
no address of their own, so they are skipped.`,
  storage: `shipcel storage ls [binding] [prefix] [--json]
shipcel storage get <binding> <key> [file | -]
shipcel storage put <binding> <key> <file> [--yes]   (KV: or --value "text")
shipcel storage rm <binding> <key> [--yes]

The KV namespaces and R2 buckets the app's Worker binds, by binding name (shipcel storage ls
lists them; with only one, the name can be left out). --preview works on the previews'
staging copies. KV takes text up to 1 MB; R2 files up to 25 MB (use Wrangler for larger).
get prints a KV text value, or saves to a file (an R2 object to the key's own name).
Changes are confirmed and recorded with their key, never the value. Alias: shipcel blob.`,
  dns: `shipcel dns ls [domain] [--json]
shipcel dns add <domain> <name> <type> <value> [--ttl 60..86400|auto] [--proxied]
                 [--priority <n>] [--yes]
shipcel dns rm <domain> <record id> [--yes]

The zones of your Cloudflare account, and their DNS records. Types: A, AAAA, CNAME, TXT and
MX (shipcel dns add example.com @ MX 10 mail.example.com). --proxied sends an A, AAAA or
CNAME record through Cloudflare's proxy. A custom domain of a Worker is added with
shipcel domains add instead: Cloudflare manages its record.`,
  cache: `shipcel cache purge [url…] [--yes]

Empties Cloudflare's cache for the app's custom domains: everything, or the URLs given.
Cloudflare's cache belongs to a domain, so a workers.dev address has none to purge; the
app's static files get fresh with every deploy anyway. Needs the Cloudflare connection's
Cache Purge permission, which Cloudflare sign-ins set up from 21 October 2026 ask for.`,
  security: `shipcel security [ls] [--json]
shipcel security managed|bots|ai-bots|under-attack on|off [--yes]
shipcel security block|challenge country <codes…> | ip <addresses…> | path <path> [--yes]
shipcel security rm <rule id> [--yes]
shipcel security rate-limit <path> <requests> | off [--yes]

Cloudflare's free firewall for the zones of the app's custom domains. Cloudflare's DDoS
protection covers every app, workers.dev addresses included; a firewall belongs to a
domain's zone, so it needs a custom domain (shipcel domains add).

  managed       Cloudflare's Free Managed Ruleset, against widely exploited flaws
  bots          Bot Fight Mode: challenges known bots (API clients and apps too)
  ai-bots       Blocks AI crawlers and scrapers
  under-attack  Under Attack mode: every visitor gets a challenge page first

These cover every host name in the zone. A rule blocks or challenges countries (CN,RU),
IP addresses or ranges, or a path and everything below it, on the app's own host names
only; Cloudflare's Free plan allows 5 rules per zone. A rate limit blocks a visitor (an IP
address) for 10 seconds after more than <requests> requests in 10 seconds to a path and
everything below it, on every host name in the zone (Free allows 1 per zone). Only what
this app made is changed or removed. Needs the Cloudflare connection's Zone WAF, Bot
Management and Zone Settings permissions, which sign-ins set up from 23 October 2026 ask
for.`,
  redirects: `shipcel redirects ls [--json]
shipcel redirects add /from /to [--status 301|302|303|307|308]
shipcel redirects rm /from
  [--file <path>]

The app's _redirects file, which Workers reads from its static files: public/_redirects or
static/_redirects in most frameworks, or the folder's own for a folder of files. Up to
2,000 static and 100 dynamic redirects (with * or :name). They apply to static files from
the next deploy, not to requests the app's code answers.`,
  pricing: `shipcel pricing [word] [--json]

Shipcel's Free plan and Cloudflare's Workers Free and Workers Paid, with the list prices
and limits the site's /pricing/ shows. A word narrows it down: shipcel pricing d1.`,
  login: `shipcel login [--url <shipcel address>]

Opens Shipcel in your browser and shows a code. Sign in with GitHub there if you aren't
yet, check the code and approve; if Cloudflare isn't connected, the same page connects it.
The token is kept in ~/.config/shipcel/config.json, readable only by you. It signs in to
https://shipcel.com; for a Shipcel you run yourself, give its address once with --url.`,
  publish: `shipcel publish | unpublish [--project <name|id>]

Turns the app's public workers.dev address on or off. Previews keep working either way.`,
};
const ALIASES: Record<string, string> = {
  ls: 'list',
  rm: 'remove',
  unpublish: 'publish',
  logout: 'login',
  whoami: 'login',
  projects: 'project',
  create: 'project',
  versions: 'list',
  rr: 'rolling-release',
  analytics: 'metrics',
  httpstat: 'curl',
  teams: 'switch',
  signup: 'login',
};

async function signedIn(io: Io, args: Args) {
  const config = await readConfig(io);
  const url = baseUrl(io, config, args.flags.url, args.flags.token);
  const token =
    text(args.flags.token) ??
    io.env.SHIPCEL_TOKEN ??
    io.env.CLOUDCEL_TOKEN ??
    config.token;
  if (token) return client(io, url, token);
  if (!io.isTTY)
    throw new CliError(
      'Not signed in. In CI, set SHIPCEL_TOKEN to an API token from the dashboard (API & CLI).',
    );
  io.out('You are not signed in yet.');
  await login(io, args, false);
  return client(io, url, (await readConfig(io)).token);
}

// In GitHub Actions without a token: the workflow shipcel git connect adds lets the run ask
// GitHub for a token that names it (permissions: id-token: write), which Shipcel exchanges for
// one that deploys the linked project for an hour (worker/github-actions.ts). The deploy goes
// where the branch goes: production for the production branch, a preview for any other.
type ActionsRun = {
  token: string;
  project: Project;
  repository: string;
  branch: string;
  target: 'production' | 'preview';
};
// A GitLab.com job does the same with the ID token its job gives it (SHIPCEL_ID_TOKEN, made for
// Shipcel's address), exchanged by worker/git-sources.ts.
async function gitlabSignIn(io: Io, url: string, project: string | undefined) {
  const oidc = io.env.SHIPCEL_ID_TOKEN;
  if (!oidc)
    throw new CliError(
      'This GitLab job can’t sign in to Shipcel: give it an ID token named SHIPCEL_ID_TOKEN with Shipcel’s address as its audience (the job shipcel git connect adds has it), or set SHIPCEL_TOKEN to a deploy token.',
    );
  if (!project)
    throw new CliError(
      'This GitLab job names no project: deploy with --project <id>, as the job shipcel git connect adds does.',
    );
  return client(io, url).raw('/git-sources/token', { token: oidc, project });
}
async function actionsSignIn(io: Io, args: Args) {
  const gitlab = io.env.GITLAB_CI === 'true';
  if (io.env.GITHUB_ACTIONS !== 'true' && !gitlab) return null;
  const config = await readConfig(io);
  if (
    text(args.flags.token) ??
    io.env.SHIPCEL_TOKEN ??
    io.env.CLOUDCEL_TOKEN ??
    config.token
  )
    return null;
  if (gitlab) {
    const url = baseUrl(io, config, args.flags.url);
    return ciRun(
      io,
      args,
      url,
      'GitLab CI',
      await gitlabSignIn(io, url, text(args.flags.project)),
    );
  }
  const requestUrl = io.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = io.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken)
    throw new CliError(
      'This GitHub Actions job can’t sign in to Shipcel: give its workflow permissions: id-token: write (the workflow shipcel git connect adds has it), or set SHIPCEL_TOKEN to an API token.',
    );
  const url = baseUrl(io, config, args.flags.url);
  let oidc: unknown = null;
  try {
    const ask = new URL(requestUrl);
    ask.searchParams.set('audience', url);
    const response = await io.fetch(ask.href, {
      headers: { Authorization: `Bearer ${requestToken}` },
    });
    if (response.ok)
      oidc = ((await response.json()) as { value?: unknown }).value;
  } catch {
    /* Said below. */
  }
  if (typeof oidc !== 'string')
    throw new CliError(
      'GitHub didn’t give this run its sign-in token. Re-run the job.',
    );
  return ciRun(
    io,
    args,
    url,
    'GitHub Actions',
    await client(io, url).raw('/github-actions/token', { token: oidc }),
  );
}
async function ciRun(
  io: Io,
  args: Args,
  url: string,
  ci: string,
  { status, data }: { status: number; data: Record<string, unknown> },
) {
  if (status !== 201)
    throw new CliError(
      typeof data.error === 'string'
        ? data.error
        : `Shipcel answered ${status}.`,
    );
  const run = data as unknown as ActionsRun;
  if (!args.flags.json)
    io.out(
      `${ci}: deploying ${run.branch} of ${run.repository} to ${run.project.name}, ${run.target === 'production' ? 'in production' : 'as a preview'}.`,
    );
  const deploying: Args = {
    ...args,
    flags: {
      ...args.flags,
      project: run.project.id,
      target: run.target,
      prod: false,
      publish: false,
      yes: true,
    },
  };
  return { api: client(io, url, run.token), args: deploying };
}

// Account ----------------------------------------------------------------------------

type Connections = {
  github: {
    configured: boolean;
    connected: boolean;
    installUrl: string | null;
  };
  cloudflare: {
    configured: boolean;
    connected: boolean;
    account: { id: string; name: string } | null;
  };
  nativeBuildsEnabled: boolean;
};
type Me = { login: string; role: string; workspaceName?: string | null };

// The page that finishes setup in the browser: signing in, connecting Cloudflare, choosing
// the account and its workers.dev address.
const setupPage = (api: Client) => `${api.url}/app/#cli-setup`;

// Asks again every few seconds, for up to ten minutes, until `check` has an answer.
async function waitFor<T>(io: Io, check: () => Promise<T | null>, seconds = 3) {
  for (let attempt = 0; attempt < 600 / seconds; attempt++) {
    await io.sleep(seconds * 1000);
    const result = await check();
    if (result !== null) return result;
  }
  return null;
}

// Something the person does once in their browser while the command waits: `check` says
// whether it's done; if not, the CLI explains, opens the page and carries on by itself when
// it is. Without a terminal it stops with what to do.
async function need<T>(
  io: Io,
  args: Args,
  step: {
    check: () => Promise<T | null>;
    todo: string[];
    url: string | null;
    waiting: string;
    done?: (result: T) => string;
    // The browser already shows the page (shipcel login's own tab).
    open?: boolean;
    seconds?: number;
  },
  // What the caller already knows, instead of checking first.
  known?: T | null,
) {
  const now = known === undefined ? await step.check() : known;
  if (now !== null) return now;
  if (!io.isTTY || args.flags.json)
    throw new CliError(
      [...step.todo, 'Then run the command again.'].join('\n'),
    );
  for (const line of step.todo) io.out(line);
  if (step.url && step.open !== false) await io.open(step.url).catch(() => {});
  io.out(`${step.waiting} (Ctrl+C stops; nothing is lost.)`);
  const result = await waitFor(io, step.check, step.seconds);
  if (result === null)
    throw new CliError(
      `Still waiting after ten minutes.${step.url ? ` Finish at ${step.url}, then` : ' Then'} run the command again.`,
    );
  if (step.done) io.out(step.done(result));
  return result;
}

// Cloudflare connected, with the account apps deploy to. In a terminal, a missing connection
// is finished in the browser while the command waits.
async function cloudflareReady(io: Io, api: Client, args: Args, open = true) {
  const read = () => api.call<Connections>('/connections');
  const usable = (c: Connections) =>
    c.cloudflare.connected && c.cloudflare.account ? c : null;
  const first = await read();
  if (usable(first)) return first;
  const page = setupPage(api);
  // Connected, but to several accounts and none chosen yet: the page lists them.
  const verb = first.cloudflare.connected ? 'Choose' : 'Connect';
  if (io.isTTY && !args.flags.json) {
    const me = await api.call<Me>('/me');
    if (me.role !== 'owner')
      throw new CliError(
        'This workspace has no Cloudflare account connected yet. Ask one of its owners to connect it.',
      );
  }
  return need(
    io,
    args,
    {
      check: async () => usable(await read()),
      todo: [
        first.cloudflare.connected
          ? 'Your Cloudflare connection reaches several accounts, and none is chosen for your apps yet.'
          : 'Shipcel deploys into your own Cloudflare account, and it isn’t connected yet.',
        open
          ? `${verb} it in your browser: ${page}`
          : `${verb} it in the browser tab that’s open (or visit ${page}).`,
      ],
      url: page,
      open,
      waiting: 'Waiting for Cloudflare…',
      done: (c) => `Connected Cloudflare: ${c.cloudflare.account!.name}.`,
      seconds: 2,
    },
    null,
  );
}

// After a sign-in: who the CLI acts as, and whether the workspace can deploy yet. `next`:
// shipcel login was run by itself, so it says what to do next.
async function welcome(io: Io, api: Client, args: Args, next: boolean) {
  const me = await api.call<Me>('/me').catch(() => null);
  io.out(
    me
      ? `Signed in as ${me.login}${me.workspaceName ? ` in ${me.workspaceName}` : ''}.`
      : 'Signed in.',
  );
  io.out(`The token is saved in ${join(configDir(io), 'config.json')}.`);
  try {
    const connections = await api.call<Connections>('/connections');
    const account = connections.cloudflare.connected
      ? connections.cloudflare.account
      : null;
    if (account) io.out(`Cloudflare: connected to ${account.name}.`);
    else if (io.isTTY) await cloudflareReady(io, api, args, false);
    else
      io.out(
        `Cloudflare isn’t connected yet. Connect it once in your browser: ${setupPage(api)}`,
      );
    if (!connections.nativeBuildsEnabled)
      io.out(
        'Deployments are switched off on this Shipcel. Its operator turns them on with NATIVE_BUILDS_ENABLED=true.',
      );
  } catch (error) {
    // Signing in worked; what is left can be finished later.
    io.out(error instanceof Error ? error.message : String(error));
  }
  if (next) io.out('Next: run shipcel in your project’s folder to deploy it.');
}

async function login(io: Io, args: Args, standalone = true) {
  const config = await readConfig(io);
  const url = baseUrl(io, config, args.flags.url);
  const data = await browserApproval(
    io,
    client(io, url),
    { host: io.hostname.slice(0, 64) },
    {
      approve: 'approve',
      denied: 'Sign-in was denied in the browser.',
      expired: 'The sign-in code expired. Run shipcel login again.',
    },
  );
  const token = data.token as string;
  await writeConfig(io, { url, token });
  await welcome(io, client(io, url, token), args, standalone);
}

// Projects ----------------------------------------------------------------------------

// .shipcel/project.json: the project a folder deploys to, and how the folder builds. A
// folder linked before Cloudcel became Shipcel keeps its .cloudcel/project.json.
async function linkDir(io: Io, dir: string) {
  return !(await io.fs.exists(join(dir, '.shipcel', 'project.json'))) &&
    (await io.fs.exists(join(dir, '.cloudcel', 'project.json')))
    ? join(dir, '.cloudcel')
    : join(dir, '.shipcel');
}
const linkPath = async (io: Io, dir: string) =>
  join(await linkDir(io, dir), 'project.json');
type Link = { projectId?: string; name?: string; settings?: Settings };
const command = (value: unknown) =>
  value === null || (typeof value === 'string' && value.trim() !== '');
// Settings are read back from a file people can edit: anything malformed is detected again.
function savedSettings(value: unknown): Settings | undefined {
  const v = value as Partial<Settings> | null;
  return v &&
    typeof v === 'object' &&
    typeof v.preset === 'string' &&
    command(v.installCommand) &&
    command(v.buildCommand) &&
    typeof v.outputDirectory === 'string' &&
    outputDirectory(v.outputDirectory) === v.outputDirectory &&
    typeof v.spa === 'boolean'
    ? {
        preset: v.preset,
        installCommand: v.installCommand!,
        buildCommand: v.buildCommand!,
        outputDirectory: v.outputDirectory,
        spa: v.spa,
      }
    : undefined;
}
async function readLink(io: Io, dir = io.cwd): Promise<Link> {
  try {
    const link = JSON.parse(
      decode(await io.fs.readFile(await linkPath(io, dir))),
    );
    return {
      ...(typeof link.projectId === 'string'
        ? { projectId: link.projectId }
        : {}),
      ...(typeof link.name === 'string' ? { name: link.name } : {}),
      settings: savedSettings(link.settings),
    };
  } catch {
    return {};
  }
}
async function writeLink(io: Io, dir: string, link: Link) {
  const folder = await linkDir(io, dir);
  const file = join(folder, 'project.json');
  const fresh = !(await io.fs.exists(file));
  await io.fs.mkdir(folder);
  await io.fs.writeFile(file, `${JSON.stringify(link, null, 2)}\n`);
  return fresh && (await ignoreLink(io, dir));
}
const linkedProject = async (io: Io) => (await readLink(io)).projectId ?? null;

// Like Vercel's .vercel: the link holds IDs from one person's workspace, so in a Git
// repository it is kept out of commits. True when .gitignore was changed.
async function ignoreLink(io: Io, dir: string) {
  if ((await gitConfig(io, dir)) === null) return false;
  const path = join(dir, '.gitignore');
  const current = (await io.fs.exists(path))
    ? decode(await io.fs.readFile(path))
    : '';
  if (current.split(/\r?\n/).some((l) => /^\/?\.shipcel\/?$/.test(l.trim())))
    return false;
  await io.fs.writeFile(
    path,
    `${current}${current && !current.endsWith('\n') ? '\n' : ''}.shipcel\n`,
  );
  return true;
}
async function findProject(api: Client, wanted: string) {
  const projects = await api.call<Project[]>('/projects');
  const found = projects.find((p) => p.id === wanted || p.name === wanted);
  if (!found)
    throw new CliError(
      `No project ${wanted} in your workspace. Run shipcel project ls to see them.`,
    );
  return found;
}
async function resolveProject(io: Io, api: Client, args: Args, named?: string) {
  const wanted = named ?? text(args.flags.project) ?? (await linkedProject(io));
  return wanted ? findProject(api, wanted) : null;
}
async function requireProject(io: Io, api: Client, args: Args, named?: string) {
  const project = await resolveProject(io, api, args, named);
  if (!project)
    throw new CliError(
      'No project is linked to this folder. Run shipcel link, or pass --project <name>.',
    );
  return project;
}
// Links a folder to a project, keeping how the folder builds. True when .gitignore changed.
async function link(
  io: Io,
  project: Project,
  dir = io.cwd,
  settings?: Settings,
) {
  const kept = settings ?? (await readLink(io, dir)).settings;
  return writeLink(io, dir, {
    projectId: project.id,
    name: project.name,
    ...(kept ? { settings: kept } : {}),
  });
}
const ignored = 'Added .shipcel to .gitignore.';

// Files -------------------------------------------------------------------------------

// .shipcelignore: one pattern per line, # for comments, * matches within a path segment,
// ** across segments, a leading / anchors to the folder, a trailing / matches folders.
export function ignoreMatcher(text: string) {
  const rules = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((pattern) => {
      const anchored = pattern.startsWith('/');
      const folder = pattern.endsWith('/');
      const body = pattern.replace(/^\//, '').replace(/\/$/, '');
      const source = body
        .split('**')
        .map((part) =>
          part
            .split('*')
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*'),
        )
        .join('.*');
      return new RegExp(
        `${anchored ? '^/' : '(^|/)'}${source}${folder ? '/' : '(/|$)'}`,
      );
    });
  return (path: string) => rules.some((r) => r.test(path));
}

type Found = { path: string; full: string; size: number };
async function collect(io: Io, root: string) {
  // .shipcelignore, or .cloudcelignore, its name before Cloudcel became Shipcel.
  const ignoreFile = (await io.fs.exists(join(root, '.shipcelignore')))
    ? join(root, '.shipcelignore')
    : join(root, '.cloudcelignore');
  const ignoreText = (await io.fs.exists(ignoreFile))
    ? new TextDecoder().decode(await io.fs.readFile(ignoreFile))
    : '';
  const ignored = ignoreMatcher(ignoreText);
  const files: Found[] = [];
  let skipped = 0;
  async function walk(dir: string, prefix: string) {
    for (const entry of await io.fs.readdir(dir)) {
      const path = `${prefix}/${entry.name}`;
      const hidden =
        entry.name.startsWith('.') &&
        !(prefix === '' && entry.name === '.well-known');
      if (
        entry.name === 'node_modules' ||
        hidden ||
        ignored(path + (entry.dir ? '/' : ''))
      ) {
        skipped++;
        continue;
      }
      if (entry.dir) await walk(join(dir, entry.name), path);
      else if (entry.file)
        files.push({
          path,
          full: join(dir, entry.name),
          size: await io.fs.size(join(dir, entry.name)),
        });
    }
  }
  await walk(root, '');
  return { files, skipped };
}

// Git ---------------------------------------------------------------------------------

// The Git configuration of the repository a folder is in: .git/config here or in a folder
// above; for a worktree or submodule, the configuration its .git file points to.
async function gitConfig(io: Io, from: string): Promise<string | null> {
  const read = (path: string) => io.fs.readFile(path).then(decode, () => null);
  for (let dir = from, depth = 0; dir && depth < 40; depth++) {
    const dot = join(dir, '.git');
    if (await io.fs.exists(dot)) {
      const config = await read(join(dot, 'config'));
      if (config !== null) return config;
      const pointer = /^gitdir:\s*(.+)$/m.exec((await read(dot)) ?? '')?.[1];
      if (!pointer) return null;
      const gitDir = resolve(dir, pointer.trim());
      const common = await read(join(gitDir, 'commondir'));
      return read(
        join(common ? resolve(gitDir, common.trim()) : gitDir, 'config'),
      );
    }
    const up = parent(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// The repositories on other Git hosts this folder's remotes name, origin first.
async function otherRemotes(io: Io) {
  return parseRemotes((await gitConfig(io, io.cwd)) ?? '')
    .flatMap((remote) => {
      const repository = remoteRepository(remote.url);
      return repository && !githubRepository(remote.url)
        ? [{ name: remote.name, repository }]
        : [];
    })
    .sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
}

// The GitHub repositories this folder's remotes name, origin first.
async function githubRemotes(io: Io) {
  return parseRemotes((await gitConfig(io, io.cwd)) ?? '')
    .flatMap((remote) => {
      const repository = githubRepository(remote.url);
      return repository ? [{ name: remote.name, repository }] : [];
    })
    .sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
}

// Build -------------------------------------------------------------------------------

async function projectFiles(io: Io, dir: string) {
  const files: Record<string, string | null> = {};
  for (const name of detectionFiles) {
    const path = join(dir, name);
    files[name] = !(await io.fs.exists(path))
      ? null
      : readInFull(name)
        ? decode(await io.fs.readFile(path))
        : 'present';
  }
  return files;
}

const unknownOutput =
  'Shipcel doesn’t recognise how this project builds. Say where its build goes: shipcel deploy --output <folder>.';
// `review`: detected just now, so it is shown, and can be changed, before it's used.
type Plan = { settings: Settings; review: boolean; note?: string };

// How this project folder builds: what an earlier run saved, or what its files say. Null
// when there is nothing to build, so the folder deploys as it is. --build-command and
// --output change either.
async function buildPlan(io: Io, args: Args): Promise<Plan | null> {
  const buildFlag = text(args.flags['build-command']);
  const outputFlag = text(args.flags.output);
  const output =
    outputFlag === undefined ? undefined : outputDirectory(outputFlag);
  if (output === null)
    throw new CliError(
      '--output takes a folder inside the project, such as dist.',
      2,
    );
  const flags = {
    ...(output ? { outputDirectory: output } : {}),
    ...(buildFlag === undefined
      ? {}
      : { buildCommand: buildFlag.trim() || null }),
  };
  const saved = (await readLink(io)).settings;
  if (saved) return { settings: { ...saved, ...flags }, review: false };
  const found = detect(await projectFiles(io, io.cwd));
  if (found.kind === 'problem') throw new CliError(found.message);
  if (found.kind === 'none') {
    if (!output && buildFlag === undefined) return null;
    if (!output)
      throw new CliError('Say where the build goes too: --output <folder>.', 2);
    return {
      settings: {
        preset: 'Other',
        installCommand: null,
        buildCommand: null,
        spa: false,
        outputDirectory: output,
        ...flags,
      },
      review: false,
    };
  }
  const settings = { ...found.settings, ...flags };
  // Nobody to ask where the build goes: stop before a project is created for it.
  if (
    !settings.outputDirectory &&
    (!io.isTTY || args.flags.yes || args.flags.json)
  )
    throw new CliError(unknownOutput);
  return {
    settings,
    review: true,
    ...(found.kind === 'other' && found.note ? { note: found.note } : {}),
  };
}

// Shows what was detected and lets the person change it, like Vercel's "Customize
// settings?". An output folder Shipcel couldn't work out has to be named.
async function reviewSettings(io: Io, args: Args, plan: Plan) {
  let settings = plan.settings;
  if (!plan.review || !io.isTTY || args.flags.yes || args.flags.json) {
    if (!settings.outputDirectory) throw new CliError(unknownOutput);
    return settings;
  }
  const summary = `Build Command: ${settings.buildCommand ?? 'none'}${settings.outputDirectory ? `, Output Directory: ${settings.outputDirectory}` : ''}`;
  io.out(
    settings.preset === 'Other'
      ? `No framework detected (${summary})`
      : `Detected ${settings.preset} (${summary})`,
  );
  if (plan.note) io.out(plan.note);
  const askOutput = async (suggested: string) => {
    const answer =
      (
        await io.ask(`Output Directory${suggested ? ` [${suggested}]` : ''}: `)
      ).trim() || suggested;
    const dir = outputDirectory(answer);
    if (!dir)
      throw new CliError(
        'The output directory is a folder inside the project, such as dist.',
      );
    return dir;
  };
  if (!settings.outputDirectory) {
    let guess = '';
    for (const name of ['dist', 'build', 'out', 'public', '_site'])
      if (!guess && (await io.fs.exists(join(io.cwd, name)))) guess = name;
    settings = { ...settings, outputDirectory: await askOutput(guess) };
  }
  if (yes(await io.ask('Customize settings? [y/N] '), false)) {
    const typed = async (label: string, current: string | null) => {
      const answer = (
        await io.ask(`${label} [${current ?? 'none'}] (- for none): `)
      ).trim();
      return answer === '-' ? null : answer || current;
    };
    settings = {
      ...settings,
      installCommand: await typed('Install Command', settings.installCommand),
      buildCommand: await typed('Build Command', settings.buildCommand),
      outputDirectory: await askOutput(settings.outputDirectory),
    };
  }
  return settings;
}

// Installs dependencies when the project has none yet, then runs the build. Their output
// goes to the terminal; a failure stops the command.
async function build(
  io: Io,
  args: Args,
  settings: Settings,
  failed = '',
  types: string | null = null,
) {
  const step = async (title: string, line: string, install = false) => {
    if (!args.flags.json) io.out(`${title}: ${line}`);
    const code = await io.run(line, io.cwd);
    if (code !== 0)
      throw new CliError(
        `${install ? installFailed(line, code) : `${line} failed (exit code ${code}).`}${failed}`,
      );
  };
  if (
    settings.installCommand &&
    (await io.fs.exists(join(io.cwd, 'package.json'))) &&
    !(await io.fs.exists(join(io.cwd, 'node_modules')))
  )
    await step('Installing dependencies', settings.installCommand, true);
  if (!settings.buildCommand) return;
  if (types) {
    if (!args.flags.json) io.out(`Generating types: ${types}`);
    if (
      (await io.run(types, io.cwd, setupEnv(), true)) !== 0 &&
      !args.flags.json
    )
      io.out(
        `  Note: ${types} didn’t finish. If the build asks for generated types, run it yourself.`,
      );
  }
  await step('Building', settings.buildCommand);
}

// A build that checks the types Wrangler generates (SvelteKit's adapter makes it `wrangler
// types --check && vite build`) fails once they are stale, and they go stale as soon as a
// first build has written the app's entry point. So they are made again just before each
// such build, by the project's own script for it.
function typesCommand(files: Record<string, string | null | undefined>) {
  const manifest = files['package.json']
    ? parseManifest(files['package.json'])
    : null;
  const scripts = manifest?.scripts ?? {};
  if (!/\bwrangler types --check\b/.test(scripts.build ?? '')) return null;
  const script = ['cf-typegen', 'gen'].find(
    (name) => scripts[name]?.trim() === 'wrangler types',
  );
  return script
    ? `${packageManager(files, manifest ?? undefined)} run ${script}`
    : null;
}

async function buildOnly(io: Io, args: Args) {
  const app = await appIn(io, args);
  if (app) {
    if (app.kind === 'server')
      throw new CliError(
        `This is a ${app.framework} app without its Cloudflare adapter yet. Run shipcel to set it up and deploy it, or set it up yourself: npx wrangler@${WRANGLER_VERSION} setup.`,
      );
    const files = await projectFiles(io, io.cwd);
    const manifest = files['package.json']
      ? parseManifest(files['package.json'])
      : null;
    const manager = packageManager(files, manifest ?? undefined);
    const flag = text(args.flags['build-command']);
    const command =
      flag === undefined
        ? appBuildCommand(manifest, manager)
        : flag.trim() || null;
    await build(
      io,
      args,
      {
        preset: 'Wrangler',
        installCommand: `${manager} install`,
        buildCommand: command,
        outputDirectory: '.',
        spa: false,
      },
      '',
      typesCommand(files),
    );
    io.out(
      command
        ? 'Built. Deploy it with shipcel deploy --prebuilt.'
        : 'Nothing to build: Wrangler bundles this app when it deploys.',
    );
    return;
  }
  const plan = await buildPlan(io, args);
  if (!plan)
    throw new CliError(
      'There is nothing to build here: this folder has no package.json with a build script. Upload built files with shipcel deploy <folder>.',
    );
  const settings = await reviewSettings(io, args, plan);
  if (await writeLink(io, io.cwd, { ...(await readLink(io)), settings }))
    io.out(ignored);
  await build(io, args, settings);
  io.out(
    settings.buildCommand
      ? `Built ${settings.outputDirectory}. Deploy it with shipcel deploy --prebuilt.`
      : `Nothing to build: ${settings.outputDirectory} deploys as it is.`,
  );
}

// Deploy ------------------------------------------------------------------------------

type Deployed = {
  workerName: string;
  versionId: string;
  previewUrl: string | null;
  url: string | null;
  published: boolean;
  preview: boolean;
  productionUrl: string | null;
  // Why the version has no preview address, when Cloudflare gives it none.
  previewNote?: string;
};

// The project a new link points to: an existing one, or the name of one to create. In a
// terminal this asks, like Vercel's set-up; --yes takes the folder's name.
async function chooseProject(
  io: Io,
  api: Client,
  args: Args,
  root: string,
): Promise<{ project: Project } | { name: string }> {
  const name = projectName(
    text(args.flags.name) ?? root.split(/[\\/]/).filter(Boolean).pop() ?? '',
  );
  const projects = await api.call<Project[]>('/projects');
  const named = (wanted: string) => projects.find((p) => p.name === wanted);
  const existing = (project: Project) => {
    io.out(`Linked to the existing project ${project.name}.`);
    return { project };
  };
  let wanted = name;
  if (!args.flags.yes && !args.flags.create) {
    if (!io.isTTY)
      throw new CliError(
        'No project is linked here. Pass --project <name>, or --yes to create one named after the folder.',
      );
    if (!yes(await io.ask(`Set up and deploy “${root}”? [Y/n] `), true))
      throw new CliError('Nothing was deployed.');
    const same = named(name);
    if (same) {
      if (
        yes(
          await io.ask(`Found project “${same.name}”. Link to it? [Y/n] `),
          true,
        )
      )
        return existing(same);
    } else if (
      projects.length &&
      yes(await io.ask('Link to existing project? [y/N] '), false)
    ) {
      io.out(`Your projects: ${projects.map((p) => p.name).join(', ')}`);
      const answer = (await io.ask('Existing project name? ')).trim();
      const found = named(answer);
      if (!found)
        throw new CliError(
          `No project ${answer} in your workspace. Nothing was deployed.`,
        );
      return existing(found);
    }
    wanted =
      (
        await io.ask(same ? 'Project name: ' : `Project name [${name}]: `)
      ).trim() || (same ? '' : name);
    if (!wanted)
      throw new CliError('A new project needs a name. Nothing was deployed.');
  }
  const found = named(wanted);
  return found ? existing(found) : { name: wanted };
}
async function createProject(
  io: Io,
  api: Client,
  name: string,
  framework = 'static',
) {
  const project = await api.call<Project>('/projects', {
    method: 'POST',
    body: { name, framework },
  });
  io.out(`Created the project ${project.name}.`);
  return project;
}
async function setUp(io: Io, api: Client, args: Args, root: string) {
  const choice = await chooseProject(io, api, args, root);
  return 'project' in choice
    ? choice.project
    : createProject(io, api, choice.name);
}

// The project this folder deploys to: the linked one, or one chosen or created now. In a
// project's own folder with a GitHub remote, a new project can deploy from GitHub instead,
// as Vercel offers: then `git connect` does the deploying and this returns null.
async function projectFor(
  io: Io,
  api: Client,
  args: Args,
  root: string,
  offerGit: boolean,
  // The runtime a new project is recorded with.
  framework = 'static',
) {
  const linked = await resolveProject(io, api, args);
  if (linked) return linked;
  const choice = await chooseProject(io, api, args, root);
  if ('project' in choice) return choice.project;
  if (
    offerGit &&
    io.isTTY &&
    !args.flags.yes &&
    !args.flags.create &&
    !args.flags.json
  ) {
    const [remote] = await githubRemotes(io);
    if (
      remote &&
      yes(
        await io.ask(
          `Connect ${remote.repository} so every push deploys, built by GitHub Actions? [y/N] `,
        ),
        false,
      )
    ) {
      await gitConnect(io, api, args, {
        name: choice.name,
        repository: remote.repository,
      });
      return null;
    }
  }
  return createProject(io, api, choice.name, framework);
}

// A project deploys one way. One that Cloudflare builds from GitHub isn't uploaded to; one set
// up for GitHub that hasn't deployed yet can still start from this computer, which is a
// choice the person confirms: after it, the project deploys from here.
async function deploysFromHere(
  io: Io,
  api: Client,
  args: Args,
  project: Project,
) {
  const job = await production(api, project);
  if (job && job.adapter !== 'direct-upload')
    throw new CliError(
      `${project.name} deploys from GitHub (${job.repository_name}, ${job.branch}): push to deploy it, or run shipcel redeploy.`,
    );
  if (!job && project.source === 'github')
    await confirmed(
      io,
      args,
      `${project.name} is set up to deploy ${project.repository?.replace('https://github.com/', '') ?? 'a repository'} from GitHub and hasn’t yet. Deploy it from this computer instead? It then stays a project you deploy from here.`,
    );
}

async function deploy(io: Io, given: Args) {
  const actions = await actionsSignIn(io, given);
  const args = actions?.args ?? given;
  const api = actions?.api ?? (await signedIn(io, args));
  const folder = args._[1] ?? '.';
  const here = /^\.\/*$/.test(folder);
  let root = here ? io.cwd : resolve(io.cwd, folder);
  if (!(await io.fs.exists(root)))
    throw new CliError(`${folder} does not exist.`);
  const say = (line: string) => {
    if (!args.flags.json) io.out(line);
  };
  let project: Project | null = null;
  let settings: Settings | null = null;
  // An app with code or bindings: Wrangler deploys it, through Shipcel.
  const app = here ? await appIn(io, args) : null;
  if (app) return deployApp(io, args, api, app);
  // This folder is a project: build it here, then deploy what the build wrote.
  const plan = here ? await buildPlan(io, args) : null;
  if (plan) {
    await cloudflareReady(io, api, args);
    project = await projectFor(io, api, args, root, true);
    if (!project) return;
    await deploysFromHere(io, api, args, project);
    settings = await reviewSettings(io, args, plan);
    if (await link(io, project, io.cwd, settings)) say(ignored);
    if (!args.flags.prebuilt)
      await build(io, args, settings, ' Nothing was deployed.');
    root =
      settings.outputDirectory === '.'
        ? io.cwd
        : join(io.cwd, settings.outputDirectory);
    if (!(await io.fs.exists(root)))
      throw new CliError(
        args.flags.prebuilt
          ? `${settings.outputDirectory} doesn’t exist yet. Build first: shipcel build.`
          : `The build finished, but ${settings.outputDirectory} doesn’t exist. Say which folder your build writes: shipcel deploy --output <folder>.`,
      );
  } else if (!here && detect(await projectFiles(io, root)).kind !== 'none')
    throw new CliError(
      `${folder} is a project’s source, not built files. Build and deploy it from its own folder: shipcel --cwd ${folder}`,
    );
  const shown = settings ? settings.outputDirectory : folder;
  const { files, skipped } = await collect(io, root);
  const special = (name: string) => files.find((f) => f.path === `/${name}`);
  const assets = files.filter(
    (f) => !['/_worker.js', '/_redirects', '/_headers'].includes(f.path),
  );
  if (!assets.length && !special('_worker.js'))
    throw new CliError(`${shown} has no files to deploy.`);
  if (
    !assets.some((f) => f.path === '/index.html') &&
    !special('_worker.js') &&
    !args.flags.yes
  ) {
    if (settings)
      throw new CliError(
        `${shown} has no index.html. If your build writes somewhere else, say so: shipcel deploy --output <folder>. Pass --yes to deploy it anyway.`,
      );
    const candidates = [];
    for (const name of ['dist', 'build', 'out', 'public', '_site'])
      if (await io.fs.exists(join(root, name, 'index.html')))
        candidates.push(name);
    throw new CliError(
      `${folder} has no index.html.${candidates.length ? ` Did you mean: shipcel deploy ${folder === '.' ? candidates[0] : join(folder, candidates[0])}?` : ''} Pass --yes to deploy it anyway.`,
    );
  }
  const problems: string[] = [];
  if (assets.length > MAX_FILES)
    problems.push(`Up to ${MAX_FILES} files can be deployed.`);
  for (const f of assets) {
    const problem = assetPathProblem(f.path);
    if (problem) problems.push(`${f.path} ${problem}.`);
    if (f.size > MAX_FILE_BYTES)
      problems.push(`${f.path} is larger than 24 MB.`);
  }
  if ((special('_worker.js')?.size ?? 0) > MAX_WORKER_BYTES)
    problems.push('_worker.js is larger than 1 MB.');
  for (const name of ['_redirects', '_headers'])
    if ((special(name)?.size ?? 0) > MAX_RULES_BYTES)
      problems.push(`${name} is larger than 64 KB.`);
  if (problems.length) throw new CliError(problems.slice(0, 10).join('\n'));

  if (!project) {
    await cloudflareReady(io, api, args);
    project = await projectFor(io, api, args, root, here);
    if (!project) return;
    await deploysFromHere(io, api, args, project);
    if (await link(io, project)) say(ignored);
  }
  // A new app's first deploy is its production deploy, as on Vercel; after that a deploy
  // is a preview unless --prod (or --target) says otherwise.
  const first = !(await production(api, project));
  const target = wantedTarget(args);
  const prod = target ? target === 'production' : first;

  const encoded = async (f: Found) => toBase64(await io.fs.readFile(f.full));
  const prepared: (Found & { hash: string })[] = [];
  for (const f of assets)
    prepared.push({ ...f, hash: assetHash(await encoded(f), f.path) });
  const upload = await api.call<{
    uploadId: string;
    workerName: string;
    missing: string[];
    maxRequestBytes: number;
  }>(`/projects/${project.id}/uploads`, {
    method: 'POST',
    body: {
      files: prepared.map(({ path, hash, size }) => ({ path, hash, size })),
      ...(text(args.flags.name) ? { workerName: args.flags.name } : {}),
    },
  });
  const byHash = new Map(prepared.map((f) => [f.hash, f]));
  const needed = upload.missing
    .map((h) => byHash.get(h))
    .filter((f) => f !== undefined);
  const limit = Math.max(upload.maxRequestBytes - 1024 * 1024, 1024);
  let sent = 0;
  while (sent < needed.length) {
    const batch: { hash: string; content: string }[] = [];
    let bytes = 0;
    while (sent < needed.length) {
      const content = await encoded(needed[sent]);
      if (batch.length && bytes + content.length > limit) break;
      batch.push({ hash: needed[sent].hash, content });
      bytes += content.length;
      sent++;
    }
    if (!args.flags.json)
      io.out(`Uploading ${sent} of ${needed.length} new files…`);
    await api.call(`/projects/${project.id}/uploads/${upload.uploadId}/files`, {
      method: 'POST',
      body: { files: batch },
    });
  }
  const pages = assets.filter((f) => f.path.endsWith('.html'));
  // A preset knows whether the site is a single-page app; otherwise one page says so.
  const spa = args.flags['no-spa']
    ? false
    : Boolean(args.flags.spa) ||
      (settings
        ? settings.spa
        : pages.length === 1 && pages[0].path === '/index.html');
  const read = async (name: string) => {
    const f = special(name);
    return f
      ? new TextDecoder().decode(await io.fs.readFile(f.full))
      : undefined;
  };
  const worker = special('_worker.js');
  const { result: r } = await api.call<{ result: Deployed }>(
    `/projects/${project.id}/uploads/${upload.uploadId}/deploy`,
    {
      method: 'POST',
      body: change({
        spa,
        ...(prod ? { publish: true } : { preview: true }),
        ...(worker ? { workerModule: await encoded(worker) } : {}),
        ...(special('_redirects')
          ? { redirects: await read('_redirects') }
          : {}),
        ...(special('_headers') ? { headers: await read('_headers') } : {}),
      }),
    },
  );
  report(
    io,
    args,
    api,
    project,
    r,
    `Deployed ${assets.length} file${assets.length === 1 ? '' : 's'} (${needed.length} new${skipped ? `, ${skipped} skipped` : ''}) to ${r.workerName}${prod ? '' : ' as a preview'}.`,
    { files: assets.length, uploaded: needed.length },
    first && !target,
  );
  await checkHome(io, args, r);
}

// A deploy that went through can still be an app that fails every request: a framework
// its Cloudflare adapter can't run yet builds and deploys without a complaint. So the new
// version is asked for its home page, a few times while a new address comes up, and a
// server error is said plainly. Anything below 500 is the app's own answer.
const HOME_CHECKS = 3;
const HOME_TIMEOUT_MS = 8000;
async function checkHome(io: Io, args: Args, r: Deployed) {
  const url = r.preview ? r.previewUrl : (r.url ?? r.previewUrl);
  if (!url || args.flags.json) return;
  let status = 0;
  for (let attempt = 0; attempt < HOME_CHECKS; attempt++) {
    if (attempt) await io.sleep(2000);
    try {
      status = (
        await io.fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(HOME_TIMEOUT_MS),
        })
      ).status;
    } catch {
      status = 0;
    }
    if (status > 0 && status < 500) return;
  }
  io.out(
    status >= 500
      ? `Heads up: ${url} answers ${status}. The deploy went through, but the app fails at its home page. Its logs say why (shipcel logs --since 10m); shipcel rollback goes back to the version before.`
      : `Heads up: ${url} didn’t answer within ${(HOME_CHECKS * HOME_TIMEOUT_MS) / 1000} seconds. A new address can take a minute; if it still doesn’t answer, the app’s logs say why (shipcel logs --since 10m).`,
  );
}

// Which deploy was asked for: --prod (or its earlier name --publish), or --target as on
// Vercel. Null leaves it to the default.
function wantedTarget(args: Args): 'production' | 'preview' | null {
  const target = text(args.flags.target);
  if (target !== undefined && target !== 'production' && target !== 'preview')
    throw new CliError('--target takes preview or production.', 2);
  if (args.flags.prod || args.flags.publish) {
    if (target === 'preview')
      throw new CliError(
        '--prod and --target preview say different things.',
        2,
      );
    return 'production';
  }
  return target ?? null;
}

// What a deploy did, and where to find it.
function report(
  io: Io,
  args: Args,
  api: Client,
  project: Project,
  r: Deployed,
  headline: string,
  details: Record<string, unknown>,
  // The app's first deploy, which went to production without being asked to.
  firstByDefault: boolean,
) {
  const inspect = dashboard(api, project, 'deployments');
  if (args.flags.json) {
    io.out(
      JSON.stringify({ project: project.name, ...details, ...r, inspect }),
    );
    return;
  }
  io.out(headline);
  io.out(`Inspect: ${inspect}`);
  if (r.previewUrl) io.out(`Preview: ${r.previewUrl}`);
  else if (r.previewNote) io.out(`Preview: none. ${r.previewNote}`);
  const short = r.versionId.slice(0, 8);
  if (!r.preview)
    io.out(
      r.url
        ? `Production: ${r.url}`
        : 'Production: deployed. Claim a workers.dev subdomain in the dashboard to give it an address.',
    );
  else if (r.productionUrl)
    io.out(
      `Production: ${r.productionUrl} (unchanged). To make this version production: shipcel promote ${short}`,
    );
  else
    io.out(
      `Not public yet: only the preview address works. To publish it: shipcel promote ${short} (or deploy with --prod).`,
    );
  if (firstByDefault && !r.preview)
    io.out(
      'A new app’s first deploy goes to production. From now on, shipcel deploys a preview and shipcel --prod deploys to production.',
    );
}

// Apps ---------------------------------------------------------------------------------

type AppDetection = Extract<Detection, { kind: 'server' | 'wrangler' }>;
type AppSession = {
  id: string;
  token: string;
  apiPath: string;
  accountId: string;
  workerName: string;
  adapter: string;
  production: boolean;
  first: boolean;
  // OpenNext's R2 cache, filled once production serves the new version.
  cache?: { bucket: string; prefix: string };
};
const resourceKinds = {
  d1: 'the D1 database',
  kv: 'the KV namespace',
  r2: 'the R2 bucket',
};
// Names the folder and the file the review read: a deploy started one folder too high is
// the likeliest reason for an answer that makes no sense to the person.
const cannotDeploy = (
  io: Io,
  files: Record<string, string | null>,
  issues: string[],
) => {
  const config = ['wrangler.jsonc', 'wrangler.json'].find((f) => files[f]);
  return [
    `The app in ${io.cwd}${config ? ` (${config})` : ''} can’t deploy yet:`,
    ...issues.map((i) => `  - ${i}`),
  ].join('\n');
};

// This folder is an app with code or bindings, which Wrangler deploys: it has a Wrangler
// configuration, or a framework that renders on a server. Naming an output folder
// (--output), now or on an earlier deploy, says to upload a static build instead.
async function appIn(io: Io, args: Args): Promise<AppDetection | null> {
  if (text(args.flags.output) !== undefined) return null;
  if ((await readLink(io)).settings) return null;
  const found = detect(await projectFiles(io, io.cwd));
  return found.kind === 'server' || found.kind === 'wrangler' ? found : null;
}

// A framework that renders on a server needs its Cloudflare adapter and a Wrangler
// configuration. Wrangler's own setup adds both. They are changes to the person's project,
// so it runs only when they agree (or passed --yes); after that nothing more is asked.
// An install that failed, said with what helps in the cases seen with new apps: a package
// manager the project uses that isn't installed, and npm 10, which can't install some of
// them (seen in October 2026 with Nuxt 4.6, Angular 21 and Analog 2.8; npm 11 can).
function installFailed(command: string, code: number) {
  const manager = command.split(' ')[0];
  if (code === 127)
    return `${manager} isn’t installed on this computer, and this project uses it (its lockfile says so). Install ${manager}, or delete its lockfile to use npm, then run shipcel again.`;
  return `${command} failed (exit code ${code}).${
    manager === 'npm'
      ? ' If npm stopped with “Cannot read properties of null (reading ‘edgesOut’)” or “Unable to resolve reference”, that is npm 10: npm 11 installs these apps (npm install -g npm@11).'
      : ''
  }`;
}

// After Wrangler's setup of an Angular app: the app's workers.dev addresses in the hosts
// its server renders for (allowWorkersDev).
async function allowAngularHosts(io: Io, args: Args, api: Client) {
  const path = join(io.cwd, 'angular.json');
  if (!(await io.fs.exists(path))) return;
  const { subdomain } = await api.call<{ subdomain: string | null }>(
    '/connections/cloudflare/subdomain',
  );
  const changed = subdomain
    ? allowWorkersDev(decode(await io.fs.readFile(path)), subdomain)
    : null;
  if (!args.flags.json && subdomain && changed)
    io.out(
      `Added ${changed.host} to angular.json (security.allowedHosts): Angular renders pages only for the hosts listed there. Add your own domains there too when you attach them.`,
    );
  else if (!args.flags.json && !subdomain)
    io.out(
      '  Note: Angular renders pages only for the hosts in angular.json (security.allowedHosts). Add the app’s address there once your account has a workers.dev subdomain.',
    );
  if (changed) await io.fs.writeFile(path, changed.text);
}

async function setUpAdapter(
  io: Io,
  args: Args,
  api: Client,
  framework: string,
) {
  const managers = lockfileManagers(await projectFiles(io, io.cwd));
  if (managers.length > 1)
    throw new CliError(
      `This folder has lockfiles for ${managers.join(' and ')}, so it isn’t clear which package manager installs it, and Wrangler’s setup and shipcel would each pick a different one. Delete the lockfile of the one you don’t use, then run shipcel again.`,
    );
  if (!args.flags.yes) {
    if (!io.isTTY || args.flags.json)
      throw new CliError(
        `This is a ${framework} app, which needs its Cloudflare adapter and a Wrangler configuration before it can deploy. Pass --yes and shipcel adds them (Wrangler’s setup changes package.json and writes wrangler.jsonc), then deploys.`,
      );
    io.out(
      `This is a ${framework} app. On Cloudflare it runs through an adapter and a Wrangler configuration, which this project doesn’t have yet.`,
    );
    if (
      !yes(
        await io.ask(
          'Add them now? Wrangler changes files in this folder (package.json and its configuration). [Y/n] ',
        ),
        true,
      )
    )
      throw new CliError(
        'Nothing was changed. Run shipcel again when you want the adapter added.',
      );
  }
  // Wrangler reads the framework's version from the installed packages.
  if (!(await io.fs.exists(join(io.cwd, 'node_modules')))) {
    const files = await projectFiles(io, io.cwd);
    const manifest = files['package.json']
      ? parseManifest(files['package.json'])
      : null;
    const install = `${packageManager(files, manifest ?? undefined)} install`;
    if (!args.flags.json) io.out(`Installing dependencies: ${install}`);
    const installed = await io.run(install, io.cwd);
    if (installed !== 0)
      throw new CliError(
        `${installFailed(install, installed)} Nothing was deployed.`,
      );
  }
  // What Wrangler's setup would do, before it changes anything. A framework it has no
  // adapter for it sets up as a folder of static files, and the app would deploy without
  // its code.
  const env = setupEnv();
  const report = join(configDir(io), 'wrangler-setup.json');
  await io.fs.mkdir(configDir(io), 0o700);
  await io.fs.remove(report);
  if (!args.flags.json)
    io.out('Checking the project with Wrangler’s setup (nothing changes yet)…');
  const looked = await io.run(
    `${setupCommand} --dry-run`,
    io.cwd,
    { ...env, WRANGLER_OUTPUT_FILE_PATH: report },
    true,
  );
  const recognised = (await io.fs.exists(report))
    ? setupFramework(decode(await io.fs.readFile(report)))
    : null;
  await io.fs.remove(report);
  if (looked !== 0)
    throw new CliError(
      `Wrangler’s setup can’t configure this ${framework} app (exit code ${looked}); its output above says why. It changed nothing.`,
    );
  const byHand =
    'Add the adapter by hand (the framework’s Cloudflare guide has the steps) and run shipcel again.';
  if (!recognised)
    throw new CliError(
      `Wrangler’s setup didn’t say what it would do with this ${framework} app, so it changed nothing. ${byHand}`,
    );
  if (recognised === 'static')
    throw new CliError(
      `Wrangler’s setup has no Cloudflare adapter for this ${framework} app: it would deploy the project’s static files without its code, so it changed nothing. ${byHand} If the app builds to static files, say where instead: shipcel deploy --output <folder>.`,
    );
  if (!args.flags.json) io.out(`Setting up: ${setupCommand}`);
  const code = await io.run(setupCommand, io.cwd, env);
  if (code !== 0)
    throw new CliError(
      `Wrangler’s setup failed (exit code ${code}); its output above says why. Nothing was deployed.`,
    );
  if (detect(await projectFiles(io, io.cwd)).kind !== 'wrangler')
    throw new CliError(
      `Wrangler’s setup left no Wrangler configuration for this ${framework} app. Add its Cloudflare adapter by hand (the framework’s Cloudflare guide has the steps), then run shipcel again.`,
    );
  if (framework === 'Angular') await allowAngularHosts(io, args, api);
}

// After a production deploy of a Next.js app with OpenNext's R2 cache: the pages Next.js
// prerendered go into the app's bucket, so their first requests are served from it. The
// deploy is done whatever happens here; a page that isn't in the cache renders on its first
// request and is cached then.
const entries = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
async function fillNextCache(
  io: Io,
  say: (line: string) => void,
  api: Client,
  session: AppSession,
) {
  const found = await cacheEntries(io, io.cwd);
  if (!found.length) return;
  const { filled, refused, left } = await fillCache(
    io,
    api.url,
    session,
    found,
  );
  if (refused)
    say(
      `  Note: OpenNext’s cache wasn’t filled (${refused}), so each page is cached on its first request.`,
    );
  else if (left)
    say(
      `Filled OpenNext’s cache with ${filled} of the ${entries(found.length)} Next.js prerendered; the others are cached on their first request.`,
    );
  else
    say(
      `Filled OpenNext’s cache with the ${entries(filled)} Next.js prerendered.`,
    );
}

// GitLab, Bitbucket, Gitea and Forgejo: their CI runs the shipcel CLI on every push, the way
// GitHub Actions do (worker/git-sources.ts). A GitLab.com job signs in with GitLab's ID token;
// the others with a deploy token of the project's.
const otherHosts = {
  gitlab: {
    name: 'GitLab',
    file: '.gitlab-ci.yml',
    secret: 'a masked, protected CI/CD variable (Settings → CI/CD → Variables)',
  },
  bitbucket: {
    name: 'Bitbucket',
    file: 'bitbucket-pipelines.yml',
    secret:
      'a secured repository variable (Repository settings → Repository variables)',
  },
  gitea: {
    name: 'Gitea',
    file: '.gitea/workflows/shipcel.yml',
    secret: 'a repository secret (Settings → Actions → Secrets)',
  },
} as const;
type OtherHost = keyof typeof otherHosts;
function providerOf(host: string, flag: string | undefined): OtherHost {
  if (flag === 'gitlab' || flag === 'bitbucket' || flag === 'gitea')
    return flag;
  if (host === 'bitbucket.org') return 'bitbucket';
  return host === 'gitlab.com' || host.includes('gitlab') ? 'gitlab' : 'gitea';
}
// The branch that goes to production: the remote's default, as the last fetch recorded it, or
// the one checked out.
async function defaultBranch(io: Io, remote: string) {
  const read = (path: string) =>
    io.fs.readFile(join(io.cwd, '.git', path)).then(decode, () => '');
  const head = /^ref: refs\/remotes\/[^/]+\/(.+)$/m.exec(
    await read(`refs/remotes/${remote}/HEAD`),
  );
  const current = /^ref: refs\/heads\/(.+)$/m.exec(await read('HEAD'));
  return head?.[1].trim() ?? current?.[1].trim() ?? null;
}
const deployLine = (origin: string, flags: string) =>
  `npx --yes --package=${origin}/cli/shipcel.tgz shipcel deploy${flags}`;
// The CI configuration that deploys every push: the production branch to production, any
// other branch as a preview.
function ciFile(
  provider: OtherHost,
  signIn: 'id-token' | 'deploy-token',
  origin: string,
  branch: string,
  project: Project,
) {
  const by = `--project ${project.id} --yes`;
  if (provider === 'gitlab' && signIn === 'id-token')
    return `# Deploys this repository with Shipcel (${origin}): every push builds here, on GitLab, and
# deploys to your Cloudflare account. The production branch goes to production while it is
# protected; other branches get a preview. The job signs in with GitLab's own ID token: no
# secret is stored.
shipcel:
  image: node:24
  rules:
    - if: $CI_COMMIT_BRANCH && ($CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "web")
  id_tokens:
    SHIPCEL_ID_TOKEN:
      aud: ${origin}
  variables:
    SHIPCEL_URL: ${origin}
  script:
    - ${deployLine(origin, '')}
`;
  if (provider === 'gitlab')
    return `# Deploys this repository with Shipcel (${origin}): ${branch} to production, other branches as
# previews. The job signs in with a deploy token, kept as the CI/CD variable SHIPCEL_TOKEN.
shipcel:
  image: node:24
  rules:
    - if: $CI_COMMIT_BRANCH == "${branch}"
      variables:
        TARGET: --prod
    - if: $CI_COMMIT_BRANCH
  variables:
    SHIPCEL_URL: ${origin}
  script:
    - ${deployLine(origin, ` $TARGET ${by}`)}
`;
  if (provider === 'bitbucket')
    return `# Deploys this repository with Shipcel (${origin}): ${branch} to production, other branches as
# previews. The step signs in with a deploy token, kept as the secured variable SHIPCEL_TOKEN.
image: node:24
pipelines:
  branches:
    ${branch}:
      - step:
          name: Deploy to production
          script:
            - export SHIPCEL_URL=${origin}
            - ${deployLine(origin, ` --prod ${by}`)}
  default:
    - step:
        name: Deploy a preview
        script:
          - export SHIPCEL_URL=${origin}
          - ${deployLine(origin, ` ${by}`)}
`;
  return `# Deploys this repository with Shipcel (${origin}): ${branch} to production, other branches as
# previews. The job signs in with a deploy token, kept as the secret SHIPCEL_TOKEN.
name: Shipcel
on:
  push:
    branches: ['**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: ${deployLine(origin, ` \${{ github.ref_name == '${branch}' && '--prod' || '' }} ${by}`)}
        env:
          SHIPCEL_URL: ${origin}
          SHIPCEL_TOKEN: \${{ secrets.SHIPCEL_TOKEN }}
`;
}
async function otherHostConnect(
  io: Io,
  api: Client,
  args: Args,
  remote: { host: string; path: string },
  remoteName: string,
) {
  const provider = providerOf(remote.host, text(args.flags.provider));
  const { name, file, secret } = otherHosts[provider];
  io.out(
    `Connecting ${name} repository: https://${remote.host}/${remote.path}`,
  );
  await cloudflareReady(io, api, args);
  const files = await planFiles(io.fs, io.cwd);
  const folder = await api.call<LocalPlan>('/local-plan', {
    method: 'POST',
    body: { files },
  });
  if (folder.adapter === 'container')
    throw new CliError(
      `${name}’s CI runs the shipcel CLI, which can’t make container images. Cloudflare’s builds can, and Shipcel connects them from GitHub only for now: push the repository to GitHub, then run shipcel git connect.`,
    );
  // A site without a Wrangler configuration is uploaded as it is; anything else is reviewed.
  const site = folder.adapter === 'static-assets';
  if (!site && folder.issues.length)
    throw new CliError(cannotDeploy(io, files, folder.issues));
  const project = await projectFor(
    io,
    api,
    args,
    io.cwd,
    false,
    site ? 'static' : (folder.framework ?? 'worker'),
  );
  if (!project) return;
  if (await link(io, project)) io.out(ignored);
  const branch =
    text(args.flags.branch) ?? (await defaultBranch(io, remoteName)) ?? 'main';
  const source = await api.call<{ signIn: 'id-token' | 'deploy-token' }>(
    `/projects/${project.id}/git-source`,
    {
      method: 'PUT',
      body: { provider, host: remote.host, repository: remote.path, branch },
    },
  );
  const content = ciFile(provider, source.signIn, api.url, branch, project);
  const path = join(io.cwd, file);
  if (await io.fs.exists(path)) {
    io.out(`${file} is there already, so it was left alone. Add this to it:`);
    io.out(content);
  } else {
    await io.fs.mkdir(path.slice(0, path.lastIndexOf('/')));
    await io.fs.writeFile(path, content);
    io.out(`Wrote ${file}.`);
  }
  if (source.signIn === 'deploy-token')
    io.out(
      `Its jobs sign in with a deploy token: make one with shipcel tokens add "${name}: ${remote.path}" --project ${project.name}, and keep it as ${secret} named SHIPCEL_TOKEN.`,
    );
  io.out(
    source.signIn === 'id-token'
      ? `Commit ${file} and push: every push to ${branch} deploys ${project.name} to production while ${branch} is protected in GitLab, and other branches deploy previews.`
      : `Commit ${file} and push: every push to ${branch} deploys ${project.name} to production, and other branches deploy previews.`,
  );
}

// Deploys an app with code or bindings. Shipcel reviews the folder's configuration (as it
// does a GitHub repository's), the app builds here, and Wrangler deploys it: Wrangler runs
// on this computer and talks to Cloudflare through Shipcel for this one deploy, with a
// token that is good for nothing else.
async function deployApp(io: Io, args: Args, api: Client, found: AppDetection) {
  const say = (line: string) => {
    if (!args.flags.json) io.out(line);
  };
  await cloudflareReady(io, api, args);
  if (found.kind === 'server')
    await setUpAdapter(io, args, api, found.framework);
  const files = await planFiles(io.fs, io.cwd);
  const folder = await api.call<LocalPlan>('/local-plan', {
    method: 'POST',
    body: { files },
  });
  if (folder.issues.length)
    throw new CliError(cannotDeploy(io, files, folder.issues));
  const project = await projectFor(
    io,
    api,
    args,
    io.cwd,
    true,
    folder.framework ?? 'worker',
  );
  if (!project) return;
  await deploysFromHere(io, api, args, project);
  if (await link(io, project)) say(ignored);
  const target = wantedTarget(args);
  const wanted = text(args.flags.name);
  const request = {
    files,
    production: target === 'production',
    ...(wanted ? { workerName: wanted } : {}),
  };
  const plan = await api.call<LocalPlan>(`/projects/${project.id}/local-plan`, {
    method: 'POST',
    body: request,
  });
  if (plan.issues.length)
    throw new CliError(cannotDeploy(io, files, plan.issues));
  const buildFlag = text(args.flags['build-command']);
  const buildCommand =
    buildFlag === undefined
      ? plan.buildCommand || null
      : buildFlag.trim() || null;
  say(
    `Detected ${adapterNames[plan.adapter] ?? plan.adapter} (Build Command: ${buildCommand ?? 'none'})`,
  );
  for (const warning of plan.warnings) say(`  Note: ${warning}`);
  if (plan.first && target === 'preview')
    say(
      'A new app’s first deploy is its production deploy; previews start with the next one.',
    );
  const create = plan.create ?? [];
  if (create.length) {
    const list = create
      .map((r) => `${resourceKinds[r.type]} ${r.name}`)
      .join(', ');
    if (args.flags.yes) say(`Cloudflare creates ${list} for this app.`);
    else if (!io.isTTY || args.flags.json)
      throw new CliError(
        `This deploy creates ${list} in your Cloudflare account. Pass --yes to confirm in scripts.`,
      );
    else if (
      !yes(
        await io.ask(
          `This deploy creates ${list} in your Cloudflare account. Go ahead? [Y/n] `,
        ),
        true,
      )
    )
      throw new CliError('Nothing was deployed.');
  }
  const manifest = files['package.json']
    ? parseManifest(files['package.json'])
    : null;
  if (!args.flags.prebuilt)
    await build(
      io,
      args,
      {
        preset: plan.adapter,
        installCommand: `${packageManager(files, manifest ?? undefined)} install`,
        buildCommand,
        outputDirectory: '.',
        spa: false,
      },
      ' Nothing was deployed.',
      typesCommand(files),
    );
  if (plan.openNextCache === 'static-assets') {
    const copied = await copyStaticCache(io, io.cwd);
    if (copied)
      say(
        `Added OpenNext’s cache to the app’s files: ${entries(copied)} that Next.js prerendered.`,
      );
  }
  const opened = await api.raw(
    `/projects/${project.id}/local-deploys`,
    change({ ...request, confirmResources: create.length > 0 }),
  );
  if (opened.status !== 201) throw api.failure(opened.status, opened.data);
  const session = opened.data as unknown as AppSession;
  say(
    `${session.production ? 'Deploying' : 'Uploading a preview of'} ${session.workerName} with Wrangler ${WRANGLER_VERSION}…`,
  );
  const code = await io.run(
    wranglerCommand(session.workerName, session.production),
    io.cwd,
    wranglerEnv(api.url, session),
  );
  const stopped =
    code === 0
      ? ''
      : ` Wrangler stopped with exit code ${code}; see its output above.`;
  if (code === 0 && session.cache) await fillNextCache(io, say, api, session);
  const finished = await api.raw(
    `/projects/${project.id}/local-deploys/${session.id}/finish`,
    { failed: code !== 0 },
  );
  if (finished.status !== 200)
    throw new CliError(
      `${typeof finished.data.error === 'string' ? finished.data.error : `Shipcel answered ${finished.status}.`}${stopped}`,
    );
  const r = finished.data.result as unknown as Deployed;
  report(
    io,
    args,
    api,
    project,
    r,
    session.production
      ? `Deployed ${r.workerName} to production.`
      : `Uploaded a preview of ${r.workerName}.`,
    { adapter: session.adapter },
    session.first && !target,
  );
  await checkHome(io, args, r);
  if (code !== 0)
    throw new CliError(
      `The new version is uploaded, but Wrangler didn’t finish.${stopped} Check the app’s address and schedules.`,
    );
}

// Versions ----------------------------------------------------------------------------

type Version = {
  id: string;
  number?: number;
  createdAt?: string;
  message: string;
  live: number | null;
  production?: boolean;
};
type Upload = { versionId: string | null; previewUrl: string | null };

// A version by its ID, the start of it, or its preview address
// (https://<first 8 characters>-<app>.<subdomain>.workers.dev).
function findVersion<V extends Version>(list: V[], ref: string) {
  let wanted = ref.toLowerCase();
  if (/^https?:\/\//.test(wanted)) {
    try {
      wanted = new URL(wanted).hostname.split('.')[0].split('-')[0];
    } catch {
      throw new CliError(`${ref} is not a web address.`);
    }
  }
  if (!/^[0-9a-f-]{4,36}$/.test(wanted))
    throw new CliError(`${ref} is not a version ID or a preview address.`);
  const found = list.filter((v) => v.id.startsWith(wanted));
  if (found.length > 1)
    throw new CliError(
      `${ref} matches more than one version. Give more of it.`,
    );
  if (!found.length)
    throw new CliError(`No version ${ref} among the 25 newest.`);
  return found[0];
}
const statusOf = (v: Version) =>
  v.live !== null
    ? `Production ${v.live}%`
    : v.production
      ? 'Earlier production'
      : 'Preview';
async function versionsOf(api: Client, project: Project) {
  const [list, uploads] = await Promise.all([
    api.call<Version[]>(`/projects/${project.id}/versions`),
    api
      .call<Upload[]>(`/projects/${project.id}/uploads`)
      .catch(() => [] as Upload[]),
  ]);
  const previews = new Map(uploads.map((u) => [u.versionId, u.previewUrl]));
  return list.map((v) => ({ ...v, previewUrl: previews.get(v.id) ?? null }));
}

async function list(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args, args._[1]);
  const [versions, job] = await Promise.all([
    versionsOf(api, project),
    production(api, project),
  ]);
  if (args.flags.json) {
    io.out(JSON.stringify(versions));
    return;
  }
  io.out(
    `${project.name} · production: ${job?.live_url ?? 'not public'} · ${dashboard(api, project, 'deployments')}`,
  );
  if (!versions.length) {
    io.out('No versions yet. Run shipcel deploy.');
    return;
  }
  for (const line of table([
    ['AGE', 'VERSION', 'STATUS', 'PREVIEW', 'MESSAGE'],
    ...versions.map((v) => [
      ago(v.createdAt),
      v.id.slice(0, 8),
      statusOf(v),
      v.previewUrl ?? '-',
      v.message,
    ]),
  ]))
    io.out(line);
}

async function inspect(io: Io, args: Args) {
  const ref = args._[1];
  if (!ref)
    throw new CliError(
      'Name a version: shipcel inspect <version|preview url>.',
      2,
    );
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const version = findVersion(await versionsOf(api, project), ref);
  if (args.flags.json) {
    io.out(JSON.stringify({ project: project.name, ...version }));
    return;
  }
  for (const line of table([
    [
      'Version',
      `${version.id}${version.number ? ` (#${version.number})` : ''}`,
    ],
    [
      'Created',
      version.createdAt
        ? `${version.createdAt} (${ago(version.createdAt)} ago)`
        : '-',
    ],
    [
      'Status',
      version.live !== null
        ? `Production, ${version.live}% of traffic`
        : version.production
          ? 'Served production before; not serving now'
          : 'Preview: serves no production traffic',
    ],
    ['Preview', version.previewUrl ?? '-'],
    ['Message', version.message || '-'],
    ['Project', `${project.name} · ${dashboard(api, project, 'deployments')}`],
  ]))
    io.out(line);
}

async function sendTraffic(api: Client, project: Project, target: Version) {
  await api.call(`/projects/${project.id}/rollback`, {
    method: 'POST',
    body: change({ versionId: target.id }),
  });
}

async function promote(io: Io, args: Args) {
  const ref = args._[1];
  if (!ref)
    throw new CliError(
      'Name a version: shipcel promote <version|preview url>.',
      2,
    );
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const target = findVersion(await versionsOf(api, project), ref);
  const job = await production(api, project);
  const uploaded = job?.adapter === 'direct-upload';
  if (target.live === 100 && (job?.live_url || !uploaded))
    throw new CliError('That version is already production.');
  await confirmed(
    io,
    args,
    `Make ${target.id.slice(0, 8)} the production version of ${project.name}?`,
  );
  if (target.live !== 100) await sendTraffic(api, project, target);
  let url = job?.live_url ?? null;
  // An app deployed by upload may not be public yet: promoting publishes it.
  if (uploaded && !url)
    url = (
      await api.call<{ result: { url: string | null } }>(
        `/projects/${project.id}/publish`,
        { method: 'POST', body: change() },
      )
    ).result.url;
  io.out(`Promoted ${target.id.slice(0, 8)} to production.`);
  if (url) io.out(`Production: ${url}`);
}

async function rollback(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const list = await versionsOf(api, project);
  const ref = args._[1] ?? text(args.flags.to);
  let target: Version | undefined;
  if (ref) target = findVersion(list, ref);
  else {
    const live = list.findIndex((v) => v.live === 100);
    if (live === -1)
      throw new CliError(
        'Traffic is split between versions. Name the version to roll back to.',
      );
    // The most recent earlier version that served production; previews never did.
    target = list.slice(live + 1).find((v) => v.production ?? true);
    if (!target)
      throw new CliError(
        'There is no earlier production version to go back to.',
      );
  }
  if (target.live === 100) throw new CliError('That version is already live.');
  await confirmed(io, args, `Send all traffic to ${target.id}?`);
  await sendTraffic(api, project, target);
  io.out(
    `Rolled back: ${target.id} now serves all traffic. Database changes are not undone.`,
  );
}

async function redeploy(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args, args._[1]);
  const job = await production(api, project);
  if (!job)
    throw new CliError(
      'This project has not been deployed yet. Deploy it first.',
    );
  if (job.adapter === 'direct-upload')
    throw new CliError(
      'This project deploys by upload: run shipcel deploy --prod in its folder.',
    );
  await confirmed(
    io,
    args,
    `Build ${job.branch ?? 'the production branch'} of ${job.repository_name ?? project.name} again?`,
  );
  const { result } = await api.call<{
    result: { buildId: string; commit: string };
  }>(`/projects/${project.id}/redeploy`, { method: 'POST', body: change() });
  io.out(
    `Started build ${result.buildId} of ${job.branch ?? 'the production branch'} at ${result.commit.slice(0, 7)}.`,
  );
  io.out(`Follow it: ${dashboard(api, project, 'operations')}`);
}

// Git deployments ---------------------------------------------------------------------

const adapterNames: Record<string, string> = {
  'configured-worker': 'Wrangler configuration',
  astro: 'Astro',
  sveltekit: 'SvelteKit',
  nextjs: 'Next.js (OpenNext)',
  python: 'Python Worker',
  'python-packages': 'Python Worker with packages',
  container: 'Container Worker',
  'static-assets': 'Static site',
};
// What the pipeline does next, by its step.
const pipelineSteps: Record<string, string> = {
  queued: 'Checking the app’s name',
  create_worker: 'Creating the Worker',
  connect_repository: 'Connecting the repository',
  create_trigger: 'Creating the build trigger',
  start_build: 'Starting the first build',
  building: 'Cloudflare is building',
  health_check: 'Checking that the app answers',
};

// Advances a GitHub deployment and reports each step until it is live or stops.
async function follow(io: Io, api: Client, project: Project, first: Job) {
  const where = dashboard(api, project, 'deployments');
  let job = first;
  let shown = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    const step = (job.step ?? '').replace(/^intent_/, '');
    if (step !== shown && pipelineSteps[step])
      io.out(`${pipelineSteps[step]}…`);
    shown = step;
    if (job.status === 'deployed') {
      io.out(`Production: ${job.live_url}`);
      io.out(`Every push to ${job.branch} now builds and deploys.`);
      return;
    }
    if (job.status === 'failed' || job.status === 'needs_attention')
      throw new CliError(
        `${job.error ?? 'The deployment stopped.'}\nSee it in the dashboard: ${where}`,
      );
    await io.sleep(4000);
    job = await api.call<Job>(`/deployments/${job.id}/refresh`, {
      method: 'POST',
    });
  }
  throw new CliError(`Cloudflare is still building. Follow it: ${where}`);
}

// How a project deploys with GitHub Actions (worker/github-actions.ts), and the answer to linking
// it: the workflow added to the repository, one there already, or GitHub's refusal.
type ActionsLink = {
  repository: string;
  branch: string;
  actionsUrl: string;
  workflowUrl: string;
};
type Linked = ActionsLink &
  (
    | { workflow: 'added'; commitUrl: string }
    | { workflow: 'present' }
    | {
        workflow: 'refused';
        reason: string;
        addUrl: string;
        // GitHub's page for installing Shipcel's app, when that is what's missing.
        installUrl?: string;
      }
  );

// Connects a GitHub repository to a project so every push deploys, like `vercel git connect`.
// Shipcel adds a workflow to the repository: GitHub Actions builds each push and deploys it
// with shipcel deploy, signed in with GitHub's own token, so nothing is set up in Cloudflare.
// --cloudflare-builds uses Cloudflare's own builds instead.
async function gitConnect(
  io: Io,
  api: Client,
  args: Args,
  from: { name?: string; repository?: string } = {},
) {
  let repository = from.repository ?? text(args.flags.repo);
  // A repository on another Git host, named with its host: gitlab.com/group/project.
  const elsewhere = repository?.split('/')[0].includes('.')
    ? remoteRepository(`https://${repository}`)
    : null;
  if (elsewhere) return otherHostConnect(io, api, args, elsewhere, 'origin');
  if (repository && !/^[\w-]+\/[\w.-]+$/.test(repository))
    throw new CliError(
      '--repo takes a GitHub repository as owner/name, or one on another host as host/path (gitlab.com/group/project).',
      2,
    );
  const remotes = await githubRemotes(io);
  if (!repository) {
    const other = remotes.length ? [] : await otherRemotes(io);
    if (other.length && args.flags['cloudflare-builds'])
      throw new CliError(
        `This folder has no GitHub remote. Cloudflare’s builds connect GitHub repositories only: without --cloudflare-builds, shipcel git connect deploys ${other[0].repository.host}/${other[0].repository.path} from its own CI.`,
      );
    if (other.length)
      return otherHostConnect(
        io,
        api,
        args,
        other[0].repository,
        other[0].name,
      );
    if (!remotes.length)
      throw new CliError(
        'This folder has no GitHub remote. Push it to GitHub first, or name the repository: shipcel git connect --repo <owner>/<name>.',
      );
    repository = remotes[0].repository;
    if (
      new Set(remotes.map((r) => r.repository)).size > 1 &&
      io.isTTY &&
      !args.flags.yes
    ) {
      io.out('Found multiple remote URLs:');
      for (const r of remotes) io.out(`  ${r.name}  ${r.repository}`);
      const answer =
        (
          await io.ask(
            `Which remote do you want to connect? [${remotes[0].name}] `,
          )
        ).trim() || remotes[0].name;
      const chosen = remotes.find((r) => r.name === answer);
      if (!chosen) throw new CliError(`There is no remote named ${answer}.`);
      repository = chosen.repository;
    }
  }
  const repo: string = repository;
  const query = `repository=${encodeURIComponent(repo)}`;
  // GitHub's runners can't reach a Shipcel on this computer: Cloudflare's builds can deploy.
  const host = new URL(api.url).hostname;
  if (
    !args.flags['cloudflare-builds'] &&
    (['localhost', '127.0.0.1', '[::1]'].includes(host) ||
      host.endsWith('.localhost'))
  )
    throw new CliError(
      `GitHub Actions can’t reach the Shipcel on this computer (${api.url}). Deploy every push with Cloudflare’s own builds instead: shipcel git connect --cloudflare-builds. Or deploy from here: shipcel deploy.`,
    );
  const connections = await cloudflareReady(io, api, args);
  if (!connections.nativeBuildsEnabled)
    throw new CliError(
      'Deployments are switched off on this Shipcel. Its operator turns them on with NATIVE_BUILDS_ENABLED=true.',
    );
  if (!connections.github.connected)
    throw new CliError(
      `GitHub isn’t connected to this workspace. Connect it, then run the command again: ${api.url}/app/#connections`,
    );
  io.out(`Connecting GitHub repository: https://github.com/${repo}`);

  // Shipcel's own GitHub app has to see the repository.
  const install =
    connections.github.installUrl ?? `${api.url}/app/#connections`;
  const detected = await need(io, args, {
    check: async () => {
      const { status, data } = await api.raw(
        `/repositories/detect?${query}`,
        undefined,
        'GET',
      );
      if (status === 404) return null;
      if (status !== 200) throw api.failure(status, data);
      return data as { framework: string | null };
    },
    todo: [
      `Shipcel’s GitHub app can’t see ${repo} yet.`,
      `Add the repository to it on GitHub: ${install}`,
    ],
    url: install,
    waiting: 'Waiting for GitHub…',
    done: () => `Shipcel can read ${repo}.`,
    seconds: 5,
  });

  const named = from.name ?? text(args.flags.name);
  let project = named
    ? ((await api.call<Project[]>('/projects')).find((p) => p.name === named) ??
      null)
    : await resolveProject(io, api, args);
  if (!project) {
    if (!detected.framework)
      throw new CliError(
        `Shipcel couldn’t tell what ${repo} runs: its root has no package.json, Wrangler configuration, pyproject.toml or index.html.`,
      );
    const containers = usesContainers(detected.framework);
    if (containers) await offFreeOnly(io, args, repo);
    let name = named ?? projectName(repo.split('/')[1]);
    if (!named && io.isTTY && !args.flags.yes)
      name = (await io.ask(`Project name [${name}]: `)).trim() || name;
    project = await api.call<Project>('/projects', {
      method: 'POST',
      body: {
        name,
        framework: detected.framework,
        source: 'github',
        repository: `https://github.com/${repo}`,
        ...(containers ? { freeOnly: false } : {}),
      },
    });
    io.out(`Created the project ${project.name}.`);
  }
  // Only a folder that holds this repository is linked to its project.
  if (remotes.some((r) => r.repository === repo) && (await link(io, project)))
    io.out(ignored);

  const existing = await production(api, project);
  // GitHub Actions deploy through the CLI, which can't make container images: Cloudflare's
  // builds can.
  if (!args.flags['cloudflare-builds'] && usesContainers(project.framework))
    io.out(
      'Containers deploy with Cloudflare’s own builds, which make their images: connecting with them.',
    );
  if (args.flags['cloudflare-builds'] || usesContainers(project.framework))
    return cloudflareBuilds(io, api, args, {
      repo,
      project,
      existing,
      connections,
    });
  if (existing && existing.adapter !== 'direct-upload') {
    io.out(
      `${project.name} already deploys ${existing.repository_name} on every push to ${existing.branch}, built by Cloudflare: ${existing.live_url}`,
    );
    return;
  }
  const { link: current } = await api.call<{ link: ActionsLink | null }>(
    `/projects/${project.id}/github-actions`,
  );
  // Linked already, connecting again adds the workflow GitHub refused before, or finds it
  // there. It commits to the repository either way, so it asks either way.
  const again = current?.repository === repo;
  await confirmed(
    io,
    args,
    `Add a workflow to ${repo} (.github/workflows/shipcel.yml) so GitHub Actions builds every push and deploys it to ${project.name}? Pushes to its default branch go to production, other branches to previews.`,
  );
  const linked = await api.call<Linked>(
    `/projects/${project.id}/github-actions`,
    { method: 'POST', body: { repository: repo, confirm: true } },
  );
  if (linked.workflow === 'refused') {
    io.out(
      `Linked ${repo} to ${project.name}, but the workflow isn’t in the repository yet. ${linked.reason}`,
    );
    if (linked.installUrl)
      io.out(`GitHub’s page for that: ${linked.installUrl}`);
    io.out(
      `${linked.installUrl ? 'Or add' : 'Add'} it on GitHub, on this page filled in for you: ${linked.addUrl}`,
    );
    await io.open(linked.installUrl ?? linked.addUrl).catch(() => {});
    return;
  }
  if (again && linked.workflow === 'present') {
    io.out(
      `${project.name} already deploys ${repo} on every push: ${linked.branch} to production, other branches as previews. Runs: ${linked.actionsUrl}`,
    );
    return;
  }
  io.out(
    linked.workflow === 'added'
      ? `Added the workflow to ${repo}: ${linked.commitUrl}`
      : `${repo} has .github/workflows/shipcel.yml already, so Shipcel kept it.`,
  );
  io.out(
    `Every push deploys now: ${linked.branch} to production, other branches as previews. Follow the runs: ${linked.actionsUrl}`,
  );
  if (linked.workflow === 'added' && remotes.some((r) => r.repository === repo))
    io.out('Run git pull to bring the workflow into this folder.');
}

// Cloudflare's own builds (Workers Builds), for what shipcel deploy can't deploy yet, such as
// containers. They need Cloudflare's own GitHub app able to read the repository and a build
// token, once per account: each is checked, and whichever is missing is finished in the
// browser while this waits.
async function cloudflareBuilds(
  io: Io,
  api: Client,
  args: Args,
  {
    repo,
    project,
    existing,
    connections,
  }: {
    repo: string;
    project: Project;
    existing: Job | null;
    connections: Connections;
  },
) {
  const owner = repo.split('/')[0];
  const query = `repository=${encodeURIComponent(repo)}`;
  if (existing?.adapter === 'direct-upload')
    throw new CliError(
      `${project.name} is deployed with shipcel deploy, and a project deploys one way. To have Cloudflare build every push, give the repository a project of its own: shipcel git connect --cloudflare-builds --name <another-name>`,
    );
  if (existing?.status === 'deployed') {
    io.out(
      `${project.name} already deploys ${existing.repository_name} on every push to ${existing.branch}: ${existing.live_url}`,
    );
    return;
  }
  if (existing) return follow(io, api, project, existing);

  const plan = await api.call<RepositoryInspection>(
    `/projects/${project.id}/repository`,
    { method: 'POST', body: { repository: repo } },
  );
  const serves = plan.site
    ? `, serves ${plan.site.directory === '.' ? 'the repository’s files' : `${plan.site.directory}/`}`
    : '';
  io.out(
    `${adapterNames[plan.adapter] ?? plan.adapter}${plan.site ? ` (${plan.site.preset})` : ''}: ${plan.buildCommand ? `builds with ${plan.buildCommand}` : 'no build step'}${serves}.`,
  );
  for (const warning of plan.warnings) io.out(`  Note: ${warning}`);
  if (plan.issues.length)
    throw new CliError(
      [
        `${repo} can’t deploy yet:`,
        ...plan.issues.map((issue) => `  - ${issue}`),
        'Fix these in the repository, push, and run shipcel git connect again.',
      ].join('\n'),
    );

  // Cloudflare clones with its own GitHub app. --skip-checks starts anyway and lets
  // Cloudflare answer, in case its check lags behind what its dashboard shows.
  if (!args.flags['skip-checks']) {
    type Access = {
      connectUrl: string;
      accounts: { readable: boolean | null; repositoriesUrl: string }[];
    };
    const access = () =>
      api.call<Access>(`/connections/cloudflare/github?${query}`);
    const first = await access();
    await need(
      io,
      args,
      {
        check: async () =>
          (await access()).accounts[0]?.readable ? true : null,
        todo: [
          `Cloudflare builds with its own GitHub app, and it can’t read ${repo} yet.`,
          `On Cloudflare’s Create application page, choose GitHub and give Cloudflare Workers and Pages ${owner} and the repository (Install & Authorize). When Cloudflare lists your repositories, you’re done: ${first.connectUrl}`,
          `If ${owner} is already listed there, add the repository on GitHub instead: ${first.accounts[0]?.repositoriesUrl ?? 'https://github.com/settings/installations'}`,
          'If Cloudflare already shows the repository, carry on with: shipcel git connect --skip-checks',
        ],
        url: first.connectUrl,
        waiting: 'Waiting for Cloudflare to see the repository…',
        done: () => `Cloudflare can read ${repo}.`,
        seconds: 5,
      },
      first.accounts[0]?.readable ? true : null,
    );
  }

  type BuildToken = { id: string; name: string };
  const tokens = await need(io, args, {
    check: async () => {
      const list = await api.call<BuildToken[]>(
        '/connections/cloudflare/build-tokens',
      );
      return list.length ? list : null;
    },
    todo: [
      'Cloudflare’s builds also need a build token: an API token you create once.',
      `Add it under Cloudflare on the Connections page: ${api.url}/app/#connections`,
    ],
    url: `${api.url}/app/#connections`,
    waiting: 'Waiting for the build token…',
    seconds: 5,
  });
  const wanted = text(args.flags['build-token']);
  let token = tokens[0];
  if (wanted) {
    const found = tokens.find((t) => t.id === wanted || t.name === wanted);
    if (!found)
      throw new CliError(
        `No build token ${wanted}. This account has: ${tokens.map((t) => t.name).join(', ')}.`,
      );
    token = found;
  } else if (tokens.length > 1) {
    if (!io.isTTY || args.flags.yes)
      throw new CliError(
        `This account has several build tokens. Choose one: --build-token <name> (${tokens.map((t) => t.name).join(', ')}).`,
      );
    const answer =
      (
        await io.ask(
          `Which build token? ${tokens.map((t) => t.name).join(', ')} [${token.name}] `,
        )
      ).trim() || token.name;
    const found = tokens.find((t) => t.name === answer);
    if (!found) throw new CliError(`No build token ${answer}.`);
    token = found;
  }

  const { subdomain } = await need(io, args, {
    check: async () => {
      const found = await api.call<{ subdomain: string | null }>(
        '/connections/cloudflare/subdomain',
      );
      return found.subdomain ? found : null;
    },
    todo: [
      'This Cloudflare account has no workers.dev address yet; every app gets its free address under it.',
      `Choose one: ${setupPage(api)}`,
    ],
    url: setupPage(api),
    waiting: 'Waiting for the workers.dev address…',
    seconds: 5,
  });

  // Next.js and container repositories deploy under the name in their configuration.
  const workerName = plan.workerName ?? project.name;
  if (plan.resources.length)
    io.out(
      `Cloudflare will create: ${plan.resources.map((r) => `${r.type.toUpperCase()} ${r.binding}`).join(', ')}.`,
    );
  if (plan.containers.length)
    io.out(
      `It deploys ${plan.containers.length} container${plan.containers.length === 1 ? '' : 's'}: containers need Cloudflare’s Workers Paid plan, and Cloudflare bills their usage to your account.`,
    );
  await confirmed(
    io,
    args,
    `Create the Worker ${workerName} in ${connections.cloudflare.account!.name} and build every push to ${plan.branch} of ${repo}? Only connect a repository you trust; Cloudflare usage and builds may incur charges.`,
  );
  const job = await api.call<Job>(`/projects/${project.id}/deployments`, {
    method: 'POST',
    body: {
      buildTokenId: token.id,
      idempotencyKey: crypto.randomUUID(),
      confirmCharges: true,
      inspectedCommit: plan.commit,
      confirmResources: plan.resources.length > 0,
      confirmContainers: plan.containers.length > 0,
      workerName,
    },
  });
  io.out(
    `Deploying ${plan.branch} at ${plan.commit.slice(0, 7)} to https://${workerName}.${subdomain}.workers.dev (build token: ${token.name})`,
  );
  await follow(io, api, project, job);
}

// Logs --------------------------------------------------------------------------------

type LogEvent = {
  id: string;
  timestamp: number;
  level: string;
  message: string;
  status: number | null;
};
function minutes(since: string | undefined) {
  if (!since) return 60;
  const m = /^(\d+)\s*(m|min|h|d)?$/i.exec(since.trim());
  if (!m) throw new CliError('Use --since like 30m, 2h or 1d.', 2);
  const value =
    Number(m[1]) *
    ({ m: 1, min: 1, h: 60, d: 1440 }[(m[2] ?? 'm').toLowerCase()] ?? 1);
  if (value < 5 || value > 3 * 1440)
    throw new CliError('--since takes 5 minutes to 3 days.', 2);
  return value;
}
async function logs(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const span = minutes(text(args.flags.since));
  const errorsOnly = args.flags.errors ? '&errors=1' : '';
  const seen = new Set<string>();
  const show = (events: LogEvent[]) => {
    for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      io.out(
        args.flags.json
          ? JSON.stringify(e)
          : `${new Date(e.timestamp).toISOString()}  ${e.level.padEnd(5)}  ${e.status ?? '   '}  ${e.message}`,
      );
    }
  };
  const fetchEvents = async (window: number) =>
    (
      await api.call<{ events: LogEvent[] }>(
        `/projects/${project.id}/logs?minutes=${window}${errorsOnly}`,
      )
    ).events;
  const first = await fetchEvents(span);
  show(first);
  if (!args.flags.follow) {
    if (!first.length && !args.flags.json)
      io.out(
        `No log events in the last ${span} minutes. Workers Logs records requests while observability is on for the Worker.`,
      );
    return;
  }
  if (!args.flags.json) io.out('Following new events. Press Ctrl+C to stop.');
  for (;;) {
    await io.sleep(5000);
    show(await fetchEvents(5));
  }
}

async function open(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  let url = dashboard(api, project);
  if (args.flags.app) {
    const live = (await production(api, project))?.live_url;
    const latest = live
      ? null
      : (
          await api.call<{ previewUrl: string | null }[]>(
            `/projects/${project.id}/uploads`,
          )
        ).find((u) => u.previewUrl)?.previewUrl;
    if (!live && !latest)
      throw new CliError('This project has no address yet. Deploy it first.');
    url = (live ?? latest)!;
  }
  io.out(url);
  await io.open(url).catch(() => {});
}

async function setPublished(io: Io, args: Args, publish: boolean) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const result = await api.call<{ result: { url: string | null } }>(
    `/projects/${project.id}/${publish ? 'publish' : 'unpublish'}`,
    { method: 'POST', body: change() },
  );
  io.out(
    publish
      ? `Published${result.result.url ? `: ${result.result.url}` : '.'}`
      : 'Unpublished: only preview addresses work.',
  );
}

// Project management ------------------------------------------------------------------

async function linkFolder(io: Io, args: Args) {
  const api = await signedIn(io, args);
  let project = await resolveProject(io, api, args, text(args.flags.project));
  if (!project) {
    const name = projectName(io.cwd.split('/').filter(Boolean).pop() ?? '');
    if (args.flags.yes) project = await setUp(io, api, args, io.cwd);
    else if (!io.isTTY)
      throw new CliError(
        'Name the project: shipcel link --project <name> (or --yes to use this folder’s name).',
      );
    else {
      const projects = await api.call<Project[]>('/projects');
      if (projects.length)
        io.out(`Your projects: ${projects.map((p) => p.name).join(', ')}`);
      const answer =
        (await io.ask(`Link to which project? [${name}] `)).trim() || name;
      project =
        projects.find((p) => p.name === answer || p.id === answer) ??
        (await api.call<Project>('/projects', {
          method: 'POST',
          body: { name: answer, framework: 'static' },
        }));
    }
  }
  const changed = await link(io, project);
  io.out(`Linked ${io.cwd} to ${project.name} (.shipcel/project.json).`);
  if (changed) io.out(ignored);
}

async function removeProject(io: Io, args: Args, name?: string) {
  if (!name) throw new CliError('Name the project: shipcel rm <name>.', 2);
  const api = await signedIn(io, args);
  const project = await findProject(api, name);
  const job = await production(api, project).catch(() => null);
  await confirmed(io, args, `Remove ${project.name} from Shipcel?`);
  await api.call(`/projects/${project.id}`, { method: 'DELETE' });
  io.out(
    `Removed ${project.name} from Shipcel.${job ? ` Its Worker ${job.worker_name} and its data stay in your Cloudflare account; delete them there if you no longer need them.` : ''}`,
  );
  if ((await linkedProject(io)) === project.id)
    await io.fs.remove(await linkPath(io, io.cwd));
}

async function project(io: Io, args: Args) {
  const [, sub = 'ls', name] = args._;
  const api = await signedIn(io, args);
  switch (sub) {
    case 'ls':
    case 'list': {
      const projects = await api.call<Project[]>('/projects');
      if (args.flags.json) io.out(JSON.stringify(projects));
      else if (!projects.length)
        io.out('No projects yet. Run shipcel deploy, or shipcel init.');
      else
        for (const line of table([
          ['NAME', 'FRAMEWORK', 'SOURCE', 'ID'],
          ...projects.map((p) => [
            p.name,
            p.framework,
            p.source ?? 'kit',
            p.id,
          ]),
        ]))
          io.out(line);
      return;
    }
    case 'add': {
      if (!name)
        throw new CliError('Name the project: shipcel project add <name>.', 2);
      const created = await api.call<Project>('/projects', {
        method: 'POST',
        body: { name, framework: text(args.flags.framework) ?? 'static' },
      });
      io.out(
        `Created ${created.name}. Link a folder to it with shipcel link --project ${created.name}.`,
      );
      return;
    }
    case 'rm':
    case 'remove':
      return removeProject(io, args, name);
    case 'inspect': {
      const found = await requireProject(io, api, args, name);
      const job = await production(api, found);
      if (args.flags.json) {
        io.out(JSON.stringify({ ...found, production: job }));
        return;
      }
      for (const line of table([
        ['Project', `${found.name} (${found.id})`],
        ['Framework', found.framework],
        [
          'Source',
          found.source === 'github'
            ? `GitHub · ${found.repository}`
            : 'starter kit',
        ],
        ['Free-only', found.freeOnly === false ? 'off' : 'on'],
        [
          'Deploys',
          job
            ? job.adapter === 'direct-upload'
              ? 'by upload (shipcel deploy)'
              : `from GitHub (${job.repository_name}, ${job.branch})`
            : 'not deployed yet',
        ],
        ['Worker', job?.worker_name ?? '-'],
        ['Production', job?.live_url ?? 'not public'],
        ['Dashboard', dashboard(api, found)],
      ]))
        io.out(line);
      return;
    }
    default:
      throw new CliError(
        `Unknown command project ${sub}. Run shipcel help project.`,
        2,
      );
  }
}

async function env(io: Io, args: Args) {
  const [, sub = 'ls', name] = args._;
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const build = Boolean(args.flags.build);
  const environment = args.flags.preview ? 'preview' : 'production';
  const base = build
    ? `/projects/${project.id}/build-variables`
    : `/projects/${project.id}/secrets`;
  switch (sub) {
    case 'ls':
    case 'list': {
      const rows = build
        ? (
            await api.call<{
              variables: {
                name: string;
                secret: boolean;
                value: string | null;
              }[];
            }>(`${base}?environment=${environment}`)
          ).variables.map((v) => [
            v.name,
            v.secret ? 'secret' : `plain: ${v.value ?? ''}`,
          ])
        : (await api.call<{ name: string; type: string }[]>(base)).map((s) => [
            s.name,
            s.type === 'secret_text' ? 'secret' : s.type,
          ]);
      if (args.flags.json)
        io.out(JSON.stringify(rows.map(([n, kind]) => ({ name: n, kind }))));
      else if (!rows.length)
        io.out(
          build
            ? `No ${environment} build variables.`
            : 'No secrets yet. Add one with shipcel env add <NAME>.',
        );
      else for (const line of table(rows)) io.out(line);
      return;
    }
    case 'add':
    case 'update': {
      if (!name)
        throw new CliError(`Name the variable: shipcel env ${sub} <NAME>.`, 2);
      const value = io.isTTY
        ? await io.askSecret(`Value of ${name} (hidden as you type): `)
        : (await io.stdin()).replace(/\r?\n$/, '');
      if (!value)
        throw new CliError(
          `No value for ${name}. Type it at the prompt, or pipe it in: printf %s "$VALUE" | shipcel env add ${name}`,
        );
      await api.call(base, {
        method: 'PUT',
        body: change(
          build
            ? { environment, name, value, secret: !args.flags.plain }
            : { name, value },
        ),
      });
      io.out(
        build
          ? `Set ${name} for ${environment} builds. It applies from the next build.`
          : `Set the secret ${name}. Cloudflare deployed it with the current code.`,
      );
      return;
    }
    case 'rm':
    case 'remove': {
      if (!name)
        throw new CliError('Name the variable: shipcel env rm <NAME>.', 2);
      await confirmed(io, args, `Remove ${name} from ${project.name}?`);
      await api.call(`${base}/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        body: change(build ? { environment } : {}),
      });
      io.out(`Removed ${name}.`);
      return;
    }
    case 'pull':
      return envPull(io, args, api, project, name);
    default:
      throw new CliError(
        `Unknown command env ${sub}. Run shipcel help env.`,
        2,
      );
  }
}

// Postgres and MySQL through Hyperdrive (worker/hyperdrive.ts). The connection string is read
// like a secret, never from the command line, and goes to Cloudflare only.
async function hyperdrive(io: Io, args: Args) {
  const [, sub = 'ls', binding] = args._;
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const base = `/projects/${project.id}/hyperdrive`;
  type Config = {
    id: string;
    binding: string;
    scheme: string;
    host: string;
    database: string;
    snippet: string;
  };
  const listed = async () =>
    (await api.call<{ configs: Config[] }>(base)).configs;
  switch (sub) {
    case 'ls':
    case 'list': {
      const configs = await listed();
      if (args.flags.json) io.out(JSON.stringify(configs));
      else if (!configs.length)
        io.out(
          'No Postgres or MySQL databases yet. Add one with shipcel hyperdrive add <BINDING>.',
        );
      else
        for (const line of table([
          ['BINDING', 'KIND', 'HOST', 'DATABASE', 'ID'],
          ...configs.map((c) => [
            c.binding,
            c.scheme,
            c.host,
            c.database,
            c.id,
          ]),
        ]))
          io.out(line);
      return;
    }
    case 'add': {
      if (!binding)
        throw new CliError(
          'Name the binding: shipcel hyperdrive add <BINDING>.',
          2,
        );
      const connectionString = io.isTTY
        ? await io.askSecret(
            `Connection string for ${binding} (postgres://user:password@host:5432/database, hidden as you type): `,
          )
        : (await io.stdin()).replace(/\r?\n$/, '');
      if (!connectionString)
        throw new CliError(
          `No address for ${binding}. Type it at the prompt, or pipe it in: printf %s "$DATABASE_URL" | shipcel hyperdrive add ${binding}`,
        );
      const made = await api.call<Config>(base, {
        method: 'POST',
        body: { binding, connectionString, confirm: true },
      });
      io.out(
        `Added ${made.binding}: ${made.scheme} at ${made.host}/${made.database}, through Hyperdrive configuration ${made.id}.`,
      );
      io.out(
        `Put this in wrangler.json(c), beside the other bindings, and deploy:\n  ${made.snippet}\nYour code reads env.${made.binding}.connectionString.`,
      );
      return;
    }
    case 'rm':
    case 'remove': {
      if (!binding)
        throw new CliError(
          'Name the binding: shipcel hyperdrive rm <BINDING>.',
          2,
        );
      const found = (await listed()).find((c) => c.binding === binding);
      if (!found)
        throw new CliError(`${binding} isn’t a database of ${project.name}.`);
      await confirmed(
        io,
        args,
        `Remove ${binding} (${found.scheme} at ${found.host}) from ${project.name}? The database itself stays where it is hosted.`,
      );
      await api.call(`${base}/${encodeURIComponent(found.id)}`, {
        method: 'DELETE',
      });
      io.out(
        `Removed ${binding}. Take its hyperdrive entry out of wrangler.json(c) before the next deploy.`,
      );
      return;
    }
    default:
      throw new CliError(
        `Unknown command hyperdrive ${sub}. Run shipcel help hyperdrive.`,
        2,
      );
  }
}

async function domains(io: Io, args: Args) {
  const [, sub = 'ls', hostname] = args._;
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const base = `/projects/${project.id}/domains`;
  const attached = () => api.call<{ id: string; hostname: string }[]>(base);
  switch (sub) {
    case 'ls':
    case 'list': {
      const list = await attached();
      if (args.flags.json) io.out(JSON.stringify(list));
      else if (!list.length)
        io.out(
          'No custom domains. Add one with shipcel domains add <hostname>.',
        );
      else for (const d of list) io.out(`https://${d.hostname}`);
      return;
    }
    case 'add': {
      if (!hostname)
        throw new CliError(
          'Name the hostname: shipcel domains add <hostname>.',
          2,
        );
      const wanted = hostname.toLowerCase();
      // The account's zone that covers the hostname, the most specific one first.
      const zones: { id: string; name: string }[] = [];
      for (let page: number | null = 1; page;) {
        const data: {
          zones: { id: string; name: string }[];
          nextPage: number | null;
        } = await api.call(`/projects/${project.id}/zones?page=${page}`);
        zones.push(...data.zones);
        page = data.nextPage;
      }
      const zone = zones
        .filter((z) => wanted === z.name || wanted.endsWith(`.${z.name}`))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone)
        throw new CliError(
          `None of the active zones in this Cloudflare account covers ${wanted}. Add the domain to Cloudflare first.`,
        );
      await api.call(base, {
        method: 'POST',
        body: change({ hostname: wanted, zoneId: zone.id }),
      });
      io.out(
        `Added https://${wanted} (zone ${zone.name}). Cloudflare issues its certificate in a few minutes.`,
      );
      return;
    }
    case 'rm':
    case 'remove': {
      if (!hostname)
        throw new CliError(
          'Name the hostname: shipcel domains rm <hostname>.',
          2,
        );
      const domain = (await attached()).find(
        (d) => d.hostname === hostname.toLowerCase(),
      );
      if (!domain)
        throw new CliError(`${hostname} isn’t attached to ${project.name}.`);
      await confirmed(
        io,
        args,
        `Detach ${domain.hostname} from ${project.name}?`,
      );
      await api.call(`${base}/${domain.id}`, {
        method: 'DELETE',
        body: change(),
      });
      io.out(`Detached ${domain.hostname}.`);
      return;
    }
    default:
      throw new CliError(
        `Unknown command domains ${sub}. Run shipcel help domains.`,
        2,
      );
  }
}

async function activity(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const events =
    await api.call<{ kind: string; projectName: string; createdAt: string }[]>(
      '/activity',
    );
  if (args.flags.json) {
    io.out(JSON.stringify(events));
    return;
  }
  const kinds: Record<string, string> = {
    'project.created': 'created',
    'kit.exported': 'kit exported',
    'project.deleted': 'removed',
  };
  if (!events.length) io.out('Nothing yet.');
  else
    for (const line of table(
      events.map((e) => [
        `${ago(e.createdAt)} ago`,
        kinds[e.kind] ?? e.kind,
        e.projectName,
      ]),
    ))
      io.out(line);
}

// Containers need Cloudflare's Workers Paid plan and bill by use, so the project of an app that
// runs them can't be Free-only. Turning that off is the person's decision, asked once.
async function offFreeOnly(io: Io, args: Args, what: string) {
  if (args.flags.yes) {
    if (!args.flags.json)
      io.out(
        `${what} runs containers: its project is created with Free-only off.`,
      );
    return;
  }
  if (!io.isTTY || args.flags.json)
    throw new CliError(
      `${what} runs containers, which need Cloudflare’s Workers Paid plan and bill by use, so its project can’t be Free-only. Pass --yes to create it with Free-only off.`,
    );
  if (
    !yes(
      await io.ask(
        `${what} runs containers, which need Cloudflare’s Workers Paid plan ($5 a month) and bill by use, so its project can’t be Free-only. Create it with Free-only off? [y/N] `,
      ),
      false,
    )
  )
    throw new CliError('Nothing was created.');
}

async function init(io: Io, args: Args) {
  let kit = args._[1];
  if (!kit) {
    io.out('Starter kits:');
    for (const line of table(
      frameworks.map((k) => [`  ${k.id}`, k.name, k.subtitle]),
    ))
      io.out(line);
    if (!io.isTTY)
      throw new CliError('Choose one: shipcel init <kit> [folder].', 2);
    kit = (await io.ask('Which kit? ')).trim();
  }
  if (!frameworks.some((k) => k.id === kit))
    throw new CliError(
      `There is no starter kit ${kit}. Kits: ${frameworks.map((k) => k.id).join(', ')}.`,
      2,
    );
  const folder = args._[2] ?? `${kit}-app`;
  const dir = resolve(io.cwd, folder);
  if ((await io.fs.exists(dir)) && (await io.fs.readdir(dir)).length)
    throw new CliError(`${folder} already exists and isn’t empty.`);
  const containers = usesContainers(kit);
  if (containers) await offFreeOnly(io, args, `The ${kit} starter kit`);
  const api = await signedIn(io, args);
  const created = await api.call<Project>('/projects', {
    method: 'POST',
    body: {
      name: projectName(folder.split('/').filter(Boolean).pop() ?? kit),
      framework: kit,
      source: 'kit',
      ...(args.flags.database ? { database: true } : {}),
      ...(containers ? { freeOnly: false } : {}),
    },
  });
  const zip = unzipSync(await api.download(`/projects/${created.id}/export`));
  let count = 0;
  for (const [path, data] of Object.entries(zip)) {
    // Every file is under <project name>/ in the archive.
    const inner = path.split('/').slice(1).join('/');
    if (!inner || path.endsWith('/')) continue;
    if (inner.split('/').some((part) => part === '..' || part === ''))
      throw new CliError(`The kit contains an unsafe path: ${path}.`);
    const target = join(dir, inner);
    await io.fs.mkdir(target.slice(0, target.lastIndexOf('/')));
    await io.fs.writeFile(target, new TextDecoder().decode(data));
    count++;
  }
  await link(io, created, dir);
  io.out(
    `Created ${created.name} from the ${kit} starter kit: ${count} files in ${folder}.`,
  );
  // A container runs locally with Docker, and a service with its database too.
  io.out(
    containers
      ? `Next: cd ${folder} && npm install`
      : `Next: cd ${folder} && npm install && npm run dev`,
  );
  io.out(
    kit === 'static'
      ? 'Deploy it: shipcel deploy public --prod'
      : kit === 'python'
        ? 'Deploy it: push the folder to GitHub, then run shipcel git connect in it (README.md has the steps).'
        : containers
          ? 'Deploy it: push the folder to GitHub, then run shipcel git connect in it; Cloudflare’s builds deploy its container (README.md has the steps).'
          : `Deploy it: cd ${folder} && shipcel. To deploy every push instead, push it to GitHub and run shipcel git connect.`,
  );
}

// Vercel's alias: on Cloudflare a custom domain belongs to the app and serves its
// production version, so this is `domains` under another name.
async function alias(io: Io, args: Args) {
  const [, sub = 'ls', first, second] = args._;
  const as = (...rest: string[]) => domains(io, { ...args, _: rest });
  if (sub === 'ls' || sub === 'list') return as('domains', 'ls');
  if (sub === 'rm' || sub === 'remove')
    return as('domains', 'rm', ...(first ? [first] : []));
  // alias set <domain>, alias set <version> <domain>, and Vercel's alias <version> <domain>.
  const [version, domain] =
    sub === 'set'
      ? second
        ? [first, second]
        : [undefined, first]
      : [sub, first];
  if (!domain)
    throw new CliError('Name the domain: shipcel alias set <domain>.', 2);
  if (version) {
    const api = await signedIn(io, args);
    const project = await requireProject(io, api, args);
    const target = findVersion(await versionsOf(api, project), version);
    if (target.live !== 100)
      throw new CliError(
        `A custom domain serves the app’s production version, and ${target.id.slice(0, 8)} isn’t it. Promote it first: shipcel promote ${target.id.slice(0, 8)}. Then add the domain.`,
      );
  }
  return as('domains', 'add', domain);
}

async function gitList(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const [job, { link }] = await Promise.all([
    production(api, project),
    api.call<{ link: ActionsLink | null }>(
      `/projects/${project.id}/github-actions`,
    ),
  ]);
  io.out(
    link
      ? `${project.name} deploys ${link.repository} with GitHub Actions: ${link.branch} to production, other branches as previews. Runs: ${link.actionsUrl}`
      : job && job.adapter !== 'direct-upload'
        ? `${project.name} deploys ${job.repository_name} on every push to ${job.branch}.`
        : project.source === 'github' && project.repository
          ? `${project.name} is set up for ${project.repository.replace('https://github.com/', '')} and hasn’t deployed from GitHub yet. Run shipcel git connect.`
          : `${project.name} isn’t connected to a Git repository: it deploys from this computer. To deploy every push, run shipcel git connect.`,
  );
}

// Stops a repository's pushes from deploying. Its workflow stays in the repository: Shipcel
// changes nothing there, and says where to delete it.
async function gitDisconnect(io: Io, args: Args) {
  const api = await signedIn(io, args);
  const project = await requireProject(io, api, args);
  const { link } = await api.call<{ link: ActionsLink | null }>(
    `/projects/${project.id}/github-actions`,
  );
  if (!link) {
    const job = await production(api, project);
    throw new CliError(
      job && job.adapter !== 'direct-upload'
        ? 'Cloudflare holds the connection that builds every push: remove it in the Cloudflare dashboard, under the Worker’s Settings → Builds. The project stays in Shipcel.'
        : `${project.name} isn’t connected to a Git repository.`,
    );
  }
  await confirmed(
    io,
    args,
    `Stop deploying ${link.repository} to ${project.name}?`,
  );
  await api.call(`/projects/${project.id}/github-actions`, {
    method: 'DELETE',
  });
  io.out(
    `Disconnected ${link.repository}: its pushes don’t deploy ${project.name} anymore. Its workflow is still in the repository; delete it there: ${link.workflowUrl}`,
  );
}

// Run ---------------------------------------------------------------------------------

const COMMANDS = new Set([
  'deploy',
  'build',
  'git',
  'promote',
  'rollback',
  'redeploy',
  'list',
  'ls',
  'versions',
  'inspect',
  'logs',
  'open',
  'publish',
  'unpublish',
  'init',
  'link',
  'project',
  'projects',
  'create',
  'remove',
  'rm',
  'env',
  'domains',
  'hyperdrive',
  'activity',
  'login',
  'logout',
  'whoami',
  'help',
  'dev',
  'pull',
  'alias',
  'crons',
  'rolling-release',
  'rr',
  'metrics',
  'analytics',
  'budget',
  'curl',
  'httpstat',
  'api',
  'mcp',
  'agent',
  'upgrade',
  'telemetry',
  'signup',
  'switch',
  'teams',
]);

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.flags.version) {
      io.out(VERSION);
      return 0;
    }
    const cwd = text(args.flags.cwd);
    if (cwd) io = { ...io, cwd: resolve(io.cwd, cwd) };
    let command = args._[0];
    if (command === 'help' || args.flags.help) {
      const topic = command === 'help' ? args._[1] : command;
      const key = topic ? (ALIASES[topic] ?? topic) : undefined;
      io.out((key && COMMAND_HELP[key]) || HELP);
      return 0;
    }
    // Like Vercel: no command, or a folder, deploys.
    if (
      !command ||
      (!COMMANDS.has(command) && (await io.fs.exists(resolve(io.cwd, command))))
    ) {
      args._.unshift('deploy');
      command = 'deploy';
    }
    switch (command) {
      case 'login':
        await login(io, args);
        break;
      case 'logout': {
        const config = await readConfig(io);
        await writeConfig(io, { url: config.url });
        io.out(
          'Signed out on this computer. Revoke the token under API & CLI in the dashboard to cancel it everywhere.',
        );
        break;
      }
      case 'whoami': {
        const api = await signedIn(io, args);
        const me = await api.call<Me>('/me');
        io.out(`Signed in as ${me.login} (${me.role}) on ${api.url}.`);
        const connections = await api
          .call<Connections>('/connections')
          .catch(() => null);
        const account = connections?.cloudflare.connected
          ? connections.cloudflare.account
          : null;
        if (connections)
          io.out(
            `Workspace: ${me.workspaceName ?? 'this workspace'} · Cloudflare: ${account ? account.name : 'not connected (run shipcel login)'}`,
          );
        break;
      }
      case 'deploy':
        await deploy(io, args);
        break;
      case 'build':
        await buildOnly(io, args);
        break;
      case 'git':
        if (args._[1] === 'ls' || args._[1] === 'list') {
          await gitList(io, args);
          break;
        }
        if (args._[1] === 'disconnect') {
          await gitDisconnect(io, args);
          break;
        }
        if (args._[1] !== 'connect')
          throw new CliError(
            'Use shipcel git connect, git ls or git disconnect. Run shipcel help git for details.',
            2,
          );
        await gitConnect(io, await signedIn(io, args), args);
        break;
      case 'promote':
        await promote(io, args);
        break;
      case 'rollback':
        await rollback(io, args);
        break;
      case 'redeploy':
        await redeploy(io, args);
        break;
      case 'list':
      case 'ls':
      case 'versions':
        await list(io, args);
        break;
      case 'inspect':
        await inspect(io, args);
        break;
      case 'logs':
        await logs(io, args);
        break;
      case 'open':
        await open(io, args);
        break;
      case 'publish':
      case 'unpublish':
        await setPublished(io, args, command === 'publish');
        break;
      case 'init':
        await init(io, args);
        break;
      case 'link':
        await linkFolder(io, args);
        break;
      case 'projects':
        args._.splice(0, 1, 'project', 'ls');
        await project(io, args);
        break;
      case 'project':
        await project(io, args);
        break;
      case 'create': {
        // The earlier form of project add, which also links the folder.
        const name = args._[1];
        if (!name)
          throw new CliError(
            'Give the project a name: shipcel create <name>.',
            2,
          );
        const api = await signedIn(io, args);
        const created = await api.call<Project>('/projects', {
          method: 'POST',
          body: { name, framework: text(args.flags.framework) ?? 'static' },
        });
        const changed = await link(io, created);
        io.out(`Created ${created.name} and linked this folder to it.`);
        if (changed) io.out(ignored);
        break;
      }
      case 'remove':
      case 'rm':
        await removeProject(io, args, args._[1]);
        break;
      case 'env':
        await env(io, args);
        break;
      case 'domains':
        await domains(io, args);
        break;
      case 'hyperdrive':
        await hyperdrive(io, args);
        break;
      case 'activity':
        await activity(io, args);
        break;
      case 'dev':
        await dev(io, (await readLink(io)).settings?.outputDirectory);
        break;
      case 'pull': {
        const api = await signedIn(io, args);
        await envPull(
          io,
          args,
          api,
          await requireProject(io, api, args),
          args._[1],
        );
        break;
      }
      case 'alias':
        await alias(io, args);
        break;
      case 'crons': {
        const api = await signedIn(io, args);
        await crons(io, args, api, await requireProject(io, api, args));
        break;
      }
      case 'rolling-release':
      case 'rr': {
        const api = await signedIn(io, args);
        const project = await requireProject(io, api, args);
        const versions = await versionsOf(api, project);
        await rollingRelease(io, args, api, project, versions, (ref) =>
          findVersion(versions, ref),
        );
        break;
      }
      case 'metrics':
      case 'analytics': {
        const api = await signedIn(io, args);
        await metrics(io, args, api, await requireProject(io, api, args));
        break;
      }
      case 'budget': {
        const api = await signedIn(io, args);
        const project = await requireProject(io, api, args);
        await budget(io, args, api, project, dashboard(api, project));
        break;
      }
      case 'curl':
      case 'httpstat': {
        const api = await signedIn(io, args);
        const project = await requireProject(io, api, args);
        // Versions are only read when one is named.
        const versions = args.flags.deployment
          ? await versionsOf(api, project)
          : [];
        await curl(
          io,
          args,
          await production(api, project),
          (ref) => findVersion(versions, ref),
          command === 'httpstat',
        );
        break;
      }
      case 'api':
        await apiCall(io, args, await signedIn(io, args));
        break;
      case 'mcp':
        await mcp(io, args, baseUrl(io, await readConfig(io), args.flags.url));
        break;
      case 'agent':
        await agentInit(io, args);
        break;
      case 'upgrade':
        await upgrade(
          io,
          args,
          baseUrl(io, await readConfig(io), args.flags.url),
          VERSION,
        );
        break;
      case 'telemetry':
        io.out(
          'shipcel collects no telemetry: nothing about how you use it is sent anywhere.',
        );
        break;
      case 'signup':
        io.out(
          'Signing in with GitHub creates your Shipcel account; there is nothing else to sign up for.',
        );
        await login(io, args);
        break;
      case 'switch': {
        const api = await signedIn(io, args);
        const me = await api.call<Me>('/me');
        io.out(
          `You are signed in to ${me.workspaceName ?? 'this workspace'} as ${me.login} (${me.role}). A sign-in works in one workspace.`,
        );
        if (!io.isTTY) {
          io.out(
            'To work in another, run shipcel switch in a terminal and choose the workspace on the page that opens. shipcel teams ls lists yours.',
          );
          break;
        }
        io.out('Choose the workspace on the page that opens.');
        await login(io, args);
        break;
      }
      case 'teams':
        await teams(io, args, await signedIn(io, args));
        break;
      case 'tokens':
        await tokens(io, args, await signedIn(io, args));
        break;
      case 'bisect': {
        const api = await signedIn(io, args);
        const project = await requireProject(io, api, args);
        const [versions, job] = await Promise.all([
          versionsOf(api, project),
          production(api, project),
        ]);
        await bisect(io, args, versions, job, (ref) =>
          findVersion(versions, ref),
        );
        break;
      }
      case 'storage':
      case 'blob': {
        const api = await signedIn(io, args);
        await storage(io, args, api, await requireProject(io, api, args));
        break;
      }
      case 'usage':
        await usage(io, args, await signedIn(io, args));
        break;
      case 'dns':
        await dnsCommand(io, args, await signedIn(io, args));
        break;
      case 'cache': {
        const api = await signedIn(io, args);
        await cache(io, args, api, await requireProject(io, api, args));
        break;
      }
      case 'security': {
        const api = await signedIn(io, args);
        await security(io, args, api, await requireProject(io, api, args));
        break;
      }
      case 'redirects':
        await redirects(io, args);
        break;
      case 'alerts': {
        const api = await signedIn(io, args);
        await alerts(
          io,
          args,
          api,
          args.flags.all ? null : await resolveProject(io, api, args),
        );
        break;
      }
      case 'webhooks': {
        const api = await signedIn(io, args);
        await webhooks(
          io,
          args,
          api,
          args.flags.all ? null : await resolveProject(io, api, args),
          () => api.call<Project[]>('/projects'),
        );
        break;
      }
      case 'pricing': {
        // Works signed out: the address only adds a link to the site's table.
        let url: string | null = null;
        try {
          url = baseUrl(io, await readConfig(io), args.flags.url);
        } catch {
          url = null;
        }
        pricing(io, args, url);
        break;
      }
      default:
        throw new CliError(
          `Unknown command ${command}. Run shipcel --help.`,
          2,
        );
    }
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof CliError ? error.code : 1;
  }
}
