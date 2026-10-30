-- Branch and pull request previews use Cloudflare's Worker Previews on the production Worker
-- (`wrangler preview`) instead of a second Worker per project whose versions got alias URLs.
-- One row per project: the staging copies of its resources (proved Cloudcel's by
-- resource_suffix, recorded before anything is created) and the preview build trigger.
CREATE TABLE project_previews (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  resource_suffix TEXT NOT NULL,
  resources_json TEXT NOT NULL DEFAULT '[]',
  trigger_uuid TEXT,
  status TEXT NOT NULL CHECK (status IN ('setting_up', 'waiting_for_config', 'active', 'needs_attention', 'disabled')),
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The second-Worker design is retired; it never ran against a live account.
UPDATE deployment_jobs
SET status = 'disabled',
  error = 'Branch previews now use Cloudflare Worker Previews. Turn previews on again from the project.',
  lease_until = 0,
  updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE environment = 'preview' AND status != 'disabled';
