-- Parameters recorded when an operation starts (never secret values), so an interrupted
-- operation can be checked against Cloudflare later. reconciled_at marks that check.
ALTER TABLE project_operations ADD COLUMN intent_json TEXT;
ALTER TABLE project_operations ADD COLUMN reconciled_at INTEGER;
