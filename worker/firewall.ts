import { Hono } from 'hono';
import { z } from 'zod';
import { limit } from './auth';
import { target, type Target } from './operations';
import { cloudflare } from './providers';
import { AppError, type AppEnv } from './types';

// Manage → Security and `shipcel security`: Cloudflare's free firewall in front of an app's
// custom domains. A firewall belongs to a domain's zone, so a workers.dev address has none,
// though Cloudflare's DDoS protection covers it as well. The Free Managed Ruleset, Bot Fight
// Mode, AI crawler blocking, Under Attack mode and rate limits apply to the whole zone; the
// custom rules made here match the app's own host names only. What Shipcel makes carries
// the app's ID in its description, and only that is changed or removed here. Needs the
// connection's Zone WAF, Bot Management and Zone Settings permissions.
export const firewall = new Hono<AppEnv>();

// Cloudflare's Free Managed Ruleset, on every plan; Cloudflare deploys it on Free zones.
const FREE_MANAGED = '77454fe2d30c4220b5701f6fdfb893ba';
const PHASE = {
  managed: 'http_request_firewall_managed',
  custom: 'http_request_firewall_custom',
  rateLimit: 'http_ratelimit',
} as const;
type Phase = keyof typeof PHASE;
// The permissions, as Connections names them (worker/provider-apps.ts).
const WAF = 'Zone WAF Write',
  BOTS = 'Bot Management Write',
  SETTINGS = 'Zone Settings Write';
// A rate limit as Cloudflare's Free plan allows one: the requests of one IP address in one
// data center, counted over 10 seconds, then blocked for 10 seconds.
const RATE = {
  characteristics: ['cf.colo.id', 'ip.src'],
  period: 10,
  mitigation_timeout: 10,
};
const MOST_REQUESTS = 100000;

const id32 = z.string().regex(/^[a-f0-9]{32}$/);
const hostname =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
// Two characters, as Cloudflare's country field has them (T1 is Tor, XX unknown).
const country = /^[A-Z][A-Z0-9]$/;
const ipv4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const ipv6 =
  /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/;
// Characters that need no escaping in an expression's string or wildcard.
const urlPath = /^\/[A-Za-z0-9._~/-]{0,200}$/;

const ruleSchema = z.object({
  id: id32,
  action: z.string().max(100),
  expression: z.string().max(20000).default(''),
  description: z.string().max(2000).default(''),
  enabled: z.boolean().default(true),
  action_parameters: z.record(z.string(), z.unknown()).optional(),
  ratelimit: z.record(z.string(), z.unknown()).optional(),
  ref: z.string().max(200).optional(),
  logging: z.record(z.string(), z.unknown()).optional(),
});
const rulesetSchema = z.object({
  id: id32,
  rules: z.array(ruleSchema).default([]),
});
type Rule = z.infer<typeof ruleSchema>;
type Entry = { id: string | null; rules: Rule[] };
type NewRule = Omit<Rule, 'id' | 'ref' | 'logging'>;
type Zone = { id: string; name: string; hosts: string[] };

const tag = (t: Target) => `[app ${t.p.id}]`;
const mine = (t: Target, r: Rule) => r.description.includes(tag(t));
const describe = (t: Target, what: string) => `Shipcel ${tag(t)}: ${what}`;
const isFreeManaged = (r: Rule) =>
  r.action === 'execute' && r.action_parameters?.id === FREE_MANAGED;
const count = (value: unknown) => (typeof value === 'number' ? value : null);

