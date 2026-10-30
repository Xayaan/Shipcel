-- Repositories on GitLab, Bitbucket and Gitea (or Forgejo) that deploy a project from their own
-- CI (worker/git-sources.ts). A GitLab.com job signs in with GitLab's ID token: the GitLab
-- project and namespace ids are pinned by the first job. The others sign in with a deploy token.
CREATE TABLE git_sources (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gitlab', 'bitbucket', 'gitea')),
  host TEXT NOT NULL,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  remote_id TEXT,
  owner_id TEXT,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX git_sources_repository ON git_sources(host, repository);
-- A deploy token: a project's token made for a CI system, kept until it expires or is revoked
-- (a GitHub Actions or GitLab job's own token lasts an hour and isn't listed).
ALTER TABLE api_tokens ADD COLUMN deploy INTEGER NOT NULL DEFAULT 0;
-- The project a requested token deploys (shipcel tokens add --project).
ALTER TABLE cli_logins ADD COLUMN token_project TEXT;
