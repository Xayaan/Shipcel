CREATE TABLE workspace_limits (
 workspace_id TEXT PRIMARY KEY,
 plan TEXT NOT NULL DEFAULT 'free',
 project_limit INTEGER NOT NULL DEFAULT 3 CHECK(project_limit>0),
 monthly_pipeline_limit INTEGER NOT NULL DEFAULT 10 CHECK(monthly_pipeline_limit>0)
);
CREATE TRIGGER enforce_project_limit BEFORE INSERT ON projects
WHEN (SELECT COUNT(*) FROM projects WHERE workspace_id=NEW.workspace_id) >= COALESCE((SELECT project_limit FROM workspace_limits WHERE workspace_id=NEW.workspace_id),3)
BEGIN SELECT RAISE(ABORT,'CLOUDCEL_PROJECT_LIMIT'); END;
CREATE TRIGGER enforce_monthly_pipeline_limit BEFORE INSERT ON deployment_jobs
WHEN (SELECT COUNT(*) FROM deployment_jobs WHERE workspace_id=NEW.workspace_id AND created_at>=CAST(strftime('%s','now','start of month') AS INTEGER)) >= COALESCE((SELECT monthly_pipeline_limit FROM workspace_limits WHERE workspace_id=NEW.workspace_id),10)
BEGIN SELECT RAISE(ABORT,'CLOUDCEL_PIPELINE_LIMIT'); END;
CREATE UNIQUE INDEX workspace_active_pipeline ON deployment_jobs(workspace_id) WHERE status IN ('queued','provisioning','building');
