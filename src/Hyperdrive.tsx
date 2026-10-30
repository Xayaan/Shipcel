import { useEffect, useState } from 'react';
import { DatabaseZap, Trash2 } from 'lucide-react';
import { api } from './api';
import type { Confirmation } from './Operations';

type Config = {
  id: string;
  binding: string;
  scheme: 'postgres' | 'mysql';
  host: string;
  database: string;
  createdAt: number;
  snippet: string;
};
type Shared = {
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  confirm: (value: Confirmation) => void;
  notice: (text: string) => void;
};

// Manage → Database → Postgres and MySQL: databases hosted elsewhere that the app reaches
// through Hyperdrive (worker/hyperdrive.ts). A connection string becomes a configuration in
// the customer's account; the password goes to Cloudflare only, so nothing here shows it again.
export function HyperdrivePanel({
  root,
  busy,
  action,
  confirm,
  notice,
}: Shared & { root: string }) {
  const [configs, setConfigs] = useState<Config[] | null>(null),
    [binding, setBinding] = useState('DB'),
    [connectionString, setConnectionString] = useState('');
  useEffect(() => {
    setConfigs(null);
    api<{ configs: Config[] }>(`${root}/hyperdrive`)
      .then((data) => setConfigs(data.configs))
      .catch(() => setConfigs([]));
  }, [root]);
  const add = () =>
    action(async () => {
      const made = await api<Config>(`${root}/hyperdrive`, {
        method: 'POST',
        body: JSON.stringify({ binding, connectionString, confirm: true }),
      });
      setConnectionString('');
      setConfigs((prev) => [...(prev ?? []), made]);
      notice(
        `Added ${made.binding}. Put the snippet in the Wrangler configuration and deploy.`,
      );
    });
  const remove = (c: Config) =>
    confirm({
      title: `Remove ${c.binding}?`,
      text: `The Hyperdrive configuration for ${c.host}/${c.database} is deleted from your Cloudflare account; the database itself stays where it is hosted. Take the binding out of the Wrangler configuration before the next deploy.`,
      action: async () => {
        await api(`${root}/hyperdrive/${encodeURIComponent(c.id)}`, {
          method: 'DELETE',
        });
        setConfigs((prev) => (prev ?? []).filter((x) => x.id !== c.id));
        notice(`Removed ${c.binding}.`);
      },
    });
  const copy = (snippet: string) =>
    void navigator.clipboard
      .writeText(snippet)
      .then(() => notice('Snippet copied.'))
      .catch(() =>
        notice('Clipboard unavailable. Select the snippet to copy it.'),
      );
  return (
    <section className="panel operation-body">
      <div className="operation-title">
        <h2>
          <DatabaseZap size={17} />
          Postgres and MySQL
        </h2>
      </div>
      <p>
        Cloudflare doesn’t host Postgres or MySQL; Hyperdrive pools and caches
        connections from your Worker to a database hosted anywhere (Neon,
        Supabase, PlanetScale, your own server). The connection string goes to
        Cloudflare only; Shipcel keeps the binding, host and database name. Free
        up to 100,000 queries a day; unlimited on Workers Paid.
      </p>
      {configs === null ? (
        <p className="field-hint">Loading…</p>
      ) : configs.length === 0 ? (
        <p className="field-hint">No Postgres or MySQL database yet.</p>
      ) : (
        <ul className="resource-list">
          {configs.map((c) => (
            <li key={c.id}>
              <strong>{c.binding}</strong>, {c.scheme} at {c.host}/{c.database}
              <br />
              <code>{c.snippet}</code>{' '}
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => copy(c.snippet)}
              >
                Copy
              </button>{' '}
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => remove(c)}
              >
                <Trash2 size={14} /> Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label className="field-label">
          Binding
          <input
            value={binding}
            onChange={(e) => setBinding(e.target.value.toUpperCase())}
            pattern="[A-Z][A-Z0-9_]{0,63}"
            required
          />
        </label>
        <label className="field-label">
          Connection string
          <input
            type="password"
            value={connectionString}
            onChange={(e) => setConnectionString(e.target.value)}
            placeholder="postgres://user:password@host:5432/database"
            autoComplete="off"
            required
          />
        </label>
        <p className="field-hint">
          postgres:// or mysql://, with the user, password, host and database
          name. Then put the snippet in wrangler.json(c), beside the other
          bindings, and deploy; your code reads env.{binding || 'DB'}
          .connectionString.
        </p>
        <button
          type="submit"
          className="button primary"
          disabled={busy || !connectionString}
        >
          Add database
        </button>
      </form>
    </section>
  );
}
