# Set up Shipcel

Two ways to run it: on your computer, to try the dashboard and work on the code, or hosted in your own Cloudflare account, as shipcel.com is.

## On your computer

Needs Node.js 24 and npm 11 (Wrangler comes with the project).

```sh
git clone <this repository> shipcel && cd shipcel
npm install
npm run db:migrate      # a local D1 database, through Wrangler
npm run dev             # http://127.0.0.1:5173 : the site at /, the dashboard at /app/
```

The first `npm run dev` writes an ignored `.dev.vars` with an encryption key of its own. Local mode signs you in to a local workspace with no accounts. To deploy real apps from it, open **Connections** in the dashboard and set up sign-in apps for GitHub and Cloudflare; the page walks you through it, and [docs/provider-setup.md](docs/provider-setup.md) has the details.

Checks, in the order the CI runs them:

```sh
npm test                  # unit tests (Vitest)
npm run check             # TypeScript
npm run format:check      # Prettier
npm run build             # the Worker, the CLI and the site
npm run test:browser      # browser journeys (Playwright, needs Chrome)
```

Optional, slower: `npm run verify:frameworks` deploys every starter kit and import adapter against Cloudflare's local runtime (needs Docker and uv), and `npm run verify:kits` checks the starter kits.

## Hosted, in your Cloudflare account

A hosted Shipcel needs a custom domain on a zone in your Cloudflare account. Set your domain in `wrangler.jsonc`'s `production` environment (`name`, `routes`, `APP_ORIGIN`), then:

```sh
npm run production:setup
```

It signs Wrangler in to Cloudflare in your browser, creates the D1 database, applies the migrations, builds and deploys, and makes the secrets it needs (an encryption key, a private GitHub App, a private Cloudflare OAuth client), sending each straight to Cloudflare. Every step is explained in [docs/guides/self-hosting.md](docs/guides/self-hosting.md), with the manual route. Run it again to deploy a newer version; nothing is asked twice.

When a newer version asks Cloudflare for a permission the OAuth client didn't have (Hyperdrive Write, added on 28 October 2026 for Postgres and MySQL), run `npm run production:setup -- --cloudflare-permissions`: it asks for a temporary API token with OAuth Client Write, adds the missing permissions to the client, and saves the new scope list; everyone then connects Cloudflare again in Connections to grant them.

Before you run it:

- `wrangler.jsonc`'s `POSTHOG_KEY` is shipcel.com's analytics key: remove it, or put your own PostHog project's key there, or your visitors are counted in shipcel.com's analytics.
- Private apps sign in only you and your account's members. When you open sign-ups, make the GitHub App and the Cloudflare OAuth client public (the Cloudflare one needs your domain verified with a DNS record, and the change is permanent).

## Configuration

| Setting                                                                       | What it is                                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `AUTH_MODE`                                                                   | `github` for a hosted Shipcel; unset for local mode                        |
| `APP_ORIGIN`                                                                  | the exact `https://` address of your Shipcel                               |
| `TOKEN_ENCRYPTION_KEY`                                                        | 64 hexadecimal characters; protects the GitHub and Cloudflare tokens       |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`                 | the GitHub App                                                             |
| `CLOUDFLARE_CLIENT_ID`, `CLOUDFLARE_CLIENT_SECRET`, `CLOUDFLARE_OAUTH_SCOPES` | the Cloudflare OAuth client                                                |
| `NATIVE_BUILDS_ENABLED`                                                       | `true` to let Shipcel create things in people's Cloudflare accounts        |
| `POSTHOG_KEY`, `POSTHOG_REGION`                                               | optional visitor analytics (PostHog, cookieless); nothing loads without it |
| `NOTIFY_EMAIL`, `NOTIFY_FROM`                                                 | optional email notifications: an Email Service binding and its sender      |

Secrets go to Cloudflare with `wrangler secret put --env production`, never into the repository; locally they live in the ignored `.dev.vars`.

Email notifications need a sender. Onboard its domain in the Cloudflare dashboard (**Compute → Email Service → Email Sending → Onboard Domain**; it must use Cloudflare DNS, and Email Sending needs Workers Paid), then add to `wrangler.jsonc`'s `production` environment `"send_email": [{ "name": "NOTIFY_EMAIL" }]` and, under `vars`, `"NOTIFY_FROM": "notifications@your-domain"`, and deploy. Without them, projects get webhook and Telegram notifications, and the dashboard says email isn't set up.
