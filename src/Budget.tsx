import { useEffect, useState } from 'react';
import { LoaderCircle, OctagonPause, Play, RefreshCw } from 'lucide-react';
import { api } from './api';
import { BarChart } from './BarChart';

// Overview → Billing → Budget guard (worker/budgets.ts): what the project costs this month
// beyond what Cloudflare includes, its budget, and what happens over it.

type MeterCost = {
  meter: string;
  label: string;
  mine: number;
  account: number;
  included: number;
  cents: number;
};
type BudgetView = {
  budget: { monthlyCents: number; onExceed: 'alert' | 'pause' };
  deployed: boolean;
  webhook: boolean;
  plan: { plan: string; source: string; detail: string | null } | null;
  notEstimated: string;
  labels: Record<string, string>;
  limits?: Record<string, { included: number; freeDaily: number | null }>;
  check: {
    month: string;
    plan: 'free' | 'paid' | 'unknown';
    estimateCents: number;
    projectedCents: number;
    accountCents: number;
    meters: MeterCost[];
    missing: { meters: string[]; reason: string }[];
    daily?: {
      days?: string[];
      meters?: Record<string, number[]>;
      cents?: number[];
    };
    level: number;
    state: 'ok' | 'over' | 'paused';
    checkedAt: number;
    readAt: number | null;
    error: string | null;
  } | null;
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const count = (n: number) => new Intl.NumberFormat().format(Math.round(n));
const since = (seconds: number) => {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  return minutes < 1
    ? 'just now'
    : minutes < 60
      ? `${minutes} min ago`
      : `${Math.round(minutes / 60)} h ago`;
};
const planName = (view: BudgetView) => {
  const plan = view.check?.plan ?? view.plan?.plan;
  return plan === 'free'
    ? 'Workers Free'
    : plan === 'paid'
      ? 'Workers Paid'
      : 'Unknown, estimated as Workers Paid';
};
const change = () => ({ requestId: crypto.randomUUID(), confirm: true });
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

// The month so far, day by day: what it had cost by each day against the budget, and one
// meter's use each day (against Workers Free's daily limit on the free plan).
function DayByDay({ view }: { view: BudgetView }) {
  const daily = view.check?.daily ?? {};
  const days = daily.days ?? [];
  const used = Object.entries(daily.meters ?? {}).filter(([, series]) =>
    series.some((n) => n > 0),
  );
  const [picked, setPicked] = useState('');
  const meter = used.some(([m]) => m === picked)
    ? picked
    : (used[0]?.[0] ?? '');
  const series = daily.meters?.[meter] ?? [];
  const limits = view.limits?.[meter];
  const free = view.check?.plan === 'free';
  const label = view.labels[meter] ?? meter;
  if (!days.length) return null;
  return (
    <div className="day-by-day">
      <h4>This month, day by day</h4>
      <BarChart
        caption="Estimated cost so far, by day"
        valueLabel="Estimated cost so far"
        format={dollars}
        bars={days.map((day, i) => ({
          key: day,
          label: dayLabel(day),
          value: daily.cents?.[i] ?? 0,
        }))}
        line={
          view.budget.monthlyCents > 0
            ? {
                value: view.budget.monthlyCents,
                label: `Budget ${dollars(view.budget.monthlyCents)}`,
              }
            : undefined
        }
      />
      {used.length > 0 && (
        <>
          <label className="field-label day-meter">
            Usage
            <select
              className="text-input"
              value={meter}
              onChange={(e) => setPicked(e.target.value)}
            >
              {used.map(([m]) => (
                <option key={m} value={m}>
                  {view.labels[m] ?? m}
                </option>
              ))}
            </select>
          </label>
          <BarChart
            caption={`${label}, by day`}
            valueLabel={label}
            format={count}
            bars={days.map((day, i) => ({
              key: day,
              label: dayLabel(day),
              value: series[i] ?? 0,
            }))}
            line={
              free && limits?.freeDaily
                ? {
                    value: limits.freeDaily,
                    label: `Workers Free’s daily limit, ${count(limits.freeDaily)}`,
                  }
                : undefined
            }
          />
          {!free && limits && (
            <p className="field-hint">
              Workers Paid includes {count(limits.included)} a month for the
              whole account; Cloudflare bills what goes past it.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function BudgetGuard({
  projectId,
  owner,
  notify,
  onChanged,
}: {
  projectId: string;
  owner: boolean;
  notify: (text: string) => void;
  onChanged: () => Promise<void>;
}) {
  const root = `/projects/${projectId}/budget`;
  const [view, setView] = useState<BudgetView | null>(null),
    [dollarsInput, setDollarsInput] = useState(''),
    [onExceed, setOnExceed] = useState<'alert' | 'pause'>('alert'),
    [confirming, setConfirming] = useState<'pause' | 'resume' | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  function show(next: BudgetView) {
    setView(next);
    setDollarsInput(String(next.budget.monthlyCents / 100));
    setOnExceed(next.budget.onExceed);
  }
  async function run(work: () => Promise<BudgetView>, done: string) {
    setBusy(true);
    setError('');
    try {
      show(await work());
      setConfirming(null);
      notify(done);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    // A load whose effect was cleaned up (development runs effects twice) is dropped, so it
    // can't land after someone has started typing and reset the form.
    let live = true;
    api<BudgetView>(root)
      .then((next) => live && show(next))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [root]);
  if (!view)
    return (
      <div className="budget-guard">
        <h3>Budget guard</h3>
        {error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : (
          <p>
            <LoaderCircle size={14} className="spin" /> Loading…
          </p>
        )}
      </div>
    );
  const check = view.check;
  const wanted = Math.round(Number(dollarsInput) * 100);
  const valid =
    dollarsInput.trim() !== '' &&
    Number.isFinite(wanted) &&
    wanted >= 0 &&
    wanted <= 10_000_000;
  const unread = (check?.missing ?? []).flatMap((m) =>
    m.meters.map((meter) => view.labels[meter] ?? meter),
  );
  return (
    <div className="budget-guard">
      <h3>Budget guard</h3>
      {check?.state === 'paused' && (
        <div className="budget-alert paused" role="alert">
          <strong>Paused for going over its budget.</strong> Production answers
          503 and its schedules are off; its data is kept. Fix the cause, raise
          the budget or switch to alerts only, then resume it.
        </div>
      )}
      {check?.state === 'over' && (
        <div className="budget-alert over" role="status">
          <strong>Over its budget.</strong> An estimated{' '}
          {dollars(check.estimateCents)} this month beyond what Cloudflare
          includes, against {dollars(view.budget.monthlyCents)}.
          {view.budget.onExceed === 'alert'
            ? ' It keeps running: this project only sends alerts.'
            : ''}
        </div>
      )}
      <p>
        Every five minutes Shipcel estimates what this app costs this month
        beyond what Cloudflare includes, from Cloudflare’s own usage figures. It
        alerts at half the budget, four fifths of it and over it, and when the
        rate of the last few minutes would go over by the end of the month.
        Cloudflare has no spending cap on Workers Paid; this catches a runaway
        bug early.
      </p>
      {!view.deployed ? (
        <p className="field-hint">
          Nothing is deployed yet. The guard starts with the first deploy.
        </p>
      ) : (
        <dl className="budget-figures">
          <div>
            <dt>This month, beyond what’s included</dt>
            <dd>{check ? dollars(check.estimateCents) : 'Not checked yet'}</dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>{dollars(view.budget.monthlyCents)} a month</dd>
          </div>
          <div>
            <dt>Over it</dt>
            <dd>
              {view.budget.onExceed === 'pause'
                ? 'Pause the app'
                : 'Alert only'}
            </dd>
          </div>
          <div>
            <dt>Cloudflare plan</dt>
            <dd>{planName(view)}</dd>
          </div>
          {check && check.accountCents > check.estimateCents && (
            <div>
              <dt>Whole account</dt>
              <dd>{dollars(check.accountCents)}</dd>
            </div>
          )}
        </dl>
      )}
      {check && check.meters.length > 0 && (
        <div className="budget-meters-scroll">
          <table className="budget-meters">
            <caption>This month so far</caption>
            <thead>
              <tr>
                <th scope="col">Usage</th>
                <th scope="col">This app</th>
                <th scope="col">Included</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {check.meters.map((m) => (
                <tr key={m.meter}>
                  <th scope="row">{m.label}</th>
                  <td>{count(m.mine)}</td>
                  <td>{count(m.included)}</td>
                  <td>{dollars(m.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {check && <DayByDay view={view} />}
      {check && (
        <p className="field-hint">
          {check.readAt
            ? `Last read ${since(check.readAt)}. `
            : 'Not read yet. '}
          {unread.length > 0 &&
            `Cloudflare didn’t report ${unread.join(', ')}, so the estimate may be low. `}
          {view.notEstimated}
        </p>
      )}
      {check?.error && (
        <div className="inline-error" role="alert">
          {check.error}
        </div>
      )}
      {!view.webhook && view.deployed && (
        <p className="field-hint">
          Alerts show here. To get them in Slack, Discord or anywhere else, add
          a webhook in Manage → Notifications: budget alerts always go to it.
        </p>
      )}
      {owner ? (
        <form
          className="budget-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                api<BudgetView>(root, {
                  method: 'PUT',
                  body: JSON.stringify({ monthlyCents: wanted, onExceed }),
                }),
              'Budget saved.',
            );
          }}
        >
          <label className="field-label">
            Monthly budget beyond what Cloudflare includes, in dollars
            <input
              className="text-input"
              type="number"
              min={0}
              max={100000}
              step={1}
              inputMode="numeric"
              value={dollarsInput}
              onChange={(e) => setDollarsInput(e.target.value)}
            />
          </label>
          <fieldset className="event-choices">
            <legend>When the estimate goes over it</legend>
            <label className="deploy-consent">
              <input
                type="radio"
                name="on-exceed"
                checked={onExceed === 'alert'}
                onChange={() => setOnExceed('alert')}
              />
              <span>Alert only: the app keeps running</span>
            </label>
            <label className="deploy-consent">
              <input
                type="radio"
                name="on-exceed"
                checked={onExceed === 'pause'}
                onChange={() => setOnExceed('pause')}
              />
              <span>
                Pause the app: production answers 503, schedules and alarms
                stop, data stays, until you resume it
              </span>
            </label>
          </fieldset>
          {onExceed === 'pause' &&
            check &&
            valid &&
            check.estimateCents > wanted &&
            check.state !== 'paused' && (
              <p className="field-hint" role="status">
                This month’s estimate ({dollars(check.estimateCents)}) is
                already over that: the guard will pause the app at its next
                check.
              </p>
            )}
          <button className="button primary" disabled={busy || !valid}>
            Save budget
          </button>
        </form>
      ) : (
        <p className="field-hint">
          A workspace owner sets the budget and what happens over it.
        </p>
      )}
      {view.deployed && (
        <div className="integration-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void run(
                () => api<BudgetView>(`${root}/check`, { method: 'POST' }),
                'Usage checked.',
              )
            }
          >
            <RefreshCw size={14} />
            Check now
          </button>
          {owner && check?.state !== 'paused' && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirming('pause')}
            >
              <OctagonPause size={14} />
              Pause now
            </button>
          )}
          {owner && check?.state === 'paused' && (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => setConfirming('resume')}
            >
              <Play size={14} />
              Resume
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div className="delete-project">
          <p>
            {confirming === 'pause'
              ? 'Pause this app now? Production will answer 503 and its schedules and alarms stop until you resume it. Its data is kept.'
              : 'Resume this app? Production goes back to the version it served before the pause, and its schedules come back. If the bug is still there it will cost money again, so deploy the fix right after.'}
          </p>
          <div>
            <button
              type="button"
              className={`button ${confirming === 'pause' ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    api<BudgetView>(`${root}/${confirming}`, {
                      method: 'POST',
                      body: JSON.stringify(change()),
                    }),
                  confirming === 'pause'
                    ? 'The app is paused.'
                    : 'The app is running again.',
                )
              }
            >
              {confirming === 'pause' ? 'Pause the app' : 'Resume the app'}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
