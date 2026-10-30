import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database, projectInput } from './helpers/database';
import { run, type Io } from '../packages/cli/src/cli';
import app from '../worker/index';

// The account commands (packages/cli/src/account.ts) against the real Shipcel API: tokens,
// teams, usage, alerts, webhooks and pricing.
let dir: string, output: string[], errors: string[], opened: string[];
let db: ReturnType<typeof database>;
type Who = Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let who: Who;
// What the person does in the browser while the CLI waits, one step per wait.
let browser: (() => Promise<unknown>)[];
const now = () => Math.floor(Date.now() / 1000);
const configFile = () => join(dir, 'config', 'config.json');

function io(overrides: Partial<Io> = {}): Io {
  return {
    env: { SHIPCEL_CONFIG_DIR: join(dir, 'config') },
    cwd: join(dir, 'work'),
    home: dir,
    hostname: 'ada-laptop',
    isTTY: false,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
    fetch: ((url: string, init: RequestInit) =>
      app.request(url, init, db.env)) as typeof globalThis.fetch,
    open: async (url) => {
      opened.push(url);
    },
    run: async () => 0,
    sleep: async () => {
      await browser.shift()?.();
    },
    ask: async () => 'y',
    askSecret: async () => '',
    stdin: async () => '',
    fs: {
      readFile: async (p) => new Uint8Array(readFileSync(p)),
      writeFile: async (p, data) => writeFileSync(p, data),
      mkdir: async (p) => {
        mkdirSync(p, { recursive: true });
      },
      remove: async (p) => rmSync(p, { force: true }),
      readdir: async () => [],
      size: async () => 0,
      exists: async (p) => existsSync(p),
    },
    ...overrides,
  };
}
const cli = (argv: string[]) => run(argv, io());
// A token made in the dashboard, saved the way shipcel login saves one.
async function signIn(name = 'CLI on ada-laptop') {
  const created = await db.request(
    '/tokens',
    { method: 'POST', body: JSON.stringify({ name }) },
    who.cookie,
  );
  const token = ((await created.json()) as { token: string }).token;
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(
    configFile(),
    JSON.stringify({ url: 'https://shipcel.test', token }),
  );
  return token;
}
async function project(name: string) {
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput(name)) },
    who.cookie,
  );
  return ((await created.json()) as { id: string }).id;
}
function linkFolder(id: string, name: string) {
  mkdirSync(join(dir, 'work', '.shipcel'), { recursive: true });
  writeFileSync(
    join(dir, 'work', '.shipcel', 'project.json'),
    JSON.stringify({ projectId: id, name }),
  );
}
function check(projectId: string, row: Record<string, unknown>) {
  const values = {
    project_id: projectId,
    workspace_id: who.workspaceId,
    account_id: 'a'.repeat(32),
    worker_name: `w-${projectId.slice(0, 8)}`,
    month: new Date().toISOString().slice(0, 7),
    plan: 'paid',
    checked_at: now() - 60,
    read_at: now() - 60,
    ...row,
  };
  db.sqlite
    .prepare(
      `INSERT INTO budget_checks(${Object.keys(values).join(',')}) VALUES (${Object.keys(
        values,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(values));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipcel-account-'));
  mkdirSync(join(dir, 'work'));
  output = [];
  errors = [];
  opened = [];
  browser = [];
  db = database();
  who = await db.user(1);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('shipcel pricing', () => {
  it('shows the plans signed out, narrows them down by a word, and says when nothing matches', async () => {
    expect(await cli(['pricing'])).toBe(0);
    expect(output[0]).toBe(
      'Shipcel is free: $0 a month, no card, up to 100 projects (shipcel pricing shipcel lists everything in it).',
    );
    expect(output).toContain(
      'Cloudflare, in your own account (list prices, checked 8 October 2026):',
    );
    expect(output).toContain('    Workers Free: Not available');
    output = [];
    expect(await cli(['pricing', 'd1'])).toBe(0);
    expect(output).toContain('  D1 SQL databases');
    expect(output.join('\n')).not.toContain('KV key-value data');
    // Markup is for the site; the terminal gets plain words.
    output = [];
    expect(await cli(['pricing', 'shipcel'])).toBe(0);
    expect(output[0]).toBe('Shipcel Free, $0 a month:');
    expect(output.join('\n')).not.toMatch(/\*\*|`/);
    output = [];
    expect(await cli(['pricing', 'kv', '--json'])).toBe(0);
    const json = JSON.parse(output[0]);
    expect(json.cloudflare.map((r: { service: string }) => r.service)).toEqual([
      'KV key-value data',
    ]);
    expect(await cli(['pricing', 'bandwidth-gremlins'])).toBe(1);
    // Signed out, the table is shipcel.com's.
    expect(errors.at(-1)).toBe(
      'Nothing about “bandwidth-gremlins” in the plans. The whole table: https://shipcel.com/pricing/',
    );
  });
});

