import { useEffect, useState } from 'react';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import { api } from './api';
import type { RepoChoice } from '../shared/integrations';

type Installation = { id: number; account: { login: string } };

// The repositories the person can deploy, loaded as soon as it shows: the GitHub accounts
// Shipcel's GitHub App is installed on, the first one chosen, and its repositories.
export function RepositoryPicker({
  value,
  onChange,
  installUrl,
  disabled,
}: {
  value: string;
  onChange: (fullName: string) => void;
  installUrl: string | null;
  disabled?: boolean;
}) {
  const [installations, setInstallations] = useState<Installation[] | null>(
      null,
    ),
    [installation, setInstallation] = useState(''),
    [repos, setRepos] = useState<RepoChoice[] | null>(null),
    [nextPage, setNextPage] = useState<number | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  async function load(id: string, page = 1) {
    const data = await api<{
      repositories: RepoChoice[];
      nextPage: number | null;
    }>(`/connections/github/repositories?installation=${id}&page=${page}`);
    return data;
  }
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await api<{ installations: Installation[] }>(
          '/connections/github/installations',
        );
        if (!alive) return;
        setInstallations(data.installations);
        const first = data.installations[0];
        if (!first) return;
        setInstallation(String(first.id));
        const page = await load(String(first.id));
        if (!alive) return;
        setRepos(page.repositories);
        setNextPage(page.nextPage);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
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
  const chooseRepositories = installUrl && (
    <a className="text-link" href={installUrl} target="_blank" rel="noreferrer">
      Choose which repositories Shipcel can see
      <ArrowUpRight size={13} />
    </a>
  );
  return (
    <div className="repository-picker">
      {installations === null && busy && (
        <p className="field-hint" role="status">
          <LoaderCircle size={13} className="spin" /> Loading your repositories…
        </p>
      )}
      {installations?.length === 0 && (
        <div className="setup-required">
          <div>
            <strong>Shipcel can’t see any repositories yet</strong>
            <p>
              Install its GitHub App on the repositories you want to deploy,
              then come back.
            </p>
          </div>
          {chooseRepositories}
        </div>
      )}
      {!!installations?.length && (
        <>
          <label className="field-label">
            GitHub account
            <select
              className="text-input"
              value={installation}
              disabled={disabled || busy}
              onChange={(e) => {
                const id = e.target.value;
                setInstallation(id);
                setRepos(null);
                onChange('');
                void run(async () => {
                  const page = await load(id);
                  setRepos(page.repositories);
                  setNextPage(page.nextPage);
                });
              }}
            >
              {installations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.account.login}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Repository
            <select
              className="text-input"
              value={value}
              disabled={disabled || !repos}
              onChange={(e) => onChange(e.target.value)}
            >
              <option value="">
                {repos ? 'Select a repository' : 'Loading repositories…'}
              </option>
              {repos?.map((r) => (
                <option key={r.id} value={r.fullName}>
                  {r.fullName}
                  {r.private ? ', private' : ''}
                </option>
              ))}
            </select>
          </label>
          {repos?.length === 0 && (
            <p className="field-hint">
              No repositories you can push to in this account.
            </p>
          )}
          {nextPage && (
            <button
              type="button"
              className="text-link"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const page = await load(installation, nextPage);
                  setRepos((prev) => [
                    ...(prev ?? []),
                    ...page.repositories.filter(
                      (r) => !prev?.some((p) => p.id === r.id),
                    ),
                  ]);
                  setNextPage(page.nextPage);
                })
              }
            >
              Load more repositories
            </button>
          )}
          {chooseRepositories && (
            <p className="field-hint">Missing one? {chooseRepositories}</p>
          )}
        </>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
