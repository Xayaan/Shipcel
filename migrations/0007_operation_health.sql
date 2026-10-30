-- Health tracking after Cloudcel-started redeploys (kind build) and version promotions
-- (kind promotion). target is the build UUID or version ID. status: pending, healthy,
-- unhealthy, build_failed, unknown. step: build, probe.
CREATE TABLE operation_health (
 operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
 account_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
 status TEXT NOT NULL, step TEXT NOT NULL, detail TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, checked_at INTEGER,
 lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX operation_health_pending ON operation_health(status, checked_at);
