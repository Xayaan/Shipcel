-- Bindings that touch no shared data (Workers AI, browser rendering, Images, variables,
-- the app's own Durable Objects), which the previews block declares again. Recorded at the
-- last check of the repository so the dashboard shows the same snippet.
ALTER TABLE project_previews ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
