# Self-hosting

Shipcel is a Cloudflare Worker with a D1 database. You can run it on your own computer to try it, or host it in a Cloudflare account of its own for your team. This guide covers both; the repository's `docs/provider-setup.md` has the detailed checklist for a hosted instance.

## Run it on your computer

You need Node.js 22 and npm.

```sh
npm install
npm run db:migrate      # creates the local database
npm run dev             # http://127.0.0.1:5173/app/
```

The first `npm run dev` creates `.dev.vars` (never commit it) with a random encryption key for the secrets Shipcel stores. On `127.0.0.1` Shipcel runs in local mode: you're signed in to a local workspace straight away, without GitHub.

## Set up sign-in from Connections

A local Shipcel creates its own GitHub App and Cloudflare OAuth client from the **Connections** page, with nothing to copy:

1. **GitHub:** **Create GitHub App on GitHub** opens GitHub with a private app filled in (for your account or an organization). Check it, click **Create GitHub App**, and you come back to Shipcel. Then **Connect GitHub** signs you in to your GitHub workspace.
2. **Cloudflare:** create a temporary API token in Cloudflare with one permission, **Account · OAuth Client · Edit**, and paste it. Shipcel creates a private OAuth client in your account with the right address and permissions, and doesn't keep the token: delete it in Cloudflare afterwards. You can also create the client by hand and enter its details.
3. **Connect Cloudflare** (signed in with GitHub, as the workspace owner) and select the account.

Secrets from this setup are stored encrypted with the key in `.dev.vars`. Values in `.dev.vars` take precedence when set.

Shipcel asks Cloudflare for _Workers Scripts Write_ (`workers-scripts.write`), which creates Workers, not _Workers Editor_, which only updates them. A client set up before this fix shows **Update Cloudflare sign-in** on Connections: paste another temporary token, then connect Cloudflare again.

## Turn deployments on

Deployments that create resources in Cloudflare are off until you turn them on, so a new instance can't create anything by accident:

```sh
# in .dev.vars
NATIVE_BUILDS_ENABLED=true
```

Restart `npm run dev` afterwards.

## Host it

A hosted Shipcel needs:

| Setting                                                                       | Value                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `AUTH_MODE`                                                                   | `github`                                                                              |
| `APP_ORIGIN`                                                                  | its exact `https://` address                                                          |
| `TOKEN_ENCRYPTION_KEY`                                                        | 64 hexadecimal characters (a Worker secret)                                           |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`                 | its GitHub App                                                                        |
| `CLOUDFLARE_CLIENT_ID`, `CLOUDFLARE_CLIENT_SECRET`, `CLOUDFLARE_OAUTH_SCOPES` | its Cloudflare OAuth client; the scopes include `workers-scripts.write`               |
| `NATIVE_BUILDS_ENABLED`                                                       | `true` once a test account passes the checklist                                       |
| `POSTHOG_KEY`, `POSTHOG_REGION`                                               | optional: your PostHog project's key and region (`us` or `eu`), for visitor analytics |
| `NOTIFY_EMAIL`, `NOTIFY_FROM`                                                 | optional: the Email Service binding and sender address for email notifications        |

`wrangler.jsonc` has a `production` environment for this: set its `name`, its custom domain (`routes`) and `APP_ORIGIN` to your address. Its `POSTHOG_KEY` is shipcel.com's own: remove it, or put your PostHog project's key there, or your visitors are counted in shipcel.com's analytics. Then one command does the rest, from your terminal, in the Cloudflare account Wrangler signs in to:

```sh
npm run production:setup
```

It signs Wrangler in (in your browser), creates the D1 database and writes its ID into `wrangler.jsonc`, applies the migrations, builds with `CLOUDFLARE_ENV=production` and deploys. Then it makes the secrets and sends them straight to Cloudflare (`wrangler secret bulk`), without showing them or writing them down:

- **The encryption key.** Keep nothing: if it's lost, set up sign-in and connect accounts again.
- **A private GitHub App**, created on GitHub's own page, which your browser opens: check it and click _Create GitHub App_.
- **A private Cloudflare OAuth client**, created with a temporary API token you paste: one permission, _Account · OAuth Client · Edit_ (Cloudflare also calls it _OAuth Clients Write_), with your account included under _Account Resources_. Delete the token afterwards.

The app asks for read and write access to Contents and Workflows, so Shipcel can add its deploy workflow to the repositories people connect. An app made before 23 Oct 2026 asked for Contents read only: open its settings on GitHub → **Permissions & events**, set Contents and Workflows to read and write, save, and accept the change on each installation.

Each secret is saved as soon as it's made. If a run stops after GitHub created the app, run it again with the app's name, as in its address (`github.com/apps/<name>`): `npm run production:setup -- --github-app <name>`. It asks for the app's Client ID and a new client secret, which you generate on the app's settings page.

The address must be a custom domain on a zone in that Cloudflare account, with no other DNS record for it. Private apps and clients sign in only you and your account's members; making them public is a step for when you open sign-ups. Use a Cloudflare account dedicated to Shipcel's own data if you can, and set budget alerts.

To set it up by hand instead, put the client secrets and the key in Worker secrets with `wrangler secret put --env production`, set the D1 database ID, apply the migrations to it (`wrangler d1 migrations apply <database> --remote --env production`), then build with `CLOUDFLARE_ENV=production npm run build` and run `wrangler deploy`. `npm run setup:check` reports what a local Shipcel is missing.

For email notifications, onboard the sender's domain in the Cloudflare dashboard (**Compute → Email Service → Email Sending → Onboard Domain**, a Workers Paid feature), then add `"send_email": [{ "name": "NOTIFY_EMAIL" }]` and a `NOTIFY_FROM` variable with the sender address to the `production` environment, and deploy. Without them, the dashboard offers webhooks and Telegram only.

The dashboard is served at `/app/`, the public site at `/`, the CLI at `/cli/shipcel.tgz` and the MCP server at `/mcp`. A cron trigger advances deployments every minute while nobody has the dashboard open.

## Updating

Pull the new version, run `npm install`, apply new migrations (`npm run db:migrate` locally), and deploy: for a hosted Shipcel, `npm run production:setup` again applies its new migrations and deploys, asking nothing it already has. Migrations are never rewritten, only added.
