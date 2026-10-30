CREATE TABLE project_operations (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
 user_id TEXT NOT NULL, account_id TEXT NOT NULL, kind TEXT NOT NULL,
 request_key TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(workspace_id,request_key)
);
CREATE UNIQUE INDEX one_project_operation ON project_operations(project_id) WHERE status='running';
CREATE INDEX operations_workspace ON project_operations(workspace_id,project_id,created_at DESC);
ALTER TABLE deployment_jobs ADD COLUMN deploy_command TEXT;
ALTER TABLE deployment_jobs ADD COLUMN adapter TEXT NOT NULL DEFAULT 'configured-worker';