// A Cloudflare call. A refusal names the permission the connection lacks; a refused change
// passes on Cloudflare's reason, such as a plan's rule quota.
async function call<T>(
  t: Target,
  permission: string,
  path: string,
  init: RequestInit = {},
) {
  try {
    return await cloudflare<T>(t.token, path, init, {
      errorDetail: !!init.method,
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      throw new AppError(
        403,
        `Cloudflare refused: this Cloudflare connection has no ${permission} permission. Cloudflare sign-ins set up from 23 October 2026 ask for it; an older one has to be set up again on Connections.`,
      );
    throw error;
  }
}

// The rules of one of a zone's phases: none when the zone has no entry point for it yet.
async function entry(t: Target, zone: string, phase: Phase): Promise<Entry> {
  try {
    return rulesetSchema.parse(
      await call(
        t,
        WAF,
        `/zones/${zone}/rulesets/phases/${PHASE[phase]}/entrypoint`,
      ),
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 404)
      return { id: null, rules: [] };
    throw error;
  }
}

// Adds a rule at the end of a phase's entry point, which is created with it when the zone
// has none, and returns the new rule's ID.
async function add(
  t: Target,
  zone: string,
  phase: Phase,
  current: Entry,
  rule: NewRule,
) {
  const ruleset = rulesetSchema.parse(
    await call(
      t,
      WAF,
      current.id
        ? `/zones/${zone}/rulesets/${current.id}/rules`
        : `/zones/${zone}/rulesets`,
      {
        method: 'POST',
        body: JSON.stringify(
          current.id
            ? rule
            : {
                name: 'default',
                kind: 'zone',
                phase: PHASE[phase],
                rules: [rule],
              },
        ),
      },
    ),
  );
  const added = [...ruleset.rules]
    .reverse()
    .find((r) => r.description === rule.description);
  if (!added)
    throw new AppError(
      502,
      'Cloudflare didn’t return the new rule. Check the zone’s security rules in Cloudflare.',
    );
  return added.id;
}

const rulePath = (zone: string, current: Entry, id: string) =>
  `/zones/${zone}/rulesets/${current.id}/rules/${id}`;

// The zones of the app's custom domains, each with the app's host names in it. Another
// app's domain in the same zone is not this app's.
async function zonesOf(t: Target): Promise<Zone[]> {
  const domains = z
    .array(
      z.object({
        hostname: z.string(),
        service: z.string(),
        zone_id: id32,
        zone_name: z.string().max(253).optional(),
      }),
    )
    .parse(await cloudflare(t.token, `${t.root}/workers/domains`))
    .filter((d) => d.service === t.job.worker_name)
    .map((d) => ({ ...d, hostname: d.hostname.toLowerCase() }));
  if (domains.some((d) => !hostname.test(d.hostname)))
    throw new AppError(
      502,
      'Cloudflare returned a custom domain Shipcel can’t put in a rule.',
    );
  return [...new Set(domains.map((d) => d.zone_id))].map((id) => ({
    id,
    name: domains.find((d) => d.zone_id === id)?.zone_name ?? id,
    hosts: domains.filter((d) => d.zone_id === id).map((d) => d.hostname),
  }));
}

async function appZones(t: Target) {
  const zones = await zonesOf(t);
  if (!zones.length)
    throw new AppError(
      409,
      "This app has no custom domain. Cloudflare's firewall belongs to a domain's zone: add one on the Domains tab or with shipcel domains add. Its workers.dev address has Cloudflare's DDoS protection, but no firewall rules.",
    );
  return zones;
}

// Whether the app also answers at its workers.dev address, where no zone firewall applies;
// null when Cloudflare doesn't say.
async function onWorkersDev(t: Target) {
  try {
    const answer = z
      .object({ enabled: z.boolean() })
      .safeParse(await cloudflare(t.token, `${t.script}/subdomain`));
    return answer.success ? answer.data.enabled : null;
  } catch (error) {
    if (error instanceof AppError) return null;
    throw error;
  }
}

async function securityLevel(t: Target, zone: string) {
  return z
    .object({ value: z.string() })
    .parse(await call(t, SETTINGS, `/zones/${zone}/settings/security_level`))
    .value;
}

// A rule as the panel lists it: what Shipcel made says what it does; anything else shows
// its own description, or its expression.
function shown(t: Target, r: Rule) {
  const ours = mine(t, r);
  return {
    id: r.id,
    action: r.action,
    summary: ours
      ? r.description
          .slice(r.description.indexOf(tag(t)) + tag(t).length)
          .replace(/^:\s*/, '')
      : `${r.action}: ${r.description || r.expression}`.slice(0, 160),
    enabled: r.enabled,
    ours,
  };
}

async function zoneStatus(t: Target, zone: Zone) {
  const denied = new Set<string>();
  // A part the connection may not read: null, with its permission noted.
  const read = async <T>(permission: string, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof AppError && error.status === 403)) throw error;
      denied.add(permission);
      return null;
    }
  };
  const [managed, custom, rate, bots, level, plan] = await Promise.all([
    read(WAF, () => entry(t, zone.id, 'managed')),
    read(WAF, () => entry(t, zone.id, 'custom')),
    read(WAF, () => entry(t, zone.id, 'rateLimit')),
    read(BOTS, async () =>
      z
        .object({
          fight_mode: z.boolean().optional(),
          ai_bots_protection: z.string().optional(),
        })
        .parse(await call(t, BOTS, `/zones/${zone.id}/bot_management`)),
    ),
    read(SETTINGS, () => securityLevel(t, zone.id)),
    zonePlanOf(t, zone.id),
  ]);
  // Cloudflare's rule when there is one; otherwise Cloudflare's default on a Free zone.
  const explicit = managed?.rules.find(isFreeManaged);
  const byDefault = managed !== null && !explicit && plan === 'free';
  return {
    ...zone,
    managed: managed ? (explicit ? explicit.enabled : byDefault) : null,
    ...(byDefault ? { managedDefault: true } : {}),
    bots: bots ? bots.fight_mode === true : null,
    aiBots: bots ? bots.ai_bots_protection === 'block' : null,
    underAttack: level === null ? null : level === 'under_attack',
    rules: custom ? custom.rules.map((r) => shown(t, r)) : null,
    rateLimits: rate
      ? rate.rules.map((r) => ({
          ...shown(t, r),
          requests: count(r.ratelimit?.requests_per_period),
          period: count(r.ratelimit?.period),
        }))
      : null,
    denied: [WAF, BOTS, SETTINGS].filter((p) => denied.has(p)),
  };
}

