# AI agents

Let your own AI agent deploy and manage your apps: Claude Code, Codex, Cursor or any agent that speaks the Model Context Protocol (MCP). Shipcel runs no model and sees no prompts; your agent calls Shipcel's MCP server with your API token, and Shipcel does the Cloudflare side.

## What the agent can do

| Tool                                | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `list_projects`, `get_project`      | the projects in your workspace and their addresses   |
| `create_project`                    | a new project                                        |
| `deploy_files`                      | deploy files the agent wrote, like a dropped folder  |
| `publish`                           | publish or unpublish an app's address                |
| `list_deployments`, `list_versions` | what's deployed, and the versions                    |
| `rollback`                          | send traffic back to an earlier version              |
| `list_secrets`, `set_secret`        | the app's secret names, and setting one              |
| `get_signin_info`                   | how the app's users sign in, with sign-in & realtime |

There's also a `build_and_deploy` prompt: describe an app and the agent builds and deploys it. The agent acts with your token, so it can do what a token can and nothing more: see [Teams and tokens](teams-and-tokens.md#api-tokens).

## Set it up

1. Create an API token under **API & CLI** and put it in your environment as `SHIPCEL_TOKEN`.
2. Open **AI agents** in the dashboard: it shows the settings for each agent with your Shipcel's address. For example, Claude Code:

```sh
claude mcp add --transport http --scope user shipcel https://shipcel.com/mcp \
  --header "Authorization: Bearer $SHIPCEL_TOKEN"
```

Codex reads the token with `bearer_token_env_var = "SHIPCEL_TOKEN"`, and Cursor with `${env:SHIPCEL_TOKEN}` in `.cursor/mcp.json`. Every setting reads the token from your environment, so it never lands in a shared file.

## Limits

- A chat app that connects with OAuth (Claude.ai, ChatGPT: add `https://shipcel.com/mcp` as a connector) registers itself, sends you to a Shipcel page to allow it (sign in with GitHub first if needed), and gets a token of its own for 90 days, listed under **API & CLI**; connect it again after that.
- Through MCP, agents deploy files, like a folder upload. An agent that works in your terminal can deploy an app with code and a database by running `shipcel` in its folder; `shipcel agent init` writes the commands into `AGENTS.md`, and `shipcel mcp` shows how to connect an agent.
