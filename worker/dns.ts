import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { activeGrant, grantToken, limit, requireIdentity } from './auth';
import { target } from './operations';
import { cloudflare, cloudflarePage } from './providers';
import { AppError, type AppEnv } from './types';

// `shipcel dns`: the DNS records of the zones in the workspace's Cloudflare account, read
// and changed through Cloudflare's API with the connection's DNS Write and Zone Read. A
// change needs a developer or owner and explicit consent; Cloudflare refuses changes to the
// records it manages itself, such as a Worker's custom domain.
export const dns = new Hono<AppEnv>();

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const recordId = z.string().regex(/^[a-f0-9]{32}$/);
const ipv4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const hostname =
  /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9-]{1,63}\.?$/i;
const record = z
  .object({
    type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX']),
    // A name in the zone (www), the zone itself (@), or a full name.
    name: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^(@|\*|[A-Za-z0-9_*.-]+)$/),
    content: z.string().trim().min(1).max(2048),
    // 1 is Cloudflare's "automatic".
    ttl: z
      .union([z.literal(1), z.number().int().min(60).max(86400)])
      .default(1),
    proxied: z.boolean().optional(),
    priority: z.number().int().min(0).max(65535).optional(),
    confirm: z.literal(true),
  })
  .strict()
  .superRefine((r, ctx) => {
    const bad = (message: string) =>
      ctx.addIssue({ code: 'custom', path: ['content'], message });
    if (r.type === 'A' && !ipv4.test(r.content))
      bad('An A record points at an IPv4 address.');
    if (r.type === 'AAAA' && !/^[0-9a-f:]+$/i.test(r.content))
      bad('An AAAA record points at an IPv6 address.');
    if ((r.type === 'CNAME' || r.type === 'MX') && !hostname.test(r.content))
      bad(`A ${r.type} record points at a host name.`);
    if (r.type === 'MX' && r.priority === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['priority'],
        message: 'An MX record needs a priority.',
      });
    if (r.proxied && !['A', 'AAAA', 'CNAME'].includes(r.type))
      ctx.addIssue({
        code: 'custom',
        path: ['proxied'],
        message:
          'Only A, AAAA and CNAME records go through Cloudflare’s proxy.',
      });
  });
const recordSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
    content: z.string(),
    proxied: z.boolean().optional(),
    ttl: z.number(),
    priority: z.number().optional(),
  })
  .passthrough();
const shown = (r: z.infer<typeof recordSchema>) => ({
  id: r.id,
  type: r.type,
  name: r.name,
  content: r.content,
  proxied: r.proxied ?? false,
  ttl: r.ttl,
  ...(r.priority !== undefined ? { priority: r.priority } : {}),
});

async function account(c: Context<AppEnv>, need: 'view' | 'deploy') {
  const who = requireIdentity(c, need);
  const grant = await activeGrant(c.env, who.workspaceId, 'cloudflare');
  if (!grant?.account_id)
    throw new AppError(409, 'Connect Cloudflare and select an account first.');
  return {
    who,
    token: await grantToken(c.env, grant),
    accountId: grant.account_id,
  };
}
// A zone of the connected account, by its name.
async function zone(c: Context<AppEnv>, need: 'view' | 'deploy') {
  const a = await account(c, need);
  const name = domain.parse(c.req.param('domain'));
  const zones = z
    .array(
      z
        .object({ id: z.string().regex(/^[a-f0-9]{32}$/), name: z.string() })
        .passthrough(),
    )
    .parse(
      await cloudflare(
        a.token,
        `/zones?${new URLSearchParams({ name, 'account.id': a.accountId })}`,
      ),
    );
  const found = zones.find((zn) => zn.name.toLowerCase() === name);
  if (!found)
    throw new AppError(
      404,
      `${name} isn't a zone of the connected Cloudflare account. shipcel dns ls lists them.`,
    );
  return { ...a, zone: found };
}

dns.get('/dns', async (c) => {
  const a = await account(c, 'view');
  const { result } = await cloudflarePage<unknown>(
    a.token,
    `/zones?${new URLSearchParams({ 'account.id': a.accountId, per_page: '50' })}`,
  );
  return c.json(
    z
      .array(
        z
          .object({ name: z.string(), status: z.string().optional() })
          .passthrough(),
      )
      .parse(result)
      .map((zn) => ({ name: zn.name, status: zn.status ?? null })),
  );
});

