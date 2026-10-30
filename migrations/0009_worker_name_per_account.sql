-- Worker names are unique per Cloudflare account, not across Cloudcel. Imports that keep
-- their configured name (Next.js) need this. SQLite cannot drop a column constraint, so
-- the table is rebuilt; its indexes and the monthly-limit trigger are recreated below.
CREATE TABLE deployment_jobs_rebuilt (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, created_by TEXT NOT NULL,
 cf_grant_id TEXT NOT NULL, gh_grant_id TEXT NOT NULL, account_id TEXT NOT NULL,
 repository_id TEXT NOT NULL, repository_name TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL,
 build_token_uuid TEXT NOT NULL, worker_name TEXT NOT NULL, build_command TEXT NOT NULL,
 status TEXT NOT NULL, step TEXT NOT NULL DEFAULT 'queued', error TEXT,
 worker_tag TEXT, repo_connection_uuid TEXT, trigger_uuid TEXT, build_uuid TEXT, live_url TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 deploy_command TEXT, adapter TEXT NOT NULL DEFAULT 'configured-worker',
 resources_json TEXT NOT NULL DEFAULT '[]', observed_resources_json TEXT NOT NULL DEFAULT '[]',
 monitor_started_at INTEGER, recovery_note TEXT,
 UNIQUE(workspace_id,idempotency_key), UNIQUE(account_id,worker_name)
);
INSERT INTO deployment_jobs_rebuilt (id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,error,worker_tag,repo_connection_uuid,trigger_uuid,build_uuid,live_url,lease_until,idempotency_key,created_at,updated_at,deploy_command,adapter,resources_json,observed_resources_json,monitor_started_at,recovery_note)
SELECT id,workspace_id,project_id,created_by,cf_grant_id,gh_grant_id,account_id,repository_id,repository_name,branch,commit_sha,build_token_uuid,worker_name,build_command,status,step,error,worker_tag,repo_connection_uuid,trigger_uuid,build_uuid,live_url,lease_until,idempotency_key,created_at,updated_at,deploy_command,adapter,resources_json,observed_resources_json,monitor_started_at,recovery_note FROM deployment_jobs;
DROP TABLE deployment_jobs;
ALTER TABLE deployment_jobs_rebuilt RENAME TO deployment_jobs;
CREATE UNIQUE INDEX project_active_job ON deployment_jobs(project_id) WHERE status IN ('queued','provisioning','building');
CREATE INDEX job_workspace ON deployment_jobs(workspace_id,created_at DESC);
CREATE UNIQUE INDEX workspace_active_pipeline ON deployment_jobs(workspace_id) WHERE status IN ('queued','provisioning','building');
CREATE TRIGGER enforce_monthly_pipeline_limit BEFORE INSERT ON deployment_jobs
WHEN (SELECT COUNT(*) FROM deployment_jobs WHERE workspace_id=NEW.workspace_id AND created_at>=CAST(strftime('%s','now','start of month') AS INTEGER)) >= COALESCE((SELECT monthly_pipeline_limit FROM workspace_limits WHERE workspace_id=NEW.workspace_id),10)
BEGIN SELECT RAISE(ABORT,'CLOUDCEL_PIPELINE_LIMIT'); END;
