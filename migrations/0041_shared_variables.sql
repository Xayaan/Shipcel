-- A workspace's shared variables (worker/shared-variables.ts): a secret set on several of its
-- projects' Workers at once. Shipcel keeps the name and when each project last got the value,
-- never the value itself.
CREATE TABLE shared_variables (
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, name)
);
CREATE TABLE shared_variable_projects (
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, name, project_id)
);
CREATE INDEX shared_variable_projects_project ON shared_variable_projects(project_id);
