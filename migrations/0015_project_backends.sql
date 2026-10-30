-- Sign-in and realtime services that Cloudcel runs in the customer's Cloudflare account.
-- Keys and secrets are never stored here: they live only in Cloudflare Worker secrets.
CREATE TABLE project_backends (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  worker_tag TEXT,
  database_id TEXT,
  client_id TEXT NOT NULL,
  version TEXT,
  status TEXT NOT NULL CHECK(status IN ('enabling','active','needs_attention')),
  error TEXT,
  url TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
