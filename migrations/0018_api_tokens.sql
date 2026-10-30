-- API tokens for the CLI, AI agents and scripts. Only a SHA-256 hash of each token is
-- stored; the token itself is shown once.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_tokens_owner ON api_tokens(workspace_id, user_id);

-- CLI sign-in by device code. The CLI holds a secret (stored hashed) and polls; the token is
-- created only when the approved CLI collects it, so no usable token is ever stored.
CREATE TABLE cli_logins (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE,
  host TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'delivered')),
  workspace_id TEXT,
  user_id TEXT,
  token_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cli_logins_expires ON cli_logins(expires_at);
