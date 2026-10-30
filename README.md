# Shipcel

Deploy websites and apps into your own Cloudflare account, with no infrastructure code. Push to GitHub, run `shipcel`, drop a folder or ask your AI agent; get previews, rollbacks, databases, file storage, sign-in and realtime for your users, and a budget guard. Everything runs in your Cloudflare account, and Shipcel itself is free as a launch offer: the only bill you can get is Cloudflare's, at Cloudflare's prices.

Live at [shipcel.com](https://shipcel.com) (alpha). Docs at [shipcel.com/docs](https://shipcel.com/docs/).

[![The Shipcel dashboard: a project's builds, analytics, visitors and budget guard, recorded with sample data](https://media.shipcel.com/tour.webp)](https://media.shipcel.com/tour.webm)

A one-minute tour of the dashboard, recorded with sample data ([watch it](https://media.shipcel.com/tour.webm)): a build and its log, analytics, visitors, and the budget guard.

## What it does

- Deploys from GitHub (GitHub Actions in your repository), from your terminal (`shipcel`), by drag and drop, or from Claude Code, Codex, Cursor and other agents through an MCP server.
- A preview address for every branch and pull request, one-click rollback, traffic splitting, a health check after every deploy.
- SQL databases (D1), file storage (R2) and key-value data (KV), created after you review them; migrations, exports, point-in-time restore, a table browser and SQL console. Postgres or MySQL hosted anywhere, through Hyperdrive.
- Sign-in for your users (passkeys, GitHub, Google, emailed links and passwords through Cloudflare's Email Service) and realtime channels, running in your account.
- Containers on Workers Paid: a starter kit for your own Dockerfile, and Umami and n8n as ready-made services.
- Free-only mode and a budget guard, so a bug that loops can't become a bill.

Every feature, with its status: [shipcel.com/features](https://shipcel.com/features/).

## Use it

```sh
npm install -g https://shipcel.com/cli/shipcel.tgz
shipcel login
cd my-app && shipcel
```

Guides: [docs/guides](docs/guides/), starting with [getting started](docs/guides/getting-started.md). AI agents start at [shipcel.com/llms.txt](https://shipcel.com/llms.txt): how to install, sign in and deploy, and every guide as Markdown.

## Run it yourself

[SETUP.md](SETUP.md): a Shipcel on your computer in a few minutes, and your own hosted Shipcel on Cloudflare with one command.

## Pricing

Shipcel is free, as a launch offer: no plan to pick, no card. Your apps run on Cloudflare's free plan, or on Cloudflare's Workers Paid plan ($5 a month per Cloudflare account) when an app needs more. Cloudflare charges that, at its list prices, with no markup. The full table and worked examples: [shipcel.com/pricing](https://shipcel.com/pricing/).

## Status and roadmap

Alpha: everything here is built and tested, and deploys from GitHub, the terminal and drag-and-drop have gone to real Cloudflare accounts; a few parts rest on Cloudflare betas. [ROADMAP.md](ROADMAP.md) lists what's next, and [shipcel.com/compare/coolify](https://shipcel.com/compare/coolify/) sets Shipcel beside Coolify.

## Development

```sh
npm install && npm run db:migrate && npm run dev   # http://127.0.0.1:5173
npm test && npm run check && npm run format:check && npm run build
npm run test:browser                               # 74 journeys, needs Chrome
```

- `worker/`: the API, a Hono app on Cloudflare Workers with D1. `src/`: the dashboard (React). `kits/`: the App catalog, one file per starter kit. `packages/cli/`: the `shipcel` command. `site/`: the public site's generator (output in `public/`). `media/`: the front page's tour, kept in R2 (`npm run media:publish`). `shared/`: code both sides use. `docs/`: guides, research and verification records. `tests/`: unit tests (Vitest) and browser journeys (Playwright).
- [HANDOFF.md](HANDOFF.md) is the project's full record: every decision, what's verified live and what isn't. [AGENTS.md](AGENTS.md) holds the working rules.

## Contributing

Issues and pull requests are welcome. Starter kits are the easiest place to start: the App catalog is one file per kit in [`kits/`](kits/), and [Add a starter kit](docs/guides/add-a-starter-kit.md) shows how to write one and check it.

Before you open a pull request:

- **One change, with its tests.** Logic gets a unit test (Vitest, in `tests/`); a new screen or flow gets a browser journey (Playwright, in `tests/browser/`).
- **Run the checks.** `npm test`, `npm run check` and `npm run format:check`; for a kit, also `npm run verify:kits -- <id>` with `npm run dev` running.
- **Say what you verified, and what you didn't.** A real Cloudflare account, Docker or an email sender are often out of reach: say so, as Shipcel's own pages do.
- **Write for people.** Plain sentences in the dashboard's names, no marketing words. Prices and limits come from the provider's own page, linked.
- **No secrets.** Never commit a token, an account ID or a `.dev.vars` file.

## License

To be chosen before the open-source release (see [ROADMAP.md](ROADMAP.md)).
