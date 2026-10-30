import { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { api } from './api';
import { ConfirmOperation, type Confirmation } from './Operations';
import './developers.css';

type Variable = {
  name: string;
  updatedAt: number;
  projects: { id: string; name: string; current: boolean }[];
};
type Project = { id: string; name: string };
type Outcome = {
  projectId: string;
  status: 'set' | 'removed' | 'failed';
  error?: string;
};

// The most projects one change reaches (worker/shared-variables.ts).
const MAX_PROJECTS = 20;
const count = (n: number) => (n === 1 ? '1 project' : `${n} projects`);

// Shared variables: one secret on several of the workspace's projects at once.
export function SharedVariablesPanel() {
  const [variables, setVariables] = useState<Variable[] | null>(null),
    [projects, setProjects] = useState<Project[]>([]),
    [form, setForm] = useState<'new' | 'existing' | null>(null),
    [name, setName] = useState(''),
    [value, setValue] = useState(''),
    [chosen, setChosen] = useState<string[]>([]),
    [outcome, setOutcome] = useState<{
      name: string;
      results: Outcome[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  async function load() {
    const [listed, all] = await Promise.all([
      api<{ variables: Variable[] }>('/shared-variables'),
      api<Project[]>('/projects'),
    ]);
    setVariables(listed.variables);
    setProjects(all.map(({ id, name }) => ({ id, name })));
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
  }, []);
  const projectName = (id: string) =>
    projects.find((p) => p.id === id)?.name ?? id;
  const open = (variable?: Variable) => {
    setForm(variable ? 'existing' : 'new');
    setName(variable?.name ?? '');
    setValue('');
    setChosen(variable?.projects.map((p) => p.id) ?? []);
    setOutcome(null);
  };
  const share = () => {
    const leaving = (
      variables?.find((v) => v.name === name)?.projects ?? []
    ).filter((p) => !chosen.includes(p.id));
    setConfirmation({
      title: `Set ${name} on ${count(chosen.length)}?`,
      text: `${chosen.map(projectName).join(', ')} get the value now, in place of a secret of that name if one has it.${leaving.length ? ` It is removed from ${leaving.map((p) => p.name).join(', ')}.` : ''} Shipcel doesn’t keep the value.`,
      action: async () => {
        setOutcome(
          await api(`/shared-variables/${encodeURIComponent(name)}`, {
            method: 'PUT',
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              confirm: true,
              value,
              projectIds: chosen,
            }),
          }),
        );
        setValue('');
        setForm(null);
        await load();
      },
    });
  };
  const remove = (variable: Variable) =>
    setConfirmation({
      title: `Remove ${variable.name}?`,
      text: `It is removed from ${variable.projects.map((p) => p.name).join(', ') || 'every project'}, and code there that reads it stops finding it.`,
      action: async () => {
        setOutcome(
          await api(`/shared-variables/${encodeURIComponent(variable.name)}`, {
            method: 'DELETE',
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              confirm: true,
            }),
          }),
        );
        await load();
      },
    });

  return (
    <div className="developers">
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>
            <KeyRound size={17} aria-hidden="true" /> Variables
          </h2>
          {!form && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => open()}
            >
              Add a shared variable
            </button>
          )}
        </div>
        <p>
          A secret several of this workspace’s projects use, such as an API key,
          set on all of them at once. The value goes to each project’s Worker as
          a runtime secret and nowhere else: Shipcel keeps the name, so adding a
          project later asks for the value again.
        </p>
        {outcome && (
          <div className="operation-list" role="status">
            <h3>{outcome.name}</h3>
            <ul className="resource-list">
              {outcome.results.map((r) => (
                <li key={r.projectId}>
                  {projectName(r.projectId)}:{' '}
                  {r.status === 'failed'
                    ? `not changed. ${r.error ?? ''}`
                    : r.status}
                </li>
              ))}
            </ul>
          </div>
        )}
        {form && (
          <form
            className="operation-form stacked"
            onSubmit={(e) => {
              e.preventDefault();
              share();
            }}
          >
            <label className="field-label">
              Name
              <input
                className="text-input"
                required
                pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"
                readOnly={form === 'existing'}
                value={name}
                placeholder="API_KEY"
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field-label">
              Value
              <input
                className="text-input"
                type="password"
                required
                autoComplete="new-password"
                maxLength={4096}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <fieldset className="event-choices">
              <legend>Projects</legend>
              {projects.map((p) => (
                <label className="deploy-consent" key={p.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.id)}
                    onChange={(e) =>
                      setChosen(
                        e.target.checked
                          ? [...chosen, p.id]
                          : chosen.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <span>{p.name}</span>
                </label>
              ))}
            </fieldset>
            <p className="field-hint">
              Up to {MAX_PROJECTS} projects, each deployed at least once.
            </p>
            <div className="integration-actions">
              <button
                className="button primary"
                disabled={
                  busy ||
                  !name ||
                  !value ||
                  !chosen.length ||
                  chosen.length > MAX_PROJECTS
                }
              >
                Set on {count(chosen.length)}
              </button>
              <button
                type="button"
                className="text-link"
                onClick={() => setForm(null)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        <div className="operation-list">
          {variables?.length === 0 && (
            <p className="operation-empty">No shared variables yet.</p>
          )}
          {variables?.map((v) => (
            <div className="operation-row" key={v.name}>
              <div>
                <strong>{v.name}</strong>
                <p>
                  {v.projects
                    .map((p) =>
                      p.current ? p.name : `${p.name} (out of date)`,
                    )
                    .join(', ') || 'On no project'}
                </p>
                {v.projects.some((p) => !p.current) && (
                  <p className="field-hint">
                    A project out of date missed the last value. Set the value
                    again to send it.
                  </p>
                )}
              </div>
              <div className="integration-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  aria-label={`Set ${v.name}`}
                  onClick={() => open(v)}
                >
                  Set value
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  aria-label={`Remove ${v.name}`}
                  onClick={() => remove(v)}
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
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
    </div>
  );
}
