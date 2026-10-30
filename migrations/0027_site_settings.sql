-- A site deployed without a Wrangler configuration of its own: the preset, build folder and
-- single-page-app setting Cloudcel reviewed, as JSON, so production and branch previews write
-- the same configuration during their builds. NULL for every other adapter.
ALTER TABLE deployment_jobs ADD COLUMN site_json TEXT;