async function status(t: Target) {
  const [zones, workersDev] = await Promise.all([zonesOf(t), onWorkersDev(t)]);
  return {
    workersDev,
    zones: await Promise.all(zones.map((zone) => zoneStatus(t, zone))),
  };
}

// Off keeps the rule that runs the ruleset, with any changes made to it in Cloudflare, so
// turning it on again brings it back as it was.
// The zone's plan, or null when it can't be read. Cloudflare runs its Free Managed Ruleset on
// Free zones without a rule in the entry point (seen live on shipcel.com, 28 Oct 2026).
async function zonePlanOf(t: Target, zone: string) {
  try {
    return (
      z
        .object({
          plan: z.object({ legacy_id: z.string().optional() }).optional(),
        })
        .parse(await call(t, WAF, `/zones/${zone}`)).plan?.legacy_id ?? null
    );
  } catch {
    return null;
  }
}

async function setManaged(t: Target, zone: string, on: boolean) {
  const current = await entry(t, zone, 'managed');
  const rule = current.rules.find(isFreeManaged);
  if (rule) {
    if (rule.enabled === on) return;
    const { id: _id, ...kept } = rule;
    await call(t, WAF, rulePath(zone, current, rule.id), {
      method: 'PATCH',
      body: JSON.stringify({ ...kept, enabled: on }),
    });
    return;
  }
  // No rule of Cloudflare's: on a Free zone the ruleset runs anyway, so "on" needs nothing and
  // "off" adds the rule disabled; elsewhere "on" adds it enabled and "off" needs nothing.
  const free = (await zonePlanOf(t, zone)) === 'free';
  if (on !== free)
    await add(t, zone, 'managed', current, {
      action: 'execute',
      action_parameters: { id: FREE_MANAGED },
      expression: 'true',
      description: 'Cloudflare Free Managed Ruleset',
      enabled: on,
    });
}

