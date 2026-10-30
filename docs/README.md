# Shipcel docs

## Guides

Step-by-step guides for people who use Shipcel. The same files are published on the site at `/docs/` (`npm run site:build` renders them; `site/docs.ts` sets their order).

| Guide                                                      | What it covers                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| [Getting started](guides/getting-started.md)               | How Shipcel works, connecting accounts, the first project and deploy  |
| [The shipcel CLI](guides/cli.md)                           | Every command, with its Vercel equivalent, and CI                     |
| [Deploy from GitHub](guides/deploy-from-github.md)         | Importing a repository, what it needs, frameworks, the build pipeline |
| [Deploy without Git](guides/deploy-without-git.md)         | Drag and drop, folder uploads, `_worker.js`, publishing               |
| [Starter kits](guides/starter-kits.md)                     | The nine kits, running them locally, deploying them                   |
| [Previews and rollbacks](guides/previews-and-rollbacks.md) | Versions, preview deploys, branch previews, promote, rollback, splits |
| [Environment variables](guides/environment-variables.md)   | Secrets, build variables, local `.dev.vars`                           |
| [Domains](guides/domains.md)                               | Free `workers.dev` addresses and your own domains                     |
| [Databases and storage](guides/databases-and-storage.md)   | D1 data, migrations and backups; KV and R2                            |
| [Logs and analytics](guides/logs-and-analytics.md)         | Analytics, Workers Logs, deploy notifications                         |
| [Teams and tokens](guides/teams-and-tokens.md)             | Workspaces, roles, invitations, API tokens                            |
| [AI agents](guides/ai-agents.md)                           | The MCP server and agent setup                                        |
| [Free-only and billing](guides/free-only-and-billing.md)   | What can bill, Free-only, Cloudflare's free allowance                 |
| [Self-hosting](guides/self-hosting.md)                     | Running Shipcel locally or hosting it                                 |
| [Troubleshooting](guides/troubleshooting.md)               | What common messages mean                                             |

## For people working on Shipcel

- [Provider setup](provider-setup.md): registering the GitHub App and Cloudflare OAuth client, and the live verification checklist.
- [Direct deploys and tokens](contracts/direct-deploy-and-tokens.md): the HTTP contract the CLI, the dashboard's uploads and the MCP server use.
- [Runtime matrix](runtime-matrix.md): which runtimes are verified, and how.
- [QA report](qa-report.md): what the tests prove, and what they don't.
- [Research](research/parity.md): parity with Vercel, Supabase and Netlify; [Worker Previews](research/workers-previews.md).
- `framework-verification.json`, `starter-kit-verification.json`, `accessibility-results.json`: evidence written by the verification scripts and tests.

Writing a guide: one Markdown file in `guides/`, added to `site/docs.ts`. Start with `# Title` and a first paragraph that works as its description; use `##` sections, lists, `>` notes, fenced code and tables. Link other guides as `[label](other-guide.md#section)`. Say what is verified, and don't describe features that don't exist yet.
