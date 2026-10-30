-- The budget guard. What each project may cost a month beyond what Cloudflare includes,
-- and what happens when its estimate goes over: an alert (the default) or a pause. No row
-- means the defaults: $0 beyond what Cloudflare includes, alert only.
CREATE TABLE project_budgets (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_cents >= 0 AND monthly_cents <= 10000000),
  on_exceed TEXT NOT NULL DEFAULT 'alert' CHECK (on_exceed IN ('alert', 'pause')),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The guard's latest reading of each deployed project, every few minutes.
CREATE TABLE budget_checks (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  -- The calendar month (UTC) the figures are for, YYYY-MM.
  month TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'paid', 'unknown')),
  -- Month to date, beyond what Cloudflare includes, in cents; and where it would end the
  -- month at the rate since the last check.
  estimate_cents INTEGER NOT NULL DEFAULT 0,
  projected_cents INTEGER NOT NULL DEFAULT 0,
  -- The whole Cloudflare account's cost beyond what is included, Workers Cloudcel doesn't
  -- manage included.
  account_cents INTEGER NOT NULL DEFAULT 0,
  -- Per meter: this project's count, the account's, and the project's share of the cost.
  meters_json TEXT NOT NULL DEFAULT '[]',
  -- Meters Cloudflare's analytics didn't report, with Cloudflare's reason.
  missing_json TEXT NOT NULL DEFAULT '[]',
  -- The highest alert sent this month: 0, 50, 80 or 100 (percent of the budget).
  level INTEGER NOT NULL DEFAULT 0,
  projected_alerted_at INTEGER,
  state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'over', 'paused')),
  -- A pause: when, the versions production served before it and the cron schedules it
  -- removed (both put back on resume), and the version the pause deployed.
  paused_at INTEGER,
  paused_from_json TEXT,
  paused_schedules_json TEXT,
  paused_version TEXT,
  -- The last attempt, the last complete reading, and why the last attempt failed. A guard
  -- that can't read usage for an hour sends an alert, at most once a day.
  checked_at INTEGER NOT NULL,
  read_at INTEGER,
  error TEXT,
  error_alerted_at INTEGER
);
CREATE INDEX budget_checks_checked ON budget_checks(checked_at);
-- Which Workers plan a workspace's Cloudflare account is on, as its billing reports it, or
-- as its usage shows (more than Workers Free allows in a day means Workers Paid).
CREATE TABLE account_plans (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'paid', 'unknown')),
  -- subscriptions, usage, no-permission or error.
  source TEXT NOT NULL,
  detail TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, account_id)
);
