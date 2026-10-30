-- The data API of a project's sign-in service (services/backend/src/data.ts): which of the
-- app's D1 databases the service has as DATA, by the app's binding name and its id.
ALTER TABLE project_backends ADD COLUMN data_binding TEXT;
ALTER TABLE project_backends ADD COLUMN data_database_id TEXT;
