import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { now } from '../worker/types';

// Manage → Security and shipcel security (worker/firewall.ts, packages/cli/src/edge.ts):
// Cloudflare's free firewall for the zones of an app's custom domains, with Cloudflare faked.
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let dir: string, output: string[], errors: string[], projectId: string;
const account = 'a'.repeat(32),
  worker = 'cc-shop-worker',
  zone = 'f'.repeat(32),
  FREE = '77454fe2d30c4220b5701f6fdfb893ba';
type Rule = Record<string, unknown> & { id: string; description?: string };
let rulesets: Record<string, { id: string; rules: Rule[] }>;
let bots: Record<string, unknown>, level: string;
let domains: unknown[], workersDev: boolean;
// Paths Cloudflare refuses (403), and a refusal of new rules (Cloudflare's quota message).
let refuse: string[], reject: string | null;
// The zone's plan: Cloudflare runs its Free Managed Ruleset on Free zones without a rule.
let zonePlan = 'free';
let ruleCount: number, rulesetCount: number;
const sent: { method: string; path: string; body: unknown }[] = [];
const ruleId = () => (++ruleCount).toString(16).padStart(32, '0');

function io(): Io {
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
    open: async () => {},
    run: async () => 0,
    sleep: async () => {},
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
  };
}
const cli = (...argv: string[]) => run(argv, io());
const security = () =>
  db.request(`/projects/${projectId}/security`, {}, who.cookie);