dns.get('/dns/:domain/records', async (c) => {
  const { token, zone: zn } = await zone(c, 'view');
  const records = [];
  for (let page = 1; page <= 10; page++) {
    const { result, info } = await cloudflarePage<unknown>(
      token,
      `/zones/${zn.id}/dns_records?per_page=100&page=${page}`,
    );
    const list = z.array(recordSchema).parse(result);
    records.push(...list.map(shown));
    if (list.length < 100 || records.length >= Number(info.total_count ?? 0))
      break;
  }
  return c.json({ zone: zn.name, records });
});

dns.post('/dns/:domain/records', async (c) => {
  const input = record.parse(await c.req.json());
  const { token, zone: zn, who } = await zone(c, 'deploy');
  await limit(c.env, `dns:${who.workspaceId}`, 30);
  const { confirm: _confirm, ...body } = input;
  const created = recordSchema.parse(
    await cloudflare(token, `/zones/${zn.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return c.json(shown(created), 201);
});

dns.delete('/dns/:domain/records/:record', async (c) => {
  z.object({ confirm: z.literal(true) })
    .strict()
    .parse(await c.req.json());
  const id = recordId.parse(c.req.param('record'));
  const { token, zone: zn, who } = await zone(c, 'deploy');
  await limit(c.env, `dns:${who.workspaceId}`, 30);
  await cloudflare(token, `/zones/${zn.id}/dns_records/${id}`, {
    method: 'DELETE',
  });
  return c.json({ deleted: id });
});

// `shipcel cache purge`: empties Cloudflare's cache for the app's custom domains, all of it or
// some URLs on them. The cache belongs to a domain's zone, so a workers.dev address has none
// Shipcel can purge; static files get fresh with every deploy anyway. Needs the connection's
// Cache Purge permission; Cloudflare's Free plan purges hostnames 5 times a minute.
dns.post('/projects/:id/cache/purge', async (c) => {
  const input = z
    .object({
      urls: z.array(z.string().url().max(2048)).max(100).optional(),
      confirm: z.literal(true),
    })
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true);
  await limit(c.env, `purge:${t.p.id}`, 5);
  const domains = z
    .array(
      z
        .object({
          hostname: z.string(),
          service: z.string(),
          zone_id: z.string().regex(/^[a-f0-9]{32}$/),
        })
        .passthrough(),
    )
    .parse(await cloudflare(t.token, `${t.root}/workers/domains`))
    .filter((d) => d.service === t.job.worker_name)
    .map((d) => ({ host: d.hostname.toLowerCase(), zone: d.zone_id }));
  if (!domains.length)
    throw new AppError(
      409,
      "This app has no custom domain. Cloudflare's cache belongs to a domain: a workers.dev address has none to purge, and static files get fresh with every deploy.",
    );
  const zoneOf = (host: string) => domains.find((d) => d.host === host)?.zone;
  const perZone = new Map<string, { hosts: string[]; files: string[] }>();
  const add = (zone: string) => {
    if (!perZone.has(zone)) perZone.set(zone, { hosts: [], files: [] });
    return perZone.get(zone)!;
  };
  if (input.urls?.length)
    for (const url of input.urls) {
      const zone = zoneOf(new URL(url).hostname.toLowerCase());
      if (!zone)
        throw new AppError(
          400,
          `${new URL(url).hostname} isn't one of this app's custom domains.`,
        );
      add(zone).files.push(url);
    }
  else for (const d of domains) add(d.zone).hosts.push(d.host);
  try {
    for (const [zone, { hosts, files }] of perZone)
      await cloudflare(t.token, `/zones/${zone}/purge_cache`, {
        method: 'POST',
        body: JSON.stringify(files.length ? { files } : { hosts }),
      });
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      throw new AppError(
        403,
        'Cloudflare refused: this Cloudflare connection has no Cache Purge permission. Cloudflare sign-ins set up from 21 October 2026 ask for it; an older one has to be set up again on Connections.',
      );
    throw error;
  }
  return c.json({
    purged: input.urls?.length
      ? { urls: input.urls }
      : { hosts: domains.map((d) => d.host) },
  });
});
