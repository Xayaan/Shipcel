import { useState } from 'react';
import { Bot, KeyRound, MessageSquareText, Plug } from 'lucide-react';
import { CopyButton } from './Developers';
import './developers.css';

type Client = 'claude' | 'codex' | 'cursor' | 'other';
const clients: { id: Client; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'other', label: 'Other agents' },
];

function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <div className="agent-snippet">
      <pre className="snippet">{text}</pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

// Build with AI agents: Shipcel runs no model. People connect the agent they already use
// to Shipcel's MCP server with an API token.
export function AgentsPanel({ onTokens }: { onTokens: () => void }) {
  const [client, setClient] = useState<Client>('claude');
  const endpoint = `${location.origin}/mcp`;
  const json = (server: Record<string, unknown>) =>
    JSON.stringify({ mcpServers: { shipcel: server } }, null, 2);

  return (
    <div className="developers agents">
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <Bot size={18} aria-hidden="true" /> Your agent, your Cloudflare
            account
          </h2>
        </div>
        <p>
          Shipcel doesn&apos;t run an AI model. Connect the coding agent you
          already use and it can create projects, deploy, publish and roll back
          for you, in your own Cloudflare account. It works through
          Shipcel&apos;s MCP server with a token you control: it can&apos;t
          create tokens, connect accounts or turn Free-only off, and you can
          revoke its token at any time.
        </p>
        <p>
          Chat apps that add connectors by address (Claude.ai, ChatGPT) sign in
          with OAuth instead: give them <code>{location.origin}/mcp</code>,
          allow the connection on the page Shipcel opens, and the agent gets a
          token of its own for 90 days, listed under API &amp; CLI. Nothing to
          copy.
        </p>
      </section>

      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <KeyRound size={18} aria-hidden="true" /> 1. Create a token for your
            agent
          </h2>
        </div>
        <p>
          Create an API token, then keep it in an environment variable named{' '}
          <code>SHIPCEL_TOKEN</code>, for example in your shell profile. The
          settings below read it from there, so the token never sits in a file
          you might commit.
        </p>
        <Snippet
          text="export SHIPCEL_TOKEN=cc_pat_…"
          label="Copy the environment variable line"
        />
        <button type="button" className="button primary" onClick={onTokens}>
          Create a token
        </button>
      </section>

      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <Plug size={18} aria-hidden="true" /> 2. Connect your agent
          </h2>
        </div>
        <div className="operation-nav" aria-label="Agent">
          {clients.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`button ${client === c.id ? 'primary' : 'secondary'}`}
              aria-pressed={client === c.id}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {client === 'claude' && (
          <>
            <p>In a terminal, add Shipcel for all your projects:</p>
            <Snippet
              text={`claude mcp add --transport http --scope user shipcel ${endpoint} --header "Authorization: Bearer $SHIPCEL_TOKEN"`}
              label="Copy the Claude Code command"
            />
            <p>
              Or share it with a project in <code>.mcp.json</code>; each person
              sets their own <code>SHIPCEL_TOKEN</code>:
            </p>
            <Snippet
              text={json({
                type: 'http',
                url: endpoint,
                headers: { Authorization: 'Bearer ${SHIPCEL_TOKEN}' },
              })}
              label="Copy the .mcp.json settings"
            />
            <p>
              Then run <code>/mcp</code> in Claude Code to check that shipcel is
              connected. <code>/mcp__shipcel__build_and_deploy</code> starts a
              build.
            </p>
          </>
        )}
        {client === 'codex' && (
          <>
            <p>
              Add this to <code>~/.codex/config.toml</code>. Codex reads the
              token from <code>SHIPCEL_TOKEN</code> when it starts.
            </p>
            <Snippet
              text={`[mcp_servers.shipcel]\nurl = "${endpoint}"\nbearer_token_env_var = "SHIPCEL_TOKEN"`}
              label="Copy the Codex settings"
            />
          </>
        )}
        {client === 'cursor' && (
          <>
            <p>
              Add this to <code>~/.cursor/mcp.json</code> for all projects, or
              to <code>.cursor/mcp.json</code> in one project:
            </p>
            <Snippet
              text={json({
                url: endpoint,
                headers: { Authorization: 'Bearer ${env:SHIPCEL_TOKEN}' },
              })}
              label="Copy the Cursor settings"
            />
          </>
        )}
        {client === 'other' && (
          <>
            <p>
              Any MCP client that connects over Streamable HTTP and can send a
              header works. Shipcel speaks MCP 2026-07-28 and the 2025
              revisions.
            </p>
            <Snippet
              text={`URL: ${endpoint}\nHeader: Authorization: Bearer <your token>`}
              label="Copy the connection details"
            />
            <p>
              Connectors that sign in with OAuth instead of a token, such as
              those added in a chat app&apos;s settings, aren&apos;t supported
              yet.
            </p>
          </>
        )}
      </section>

      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <MessageSquareText size={18} aria-hidden="true" /> 3. Ask for what
            you want
          </h2>
        </div>
        <ul className="agent-examples">
          <li>
            “Build a one-page site for my bakery and deploy it with Shipcel.
            Show me the preview before publishing.”
          </li>
          <li>“Deploy this repository’s dist folder to my-site.”</li>
          <li>“Roll my-site back to the previous version.”</li>
          <li>“Add my weather API key to my-site as WEATHER_KEY.”</li>
        </ul>
        <p>
          The agent can list and create projects; deploy files as a new version,
          unpublished at a preview address until you publish; publish or
          unpublish an app; list versions and roll back; set runtime secrets
          (values are never shown back); and look up sign-in &amp; realtime
          details. Agents that can run commands can also use the{' '}
          <a href="#developers">shipcel CLI</a> for whole build folders. Apps
          with databases or other bindings deploy from Git.
        </p>
      </section>
    </div>
  );
}
