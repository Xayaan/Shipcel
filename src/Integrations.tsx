import type {
  RepositoryInspection,
  ResourceRequest,
} from '../shared/deployment-plan';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Cloud,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Zap,
} from 'lucide-react';
import { api } from './api';
import { capture } from './posthog';
import { DirectUpload } from './Upload';
import { ConfirmOperation, type Confirmation } from './Operations';
import { BranchPreviews } from './Previews';
import { RepositoryPicker } from './RepositoryPicker';
import { GitHubDeploy } from './GitHubDeploy';
import { GitSource, type GitSourceLink } from './GitSource';
import {
  BuildTokenSetup,
  CloudflareGitHubAccess,
  ConnectSteps,
  type BuildToken,
  type GitHubAccess,
  type GitHubAccessCheck,
} from './BuildSetup';
import {
  CloudflareSetup,
  CloudflareUpdate,
  GitHubSetup,
  type SetupStatus,
} from './ProviderSetup';
import type {
  ConnectionStatus,
  Deployment,
  SessionStatus,
} from '../shared/integrations';
import type { Project } from '../shared/catalog';

const resourceLabels: Record<ResourceRequest['type'], string> = {
  d1: 'D1 database',
  r2: 'R2 bucket',
  kv: 'KV namespace',
  // Bound as it is; the deploy creates nothing for it.
  hyperdrive: 'Postgres or MySQL through Hyperdrive',
};
// Interrupted provider requests (intent_*) share the label of the step they belong to.
const stepLabels: Record<string, string> = {
  queued: 'Queued',
  create_worker: 'Creating Worker',
  connect_repository: 'Connecting repository',
  create_trigger: 'Creating build trigger',
  start_build: 'Starting initial build',
  building: 'Building',
  health_check: 'Checking bindings and health',
  finished: 'Finished',
};
// Worker names and workers.dev subdomains: one DNS label of lowercase letters, numbers, and hyphens.
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const stepLabel = (step: string) =>
  stepLabels[step.replace(/^intent_/, '')] ?? step.replaceAll('_', ' ');
const adapterLabels: Record<string, string> = {
  'configured-worker': 'Wrangler configuration',
  astro: 'Astro with @astrojs/cloudflare',
  sveltekit: 'SvelteKit with @sveltejs/adapter-cloudflare',
  nextjs: 'Next.js with @opennextjs/cloudflare',
  python: 'Python Worker',
  'python-packages': 'Python Worker with packages (pywrangler)',
  container: 'Container Worker (Docker images and Durable Objects)',
  'static-assets': 'Static site, no Wrangler configuration needed',
};

export function SignIn({ configured }: { configured: boolean }) {
  return (
    <main className="signin-page">
      <img src="/favicon.svg" alt="Shipcel" />
      <h1>Your next deployment starts here.</h1>
      <p>
        Sign in with GitHub, choose your repository, and deploy to your own
        Cloudflare account.
      </p>
      {configured ? (
        <a className="button primary" href="/api/auth/github/start">
          <GitBranch size={18} />
          Continue with GitHub
        </a>
      ) : (
        <div className="inline-error">
          GitHub sign-in is not available yet. The Shipcel owner needs to finish
          account setup.
        </div>
      )}
      <p className="signin-footnote">
        Your Cloudflare infrastructure remains in your account.
      </p>
      <p className="signin-footnote">
        <a href="/pricing/">What’s free</a>, <a href="/why/">Why Shipcel</a>,{' '}
        <a href="/compare/">Compare</a>
      </p>
    </main>
  );
}

