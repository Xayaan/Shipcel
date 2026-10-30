import { useEffect, useState } from 'react';
import { ArrowUpRight, Cloud, GitBranch } from 'lucide-react';
import { api } from './api';
import { CopyButton } from './Developers';

export type SetupStatus = {
  available: boolean;
  encryption: boolean;
  origin: string;
  github: ProviderSetupState & { callbackUrl: string };
  // outdated: permissions every deploy needs that the client lacks.
  cloudflare: ProviderSetupState & { redirectUrl: string; outdated?: string[] };
};
type ProviderSetupState = {
  configured: boolean;
  source: 'env' | 'setup' | null;
  name: string | null;
  url: string | null;
  accountId: string | null;
  scopes: string[];
};
type Preview = {
  accounts: { id: string; name: string }[];
  scopes: { id: string; name: string }[];
  missing: string[];
  ready: boolean;
};

// Connections → set up GitHub sign-in on a local Shipcel: GitHub opens with a private app
// filled in; the person creates it there and comes back. Nothing to copy.
export function GitHubSetup({ busy }: { busy: boolean }) {
  const [organization, setOrganization] = useState(''),
    [error, setError] = useState(''),
    [starting, setStarting] = useState(false);
  // Coming back from GitHub with the Back button restores this page as it was left.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setStarting(false);
    };
    addEventListener('pageshow', restored);
    return () => removeEventListener('pageshow', restored);
  }, []);
  async function start() {
    setStarting(true);
    setError('');
    try {
      const { action, manifest } = await api<{
        action: string;
        manifest: Record<string, unknown>;
      }>('/setup/github', {
        method: 'POST',
        body: JSON.stringify(
          organization.trim() ? { organization: organization.trim() } : {},
        ),
      });
      // GitHub takes the manifest as a form post, so the browser goes there.
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = JSON.stringify(manifest);
      form.appendChild(field);
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  }
  return (
    <form
      className="setup-steps"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <strong>Set up GitHub sign-in</strong>
      <p>
        Shipcel creates a private GitHub App for you. GitHub opens with
        everything filled in: check it, click <em>Create GitHub App</em>, and
        you’ll come back here.
      </p>
      <label className="field-label">
        Create it for an organization <span>optional</span>
        <input
          className="text-input"
          value={organization}
          placeholder="Your personal account"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setOrganization(e.target.value)}
        />
      </label>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <button className="button primary" disabled={busy || starting}>
        <GitBranch size={15} />
        {starting ? 'Opening GitHub…' : 'Create GitHub App on GitHub'}
      </button>
    </form>
  );
}

