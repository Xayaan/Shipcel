-- Branch previews run as a separate pipeline (own Worker, trigger, and resources) through the
-- same job state machine. Production queries filter environment='production'.
ALTER TABLE deployment_jobs ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';