// Off goes back to Cloudflare's default level; a level other than Under Attack is left as
// it is.
async function setUnderAttack(t: Target, zone: string, on: boolean) {
  if (((await securityLevel(t, zone)) === 'under_attack') === on) return;
  await call(t, SETTINGS, `/zones/${zone}/settings/security_level`, {
    method: 'PATCH',
    body: JSON.stringify({ value: on ? 'under_attack' : 'medium' }),
  });
}

// A path and everything below it; a trailing slash doesn't count.
function pathOf(value: string) {
  const path = value.replace(/(.)\/+$/, '$1');
  if (!urlPath.test(path))
    throw new AppError(
      400,
      `${value} isn't a path such as /admin: it starts with / and has only letters, digits and . _ ~ - /.`,
    );
  return path;
}
const pathMatch = (path: string) =>
  path === '/'
    ? 'http.request.uri.path wildcard "/*"'
    : `http.request.uri.path wildcard "${path}" or http.request.uri.path wildcard "${path}/*"`;
// A list in a rule's description: the first five, then how many more.
const brief = (items: string[]) =>
  items.length > 5
    ? `${items.slice(0, 5).join(', ')} and ${items.length - 5} more`
    : items.join(', ');

// A rule's condition from what was typed, checked so that nothing typed reaches the
// expression unescaped.
function matchOf(match: 'country' | 'ip' | 'path', values: string[]) {
  if (match === 'path') {
    if (values.length !== 1)
      throw new AppError(400, 'A rule matches one path.');
    const path = pathOf(values[0]);
    return { expression: pathMatch(path), text: `path ${path}` };
  }
  const items = [
    ...new Set(
      values.map((v) =>
        match === 'country' ? v.toUpperCase() : v.toLowerCase(),
      ),
    ),
  ];
  const bad = items.find((v) =>
    match === 'country' ? !country.test(v) : !ipv4.test(v) && !ipv6.test(v),
  );
  if (bad !== undefined)
    throw new AppError(
      400,
      match === 'country'
        ? `${bad} isn't a country code: use two letters, such as CN or RU.`
        : `${bad} isn't an IP address or range, such as 203.0.113.7 or 198.51.100.0/24.`,
    );
  return match === 'country'
    ? {
        expression: `ip.src.country in {${items.map((v) => `"${v}"`).join(' ')}}`,
        text: `countries ${brief(items)}`,
      }
    : {
        expression: `ip.src in {${items.join(' ')}}`,
        text: `IPs ${brief(items)}`,
      };
}

const confirmed = z.object({ confirm: z.literal(true) }).strict();

firewall.get('/projects/:id/security', async (c) =>
  c.json(await status(await target(c))),
);

firewall.put('/projects/:id/security', async (c) => {
  const { confirm: _confirm, ...input } = z
    .object({
      managed: z.boolean().optional(),
      bots: z.boolean().optional(),
      aiBots: z.boolean().optional(),
      underAttack: z.boolean().optional(),
      confirm: z.literal(true),
    })
    .strict()
    .parse(await c.req.json());
  if (!Object.keys(input).length)
    throw new AppError(400, 'Name a setting to change.');
  const t = await target(c, true);
  await limit(c.env, `security:${t.p.id}`, 30);
  for (const zone of await appZones(t)) {
    if (input.managed !== undefined)
      await setManaged(t, zone.id, input.managed);
    if (input.bots !== undefined || input.aiBots !== undefined)
      await call(t, BOTS, `/zones/${zone.id}/bot_management`, {
        method: 'PUT',
        body: JSON.stringify({
          ...(input.bots === undefined ? {} : { fight_mode: input.bots }),
          ...(input.aiBots === undefined
            ? {}
            : { ai_bots_protection: input.aiBots ? 'block' : 'disabled' }),
        }),
      });
    if (input.underAttack !== undefined)
      await setUnderAttack(t, zone.id, input.underAttack);
  }
  return c.json(await status(t));
});

