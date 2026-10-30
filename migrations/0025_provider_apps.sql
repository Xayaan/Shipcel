-- The GitHub App and Cloudflare OAuth client a local Cloudcel signs in with, when they were
-- set up from the Connections page instead of .dev.vars (which takes precedence). One row per
-- provider for the whole instance; the client secret is encrypted with TOKEN_ENCRYPTION_KEY.
CREATE TABLE provider_apps (
  provider TEXT PRIMARY KEY CHECK (provider IN ('github', 'cloudflare')),
  client_id TEXT NOT NULL,
  secret_sealed TEXT NOT NULL,
  -- GitHub: the app's name, slug and page. Cloudflare: the account that owns the client.
  name TEXT,
  slug TEXT,
  url TEXT,
  account_id TEXT,
  -- Cloudflare: the scopes the client may request, space-separated.
  scopes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
