CREATE TABLE users (id TEXT PRIMARY KEY, github_id TEXT UNIQUE, login TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE memberships (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(workspace_id,user_id));
INSERT INTO users VALUES ('local-owner', NULL, 'Local workspace', 0);
INSERT INTO workspaces VALUES ('local', 'Local workspace', 0);
INSERT INTO memberships VALUES ('local', 'local-owner', 'owner');

CREATE TABLE projects_scoped (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'local', name TEXT NOT NULL,
 framework TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '', database_enabled INTEGER NOT NULL DEFAULT 0,
 storage_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 UNIQUE(workspace_id,name)
);
INSERT INTO projects_scoped(id,name,framework,repository,database_enabled,storage_enabled,created_at)
SELECT id,name,framework,repository,database_enabled,storage_enabled,created_at FROM projects;
DROP TABLE projects;
ALTER TABLE projects_scoped RENAME TO projects;
ALTER TABLE events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX project_workspace ON projects(workspace_id,created_at DESC);
CREATE INDEX event_workspace ON events(workspace_id,created_at DESC);

CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL, user_id TEXT, workspace_id TEXT, session_hash TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE provider_grants (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, provider TEXT NOT NULL,
 encrypted_tokens TEXT, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0,
 refresh_lock_until INTEGER NOT NULL DEFAULT 0, account_id TEXT, account_name TEXT, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_active_grant ON provider_grants(workspace_id,provider) WHERE status = 'active';
CREATE TABLE request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE deployment_jobs (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, created_by TEXT NOT NULL,
 cf_grant_id TEXT NOT NULL, gh_grant_id TEXT NOT NULL, account_id TEXT NOT NULL,
 repository_id TEXT NOT NULL, repository_name TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL,
 build_token_uuid TEXT NOT NULL, worker_name TEXT NOT NULL UNIQUE, build_command TEXT NOT NULL,
 status TEXT NOT NULL, step TEXT NOT NULL DEFAULT 'queued', error TEXT,
 worker_tag TEXT, repo_connection_uuid TEXT, trigger_uuid TEXT, build_uuid TEXT, live_url TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(workspace_id,idempotency_key)
);
CREATE UNIQUE INDEX project_active_job ON deployment_jobs(project_id) WHERE status IN ('queued','provisioning','building');
CREATE INDEX job_workspace ON deployment_jobs(workspace_id,created_at DESC);
