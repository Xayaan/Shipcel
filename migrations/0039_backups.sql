-- Scheduled copies of a project's D1 database in an R2 bucket of the customer's own account
-- (worker/backups.ts): one schedule per project, and each copy, from Cloudflare's export to the
-- object it became. A stopped schedule has no next_at, and keeps the bucket Shipcel made.
CREATE TABLE backup_schedules (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  binding TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  keep INTEGER NOT NULL CHECK (keep BETWEEN 1 AND 90),
  bucket TEXT NOT NULL,
  next_at INTEGER,
  last_error TEXT,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX backup_schedules_due ON backup_schedules(next_at);
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  binding TEXT NOT NULL,
  database_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('exporting', 'storing', 'done', 'failed')),
  bookmark TEXT,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  bytes INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX backups_project ON backups(project_id, created_at);
CREATE INDEX backups_running ON backups(status, updated_at);
