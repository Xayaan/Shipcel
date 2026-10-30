-- Recovery restarts the 45-minute monitoring window without changing created_at,
-- which the monthly pipeline limit counts. recovery_note explains the last attempt.
ALTER TABLE deployment_jobs ADD COLUMN monitor_started_at INTEGER;
ALTER TABLE deployment_jobs ADD COLUMN recovery_note TEXT;
