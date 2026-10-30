import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from './api';
import type { Confirmation } from './Operations';

type Rule = {
  id: string;
  action: string;
  summary: string;
  enabled: boolean;
  ours: boolean;
};
type Zone = {
  id: string;
  name: string;
  hosts: string[];
  managed: boolean | null;
  bots: boolean | null;
  aiBots: boolean | null;
  underAttack: boolean | null;
  rules: Rule[] | null;
  rateLimits:
    (Rule & { requests: number | null; period: number | null })[] | null;
  denied: string[];
};
type Security = { workersDev: boolean | null; zones: Zone[] };
type Field = 'managed' | 'bots' | 'aiBots' | 'underAttack';

// The settings that cover a whole zone.
const settings: { field: Field; label: string; text: string }[] = [
  {
    field: 'managed',
    label: 'Free Managed Ruleset',
    text: 'Cloudflare’s rules against widely exploited flaws, such as Log4j and common WordPress attacks.',
  },
  {
    field: 'bots',
    label: 'Bot Fight Mode',
    text: 'Challenges traffic that matches known bots. No rule can make an exception, so API clients and mobile apps may be challenged too.',
  },
  {
    field: 'aiBots',
    label: 'Block AI crawlers',
    text: 'Blocks crawlers that collect pages for AI.',
  },
  {
    field: 'underAttack',
    label: 'Under Attack mode',
    text: 'Every visitor gets a challenge page before the app. For an attack in progress.',
  },
];
const matches = {
  country: { label: 'Countries', these: 'these countries', example: 'CN, RU' },
  ip: {
    label: 'IP addresses',
    these: 'these IP addresses',
    example: '203.0.113.7, 198.51.100.0/24',
  },
  path: { label: 'Path', these: 'this path', example: '/wp-admin' },
} as const;
type Match = keyof typeof matches;

