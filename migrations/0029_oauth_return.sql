-- Where a sign-in goes back to when the cloudcel CLI's page started it ('cli-login:<code>'
-- or 'cli-setup', checked by the API); NULL returns to Connections.
ALTER TABLE oauth_states ADD COLUMN return_to TEXT;
