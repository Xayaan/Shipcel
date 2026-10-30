import { useEffect, useState } from 'react';
import { ExternalLink, GitPullRequest, RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api';
import { ConfirmOperation, type Confirmation } from './Operations';
import { CopyButton } from './Developers';
import './previews.css';

type Staging = {
  type: 'd1' | 'kv' | 'r2';
  binding: string;
  name: string;
  id: string;
};
type PreviewItem = {
  id: string;
  name: string;
  urls: string[];
  deployedOn: string | null;
  latest: null | {
    id: string;
    number: number | null;
    urls: string[];
    createdOn: string | null;
    commit: string | null;
    pullRequest: string | null;
  };
};
type State = {
  status:
    | 'off'
    | 'setting_up'
    | 'waiting_for_config'
    | 'active'
    | 'needs_attention'
    | 'disabled';
  error?: string | null;
  branch?: string;
  resources?: Staging[];
  snippet?: string;
  previews?: PreviewItem[] | null;
  previewsError?: string | null;
  builds?: {
    id: string;
    branch: string | null;
    outcome: string | null;
    status: string | null;
    createdAt: string | null;
  }[];
};
type Plan = {
  branch: string;
  resources: { type: Staging['type']; binding: string; name: string }[];
  warnings: string[];
  issues: string[];
  ready: boolean;
};
type Enabled = {
  result?: { status: State['status']; issues?: string[] };
};

const labels: Record<Staging['type'], string> = {
  d1: 'D1 database',
  kv: 'KV namespace',
  r2: 'R2 bucket',
};
const when = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : null;

// Branch and pull request previews (Cloudflare Worker Previews) for a project deployed
// from Git. Every push to another branch gets its own address; Cloudflare comments it on
// the pull request.
export function BranchPreviews({ projectId }: { projectId: string }) {
  const root = `/projects/${projectId}/previews`;
  const [state, setState] = useState<State | null>(null),
    [plan, setPlan] = useState<Plan | null>(null),
    [consent, setConsent] = useState(false),
    [issues, setIssues] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  async function load() {
    setState(await api<State>(root));
  }
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
  useEffect(() => {
    void run(load);
  }, [root]);
  async function turnOn() {
    const enabled = await api<Enabled>(root, {
      method: 'POST',
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        confirm: true,
        confirmResources: consent,
      }),
    });
    setIssues(enabled.result?.issues ?? []);
    setPlan(null);
    setConsent(false);
    await load();
  }

  if (!state)
    return (
      <section className="preview-section" aria-labelledby="previews-title">
        <h3 id="previews-title">Branch previews</h3>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="field-hint">Loading previews…</p>
        )}
      </section>
    );
  const review = (
    <>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setPlan(await api<Plan>(`${root}/plan`));
            setConsent(false);
          })
        }
      >
        Review preview setup
      </button>
      {plan && (
        <div className="resource-review">
          {plan.issues.map((issue) => (
            <p className="inline-error" key={issue}>
              {issue}
            </p>
          ))}
          {plan.resources.length > 0 && (
            <>
              <h4>Staging copies to create</h4>
              <p className="field-hint">
                Previews never use production data. Shipcel creates an empty
                copy of each of these for all branch previews to share.
              </p>
              <ul className="resource-list">
                {plan.resources.map((r) => (
                  <li key={`${r.type}:${r.binding}`}>
                    {labels[r.type]} {r.binding}: <code>{r.name}</code>
                  </li>
                ))}
              </ul>
              <label className="deploy-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  Create these staging copies in my Cloudflare account. They
                  start empty; usage beyond the free allowance may be billed.
                </span>
              </label>
            </>
          )}
          <ul className="resource-list">
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <button
            className="button primary"
            disabled={
              busy || !plan.ready || (plan.resources.length > 0 && !consent)
            }
            onClick={() => void run(turnOn)}
          >
            Turn on previews
          </button>
        </div>
      )}
    </>
  );
  const resources = state.resources ?? [];
  const staging = resources.length > 0 && (
    <div>
      <h4>Staging copies</h4>
      <ul className="resource-list">
        {resources.map((r) => (
          <li key={`${r.type}:${r.binding}`}>
            {labels[r.type]} {r.binding}: <code>{r.name}</code>
          </li>
        ))}
      </ul>
    </div>
  );
  const list = state.previews !== undefined && (
    <div className="preview-list">
      <div className="preview-list-heading">
        <h4>Previews</h4>
        <button
          className="text-link"
          disabled={busy}
          onClick={() => void run(load)}
        >
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </button>
      </div>
      {state.previewsError && (
        <p className="inline-error">{state.previewsError}</p>
      )}
      {state.previews?.length ? (
        <ul aria-label="Previews">
          {state.previews.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.name}</strong>
                {p.urls[0] && (
                  <a
                    className="text-link"
                    href={p.urls[0]}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.urls[0]} <ExternalLink size={12} aria-hidden="true" />
                  </a>
                )}
                <p className="field-hint">
                  {[
                    p.latest?.number ? `Deployment ${p.latest.number}` : null,
                    p.latest?.commit
                      ? `commit ${p.latest.commit.slice(0, 7)}`
                      : null,
                    when(p.latest?.createdOn ?? p.deployedOn),
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  {p.latest?.pullRequest && (
                    <>
                      {', '}
                      <a
                        className="text-link"
                        href={p.latest.pullRequest}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <GitPullRequest size={12} aria-hidden="true" /> Pull
                        request
                      </a>
                    </>
                  )}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={busy}
                aria-label={`Delete preview ${p.name}`}
                onClick={() =>
                  setConfirmation({
                    title: `Delete the preview ${p.name}?`,
                    text: 'Its addresses stop working. The branch is not changed, and while previews are on its next push creates the preview again.',
                    action: async () => {
                      await api(`${root}/${encodeURIComponent(p.id)}`, {
                        method: 'DELETE',
                        body: JSON.stringify({
                          requestId: crypto.randomUUID(),
                          confirm: true,
                        }),
                      });
                      await load();
                    },
                  })
                }
              >
                <Trash2 size={14} />
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !state.previewsError && (
          <p className="field-hint">
            No previews yet. Push a branch other than {state.branch}, or open a
            pull request from one.
          </p>
        )
      )}
      {state.builds && state.builds.length > 0 && (
        <>
          <h4>Recent preview builds</h4>
          <ul className="resource-list" aria-label="Recent preview builds">
            {state.builds.map((b) => (
              <li key={b.id}>
                {b.branch ?? 'Unknown branch'},{' '}
                {b.outcome ?? b.status ?? 'in progress'}
                {b.createdAt ? `, ${when(b.createdAt)}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );

  return (
    <section className="preview-section" aria-labelledby="previews-title">
      <h3 id="previews-title">Branch previews</h3>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {(state.status === 'off' || state.status === 'needs_attention') && (
        <>
          <p>
            Give every branch and pull request its own address. Cloudflare
            builds each push to a branch other than the production branch as a
            Preview of this app and comments its address on the pull request.
            Previews use separate staging copies of your databases, namespaces
            and buckets, never production data. Branch builds use your build
            token, so only trusted collaborators should push branches, and pull
            requests from forks get no preview.
          </p>
          {state.status === 'needs_attention' && state.error && (
            <p className="inline-error">
              Setup stopped: {state.error} Review it again to continue; Shipcel
              picks up where it stopped.
            </p>
          )}
          {review}
        </>
      )}
      {state.status === 'waiting_for_config' && state.snippet && (
        <>
          <p>
            One step left. Add these settings at the top level of{' '}
            <code>wrangler.json</code> (or <code>wrangler.jsonc</code>) on{' '}
            {state.branch}, push, then check again. Cloudflare fails every
            preview build without a <code>previews</code> block, and this one
            binds the staging copies, so previews never touch production data.
          </p>
          {issues.length > 0 && (
            <ul className="inline-error preview-issues">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          <div className="agent-snippet">
            <pre className="snippet">{state.snippet}</pre>
            <CopyButton
              text={state.snippet}
              label="Copy the previews settings"
            />
          </div>
          {staging}
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void run(turnOn)}
          >
            Check again and turn on
          </button>
          {review}
        </>
      )}
      {state.status === 'setting_up' && (
        <p className="field-hint">
          Setting up previews…{' '}
          <button
            className="text-link"
            disabled={busy}
            onClick={() => void run(load)}
          >
            Refresh
          </button>
        </p>
      )}
      {state.status === 'active' && (
        <>
          <p>
            Previews are on. Every push to a branch other than {state.branch}{' '}
            deploys that branch&apos;s preview, and Cloudflare comments its
            address on the pull request. Each deployment also keeps its own
            address. Preview addresses are public to anyone who has them unless
            you ask for sign-in in Manage → Domains.
          </p>
          {list}
          {staging}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              setConfirmation({
                title: 'Turn off branch previews?',
                text: 'Shipcel deletes the preview build trigger, so pushes stop creating previews. Existing previews keep their addresses until you delete them. The staging copies stay in your account, and Shipcel uses them again if you turn previews back on. Production is not affected.',
                action: async () => {
                  await api(root, {
                    method: 'DELETE',
                    body: JSON.stringify({
                      requestId: crypto.randomUUID(),
                      confirm: true,
                    }),
                  });
                  await load();
                },
              })
            }
          >
            Turn off previews
          </button>
        </>
      )}
      {state.status === 'disabled' && (
        <>
          <p>
            Previews are off: pushes don&apos;t create previews. Existing
            previews keep their addresses until you delete them.
          </p>
          {list}
          {staging}
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void run(turnOn)}
          >
            Turn previews back on
          </button>
        </>
      )}
      {confirmation && (
        <ConfirmOperation
          value={confirmation}
          busy={busy}
          onConfirm={() =>
            void run(async () => {
              try {
                await confirmation.action();
              } finally {
                setConfirmation(null);
              }
            })
          }
          onCancel={() => setConfirmation(null)}
        />
      )}
    </section>
  );
}
