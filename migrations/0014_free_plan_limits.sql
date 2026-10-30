-- The Free plan never caps below Cloudflare's Workers Free plan: up to 100 projects (Cloudflare
-- allows 100 Workers per account), no monthly limit on new pipelines (Cloudflare's build minutes
-- apply), and one setup at a time (Workers Free runs one build at a time; the
-- workspace_active_pipeline index still enforces it).
DROP TRIGGER IF EXISTS enforce_project_limit;
CREATE TRIGGER enforce_project_limit BEFORE INSERT ON projects
WHEN (SELECT COUNT(*) FROM projects WHERE workspace_id=NEW.workspace_id) >= COALESCE((SELECT project_limit FROM workspace_limits WHERE workspace_id=NEW.workspace_id),100)
BEGIN SELECT RAISE(ABORT,'CLOUDCEL_PROJECT_LIMIT'); END;
DROP TRIGGER IF EXISTS enforce_monthly_pipeline_limit;
UPDATE workspace_limits SET project_limit=100 WHERE plan='free' AND project_limit<100;
