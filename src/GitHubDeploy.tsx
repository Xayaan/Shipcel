import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  GitBranch,
  LoaderCircle,
  Unplug,
  Zap,
} from 'lucide-react';
import { api } from './api';
import { ConfirmOperation, type Confirmation } from './Operations';
import { RepositoryPicker } from './RepositoryPicker';
import type { ConnectionStatus } from '../shared/integrations';
import type { Project } from '../shared/catalog';

// Deploys from GitHub with GitHub Actions (worker/github-actions.ts): Shipcel adds a workflow
// to the repository, and every push builds on GitHub and deploys here. Nothing is set up in
// Cloudflare, and the repository holds no secret.
type Link = {
  repository: string;
  branch: string;
  linkedBy: string | null;
  actionsUrl: string;
  workflowUrl: string;
};
// The answer to connecting: the workflow added, one there already, or GitHub's refusal.
type Linked = Link &
  (
    | { workflow: 'added'; commitUrl: string }
    | { workflow: 'present' }
    | {
        workflow: 'refused';
        reason: string;
        addUrl: string;
        // GitHub's page for installing Shipcel's app, when that is what's missing.
        installUrl?: string;
      }
  );

export function GitHubDeploy({
  project,
  connections,
  onLinked,
}: {
  project: Project;
  // null: still loading.
  connections: ConnectionStatus | null;
  onLinked: () => Promise<void>;
}) {
  // undefined: loading. `workflow` is what Shipcel adds, shown before it does.
  const [state, setState] = useState<{ link: Link | null; workflow: string }>();
  const [linked, setLinked] = useState<Linked | null>(null);
  // The repository chosen when the project was created, or linked before.
  const saved =
    /^https:\/\/github\.com\/([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      project.repository,
    )?.[1] ?? '';
  const [selected, setSelected] = useState(saved);
  const [picking, setPicking] = useState(!saved);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  useEffect(() => {
    let alive = true;
    void api<NonNullable<typeof state>>(
      `/projects/${project.id}/github-actions`,
    )
      .then((data) => {
        if (alive) setState(data);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [project.id]);
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
  async function connect() {
    const result = await api<Linked>(`/projects/${project.id}/github-actions`, {
      method: 'POST',
      body: JSON.stringify({ repository: selected, confirm: true }),
    });
    setLinked(result);
    setState((prev) => prev && { ...prev, link: result });
    setConsent(false);
    await onLinked();
  }
  async function disconnect() {
    await api(`/projects/${project.id}/github-actions`, { method: 'DELETE' });
    setLinked(null);
    setState((prev) => prev && { ...prev, link: null });
  }
  const link = state?.link;
  const external = { target: '_blank', rel: 'noreferrer' } as const;
  return (
    <section className="panel deployment-panel" aria-labelledby="github-deploy">
      <div className="panel-heading">
        <h2 id="github-deploy">
          <GitBranch size={17} />
          Deploy from GitHub
        </h2>
        <span className={`badge ${link ? 'green' : ''}`}>
          {link ? 'Every push deploys' : 'GitHub Actions'}
        </span>
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
        {state === undefined ? (
          !error && (
            <p className="field-hint" role="status">
              <LoaderCircle size={13} className="spin" /> Loading…
            </p>
          )
        ) : link ? (
          <>
            <p>
              Every push to <strong>{link.repository}</strong> builds on GitHub
              and deploys here: <strong>{link.branch}</strong> to production,
              other branches as previews. Each deploy is listed below.
            </p>
            {linked?.workflow === 'added' && (
              <p className="setup-done">
                <Check size={14} />
                Shipcel added the workflow to {link.branch}, so GitHub is
                deploying it now.{' '}
                <a className="text-link" href={linked.commitUrl} {...external}>
                  The commit
                  <ArrowUpRight size={14} />
                </a>
              </p>
            )}
            {linked?.workflow === 'present' && (
              <p className="field-hint">
                The repository has .github/workflows/shipcel.yml already, so
                Shipcel kept it.
              </p>
            )}
            {linked?.workflow === 'refused' && (
              <div className="setup-warning" role="status">
                The workflow isn’t in the repository yet. {linked.reason}{' '}
                {linked.installUrl && (
                  <>
                    <a
                      className="text-link"
                      href={linked.installUrl}
                      {...external}
                    >
                      GitHub’s page for that
                      <ArrowUpRight size={14} />
                    </a>
                    , then{' '}
                    <button
                      type="button"
                      className="text-link"
                      disabled={busy}
                      onClick={() => void action(connect)}
                    >
                      connect again
                    </button>
                    .{' '}
                  </>
                )}
                <a className="text-link" href={linked.addUrl} {...external}>
                  Add it on GitHub
                  <ArrowUpRight size={14} />
                </a>{' '}
                opens GitHub’s page with the file filled in: commit it there, or
                propose it in a pull request.
              </div>
            )}
            <div className="integration-actions">
              <a
                className="button secondary"
                href={link.actionsUrl}
                {...external}
              >
                Runs on GitHub
                <ArrowUpRight size={14} />
              </a>
              <a className="text-link" href={link.workflowUrl} {...external}>
                The workflow
                <ArrowUpRight size={14} />
              </a>
            </div>
            <button
              className="text-link disconnect-link"
              disabled={busy}
              onClick={() =>
                setConfirming({
                  title: `Stop deploying ${link.repository}?`,
                  text: `Pushes to ${link.repository} stop deploying ${project.name}. Shipcel changes nothing in the repository: delete .github/workflows/shipcel.yml there too.`,
                  action: disconnect,
                })
              }
            >
              <Unplug size={14} />
              Disconnect repository
            </button>
          </>
        ) : !connections ? null : !connections.github.connected ? (
          <div className="setup-required">
            <GitBranch size={21} />
            <div>
              <strong>Connect GitHub to choose a repository</strong>
              <p>Shipcel only sees repositories granted to its GitHub App.</p>
            </div>
            <a className="button secondary" href="#connections">
              Connections
              <ArrowRight size={14} />
            </a>
          </div>
        ) : (
          <>
            <p>
              Shipcel adds a workflow to the repository: GitHub Actions builds
              every push and deploys it here, pushes to its default branch to
              production and other branches as previews. Nothing is set up in
              Cloudflare, and the repository holds no secret.
            </p>
            <div className="repo-import">
              <span className="field-label">Repository</span>
              {picking ? (
                <RepositoryPicker
                  value={selected}
                  installUrl={connections.github.installUrl}
                  disabled={busy}
                  onChange={(name) => {
                    setSelected(name);
                    setConsent(false);
                  }}
                />
              ) : (
                <div className="chosen-repository">
                  <GitBranch size={16} />
                  <strong>{selected}</strong>
                  <button
                    className="text-link"
                    disabled={busy}
                    onClick={() => setPicking(true)}
                  >
                    Change repository
                  </button>
                </div>
              )}
            </div>
            {!connections.cloudflare.account && (
              <p className="setup-warning" role="status">
                Its deploys go to your Cloudflare account: connect Cloudflare
                and choose an account on{' '}
                <a className="text-link" href="#connections">
                  Connections
                </a>{' '}
                first.
              </p>
            )}
            {state.workflow && (
              <details className="migration-sql">
                <summary>
                  What Shipcel adds: .github/workflows/shipcel.yml
                </summary>
                <pre>{state.workflow}</pre>
              </details>
            )}
            <label className="deploy-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                Add the workflow to {selected || 'the repository'}. I trust this
                repository: every push to it deploys into my Cloudflare account,
                and Cloudflare usage may incur charges.
              </span>
            </label>
            <button
              className="button primary"
              disabled={
                busy || !selected || !consent || !connections.cloudflare.account
              }
              onClick={() => void action(connect)}
            >
              <Zap size={16} />
              {busy ? 'Connecting…' : 'Connect repository'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
