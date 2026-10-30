-- Hyperdrive configurations Shipcel made in the customer's account: a Postgres or MySQL
-- database elsewhere, reached through Cloudflare. The address's password went to Cloudflare
-- and is never kept here.
CREATE TABLE hyperdrive_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  binding TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('postgres', 'mysql')),
  host TEXT NOT NULL,
  database TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, binding)
);
