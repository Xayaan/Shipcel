import { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api';
import { DataApiPanel } from './DataApi';
import type { Confirmation } from './Operations';

type Settings = {
  appName: string;
  redirectUris: string[];
  logoutUris: string[];
  githubClientId: string | null;
  googleClientId: string | null;
  // Sign-in by email: links sent from this address; passwords allowed or not.
  emailFrom: string | null;
  password: boolean;
  signin: boolean;
  realtime: boolean;
};
type Info = {
  status: 'off' | 'enabling' | 'active' | 'needs_attention';
  error?: string | null;
  url?: string | null;
  clientId?: string;
  version?: string | null;
  latestVersion: string;
  updateAvailable?: boolean;
  workerName?: string;
  plan: { workerName: string; databaseName: string; appSecrets: string[] };
  settings?: Settings | null;
  settingsError?: string | null;
};
type User = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  disabled: boolean;
  createdAt: number;
  lastSignInAt: number | null;
  providers: string[];
  passkeys: number;
};
type Provider = 'github' | 'google';
const providers: { id: Provider; label: string; console: string }[] = [
  {
    id: 'github',
    label: 'GitHub',
    console: 'https://github.com/settings/developers',
  },
  {
    id: 'google',
    label: 'Google',
    console: 'https://console.cloud.google.com/apis/credentials',
  },
];
const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Sign-in and realtime for one project: a service Shipcel runs in the project's own
// Cloudflare account. Every change goes through the same confirmation and journal as
// the other Manage operations.
export function BackendPanel({
  root,
  busy,
  liveUrl,
  action,
  mutate,
  confirm,
}: {
  root: string;
  busy: boolean;
  liveUrl: string | null;
  action: (work: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: string,
    body: Record<string, unknown>,
    success: string,
  ) => Promise<void>;
  confirm: (value: Confirmation) => void;
}) {
  const [info, setInfo] = useState<Info | null>(null),
    [form, setForm] = useState({
      appName: '',
      redirectUris: '',
      logoutUris: '',
      signin: true,
      realtime: true,
      emailFrom: '',
      password: false,
    }),
    [credentials, setCredentials] = useState<
      Record<Provider, { clientId: string; clientSecret: string }>
    >({
      github: { clientId: '', clientSecret: '' },
      google: { clientId: '', clientSecret: '' },
    }),
    [users, setUsers] = useState<{ total: number; users: User[] } | null>(null),
    [removeName, setRemoveName] = useState('');

  async function load() {
    const data = await api<Info>(`${root}/backend`);
    setInfo(data);
    if (data.settings)
      setForm({
        appName: data.settings.appName,
        redirectUris: data.settings.redirectUris.join('\n'),
        logoutUris: data.settings.logoutUris.join('\n'),
        signin: data.settings.signin,
        realtime: data.settings.realtime,
        emailFrom: data.settings.emailFrom ?? '',
        password: data.settings.password,
      });
  }
  // Refreshes the status even when a change fails, so a stopped setup shows as such.
  async function change(work: () => Promise<void>) {
    try {
      await work();
    } finally {
      await load().catch(() => {});
    }
  }
  async function loadUsers() {
    setUsers(await api(`${root}/backend/users`));
  }
  // Loads once per project; the helpers are recreated on every render.
  useEffect(() => {
    void action(load);
  }, [root]);

  if (!info)
    return (
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>Sign-in &amp; realtime</h2>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void action(load)}
          >
            <RefreshCw size={14} />
            Check status
          </button>
        </div>
        <p>{busy ? 'Checking sign-in and realtime…' : ''}</p>
      </section>
    );

  const { plan } = info;
  const remove = (
    <section className="panel operation-body">
      <div className="operation-title">
        <h2>Remove sign-in &amp; realtime</h2>
      </div>
      <p>
        Deletes the {plan.workerName} Worker with its realtime channels, the{' '}
        {plan.databaseName} database with every user account and passkey, and
        the {plan.appSecrets.length} CLOUDCEL_ runtime secrets from your app.
        People can no longer sign in. This cannot be undone.
      </p>
      <form
        className="operation-form"
        onSubmit={(e) => {
          e.preventDefault();
          const confirmName = removeName;
          confirm({
            title: 'Remove sign-in & realtime?',
            text: `Every user account, passkey and session in ${plan.databaseName} is deleted, along with the ${plan.workerName} Worker. This cannot be undone.`,
            action: () =>
              change(async () => {
                await mutate(
                  '/backend',
                  'DELETE',
                  { confirmName },
                  'Sign-in and realtime were removed from this project.',
                );
                setRemoveName('');
                setUsers(null);
              }),
          });
        }}
      >
        <label className="field-label">
          Type {plan.workerName} to confirm
          <input
            className="text-input"
            value={removeName}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setRemoveName(e.target.value)}
          />
        </label>
        <button
          className="button danger"
          disabled={busy || removeName !== plan.workerName}
        >
          <Trash2 size={14} />
          Remove sign-in &amp; realtime
        </button>
      </form>
    </section>
  );

  if (info.status !== 'active')
    return (
      <>
        <section className="panel operation-body">
          <div className="operation-title">
            <h2>Sign-in &amp; realtime</h2>
            {info.status !== 'off' && (
              <span className="badge warning">Setup incomplete</span>
            )}
          </div>
          {info.status === 'off' ? (
            <>
              <p>
                Give this app user accounts and live updates without another
                provider. Shipcel sets them up in this project&apos;s own
                Cloudflare account, where they run within Cloudflare&apos;s free
                plan. People sign in with a passkey, or with GitHub or Google
                once you add them; your app gets realtime channels with
                presence.
              </p>
              <div className="operation-list">
                <h3>What Shipcel will create</h3>
                <div className="operation-row">
                  <div>
                    <strong>Worker {plan.workerName}</strong>
                    <p>
                      A standard OpenID Connect sign-in service and realtime
                      channels on Durable Objects, at its own workers.dev
                      address.
                    </p>
                  </div>
                </div>
                <div className="operation-row">
                  <div>
                    <strong>D1 database {plan.databaseName}</strong>
                    <p>
                      User accounts, passkeys and sessions, kept in your
                      account. The name ends in a short random code chosen at
                      setup, which shows Shipcel created it.
                    </p>
                  </div>
                </div>
                <div className="operation-row">
                  <div>
                    <strong>Runtime secrets on your app</strong>
                    <p>
                      {plan.appSecrets.join(', ')}, so your app reaches the
                      service without copying keys.
                    </p>
                  </div>
                </div>
              </div>
              <p>
                The token signing key and realtime secret are generated during
                setup and stored only as Cloudflare Worker secrets. Shipcel
                keeps no copy.
              </p>
            </>
          ) : (
            <>
              <p>{info.error || 'Setup has not finished yet.'}</p>
              <p>
                Continuing is safe: Shipcel picks up where it stopped and reuses
                only what this setup created.
              </p>
            </>
          )}
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              confirm({
                title:
                  info.status === 'off'
                    ? 'Turn on sign-in & realtime?'
                    : 'Continue setup?',
                text: `Shipcel creates the ${plan.workerName} Worker and the ${plan.databaseName} D1 database in this project's Cloudflare account, then adds ${plan.appSecrets.length} runtime secrets to your app. Nothing outside these is changed.`,
                action: () =>
                  change(() =>
                    mutate(
                      '/backend',
                      'POST',
                      {},
                      'Sign-in and realtime are on.',
                    ),
                  ),
              })
            }
          >
            {info.status === 'off'
              ? 'Turn on sign-in & realtime'
              : 'Continue setup'}
          </button>
        </section>
        {info.status !== 'off' && remove}
      </>
    );

  const url = info.url ?? '';
  const realtimeUrl = `${url.replace(/^https/, 'wss')}/realtime/channels/`;
  const settings = info.settings;
  const returnTo =
    settings?.redirectUris[0] ?? (liveUrl ? `${liveUrl}auth/callback` : '');
  return (
    <>
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>Sign-in &amp; realtime</h2>
          <div className="operation-badges">
            <span className="badge green">On</span>
            {info.updateAvailable && (
              <span className="badge warning">Update available</span>
            )}
          </div>
        </div>
        <p>
          Running in your Cloudflare account as the {info.workerName} Worker.
          Your app already has {plan.appSecrets.join(', ')} as runtime secrets.
        </p>
        <div className="operation-list">
          <div className="operation-row">
            <div>
              <strong>Sign-in address (issuer)</strong>
              <p>
                <a href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
              </p>
            </div>
          </div>
          <div className="operation-row">
            <div>
              <strong>Client ID</strong>
              <p>
                <code>{info.clientId}</code>
              </p>
            </div>
          </div>
          <div className="operation-row">
            <div>
              <strong>Realtime address</strong>
              <p>
                <code>{realtimeUrl}</code>
              </p>
            </div>
          </div>
          <div className="operation-row">
            <div>
              <strong>Service version</strong>
              <p>
                {info.version}
                {info.updateAvailable
                  ? `, ${info.latestVersion} is available. Updating keeps every user, key and setting.`
                  : ', up to date'}
              </p>
            </div>
            {info.updateAvailable && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  confirm({
                    title: 'Install the service update?',
                    text: 'Shipcel updates the database tables and uploads the new service code. Users, keys, sessions and settings are kept.',
                    action: () =>
                      change(() =>
                        mutate(
                          '/backend/update',
                          'POST',
                          {},
                          'The sign-in and realtime service was updated.',
                        ),
                      ),
                  })
                }
              >
                Install update
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="panel operation-body">
        <div className="operation-title">
          <h2>Connect your app</h2>
        </div>
        <p>
          Sign-in is standard OpenID Connect, so any OIDC library works: use the
          authorization code flow with PKCE (S256) as a public client with no
          client secret. Tokens are ES256-signed JWTs you can verify with the
          service&apos;s published keys.
        </p>
        <pre className="snippet">
          {`Issuer      ${url}
Client ID   ${info.clientId}
Return to   ${returnTo || 'https://your-app.example/auth/callback'}
Discovery   ${url}/.well-known/openid-configuration`}
        </pre>
        <p>
          Realtime: browsers listen on public: channels without a token. Your
          Worker sends to a channel with the realtime secret, and can sign
          channel tokens (HS256, with the same secret) that let a person join
          private channels or publish.
        </p>
        <pre className="snippet">
          {`// In the browser
const ws = new WebSocket('${realtimeUrl}public:lobby');
ws.onmessage = (e) => console.log(JSON.parse(e.data));

// In your Worker
await fetch(\`\${env.CLOUDCEL_AUTH_ISSUER}/realtime/channels/public:lobby/messages\`, {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${env.CLOUDCEL_REALTIME_SECRET}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ event: 'update', data: { text: 'Hello' } }),
});`}
        </pre>
        <p>
          A channel token is a JWT with <code>sub</code>, <code>exp</code>,{' '}
          <code>channels</code> (names, or prefixes ending in *), and optional{' '}
          <code>publish</code> and <code>info</code>; browsers add it as{' '}
          <code>?token=</code>. A signed-in person&apos;s access token also lets
          them listen on their own <code>user:&lt;id&gt;</code> channel.
        </p>
      </section>

      {settings ? (
        <>
          <section className="panel operation-body">
            <div className="operation-title">
              <h2>Sign-in settings</h2>
            </div>
            <form
              className="operation-form stacked"
              onSubmit={(e) => {
                e.preventDefault();
                const next = {
                  appName: form.appName.trim(),
                  redirectUris: lines(form.redirectUris),
                  logoutUris: lines(form.logoutUris),
                  signin: form.signin,
                  realtime: form.realtime,
                  emailFrom: form.emailFrom.trim(),
                  password: form.password,
                };
                confirm({
                  title: 'Save sign-in settings?',
                  text: `People can return only to the ${plural(next.redirectUris.length, 'address')} listed after signing in.${next.signin ? '' : ' Sign-in will be turned off: new sign-ins, sign-in pages and token refreshes are refused until you turn it back on. Access tokens already issued keep working for up to an hour.'}${next.realtime ? '' : ' Realtime will be turned off: new connections are refused.'}`,
                  action: () =>
                    change(() =>
                      mutate(
                        '/backend/settings',
                        'PUT',
                        next,
                        'Sign-in settings saved.',
                      ),
                    ),
                });
              }}
            >
              <label className="field-label">
                App name on the sign-in page
                <input
                  className="text-input"
                  required
                  maxLength={80}
                  value={form.appName}
                  onChange={(e) =>
                    setForm({ ...form, appName: e.target.value })
                  }
                />
              </label>
              <label className="field-label">
                Return addresses after sign-in
                <textarea
                  className="text-input"
                  rows={3}
                  aria-describedby="return-hint"
                  value={form.redirectUris}
                  onChange={(e) =>
                    setForm({ ...form, redirectUris: e.target.value })
                  }
                />
              </label>
              <label className="field-label">
                Return addresses after sign-out
                <textarea
                  className="text-input"
                  rows={2}
                  aria-describedby="return-hint"
                  value={form.logoutUris}
                  onChange={(e) =>
                    setForm({ ...form, logoutUris: e.target.value })
                  }
                />
              </label>
              <p className="field-hint" id="return-hint">
                One per line, up to 10. Use https://, or http://localhost while
                developing.
              </p>
              <label className="field-label">
                Sender address for sign-in links by email
                <input
                  className="text-input"
                  type="email"
                  maxLength={254}
                  placeholder="sign-in@your-domain.com"
                  aria-describedby="email-hint"
                  value={form.emailFrom}
                  onChange={(e) =>
                    setForm({ ...form, emailFrom: e.target.value })
                  }
                />
              </label>
              <p className="field-hint" id="email-hint">
                Leave it empty for no email sign-in. The address must be on a
                domain onboarded for Email Sending in your Cloudflare account
                (Compute, Email Service, Email Sending, Onboard Domain: it adds
                the DNS records). Cloudflare includes 3,000 emails a month on
                Workers Paid, then charges $0.35 per 1,000.
              </p>
              <label className="deploy-consent">
                <input
                  type="checkbox"
                  checked={form.password}
                  onChange={(e) =>
                    setForm({ ...form, password: e.target.checked })
                  }
                />
                <span>
                  Allow passwords: people set one at the service’s /password/set
                  page once signed in, and can still ask for a link by email.
                </span>
              </label>
              <label className="deploy-consent">
                <input
                  type="checkbox"
                  checked={form.signin}
                  onChange={(e) =>
                    setForm({ ...form, signin: e.target.checked })
                  }
                />
                <span>Allow sign-in</span>
              </label>
              <label className="deploy-consent">
                <input
                  type="checkbox"
                  checked={form.realtime}
                  onChange={(e) =>
                    setForm({ ...form, realtime: e.target.checked })
                  }
                />
                <span>Allow realtime connections</span>
              </label>
              <button className="button primary" disabled={busy}>
                Save settings
              </button>
            </form>
          </section>

          <section className="panel operation-body">
            <div className="operation-title">
              <h2>Sign-in methods</h2>
            </div>
            <div className="operation-list">
              <div className="operation-row">
                <div>
                  <strong>Passkeys</strong>
                  <p>
                    Always on: Face ID, Touch ID, Windows Hello or a security
                    key. There are no passwords to leak and no email service to
                    set up.
                  </p>
                </div>
                <span className="badge green">On</span>
              </div>
              {providers.map((p) => {
                const clientId =
                  (p.id === 'github'
                    ? settings?.githubClientId
                    : settings?.googleClientId) ?? null;
                const callback = `${url}/oauth/${p.id}/callback`;
                const value = credentials[p.id];
                return (
                  <div className="operation-row" key={p.id}>
                    <div>
                      <strong>{p.label}</strong>
                      {clientId ? (
                        <p>
                          Connected with client ID <code>{clientId}</code>.
                        </p>
                      ) : (
                        <>
                          <p>
                            Create an OAuth app in{' '}
                            <a
                              href={p.console}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {p.label}&apos;s developer settings
                            </a>{' '}
                            with this callback URL: <code>{callback}</code>
                          </p>
                          <form
                            className="operation-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              // The secret leaves the form now; Shipcel sends it
                              // straight to a Cloudflare Worker secret.
                              const input = { ...value };
                              setCredentials({
                                ...credentials,
                                [p.id]: {
                                  clientId: value.clientId,
                                  clientSecret: '',
                                },
                              });
                              confirm({
                                title: `Turn on ${p.label} sign-in?`,
                                text: `The client secret is stored only as a Cloudflare Worker secret on ${info.workerName}. Shipcel keeps no copy.`,
                                action: () =>
                                  change(async () => {
                                    await mutate(
                                      `/backend/providers/${p.id}`,
                                      'PUT',
                                      input,
                                      `${p.label} sign-in is on.`,
                                    );
                                    setCredentials((prev) => ({
                                      ...prev,
                                      [p.id]: {
                                        clientId: '',
                                        clientSecret: '',
                                      },
                                    }));
                                  }),
                              });
                            }}
                          >
                            <label className="field-label">
                              {p.label} client ID
                              <input
                                className="text-input"
                                required
                                maxLength={200}
                                autoComplete="off"
                                spellCheck={false}
                                value={value.clientId}
                                onChange={(e) =>
                                  setCredentials({
                                    ...credentials,
                                    [p.id]: {
                                      ...value,
                                      clientId: e.target.value,
                                    },
                                  })
                                }
                              />
                            </label>
                            <label className="field-label">
                              {p.label} client secret
                              <input
                                className="text-input"
                                type="password"
                                required
                                maxLength={500}
                                autoComplete="off"
                                value={value.clientSecret}
                                onChange={(e) =>
                                  setCredentials({
                                    ...credentials,
                                    [p.id]: {
                                      ...value,
                                      clientSecret: e.target.value,
                                    },
                                  })
                                }
                              />
                            </label>
                            <button
                              className="button secondary"
                              disabled={busy}
                            >
                              Turn on {p.label} sign-in
                            </button>
                          </form>
                        </>
                      )}
                    </div>
                    {clientId ? (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          confirm({
                            title: `Turn off ${p.label} sign-in?`,
                            text: `People who signed up with ${p.label} can no longer use it to sign in. Their accounts stay, and any passkeys they added keep working.`,
                            action: () =>
                              change(() =>
                                mutate(
                                  `/backend/providers/${p.id}`,
                                  'DELETE',
                                  {},
                                  `${p.label} sign-in is off.`,
                                ),
                              ),
                          })
                        }
                      >
                        Turn off
                      </button>
                    ) : (
                      <span className="badge">Off</span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel operation-body">
            <div className="operation-title">
              <h2>Users</h2>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void action(loadUsers)}
              >
                <RefreshCw size={14} />
                Load users
              </button>
            </div>
            {users && (
              <div className="operation-list">
                {users.users.length ? (
                  users.users.map((u) => {
                    const who = u.name || u.email || u.id;
                    const methods = [
                      ...u.providers.map(
                        (p) => providers.find((x) => x.id === p)?.label ?? p,
                      ),
                      ...(u.passkeys ? [plural(u.passkeys, 'passkey')] : []),
                    ];
                    const act = (
                      verb: 'disable' | 'enable' | 'delete',
                      title: string,
                      text: string,
                      done: string,
                    ) =>
                      confirm({
                        title,
                        text,
                        action: async () => {
                          await mutate(
                            `/backend/users/${encodeURIComponent(u.id)}/${verb}`,
                            'POST',
                            {},
                            done,
                          );
                          await loadUsers();
                        },
                      });
                    return (
                      <div className="operation-row" key={u.id}>
                        <div>
                          <strong>{who}</strong>
                          <p>
                            {u.email && u.name ? `${u.email}, ` : ''}
                            Joined {date(u.createdAt)},{' '}
                            {u.lastSignInAt
                              ? `last signed in ${date(u.lastSignInAt)}`
                              : 'never signed in'}
                            {methods.length ? `, ${methods.join(', ')}` : ''}
                          </p>
                        </div>
                        <div className="operation-badges">
                          {u.disabled && (
                            <span className="badge warning">Disabled</span>
                          )}
                          <button
                            className="button secondary"
                            disabled={busy}
                            aria-label={`${u.disabled ? 'Enable' : 'Disable'} ${who}`}
                            onClick={() =>
                              u.disabled
                                ? act(
                                    'enable',
                                    `Enable ${who}?`,
                                    'They can sign in again.',
                                    'User enabled.',
                                  )
                                : act(
                                    'disable',
                                    `Disable ${who}?`,
                                    'They are signed out everywhere: their sessions end, their refresh tokens stop working, and their realtime connections close within 5 minutes. They cannot sign in until you enable them again. Their account stays.',
                                    'User disabled and signed out.',
                                  )
                            }
                          >
                            {u.disabled ? 'Enable' : 'Disable'}
                          </button>
                          <button
                            className="button secondary"
                            disabled={busy}
                            aria-label={`Delete ${who}`}
                            onClick={() =>
                              act(
                                'delete',
                                `Delete ${who}?`,
                                "Their account, passkeys and linked sign-ins are deleted and they are signed out everywhere. Your app's own data about them is not touched. This cannot be undone.",
                                'User deleted.',
                              )
                            }
                          >
                            <Trash2 size={14} />
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="operation-empty">No one has signed up yet.</p>
                )}
                {users.total > users.users.length && (
                  <p className="operation-empty">
                    Showing the newest {users.users.length} of {users.total}{' '}
                    users.
                  </p>
                )}
              </div>
            )}
          </section>
          <DataApiPanel
            root={root}
            issuer={url}
            busy={busy}
            action={action}
            mutate={mutate}
            confirm={confirm}
          />
        </>
      ) : (
        <section className="panel operation-body">
          <div className="operation-title">
            <h2>Settings unavailable</h2>
            <span className="badge warning">Needs attention</span>
          </div>
          <p>
            Shipcel couldn&apos;t read this service&apos;s settings from the{' '}
            {plan.databaseName} database
            {info.settingsError ? `: ${info.settingsError}` : '.'} Settings,
            sign-in methods and users are unavailable until it can. If the
            database was deleted in Cloudflare, remove sign-in &amp; realtime
            below, then turn it on again.
          </p>
        </section>
      )}
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>Realtime secret</h2>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              confirm({
                title: 'Replace the realtime secret?',
                text: 'Shipcel gives the service and your app a new secret together. Channel tokens signed with the old secret stop working for new connections.',
                action: () =>
                  change(() =>
                    mutate(
                      '/backend/realtime-secret',
                      'POST',
                      {},
                      'The realtime secret was replaced on the service and your app.',
                    ),
                  ),
              })
            }
          >
            <RefreshCw size={14} />
            Replace secret
          </button>
        </div>
        <p>
          Your app reads it as CLOUDCEL_REALTIME_SECRET. Replace it if it may
          have been exposed.
        </p>
      </section>
      {remove}
    </>
  );
}