const change = (path: string, method: string, body: unknown) =>
  db.request(
    `/projects/${projectId}/security${path}`,
    { method, body: JSON.stringify(body) },
    who.cookie,
  );

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipcel-firewall-'));
  mkdirSync(join(dir, 'work', '.shipcel'), { recursive: true });
  output = [];
  errors = [];
  sent.length = 0;
  refuse = [];
  reject = null;
  ruleCount = 0;
  rulesetCount = 3;
  db = database();
  who = await db.user(1);
  await db.grant(who, 'cloudflare');
  const created = await db.request(
    '/projects',
    { method: 'POST', body: JSON.stringify(projectInput('shop')) },
    who.cookie,
  );
  projectId = ((await created.json()) as { id: string }).id;
  const job = {
    id: crypto.randomUUID(),
    workspace_id: who.workspaceId,
    project_id: projectId,
    created_by: who.userId,
    cf_grant_id: 'cf',
    gh_grant_id: 'gh',
    account_id: account,
    repository_id: '1',
    repository_name: 'ada/shop',
    branch: 'main',
    commit_sha: 'b'.repeat(40),
    build_token_uuid: crypto.randomUUID(),
    worker_name: worker,
    build_command: '',
    status: 'deployed',
    idempotency_key: crypto.randomUUID(),
    created_at: now(),
    updated_at: now(),
    worker_tag: 'c'.repeat(32),
  };
  db.sqlite
    .prepare(
      `INSERT INTO deployment_jobs(${Object.keys(job).join(',')}) VALUES (${Object.keys(
        job,
      )
        .map(() => '?')
        .join(',')})`,
    )
    .run(...Object.values(job));
  const token = (
    (await (
      await db.request(
        '/tokens',
        { method: 'POST', body: JSON.stringify({ name: 'CLI' }) },
        who.cookie,
      )
    ).json()) as { token: string }
  ).token;
  mkdirSync(join(dir, 'config'));
  writeFileSync(
    join(dir, 'config', 'config.json'),
    JSON.stringify({ url: 'https://shipcel.test', token }),
  );
  writeFileSync(
    join(dir, 'work', '.shipcel', 'project.json'),
    JSON.stringify({ projectId, name: 'shop' }),
  );
  // What a Free zone has: Cloudflare deploys its Free Managed Ruleset, and someone made a
  // custom rule for another app's host name in the dashboard.
  zonePlan = 'free';
  rulesets = {
    http_request_firewall_managed: {
      id: '1'.repeat(32),
      rules: [
        {
          id: '9'.repeat(32),
          action: 'execute',
          action_parameters: { id: FREE, version: 'latest' },
          expression: 'true',
          description: '',
          enabled: true,
          ref: '9'.repeat(32),
          last_updated: '2026-10-01T00:00:00Z',
        },
      ],
    },
    http_request_firewall_custom: {
      id: '2'.repeat(32),
      rules: [
        {
          id: '8'.repeat(32),
          action: 'block',
          expression: '(http.host eq "blog.example.com")',
          description: 'Made in the dashboard',
          enabled: true,
        },
      ],
    },
  };
  bots = {
    fight_mode: false,
    ai_bots_protection: 'disabled',
    using_latest_model: true,
  };
  level = 'medium';
  domains = [
    {
      id: 'd1',
      hostname: 'Shop.Example.com',
      service: worker,
      zone_id: zone,
      zone_name: 'example.com',
      environment: 'production',
    },
    {
      id: 'd2',
      hostname: 'blog.example.com',
      service: 'another-app',
      zone_id: zone,
      zone_name: 'example.com',
      environment: 'production',
    },
  ];
  workersDev = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init: RequestInit = {}) => {
      const path = new URL(String(raw)).pathname.replace('/client/v4', '');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (method !== 'GET') sent.push({ method, path, body });
      const ok = (result: unknown) => Response.json({ success: true, result });
      const fail = (status: number, message: string, code = 10000) =>
        Response.json(
          { success: false, errors: [{ code, message }] },
          { status },
        );
      if (refuse.some((p) => path.includes(p)))
        return fail(403, 'Authentication error');
      if (path === `/accounts/${account}/workers/scripts`)
        return ok([{ id: worker, tag: 'c'.repeat(32) }]);
      if (path === `/accounts/${account}/workers/domains`) return ok(domains);
      if (path === `/accounts/${account}/workers/scripts/${worker}/subdomain`)
        return ok({ enabled: workersDev, previews_enabled: false });
      const phase = path.match(
        /^\/zones\/f{32}\/rulesets\/phases\/(\w+)\/entrypoint$/,
      );
      if (phase && method === 'GET')
        return rulesets[phase[1]]
          ? ok({ ...rulesets[phase[1]], kind: 'zone', phase: phase[1] })
          : fail(
              404,
              `could not find entrypoint ruleset in the ${phase[1]} phase`,
              10003,
            );
      if (path === `/zones/${zone}/rulesets` && method === 'POST') {
        if (reject) return fail(400, reject, 20217);
        const created = {
          id: (++rulesetCount).toString(16).repeat(32),
          rules: (body.rules as Rule[]).map((r) => ({
            enabled: true,
            ...r,
            id: ruleId(),
          })),
        };
        rulesets[body.phase] = created;
        return ok(created);
      }
      const rule = path.match(
        /^\/zones\/f{32}\/rulesets\/(\w+)\/rules(?:\/(\w+))?$/,
      );
      if (rule) {
        const set = Object.values(rulesets).find((r) => r.id === rule[1]);
        if (!set) return fail(404, 'ruleset not found');
        if (method === 'POST' && !rule[2]) {
          if (reject) return fail(400, reject, 20217);
          set.rules.push({ enabled: true, ...body, id: ruleId() });
          return ok(set);
        }
        const at = set.rules.findIndex((r) => r.id === rule[2]);
        if (at < 0) return fail(404, 'rule not found');
        if (method === 'PATCH') {
          set.rules[at] = { ...body, id: rule[2] };
          return ok(set);
        }
        if (method === 'DELETE') {
          set.rules.splice(at, 1);
          return ok(set);
        }
      }
      if (path === `/zones/${zone}`)
        return ok({
          id: zone,
          name: 'example.com',
          plan: { legacy_id: zonePlan },
        });
      if (path === `/zones/${zone}/bot_management`) {
        if (method === 'PUT') bots = { ...bots, ...body };
        return ok(bots);
      }
      if (path === `/zones/${zone}/settings/security_level`) {
        if (method === 'PATCH') level = body.value;
        return ok({ id: 'security_level', value: level, editable: true });
      }
      throw new Error(`Unexpected ${method} ${raw}`);
    }),
  );
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Security panel', () => {
  it('shows the firewall of the zone the app’s custom domains are in, and who made each rule', async () => {
    const res = await security();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workersDev: true,
      zones: [
        {
          id: zone,
          name: 'example.com',
          // Only this app's host names: blog.example.com is another app's.
          hosts: ['shop.example.com'],
          managed: true,
          bots: false,
          aiBots: false,
          underAttack: false,
          rules: [
            {
              id: '8'.repeat(32),
              action: 'block',
              summary: 'block: Made in the dashboard',
              enabled: true,
              ours: false,
            },
          ],
          rateLimits: [],
          denied: [],
        },
      ],
    });
    // Looking changes nothing.
    expect(sent).toEqual([]);
  });

  it('turns the managed rules, Bot Fight Mode, AI crawler blocking and Under Attack mode on and off, once confirmed', async () => {
    expect((await change('', 'PUT', { underAttack: true })).status).toBe(400);
    expect((await change('', 'PUT', { confirm: true })).status).toBe(400);
    expect(sent).toEqual([]);
    // Off keeps Cloudflare's rule, with everything it had, so on brings it back as it was.
    expect(
      (await change('', 'PUT', { managed: false, confirm: true })).status,
    ).toBe(200);
    expect(sent).toEqual([
      {
        method: 'PATCH',
        path: `/zones/${zone}/rulesets/${'1'.repeat(32)}/rules/${'9'.repeat(32)}`,
        body: {
          action: 'execute',
          action_parameters: { id: FREE, version: 'latest' },
          expression: 'true',
          description: '',
          enabled: false,
          ref: '9'.repeat(32),
        },
      },
    ]);
    expect(((await (await security()).json()) as any).zones[0].managed).toBe(
      false,
    );
    expect(
      (await change('', 'PUT', { managed: true, confirm: true })).status,
    ).toBe(200);
    expect(rulesets.http_request_firewall_managed.rules).toEqual([
      expect.objectContaining({ id: '9'.repeat(32), enabled: true }),
    ]);
    // Already on: nothing to write.
    sent.length = 0;
    expect(
      (await change('', 'PUT', { managed: true, confirm: true })).status,
    ).toBe(200);
    expect(sent).toEqual([]);
    // A zone without the managed phase's entry point gets one that runs the Free Managed Ruleset.
    // A paid zone gets nothing by default, so on creates the entry point and the rule.
    zonePlan = 'pro';
    delete rulesets.http_request_firewall_managed;
    expect(
      (await change('', 'PUT', { managed: true, confirm: true })).status,
    ).toBe(200);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: `/zones/${zone}/rulesets`,
        body: {
          name: 'default',
          kind: 'zone',
          phase: 'http_request_firewall_managed',
          rules: [
            {
              action: 'execute',
              action_parameters: { id: FREE },
              expression: 'true',
              description: 'Cloudflare Free Managed Ruleset',
              enabled: true,
            },
          ],
        },
      },
    ]);
    sent.length = 0;
    const res = await change('', 'PUT', {
      bots: true,
      aiBots: true,
      underAttack: true,
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(sent).toEqual([
      {
        method: 'PUT',
        path: `/zones/${zone}/bot_management`,
        body: { fight_mode: true, ai_bots_protection: 'block' },
      },
      {
        method: 'PATCH',
        path: `/zones/${zone}/settings/security_level`,
        body: { value: 'under_attack' },
      },
    ]);
    // The answer is the panel as it is now.
    expect(((await res.json()) as any).zones[0]).toMatchObject({
      managed: true,
      bots: true,
      aiBots: true,
      underAttack: true,
    });
    expect(
      (await change('', 'PUT', { aiBots: false, confirm: true })).status,
    ).toBe(200);
    expect(sent.at(-1)!.body).toEqual({ ai_bots_protection: 'disabled' });
    // Under Attack off goes back to Cloudflare's default level; a level set by hand stays.
    expect(
      (await change('', 'PUT', { underAttack: false, confirm: true })).status,
    ).toBe(200);
    expect(level).toBe('medium');
    level = 'high';
    sent.length = 0;
    expect(
      (await change('', 'PUT', { underAttack: false, confirm: true })).status,
    ).toBe(200);
    expect(sent).toEqual([]);
    expect(level).toBe('high');
  });

  it('adds rules that match only the app’s own host names, checks them first, and removes only its own', async () => {
    const add = (body: Record<string, unknown>) =>
      change('/rules', 'POST', { ...body, confirm: true });
    const tag = `Shipcel [app ${projectId}]`;
    const res = await add({
      action: 'block',
      match: 'country',
      values: ['cn', 'RU', 'CN'],
    });
    expect(res.status).toBe(201);
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      path: `/zones/${zone}/rulesets/${'2'.repeat(32)}/rules`,
      body: {
        action: 'block',
        expression:
          '(http.host in {"shop.example.com"}) and (ip.src.country in {"CN" "RU"})',
        description: `${tag}: block countries CN, RU`,
        enabled: true,
      },
    });
    const answer = (await res.json()) as any;
    const countries = rulesets.http_request_firewall_custom.rules.at(-1)!.id;
    expect(answer.added).toEqual([{ zone: 'example.com', id: countries }]);
    expect(answer.summary).toBe('block countries CN, RU');
    expect(answer.zones[0].rules.at(-1)).toEqual({
      id: countries,
      action: 'block',
      summary: 'block countries CN, RU',
      enabled: true,
      ours: true,
    });
    // The same rule again is a second rule, and the answer names the new one.
    const again = (await (
      await add({ action: 'block', match: 'country', values: ['CN', 'RU'] })
    ).json()) as any;
    const second = rulesets.http_request_firewall_custom.rules.at(-1)!.id;
    expect(second).not.toBe(countries);
    expect(again.added).toEqual([{ zone: 'example.com', id: second }]);
    expect(
      (
        await add({
          action: 'challenge',
          match: 'path',
          values: ['/wp-admin/'],
        })
      ).status,
    ).toBe(201);
    expect(sent.at(-1)!.body).toEqual({
      action: 'managed_challenge',
      expression:
        '(http.host in {"shop.example.com"}) and (http.request.uri.path wildcard "/wp-admin" or http.request.uri.path wildcard "/wp-admin/*")',
      description: `${tag}: challenge path /wp-admin`,
      enabled: true,
    });
    expect(
      (
        await add({
          action: 'block',
          match: 'ip',
          values: ['203.0.113.7', '198.51.100.0/24', '2001:DB8::/32'],
        })
      ).status,
    ).toBe(201);
    expect(sent.at(-1)!.body).toMatchObject({
      action: 'block',
      expression:
        '(http.host in {"shop.example.com"}) and (ip.src in {203.0.113.7 198.51.100.0/24 2001:db8::/32})',
      description: `${tag}: block IPs 203.0.113.7, 198.51.100.0/24, 2001:db8::/32`,
    });
    // The whole site, and long lists, said briefly.
    expect(
      (await add({ action: 'challenge', match: 'path', values: ['/'] })).status,
    ).toBe(201);
    expect(sent.at(-1)!.body).toMatchObject({
      expression:
        '(http.host in {"shop.example.com"}) and (http.request.uri.path wildcard "/*")',
      description: `${tag}: challenge path /`,
    });
    const many = Array.from(
      { length: 50 },
      (_, i) =>
        String.fromCharCode(65 + Math.floor(i / 26)) +
        String.fromCharCode(65 + (i % 26)),
    );
    expect(
      (await add({ action: 'block', match: 'country', values: many })).status,
    ).toBe(201);
    expect((sent.at(-1)!.body as Rule).description).toBe(
      `${tag}: block countries AA, AB, AC, AD, AE and 45 more`,
    );
    // Refused before Cloudflare is asked.
    const writes = sent.length;
    for (const bad of [
      { action: 'block', match: 'country', values: ['China'] },
      { action: 'block', match: 'country', values: ['C"'] },
      { action: 'block', match: 'ip', values: ['999.1.1.1'] },
      { action: 'block', match: 'ip', values: ['10.0.0.0/33'] },
      { action: 'block', match: 'ip', values: ['1.2.3.4 or true'] },
      { action: 'block', match: 'path', values: ['/a" or true or "'] },
      { action: 'block', match: 'path', values: ['/admin/*'] },
      { action: 'block', match: 'path', values: ['admin'] },
      { action: 'block', match: 'path', values: ['/a', '/b'] },
      { action: 'allow', match: 'path', values: ['/a'] },
      { action: 'block', match: 'asn', values: ['13335'] },
      { action: 'block', match: 'country', values: [] },
      { action: 'block', match: 'country', values: [...many, 'ZZ'] },
    ])
      expect((await add(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(
      (
        await change('/rules', 'POST', {
          action: 'block',
          match: 'country',
          values: ['CN'],
        })
      ).status,
    ).toBe(400);
    expect(sent).toHaveLength(writes);
    expect(
      (
        (await (
          await add({ action: 'block', match: 'ip', values: ['1.2.3'] })
        ).json()) as any
      ).error,
    ).toBe(
      "1.2.3 isn't an IP address or range, such as 203.0.113.7 or 198.51.100.0/24.",
    );
    // Cloudflare's own refusal, such as the Free plan's 5 rules, is passed on.
    reject =
      'exceeded maximum number of rules in the phase http_request_firewall_custom: 5 out of 5';
    const full = await add({
      action: 'block',
      match: 'country',
      values: ['KP'],
    });
    expect(full.status).toBe(502);
    expect(((await full.json()) as any).error).toBe(
      `Cloudflare reported: ${reject}`,
    );
    reject = null;
    // Removing: its own rules only.
    const remove = (id: string, body: unknown = { confirm: true }) =>
      change(`/rules/${id}`, 'DELETE', body);
    expect((await remove(countries, {})).status).toBe(400);
    expect((await remove(countries)).status).toBe(200);
    expect(sent.at(-1)).toEqual({
      method: 'DELETE',
      path: `/zones/${zone}/rulesets/${'2'.repeat(32)}/rules/${countries}`,
      body: null,
    });
    expect(
      rulesets.http_request_firewall_custom.rules.some(
        (r) => r.id === countries,
      ),
    ).toBe(false);
    const elsewhere = await remove('8'.repeat(32));
    expect(elsewhere.status).toBe(409);
    expect(((await elsewhere.json()) as any).error).toBe(
      "This rule wasn't made for this app. Change it in Cloudflare's dashboard.",
    );
    // Another app's rule in the same zone, made by Shipcel, isn't this app's either.
    rulesets.http_request_firewall_custom.rules.push({
      id: '6'.repeat(32),
      action: 'block',
      expression:
        '(http.host in {"blog.example.com"}) and (ip.src.country in {"CN"})',
      description:
        'Shipcel [app 00000000-0000-4000-8000-000000000000]: block countries CN',
      enabled: true,
    });
    expect(
      ((await (await security()).json()) as any).zones[0].rules.find(
        (r: { id: string }) => r.id === '6'.repeat(32),
      ).ours,
    ).toBe(false);
    expect((await remove('6'.repeat(32))).status).toBe(409);
    expect((await remove(countries)).status).toBe(404);
    expect((await remove('not-a-rule')).status).toBe(400);
    expect(
      rulesets.http_request_firewall_custom.rules.some(
        (r) => r.id === '8'.repeat(32),
      ),
    ).toBe(true);
  });

  it('reports Cloudflare’s own managed rules on a Free zone with no rule for them, and turns them off by adding one', async () => {
    rulesets.http_request_firewall_managed.rules = [];
    type Shown = {
      zones: { managed: boolean | null; managedDefault?: boolean }[];
    };
    let shown = (await (await security()).json()) as Shown;
    expect(shown.zones[0]).toMatchObject({
      managed: true,
      managedDefault: true,
    });
    // On already, by Cloudflare's default: nothing to write.
    sent.length = 0;
    expect(
      (await change('', 'PUT', { managed: true, confirm: true })).status,
    ).toBe(200);
    expect(sent).toEqual([]);
    // Off adds Cloudflare's rule, disabled.
    expect(
      (await change('', 'PUT', { managed: false, confirm: true })).status,
    ).toBe(200);
    expect(rulesets.http_request_firewall_managed.rules).toEqual([
      expect.objectContaining({
        action: 'execute',
        action_parameters: { id: FREE },
        enabled: false,
      }),
    ]);
    shown = (await (await security()).json()) as Shown;
    expect(shown.zones[0].managed).toBe(false);
    expect(shown.zones[0].managedDefault).toBeUndefined();
    // A paid zone gets nothing by default: on adds the rule, enabled.
    rulesets.http_request_firewall_managed.rules = [];
    zonePlan = 'pro';
    shown = (await (await security()).json()) as Shown;
    expect(shown.zones[0]).toMatchObject({ managed: false });
    expect(shown.zones[0].managedDefault).toBeUndefined();
    expect(
      (await change('', 'PUT', { managed: true, confirm: true })).status,
    ).toBe(200);
    expect(rulesets.http_request_firewall_managed.rules).toEqual([
      expect.objectContaining({
        action_parameters: { id: FREE },
        enabled: true,
      }),
    ]);
    zonePlan = 'free';
  });

  it('creates the custom rules’ entry point when the zone has none', async () => {
    delete rulesets.http_request_firewall_custom;
    expect(
      (
        await change('/rules', 'POST', {
          action: 'block',
          match: 'path',
          values: ['/xmlrpc.php'],
          confirm: true,
        })
      ).status,
    ).toBe(201);
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      path: `/zones/${zone}/rulesets`,
      body: {
        name: 'default',
        kind: 'zone',
        phase: 'http_request_firewall_custom',
        rules: [
          expect.objectContaining({
            action: 'block',
            description: `Shipcel [app ${projectId}]: block path /xmlrpc.php`,
          }),
        ],
      },
    });
  });

  it('keeps one rate limit for a path, replaces it, and removes it', async () => {
    const set = (body: Record<string, unknown>) =>
      change('/rate-limit', 'PUT', { ...body, confirm: true });
    expect((await set({ path: '/api/', requests: 100 })).status).toBe(200);
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      path: `/zones/${zone}/rulesets`,
      body: {
        name: 'default',
        kind: 'zone',
        phase: 'http_ratelimit',
        rules: [
          {
            action: 'block',
            // Cloudflare's Free plan matches a rate limit on the path only.
            expression:
              '(http.request.uri.path wildcard "/api" or http.request.uri.path wildcard "/api/*")',
            description: `Shipcel [app ${projectId}]: at most 100 requests per 10 seconds per visitor to /api`,
            enabled: true,
            ratelimit: {
              characteristics: ['cf.colo.id', 'ip.src'],
              period: 10,
              requests_per_period: 100,
              mitigation_timeout: 10,
            },
          },
        ],
      },
    });
    const first = rulesets.http_ratelimit.rules[0].id;
    const res = await set({ path: '/login', requests: 20 });
    expect(res.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({
      method: 'PATCH',
      path: `/zones/${zone}/rulesets/${rulesets.http_ratelimit.id}/rules/${first}`,
      body: {
        expression:
          '(http.request.uri.path wildcard "/login" or http.request.uri.path wildcard "/login/*")',
        ratelimit: expect.objectContaining({ requests_per_period: 20 }),
      },
    });
    expect(rulesets.http_ratelimit.rules).toHaveLength(1);
    expect(((await res.json()) as any).zones[0].rateLimits).toEqual([
      {
        id: first,
        action: 'block',
        summary: 'at most 20 requests per 10 seconds per visitor to /login',
        enabled: true,
        ours: true,
        requests: 20,
        period: 10,
      },
    ]);
    const writes = sent.length;
    for (const bad of [
      { path: '/api', requests: 0 },
      { path: '/api', requests: 1.5 },
      { path: '/api', requests: 100001 },
      { path: 'api', requests: 10 },
      { path: '/api/*', requests: 10 },
    ])
      expect((await set(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(sent).toHaveLength(writes);
    const off = () =>
      change('/rate-limit', 'DELETE', { confirm: true }) as Promise<Response>;
    const removed = await off();
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: ['example.com'] });
    expect(rulesets.http_ratelimit.rules).toEqual([]);
    expect((await off()).status).toBe(404);
  });

  it('leaves a rate limit made elsewhere alone and says what Cloudflare refused', async () => {
    rulesets.http_ratelimit = {
      id: '3'.repeat(32),
      rules: [
        {
          id: '7'.repeat(32),
          action: 'block',
          expression: '(http.request.uri.path eq "/")',
          description: 'Home page',
          enabled: true,
          ratelimit: { period: 10, requests_per_period: 50 },
        },
      ],
    };
    expect(
      ((await (await security()).json()) as any).zones[0].rateLimits,
    ).toEqual([
      {
        id: '7'.repeat(32),
        action: 'block',
        summary: 'block: Home page',
        enabled: true,
        ours: false,
        requests: 50,
        period: 10,
      },
    ]);
    reject =
      'exceeded maximum number of rules in the phase http_ratelimit: 1 out of 1';
    const res = await change('/rate-limit', 'PUT', {
      path: '/api',
      requests: 10,
      confirm: true,
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toContain('1 out of 1');
    expect(rulesets.http_ratelimit.rules).toHaveLength(1);
    expect(
      (await change('/rate-limit', 'DELETE', { confirm: true })).status,
    ).toBe(404);
  });

  it('needs a developer, a custom domain and the permissions, and names a missing one', async () => {
    const viewer = await db.user(2, 'viewer');
    await db.grant(viewer, 'cloudflare');
    expect(
      (
        await db.request(
          `/projects/${projectId}/security`,
          {
            method: 'PUT',
            body: JSON.stringify({ bots: true, confirm: true }),
          },
          viewer.cookie,
        )
      ).status,
    ).toBe(403);
    // A connection without Bot Management or Zone WAF still shows the rest.
    refuse = ['/bot_management', '/rulesets'];
    const partial = (await (await security()).json()) as any;
    expect(partial.zones[0]).toMatchObject({
      managed: null,
      bots: null,
      aiBots: null,
      underAttack: false,
      rules: null,
      rateLimits: null,
      denied: ['Zone WAF Write', 'Bot Management Write'],
    });
    const refused = await change('', 'PUT', { bots: true, confirm: true });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).error).toBe(
      'Cloudflare refused: this Cloudflare connection has no Bot Management Write permission. Cloudflare sign-ins set up from 23 October 2026 ask for it; an older one has to be set up again on Connections.',
    );
    expect(
      (
        (await (
          await change('/rules', 'POST', {
            action: 'block',
            match: 'country',
            values: ['CN'],
            confirm: true,
          })
        ).json()) as any
      ).error,
    ).toContain('no Zone WAF Write permission');
    // No custom domain: nothing to protect at the zone, which the panel says.
    refuse = [];
    domains = [];
    workersDev = true;
    sent.length = 0;
    expect(await (await security()).json()).toEqual({
      workersDev: true,
      zones: [],
    });
    const none = await change('', 'PUT', { underAttack: true, confirm: true });
    expect(none.status).toBe(409);
    expect(((await none.json()) as any).error).toContain(
      'This app has no custom domain.',
    );
    expect(sent).toEqual([]);
  });
});

