import { useState } from 'react';
import { ArrowUpRight, Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from './api';

// What Cloudflare's builds need besides the two connections, set up once on Connections:
// Cloudflare's own GitHub app, and a build token (a user API token: Cloudflare doesn't let
// apps create one yet).
export type GitHubAccess = {
  login: string;
  repository: string | null;
  // null: the account has no repository to check. True once Cloudflare reads any of them.
  readable: boolean | null;
  // Each repository Cloudflare was asked about.
  checked?: { repository: string; readable: boolean }[];
  // GitHub's page for the repositories Cloudflare's app may read.
  repositoriesUrl: string;
};
// Cloudflare's dashboard page for creating an application, where its GitHub app is connected
// to the account.
export type GitHubAccessCheck = {
  connectUrl: string;
  accounts: GitHubAccess[];
};

// Cloudflare's way to connect its GitHub app to Workers Builds (developers.cloudflare.com/
// workers/ci-cd/builds/): the button opens Create application.
export function ConnectSteps() {
  return (
    <>
      choose <strong>GitHub</strong>, sign in to GitHub if asked, give{' '}
      <strong>Cloudflare Workers and Pages</strong> your account and its
      repositories, then <strong>Install &amp; Authorize</strong>. When
      Cloudflare lists your repositories you’re done: nothing needs creating.
    </>
  );
}
export type BuildToken = { id: string; name: string };

// Cloudflare's token page, filled in with what its builds need (developers.cloudflare.com/
// fundamentals/api/how-to/account-owned-token-template/). The dashboard ignores unknown keys.
const buildTokenPermissions = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'account_settings', type: 'read' },
  { key: 'user_details', type: 'read' },
  { key: 'memberships', type: 'read' },
];
export const buildTokenUrl = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(buildTokenPermissions))}&accountId=*&zoneId=all&name=${encodeURIComponent('Shipcel builds')}`;

export function CloudflareGitHubAccess({
  check,
  error,
  checking,
  onCheck,
}: {
  // undefined: Cloudflare isn't connected yet; null: checking.
  check: GitHubAccessCheck | null | undefined;
  error: string;
  checking: boolean;
  onCheck: () => void;
}) {
  const access = check?.accounts;
  return (
    <div
      className="setup-step"
      role="group"
      aria-labelledby="cloudflare-github-app"
    >
      <h3 id="cloudflare-github-app">Cloudflare’s GitHub app</h3>
      <p className="field-hint">
        Cloudflare clones your code for its builds with its own GitHub app,
        separate from Shipcel’s. It’s installed once, from Cloudflare.
      </p>
      {check === undefined ? (
        <p className="field-hint">
          Connect Cloudflare and choose an account: Shipcel then checks this for
          you.
        </p>
      ) : error ? (
        <div className="inline-error" role="alert">
          Shipcel couldn’t check: {error}{' '}
          <button className="text-link" onClick={onCheck}>
            Try again
          </button>
        </div>
      ) : !access ? (
        <p className="field-hint" role="status">
          <LoaderCircle size={13} className="spin" /> Checking…
        </p>
      ) : (
        <ul className="setup-accounts">
          {access.map((a) => (
            <li key={a.login}>
              {a.readable === null ? (
                <span>{a.login}: no repositories to check yet</span>
              ) : (
                <span className={a.readable ? 'setup-done' : undefined}>
                  {a.readable && <Check size={14} />}
                  {a.readable
                    ? `Cloudflare can read ${a.login}’s repositories`
                    : `${a.login}: Cloudflare can’t read these repositories yet`}
                  {a.checked && a.checked.length > 0 && (
                    <>
                      {' '}
                      (
                      {a.checked
                        .map(
                          (r) =>
                            `${r.repository}: ${r.readable ? 'yes' : 'not yet'}`,
                        )
                        .join(', ')}
                      )
                    </>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {check && access?.some((a) => a.readable === false) && (
        <>
          <ol className="setup-instructions">
            <li>
              <a
                className="button secondary"
                href={check.connectUrl}
                target="_blank"
                rel="noreferrer"
              >
                Connect GitHub in Cloudflare
                <ArrowUpRight size={14} />
              </a>
            </li>
            <li>
              On Cloudflare’s Create application page: <ConnectSteps />
            </li>
            <li>
              Come back to this page: Shipcel checks again by itself.{' '}
              <button
                className="text-link"
                disabled={checking}
                onClick={onCheck}
              >
                <RefreshCw size={13} />
                Check now
              </button>
            </li>
          </ol>
          <p className="field-hint">
            Already installed? Then add the repositories to{' '}
            <strong>Cloudflare Workers and Pages</strong> on GitHub instead:{' '}
            {access
              .filter((a) => a.readable === false)
              .map((a, _, unreadable) => (
                <a
                  key={a.login}
                  className="text-link"
                  href={a.repositoriesUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {unreadable.length > 1 ? `${a.login}: ` : ''}Repository access
                  on GitHub
                  <ArrowUpRight size={14} />
                </a>
              ))}
          </p>
        </>
      )}
    </div>
  );
}

export function BuildTokenSetup({
  tokens,
  error,
  onReload,
}: {
  // null: loading.
  tokens: BuildToken[] | null;
  error: string;
  onReload: () => Promise<void>;
}) {
  // A user API token pasted to become the build token; sent once and never kept.
  const [value, setValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  async function add() {
    setAdding(true);
    setAddError('');
    try {
      await api('/connections/cloudflare/build-tokens', {
        method: 'POST',
        body: JSON.stringify({ token: value.trim() }),
      });
      setValue('');
      await onReload();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }
  return (
    <div className="setup-step" role="group" aria-labelledby="build-token">
      <h3 id="build-token">Build token</h3>
      {error ? (
        <div className="inline-error" role="alert">
          Cloudflare didn’t list the build tokens: {error}{' '}
          <button className="text-link" onClick={() => void onReload()}>
            Try again
          </button>
        </div>
      ) : tokens === null ? (
        <p className="field-hint" role="status">
          <LoaderCircle size={13} className="spin" /> Loading build tokens…
        </p>
      ) : tokens.length ? (
        <p className="setup-done">
          <Check size={14} />
          {tokens.map((t) => t.name).join(', ')}
        </p>
      ) : (
        <>
          <p className="field-hint">
            Cloudflare builds your apps with an API token of yours, made once
            for this account (Cloudflare doesn’t let apps create one yet).
          </p>
          <ol className="setup-instructions">
            <li>
              <a
                className="text-link"
                href={buildTokenUrl}
                target="_blank"
                rel="noreferrer"
              >
                Create the token in Cloudflare
                <ArrowUpRight size={14} />
              </a>{' '}
              opens with its permissions filled in: choose{' '}
              <strong>Continue to summary</strong>, then{' '}
              <strong>Create Token</strong>, and copy it.
            </li>
            <li>Paste it here.</li>
          </ol>
          <form
            className="address-input"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input
              className="text-input"
              type="password"
              aria-label="API token"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              className="button primary"
              type="submit"
              disabled={adding || !value.trim()}
            >
              {adding && <LoaderCircle size={14} className="spin" />}
              Add build token
            </button>
          </form>
          {addError && (
            <div className="inline-error" role="alert">
              {addError}
            </div>
          )}
          <p className="field-hint">
            Shipcel checks it with Cloudflare, registers it as “Shipcel builds”
            and keeps no copy. Made one in Cloudflare already?{' '}
            <button className="text-link" onClick={() => void onReload()}>
              check for build tokens
            </button>
            .
          </p>
        </>
      )}
    </div>
  );
}
