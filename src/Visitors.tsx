import { useEffect, useState } from 'react';
import { ArrowUpRight, Eye, RefreshCw } from 'lucide-react';
import { api } from './api';
import { BarChart } from './BarChart';
import { CopyButton } from './Developers';

// Manage → Visitors (worker/web-analytics.ts): Cloudflare Web Analytics for the app, which
// counts visitors with a small script in its pages (free, no cookies), and its Core Web
// Vitals. The owner adds the Web Analytics site in Cloudflare; Shipcel finds it by the
// app's addresses.

type Range = '24h' | '7d' | '30d';
type Ranked = { name: string; views: number }[];
type Vital = {
  p75: number | null;
  good: number;
  needsImprovement: number;
  poor: number;
  total: number;
};
type Visitors = {
  site: { tag: string; wholeZone: boolean; beacon: string | null } | null;
  hosts: string[];
  setup: string;
  bucket?: 'hour' | 'day';
  totals?: { pageViews: number; visits: number };
  series?: { at: string; pageViews: number; visits: number }[];
  pages?: Ranked;
  referrers?: Ranked;
  countries?: Ranked;
  devices?: Ranked;
  browsers?: Ranked;
  vitals?: { lcp: Vital; inp: Vital; cls: Vital };
};

const ranges: Record<Range, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
const count = new Intl.NumberFormat();
const when = (at: string, byDay: boolean) =>
  byDay
    ? new Date(`${at.slice(0, 10)}T00:00:00Z`).toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : new Date(at).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
      });
// Countries come as two-letter codes.
const regions = (() => {
  try {
    return new Intl.DisplayNames([], { type: 'region' });
  } catch {
    return null;
  }
})();
const country = (code: string) => {
  try {
    return regions?.of(code) ?? code;
  } catch {
    return code;
  }
};
// Google's thresholds for Core Web Vitals at the 75th percentile.
const vitals = [
  {
    id: 'lcp',
    name: 'Largest Contentful Paint',
    explain: 'how soon the main content shows',
    good: 2500,
    poor: 4000,
    show: (v: number) => `${(v / 1000).toFixed(2)} s`,
  },
  {
    id: 'inp',
    name: 'Interaction to Next Paint',
    explain: 'how quickly the page answers a click or a key',
    good: 200,
    poor: 500,
    show: (v: number) => `${count.format(v)} ms`,
  },
  {
    id: 'cls',
    name: 'Cumulative Layout Shift',
    explain: 'how much the page moves while it loads',
    good: 0.1,
    poor: 0.25,
    show: (v: number) => v.toFixed(2),
  },
] as const;
const verdict = (value: number, good: number, poor: number) =>
  value <= good ? 'Good' : value <= poor ? 'Needs improvement' : 'Poor';
const percent = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : '0%';

function TopList({
  title,
  column,
  rows,
  total,
  name = (n) => n,
}: {
  title: string;
  // What one row is: Page, Referrer…
  column: string;
  rows: Ranked;
  total: number;
  name?: (value: string) => string;
}) {
  return (
    <div className="top-list">
      <h3>{title}</h3>
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th scope="col">{column}</th>
              <th scope="col">Page views</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{name(r.name)}</td>
                <td>
                  {count.format(r.views)} ({percent(r.views, total)})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="field-hint">None in this period.</p>
      )}
    </div>
  );
}

