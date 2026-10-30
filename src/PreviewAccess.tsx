import { useEffect, useState } from 'react';
import { ArrowUpRight, LockKeyhole, RefreshCw } from 'lucide-react';
import { api } from './api';
import type { Confirmation } from './Operations';

type State = {
  organization: { authDomain: string } | null;
  organizationError: string | null;
  loginMethods: { name: string; type: string }[];
  protection: {
    emails: string[];
    domains: string[];
    otherRules: number;
    sessionDuration: string | null;
  } | null;
  missing: boolean;
};
type Journaled = { status: string; error?: string };
// Commas, spaces, semicolons or new lines separate entries; the server checks them again.
const entries = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((entry) => entry.replace(/^@/, '').toLowerCase())
      .filter(Boolean),
  ),
];

// Manage → Domains → Who can open previews: a sign-in in front of preview addresses through
// Cloudflare Access, in the customer's own Zero Trust organization.
export function PreviewAccess({
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
  const [state, setState] = useState<State | null>(null),
    // Shown in this section, so the rest of the Domains tab works without Access permissions.
    [loadError, setLoadError] = useState(''),
    [editing, setEditing] = useState(false),
    [emails, setEmails] = useState(''),
    [domains, setDomains] = useState('');
  async function load() {
    setLoadError('');
    try {
      setState(await api<State>(`${root}/access`));
    } catch (e) {
      setState(null);
      setLoadError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [root]);
  const protection = state?.protection ?? null;
  const people = entries(emails),
    groups = entries(domains);
  const form = state?.organization && (
    <form
      className="operation-form stacked"
      onSubmit={(e) => {
        e.preventDefault();
        const addLoginMethod = !state.loginMethods.length;
        confirm({
          title: protection
            ? 'Change who can open previews?'
            : 'Ask reviewers to sign in?',
          text: (
            <>
              {people.length > 0 && <>People: {people.join(', ')}. </>}
              {groups.length > 0 && (
                <>Anyone with an email address at {groups.join(', ')}. </>
              )}
              Shipcel {protection ? 'updates' : 'creates'} a Cloudflare Access
              application for this app’s preview addresses; production stays
              public.
              {addLoginMethod &&
                ' Your Zero Trust organization has no login method yet, so Shipcel also adds Cloudflare’s One-time PIN: reviewers get a sign-in code by email.'}
              {protection?.otherRules
                ? ' Rules added to this application in Cloudflare’s dashboard are replaced.'
                : ''}
            </>
          ),
          action: async () => {
            const data = await api<Journaled>(`${root}/access`, {
              method: 'PUT',
              body: JSON.stringify({
                emails: people,
                domains: groups,
                addLoginMethod,
                requestId: crypto.randomUUID(),
                confirm: true,
              }),
            });
            if (data.status !== 'succeeded')
              throw new Error(
                data.error || 'This change needs review in Cloudflare.',
              );
            notice('Preview addresses now ask reviewers to sign in.');
            setEditing(false);
            await load();
          },
        });
      }}
    >
      <label className="field-label">
        People who can open previews
        <textarea
          className="text-input"
          rows={3}
          value={emails}
          placeholder="ada@example.com"
          spellCheck={false}
          onChange={(e) => setEmails(e.target.value)}
        />
      </label>
      <p className="field-hint">
        Email addresses, one per line or separated by commas. Up to 50.
      </p>
      <label className="field-label">
        Everyone with an email address at
        <input
          className="text-input"
          value={domains}
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDomains(e.target.value)}
        />
      </label>
      <p className="field-hint">
        Your company’s domain, for example. Separate domains with commas; up to
        10.
      </p>
      <p className="field-hint">
        {state.loginMethods.length
          ? `Reviewers sign in with ${state.loginMethods.map((m) => m.name).join(', ')}.`
          : 'Your Zero Trust organization has no login method yet; Shipcel adds email codes (One-time PIN) when you confirm.'}
      </p>
      <div className="integration-actions">
        <button
          className="button primary"
          disabled={busy || !(people.length || groups.length)}
        >
          {protection ? 'Save' : 'Ask for sign-in'}
        </button>
        {editing && (
          <button
            type="button"
            className="button secondary"
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
  return (
    <section className="panel operation-body">
      <div className="operation-title">
        <h2>
          <LockKeyhole size={18} aria-hidden="true" /> Who can open previews
        </h2>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void action(load)}
        >
          <RefreshCw size={14} />
          Check again
        </button>
      </div>
      <p>
        Preview addresses, from branch previews and unpublished uploads, open
        for anyone who has the link. Cloudflare Access can ask reviewers to sign
        in first. Your production address stays public.
      </p>
      {loadError && (
        <div className="inline-error" role="alert">
          {loadError}
        </div>
      )}
      {state && !state.organization && (
        <div className="access-setup">
          <p>
            Access works through a Zero Trust organization in your Cloudflare
            account. Set one up once in Cloudflare: choose a team name and the
            Zero Trust Free plan, which covers up to 50 people at no charge.
            Cloudflare asks for a payment method during this step even on the
            free plan, so Shipcel can’t do it for you. Then check again here.
          </p>
          <a
            className="button secondary"
            href="https://one.dash.cloudflare.com/"
            target="_blank"
            rel="noreferrer"
          >
            Open Cloudflare Zero Trust
            <ArrowUpRight size={14} />
          </a>
          {state.organizationError && (
            <p className="field-hint">{state.organizationError}</p>
          )}
        </div>
      )}
      {state?.organization && state.missing && (
        <p className="field-hint" role="status">
          The Access application Shipcel created was removed in Cloudflare, so
          preview addresses are public. Ask for sign-in again below.
        </p>
      )}
      {state?.organization && protection && !editing && (
        <div className="operation-list">
          <div className="operation-row">
            <div>
              <strong>Sign-in required</strong>
              <p>
                {[
                  ...protection.emails,
                  ...protection.domains.map((d) => `anyone at ${d}`),
                ].join(', ')}
                {protection.otherRules
                  ? `, plus ${protection.otherRules} rules set in Cloudflare`
                  : ''}
              </p>
              <p>
                Sign-ins last {protection.sessionDuration ?? '24h'}, on{' '}
                {state.organization.authDomain}.
              </p>
            </div>
            <div className="operation-badges">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setEmails(protection.emails.join('\n'));
                  setDomains(protection.domains.join(', '));
                  setEditing(true);
                }}
              >
                Change
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  confirm({
                    title: 'Make preview addresses public again?',
                    text: 'Anyone with a preview link can open it without signing in. Shipcel deletes its Access application in your Cloudflare account.',
                    action: async () => {
                      const data = await api<Journaled>(`${root}/access`, {
                        method: 'DELETE',
                        body: JSON.stringify({
                          requestId: crypto.randomUUID(),
                          confirm: true,
                        }),
                      });
                      if (data.status !== 'succeeded')
                        throw new Error(
                          data.error ||
                            'This change needs review in Cloudflare.',
                        );
                      notice('Preview addresses are public again.');
                      await load();
                    },
                  })
                }
              >
                Remove sign-in
              </button>
            </div>
          </div>
        </div>
      )}
      {(!protection || editing) && form}
      <p className="field-hint">
        Each person who signs in uses one of Zero Trust Free’s 50 seats.
        WebSocket connections to a protected preview don’t work: Cloudflare
        Access doesn’t support them for Workers yet.
      </p>
    </section>
  );
}