describe('shipcel security', () => {
  const pad = (n: number) => ' '.repeat(n);

  it('shows each zone’s firewall', async () => {
    expect(await cli('security')).toBe(0);
    expect(output).toEqual([
      'example.com: shop.example.com',
      `Setting${pad(15)}State`,
      `Free Managed Ruleset${pad(2)}on`,
      `Bot Fight Mode${pad(8)}off`,
      `AI crawler blocking${pad(3)}off`,
      `Under Attack mode${pad(5)}off`,
      `Rule${pad(30)}What it does${pad(18)}Made by`,
      `${'8'.repeat(32)}  block: Made in the dashboard  elsewhere`,
      'No rate limit. shipcel security rate-limit /api 100 sets one.',
      "This app also answers at its workers.dev address, which Cloudflare's DDoS protection covers but no zone firewall does. shipcel unpublish turns it off.",
    ]);
    output = [];
    expect(await cli('security', '--json')).toBe(0);
    expect(JSON.parse(output.join('\n'))).toEqual(
      await (await security()).json(),
    );
    output = [];
    domains = [];
    expect(await cli('security')).toBe(0);
    expect(output).toEqual([
      "This app has no custom domain. Cloudflare's DDoS protection covers its workers.dev address, but the firewall belongs to a domain's zone: shipcel domains add <hostname>.",
    ]);
  });

  it('changes settings, rules and the rate limit after confirmation', async () => {
    expect(await cli('security', 'bots', 'on')).toBe(1);
    expect(errors.at(-1)).toContain('Pass --yes to confirm in scripts.');
    expect(bots.fight_mode).toBe(false);
    expect(await cli('security', 'bots', 'on', '--yes')).toBe(0);
    expect(output.at(-1)).toBe('Bot Fight Mode is on for example.com.');
    expect(bots.fight_mode).toBe(true);
    expect(await cli('security', 'under-attack', 'on', '--yes')).toBe(0);
    expect(output.at(-1)).toBe('Under Attack mode is on for example.com.');
    expect(level).toBe('under_attack');
    expect(await cli('security', 'ai-bots', 'on', '--yes')).toBe(0);
    expect(bots.ai_bots_protection).toBe('block');
    expect(await cli('security', 'managed', 'off', '--yes')).toBe(0);
    expect(output.at(-1)).toBe('Free Managed Ruleset is off for example.com.');
    expect(
      await cli('security', 'block', 'country', 'cn,ru', 'KP', '--yes'),
    ).toBe(0);
    const added = rulesets.http_request_firewall_custom.rules.at(-1)!;
    expect(output.at(-1)).toBe(
      `Added rule ${added.id} on example.com: block countries CN, RU, KP.`,
    );
    output = [];
    expect(await cli('security')).toBe(0);
    expect(output).toContain(
      `${added.id}  block countries CN, RU, KP${pad(4)}this app`,
    );
    expect(await cli('security', 'challenge', 'path', '/login', '--yes')).toBe(
      0,
    );
    expect(rulesets.http_request_firewall_custom.rules.at(-1)!.action).toBe(
      'managed_challenge',
    );
    expect(await cli('security', 'rm', added.id, '--yes')).toBe(0);
    expect(output.at(-1)).toBe(`Removed rule ${added.id}.`);
    expect(await cli('security', 'rate-limit', '/api', '100', '--yes')).toBe(0);
    expect(output.at(-1)).toBe(
      'example.com: at most 100 requests per 10 seconds per visitor to /api. It counts that path on every host name in the zone.',
    );
    expect(await cli('security', 'rate-limit', 'off', '--yes')).toBe(0);
    expect(output.at(-1)).toBe('Removed the rate limit from example.com.');
    // A server refusal is the command's error.
    expect(await cli('security', 'rm', '8'.repeat(32), '--yes')).toBe(1);
    expect(errors.at(-1)).toBe(
      "This rule wasn't made for this app. Change it in Cloudflare's dashboard.",
    );
  });

  it('checks its arguments before asking anything', async () => {
    for (const argv of [
      ['security', 'bots'],
      ['security', 'bots', 'maybe'],
      ['security', 'block', 'planet', 'x'],
      ['security', 'block', 'country'],
      ['security', 'block', 'path', '/a', '/b'],
      ['security', 'rate-limit', '/api'],
      ['security', 'rate-limit', '/api', 'many'],
      ['security', 'rate-limit', 'api', '10'],
      ['security', 'rm'],
      ['security', 'rm', 'abc'],
      ['security', 'nope'],
    ])
      expect(await cli(...argv, '--yes'), argv.join(' ')).toBe(2);
    expect(sent).toEqual([]);
    // No custom domain: said before asking.
    domains = [];
    expect(await cli('security', 'under-attack', 'on')).toBe(1);
    expect(errors.at(-1)).toContain('This app has no custom domain.');
  });
});
