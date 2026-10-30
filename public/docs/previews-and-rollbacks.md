# Previews and rollbacks

Try a change at its own address before it reaches production, and put production back in one step when something goes wrong. Every deploy is a Cloudflare Worker version in your account, so both are instant.

## Versions

Each deploy creates a new version of your app's Worker; Cloudflare keeps them, and production is whichever version (or two versions, in a split) currently receives traffic. You can see them in **Manage → Builds & versions → Versions and rollback**, or with `shipcel ls`:

```text
AGE  VERSION   STATUS              PREVIEW                                               MESSAGE
2m   1a2b3c4d  Preview             https://1a2b3c4d-my-site.your-name.workers.dev        Preview from Shipcel
1h   5e6f7a8b  Production 100%     https://5e6f7a8b-my-site.your-name.workers.dev        Direct upload from Shipcel
1d   9c0d1e2f  Earlier production  https://9c0d1e2f-my-site.your-name.workers.dev        Direct upload from Shipcel
```

## Preview deploys (folders)

`shipcel deploy` without `--prod` uploads a version **without deploying it**: it gets its own address, `https://<version>-<app>.<subdomain>.workers.dev`, and production keeps serving the current version. When you're happy with it:

```sh
shipcel promote 1a2b3c4d     # or its preview address
```

## Branch previews (GitHub)

For a project deployed from GitHub, turn on **Branch previews** on the Deployments tab once production is deployed: **Review preview setup**, then **Turn on previews**. Every push to another branch, including branches with pull requests, then gets a preview address that follows the branch, built by Cloudflare like production.

- Previews never use production data. If the app has a D1 database, KV namespace or R2 bucket, Shipcel creates an empty copy of each for all branch previews to share; you consent to these first.
- The Deployments tab lists recent preview builds with their addresses; turning previews off stops new ones.
- Previews use Cloudflare's Worker Previews, which Cloudflare offers as a beta.
- Pull requests from forks get no preview. Cloudflare builds branches of your repository, and building a fork's code with your build token would let anyone who opens a pull request run code with it. Push the branch to your repository to preview it.
- Next.js apps get no branch previews yet: OpenNext calls its own Worker through a service binding (`WORKER_SELF_REFERENCE`), and a service binding from a Preview reaches production. Cloudflare's way around that, `ctx.exports`, isn't in OpenNext yet (1.20.14, 28 October 2026).

## Who can open previews

Preview addresses are public by default: anyone with the link can open them. To require a sign-in, use **Manage → Domains → Who can open previews**: Shipcel puts a Cloudflare Access application in front of the previews only, allowing the email addresses and domains you list. Production stays public. This needs Cloudflare Zero Trust set up in your account (its Free plan covers 50 people); the section explains that step.

## Roll back

- **Dashboard:** Manage → Builds & versions → **Roll back to Version N** sends all traffic to the version before the one serving production. **Send all traffic to Version N** (Promote) works for any version.
- **CLI:** `shipcel rollback` goes back to the most recent earlier version that served production, skipping previews; `shipcel rollback <version>` goes to a given one.

A rollback changes which code runs. It doesn't undo database changes; restore the database separately if you need to (see [Databases and storage](databases-and-storage.md)).

## Split traffic

**Split traffic** sends 1–99% of requests to one version and the rest to the live one, to try a release on part of your traffic. Cloudflare allows two versions in a split. Shipcel checks that the version serves its share after the change.

## Health checks

After a promotion, rollback, split or build, Shipcel checks that the expected version is serving and that the homepage answers, and shows the result with the operation. Deploy notifications can send failures to Slack, Discord or any webhook: see [Logs and analytics](logs-and-analytics.md).
