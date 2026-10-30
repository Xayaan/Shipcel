import { useEffect, useState } from 'react';
import { ChartColumn, RefreshCw, ScrollText } from 'lucide-react';
import { api } from './api';
import { BarChart } from './BarChart';

type Range = '24h' | '7d' | '30d';
type Analytics = {
  range: Range;
  bucket?: 'hour' | 'day';
  // Times in milliseconds.
  totals: {
    requests: number;
    errors: number;
    subrequests: number;
    cpuP50: number;
    cpuP99: number;
    wallP50?: number;
    wallP99?: number;
  };
  series?: {
    at: string;
    requests: number;
    errors: number;
    wallP50: number;
    wallP99: number;
  }[];
  hours: { hour: string; requests: number; errors: number }[];
  statuses: Record<string, number>;
};
// From Workers Logs: requests by the HTTP status the app answered.
type StatusCodes = {
  hours: number;
  codes: { status: number; requests: number }[];
  series: { at: string; requests: number; errors: number }[];
};
const rangeNames: Record<Range, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
type LogEvent = {
  id: string;
  timestamp: number;
  level: string;
  message: string;
  trigger: string | null;
  status: number | null;
  outcome: string | null;
  requestId: string | null;
};
// Cloudflare's invocation statuses, in plain words.
const statusLabels: Record<string, string> = {
  success: 'Succeeded',
  scriptThrewException: 'Threw an exception',
  exceededCpu: 'Exceeded the CPU limit',
  exceededMemory: 'Exceeded the memory limit',
  clientDisconnected: 'Client disconnected',
  internalError: 'Cloudflare internal error',
  unknown: 'Unknown',
};
const count = new Intl.NumberFormat();
const hourLabel = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
  });
const dayLabel = (day: string) =>
  new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
const millis = (n: number) => `${count.format(n)} ms`;
// Live logs: every five seconds, the last five minutes (Workers Logs takes a few seconds to
// have an event), keeping the newest 300 on screen.
const LIVE_MS = 5000;
const LIVE_MINUTES = '5';
const LIVE_KEPT = 300;
const share = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : '0%';

