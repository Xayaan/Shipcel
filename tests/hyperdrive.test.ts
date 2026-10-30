import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database, projectInput } from './helpers/database';
import { uploadProblems } from '../worker/wrangler-policy';
import {
  previewsBlockIssues,
  previewsSnippet,
  repositoryPlan,
} from '../worker/repository-plan';

// Postgres and MySQL through Hyperdrive (worker/hyperdrive.ts): a connection string becomes a
// Hyperdrive configuration in the customer's Cloudflare account, and its id a binding an upload
// may carry. Cloudflare is faked; the password must reach it and nothing else.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let project: { id: string };
let calls: {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}[];

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  project = (await (
    await db.request(
      '/projects',
      { method: 'POST', body: JSON.stringify(projectInput()) },
      who.cookie,
    )
  ).json()) as { id: string };
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = init.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null;
      calls.push({ method, url, body });
      if (/\/hyperdrive\/configs$/.test(url) && method === 'POST') {
        const origin = body!.origin as Record<string, unknown>;
        const { password: _password, ...rest } = origin;
        return Response.json({
          success: true,
          result: {
            id: `hd_${'a'.repeat(28)}`,
            name: body!.name,
            origin: rest,
          },
        });
      }
      if (/\/hyperdrive\/configs\/[^/]+$/.test(url) && method === 'DELETE')
        return Response.json({ success: true, result: null });
      throw new Error(`Unexpected ${method} ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});
const api = (path: string, init: RequestInit = {}) =>
  db.request(path, init, who.cookie);
const rows = () =>
  db.sqlite.prepare('SELECT * FROM hyperdrive_configs').all() as unknown[];

describe('Postgres and MySQL through Hyperdrive', () => {
  it('makes a Hyperdrive configuration in the customer’s account from a connection string, keeping no password', async () => {
    const res = await api(`/projects/${project.id}/hyperdrive`, {
      method: 'POST',
      body: JSON.stringify({
        binding: 'DB',
        connectionString:
          'postgres://app:s3cret@db.neon.tech:5432/shop?sslmode=require',
        confirm: true,
      }),
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as Record<string, string>;
    expect(made).toMatchObject({
      binding: 'DB',
      scheme: 'postgres',
      host: 'db.neon.tech',
      database: 'shop',
      id: expect.stringMatching(/^hd_/),
    });
    expect(made.snippet).toContain(`"id": "${made.id}"`);
    expect(JSON.stringify(made)).not.toContain('s3cret');
    const [create] = calls;
    expect(create.url).toMatch(
      /\/accounts\/[0-9a-f]{32}\/hyperdrive\/configs$/,
    );
    expect(create.body!.origin).toEqual({
      scheme: 'postgres',
      host: 'db.neon.tech',
      port: 5432,
      database: 'shop',
      user: 'app',
      password: 's3cret',
    });
    expect(rows()).toHaveLength(1);
    expect(JSON.stringify(rows())).not.toContain('s3cret');
    // Listed, and accepted as a binding on an upload from a computer, by its id only.
    const list = (await (
      await api(`/projects/${project.id}/hyperdrive`)
    ).json()) as {
      configs: unknown[];
    };
    expect(list.configs).toHaveLength(1);
    expect(
      uploadProblems(
        { bindings: [{ name: 'DB', type: 'hyperdrive', id: made.id }] },
        'my-app',
        [{ type: 'hyperdrive', name: 'DB', id: made.id }],
      ),
    ).toEqual([]);
    expect(
      uploadProblems(
        { bindings: [{ name: 'DB', type: 'hyperdrive', id: 'other' }] },
        'my-app',
        [],
      ),
    ).toEqual([expect.stringContaining('DB names a')]);
    // Removed in Cloudflare too.
    expect(
      (
        await api(`/projects/${project.id}/hyperdrive/${made.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(rows()).toHaveLength(0);
  });

  it('asks for the Cloudflare sign-in to be updated when it predates Hyperdrive', async () => {
    db.sqlite
      .prepare(
        "UPDATE provider_grants SET scopes=? WHERE provider='cloudflare'",
      )
      .run('account-settings.read workers-scripts.write d1.write');
    const res = await api(`/projects/${project.id}/hyperdrive`, {
      method: 'POST',
      body: JSON.stringify({
        binding: 'DB',
        connectionString: 'postgres://app:s3cret@db.neon.tech:5432/shop',
        confirm: true,
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      'Connections',
    );
    expect(calls).toEqual([]);
  });

  it('refuses an address that isn’t Postgres or MySQL, or lacks a password, before asking Cloudflare', async () => {
    for (const connectionString of [
      'https://example.com',
      'postgres://app@db.neon.tech/shop',
      'mysql://',
    ])
      expect(
        (
          await api(`/projects/${project.id}/hyperdrive`, {
            method: 'POST',
            body: JSON.stringify({
              binding: 'DB',
              connectionString,
              confirm: true,
            }),
          })
        ).status,
        connectionString,
      ).toBe(400);
    expect(calls).toEqual([]);
  });
});

// The `hyperdrive` setting of a committed or local Wrangler configuration: a binding and the
// id of a configuration Shipcel added to the project. Nothing is created by a deploy.
describe('Hyperdrive in the repository review', () => {
  const id = 'f'.repeat(32);
  const planOf = (config: Record<string, unknown>, local = false) =>
    repositoryPlan(
      {
        'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
        'package-lock.json': '{}',
        'wrangler.json': JSON.stringify({
          name: 'my-app',
          main: 'src/index.js',
          compatibility_date: '2026-10-07',
          ...config,
        }),
      },
      undefined,
      { local },
    );

  it('accepts a hyperdrive binding with its id, as a resource the deploy binds but never creates', () => {
    const plan = planOf({
      hyperdrive: [
        {
          binding: 'DB',
          id,
          localConnectionString: 'postgres://me:pw@localhost:5432/app',
        },
      ],
    });
    expect(plan.issues).toEqual([]);
    expect(plan.resources).toEqual([{ type: 'hyperdrive', binding: 'DB', id }]);
    expect(JSON.stringify(plan)).not.toContain('localhost:5432');
  });

  it('refuses hyperdrive entries without an id, with other keys, or beyond five', () => {
    for (const [hyperdrive, what] of [
      [[{ binding: 'DB' }], 'no id'],
      [[{ binding: 'DB', id, database_id: 'x' }], 'other keys'],
      [[{ binding: 'db-1', id }], 'bad binding'],
      [Array.from({ length: 6 }, (_, i) => ({ binding: `DB${i}`, id })), 'six'],
    ] as const) {
      const plan = planOf({ hyperdrive });
      expect(plan.issues.join(' '), what).toContain('Hyperdrive');
      expect(plan.resources, what).toEqual([]);
    }
    expect(
      planOf({ hyperdrive: [{ binding: 'DB' }] }, true).issues.join(' '),
    ).toContain('shipcel hyperdrive add');
  });

  it('lets previews bind the same configurations as production, and nothing else', () => {
    const production = [{ binding: 'DB', id }];
    expect(
      previewsBlockIssues(
        { hyperdrive: [{ binding: 'DB', id }] },
        [],
        production,
      ),
    ).toEqual([]);
    expect(
      previewsBlockIssues(
        { hyperdrive: [{ binding: 'DB', id: 'e'.repeat(32) }] },
        [],
        production,
      ).join(' '),
    ).toContain('Hyperdrive');
    expect(
      previewsBlockIssues({ hyperdrive: [{ binding: 'DB', id }] }, [], []).join(
        ' ',
      ),
    ).toContain('Hyperdrive');
    expect(
      previewsSnippet([], 'configured-worker', { hyperdrive: production }),
    ).toContain(
      `"hyperdrive": [\n    {\n      "binding": "DB",\n      "id": "${id}"\n    }\n  ]`,
    );
  });
});
