-- Free-only projects: Cloudcel refuses anything Cloudflare can bill for (R2 buckets and
-- containers). New projects start Free-only; projects that already use R2 or containers
-- start with it off so nothing they rely on is blocked.
ALTER TABLE projects ADD COLUMN free_only INTEGER NOT NULL DEFAULT 1 CHECK (free_only IN (0, 1));

UPDATE projects SET free_only = 0
WHERE storage_enabled = 1
  OR framework = 'docker'
  OR id IN (
    SELECT project_id FROM deployment_jobs
    WHERE adapter = 'container' OR resources_json LIKE '%"type":"r2"%'
  );
