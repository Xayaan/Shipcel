# Teams and tokens

Work with other people in a shared workspace, give each the access they need, and let the CLI, scripts and AI agents act for you with API tokens.

## Workspaces

Everything in Shipcel belongs to a workspace: projects, connections and tokens. You start with a personal workspace; create a team from **Team** in the sidebar and switch between workspaces at the top of the sidebar. Each workspace connects its own GitHub and Cloudflare accounts.

## Roles

| Role      | Can                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner     | everything: connect accounts, choose the Cloudflare account, claim the `workers.dev` subdomain, turn Free-only off, notifications, the team |
| Developer | create and delete projects, deploy, every Manage operation, their own API tokens                                                            |
| Viewer    | read projects, deployments and settings                                                                                                     |

A workspace always keeps at least one owner. Nobody can leave their personal workspace.

## Invite people

**Team → Invite** creates a link for one GitHub login, with a role. It's shown once and works once, for that login, within 7 days. Owners change roles and remove people; removing someone also revokes their tokens for the workspace.

## API tokens

A token lets the CLI, a script or an AI agent act as you in one workspace. Create one under **API & CLI**: it's shown once, and Shipcel keeps only a fingerprint. A token expires in 30 days, 90 days or a year, or never, as you choose; revoke one at any time.

A token can deploy and manage projects. It can't create tokens, approve CLI sign-ins, connect or change accounts, turn Free-only off, protect previews or set up notifications: those stay in the dashboard.

`shipcel login` creates a token for you through the browser, valid for 90 days, so you don't have to copy one.

## In CI

Store a token as a secret and set `SHIPCEL_URL` and `SHIPCEL_TOKEN`; see [The CLI](cli.md#in-ci).
