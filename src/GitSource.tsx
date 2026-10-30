import { useEffect, useState } from 'react';
import { ArrowUpRight, GitBranch, Unplug } from 'lucide-react';
import { api } from './api';
import { ConfirmOperation, type Confirmation } from './Operations';
import type { Project } from '../shared/catalog';

// A repository on GitLab, Bitbucket, Gitea or Forgejo, whose own CI deploys the project
// (worker/git-sources.ts). shipcel git connect links it and writes the CI file.
export type GitSourceLink = {
  provider: 'gitlab' | 'bitbucket' | 'gitea';
  host: string;
  repository: string;
  branch: string;
  signIn: 'id-token' | 'deploy-token';
  url: string;
};
const names = { gitlab: 'GitLab', bitbucket: 'Bitbucket', gitea: 'Gitea' };
const files = {
  gitlab: '.gitlab-ci.yml',
  bitbucket: 'bitbucket-pipelines.yml',
  gitea: '.gitea/workflows/shipcel.yml',
};

export function GitSource({
  project,
  onChange,
}: {
  project: Project;
  // The repository linked, or null when there is none.
  onChange: (source: GitSourceLink | null) => void;
}) {
  const [source, setSource] = useState<GitSourceLink | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api<{ source: GitSourceLink | null }>(
      `/projects/${project.id}/git-source`,
    )
      .then(({ source: found }) => {
        if (!alive) return;
        setSource(found);
        onChange(found);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
    // onChange is the parent's state setter, the same on every render.
  }, [project.id]);
  if (!source)
    return error ? (
      <div className="inline-error" role="alert">
        {error}
      </div>
    ) : null;
  const name = names[source.provider];
  async function disconnect() {
    await api(`/projects/${project.id}/git-source`, { method: 'DELETE' });
    setSource(null);
    onChange(null);
  }
  return (
    <section className="panel deployment-panel" aria-labelledby="git-source">
      <div className="panel-heading">
        <h2 id="git-source">
          <GitBranch size={17} />
          Deploy from {name}
        </h2>
        <span className="badge green">Every push deploys</span>
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
            onConfirm={() => {
              setBusy(true);
              setError('');
              void confirming
                .action()
                .catch((e) => setError((e as Error).message))
                .finally(() => {
                  setBusy(false);
                  setConfirming(null);
                });
            }}
          />
        )}
        <p>
          {name}’s CI deploys{' '}
          <a
            className="text-link"
            href={source.url}
            target="_blank"
            rel="noreferrer"
          >
            {source.host}/{source.repository}
            <ArrowUpRight size={14} />
          </a>{' '}
          on every push: {source.branch} to production
          {source.signIn === 'id-token' ? ' while it is protected' : ''}, other
          branches as previews.{' '}
          {source.signIn === 'id-token'
            ? 'Its jobs sign in with GitLab’s own ID token, so the repository holds no secret.'
            : 'Its jobs sign in with a deploy token kept as SHIPCEL_TOKEN (shipcel tokens add --project makes one).'}
        </p>
        <button
          className="text-link disconnect-link"
          disabled={busy}
          onClick={() =>
            setConfirming({
              title: `Stop deploying ${source.repository}?`,
              text: `${name} jobs stop deploying ${project.name}. Shipcel changes nothing in the repository: delete ${files[source.provider]} there too.`,
              action: disconnect,
            })
          }
        >
          <Unplug size={14} />
          Disconnect repository
        </button>
      </div>
    </section>
  );
}
