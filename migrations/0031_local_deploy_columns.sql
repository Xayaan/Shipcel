-- A security review of deploys from a computer added three columns to local_deploys: the
-- sign-in that opened the deploy, the Worker's tag when it was reviewed, and the resources
-- the person agreed Cloudflare may create. Migration 0030 was still being written then, so
-- a database may hold the table with or without them. A row lives for the hour its deploy
-- is open, and no deploy from a computer had run when this was written: the table is made
-- again in its final form, which brings every database to the same place.
DROP TABLE IF EXISTS local_deploys;
CREATE TABLE local_deploys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  -- 1: a production deploy; 0: a preview version that serves no production traffic.
  production INTEGER NOT NULL,
  -- 1: this deploy creates the Worker.
  first INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'deployed', 'failed')),
  secret_hash TEXT NOT NULL,
  -- The sign-in that opened it: "pat:<token id>" for an API token, a browser session's
  -- hash otherwise. The deploy ends when that sign-in does.
  opened_with TEXT,
  operation_id TEXT NOT NULL,
  -- The Worker's tag when the deploy was reviewed; NULL for a new app.
  worker_tag TEXT,
  -- The app's reviewed resources; the ones the person agreed Cloudflare may create now;
  -- and the ones this deploy has created.
  resources_json TEXT NOT NULL,
  create_json TEXT NOT NULL DEFAULT '[]',
  created_json TEXT NOT NULL DEFAULT '[]',
  upload_token TEXT,
  completion_token TEXT,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  version_id TEXT,
  -- 1 once the uploaded version serves production.
  live INTEGER NOT NULL DEFAULT 0,
  -- The workers.dev address as the deploy left it: 1 on, 0 off, NULL untouched.
  published INTEGER,
  -- 1: the configuration says nothing about observability, so Workers Logs stay on.
  keep_logs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX local_deploys_project ON local_deploys(project_id, created_at DESC);