export function VisitorsPanel({
  root,
  busy,
  action,
}: {
  root: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
}) {
  const [range, setRange] = useState<Range>('24h'),
    [data, setData] = useState<Visitors | null>(null);
  async function load(next = range) {
    setData(await api<Visitors>(`${root}/web-analytics?range=${next}`));
  }
  useEffect(() => {
    void action(() => load());
  }, [root]);
  const totals = data?.totals;
  const byDay = data?.bucket === 'day';
  return (
    <section className="panel operation-body observability">
      <div className="operation-title">
        <h2>
          <Eye size={18} aria-hidden="true" /> Visitors
        </h2>
        {data?.site && (
          <div className="integration-actions">
            {(Object.keys(ranges) as Range[]).map((r) => (
              <button
                key={r}
                type="button"
                className={`button ${range === r ? 'primary' : 'secondary'}`}
                aria-pressed={range === r}
                disabled={busy}
                onClick={() => {
                  setRange(r);
                  void action(() => load(r));
                }}
              >
                {ranges[r]}
              </button>
            ))}
          </div>
        )}
      </div>
      {data && !data.site && (
        <>
          <p>
            Cloudflare Web Analytics counts your app’s visitors with a small
            script in its pages: free, with no cookies. It shows page views,
            where visitors come from and how fast pages load for them (Core Web
            Vitals). Shipcel reads it once Cloudflare has a site for this app’s
            address.
          </p>
          <ol className="setup-list">
            <li>
              In Cloudflare, open Web Analytics and add a site for{' '}
              <code>{data.hosts[0] ?? 'the app’s address'}</code>.{' '}
              <a
                className="text-link"
                href={data.setup}
                target="_blank"
                rel="noreferrer"
              >
                Open Web Analytics <ArrowUpRight size={13} />
              </a>
            </li>
            <li>
              Put the script Cloudflare shows in the app’s pages, just before{' '}
              <code>&lt;/body&gt;</code> (in a framework app, in its root
              layout), and deploy.
            </li>
            <li>Come back here: visits show within minutes.</li>
          </ol>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void action(() => load())}
          >
            <RefreshCw size={14} />
            Check again
          </button>
        </>
      )}
      {data?.site && totals && totals.pageViews === 0 && (
        <>
          <p>
            Cloudflare has a Web Analytics site for this app, but no page views
            in this period. If the app’s pages don’t have its script yet, put
            this just before <code>&lt;/body&gt;</code> and deploy:
          </p>
          {data.site.beacon && (
            <div className="token-value">
              <code>{data.site.beacon}</code>
              <CopyButton
                text={data.site.beacon}
                label="Copy the Web Analytics script"
              />
            </div>
          )}
        </>
      )}
      {data?.site && totals && totals.pageViews > 0 && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span>Page views</span>
              <strong>{count.format(totals.pageViews)}</strong>
            </div>
            <div className="stat">
              <span>Visits</span>
              <strong>{count.format(totals.visits)}</strong>
            </div>
            <div className="stat">
              <span>Page views per visit</span>
              <strong>
                {totals.visits
                  ? (totals.pageViews / totals.visits).toFixed(1)
                  : '—'}
              </strong>
            </div>
          </div>
          <BarChart
            caption={`Page views by ${byDay ? 'day' : 'hour'}`}
            valueLabel="Page views"
            overlayLabel="Visits"
            overlayTone="part"
            format={(n) => count.format(n)}
            bars={(data.series ?? []).map((p) => ({
              key: p.at,
              label: when(p.at, byDay),
              value: p.pageViews,
              overlay: p.visits,
            }))}
          />
          <div className="top-lists">
            <TopList
              title="Pages"
              column="Page"
              rows={data.pages ?? []}
              total={totals.pageViews}
            />
            <TopList
              title="Referrers"
              column="Referrer"
              rows={data.referrers ?? []}
              total={totals.pageViews}
            />
            <TopList
              title="Countries"
              column="Country"
              rows={data.countries ?? []}
              total={totals.pageViews}
              name={country}
            />
            <TopList
              title="Devices"
              column="Device"
              rows={data.devices ?? []}
              total={totals.pageViews}
            />
            <TopList
              title="Browsers"
              column="Browser"
              rows={data.browsers ?? []}
              total={totals.pageViews}
            />
          </div>
          <h3>Core Web Vitals</h3>
          <div className="vitals">
            {vitals.map((v) => {
              const measured = data.vitals?.[v.id];
              return (
                <div className="vital" key={v.id}>
                  <span>
                    {v.name}, 75th percentile: {v.explain}
                  </span>
                  {measured?.p75 !== null && measured?.p75 !== undefined ? (
                    <strong>
                      {v.show(measured.p75)},{' '}
                      {verdict(measured.p75, v.good, v.poor)}
                    </strong>
                  ) : (
                    <strong>Not measured yet</strong>
                  )}
                  {measured && measured.total > 0 && (
                    <p className="field-hint">
                      Good {percent(measured.good, measured.total)}, needs
                      improvement{' '}
                      {percent(measured.needsImprovement, measured.total)}, poor{' '}
                      {percent(measured.poor, measured.total)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="field-hint">
            Cloudflare samples these numbers and leaves out bots.
            {data.site.wholeZone
              ? ' The site is set up for the whole zone; only this app’s addresses are counted here.'
              : ''}
          </p>
        </>
      )}
    </section>
  );
}
