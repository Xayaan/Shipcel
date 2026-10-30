-- Telegram and email beside a project's webhook (worker/notifications.ts): one of each per
-- project. The bot token and chat, and an email's link token, are kept encrypted in
-- target_sealed; `label` is what the dashboard shows (for email, the address itself). An
-- address gets notifications only once its owner confirms it through the link in
-- token_hash's email.
CREATE TABLE notification_channels (
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'email')),
  target_sealed TEXT NOT NULL,
  label TEXT NOT NULL,
  events_json TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  confirmed_at INTEGER,
  confirm_sent_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  last_sent_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind)
);
-- The outbox now holds a row per channel an event goes to.
ALTER TABLE webhook_deliveries ADD COLUMN channel TEXT NOT NULL DEFAULT 'webhook' CHECK (channel IN ('webhook', 'telegram', 'email'));
