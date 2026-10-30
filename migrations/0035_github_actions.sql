-- Deploys from GitHub Actions: a repository linked to a project. Shipcel added a workflow to
-- it that builds every push on GitHub and deploys through Shipcel, signed in by GitHub's own
-- OIDC token. One project per repository; deploys act for the person who linked it.
CREATE TABLE github_actions (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL UNIQUE,
  -- The repository's owner when it was linked: a repository moved to another owner deploys
  -- again only once it is linked again.
  owner_id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  -- Pushes to this branch deploy to production; other branches deploy previews.
  branch TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- An API token made for one GitHub Actions run reaches that project only and expires within
-- the hour; one for a branch other than the production branch deploys previews only. Tokens
-- people make have neither.
ALTER TABLE api_tokens ADD COLUMN project_id TEXT;
ALTER TABLE api_tokens ADD COLUMN preview_only INTEGER NOT NULL DEFAULT 0;
CREATE INDEX api_tokens_run_expiry ON api_tokens(expires_at) WHERE project_id IS NOT NULL;
