CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  framework TEXT NOT NULL CHECK (framework IN ('react', 'nextjs', 'vue', 'hono', 'astro', 'sveltekit', 'static', 'worker', 'python', 'docker', 'wordpress')),
  repository TEXT NOT NULL DEFAULT '',
  database_enabled INTEGER NOT NULL DEFAULT 0,
  storage_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  project_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project.created', 'kit.exported', 'project.deleted')),
  created_at TEXT NOT NULL
);

CREATE INDEX events_created_at ON events(created_at DESC);
