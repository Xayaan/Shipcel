# Getting started

Shipcel deploys and manages apps in your own Cloudflare account, the way you would on Vercel or Netlify, without writing infrastructure code. Your apps, databases and files live in your account; Shipcel sets them up and gives you one place to deploy, preview, roll back and watch them.

## How Shipcel works

- You connect two accounts: **GitHub**, to read the repositories you choose, and **Cloudflare**, to create Workers, databases and domains in the account you select.
- Every app is a Cloudflare Worker in your account. Its free address is `https://<app>.<your-subdomain>.workers.dev`; you can add your own domain later.
- Shipcel keeps a project for each app: where its code comes from, its deployments, and what you changed. Cloudflare bills you directly for anything beyond its free limits, with no markup from Shipcel.
- With **Free-only** on (the default for every project), Shipcel never creates anything Cloudflare can bill for. See [Free-only and billing](free-only-and-billing.md).

## Ways to start

| Way                 | Good for                                         | Guide                                       |
| ------------------- | ------------------------------------------------ | ------------------------------------------- |
| A GitHub repository | apps that deploy on every push                   | [Deploy from GitHub](deploy-from-github.md) |
| The `shipcel` CLI   | any site or app, built on your computer          | [The CLI](cli.md)                           |
| Drag and drop       | a built folder, from the dashboard               | [Deploy without Git](deploy-without-git.md) |
| A starter kit       | a new app, ready to run and deploy               | [Starter kits](starter-kits.md)             |
| Your AI agent       | asking Claude, Cursor or another agent to deploy | [AI agents](ai-agents.md)                   |

## The quickest start: your terminal

```sh
npm install -g https://shipcel.com/cli/shipcel.tgz
shipcel login
cd my-app && shipcel
```

`shipcel login` opens one page where you sign in with GitHub, approve the CLI and connect Cloudflare. On a Shipcel you run yourself, install the CLI from its address and add `--url` with that address the first time.

Then `shipcel` recognises your framework, builds on your computer and deploys to your Cloudflare account:

- a static site goes up as files;
- an app with code (Next.js, SvelteKit, a Worker with a database) goes through Wrangler, which the CLI runs for you;
- an app with no `wrangler.jsonc` gets one, with its framework's Cloudflare adapter, after the CLI asks once.

A new app's first deploy goes to production. After that, `shipcel` deploys a preview and `shipcel --prod` deploys to production. Nothing needs setting up in Cloudflare; [The CLI](cli.md) has every command.

## 1. Open the dashboard

The dashboard is at [shipcel.com/app/](https://shipcel.com/app/), or at `/app/` on the address of a Shipcel you run yourself. To run one on your own computer, [Self-hosting](self-hosting.md) shows how to start it.

## 2. Connect GitHub and Cloudflare

Open **Connections** in the sidebar.

1. **Connect GitHub.** You sign in with GitHub and choose which repositories Shipcel's GitHub App can read. You can change that list later on GitHub.
2. **Connect Cloudflare.** Cloudflare asks you to approve Shipcel's access. With one Cloudflare account, that's the account your apps go into; with several, you choose one.
3. If the account has no `workers.dev` subdomain yet, the first deploy asks you to claim one, such as `your-name.workers.dev`. Every app's free address uses it.

Only the account owner can connect accounts. Shipcel stores the access it receives encrypted, and you can disconnect either account at any time. `shipcel login` does steps 1 and 2 from your terminal.

## 3. Create a project

Click **New project** and choose where it starts:

- **Starter kit**: a ready-made app (React, Vue, Hono, Astro, SvelteKit, Next.js, Python, a static site or a JavaScript Worker) that you export, push to GitHub and deploy.
- **GitHub repository**: an app you already have. Shipcel lists your repositories, reads the one you choose and fills in its framework.

## 4. Deploy

- **From GitHub**, the project opens on **Deployments** with its repository chosen. Tick the box and click **Connect repository**: Shipcel adds a GitHub Actions workflow, and from then on every push deploys, the default branch to production and other branches as previews. See [Deploy from GitHub](deploy-from-github.md).
- **From your computer**, run `shipcel` in the project's folder: it builds there and deploys the result, whether the project is a site or an app with code and a database. Or drop a built folder on the project's Deployments tab.

Your app is live at its `workers.dev` address when the deployment finishes.

## 5. Manage it

The **Manage** tab of a deployed project has everything else: custom domains, secrets and build variables, the database (tables, SQL, migrations, backups), KV and R2 storage, versions and rollback, branch previews, analytics and logs, deploy notifications, and sign-in & realtime for your app's users.

## Where to go next

- [The CLI](cli.md): every command, with its Vercel equivalent.
- [Previews and rollbacks](previews-and-rollbacks.md): try changes before production, and undo them.
- [Domains](domains.md): your own domain, with its certificate.
- [Troubleshooting](troubleshooting.md): what common messages mean.
