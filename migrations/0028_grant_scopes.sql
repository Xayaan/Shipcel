-- The scopes the provider reported granting a connection (space-separated), when it says.
-- Not secret: it tells Cloudcel what a connection may do, such as whether a Cloudflare
-- connection can create Workers (Workers Scripts Write) or only update them (Workers Editor).
ALTER TABLE provider_grants ADD COLUMN scopes TEXT;
