import { useEffect, useState } from 'react';
import { api } from './api';
import type { Confirmation } from './Operations';

type Access = 'public' | 'signed-in' | 'owner' | 'none';
type Policy = {
  read: Access;
  write: Exclude<Access, 'public'>;
  owner?: string;
};
type View = {
  binding: string | null;
  databases: string[];
  tables: Record<string, Policy>;
  schema: Record<string, string[]>;
};

const who: Record<Access, string> = {
  public: 'Everyone',
  'signed-in': 'Signed-in users',
  owner: 'Each user, their own rows',
  none: 'No one',
};
const readers = Object.keys(who) as Access[];
const writers = readers.filter((a) => a !== 'public');
const usesOwner = (p: Policy) => p.read === 'owner' || p.write === 'owner';
// A change answers with the rows it reached, so no more people may change a table than read
// it, unless no one reads it (it then only takes new rows).
const reach: Record<Access, number> = {
  none: 0,
  owner: 1,
  'signed-in': 2,
  public: 3,
};
const tooBroad = (p: Policy) =>
  p.read !== 'none' && reach[p.write] > reach[p.read];

// Manage → Sign-in & realtime → Data API: which tables of the app's D1 database the service
// opens at /data/<table>, and who may read and change each (worker/backend.ts,
// services/backend/src/data.ts).
export function DataApiPanel({
  root,
  issuer,
  busy,
  action,
  mutate,
  confirm,
}: {
  root: string;
  issuer: string;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: string,
    body: Record<string, unknown>,
    success: string,
  ) => Promise<void>;
  confirm: (value: Confirmation) => void;
}) {
  const [view, setView] = useState<View | null>(null),
    [binding, setBinding] = useState(''),
    [draft, setDraft] = useState<Record<string, Policy>>({});
  async function load(chosen?: string) {
    const next = await api<View>(
      `${root}/backend/data${chosen ? `?binding=${encodeURIComponent(chosen)}` : ''}`,
    );
    const shown = chosen ?? next.binding ?? next.databases[0] ?? '';
    setView(next);
    setBinding(shown);
    // Another database's tables start closed.
    setDraft(shown === next.binding ? next.tables : {});
  }
  useEffect(() => {
    void action(() => load());
  }, [root]);
  const set = (table: string, policy: Policy | null) =>
    setDraft((prev) => ({
      ...Object.fromEntries(Object.entries(prev).filter(([t]) => t !== table)),
      ...(policy ? { [table]: policy } : {}),
    }));
  const opened = Object.entries(draft);
  const incomplete = opened.some(([, p]) => usesOwner(p) && !p.owner);
  const broad = opened.filter(([, p]) => tooBroad(p)).map(([t]) => t);
  const save = () =>
    confirm({
      title: opened.length
        ? `Open ${opened.length === 1 ? '1 table' : `${opened.length} tables`} to the data API?`
        : 'Close every table?',
      text: opened.length
        ? `${opened.map(([t, p]) => `${t}: read by ${who[p.read].toLowerCase()}, changed by ${who[p.write].toLowerCase()}`).join('; ')}. Your pages reach them at ${issuer}/data/<table>.${binding !== view?.binding ? ` The service Worker is deployed again with the ${binding} database.` : ''}`
        : 'No table is reachable through the data API until you open one again.',
      action: async () => {
        await mutate(
          '/backend/data',
          'PUT',
          { binding, tables: draft },
          'Data API saved.',
        );
        await load();
      },
    });
  const turnOff = () =>
    confirm({
      title: 'Turn the data API off?',
      text: `Every table closes, and the service Worker is deployed again without the ${view?.binding} database.`,
      action: async () => {
        await mutate(
          '/backend/data',
          'PUT',
          { binding: null, tables: {} },
          'Data API turned off.',
        );
        await load();
      },
    });

  return (
    <section className="panel operation-body">
      <div className="operation-title">
        <h2>Data API</h2>
        {view?.binding && <span className="badge green">On</span>}
      </div>
      <p>
        Your pages read and change rows of the app’s D1 database at{' '}
        <code>{issuer}/data/&lt;table&gt;</code>, sending the signed-in user’s
        access token. Only the tables opened here are reachable, each with who
        may read it and who may change it; “their own rows” are those whose
        owner column holds the user’s id. Each change goes out on realtime: on{' '}
        <code>public:data:&lt;table&gt;</code> or{' '}
        <code>signed-in:data:&lt;table&gt;</code>, or to the owner’s{' '}
        <code>user:&lt;id&gt;</code> channel.
      </p>
      {view && !view.databases.length && (
        <p className="field-hint">
          The app’s Worker has no D1 database bound. Deploy it with one first.
        </p>
      )}
      {view && view.databases.length > 0 && (
        <>
          {view.databases.length > 1 && (
            <label className="field-label">
              Database
              <select
                className="text-input"
                value={binding}
                disabled={busy}
                onChange={(e) => void action(() => load(e.target.value))}
              >
                {view.databases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!Object.keys(view.schema).length && (
            <p className="operation-empty">
              The {binding} database has no tables yet.
            </p>
          )}
          {Object.entries(view.schema).map(([table, columns]) => {
            const policy = draft[table];
            return (
              <fieldset className="event-choices data-table" key={table}>
                <legend>{table}</legend>
                <label className="deploy-consent">
                  <input
                    type="checkbox"
                    checked={Boolean(policy)}
                    disabled={busy}
                    onChange={(e) =>
                      set(
                        table,
                        e.target.checked
                          ? { read: 'signed-in', write: 'none' }
                          : null,
                      )
                    }
                  />
                  <span>Open to the data API</span>
                </label>
                {policy && (
                  <div className="operation-form">
                    <label className="field-label">
                      Who reads
                      <select
                        className="text-input"
                        value={policy.read}
                        disabled={busy}
                        onChange={(e) =>
                          set(table, {
                            ...policy,
                            read: e.target.value as Access,
                          })
                        }
                      >
                        {readers.map((a) => (
                          <option key={a} value={a}>
                            {who[a]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      Who changes
                      <select
                        className="text-input"
                        value={policy.write}
                        disabled={busy}
                        onChange={(e) =>
                          set(table, {
                            ...policy,
                            write: e.target.value as Policy['write'],
                          })
                        }
                      >
                        {writers.map((a) => (
                          <option key={a} value={a}>
                            {who[a]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      Owner column
                      <select
                        className="text-input"
                        value={policy.owner ?? ''}
                        disabled={busy}
                        onChange={(e) =>
                          set(table, {
                            ...policy,
                            owner: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">None</option>
                        {columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </fieldset>
            );
          })}
          {broad.length > 0 && (
            <p className="field-hint">
              {broad.join(', ')}: no more people may change a table than read
              it, since a change answers with the rows it reached.
            </p>
          )}
          {incomplete && (
            <p className="field-hint">
              Choose the owner column of each table whose rows only their owners
              read or change.
            </p>
          )}
          <div className="integration-actions">
            <button
              className="button primary"
              disabled={busy || incomplete || broad.length > 0 || !binding}
              onClick={save}
            >
              Save data API
            </button>
            {view.binding && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={turnOff}
              >
                Turn off
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
