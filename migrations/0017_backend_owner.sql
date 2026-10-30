-- Sign-in & realtime: a random suffix chosen before any resource is created. The service's
-- database is named <worker>-db-<suffix> and its Worker carries the binding
-- CLOUDCEL_BACKEND_OWNER = <project id>:<suffix>, so Cloudcel adopts only resources it can
-- prove it created, instead of trusting creation times.
ALTER TABLE project_backends ADD COLUMN resource_suffix TEXT;
