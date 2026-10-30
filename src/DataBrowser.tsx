import { useEffect, useState } from 'react';
import { Table2 } from 'lucide-react';
import { api } from './api';
import type { Confirmation } from './Operations';

type Column = { name: string; type: string; primaryKey: boolean };
type Page = {
  table: string;
  offset: number;
  columns: Column[];
  rows: Record<string, unknown>[];
  nextOffset: number | null;
};
type Result = {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  meta: {
    changes: number | null;
    rowsRead: number | null;
    rowsWritten: number | null;
  };
};
// SELECT and EXPLAIN alone run at once; the server checks this again.
const readOnly = (sql: string) => {
  const statement = sql.trim().replace(/;\s*$/, '');
  return /^(select|explain)\b/i.test(statement) && !statement.includes(';');
};
const cell = (value: unknown) => {
  if (value === null || value === undefined)
    return <span className="null-value">NULL</span>;
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

function Rows({
  label,
  columns,
  rows,
}: {
  label: string;
  columns: string[];
  rows: Record<string, unknown>[];
}) {
  // Wide tables scroll inside their own focusable region, never the page.
  return (
    <div className="result-table" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th scope="col" key={c}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{cell(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Manage → Database → Data: browse D1 tables and run SQL. Changes are confirmed, and
// Shipcel records a Time Travel restore point before each one.
export function DataBrowser({
  root,
  busy,
  environment,
  action,
  confirm,
}: {
  root: string;
  busy: boolean;
  environment: 'production' | 'preview';
  action: (work: () => Promise<void>) => Promise<void>;
  confirm: (value: Confirmation) => void;
}) {
  const [bindings, setBindings] = useState<string[] | null>(null),
    [binding, setBinding] = useState(''),
    [tables, setTables] = useState<{ name: string; type: string }[] | null>(
      null,
    ),
    [page, setPage] = useState<Page | null>(null),
    [sql, setSql] = useState(''),
    [result, setResult] = useState<Result | null>(null);
  const base = `${root}/databases/${encodeURIComponent(binding)}`;

  useEffect(() => {
    void action(async () => {
      const cloud = await api<{ bindings: { name: string; type: string }[] }>(
        `${root}/cloud`,
      );
      const names = cloud.bindings
        .filter((b) => b.type === 'd1')
        .map((b) => b.name);
      setBindings(names);
      setBinding(names[0] ?? '');
    });
  }, [root]);
  async function loadTables() {
    setTables(
      (
        await api<{ tables: { name: string; type: string }[] }>(
          `${base}/tables?environment=${environment}`,
        )
      ).tables,
    );
  }
  useEffect(() => {
    if (!binding) return;
    setTables(null);
    setPage(null);
    setResult(null);
    void action(loadTables);
  }, [binding, environment]);
  async function browse(table: string, offset: number) {
    const data = await api<Omit<Page, 'table' | 'offset'>>(
      `${base}/tables/${encodeURIComponent(table)}?environment=${environment}&offset=${offset}`,
    );
    setPage({ table, offset, ...data });
  }
  async function run() {
    const statement = sql.trim();
    if (readOnly(statement)) {
      setResult(
        await api<Result>(`${base}/query`, {
          method: 'POST',
          body: JSON.stringify({ sql: statement, environment }),
        }),
      );
      return;
    }
    confirm({
      title:
        environment === 'preview'
          ? 'Run this SQL on the previews’ staging copy?'
          : 'Run this SQL on the production database?',
      text: (
        <>
          <pre className="snippet">{statement}</pre>
          It can change or delete data. Shipcel records a Time Travel restore
          point first; restore it from Restore points to undo this.
        </>
      ),
      action: async () => {
        const data = await api<{
          status: string;
          error?: string;
          result?: Result;
        }>(`${base}/query`, {
          method: 'POST',
          body: JSON.stringify({
            sql: statement,
            environment,
            requestId: crypto.randomUUID(),
            confirm: true,
          }),
        });
        if (data.status !== 'succeeded' || !data.result)
          throw new Error(
            data.error || 'This change needs review in Cloudflare.',
          );
        setResult(data.result);
        await loadTables();
        if (page) await browse(page.table, page.offset);
      },
    });
  }

  if (bindings !== null && !bindings.length)
    return (
      <section className="panel operation-body">
        <h2>Data</h2>
        <p className="operation-empty">No D1 database is bound to this app.</p>
      </section>
    );
  return (
    <section className="panel operation-body data-browser">
      <div className="operation-title">
        <h2>
          <Table2 size={18} aria-hidden="true" /> Data
        </h2>
        {bindings && bindings.length > 1 && (
          <label className="field-label">
            Database
            <select
              className="text-input"
              value={binding}
              disabled={busy}
              onChange={(e) => setBinding(e.target.value)}
            >
              {bindings.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p>
        Browse {binding || 'your database'}
        {environment === 'preview' ? ' (the previews’ staging copy)' : ''} and
        run SQL. SELECT queries run at once; anything else asks first and
        records a restore point.
      </p>
      {tables && (
        <div className="table-list" aria-label="Tables">
          {tables.length ? (
            tables.map((t) => (
              <button
                key={t.name}
                type="button"
                className={`button ${page?.table === t.name ? 'primary' : 'secondary'}`}
                aria-pressed={page?.table === t.name}
                disabled={busy}
                onClick={() => void action(() => browse(t.name, 0))}
              >
                {t.name}
                {t.type === 'view' ? ' (view)' : ''}
              </button>
            ))
          ) : (
            <p className="operation-empty">No tables yet.</p>
          )}
        </div>
      )}
      {page && (
        <>
          <p className="field-hint">
            {page.table}:{' '}
            {page.rows.length
              ? `rows ${page.offset + 1}–${page.offset + page.rows.length}`
              : 'no rows'}{' '}
            ,{' '}
            {page.columns
              .map(
                (c) =>
                  `${c.name}${c.type ? ` ${c.type}` : ''}${c.primaryKey ? ' (key)' : ''}`,
              )
              .join(', ')}
          </p>
          {page.rows.length > 0 && (
            <Rows
              label={`Rows of ${page.table}`}
              columns={page.columns.map((c) => c.name)}
              rows={page.rows}
            />
          )}
          {(page.offset > 0 || page.nextOffset !== null) && (
            <div className="integration-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy || page.offset === 0}
                onClick={() =>
                  void action(() =>
                    browse(page.table, Math.max(0, page.offset - 50)),
                  )
                }
              >
                Previous rows
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy || page.nextOffset === null}
                onClick={() =>
                  void action(() => browse(page.table, page.nextOffset!))
                }
              >
                Next rows
              </button>
            </div>
          )}
        </>
      )}
      <form
        className="operation-form stacked"
        onSubmit={(e) => {
          e.preventDefault();
          void action(run);
        }}
      >
        <label className="field-label">
          SQL
          <textarea
            className="text-input sql-input"
            rows={4}
            value={sql}
            spellCheck={false}
            placeholder="SELECT * FROM notes LIMIT 10"
            onChange={(e) => setSql(e.target.value)}
          />
        </label>
        <button
          className="button primary"
          disabled={busy || !binding || !sql.trim()}
        >
          Run
        </button>
      </form>
      {result && (
        <>
          <p className="field-hint" role="status">
            {[
              result.meta.changes
                ? `${result.meta.changes} rows changed`
                : null,
              result.meta.rowsRead !== null
                ? `${result.meta.rowsRead} rows read`
                : null,
              result.truncated ? 'showing the first 200 rows' : null,
            ]
              .filter(Boolean)
              .join(', ') || 'Done.'}
          </p>
          {result.columns.length > 0 && (
            <Rows
              label="Query results"
              columns={result.columns}
              rows={result.rows}
            />
          )}
        </>
      )}
    </section>
  );
}
