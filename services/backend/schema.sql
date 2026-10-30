-- Shipcel sign-in and realtime service database (D1). Applied by Shipcel when the
-- service is enabled; every statement is idempotent so it can be applied again on update.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  picture TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_sign_in_at INTEGER
);
CREATE INDEX IF NOT EXISTS users_email ON users(email);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  algorithm INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS auth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  nonce TEXT,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  user_handle TEXT,
  name TEXT,
  email TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  request_id TEXT NOT NULL,
  verifier TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  nonce TEXT,
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL,
  auth_time INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family ON refresh_tokens(family);
CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  auth_time INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- Which browser started each sign-in request (login CSRF protection).
CREATE TABLE IF NOT EXISTS auth_request_browsers (
  request_id TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Expiry indexes keep cleanup from scanning whole tables.
CREATE INDEX IF NOT EXISTS auth_requests_expires ON auth_requests(expires_at);
CREATE INDEX IF NOT EXISTS auth_request_browsers_expires ON auth_request_browsers(expires_at);
CREATE INDEX IF NOT EXISTS challenges_expires ON challenges(expires_at);
CREATE INDEX IF NOT EXISTS oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS codes_expires ON codes(expires_at);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires ON refresh_tokens(expires_at);
-- Sign-in by email: one-time links (the token is stored hashed), and optional passwords.
CREATE TABLE IF NOT EXISTS email_links (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_links_email ON email_links(email, created_at);
CREATE INDEX IF NOT EXISTS email_links_expires ON email_links(expires_at);
CREATE TABLE IF NOT EXISTS passwords (
  user_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