// A custom rule: block or challenge countries, IP addresses or a path, on the app's own
// host names in each of its zones.
firewall.post('/projects/:id/security/rules', async (c) => {
  const input = z
    .object({
      action: z.enum(['block', 'challenge']),
      match: z.enum(['country', 'ip', 'path']),
      values: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
      confirm: z.literal(true),
    })
    .strict()
    .parse(await c.req.json());
  const condition = matchOf(input.match, input.values);
  const t = await target(c, true);
  await limit(c.env, `security:${t.p.id}`, 30);
  const summary = `${input.action} ${condition.text}`;
  const added: { zone: string; id: string }[] = [];
  for (const zone of await appZones(t))
    added.push({
      zone: zone.name,
      id: await add(t, zone.id, 'custom', await entry(t, zone.id, 'custom'), {
        action: input.action === 'block' ? 'block' : 'managed_challenge',
        expression: `(http.host in {${zone.hosts.map((h) => `"${h}"`).join(' ')}}) and (${condition.expression})`,
        description: describe(t, summary),
        enabled: true,
      }),
    });
  return c.json({ added, summary, ...(await status(t)) }, 201);
});

firewall.delete('/projects/:id/security/rules/:rule', async (c) => {
  confirmed.parse(await c.req.json());
  const id = id32.parse(c.req.param('rule'));
  const t = await target(c, true);
  await limit(c.env, `security:${t.p.id}`, 30);
  for (const zone of await appZones(t)) {
    const current = await entry(t, zone.id, 'custom');
    const rule = current.rules.find((r) => r.id === id);
    if (!rule) continue;
    if (!mine(t, rule))
      throw new AppError(
        409,
        "This rule wasn't made for this app. Change it in Cloudflare's dashboard.",
      );
    await call(t, WAF, rulePath(zone.id, current, id), { method: 'DELETE' });
    return c.json({ removed: id });
  }
  throw new AppError(404, `No rule ${id} in this app's zones.`);
});

// One rate limit per zone for a path and everything below it. Cloudflare's Free plan
// matches a rate limit on the path only, so it counts that path on every host name in the
// zone.
firewall.put('/projects/:id/security/rate-limit', async (c) => {
  const input = z
    .object({
      path: z.string().max(300),
      requests: z.number().int().min(1).max(MOST_REQUESTS),
      confirm: z.literal(true),
    })
    .strict()
    .parse(await c.req.json());
  const path = pathOf(input.path);
  const t = await target(c, true);
  await limit(c.env, `security:${t.p.id}`, 30);
  const rule = {
    action: 'block',
    expression: `(${pathMatch(path)})`,
    description: describe(
      t,
      `at most ${input.requests} requests per 10 seconds per visitor to ${path}`,
    ),
    enabled: true,
    ratelimit: { ...RATE, requests_per_period: input.requests },
  };
  for (const zone of await appZones(t)) {
    const current = await entry(t, zone.id, 'rateLimit');
    const ours = current.rules.find((r) => mine(t, r));
    if (ours)
      await call(t, WAF, rulePath(zone.id, current, ours.id), {
        method: 'PATCH',
        body: JSON.stringify(rule),
      });
    else await add(t, zone.id, 'rateLimit', current, rule);
  }
  return c.json(await status(t));
});

firewall.delete('/projects/:id/security/rate-limit', async (c) => {
  confirmed.parse(await c.req.json());
  const t = await target(c, true);
  await limit(c.env, `security:${t.p.id}`, 30);
  const removed: string[] = [];
  for (const zone of await appZones(t)) {
    const current = await entry(t, zone.id, 'rateLimit');
    const ours = current.rules.find((r) => mine(t, r));
    if (!ours) continue;
    await call(t, WAF, rulePath(zone.id, current, ours.id), {
      method: 'DELETE',
    });
    removed.push(zone.name);
  }
  if (!removed.length) throw new AppError(404, 'This app has no rate limit.');
  return c.json({ removed });
});
