ALTER TABLE deployment_jobs ADD COLUMN resources_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE deployment_jobs ADD COLUMN observed_resources_json TEXT NOT NULL DEFAULT '[]';