describe('shipcel tokens', () => {
  it('makes a deploy token for one project, approved in the browser', async () => {
    await signIn();
    const created = await db.request(
      '/projects',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'shop', framework: 'static' }),
      },
      who.cookie,
    );
    const { id } = (await created.json()) as { id: string };
    browser.push(async () => {
      const code = new URLSearchParams(opened.at(-1)!.split('?')[1]).get(
        'code',
      );
      await db.request(
        '/cli/login/approve',
        { method: 'POST', body: JSON.stringify({ code }) },
        who.cookie,
      );
    });
    output = [];
    expect(
      await cli(['tokens', 'add', 'Bitbucket: ada/shop', '--project', 'shop']),
    ).toBe(0);
    const until = new Date((now() + 90 * 86400) * 1000)
      .toISOString()
      .slice(0, 10);
    expect(output.slice(-3)).toEqual([
      `Created the deploy token Bitbucket: ada/shop, which deploys only shop, until ${until}. Shipcel shows it only now:`,
      expect.stringMatching(/^cc_pat_[A-Za-z0-9_-]{43}$/),
      'In CI, set it as SHIPCEL_TOKEN, with SHIPCEL_URL. shipcel tokens rm revokes it.',
    ]);
    const token = output.at(-2)!;
    const as = (path: string) =>
      app.request(
        `https://shipcel.test/api${path}`,
        { headers: { Authorization: `Bearer ${token}` } },
        db.env,
      );
    expect((await as('/projects')).status).toBe(200);
    expect((await as(`/projects/${id}/budget`)).status).toBe(403);
    expect(await cli(['tokens', 'add', 'x', '--project', 'nope'])).toBe(1);
    expect(errors.pop()).toBe(
      'There is no project nope. shipcel ls lists them.',
    );
  });

  it('lists, adds (approved in the browser) and revokes tokens', async () => {
    await signIn();
    expect(await cli(['tokens'])).toBe(0);
    expect(output[0]).toMatch(
      /^Name\s+Prefix\s+Created\s+Last used\s+Expires$/,
    );
    expect(output[1]).toMatch(
      /^CLI on ada-laptop \(this computer\)\s+cc_pat_\S+\s+\d+s ago\s+\d+s ago\s+never$/,
    );
    // add: the same page shipcel login opens, for a named token.
    browser.push(async () => {
      const code = new URLSearchParams(opened[0].split('?')[1]).get('code');
      await db.request(
        '/cli/login/approve',
        { method: 'POST', body: JSON.stringify({ code }) },
        who.cookie,
      );
    });
    output = [];
    expect(
      await cli(['tokens', 'add', 'CI', 'deploy', '--expires', '30']),
    ).toBe(0);
    expect(opened[0]).toMatch(/#cli-login\?code=[B-Z2-9-]+&token=1$/);
    const until = new Date((now() + 30 * 86400) * 1000)
      .toISOString()
      .slice(0, 10);
    expect(output.slice(-3)).toEqual([
      `Created the token CI deploy, which acts as you until ${until}. Shipcel shows it only now:`,
      expect.stringMatching(/^cc_pat_[A-Za-z0-9_-]{43}$/),
      'In CI, set it as SHIPCEL_TOKEN, with SHIPCEL_URL. shipcel tokens rm revokes it.',
    ]);
    const ci = output.at(-2)!;
    // The new token works, and the saved sign-in is still this computer's own.
    expect(
      (
        await app.request(
          'https://shipcel.test/api/projects',
          { headers: { Authorization: `Bearer ${ci}` } },
          db.env,
        )
      ).status,
    ).toBe(200);
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).token).not.toBe(ci);
    // Without --expires, 90 days.
    browser.push(async () => {
      const code = new URLSearchParams(opened.at(-1)!.split('?')[1]).get(
        'code',
      );
      await db.request(
        '/cli/login/approve',
        { method: 'POST', body: JSON.stringify({ code }) },
        who.cookie,
      );
    });
    expect(await cli(['tokens', 'add', 'Laptop'])).toBe(0);
    const ninety = new Date((now() + 90 * 86400) * 1000)
      .toISOString()
      .slice(0, 10);
    expect(output.at(-3)).toContain(`which acts as you until ${ninety}.`);
    // Always an end date, at most a year.
    expect(await cli(['tokens', 'add', 'Forever', '--expires', 'never'])).toBe(
      1,
    );
    expect(errors.at(-1)).toBe(
      'A token without an end date is made in the dashboard: https://shipcel.test/app/#developers',
    );
    expect(await cli(['tokens', 'add', 'Long', '--expires', '400'])).toBe(2);
    expect(await cli(['tokens', 'add'])).toBe(2);
    // A denied request creates nothing.
    browser.push(async () => {
      const code = new URLSearchParams(opened.at(-1)!.split('?')[1]).get(
        'code',
      );
      await db.request(
        '/cli/login/deny',
        { method: 'POST', body: JSON.stringify({ code }) },
        who.cookie,
      );
    });
    expect(await cli(['tokens', 'add', 'Nope'])).toBe(1);
    expect(errors.at(-1)).toBe(
      'The token was denied in the browser; none was created.',
    );
    // rm by name; then the computer's own token, which signs it out.
    output = [];
    expect(await cli(['tokens', 'rm', 'CI deploy', '--yes'])).toBe(0);
    expect(output.at(-1)).toBe('Revoked CI deploy.');
    expect(
      (
        await app.request(
          'https://shipcel.test/api/projects',
          { headers: { Authorization: `Bearer ${ci}` } },
          db.env,
        )
      ).status,
    ).toBe(401);
    expect(await cli(['tokens', 'rm', 'Nothing here', '--yes'])).toBe(1);
    expect(await cli(['tokens', 'rm', 'CLI on ada-laptop'])).toBe(1);
    expect(errors.at(-1)).toContain('Pass --yes to confirm in scripts.');
    expect(await cli(['tokens', 'rm', 'CLI on ada-laptop', '--yes'])).toBe(0);
    expect(output.at(-1)).toBe(
      'Revoked CLI on ada-laptop. This computer is signed out: shipcel login signs in again.',
    );
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual({
      url: 'https://shipcel.test',
    });
  });
});

