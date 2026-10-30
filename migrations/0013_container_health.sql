-- When a container deployment's homepage check first failed. A first container deployment
-- can take minutes to provision, so its health check repeats for a bounded window.
ALTER TABLE deployment_jobs ADD COLUMN health_since INTEGER;