// Connections → set up Cloudflare sign-in on a local Shipcel: a temporary API token with one
// permission lets Shipcel create the OAuth client. Creating it by hand is the fallback.
export function CloudflareSetup({
  setup,
  onDone,
}: {
  setup: SetupStatus;
  onDone: (notice: string) => Promise<void>;
}) {
  const [token, setToken] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [accountId, setAccountId] = useState(''),
    [clientId, setClientId] = useState(''),
    [clientSecret, setClientSecret] = useState(''),
    [scopes, setScopes] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
  const tokenField = token.trim();
  return (
    <div className="setup-steps">
      <strong>Set up Cloudflare sign-in</strong>
      <ol>
        <li>
          In Cloudflare, create a temporary API token: <em>Create Token</em> →{' '}
          <em>Custom token</em> with one permission, <em>Account</em>,{' '}
          <em>OAuth Client</em>, <em>Edit</em>.{' '}
          <a
            className="text-link"
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noreferrer"
          >
            Open Cloudflare API tokens
            <ArrowUpRight size={13} />
          </a>
        </li>
        <li>
          Paste it here. Shipcel creates a private OAuth client in your account
          with the right address and permissions. It doesn’t keep the token:
          delete it in Cloudflare afterwards.
        </li>
      </ol>
      <form
        className="setup-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const data = await api<Preview>('/setup/cloudflare/inspect', {
              method: 'POST',
              body: JSON.stringify({ token: tokenField }),
            });
            setPreview(data);
            setAccountId(data.accounts[0]?.id ?? '');
          });
        }}
      >
        <label className="field-label">
          Temporary API token
          <input
            className="text-input"
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setToken(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button className="button secondary" disabled={busy || !tokenField}>
          Check token
        </button>
      </form>
      {preview && (
        <div className="setup-preview" role="status">
          {preview.accounts.length > 1 ? (
            <label className="field-label">
              Account that owns the client
              <select
                className="text-input"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {preview.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          ) : preview.accounts.length ? (
            <p>Account: {preview.accounts[0].name}</p>
          ) : (
            <p>This token can’t see any account.</p>
          )}
          <p>
            Shipcel will ask for:{' '}
            {preview.scopes.map((s) => s.name).join(', ') || 'nothing yet'}.
          </p>
          {preview.missing.length > 0 && (
            <p className="field-hint">
              Not offered to OAuth clients in this account:{' '}
              {preview.missing.join(', ')}. Features that need them won’t work
              until they are.
            </p>
          )}
          <button
            type="button"
            className="button primary"
            disabled={busy || !preview.ready || !accountId}
            onClick={() =>
              void run(async () => {
                const created = await api<{ refreshTokens: boolean }>(
                  '/setup/cloudflare/create',
                  {
                    method: 'POST',
                    body: JSON.stringify({ token: tokenField, accountId }),
                  },
                );
                setToken('');
                setPreview(null);
                await onDone(
                  created.refreshTokens
                    ? 'Cloudflare sign-in is set up. You can delete the temporary token in Cloudflare.'
                    : 'Cloudflare sign-in is set up without refresh tokens, so you’ll reconnect when access expires. You can delete the temporary token in Cloudflare.',
                );
              })
            }
          >
            <Cloud size={15} />
            Create OAuth client
          </button>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <details className="setup-manual">
        <summary>Create the OAuth client yourself instead</summary>
        <p>
          In Cloudflare: <em>Manage Account</em> → <em>OAuth clients</em> →{' '}
          <em>Create client</em>, with response type <code>code</code>, grant
          types <em>Authorization code</em> and <em>Refresh token</em>, token
          authentication <code>client_secret_post</code>, and this redirect URL:
        </p>
        <div className="token-value">
          <code>{setup.cloudflare.redirectUrl}</code>
          <CopyButton
            text={setup.cloudflare.redirectUrl}
            label="Copy the redirect URL"
          />
        </div>
        <form
          className="operation-form stacked"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/setup/cloudflare', {
                method: 'PUT',
                body: JSON.stringify({ clientId, clientSecret, scopes }),
              });
              setClientSecret('');
              await onDone('Cloudflare sign-in is set up.');
            });
          }}
        >
          <label className="field-label">
            Client ID
            <input
              className="text-input"
              value={clientId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value)}
            />
          </label>
          <label className="field-label">
            Client secret
            <input
              className="text-input"
              type="password"
              value={clientSecret}
              autoComplete="off"
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </label>
          <label className="field-label">
            Scopes, as Cloudflare lists them
            <input
              className="text-input"
              value={scopes}
              placeholder="account-settings.read workers-scripts.write offline_access"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setScopes(e.target.value)}
            />
          </label>
          <button
            className="button secondary"
            disabled={
              busy || !clientId.trim() || !clientSecret.trim() || !scopes.trim()
            }
          >
            Save
          </button>
        </form>
      </details>
    </div>
  );
}

// Connections → a Cloudflare client set up before Shipcel asked for Workers Scripts Write:
// Workers Editor updates Workers but can't create them. The same kind of temporary token
// lets Shipcel update the client; connecting again grants the new permission.
export function CloudflareUpdate({
  onDone,
}: {
  onDone: (notice: string) => Promise<void>;
}) {
  const [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const value = token.trim();
  return (
    <section className="setup-steps" aria-labelledby="cloudflare-update-title">
      <strong id="cloudflare-update-title">Update Cloudflare sign-in</strong>
      <p>
        Shipcel’s OAuth client has <em>Workers Editor</em>, which updates
        Workers but can’t create them, so new apps can’t be deployed. Create a
        temporary API token with one permission, <em>Account</em>,{' '}
        <em>OAuth Client</em>, <em>Edit</em>, and paste it: Shipcel adds{' '}
        <em>Workers Scripts Write</em> to the client and doesn’t keep the token.{' '}
        <a
          className="text-link"
          href="https://dash.cloudflare.com/profile/api-tokens"
          target="_blank"
          rel="noreferrer"
        >
          Open Cloudflare API tokens
          <ArrowUpRight size={13} />
        </a>
      </p>
      <form
        className="setup-row"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void api<{ updated: 'in place' | 'replaced' }>(
            '/setup/cloudflare/update',
            { method: 'POST', body: JSON.stringify({ token: value }) },
          )
            .then(async ({ updated }) => {
              setToken('');
              await onDone(
                updated === 'replaced'
                  ? 'Shipcel made a new OAuth client with Workers Scripts Write, because Cloudflare wouldn’t change the old one. Connect Cloudflare again, then delete the temporary token, and the older Shipcel client, in Cloudflare.'
                  : 'Cloudflare sign-in is updated. Connect Cloudflare again to grant Workers Scripts Write, then delete the temporary token in Cloudflare.',
              );
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label className="field-label">
          Temporary API token
          <input
            className="text-input"
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <button className="button primary" disabled={busy || !value}>
          <Cloud size={15} />
          Update OAuth client
        </button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
