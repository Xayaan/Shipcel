import { useEffect, useState, type ReactNode } from 'react';
import { Check, Cloud, GitBranch } from 'lucide-react';
import { api } from './api';
import { ConfirmOperation, type Confirmation } from './Operations';
import type { ConnectionStatus, SessionStatus } from '../shared/integrations';
import './cli-setup.css';

type Login = {
  code: string;
  host: string | null;
  status: 'pending' | 'approved' | 'denied' | 'delivered' | 'expired';
  createdAt: number;
  expiresAt: number;
  // This person decided it, in this workspace.
  mine: boolean;
  // `shipcel tokens add`: approving creates this token instead of signing the CLI in.
  token?: { name: string; expiresInDays: number };
};
type Account = { id: string; name: string };
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function Step({
  number,
  title,
  done,
  current,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <li className={done ? 'done' : current ? 'current' : ''}>
      <span className="cli-step-mark" aria-hidden="true">
        {done ? <Check size={14} /> : number}
      </span>
      <div className="cli-step-body">
        <h2>
          {title}
          {done && <span className="cli-step-state">, done</span>}
        </h2>
        {children}
      </div>
    </li>
  );
}

// The page the shipcel CLI opens, with the terminal waiting behind it. Everything the CLI
// needs happens here, one step after the other: signing in with GitHub, approving this
// computer (`shipcel login` shows the same code), and connecting the Cloudflare account that
// apps deploy to. Signing in and connecting come back to this page. For `shipcel tokens
// add` it approves a named token instead, and Cloudflare isn't part of it.
export function CliSetup({
  code,
  session,
  onRefresh,
}: {
  // The code `shipcel login` shows; empty when the CLI only needs Cloudflare connected.
  code: string;
  session: SessionStatus;
  onRefresh: () => Promise<void>;
}) {
  // Without a GitHub sign-in, a local Shipcel acts as its local workspace, which can't
  // connect Cloudflare or approve a CLI.
  const user = session.user && !session.user.local ? session.user : null;
  const workspace = user?.workspaces.find((w) => w.id === user.workspaceId);
  const owner = user?.role === 'owner';
  const back = encodeURIComponent(code ? `cli-login:${code}` : 'cli-setup');
  const [login, setLogin] = useState<Login | null>(null),
    [loginError, setLoginError] = useState(''),
    [decided, setDecided] = useState<'approved' | 'denied' | null>(null),
    [connections, setConnections] = useState<ConnectionStatus | null>(null),
    [accounts, setAccounts] = useState<Account[] | null>(null),
    [account, setAccount] = useState(''),
    // undefined: not known (yet); null: the account has none.
    [subdomain, setSubdomain] = useState<string | null | undefined>(),
    [claim, setClaim] = useState(''),
    [confirming, setConfirming] = useState<Confirmation | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [declined] = useState(
    () => new URLSearchParams(location.search).get('connection') === 'declined',
  );
  // The CLI's link says a token was asked for; once the code is read, its answer decides.
  const [asked] = useState(
    () =>
      new URLSearchParams(location.hash.split('?')[1] ?? '').get('token') ===
      '1',
  );
  // The address keeps only what this page reads again.
  useEffect(() => {
    if (location.search)
      history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }, []);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const signedIn = !!user;
  const workspaceId = user?.workspaceId;
  useEffect(() => {
    setLogin(null);
    setLoginError('');
    setDecided(null);
    if (!signedIn || !code) return;
    api<Login>(`/cli/login/${encodeURIComponent(code)}`)
      .then(setLogin)
      .catch((e: Error) => setLoginError(e.message));
  }, [signedIn, workspaceId, code]);
  const loadConnections = () =>
    api<ConnectionStatus>('/connections')
      .then(setConnections)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setConnections(null);
    if (signedIn) void loadConnections();
  }, [signedIn, workspaceId]);
  const connected = !!connections?.cloudflare.connected;
  const chosen = connected ? connections!.cloudflare.account : null;
  // A connection that reaches several accounts lists them without being asked.
  useEffect(() => {
    setAccounts(null);
    if (!owner || !connected || chosen) return;
    api<{ accounts: Account[] }>('/connections/cloudflare/accounts')
      .then((r) => setAccounts(r.accounts))
      .catch((e: Error) => setError(e.message));
  }, [owner, connected, chosen?.id]);
  // Every app's free address is under the account's workers.dev subdomain.
  useEffect(() => {
    setSubdomain(undefined);
    if (!chosen || !connections?.nativeBuildsEnabled) return;
    api<{ subdomain: string | null }>('/connections/cloudflare/subdomain')
      .then((r) => setSubdomain(r.subdomain))
      .catch(() => setSubdomain(undefined));
  }, [chosen?.id, connections?.nativeBuildsEnabled]);

  const decide = (choice: 'approve' | 'deny') =>
    run(async () => {
      await api(`/cli/login/${choice}`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setDecided(choice === 'approve' ? 'approved' : 'denied');
    });
  const approved =
    decided === 'approved' ||
    (!decided &&
      !!login?.mine &&
      (login.status === 'approved' || login.status === 'delivered'));
  const denied =
    decided === 'denied' ||
    (!decided && !!login?.mine && login.status === 'denied');
  const cloudflareDone = !!chosen && subdomain !== null;
  const forToken = !!code && (login ? !!login.token : asked);
  const days = login?.token?.expiresInDays;
  const current = !signedIn
    ? 'github'
    : code && !approved
      ? 'approve'
      : !cloudflareDone && !forToken
        ? 'cloudflare'
        : '';
  const finished =
    signedIn && (!code || approved) && (cloudflareDone || forToken);
  let number = 0;
  return (
    <main className="cli-setup">
      <img src="/favicon.svg" alt="Shipcel" />
      <h1>
        {forToken
          ? 'Create an API token'
          : code
            ? 'Sign in the Shipcel CLI'
            : 'Finish setting up the CLI'}
      </h1>
      <p className="cli-setup-lead">
        Your terminal is waiting. Do each step here; the CLI carries on by
        itself.
      </p>
      {declined && (
        <div className="inline-error" role="status">
          Authorization was declined; nothing was connected.
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <ol className="cli-steps">
        <Step
          number={++number}
          title="Sign in with GitHub"
          done={signedIn}
          current={current === 'github'}
        >
          {user ? (
            <p>
              Signed in as <strong>{user.login}</strong>
              {workspace ? (
                <>
                  , in <strong>{workspace.name}</strong>
                </>
              ) : null}
              .{' '}
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api('/auth/logout', { method: 'POST' });
                    await onRefresh();
                  })
                }
              >
                Not you? Sign out
              </button>
            </p>
          ) : session.githubConfigured ? (
            <>
              <p>
                Shipcel signs you in with your GitHub account. You come back to
                this page afterwards.
              </p>
              <a
                className="button primary"
                href={`/api/auth/github/start?return=${back}`}
              >
                <GitBranch size={16} aria-hidden="true" />
                Continue with GitHub
              </a>
            </>
          ) : session.local ? (
            <p>
              This Shipcel has no GitHub sign-in yet. Set it up once on{' '}
              <a href="/app/#connections">Connections</a>, then run{' '}
              <code>shipcel login</code> again.
            </p>
          ) : (
            <p>
              GitHub sign-in is not available yet. The Shipcel owner needs to
              finish account setup.
            </p>
          )}
          {user && user.workspaces.length > 1 && !approved && (
            <label className="field-label">
              Workspace the CLI will act in
              <select
                className="text-input"
                value={user.workspaceId}
                disabled={busy}
                onChange={(e) =>
                  void run(async () => {
                    await api('/auth/workspace', {
                      method: 'POST',
                      body: JSON.stringify({ workspaceId: e.target.value }),
                    });
                    await onRefresh();
                  })
                }
              >
                {user.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </Step>
        {code && (
          <Step
            number={++number}
            title={forToken ? 'Approve the token' : 'Approve this computer'}
            done={approved}
            current={current === 'approve'}
          >
            {!signedIn ? (
              <p>
                Then check the code <strong>{code}</strong> against your
                terminal and approve it.
              </p>
            ) : approved && login?.token ? (
              <p role="status">
                Created the token <strong>{login.token.name}</strong>. Your
                terminal shows it once; it acts as you in{' '}
                {workspace?.name ?? 'this workspace'} for {days} day
                {days === 1 ? '' : 's'}.
              </p>
            ) : approved ? (
              <p role="status">
                The CLI on {login?.host || 'your computer'} is signed in. It
                acts as you in {workspace?.name ?? 'this workspace'} for 90
                days.
              </p>
            ) : denied ? (
              <p role="status">
                {forToken
                  ? 'Denied. No token was created.'
                  : 'Denied. The CLI won’t get access.'}{' '}
                If you didn’t ask for it in your terminal yourself, nothing else
                is needed.
              </p>
            ) : loginError ? (
              <p className="inline-error" role="alert">
                {loginError}
              </p>
            ) : !login ? (
              <p>Checking the code…</p>
            ) : login.status === 'pending' ? (
              <>
                {login.token ? (
                  <p>
                    Check that this code matches the one in your terminal, and
                    only approve a token you asked for yourself. Approving
                    creates the token <strong>{login.token.name}</strong>, which
                    acts as you in{' '}
                    <strong>{workspace?.name ?? 'this workspace'}</strong> for{' '}
                    {days} day{days === 1 ? '' : 's'}. Your terminal shows it
                    once.
                  </p>
                ) : (
                  <p>
                    Check that this code matches the one in your terminal, and
                    only approve a sign-in you started yourself. The CLI gets a
                    token that acts as you in{' '}
                    <strong>{workspace?.name ?? 'this workspace'}</strong> for
                    90 days.
                  </p>
                )}
                <p className="cli-code" aria-label={`Code ${login.code}`}>
                  {login.code}
                </p>
                <p>
                  Requested from {login.host || 'a computer'} at{' '}
                  {new Date(login.createdAt * 1000).toLocaleTimeString()}.
                </p>
                <div className="integration-actions">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void decide('approve')}
                  >
                    Approve
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void decide('deny')}
                  >
                    Deny
                  </button>
                </div>
              </>
            ) : (
              <p>
                This code was already used or has expired. Run{' '}
                <code>{forToken ? 'shipcel tokens add' : 'shipcel login'}</code>{' '}
                again.
              </p>
            )}
          </Step>
        )}
        {!forToken && (
          <Step
            number={++number}
            title="Connect Cloudflare"
            done={cloudflareDone}
            current={current === 'cloudflare'}
          >
            {!signedIn || !connections ? (
              <p>
                Your apps deploy into your own Cloudflare account. You connect
                it once.
              </p>
            ) : chosen ? (
              <p>
                Apps deploy to <strong>{chosen.name}</strong>.
              </p>
            ) : !owner ? (
              <p>
                This workspace has no Cloudflare account connected yet. Ask one
                of its owners to connect it.
              </p>
            ) : connected ? (
              accounts === null ? (
                <p>Loading your Cloudflare accounts…</p>
              ) : (
                <>
                  <label className="field-label" htmlFor="cli-account">
                    This connection reaches several accounts. Which one do apps
                    deploy to?
                  </label>
                  <select
                    id="cli-account"
                    className="text-input"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                  >
                    <option value="">Choose an account</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <div className="integration-actions">
                    <button
                      className="button primary"
                      disabled={busy || !account}
                      onClick={() =>
                        void run(async () => {
                          await api('/connections/cloudflare/account', {
                            method: 'POST',
                            body: JSON.stringify({ accountId: account }),
                          });
                          await loadConnections();
                        })
                      }
                    >
                      Use this account
                    </button>
                  </div>
                </>
              )
            ) : connections.cloudflare.configured ? (
              <>
                <p>
                  Your apps deploy into your own Cloudflare account: your
                  infrastructure and your bill. You come back to this page
                  afterwards.
                </p>
                <a
                  className="button primary"
                  href={`/api/auth/cloudflare/start?return=${back}`}
                >
                  <Cloud size={16} aria-hidden="true" />
                  Connect Cloudflare
                </a>
              </>
            ) : session.local ? (
              <p>
                This Shipcel has no Cloudflare sign-in yet. Set it up once on{' '}
                <a href="/app/#connections">Connections</a>, then come back to
                this page.
              </p>
            ) : (
              <p>
                Cloudflare sign-in is not available yet. The Shipcel owner needs
                to finish account setup.
              </p>
            )}
            {chosen && subdomain === null && owner && (
              <div className="address-claim">
                <p>
                  This Cloudflare account has no workers.dev subdomain yet.
                  Claim one for free: every app you deploy gets an address under
                  it.
                </p>
                <div className="address-input">
                  <input
                    className="text-input"
                    aria-label="workers.dev subdomain"
                    value={claim}
                    placeholder="your-name"
                    onChange={(e) =>
                      setClaim(e.target.value.trim().toLowerCase())
                    }
                  />
                  <span>.workers.dev</span>
                </div>
                <button
                  className="button secondary"
                  disabled={busy || !dnsLabel.test(claim)}
                  onClick={() =>
                    setConfirming({
                      title: `Claim ${claim}.workers.dev?`,
                      text: 'Cloudflare registers this subdomain for your whole account, so every Worker’s free address uses it. Changing it later moves all of those addresses.',
                      action: async () => {
                        const claimed = await api<{ subdomain: string }>(
                          '/connections/cloudflare/subdomain',
                          {
                            method: 'POST',
                            body: JSON.stringify({
                              subdomain: claim,
                              confirm: true,
                            }),
                          },
                        );
                        setSubdomain(claimed.subdomain);
                      },
                    })
                  }
                >
                  Claim {claim || 'your-name'}.workers.dev
                </button>
              </div>
            )}
            {chosen && subdomain === null && !owner && (
              <p>
                The account has no workers.dev subdomain yet. Ask a workspace
                owner to claim one.
              </p>
            )}
          </Step>
        )}
      </ol>
      {finished && (
        <p className="cli-setup-done" role="status">
          <Check size={16} aria-hidden="true" />
          You’re all set. Go back to your terminal.
        </p>
      )}
      <p className="signin-footnote">
        <a href="/app/">Open the dashboard</a>
      </p>
      {confirming && (
        <ConfirmOperation
          value={confirming}
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              try {
                await confirming.action();
              } finally {
                setConfirming(null);
              }
            })
          }
          onCancel={() => setConfirming(null)}
        />
      )}
    </main>
  );
}
