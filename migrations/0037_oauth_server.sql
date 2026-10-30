-- OAuth for the MCP server (worker/oauth-server.ts): the clients chat apps and agents
-- register, and each authorization request from when the owner is sent to the dashboard
-- to approve until its code is exchanged for an API token.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  scope TEXT,
  resource TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used')),
  code_hash TEXT,
  workspace_id TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_requests_code ON oauth_requests(code_hash);
CREATE INDEX oauth_requests_expires ON oauth_requests(expires_at);
CREATE INDEX oauth_clients_created ON oauth_clients(created_at);
