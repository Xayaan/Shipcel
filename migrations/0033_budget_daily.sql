-- The budget guard's reading, day by day, for the Billing panel's charts: this project's use
-- of each meter on each day of the month so far, and the month's estimate at the end of each
-- day, in cents. {"days": ["YYYY-MM-DD", …], "meters": {"<meter>": [count, …]}, "cents": […]}
ALTER TABLE budget_checks ADD COLUMN daily_json TEXT NOT NULL DEFAULT '{}';
