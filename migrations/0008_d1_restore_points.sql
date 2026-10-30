-- Time Travel bookmarks recorded before Cloudcel applies D1 migrations, so a migration
-- can be undone from Cloudcel. Written before any migration runs.
CREATE TABLE d1_restore_points (
 operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
 binding TEXT NOT NULL, database_id TEXT NOT NULL, bookmark TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX d1_restore_points_project ON d1_restore_points(workspace_id, project_id, binding, created_at);
