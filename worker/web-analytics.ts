import { Hono } from 'hono';
import { z } from 'zod';
import { workersSubdomain } from './health';
import { target, type Target } from './operations';
import { cloudflare, cloudflarePage, providerJSON } from './providers';
import { AppError, type AppEnv } from './types';

// Manage → Visitors: page views, visits, top pages, referrers, countries, devices,
// browsers and Core Web Vitals from Cloudflare Web Analytics, which counts visitors with a
// small script in the app's pages (free, no cookies). Shipcel can't create a Web Analytics
// site (Cloudflare asks for Account Settings Write): the owner adds one in Cloudflare for the
// app's address, and Shipcel finds it with Account Settings Read. Read-only.
export const webAnalytics = new Hono<AppEnv>();

const ranges = {
  '24h': { hours: 24, bucket: 'datetimeHour' },
  '7d': { hours: 24 * 7, bucket: 'datetimeHour' },
  '30d': { hours: 24 * 30, bucket: 'date' },
} as const;
type Range = keyof typeof ranges;
const SITE_PAGES = 10;

const siteSchema = z
  .object({
    site_tag: z.string(),
    site_token: z.string().nullable().optional(),
    host: z.string().nullable().optional(),
    rules: z
      .array(z.object({ host: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
    ruleset: z
      .object({ zone_name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
type Site = z.infer<typeof siteSchema>;
const domainsSchema = z.array(
  z.object({ hostname: z.string(), service: z.string() }).passthrough(),
);

// The app's addresses: its workers.dev address and the custom domains on its Worker.
async function appHosts(t: Target) {
  const [subdomain, domains] = await Promise.all([
    workersSubdomain(t.token, t.job.account_id),
    cloudflare(t.token, `${t.root}/workers/domains`)
      .then((result) => domainsSchema.parse(result))
      .catch(() => []),
  ]);
  return [
    ...(subdomain ? [`${t.job.worker_name}.${subdomain}.workers.dev`] : []),
    ...domains
      .filter((d) => d.service === t.job.worker_name)
      .map((d) => d.hostname.toLowerCase()),
  ];
}

// The Web Analytics site for one of the app's addresses: one made for the address itself,
// or for the zone a custom domain is in (then only the app's addresses are counted).
async function findSite(t: Target, hosts: string[]) {
  const named = (site: Site) =>
    [site.host, ...(site.rules ?? []).map((r) => r.host)].some(
      (h) => h && hosts.includes(h.toLowerCase()),
    );
  const zoned = (site: Site) => {
    const zone = site.ruleset?.zone_name?.toLowerCase();
    return Boolean(
      zone && hosts.some((h) => h === zone || h.endsWith(`.${zone}`)),
    );
  };
  for (let page = 1; page <= SITE_PAGES; page++) {
    const { result, info } = await cloudflarePage<unknown>(
      t.token,
      `${t.root}/rum/site_info/list?per_page=100&page=${page}`,
    );
    const sites = z.array(siteSchema).parse(result ?? []);
    const found = sites.find(named) ?? sites.find(zoned);
    if (found) return { site: found, wholeZone: !named(found) };
    if (sites.length < 100 || page * 100 >= Number(info.total_count ?? 0))
      break;
  }
  return null;
}

const vitalsFields = ['lcp', 'inp', 'cls'] as const;
const visitorsQuery = (bucket: 'datetimeHour' | 'date') => {
  const filter =
    'filter: { siteTag: $site, requestHost_in: $hosts, datetime_geq: $since, datetime_leq: $until, bot: 0 }';
  const top = (alias: string, dimension: string, limit: number) =>
    `${alias}: rumPageloadEventsAdaptiveGroups(limit: ${limit}, ${filter}, orderBy: [count_DESC]) { count dimensions { ${dimension} } }`;
  return `query Visitors($account: string!, $site: string!, $hosts: [string!]!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      total: rumPageloadEventsAdaptiveGroups(limit: 1, ${filter}) { count sum { visits } }
      series: rumPageloadEventsAdaptiveGroups(limit: 1000, ${filter}, orderBy: [${bucket}_ASC]) { count sum { visits } dimensions { ${bucket} } }
      ${top('pages', 'requestPath', 10)}
      ${top('referrers', 'refererHost', 12)}
      ${top('countries', 'countryName', 10)}
      ${top('devices', 'deviceType', 5)}
      ${top('browsers', 'userAgentBrowser', 8)}
      vitals: rumWebVitalsEventsAdaptiveGroups(limit: 1, ${filter}) {
        count
        sum { ${vitalsFields.map((v) => `${v}Good ${v}NeedsImprovement ${v}Poor ${v}Total`).join(' ')} }
        quantiles { largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75 }
      }
    }
  }
}`;
};
const count = z.number().nonnegative();
const groupSchema = z
  .object({
    count,
    sum: z.object({ visits: count }).partial().optional(),
    dimensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const answerSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        accounts: z.array(
          z
            .object({
              total: z.array(groupSchema),
              series: z.array(groupSchema),
              pages: z.array(groupSchema),
              referrers: z.array(groupSchema),
              countries: z.array(groupSchema),
              devices: z.array(groupSchema),
              browsers: z.array(groupSchema),
              vitals: z.array(
                z
                  .object({
                    count,
                    sum: z.record(z.string(), z.number()).optional(),
                    quantiles: z.record(z.string(), z.number()).optional(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        ),
      }),
    })
    .nullable(),
  errors: z
    .array(z.object({ message: z.string() }))
    .nullable()
    .optional(),
});
const shortText = (text: string, max = 300) =>
  text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const label = (value: unknown) =>
  typeof value === 'string' && value ? value.slice(0, 300) : '';

// The beacon Cloudflare asks to be put in every page, for a site's token.
const beacon = (token: string) =>
  `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${token}"}'></script>`;

webAnalytics.get('/projects/:id/web-analytics', async (c) => {
  const range = z
    .enum(Object.keys(ranges) as [Range, ...Range[]])
    .parse(c.req.query('range') ?? '24h');
  const { hours, bucket } = ranges[range];
  const t = await target(c);
  const hosts = await appHosts(t);
  let found: Awaited<ReturnType<typeof findSite>>;
  try {
    found = hosts.length ? await findSite(t, hosts) : null;
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      throw new AppError(
        403,
        'Cloudflare denied access to Web Analytics. Reconnect Cloudflare so Shipcel can read the account’s settings.',
      );
    throw error;
  }
  const account = t.job.account_id;
  const setup = `https://dash.cloudflare.com/${account}/web-analytics`;
  if (!found) return c.json({ site: null, hosts, setup });
  const { site, wholeZone } = found;
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600 * 1000);
  const answer = answerSchema.parse(
    await providerJSON('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${t.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: visitorsQuery(bucket),
        variables: {
          account,
          site: site.site_tag,
          hosts,
          since: since.toISOString(),
          until: until.toISOString(),
        },
      }),
    }),
  );
  const data = answer.data?.viewer.accounts[0];
  if (answer.errors?.length || !data)
    throw new AppError(
      502,
      `Cloudflare Web Analytics: ${shortText(answer.errors?.[0]?.message ?? 'no data')}`,
    );
  const ranked = (groups: z.infer<typeof groupSchema>[], key: string) =>
    groups
      .map((g) => ({ name: label(g.dimensions?.[key]), views: g.count }))
      .filter((r) => r.name);
  const vitals = data.vitals[0];
  const sum = (key: string) => vitals?.sum?.[key] ?? 0;
  const p75 = (key: string) => {
    const value = vitals?.quantiles?.[key];
    // Negative means Cloudflare has no value.
    return typeof value === 'number' && value >= 0 ? value : null;
  };
  const rating = (v: (typeof vitalsFields)[number]) => ({
    good: sum(`${v}Good`),
    needsImprovement: sum(`${v}NeedsImprovement`),
    poor: sum(`${v}Poor`),
    total: sum(`${v}Total`),
  });
  const milliseconds = (value: number | null) =>
    value === null ? null : Math.round(value / 1000);
  return c.json({
    site: {
      tag: site.site_tag,
      wholeZone,
      beacon: site.site_token ? beacon(site.site_token) : null,
    },
    hosts,
    setup,
    range,
    bucket: bucket === 'date' ? 'day' : 'hour',
    totals: {
      pageViews: data.total[0]?.count ?? 0,
      visits: data.total[0]?.sum?.visits ?? 0,
    },
    series: data.series.map((g) => ({
      at: label(g.dimensions?.[bucket]),
      pageViews: g.count,
      visits: g.sum?.visits ?? 0,
    })),
    pages: ranked(data.pages, 'requestPath'),
    // Not the app's own pages linking to each other.
    referrers: ranked(data.referrers, 'refererHost').filter(
      (r) => !hosts.includes(r.name.toLowerCase()),
    ),
    countries: ranked(data.countries, 'countryName'),
    devices: ranked(data.devices, 'deviceType'),
    browsers: ranked(data.browsers, 'userAgentBrowser'),
    // Core Web Vitals at the 75th percentile, as Google judges them: milliseconds for LCP
    // and INP (Cloudflare reports microseconds), a score for CLS; and how many page views
    // were good, needed improvement or were poor.
    vitals: {
      lcp: {
        p75: milliseconds(p75('largestContentfulPaintP75')),
        ...rating('lcp'),
      },
      inp: {
        p75: milliseconds(p75('interactionToNextPaintP75')),
        ...rating('inp'),
      },
      cls: { p75: p75('cumulativeLayoutShiftP75'), ...rating('cls') },
    },
  });
});
