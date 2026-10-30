-- Where a project starts: a Cloudcel starter kit, or a GitHub repository chosen when it was
-- created ('kit' | 'github', checked by the API). Projects that already name a repository
-- were created for, or linked to, a GitHub repository.
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'kit';
UPDATE projects SET source = 'github' WHERE repository <> '';
