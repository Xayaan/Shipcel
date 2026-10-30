# Troubleshooting

What the most common messages mean and what to do about them. Shipcel always says what it checked; when an operation was interrupted, **Check Cloudflare** finds out what actually happened in your account.

## Connecting accounts

**"Connect GitHub first" when connecting Cloudflare.** Cloudflare is connected to a GitHub workspace, so sign in with GitHub first (Connections), then connect Cloudflare as the workspace owner.

**A repository is missing from the list.** Shipcel sees only repositories its GitHub App can read and that you can push to. Use **Choose which repositories Shipcel can see** to add it on GitHub, then open the list again. Archived repositories can't be deployed.

**"Cloudflare denied access" or "reconnect Cloudflare".** The connection expired or lacks a permission; the message includes Cloudflare's own reason. Disconnect and connect Cloudflare again in Connections, then select the account.

**"Your Cloudflare connection can update Workers but not create new ones".** Shipcel's OAuth client was set up with _Workers Editor_, which can't create Workers. On Connections, **Update Cloudflare sign-in** with a temporary API token (_Account · OAuth Client · Edit_), then connect Cloudflare again.

## Deploying from GitHub

**A GitHub Actions run of the Shipcel workflow fails.** Open it on GitHub (the project's **Runs on GitHub**): the last lines say why.

- _Shipcel refused GitHub’s token for this run: …_: the reason follows. "It was made for another address than …" means the workflow's `SHIPCEL_URL` isn't your Shipcel's address; "it was used already" means the job ran twice with one token: re-run it.
- _… isn’t linked to a project in this Shipcel_: the repository was disconnected, or connected to another Shipcel. Connect it on the project's Deployments tab, or delete `.github/workflows/shipcel.yml`.
- _This GitHub Actions job can’t sign in to Shipcel_: the workflow lost `permissions: id-token: write`. Put it back, or connect the repository again to get Shipcel's workflow.
- _This GitHub Actions run is for a branch other than the production branch…_: branches deploy previews only, and previews start after the first production deploy. Push to the default branch first.
- _The person who linked … can no longer deploy_ or _… has moved to another owner_: connect the repository again.
- Anything else is the same as a deploy from your computer: see [The CLI](#the-cli).

**"Shipcel's GitHub App isn't installed on …" or "… is installed on …, but not for …".** The app commits the workflow only where it is installed. Install it on the repository's owner, or add the repository to the installation, on the page the message links, then connect again (`shipcel git connect`, or **connect again** in the dashboard). Signing in can work without it: GitHub shows Shipcel other installations you can see, such as one on a repository you collaborate on.

**"GitHub didn't accept a commit" or "GitHub didn't let Shipcel add the workflow".** The default branch is protected, or Shipcel's GitHub App can't write workflows (its owner gives it read and write access to Contents and Workflows on GitHub, and each installation accepts the change). **Add it on GitHub** opens GitHub's page with the workflow filled in.

**"Repository needs configuration".** The list under it says what's missing. The usual ones:

- _Commit a wrangler.json or wrangler.jsonc at the repository root_: Shipcel didn't recognise the repository as a site it can build (Vite, Create React App, Vue CLI, Astro, Gatsby or plain HTML), so it needs a configuration of its own. See [Deploy from GitHub](deploy-from-github.md#what-a-repository-needs).
- _Commit package-lock.json_: run `npm install` and commit the lockfile. Sites accept pnpm, Yarn and Bun lockfiles too; apps with a Wrangler configuration need npm for now.
- _Keep one package manager’s lockfile_: the repository has, say, `pnpm-lock.yaml` and `yarn.lock`. Delete the one you don't use and push. When one of them is `package-lock.json`, a site builds with npm instead, and the plan only warns.
- _Shipcel couldn’t read where Vite writes the build_: `build.outDir` or `root` in `vite.config` is computed. Use a plain string, or commit a `wrangler.jsonc` whose `assets.directory` is the build folder.
- _This repository does not depend on …_: the project's runtime doesn't match the repository. Create the project again and choose the runtime it uses.
- _Configure the … adapter once_: run the command it names (often `npx wrangler setup`), review the changes and commit them.

Fix it, push, and click **Check again**.

**No build tokens** (Cloudflare's own builds). Add one on Connections: the Cloudflare card's **Create the token in Cloudflare** opens Cloudflare with everything filled in, and you paste the token once. See [Add a build token](deploy-from-github.md#add-a-build-token).

**"Cloudflare can't read …"** (Cloudflare's own builds). Cloudflare builds with its own GitHub app, connected in Cloudflare's dashboard: **Connect GitHub in Cloudflare** opens **Create application**, where you choose **GitHub** and **Install & Authorize** _Cloudflare Workers and Pages_ for your account and repositories. If it's connected but leaves this repository out, **Repository access on GitHub** adds it. Still unreadable? Cloudflare's own advice is to uninstall _Cloudflare Workers and Pages_ on GitHub and connect it again from the dashboard. Shipcel checks again when you come back. A deployment that stopped while connecting the repository shows Cloudflare's reason: fix it, then **Check Cloudflare and resume**.

**"Cloudflare didn’t accept this token".** Paste a user API token (My Profile → API Tokens), not an account-owned one, exactly as Cloudflare showed it, and check that it's active and hasn't expired.

**"Claim a workers.dev subdomain".** The account has none yet: claim one on the Deployments tab. It's free and used by every app in the account.

**The first build failed.** Open **Build logs & future deployments** to see Cloudflare's log. Fix the repository and push: the trigger builds again. If the deployment says it **needs attention**, **Check Cloudflare and resume** continues from where it stopped.

**"This project already has a deployment pipeline".** A project deploys one repository. Create another project for another repository.

## Deploying folders

**"… has no index.html".** For a folder you named, you're probably deploying the source; the CLI suggests the build folder it found (`dist`, `build`…). After a build, the build wrote somewhere else: say where with `--output <folder>`. Pass `--yes` to deploy it anyway.

**"Shipcel doesn’t recognise how this project builds".** The project has a `build` script but isn't one of the frameworks the CLI knows. Name the folder the build writes: `shipcel --output <folder>` (and `--build-command "<command>"` if `npm run build` isn't it). The answer is saved for later deploys.

**"This is a … app, which renders on a server" or "its own Wrangler configuration".** The CLI builds and uploads static sites. Server apps and Workers with bindings are built by Cloudflare from GitHub: `shipcel git connect`. If the build writes a static export, name its folder with `--output`.

**"… failed (exit code …). Nothing was deployed."** Your install or build command failed; its own output is just above. Fix it, or change the command with `--build-command`, and run `shipcel` again.

**"… is a project’s source, not built files".** `shipcel deploy <folder>` uploads a folder as it is. To build a project in another folder, run `shipcel --cwd <folder>`.

**"Not public yet".** A new app starts unpublished. `shipcel deploy --prod`, `shipcel promote <version>` or **Publish** makes it public.

**"A Worker named … already exists in this Cloudflare account".** Shipcel never takes over a Worker it didn't create. Choose another app name with `--name`.

## The CLI

**"Your Shipcel token is no longer valid".** It was revoked or expired: run `shipcel login`.

**"Cloudflare isn’t connected yet" or "Shipcel deploys into your own Cloudflare account, and it isn’t connected yet".** In a terminal the CLI opens the page that connects it and waits; otherwise open the address it prints, connect Cloudflare, and run the command again. The CLI's token belongs to the workspace you approved it in, and only an owner of that workspace can connect Cloudflare.

**"This Shipcel has no GitHub sign-in yet" on the page `shipcel login` opens.** A Shipcel on your own computer needs its GitHub App and Cloudflare sign-in set up once, on **Connections** (see [Self-hosting](self-hosting.md)). Then run `shipcel login` again.

**"The sign-in code expired".** Codes last ten minutes. Run `shipcel login` again; if the browser was already signed in, only **Approve** is left.

**`shipcel git connect` keeps "Waiting for Cloudflare to see the repository".** Cloudflare's own GitHub app can't read it yet: follow the steps the CLI printed (see ["Cloudflare can't read …"](#deploying-from-github) above). Ctrl+C is safe; run the command again later. If Cloudflare's dashboard already lists the repository, `shipcel git connect --skip-checks` starts anyway.

**"Could not reach Shipcel at http://127.0.0.1:5173. Is it running?"** The Shipcel on your computer isn't started (it stops when its terminal is closed or the computer restarts). In the Shipcel folder run `npm run dev`, leave it running, and run the command again in another terminal.

**"Not signed in" in CI.** Set `SHIPCEL_URL` and `SHIPCEL_TOKEN`, with a token from **API & CLI**.

**A command asks "Pass --yes to confirm".** Commands that change something ask first in a terminal; in scripts, add `--yes`.

- **"The app in … can't deploy yet"** followed by a list: Shipcel reviewed the Wrangler configuration in that folder and found settings it doesn't deploy from a computer (routes, queues, bindings to existing databases or other Workers, containers). Remove them, or deploy the app from GitHub. Nothing was built or created. The first line names the folder and the file it read: if that isn't your app (the command ran one folder too high, say), `cd` into the app's folder and run it again.
- **"This deploy creates … in your Cloudflare account. Pass --yes to confirm in scripts."** The app declares a D1 database, KV namespace or R2 bucket that doesn't exist yet. In a terminal the CLI asks; in a script, `--yes` agrees.
- **"This is a Next.js app, which needs its Cloudflare adapter…"** The framework renders on a server and the project has no adapter or Wrangler configuration yet. In a terminal the CLI asks once and adds them; in a script, pass `--yes`.
- **"OpenNext … builds Next.js 16.4.0, but every request then fails"**: update Cloudflare's Next.js adapter (`npm install @opennextjs/cloudflare@latest`): 1.20.13 runs Next.js 16.4. **"next.config turns on cacheComponents"**: the adapter can't run Cache Components yet, so remove `cacheComponents` and `partialPrefetching` from `next.config.ts`. Shipcel stops before deploying an app that would answer errors; run `shipcel` again after the change. The setup it already did stays.
- **"Next.js … has critical security advisories"**: that Next.js release has the advisories published on 22 October 2026. Update to the release the note names (`npm install next@16.4`, or `next@15.5` on 15.x).
- **"Wrangler’s setup has no Cloudflare adapter for this … app"** or **"can’t configure this … app"**. Wrangler doesn't know the framework, or this version of it; its own output says which. Nothing in the project was changed. Add the framework's Cloudflare adapter and a `wrangler.jsonc` by hand (the framework's Cloudflare guide has the steps), or, for an app that builds to static files, name the folder: `shipcel deploy --output <folder>`.
- **A Cloudflare sign-in page opens in the browser during a deploy.** That is Wrangler's own sign-in, and `shipcel` never needs it: close the tab. It happens when Wrangler's setup is run by hand (`npx wrangler setup`) for a Next.js app; let `shipcel` run it instead.
- **A line that starts with "Shipcel:" in Wrangler's output** means Shipcel refused one of Wrangler's calls: the app's build added something the review didn't cover (a binding that isn't declared in `wrangler.jsonc` with only its name, for example). The message says what; declare it in the configuration and deploy again.
- **"Shipcel: this deploy session is no longer open."** A deploy has an hour, and ends early when the sign-in that started it ends (its API token is revoked or expires), when another deploy of the project takes over, or when the workspace's Cloudflare connection changes. Run `shipcel` again.
- **"Shipcel: the Worker … changed in Cloudflare since this deploy was reviewed."** The Worker was deleted or recreated in Cloudflare while the deploy was running. Run `shipcel` again; it reviews the app against what is there now.
- **"Shipcel: the app’s code is larger than 32 MB."** That is the built Worker (its code and modules), not the app's files, which upload separately and may be larger. Trim what the build bundles, or deploy the app from GitHub (`shipcel git connect`).
- **"Shipcel: Too many requests."** A deploy makes a few dozen calls; this many in a minute means several are running at once. Wait a minute and deploy again.
- **"The deploy from a computer stopped before the app was uploaded."** Wrangler failed; its own output above says why. Run `shipcel` again: a database it had already created is used, not created twice.
- **"The deploy from a computer uploaded version … and then stopped reporting back."** The deploy reached Cloudflare, but the computer went away before Shipcel could record it, so the project's deploy history doesn't list it. The message says whether production serves that version; `shipcel ls` shows it either way. Nothing needs repairing: deploy again when you're ready.
- **"Another deploy of this project is in progress."** One deploy of a project runs at a time. If the other one's computer went away, try again in two minutes.
- **"This project is an app with code or bindings that Wrangler deploys…"** A folder of files (drag and drop, `shipcel deploy dist`) can't replace such an app: run `shipcel` in the app's own folder.
- **"Types at worker-configuration.d.ts are out of date"** while building a SvelteKit app. Its build checks the types Wrangler generates, and they change once a first build has written the app. `shipcel` makes them again before each build; if you build by hand, run `npm run gen` first.
- **"Heads up: … answers 500"** after a deploy. The deploy went through, but the new version fails at its home page. `shipcel logs --since 10m` shows the error; `shipcel rollback` sends production back to the version before. "didn't answer within 24 seconds" usually means a brand-new address that isn't up yet: open it again in a minute.
- **"Preview: none"**, or a version's preview address answers Cloudflare's 404 page. Cloudflare gives no preview addresses to a Worker that has a Durable Object. The version exists and can be made production with `shipcel promote <version>`; it just can't be opened on its own.
- **"npm install failed" after "Cannot read properties of null (reading 'edgesOut')" or "Unable to resolve reference".** npm 10 (the one that comes with Node.js 22) can't install some of today's apps (Nuxt 4.6, Angular 21, Analog 2.8 in October 2026). npm 11 can: `npm install -g npm@11`, or Node.js 24, which comes with it; then run `shipcel` again.
- **"pnpm isn't installed on this computer"** (or Yarn, or Bun). The project's lockfile names that package manager. Install it, or delete its lockfile to use npm.
- **"This folder has lockfiles for npm and pnpm"**. Some templates ship a lockfile for another package manager than the one their README tells you to use. Delete the lockfile of the one you don't use, then run `shipcel` again.
- **An Angular app answers 400 "Header "host" with value "…" is not allowed".** Angular renders pages only for the hosts in `angular.json` (`security.allowedHosts`). The CLI adds your workers.dev addresses when it sets the app up; add a custom domain there yourself, then deploy again.
- **`shipcel logs` shows nothing for an app Wrangler deploys.** Logs stay on unless the app's `wrangler.jsonc` sets `observability` to off; remove that setting and deploy again.

## Free-only

**"R2 file storage can bill beyond its free tier" or "Containers need Cloudflare's Workers Paid plan".** The project is Free-only. If you accept the charges, an owner can turn Free-only off in the project's **Billing** panel. See [Free-only and billing](free-only-and-billing.md).

## The budget guard

- **The app answers 503 "This app is paused: it went over its budget in Shipcel."** The budget guard paused it: the month's estimate went over a budget set to pause. The Billing panel shows what cost the money. Fix the cause, raise the budget or switch it to alerts only, then **Resume**; deploy the fix right after. Deploys to production say "This project is paused for going over its budget" until then.
- **"The budget guard can't read … usage from Cloudflare".** Shipcel's Cloudflare sign-in can't read analytics: it needs the Account Analytics Read permission. Update the Cloudflare sign-in in Connections, then connect Cloudflare again. Until then the guard can't alert or pause.
- **"Cloudflare didn't report D1 rows read, …, so the estimate may be low".** Cloudflare's analytics left out a product for your account. The rest of the estimate stands; check that product's usage in Cloudflare's dashboard.
- **"Couldn't pause the app"**, with the app still running. Cloudflare refused the change, or the Worker isn't the one Shipcel deployed any more. Stop it in Cloudflare's dashboard (Workers → the app → Settings), then look at the project's operations in Manage.
- **Cloudflare plan: "Unknown, estimated as Workers Paid".** Shipcel's sign-in doesn't have Billing Read. Nothing is wrong: on Workers Free the estimate still shows $0 unless R2 is used.

## Still stuck

The project's Manage tab records every operation with its result. Cloudflare's dashboard shows the same Worker, builds and resources Shipcel created, under your account.
