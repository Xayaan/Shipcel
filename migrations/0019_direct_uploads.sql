-- Direct uploads (drag and drop, the cloudcel CLI, MCP): one row per upload session. The
-- Cloudflare upload and completion tokens are short-lived (one hour) and stored sealed with
-- the workspace's key; they are cleared once the upload is deployed.
CREATE TABLE direct_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'deployed', 'failed')),
  missing_json TEXT NOT NULL,
  upload_token TEXT,
  completion_token TEXT,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  has_404 INTEGER NOT NULL DEFAULT 0,
  has_index INTEGER NOT NULL DEFAULT 0,
  version_id TEXT,
  preview_url TEXT,
  url TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX direct_uploads_project ON direct_uploads(project_id, created_at DESC);
