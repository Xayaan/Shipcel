import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { digest, seal } from '../../worker/crypto';
import { now, type Env } from '../../worker/types';
import app from '../../worker/index';

// Execute real migrations/constraints on SQLite; only the D1 transport is adapted.
export function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  class Statement {
    values: SQLInputValue[] = [];
    constructor(readonly sql: string) {}
    bind(...values: SQLInputValue[]) {
      this.values = values;
      return this;
    }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.values);
      return row ? (column ? row[column] : row) : null;
    }
    async all() {
      return {
        success: true,
        results: sqlite.prepare(this.sql).all(...this.values),
        meta: {},
      };
    }
    async run() {
      const result = sqlite.prepare(this.sql).run(...this.values);
      return {
        success: true,
        results: [],
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
        },
      };
    }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  const env: Env = {
    DB: db,
    ASSETS: {} as Fetcher,
    AUTH_MODE: 'github',
    APP_ORIGIN: 'https://shipcel.test',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    GITHUB_CLIENT_ID: 'test-client',
    GITHUB_CLIENT_SECRET: 'test-github-secret',
    GITHUB_APP_SLUG: 'shipcel-test',
    CLOUDFLARE_CLIENT_ID: 'test-cf-client',
    CLOUDFLARE_CLIENT_SECRET: 'test-cf-secret',
    CLOUDFLARE_OAUTH_SCOPES: 'test:scope',
    NATIVE_BUILDS_ENABLED: 'true',
  };
  async function user(
    number: number,
    role: 'owner' | 'developer' | 'viewer' = 'owner',
  ) {
    const userId = `gh-${number}`,
      workspaceId = `personal-${number}`,
      raw = `test-session-${number}`;
    sqlite
      .prepare('INSERT INTO users VALUES (?,?,?,?)')
      .run(userId, String(number), `user-${number}`, now());
    sqlite
      .prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,?)')
      .run(workspaceId, `workspace-${number}`, now());
    sqlite
      .prepare('INSERT INTO memberships VALUES (?,?,?)')
      .run(workspaceId, userId, role);
    sqlite
      .prepare('INSERT INTO sessions VALUES (?,?,?,?)')
      .run(await digest(raw), userId, workspaceId, now() + 3600);
    return {
      userId,
      workspaceId,
      raw,
      cookie: `__Host-cloudcel_session=${raw}`,
    };
  }
  async function grant(
    who: Awaited<ReturnType<typeof user>>,
    provider: 'github' | 'cloudflare',
    options: { expires?: number; refresh?: string } = {},
  ) {
    const id = crypto.randomUUID();
    const encrypted = await seal(
      {
        access_token: `${provider}-access-secret`,
        ...(options.refresh ? { refresh_token: options.refresh } : {}),
      },
      env.TOKEN_ENCRYPTION_KEY,
      `${who.workspaceId}:${provider}:${id}`,
    );
    sqlite
      .prepare(
        'INSERT INTO provider_grants(id,workspace_id,user_id,provider,encrypted_tokens,expires_at,account_id,account_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        who.workspaceId,
        who.userId,
        provider,
        encrypted,
        options.expires ?? null,
        provider === 'cloudflare' ? 'a'.repeat(32) : null,
        provider === 'cloudflare' ? 'Test Cloud' : null,
        now(),
      );
    return id;
  }
  function request(path: string, options: RequestInit = {}, cookie?: string) {
    const headers = new Headers(options.headers);
    headers.set('X-Shipcel-Request', '1');
    if (cookie) headers.set('Cookie', cookie);
    if (options.body && !(options.body instanceof FormData))
      headers.set('Content-Type', 'application/json');
    return app.request(
      `https://shipcel.test/api${path}`,
      { ...options, headers },
      env,
    );
  }
  return { sqlite, env, user, grant, request, close: () => sqlite.close() };
}
export const projectInput = (name = 'test-app') => ({
  name,
  framework: 'worker',
  repository: '',
  database: false,
  storage: false,
});
