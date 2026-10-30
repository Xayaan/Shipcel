-- Who can open a project's preview addresses: a Cloudflare Access application on the
-- production Worker's previews (destination `preview_worker`) in the customer's own Zero
-- Trust organization. The people allowed are kept in Cloudflare; Cloudcel keeps the ID.
CREATE TABLE project_access (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  worker_tag TEXT NOT NULL,
  app_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