// Manage → Security: Cloudflare's free firewall for the zones of the app's custom domains
// (worker/firewall.ts). Settings and rate limits cover every host name in a zone; rules
// made here match the app's own host names.
export function SecurityPanel({
  root,
  busy,
  action,
  confirm,
  notice,
}: {
  root: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  confirm: (value: Confirmation) => void;
  notice: (text: string) => void;
}) {
  const [security, setSecurity] = useState<Security | null>(null),
    [ruleAction, setRuleAction] = useState<'block' | 'challenge'>('block'),
    [match, setMatch] = useState<Match>('country'),
    [values, setValues] = useState(''),
    [ratePath, setRatePath] = useState('/api'),
    [requests, setRequests] = useState('100');
  async function load() {
    setSecurity(await api<Security>(`${root}/security`));
  }
  useEffect(() => {
    void action(load);
  }, [root]);
  const send = <T,>(path: string, method: string, body = {}) =>
    api<T>(`${root}/security${path}`, {
      method,
      body: JSON.stringify({ ...body, confirm: true }),
    });
  const zones = security?.zones ?? [];
  const names = zones.map((z) => z.name).join(', ');
  const hosts = zones.flatMap((z) => z.hosts).join(', ');
  const several = zones.length > 1;
  // On only when on in every zone; null when Cloudflare didn't show it for one.
  const stateOf = (field: Field) =>
    zones.some((z) => z[field] === null)
      ? null
      : zones.every((z) => z[field])
        ? 'on'
        : zones.some((z) => z[field])
          ? 'some'
          : 'off';
  const rules = zones.flatMap((z) =>
    (z.rules ?? []).map((r) => ({ ...r, zone: z.name })),
  );
  const limits = zones.flatMap((z) =>
    (z.rateLimits ?? []).map((r) => ({ ...r, zone: z.name })),
  );
  const denied = [...new Set(zones.flatMap((z) => z.denied))];
  const list = values
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  const limit = Number(requests);
  return (
    <section className="panel operation-body">
      <div className="operation-title">
        <h2>
          <ShieldCheck size={18} aria-hidden="true" /> Security
        </h2>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void action(load)}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <p>
        Cloudflare’s DDoS protection covers this app at every address, its
        workers.dev one included. A firewall belongs to a domain’s zone, so the
        settings below need a custom domain. They’re free on Cloudflare’s Free
        plan.
      </p>
      {security && !zones.length && (
        <p className="field-hint">
          This app has no custom domain yet. Add one on the Domains tab, then
          turn on Cloudflare’s firewall for it here.
        </p>
      )}
      {zones.length > 0 && (
        <>
          <p className="field-hint">
            For {hosts}, in the zone{several ? 's' : ''} {names}. These settings
            cover every host name in {several ? 'those zones' : 'it'}.
          </p>
          <div className="operation-list">
            {settings.map((s) => {
              const state = stateOf(s.field);
              const on = state === 'on';
              return (
                <div className="operation-row" key={s.field}>
                  <div>
                    <strong>{s.label}</strong>
                    <p>{s.text}</p>
                  </div>
                  <div className="operation-badges">
                    <span className={`badge${on ? ' green' : ''}`}>
                      {state === null
                        ? 'Not shown'
                        : state === 'some'
                          ? 'On in some zones'
                          : on
                            ? 'On'
                            : 'Off'}
                    </span>
                    {state !== null && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        aria-label={`${on ? 'Turn off' : 'Turn on'} ${s.label}`}
                        onClick={() =>
                          confirm({
                            title: `Turn ${s.label} ${on ? 'off' : 'on'}?`,
                            text: `It covers every host name in ${names}.`,
                            action: async () => {
                              setSecurity(
                                await send<Security>('', 'PUT', {
                                  [s.field]: !on,
                                }),
                              );
                              notice(`${s.label} is ${on ? 'off' : 'on'}.`);
                            },
                          })
                        }
                      >
                        {on ? 'Turn off' : 'Turn on'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="operation-list">
            <h3>Rules</h3>
            {zones.some((z) => z.rules) && !rules.length && (
              <p className="operation-empty">No rules yet.</p>
            )}
            {rules.map((r) => (
              <div className="operation-row" key={`${r.zone}-${r.id}`}>
                <div>
                  <strong>
                    {r.summary}
                    {r.enabled ? '' : ' (off)'}
                  </strong>
                  <p>
                    {r.ours ? 'Made by this app' : 'Made elsewhere'}
                    {several ? `, ${r.zone}` : ''}
                  </p>
                </div>
                {r.ours && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    aria-label={`Remove rule ${r.summary}`}
                    onClick={() =>
                      confirm({
                        title: 'Remove this rule?',
                        text: `${r.summary}, on ${r.zone}.`,
                        action: async () => {
                          await send(`/rules/${r.id}`, 'DELETE');
                          notice('Rule removed.');
                          await load();
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <p>
            A rule blocks or challenges visitors from countries, IP addresses or
            a path, on {hosts} only. Cloudflare’s Free plan allows 5 rules per
            zone.
          </p>
          <form
            className="operation-form"
            onSubmit={(e) => {
              e.preventDefault();
              confirm({
                title: `${ruleAction === 'block' ? 'Block' : 'Challenge'} ${matches[match].these}?`,
                text: `${list.join(', ')}, on ${hosts}. Cloudflare’s Free plan allows 5 rules per zone.`,
                action: async () => {
                  const answer = await send<Security & { summary: string }>(
                    '/rules',
                    'POST',
                    { action: ruleAction, match, values: list },
                  );
                  setSecurity(answer);
                  setValues('');
                  notice(`Rule added: ${answer.summary}.`);
                },
              });
            }}
          >
            <label className="field-label">
              Action
              <select
                className="text-input"
                value={ruleAction}
                disabled={busy}
                onChange={(e) =>
                  setRuleAction(e.target.value as 'block' | 'challenge')
                }
              >
                <option value="block">Block</option>
                <option value="challenge">Challenge</option>
              </select>
            </label>
            <label className="field-label">
              Match
              <select
                className="text-input"
                value={match}
                disabled={busy}
                onChange={(e) => setMatch(e.target.value as Match)}
              >
                {Object.entries(matches).map(([id, m]) => (
                  <option key={id} value={id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              {matches[match].label}
              <input
                className="text-input"
                value={values}
                autoComplete="off"
                spellCheck={false}
                placeholder={matches[match].example}
                onChange={(e) => setValues(e.target.value)}
              />
            </label>
            <button className="button primary" disabled={busy || !list.length}>
              Add rule
            </button>
          </form>
          <div className="operation-list">
            <h3>Rate limit</h3>
            {zones.some((z) => z.rateLimits) && !limits.length && (
              <p className="operation-empty">No rate limit yet.</p>
            )}
            {limits.map((r) => (
              <div className="operation-row" key={`${r.zone}-${r.id}`}>
                <div>
                  <strong>
                    {r.summary}
                    {r.enabled ? '' : ' (off)'}
                  </strong>
                  <p>
                    {r.ours ? 'Set by this app' : 'Made elsewhere'}
                    {several ? `, ${r.zone}` : ''}
                  </p>
                </div>
                {r.ours && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    aria-label="Remove the rate limit"
                    onClick={() =>
                      confirm({
                        title: 'Remove the rate limit?',
                        text: `From ${names}.`,
                        action: async () => {
                          await send('/rate-limit', 'DELETE');
                          notice('Rate limit removed.');
                          await load();
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <p>
            A visitor (an IP address) that sends more requests than this in 10
            seconds to the path, or below it, is blocked for 10 seconds.
            Cloudflare’s Free plan allows one per zone and counts that path on
            every host name in the zone.
          </p>
          <form
            className="operation-form"
            onSubmit={(e) => {
              e.preventDefault();
              confirm({
                title: 'Set the rate limit?',
                text: `At most ${limit} requests per 10 seconds per visitor to ${ratePath}, on every host name in ${names}.`,
                action: async () => {
                  setSecurity(
                    await send<Security>('/rate-limit', 'PUT', {
                      path: ratePath.trim(),
                      requests: limit,
                    }),
                  );
                  notice('Rate limit set.');
                },
              });
            }}
          >
            <label className="field-label">
              Path
              <input
                className="text-input"
                value={ratePath}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setRatePath(e.target.value)}
              />
            </label>
            <label className="field-label">
              Requests per 10 seconds
              <input
                className="text-input"
                type="number"
                min={1}
                max={100000}
                value={requests}
                onChange={(e) => setRequests(e.target.value)}
              />
            </label>
            <button
              className="button primary"
              disabled={
                busy ||
                !ratePath.trim().startsWith('/') ||
                !Number.isInteger(limit) ||
                limit < 1
              }
            >
              Save rate limit
            </button>
          </form>
          {denied.length > 0 && (
            <p className="field-hint">
              Cloudflare didn’t show some settings: this connection has no{' '}
              {denied.join(' or ')} permission. Cloudflare sign-ins set up from
              23 October 2026 ask for it; set up an older one again on
              Connections.
            </p>
          )}
          {security?.workersDev && (
            <p className="field-hint">
              This app also answers at its workers.dev address, which no zone
              firewall covers. To serve it only through {hosts}, turn that
              address off with <code>shipcel unpublish</code>.
            </p>
          )}
        </>
      )}
    </section>
  );
}
