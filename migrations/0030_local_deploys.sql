-- Apps with code, databases and other bindings, deployed from a person's computer: the
-- cloudcel CLI builds there and runs Wrangler, and for that one deploy Wrangler reaches
-- Cloudflare through Cloudcel, which holds the connection and checks every call. One row per
-- deploy. `secret_hash` is the hash of the token Wrangler presents; Cloudflare's upload
-- tokens are stored sealed and cleared when the deploy ends.
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
  operation_id TEXT NOT NULL,
  -- The app's reviewed resources, and the ones this deploy has created.
  resources_json TEXT NOT NULL,
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
-- How a project that deploys from a computer is built: NULL for a folder of files, or the
-- adapter of an app Wrangler deploys (configured-worker, nextjs, astro, sveltekit, python).
ALTER TABLE deployment_jobs ADD COLUMN local_adapter TEXT;
-- 0031 makes local_deploys again with three more columns.
