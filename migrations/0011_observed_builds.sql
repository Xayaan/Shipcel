-- Production builds Cloudcel has seen per project, so builds started by GitHub pushes get
-- the same follow-up health check as builds started from Manage. The first scan of a
-- project records a baseline; only builds that appear after it are checked.
CREATE TABLE observed_builds (
 build_uuid TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
 created_at INTEGER, first_seen_at INTEGER NOT NULL
);
CREATE TABLE build_scans (
 project_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
 baseline_at INTEGER NOT NULL, scanned_at INTEGER NOT NULL
);
CREATE INDEX operation_health_target ON operation_health(project_id, target);