export function ConnectionsPanel({
  session,
  onRefresh,
}: {
  session: SessionStatus | null;
  onRefresh: () => Promise<void>;
}) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(1);
  const [selected, setSelected] = useState('');
  const [confirm, setConfirm] = useState<'github' | 'cloudflare' | null>(null);
  // Choosing another account than the one deployments go to.
  const [changing, setChanging] = useState(false);
  // A local Shipcel sets up its GitHub App and Cloudflare OAuth client here.
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  // What Cloudflare's builds need besides the connections: undefined until Cloudflare and an
  // account are there to check with; null while checking.
  const [access, setAccess] = useState<GitHubAccessCheck | null | undefined>();
  const [accessError, setAccessError] = useState('');
  const [tokens, setTokens] = useState<BuildToken[] | null>(null);
  const [tokenError, setTokenError] = useState('');
  // Cloudflare's own builds are optional: what they need is checked once their section opens.
  const [buildsOpen, setBuildsOpen] = useState(false);
  async function load() {
    try {
      const data = await api<ConnectionStatus>('/connections');
      setStatus(data);
      setSelected(data.cloudflare.account?.id || '');
      setSetup(
        session?.local
          ? await api<SetupStatus>('/setup').catch(() => null)
          : null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const params = new URLSearchParams(location.search);
    const result = params.get('connection'),
      created = params.get('setup');
    if (result)
      setNotice(
        result === 'success'
          ? 'Account authorization completed.'
          : result === 'repositories'
            ? 'GitHub saved your choice of repositories.'
            : 'Authorization was declined; nothing was connected.',
      );
    if (created)
      setNotice(
        created === 'github'
          ? 'GitHub App created. Connect GitHub to sign in.'
          : created === 'cancelled'
            ? 'GitHub App setup was cancelled.'
            : 'GitHub didn’t finish creating the app. Try again.',
      );
    if (result || created)
      history.replaceState(null, '', `${location.pathname}#connections`);
  }, [session?.local]);
  const githubConnected = !!status?.github.connected;
  const accountId = status?.cloudflare.account?.id;
  // GitHub Actions deploys every push when GitHub can reach this Shipcel. Otherwise (a Shipcel
  // on someone's own computer) Cloudflare's own builds do, set up on the cards below.
  const actions = !!status?.githubActions;
  async function checkAccess() {
    setAccessError('');
    setAccess((prev) => prev ?? null);
    try {
      setAccess(await api<GitHubAccessCheck>('/connections/cloudflare/github'));
    } catch (e) {
      setAccessError((e as Error).message);
    }
  }
  async function loadTokens() {
    setTokenError('');
    try {
      setTokens(
        await api<BuildToken[]>('/connections/cloudflare/build-tokens'),
      );
    } catch (e) {
      setTokenError((e as Error).message);
    }
  }
  // Checked as soon as there is something to check with: with GitHub Actions, once Cloudflare's
  // own builds are opened.
  useEffect(() => {
    if (!accountId) {
      setAccess(undefined);
      setTokens(null);
      return;
    }
    if (actions && !buildsOpen) return;
    void loadTokens();
    if (githubConnected) void checkAccess();
  }, [accountId, githubConnected, actions, buildsOpen]);
  // Coming back from GitHub, after installing Cloudflare's app, checks again by itself.
  const waiting = !!access?.accounts.some((a) => a.readable === false);
  useEffect(() => {
    if (!waiting) return;
    const again = () => void checkAccess();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [waiting]);
  // A connection with several accounts lists them without being asked.
  const choosing =
    !!status?.cloudflare.connected && (!status.cloudflare.account || changing);
  useEffect(() => {
    if (choosing && !accounts.length) void loadAccounts();
  }, [choosing]);
  async function removeSetup(provider: 'github' | 'cloudflare') {
    setBusy(true);
    setError('');
    try {
      await api(`/setup/${provider}`, { method: 'DELETE' });
      setNotice(
        `${provider === 'github' ? 'GitHub App' : 'Cloudflare OAuth client'} setup removed. Set it up again below.`,
      );
      await load();
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const keyMissing = setup?.available && !setup.encryption && (
    <div className="connection-state">
      <ShieldCheck size={18} />
      <div>
        <strong>Add an encryption key first</strong>
        <p>
          Add <code>TOKEN_ENCRYPTION_KEY</code> to <code>.dev.vars</code> (
          <code>npm run dev</code> creates one) and restart Shipcel.
        </p>
      </div>
    </div>
  );
  async function loadAccounts() {
    setBusy(true);
    setError('');
    try {
      const data = await api<{
        accounts: { id: string; name: string }[];
        nextPage: number | null;
      }>(`/connections/cloudflare/accounts?page=${nextPage || 1}`);
      setAccounts((prev) => [
        ...prev,
        ...data.accounts.filter((a) => !prev.some((p) => p.id === a.id)),
      ]);
      setNextPage(data.nextPage);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function chooseAccount() {
    setBusy(true);
    setError('');
    try {
      await api('/connections/cloudflare/account', {
        method: 'POST',
        body: JSON.stringify({ accountId: selected }),
      });
      await load();
      setChanging(false);
      setNotice('Cloudflare account selected.');
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(provider: 'github' | 'cloudflare') {
    setBusy(true);
    setError('');
    try {
      const data = await api<{ notice: string }>(`/connections/${provider}`, {
        method: 'DELETE',
      });
      setNotice(data.notice);
      setConfirm(null);
      await load();
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const steps = [
    { label: 'GitHub connected', done: githubConnected },
    {
      label: 'Cloudflare connected, with an account to deploy to',
      done: !!accountId,
    },
    // Without GitHub Actions, pushes deploy through Cloudflare's own builds.
    ...(actions
      ? []
      : [
          {
            label: 'Cloudflare can read your repositories',
            done:
              !!access?.accounts.length &&
              access.accounts.every((a) => a.readable !== false),
          },
          { label: 'Build token', done: !!tokens?.length },
        ]),
  ];
  const left = steps.filter((step) => !step.done).length;
  return (
    <>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="connection-notice" role="status">
          {notice}
        </div>
      )}
      <div className="connection-grid">
        <section className="panel connection-card">
          <div className="connection-top">
            <div className="connection-logo">
              <GitBranch size={28} />
            </div>
            <span className="badge">
              {status?.github.connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <h2>GitHub</h2>
          <p>
            Sign in with GitHub and choose the repositories Shipcel may deploy,
            in one visit to GitHub.
          </p>
          <div className="connection-capabilities">
            <span>
              <Check size={14} />
              Selected repository access
            </span>
            <span>
              <Check size={14} />
              Server-side encrypted credentials
            </span>
            <span>
              <Check size={14} />
              Adds a deploy workflow when you ask
            </span>
          </div>
          {status?.github.configured ? (
            <div className="integration-actions">
              <a className="button primary" href="/api/auth/github/start">
                <GitBranch size={15} />
                {status.github.connected
                  ? 'Reauthorize GitHub'
                  : 'Connect GitHub'}
              </a>
              {status.github.connected && status.github.installUrl && (
                <a className="button secondary" href={status.github.installUrl}>
                  Change repositories
                  <ArrowUpRight size={14} />
                </a>
              )}
            </div>
          ) : setup?.available ? (
            keyMissing || <GitHubSetup busy={busy} />
          ) : (
            <div className="connection-state">
              <ShieldCheck size={18} />
              <div>
                <strong>GitHub App registration required</strong>
                <p>
                  The integration is implemented. Configure the App client ID,
                  client secret, and app slug on the server to activate it.
                </p>
              </div>
            </div>
          )}
          {status?.github.connected && !actions && (
            <CloudflareGitHubAccess
              check={access}
              error={accessError}
              checking={access === null}
              onCheck={() => void checkAccess()}
            />
          )}
          {status?.github.connected && (
            <button
              className="text-link disconnect-link"
              onClick={() => setConfirm('github')}
            >
              <Unplug size={14} />
              Disconnect GitHub access
            </button>
          )}
          {setup?.github.source === 'setup' && (
            <p className="field-hint">
              Signs in with{' '}
              {setup.github.url ? (
                <a href={setup.github.url} target="_blank" rel="noreferrer">
                  {setup.github.name ?? 'your GitHub App'}
                </a>
              ) : (
                (setup.github.name ?? 'your GitHub App')
              )}
              .{' '}
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => void removeSetup('github')}
              >
                Remove this setup
              </button>
            </p>
          )}
        </section>
        <section className="panel connection-card">
          <div className="connection-top">
            <div className="connection-logo cloudflare">
              <Cloud size={29} />
            </div>
            <span className="badge">
              {status?.cloudflare.connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <h2>Cloudflare</h2>
          <p>
            Your account, infrastructure, and bill. Shipcel handles the
            deployment workflow.
          </p>
          <div className="connection-capabilities">
            <span>
              <Check size={14} />
              OAuth with scoped access
            </span>
            <span>
              <Check size={14} />
              Explicit account selection
            </span>
            <span>
              <Check size={14} />
              Apps run in your own account
            </span>
          </div>
          {status?.cloudflare.configured ? (
            <a
              className="button primary"
              href="/api/auth/cloudflare/start"
              aria-disabled={session?.user?.local || !session?.user}
              onClick={(e) => {
                if (session?.user?.local || !session?.user) {
                  e.preventDefault();
                  setError('Sign in with GitHub before connecting Cloudflare.');
                }
              }}
            >
              <Cloud size={16} />
              {status.cloudflare.connected
                ? 'Reauthorize Cloudflare'
                : 'Connect Cloudflare'}
            </a>
          ) : setup?.available ? (
            keyMissing || (
              <CloudflareSetup
                setup={setup}
                onDone={async (text) => {
                  setNotice(text);
                  await load();
                }}
              />
            )
          ) : (
            <div className="connection-state">
              <ShieldCheck size={18} />
              <div>
                <strong>Cloudflare OAuth registration required</strong>
                <p>
                  Register the OAuth client and configure its credentials and
                  approved scopes on the server. No API key is requested from
                  customers.
                </p>
              </div>
            </div>
          )}
          {status?.cloudflare.configured &&
            !status.cloudflare.connected &&
            (session?.user?.local || !session?.user) && (
              <p className="field-hint">
                Connect GitHub first: Cloudflare connects to the workspace you
                sign in to.
              </p>
            )}
          {setup?.cloudflare.source === 'setup' &&
            !!setup.cloudflare.outdated?.length && (
              <CloudflareUpdate
                onDone={async (text) => {
                  setNotice(text);
                  await load();
                }}
              />
            )}
          {setup?.cloudflare.source === 'env' &&
            !!setup.cloudflare.outdated?.length && (
              <p className="field-hint">
                Add workers-scripts.write (Workers Scripts Write) to the OAuth
                client and to CLOUDFLARE_OAUTH_SCOPES: Workers Editor can’t
                create Workers.
              </p>
            )}
          {setup?.cloudflare.source === 'setup' && (
            <p className="field-hint">
              Signs in with {setup.cloudflare.name ?? 'your OAuth client'} (
              {setup.cloudflare.scopes.length} permissions).{' '}
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => void removeSetup('cloudflare')}
              >
                Remove this setup
              </button>
            </p>
          )}
          {status?.cloudflare.connected && (
            <div className="account-picker">
              {status.cloudflare.account && !changing ? (
                <p>
                  Deploying to <strong>{status.cloudflare.account.name}</strong>
                  .{' '}
                  <button
                    className="text-link"
                    onClick={() => setChanging(true)}
                  >
                    Change account
                  </button>
                </p>
              ) : (
                <>
                  <label className="field-label" htmlFor="cf-account">
                    Deployment account
                  </label>
                  {accounts.length ? (
                    <>
                      <select
                        id="cf-account"
                        className="text-input"
                        value={selected}
                        onChange={(e) => setSelected(e.target.value)}
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
                          disabled={busy || !selected}
                          onClick={() => void chooseAccount()}
                        >
                          Use this account
                        </button>
                        {nextPage !== null && (
                          <button
                            className="button secondary"
                            onClick={() => void loadAccounts()}
                            disabled={busy}
                          >
                            Load more accounts
                          </button>
                        )}
                      </div>
                    </>
                  ) : busy || !error ? (
                    <p className="field-hint" role="status">
                      Loading your Cloudflare accounts…
                    </p>
                  ) : (
                    <button
                      className="button secondary"
                      onClick={() => void loadAccounts()}
                    >
                      Load your Cloudflare accounts
                    </button>
                  )}
                </>
              )}
              {status.cloudflare.account && !actions && (
                <BuildTokenSetup
                  tokens={tokens}
                  error={tokenError}
                  onReload={loadTokens}
                />
              )}
              <button
                className="text-link disconnect-link"
                onClick={() => setConfirm('cloudflare')}
              >
                <Unplug size={14} />
                Disconnect Cloudflare access
              </button>
            </div>
          )}
        </section>
      </div>
      {confirm && (
        <section className="panel disconnect-confirm">
          <h3>Disconnect {confirm === 'github' ? 'GitHub' : 'Cloudflare'}?</h3>
          <p>
            This removes Shipcel's stored credentials and stops pending Shipcel
            operations. Running apps, GitHub Actions workflows and Cloudflare
            build triggers stay where they are. Revoke the upstream grant in the
            provider dashboard to remove all provider access.
          </p>
          <div className="integration-actions">
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void disconnect(confirm)}
            >
              Disconnect access
            </button>
            <button
              className="button secondary"
              onClick={() => setConfirm(null)}
            >
              Keep connected
            </button>
          </div>
        </section>
      )}
      {session?.user?.local && (
        <details className="panel integration-setup">
          <summary className="panel-heading">
            <h2>For whoever runs this Shipcel: one-time platform setup</h2>
          </summary>
          <div className="detail-panel-content">
            <p>
              Set up GitHub and Cloudflare sign-in above: Shipcel creates the
              GitHub App and the Cloudflare OAuth client for you and keeps their
              secrets encrypted on this computer. A hosted Shipcel takes them
              from its environment instead; see{' '}
              <code>docs/provider-setup.md</code>.
            </p>
            <ol>
              <li>
                Enable GitHub sign-in and install the App on your selected
                repositories.
              </li>
              <li>
                Authorize Cloudflare and choose the account that will own your
                applications.
              </li>
              <li>
                Deploy each project from your computer with{' '}
                <code>shipcel deploy</code>. GitHub Actions can’t reach a
                Shipcel on your own computer, so pushes deploy through
                Cloudflare’s own builds: their GitHub app and build token are
                set up on the cards above.
              </li>
            </ol>
            <p>
              Resource creation, framework and container adapters, and branch
              previews are tested with provider fixtures and dry runs only;
              verify them in a test account before customers rely on them.
            </p>
            <a
              className="text-link"
              href="https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/"
              target="_blank"
              rel="noreferrer"
            >
              Cloudflare build setup
              <ArrowUpRight size={14} />
            </a>
          </div>
        </details>
      )}
      <section
        className="panel integration-setup"
        aria-labelledby="deploy-ready"
      >
        <div className="panel-heading">
          <h2 id="deploy-ready">Deploying from GitHub</h2>
          <span className="badge">
            {left ? `${left} ${left === 1 ? 'step' : 'steps'} left` : 'Ready'}
          </span>
        </div>
        <div className="detail-panel-content">
          <ul className="setup-checklist">
            {steps.map((step) => (
              <li key={step.label} className={step.done ? 'done' : ''}>
                {step.done ? (
                  <Check size={14} aria-hidden />
                ) : (
                  <span className="todo-mark" aria-hidden />
                )}
                {step.label}
                <span className="sr-only">
                  {step.done ? ': done' : ': to do'}
                </span>
              </li>
            ))}
          </ul>
          <p>
            {actions
              ? left
                ? 'Each step is done once. Then connect a project’s repository on its Deployments tab: Shipcel adds a GitHub Actions workflow, and every push deploys.'
                : 'Connect a project’s repository on its Deployments tab: Shipcel adds a GitHub Actions workflow, and every push deploys.'
              : left
                ? 'Each step is done once. After that, every project deploys from its Deployments tab with one click, and pushes to its production branch deploy by themselves.'
                : 'Open a project’s Deployments tab and deploy: pushes to its production branch deploy by themselves.'}
          </p>
        </div>
      </section>
      {actions && githubConnected && accountId && (
        <details
          className="panel integration-setup setup-manual"
          onToggle={(e) => setBuildsOpen(e.currentTarget.open)}
        >
          <summary>Cloudflare’s own builds (optional)</summary>
          <p className="field-hint">
            Only for apps GitHub Actions can’t deploy yet: containers, queues,
            routes and Python packages. Cloudflare then builds them itself, with
            its own GitHub app and a build token, each set up once.
          </p>
          <CloudflareGitHubAccess
            check={access}
            error={accessError}
            checking={access === null}
            onCheck={() => void checkAccess()}
          />
          <BuildTokenSetup
            tokens={tokens}
            error={tokenError}
            onReload={loadTokens}
          />
        </details>
      )}
    </>
  );
}

export function DeploymentPanel({
  project,
  onRefresh,
}: {
  project: Project;
  onRefresh: () => Promise<void>;
}) {
  const [connections, setConnections] = useState<ConnectionStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The repository inspected or being chosen, as owner/name.
  const [selected, setSelected] = useState('');
  // The repository list shows for a project without one, or after "Change repository".
  const [picking, setPicking] = useState(false);
  const [inspection, setInspection] = useState<RepositoryInspection | null>(
    null,
  );
  const [resourceConsent, setResourceConsent] = useState(false);
  const [containerConsent, setContainerConsent] = useState(false);
  // undefined: not loaded (the server checks again); null: the account has none yet.
  const [subdomain, setSubdomain] = useState<string | null | undefined>();
  const [claimName, setClaimName] = useState('');
  const [appName, setAppName] = useState(project.name);
  // null: still loading.
  const [tokens, setTokens] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const [tokenError, setTokenError] = useState('');
  const [buildToken, setBuildToken] = useState('');
  // Whether Cloudflare's own GitHub app can read the inspected repository.
  const [repoAccess, setRepoAccess] = useState<{
    connectUrl: string;
    account: GitHubAccess;
  } | null>(null);
  const [consent, setConsent] = useState(false);
  const [jobs, setJobs] = useState<Deployment[]>([]);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  // Cloudflare's own builds: what they need loads once their section opens.
  const [buildsOpen, setBuildsOpen] = useState(false);
  // The repository chosen when the project was created, or linked before.
  const saved =
    /^https:\/\/github\.com\/([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      project.repository,
    )?.[1] ?? '';
  async function recoverJob(id: string) {
    try {
      const updated = await api<Deployment>(`/deployments/${id}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
    } catch (e) {
      // The server records why recovery stopped on the deployment itself.
      setJobs(await api<Deployment[]>(`/projects/${project.id}/deployments`));
      throw e;
    }
  }
  async function refreshJob(id: string) {
    const updated = await api<Deployment>(`/deployments/${id}/refresh`, {
      method: 'POST',
    });
    setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
  }
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<ConnectionStatus>('/connections'),
      api<Deployment[]>(`/projects/${project.id}/deployments`),
    ])
      .then(([c, j]) => {
        if (alive) {
          setConnections(c);
          setJobs(j);
          setLoaded(true);
        }
        if (c.cloudflare.account)
          void api<{ subdomain: string | null }>(
            '/connections/cloudflare/subdomain',
          )
            .then((r) => {
              if (alive) setSubdomain(r.subdomain);
            })
            .catch(() => undefined);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [project.id]);
  const running = jobs.find((j) =>
    ['queued', 'provisioning', 'building'].includes(j.status),
  );
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const timer = setTimeout(() => {
      void api<Deployment>(`/deployments/${running.id}/refresh`, {
        method: 'POST',
      })
        .then((j) => {
          if (alive)
            setJobs((prev) =>
              prev.map((item) => (item.id === j.id ? j : item)),
            );
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }, 5000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [running]);
  // GitHub Actions deploys pushes when GitHub can reach this Shipcel; otherwise (a Shipcel on
  // someone's own computer) Cloudflare's own builds do.
  const actions = !!connections?.githubActions;
  // A repository on another Git host deploys the project instead of GitHub.
  const [gitSource, setGitSource] = useState<GitSourceLink | null>(null);
  // Before the first deployment, everything Cloudflare's builds need loads by itself (with
  // GitHub Actions, once they are opened): the saved repository is inspected and the build
  // tokens listed.
  const fresh = loaded && !jobs.some((j) => j.environment !== 'preview');
  const ready = fresh && (!actions || buildsOpen);
  const autoInspect = useRef(true);
  useEffect(() => {
    if (!ready || !connections?.github.connected || !autoInspect.current)
      return;
    autoInspect.current = false;
    if (saved)
      void action(async () => {
        try {
          await inspect(saved);
        } catch (e) {
          setPicking(true);
          throw e;
        }
      });
    // Runs once, when the panel is ready; inspect and action are recreated every render.
  }, [ready, connections, saved]);
  const accountId = connections?.cloudflare.account?.id;
  useEffect(() => {
    if (!ready || !accountId) return;
    let alive = true;
    void loadTokens(() => alive);
    return () => {
      alive = false;
    };
  }, [ready, accountId]);
  const inspected = inspection?.repository;
  useEffect(() => {
    setRepoAccess(null);
    if (inspected && accountId && connections?.github.connected)
      void checkRepoAccess();
    // checkRepoAccess is recreated every render; the repository and account decide.
  }, [inspected, accountId]);
  const unreadable = repoAccess?.account.readable === false;
  useEffect(() => {
    if (!unreadable) return;
    const again = () => void checkRepoAccess();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [unreadable]);
  async function action(work: () => Promise<void>) {
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
  async function inspect(repository: string) {
    setSelected(repository);
    setInspection(null);
    const data = await api<NonNullable<typeof inspection>>(
      `/projects/${project.id}/repository`,
      { method: 'POST', body: JSON.stringify({ repository }) },
    );
    setInspection(data);
    setPicking(false);
    setConsent(false);
    setResourceConsent(false);
    setContainerConsent(false);
    // The project now names this repository.
    if (data.repository !== saved) await onRefresh();
  }
  async function loadTokens(alive = () => true) {
    setTokenError('');
    try {
      const list = await api<{ id: string; name: string }[]>(
        '/connections/cloudflare/build-tokens',
      );
      if (!alive()) return;
      setTokens(list);
      // A single token is the obvious choice.
      setBuildToken((prev) =>
        list.some((t) => t.id === prev)
          ? prev
          : list.length === 1
            ? list[0].id
            : '',
      );
    } catch (e) {
      if (alive()) setTokenError((e as Error).message);
    }
  }
  async function checkRepoAccess() {
    if (!inspection) return;
    try {
      const check = await api<GitHubAccessCheck>(
        `/connections/cloudflare/github?repository=${encodeURIComponent(inspection.repository)}`,
      );
      setRepoAccess(
        check.accounts[0]
          ? { connectUrl: check.connectUrl, account: check.accounts[0] }
          : null,
      );
    } catch {
      // Not knowing doesn't stop a deploy: the pipeline reports what Cloudflare says.
      setRepoAccess(null);
    }
  }
  async function launch() {
    const result = await api<Deployment>(
      `/projects/${project.id}/deployments`,
      {
        method: 'POST',
        body: JSON.stringify({
          buildTokenId: buildToken,
          idempotencyKey: requestKey,
          confirmCharges: consent,
          inspectedCommit: inspection?.commit,
          confirmResources: resourceConsent,
          confirmContainers: containerConsent,
          // Adapters that keep the configured name (inspection.workerName) choose it themselves.
          workerName: inspection?.workerName ? undefined : appName,
        }),
      },
    );
    setJobs([result]);
    capture('repository_deployment_started', {
      adapter: result.adapter,
      has_resources: Boolean(inspection?.resources?.length),
      has_containers: Boolean(inspection?.containers?.length),
    });
    setRequestKey(crypto.randomUUID());
  }
  const renderJob = (job: Deployment) => (
    <div className="deployment-record" key={job.id}>
      <div className="deployment-record-top">
        <strong>{job.repository_name}</strong>
        <span className={`badge ${job.status === 'deployed' ? 'green' : ''}`}>
          {job.status.replaceAll('_', ' ')}
        </span>
      </div>
      <p>
        {job.branch}, {job.worker_name}
      </p>
      <div className="deployment-step">
        {['queued', 'provisioning', 'building'].includes(job.status) && (
          <LoaderCircle size={15} className="spin" />
        )}
        {stepLabel(job.step)}
      </div>
      {!!job.resources?.length && (
        <ul className="resource-list" aria-label="Deployment resources">
          {job.resources.map((resource) => {
            const observed = job.observedResources?.find(
              (o) => o.type === resource.type && o.binding === resource.binding,
            );
            return (
              <li key={`${resource.type}:${resource.binding}`}>
                {resourceLabels[resource.type]}, {resource.binding},{' '}
                {observed
                  ? observed.id
                  : ['queued', 'provisioning', 'building'].includes(job.status)
                    ? 'pending'
                    : 'not bound'}
              </li>
            );
          })}
        </ul>
      )}
      {job.error && <div className="inline-error">{job.error}</div>}
      {job.recovery_note && <p className="field-hint">{job.recovery_note}</p>}
      {job.adapter === 'container' &&
        job.step === 'health_check' &&
        job.status === 'building' && (
          <p className="field-hint">
            Cloudflare is starting the container. A first deployment can take
            several minutes; Shipcel keeps checking for up to 15 minutes.
          </p>
        )}
      {job.status === 'needs_attention' && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            setConfirming({
              title: 'Resume this deployment?',
              text: (
                <p>
                  Shipcel checks what Cloudflare already created for this
                  deployment and continues from where it stopped. It adopts what
                  exists and repeats a request only after Cloudflare shows that
                  it did not take effect. The plan and resources you approved
                  for{' '}
                  {job.commit_sha
                    ? `commit ${job.commit_sha.slice(0, 7)}`
                    : 'the reviewed commit'}{' '}
                  stay the same; your current GitHub and Cloudflare connections
                  must still reach the same repository and account.
                </p>
              ),
              action: () => recoverJob(job.id),
            })
          }
        >
          <RefreshCw size={14} />
          Check Cloudflare and resume
        </button>
      )}
      {job.live_url && (
        <a
          className="button primary"
          href={job.live_url}
          target="_blank"
          rel="noreferrer"
        >
          Open deployed app
          <ArrowUpRight size={15} />
        </a>
      )}
      <a
        className="text-link"
        href={`https://dash.cloudflare.com/${job.account_id}/workers/services/view/${job.worker_name}/production`}
        target="_blank"
        rel="noreferrer"
      >
        Build logs & future deployments
        <ArrowUpRight size={14} />
      </a>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => void action(() => refreshJob(job.id))}
      >
        <RefreshCw size={14} />
        Refresh status
      </button>
      {job.trigger_uuid && job.environment !== 'preview' && (
        <p className="field-hint">
          Pushes to {job.branch} now use the native Cloudflare trigger. Open
          Manage for build history, or Cloudflare for detailed logs.
        </p>
      )}
    </div>
  );
  const productionJobs = jobs.filter((j) => j.environment !== 'preview');
  // Next.js and container repositories deploy under their configured name.
  const fixedName = inspection?.workerName;
  const addressName = fixedName ?? appName;
  const freeAddress = subdomain
    ? `https://${addressName}.${subdomain}.workers.dev`
    : null;
  // Branch previews: Git projects with a deployed production pipeline.
  const previewsSection = productionJobs[0]?.status === 'deployed' &&
    productionJobs[0].adapter !== 'direct-upload' && (
      <BranchPreviews projectId={project.id} />
    );
  const uploaded = productionJobs[0]?.adapter === 'direct-upload';
  const reloadJobs = async () => {
    setJobs(await api<Deployment[]>(`/projects/${project.id}/deployments`));
    await onRefresh();
  };
  // Cloudflare's own builds keep a project they deploy. Every other project deploys from
  // GitHub with GitHub Actions, which uploads like a deploy from a computer does, so the
  // upload panel lists its deploys; one without any deployment can still choose
  // Cloudflare's builds. Without GitHub Actions, a project deploys from GitHub through
  // Cloudflare's builds or by upload. The upload panel keeps its place so its state survives
  // the switch after a first upload.
  const builtByCloudflare = !!productionJobs.length && !uploaded;
  // Built only where it shows: its jobs are Cloudflare's, never an upload's.
  const cloudflareBuilds = () => (
    <section className="panel deployment-panel">
      <div className="panel-heading">
        <h2>
          <Zap size={17} />
          GitHub deployments
        </h2>
        <span className="badge">Cloudflare native builds</span>
      </div>
      <div className="detail-panel-content">
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {confirming && (
          <ConfirmOperation
            value={confirming}
            busy={busy}
            onCancel={() => setConfirming(null)}
            onConfirm={() =>
              void action(async () => {
                try {
                  await confirming.action();
                } finally {
                  setConfirming(null);
                }
              })
            }
          />
        )}
        {productionJobs.length ? (
          <>
            {productionJobs.map(renderJob)}
            {previewsSection}
          </>
        ) : (
          <>
            <p>
              Import a repository, review its configuration, and create a native
              deployment pipeline in your Cloudflare account. Future pushes to
              its default branch are built by Cloudflare.
            </p>
            {!connections?.github.connected ? (
              <div className="setup-required">
                <GitBranch size={21} />
                <div>
                  <strong>Connect GitHub to choose a repository</strong>
                  <p>
                    Shipcel only sees repositories granted to its GitHub App.
                  </p>
                </div>
                <a className="button secondary" href="#connections">
                  Connections
                  <ArrowRight size={14} />
                </a>
              </div>
            ) : (
              <div className="repo-import">
                <span className="field-label">1. Repository</span>
                {picking || (!saved && !inspection) ? (
                  <RepositoryPicker
                    value={selected}
                    installUrl={connections.github.installUrl}
                    disabled={busy}
                    onChange={(name) => {
                      setSelected(name);
                      setInspection(null);
                      if (name) void action(() => inspect(name));
                    }}
                  />
                ) : (
                  <div className="chosen-repository">
                    <GitBranch size={16} />
                    <strong>{selected || saved}</strong>
                    {busy && !inspection && (
                      <span role="status">
                        <LoaderCircle size={14} className="spin" />
                        Checking the repository…
                      </span>
                    )}
                    <button
                      className="text-link"
                      disabled={busy}
                      onClick={() => setPicking(true)}
                    >
                      Change repository
                    </button>
                  </div>
                )}
                {picking && busy && !inspection && selected && (
                  <p className="field-hint" role="status">
                    Checking {selected}…
                  </p>
                )}
              </div>
            )}
            {inspection && (
              <div className="repository-inspection">
                <h3>
                  {inspection.ready
                    ? 'Repository configuration is ready'
                    : 'Repository needs configuration'}
                </h3>
                <p>
                  {inspection.repository}, {inspection.branch},{' '}
                  {inspection.commit.slice(0, 7)}
                </p>
                {inspection.adapter && (
                  <p>
                    Adapter:{' '}
                    {inspection.site
                      ? `Static site (${inspection.site.preset}), no Wrangler configuration needed`
                      : (adapterLabels[inspection.adapter] ??
                        inspection.adapter)}
                  </p>
                )}
                {inspection.site && (
                  <p>
                    {inspection.buildCommand
                      ? `Builds with ${inspection.buildCommand}, then serves `
                      : 'Serves '}
                    {inspection.site.directory === '.'
                      ? 'the repository’s files'
                      : `${inspection.site.directory}/`}{' '}
                    as{' '}
                    {inspection.site.spa
                      ? 'a single-page app.'
                      : 'a static site.'}
                  </p>
                )}
                {!!inspection.resources?.length && (
                  <div className="resource-review">
                    <h4>Resources to create</h4>
                    <ul>
                      {inspection.resources.map((resource) => (
                        <li key={`${resource.type}:${resource.binding}`}>
                          {resourceLabels[resource.type]}, {resource.binding}
                          {resource.source === 'adapter' &&
                            ', framework adapter default'}
                        </li>
                      ))}
                    </ul>
                    <label className="deploy-consent">
                      <input
                        type="checkbox"
                        checked={resourceConsent}
                        onChange={(e) => setResourceConsent(e.target.checked)}
                      />
                      <span>
                        Create the listed resources in my selected account with
                        this deployment. I understand Wrangler names them after
                        the deployed Worker, migrations need a separate review,
                        and usage may incur charges.
                      </span>
                    </label>
                  </div>
                )}
                {!!inspection.containers?.length && (
                  <div className="resource-review">
                    <h4 id="container-review">Containers to deploy</h4>
                    <ul aria-labelledby="container-review">
                      {inspection.containers.map((container) => (
                        <li key={container.className}>
                          {container.className}, {container.images.join(', ')},{' '}
                          {container.policy === 'durable_object'
                            ? 'started by its Durable Object (beta)'
                            : `${container.instanceType} instances, up to ${container.maxInstances} at once`}
                        </li>
                      ))}
                    </ul>
                    <label className="deploy-consent">
                      <input
                        type="checkbox"
                        checked={containerConsent}
                        onChange={(e) => setContainerConsent(e.target.checked)}
                      />
                      <span>
                        Deploy these containers as {inspection.workerName}. I
                        understand containers need the Workers Paid plan and
                        Cloudflare bills their usage to my account.
                      </span>
                    </label>
                  </div>
                )}
                {inspection.warnings?.map((warning) => (
                  <p className="field-hint" key={warning}>
                    {warning}
                  </p>
                ))}
                {inspection.issues.length > 0 && (
                  <ul>
                    {inspection.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(() => inspect(inspection.repository))
                  }
                >
                  <RefreshCw size={14} />
                  Check again
                </button>
              </div>
            )}
            <div className="deployment-controls">
              <span className="field-label">
                2. Cloudflare account and build token
              </span>
              {connections?.cloudflare.account ? (
                <>
                  <p>
                    Account:{' '}
                    <strong>{connections.cloudflare.account.name}</strong>
                  </p>
                  {tokenError ? (
                    <div className="inline-error" role="alert">
                      Cloudflare didn’t list the build tokens: {tokenError}{' '}
                      <button
                        className="text-link"
                        onClick={() => void loadTokens()}
                      >
                        Try again
                      </button>
                    </div>
                  ) : tokens === null ? (
                    <p className="field-hint" role="status">
                      <LoaderCircle size={13} className="spin" /> Loading build
                      tokens…
                    </p>
                  ) : tokens.length ? (
                    <label className="field-label">
                      Build token
                      <select
                        className="text-input"
                        value={buildToken}
                        onChange={(e) => setBuildToken(e.target.value)}
                      >
                        <option value="">Choose a build token</option>
                        {tokens.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p>
                      Cloudflare needs a build token first: add it once on{' '}
                      <a className="text-link" href="#connections">
                        Connections
                      </a>
                      , then{' '}
                      <button
                        className="text-link"
                        onClick={() => void loadTokens()}
                      >
                        check for build tokens
                      </button>
                      .
                    </p>
                  )}
                  {unreadable && repoAccess && (
                    <p className="setup-warning" role="status">
                      Cloudflare can’t read {repoAccess.account.repository} yet,
                      so it couldn’t build it. Open Cloudflare’s Create
                      application page below, then <ConnectSteps /> Already
                      connected? Include this repository on GitHub.{' '}
                      <a
                        className="text-link"
                        href={repoAccess.connectUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Connect GitHub in Cloudflare
                        <ArrowUpRight size={14} />
                      </a>{' '}
                      <a
                        className="text-link"
                        href={repoAccess.account.repositoriesUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Repository access on GitHub
                        <ArrowUpRight size={14} />
                      </a>{' '}
                      <button
                        className="text-link"
                        onClick={() => void checkRepoAccess()}
                      >
                        Check again
                      </button>
                    </p>
                  )}
                  <p className="field-hint">
                    Cloudflare builds your repository with a build token. Only
                    token names and IDs are shown here.
                  </p>
                </>
              ) : (
                <a className="text-link" href="#connections">
                  Connect Cloudflare and select an account
                  <ArrowRight size={14} />
                </a>
              )}
              <label className="field-label" htmlFor="app-name">
                3. Choose the app's free address
              </label>
              {subdomain === null ? (
                <div className="address-claim">
                  <p>
                    This Cloudflare account has no workers.dev subdomain yet.
                    Claim one for free: every app you deploy gets an address
                    under it, with no domain to buy.
                  </p>
                  <div className="address-input">
                    <input
                      className="text-input"
                      aria-label="workers.dev subdomain"
                      value={claimName}
                      placeholder="your-name"
                      onChange={(e) =>
                        setClaimName(e.target.value.trim().toLowerCase())
                      }
                    />
                    <span>.workers.dev</span>
                  </div>
                  <button
                    className="button secondary"
                    disabled={busy || !dnsLabel.test(claimName)}
                    onClick={() =>
                      setConfirming({
                        title: `Claim ${claimName}.workers.dev?`,
                        text: 'Cloudflare registers this subdomain for your whole account, so every Worker’s free address uses it. Changing it later moves all of those addresses.',
                        action: async () => {
                          const claimed = await api<{ subdomain: string }>(
                            '/connections/cloudflare/subdomain',
                            {
                              method: 'POST',
                              body: JSON.stringify({
                                subdomain: claimName,
                                confirm: true,
                              }),
                            },
                          );
                          setSubdomain(claimed.subdomain);
                        },
                      })
                    }
                  >
                    Claim {claimName || 'your-name'}.workers.dev
                  </button>
                </div>
              ) : (
                <>
                  {fixedName ? (
                    <p>
                      This repository deploys as <strong>{fixedName}</strong>,
                      the name in its Wrangler configuration.
                    </p>
                  ) : (
                    <div className="address-input">
                      <span>https://</span>
                      <input
                        id="app-name"
                        className="text-input"
                        aria-label="App name"
                        aria-invalid={!dnsLabel.test(appName)}
                        value={appName}
                        onChange={(e) =>
                          setAppName(e.target.value.trim().toLowerCase())
                        }
                      />
                      <span>.{subdomain ?? 'your-subdomain'}.workers.dev</span>
                    </div>
                  )}
                  {!dnsLabel.test(addressName) && (
                    <p className="inline-error">
                      Use 1 to 63 lowercase letters, numbers, and hyphens,
                      starting and ending with a letter or number.
                    </p>
                  )}
                  {freeAddress && (
                    <p>
                      Your app will be live at <code>{freeAddress}</code>
                    </p>
                  )}
                  <p className="field-hint">
                    Free on Cloudflare’s workers.dev, with no domain to buy. Add
                    your own domain later in Manage → Domains. Cloudflare treats
                    workers.dev addresses as free sites for personal and hobby
                    projects; use your own domain for business-critical apps.
                  </p>
                </>
              )}
              <label className="deploy-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  Create a new Worker and an automatic production build trigger
                  in my selected account. I trust this repository and understand
                  that Cloudflare usage and builds may incur charges.
                </span>
              </label>
              <button
                className="button primary"
                disabled={
                  busy ||
                  !inspection?.ready ||
                  !buildToken ||
                  !consent ||
                  !connections?.nativeBuildsEnabled ||
                  (!!inspection?.resources?.length && !resourceConsent) ||
                  (!!inspection?.containers?.length && !containerConsent) ||
                  subdomain === null ||
                  !dnsLabel.test(addressName)
                }
                onClick={() => void action(launch)}
              >
                <Zap size={16} />
                {busy ? 'Preparing deployment…' : 'Deploy repository'}
              </button>
              {!connections?.nativeBuildsEnabled && (
                <p className="field-hint">
                  Automatic deployments are not enabled for this workspace yet.
                  See Connections for setup status.
                </p>
              )}
            </div>
            <div className="native-scope">
              <ShieldCheck size={16} />
              <p>
                Current adapters: npm repositories with root-level Wrangler
                JSON/JSONC for Workers or Assets; Astro, SvelteKit, and Next.js
                (OpenNext) repositories with their Cloudflare adapter committed;
                Python Workers; and Container Workers built from a Dockerfile in
                the repository. Draft D1, R2, and KV bindings and containers are
                deployed only after you review them. Cloudflare’s GitHub App
                must be installed.
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
  return (
    <>
      <GitSource project={project} onChange={setGitSource} />
      {actions && !builtByCloudflare && !gitSource && (
        <GitHubDeploy
          project={project}
          connections={connections}
          onLinked={onRefresh}
        />
      )}
      {(builtByCloudflare || (!actions && !uploaded)) && cloudflareBuilds()}
      {actions && !productionJobs.length && (
        <details
          className="setup-manual cloudflare-builds"
          onToggle={(e) => setBuildsOpen(e.currentTarget.open)}
        >
          <summary>
            Build with Cloudflare instead, for containers, queues, routes and
            Python packages
          </summary>
          {cloudflareBuilds()}
        </details>
      )}
      {(uploaded || !productionJobs.length) && (
        <DirectUpload
          project={project}
          job={uploaded ? productionJobs[0] : null}
          onDeployed={reloadJobs}
        />
      )}
    </>
  );
}

export function PlanPanel() {
  const [plan, setPlan] = useState<{
    name: string;
    price: number;
    projectLimit: number;
    pipelineLimit: number | null;
    projects: number;
    pipelines: number;
    concurrentSetups: number;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<NonNullable<typeof plan>>('/plan')
      .then(setPlan)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="plan-layout">
      <section className="panel plan-card">
        <span className="badge green">Current plan</span>
        <h2>Free</h2>
        <div className="plan-price">
          $0<span> / month for Shipcel</span>
        </div>
        <p>Shipcel adds no limits below Cloudflare’s free plan.</p>
        <ul>
          <li>
            <Check size={15} />
            Up to {plan?.projectLimit ?? 100} projects, as many Workers as
            Cloudflare’s free plan allows
          </li>
          <li>
            <Check size={15} />
            No monthly limit on deployments
          </li>
          <li>
            <Check size={15} />
            One deployment set up at a time, like Cloudflare’s single free build
          </li>
          <li>
            <Check size={15} />
            Starter kits to download
          </li>
          <li>
            <Check size={15} />A deploy on every push to GitHub
          </li>
          <li>
            <Check size={15} />
            Your own Cloudflare account, and its bill
          </li>
        </ul>
      </section>
      <section className="panel plan-usage">
        <div className="panel-heading">
          <h2>Workspace usage</h2>
        </div>
        <div className="detail-panel-content">
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="usage-row">
            <span>Projects</span>
            <strong>
              {plan?.projects ?? '—'} / {plan?.projectLimit ?? 100}
            </strong>
          </div>
          <div className="usage-row">
            <span>Deployments set up this month</span>
            <strong>{plan?.pipelines ?? '—'}</strong>
          </div>
          <p>
            Shipcel’s Free plan has no subscription charge. Your apps run on
            your Cloudflare account’s plan: on Workers Free, Cloudflare stops
            serving requests over a daily limit until it resets instead of
            charging you. Workers Paid starts at $5 a month per account.
          </p>
          <p>
            Builds run on GitHub Actions or Cloudflare’s own builds, within the
            free minutes of your GitHub and Cloudflare plans. Shipcel has no
            paid plans.
          </p>
          <a className="text-link" href="/pricing/">
            Everything Cloudflare’s free plan includes
            <ArrowRight size={14} />
          </a>
        </div>
      </section>
    </div>
  );
}
