-- Deploy notifications: one webhook per project. Its address and signing secret are
-- encrypted (webhook addresses often embed credentials); only the host is kept in clear.
CREATE TABLE project_webhooks (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  url_sealed TEXT NOT NULL,
  host TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  events_json TEXT NOT NULL,
  last_status TEXT,
  last_error TEXT,
  last_sent_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The outbox the scheduled handler delivers from, with retries.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