describe('shipcel teams, usage, alerts and webhooks', () => {
  it('lists workspaces, and sends team changes to the dashboard', async () => {
    await db.request(
      '/workspaces',
      { method: 'POST', body: JSON.stringify({ name: 'Acme' }) },
      who.cookie,
    );
    // The session moved to Acme; the token below is made there.
    await signIn();
    expect(await cli(['teams', 'ls'])).toBe(0);
    expect(output).toEqual([
      'Workspace            Role   Kind',
      'Acme (this sign-in)  owner  team',
      'workspace-1          owner  personal',
      'A sign-in works in one workspace: shipcel switch signs in to another.',
    ]);
    expect(await cli(['teams', 'invite', 'grace'])).toBe(1);
    expect(errors.at(-1)).toBe(
      'Teams are made, and people invited, changed or removed, in the dashboard by an owner: https://shipcel.test/app/#team',
    );
  });

  it('sums up the month and lists what needs attention, for the linked project or all', async () => {
    await signIn();
    const shop = await project('shop');
    const blog = await project('blog');
    // The latest reading has the account's figure.
    check(shop, {
      estimate_cents: 600,
      projected_cents: 1400,
      account_cents: 700,
      level: 50,
      read_at: now() - 30,
    });
    db.sqlite
      .prepare(
        "INSERT INTO project_budgets(project_id,workspace_id,monthly_cents,on_exceed,updated_by,updated_at) VALUES (?,?,1000,'pause',?,?)",
      )
      .run(shop, who.workspaceId, who.userId, now());
    check(blog, {
      state: 'paused',
      paused_at: now() - 30,
      estimate_cents: 50,
      level: 100,
    });
    expect(await cli(['usage'])).toBe(0);
    const month = new Date().toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    expect(output.slice(0, 2)).toEqual([
      `${month} so far, on Workers Paid.`,
      'The whole Cloudflare account, beyond what Cloudflare includes: $7.00 (read 30s ago).',
    ]);
    expect(output.slice(2, 5)).toEqual([
      'Project        This month  By month end  Budget  Over it',
      'blog (paused)  $0.50       $0.00         $0.00   alert only',
      'shop           $6.00       $14.00        $10.00  pause',
    ]);
    output = [];
    expect(await cli(['alerts', '--all'])).toBe(0);
    expect(output[0]).toMatch(/^When\s+Project\s+Alert$/);
    expect(output.slice(1).map((l) => l.replace(/^\S+ ago\s+/, ''))).toEqual([
      'blog     Error: Paused for going over its budget: $0.50 this month beyond what Cloudflare includes, against a $0.00 budget. An owner resumes it in the dashboard.',
      'shop     Warning: Has used 50% of its budget: $6.00 this month beyond what Cloudflare includes, against a $10.00 budget.',
      'shop     Warning: On course to go over its budget: at the latest rate it would cost $14.00 beyond what Cloudflare includes by the end of the month, against a $10.00 budget.',
    ]);
    // In a folder linked to shop: shop's alone, unless --all.
    linkFolder(shop, 'shop');
    output = [];
    expect(await cli(['alerts'])).toBe(0);
    expect(output.slice(1).every((l) => l.includes('shop'))).toBe(true);
    expect(output).toHaveLength(3);
    output = [];
    expect(await cli(['alerts', '--json'])).toBe(0);
    expect(JSON.parse(output[0]).map((a: { kind: string }) => a.kind)).toEqual([
      'budget.level',
      'budget.projected',
    ]);
    // Nothing to say.
    const quiet = await project('quiet');
    linkFolder(quiet, 'quiet');
    output = [];
    expect(await cli(['alerts'])).toBe(0);
    expect(output).toEqual(['Nothing needs attention in quiet.']);
  });

  it('shows each project’s webhook, and sends adding one to the dashboard', async () => {
    await signIn();
    const shop = await project('shop');
    await project('blog');
    const saved = await db.request(
      `/projects/${shop}/notifications`,
      {
        method: 'PUT',
        body: JSON.stringify({
          url: 'https://hooks.example.com/services/T0/B0/secret',
          events: ['deployment.failed'],
        }),
      },
      who.cookie,
    );
    expect(saved.status).toBe(200);
    expect(await cli(['webhooks', 'ls', '--all'])).toBe(0);
    // One line a project. (Both were made in the same second, so their order isn't part of
    // this.)
    expect([...output].sort()).toEqual([
      'blog: no webhook.',
      'shop: hooks.example.com, for deployment.failed and budget alerts; nothing sent yet.',
    ]);
    // The address's path, which holds the hook's secret, never comes back.
    expect(output.join('\n')).not.toContain('secret');
    linkFolder(shop, 'shop');
    expect(await cli(['webhooks', 'add', 'https://example.com/hook'])).toBe(1);
    expect(errors.at(-1)).toBe(
      `Webhooks are added, tested and removed in the dashboard, under Manage → Notifications, so a token can't send your projects' events somewhere new: https://shipcel.test/app/#projects/${shop}/operations`,
    );
  });
});
