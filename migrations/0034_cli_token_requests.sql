-- `cloudcel tokens add`: a named API token asked for from the terminal and approved in the
-- browser, like a CLI sign-in. A sign-in has neither column; a token request has its name,
-- and the days until it expires (1 to 365).
ALTER TABLE cli_logins ADD COLUMN token_name TEXT;
ALTER TABLE cli_logins ADD COLUMN token_days INTEGER;
