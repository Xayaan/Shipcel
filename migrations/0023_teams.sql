-- Teams: workspaces people share, with three roles. Owners run the team, its connections and
-- its billing switches; developers create, deploy and manage projects; viewers read (the
-- former "member" role). SQLite cannot change a CHECK constraint, so the table is rebuilt.
CREATE TABLE memberships_rebuilt (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'developer', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);
INSERT INTO memberships_rebuilt (workspace_id, user_id, role)
SELECT workspace_id, user_id, CASE role WHEN 'member' THEN 'viewer' ELSE role END FROM memberships;
DROP TABLE memberships;
ALTER TABLE memberships_rebuilt RENAME TO memberships;
CREATE INDEX membership_user ON memberships(user_id);
-- Personal workspaces come from GitHub sign-in; teams are created in Cloudcel.
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'team'));
-- An invitation link is bound to one GitHub login and stored only as a hash.
CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  login TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'developer', 'viewer')),
  code_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_by TEXT,
  accepted_at INTEGER
);
CREATE INDEX invitation_workspace ON workspace_invitations(workspace_id, created_at DESC);