// Manage → Analytics & logs, read from Cloudflare for this project's Worker.
export function ObservabilityPanel({
  root,
  busy,
  action,
}: {
  root: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
}) {
  const [range, setRange] = useState<Range>('24h'),
    [analytics, setAnalytics] = useState<Analytics | null>(null),
    [codes, setCodes] = useState<StatusCodes | string | null>(null),
    [minutes, setMinutes] = useState('60'),
    [errorsOnly, setErrorsOnly] = useState(false),
    [logs, setLogs] = useState<LogEvent[] | null>(null),
    // Words to look for (typed, and applied), and whether new events are fetched as they come.
    [typed, setTyped] = useState(''),
    [search, setSearch] = useState(''),
    [live, setLive] = useState(false),
    [liveError, setLiveError] = useState('');
  async function loadAnalytics(next = range) {
    // Status codes come from Workers Logs: if they can't be read, the rest still shows.
    const [numbers, statuses] = await Promise.all([
      api<Analytics>(`${root}/analytics?range=${next}`),
      api<StatusCodes>(`${root}/status-codes?range=${next}`).catch(
        (error: Error) => error.message,
      ),
    ]);
    setAnalytics(numbers);
    setCodes(statuses);
  }
  const logsPath = (nextMinutes: string, nextErrors: boolean, words: string) =>
    `${root}/logs?minutes=${nextMinutes}${nextErrors ? '&errors=1' : ''}${
      words ? `&q=${encodeURIComponent(words)}` : ''
    }`;
  async function loadLogs(
    nextMinutes = minutes,
    nextErrors = errorsOnly,
    words = search,
  ) {
    setLogs(
      (
        await api<{ events: LogEvent[] }>(
          logsPath(nextMinutes, nextErrors, words),
        )
      ).events,
    );
  }
  // Live: the last few minutes every few seconds, added above what is shown.
  useEffect(() => {
    if (!live) return;
    setLiveError('');
    const timer = setInterval(() => {
      api<{ events: LogEvent[] }>(logsPath(LIVE_MINUTES, errorsOnly, search))
        .then(({ events }) =>
          setLogs((shown) => {
            const known = new Set((shown ?? []).map((e) => e.id));
            return [...events.filter((e) => !known.has(e.id)), ...(shown ?? [])]
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, LIVE_KEPT);
          }),
        )
        .catch((error: Error) => setLiveError(error.message));
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [live, errorsOnly, search, root]);
  useEffect(() => {
    void action(async () => {
      await loadAnalytics();
      await loadLogs();
    });
  }, [root]);
  const t = analytics?.totals;
  const byDay = analytics?.bucket === 'day';
  const when = (at: string) => (byDay ? dayLabel(at) : hourLabel(at));
  const per = byDay ? 'day' : 'hour';
  const series =
    analytics?.series ??
    analytics?.hours.map((h) => ({
      at: h.hour,
      requests: h.requests,
      errors: h.errors,
      wallP50: 0,
      wallP99: 0,
    })) ??
    [];
  const seen =
    typeof codes === 'object' && codes
      ? codes.codes.reduce((n, c) => n + c.requests, 0)
      : 0;

  return (
    <>
      <section className="panel operation-body observability">
        <div className="operation-title">
          <h2>
            <ChartColumn size={18} aria-hidden="true" /> Analytics
          </h2>
          <div className="operation-nav" aria-label="Analytics period">
            {(Object.keys(rangeNames) as Range[]).map((r) => (
              <button
                key={r}
                type="button"
                className={`button ${range === r ? 'primary' : 'secondary'}`}
                aria-pressed={range === r}
                disabled={busy}
                onClick={() => {
                  setRange(r);
                  void action(() => loadAnalytics(r));
                }}
              >
                {rangeNames[r]}
              </button>
            ))}
          </div>
        </div>
        {t && analytics && (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span>Requests</span>
                <strong>{count.format(t.requests)}</strong>
              </div>
              <div className="stat">
                <span>Errors</span>
                <strong>
                  {count.format(t.errors)}
                  {t.requests
                    ? ` (${((t.errors / t.requests) * 100).toFixed(1)}%)`
                    : ''}
                </strong>
              </div>
              <div className="stat">
                <span>Response time, median (approx.)</span>
                <strong>{millis(t.wallP50 ?? 0)}</strong>
              </div>
              <div className="stat">
                <span>Response time, 99th percentile (up to)</span>
                <strong>{millis(t.wallP99 ?? 0)}</strong>
              </div>
              <div className="stat">
                <span>CPU time, median (approx.)</span>
                <strong>{millis(t.cpuP50)}</strong>
              </div>
              <div className="stat">
                <span>CPU time, 99th percentile (up to)</span>
                <strong>{millis(t.cpuP99)}</strong>
              </div>
            </div>
            {series.length ? (
              <>
                <h3>Requests</h3>
                <BarChart
                  caption={`Requests by ${per}`}
                  valueLabel="Requests"
                  overlayLabel="Errors"
                  format={(n) => count.format(n)}
                  bars={series.map((p) => ({
                    key: p.at,
                    label: when(p.at),
                    value: p.requests,
                    overlay: p.errors,
                  }))}
                />
                <h3>Response time</h3>
                <BarChart
                  caption={`Response time by ${per}`}
                  valueLabel="99th percentile"
                  overlayLabel="Median"
                  overlayTone="part"
                  format={millis}
                  bars={series.map((p) => ({
                    key: p.at,
                    label: when(p.at),
                    value: p.wallP99,
                    overlay: p.wallP50,
                  }))}
                />
                <p className="field-hint">
                  From the request to the response, waiting on databases and
                  other services included.
                </p>
                <ul className="resource-list" aria-label="Outcomes">
                  {Object.entries(analytics.statuses).map(([status, n]) => (
                    <li key={status}>
                      {statusLabels[status] ?? status}: {count.format(n)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="operation-empty">No requests in this period.</p>
            )}
            <h3>HTTP status codes</h3>
            {typeof codes === 'string' ? (
              <p className="field-hint">
                HTTP status codes aren’t available: {codes}
              </p>
            ) : codes && codes.codes.length ? (
              <>
                <p className="field-hint">
                  From Workers Logs, for the last{' '}
                  {codes.hours <= 24 ? '24 hours' : '7 days'} at most: it keeps
                  3 days on Workers Free and 7 on Workers Paid, and only
                  requests that ran the app’s code.
                </p>
                <ul className="status-codes" aria-label="HTTP status codes">
                  {codes.codes.map((c) => (
                    <li
                      key={c.status}
                      className={`code-${String(c.status)[0]}xx`}
                    >
                      <strong>{c.status}</strong>
                      {count.format(c.requests)} ({share(c.requests, seen)})
                    </li>
                  ))}
                </ul>
                {codes.series.length > 1 && (
                  <BarChart
                    caption="Requests by status over time"
                    valueLabel="Requests"
                    overlayLabel="4xx and 5xx"
                    format={(n) => count.format(n)}
                    bars={codes.series.map((p) => ({
                      key: p.at,
                      label: hourLabel(p.at),
                      value: p.requests,
                      overlay: p.errors,
                    }))}
                  />
                )}
              </>
            ) : (
              codes && (
                <p className="field-hint">
                  No requests in Workers Logs for this period. Status codes come
                  from Workers Logs, which is on unless the app’s Wrangler
                  configuration turns observability off.
                </p>
              )
            )}
          </>
        )}
      </section>
      <section className="panel operation-body observability">
        <div className="operation-title">
          <h2>
            <ScrollText size={18} aria-hidden="true" /> Logs
          </h2>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void action(() => loadLogs())}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        <div className="log-controls">
          <label className="field-label">
            Period
            <select
              className="text-input"
              value={minutes}
              disabled={busy}
              onChange={(e) => {
                setMinutes(e.target.value);
                void action(() => loadLogs(e.target.value));
              }}
            >
              <option value="60">Last hour</option>
              <option value="360">Last 6 hours</option>
              <option value="1440">Last 24 hours</option>
              <option value="4320">Last 3 days</option>
            </select>
          </label>
          <label className="deploy-consent">
            <input
              type="checkbox"
              checked={errorsOnly}
              disabled={busy}
              onChange={(e) => {
                setErrorsOnly(e.target.checked);
                void action(() => loadLogs(minutes, e.target.checked));
              }}
            />
            <span>Errors only</span>
          </label>
          <label className="deploy-consent">
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
            />
            <span>Live: new events every 5 seconds</span>
          </label>
        </div>
        <form
          className="log-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const words = typed.trim();
            setSearch(words);
            void action(() => loadLogs(minutes, errorsOnly, words));
          }}
        >
          <label className="field-label">
            Search the logs
            <input
              className="text-input"
              type="search"
              value={typed}
              maxLength={200}
              placeholder="An error message, a path, a request ID…"
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <button className="button secondary" disabled={busy}>
            Search
          </button>
        </form>
        {liveError && (
          <p className="field-hint" role="status">
            Live logs paused a moment: {liveError}
          </p>
        )}
        {logs &&
          (logs.length ? (
            <ol className="log-list" aria-label="Log events">
              {logs.map((e) => (
                <li key={e.id} className={`log-${e.level}`}>
                  <div className="log-meta">
                    <time dateTime={new Date(e.timestamp).toISOString()}>
                      {new Date(e.timestamp).toLocaleString()}
                    </time>
                    <span
                      className={`badge ${
                        e.level === 'error'
                          ? 'danger'
                          : e.level === 'warn'
                            ? 'warning'
                            : ''
                      }`}
                    >
                      {e.level}
                    </span>
                    {e.trigger && <span>{e.trigger}</span>}
                    {e.status !== null && <span>HTTP {e.status}</span>}
                  </div>
                  <pre>{e.message}</pre>
                </li>
              ))}
            </ol>
          ) : (
            <p className="operation-empty">
              No logs in this period. Logs appear when Workers Logs is on for
              this Worker: it is on by default for new Workers, and{' '}
              <code>observability.enabled</code> in the Wrangler configuration
              controls it. The free plan keeps 200,000 log events a day for 3
              days.
            </p>
          ))}
      </section>
    </>
  );
}
