import { useEffect, useState } from 'react';
import { Download, Folder, HardDrive, Trash2, Upload } from 'lucide-react';
import { api } from './api';
import type { Confirmation } from './Operations';

type Environment = 'production' | 'preview';
type Bound = {
  kv: { binding: string; id: string }[];
  r2: { binding: string; bucket: string; jurisdiction?: string }[];
};
type Store = { type: 'kv' | 'r2'; binding: string };
type Value = {
  key: string;
  text: string | null;
  size: number | null;
  truncated: boolean;
};
type StoredObject = {
  key: string;
  size: number | null;
  lastModified: string | null;
  contentType: string | null;
};
type Journaled = { status: string; error?: string };
type Shared = {
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  confirm: (value: Confirmation) => void;
  notice: (text: string) => void;
};
// The server enforces both limits again.
const MAX_UPLOAD = 25 * 1048576;
const sizeLabel = (n: number | null) =>
  n === null
    ? 'size unknown'
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
async function journaled(path: string, method: string, body: BodyInit) {
  const data = await api<Journaled>(path, { method, body });
  if (data.status !== 'succeeded')
    throw new Error(data.error || 'This change needs review in Cloudflare.');
}

// Manage → Storage: the KV namespaces and R2 buckets the app binds, or the previews' staging
// copies. Changes ask first; Operation history records which key changed, never the value.
export function StoragePanel({
  root,
  previews,
  ...shared
}: Shared & { root: string; previews: boolean }) {
  const { busy, action } = shared;
  const [environment, setEnvironment] = useState<Environment>('production'),
    [bound, setBound] = useState<Bound | null>(null),
    [store, setStore] = useState<Store | null>(null);
  useEffect(() => {
    setBound(null);
    setStore(null);
    void action(async () => {
      const data = await api<Bound>(
        `${root}/storage?environment=${environment}`,
      );
      setBound(data);
      setStore(
        data.kv[0]
          ? { type: 'kv', binding: data.kv[0].binding }
          : data.r2[0]
            ? { type: 'r2', binding: data.r2[0].binding }
            : null,
      );
    });
  }, [root, environment]);
  const stores: Store[] = bound
    ? [
        ...bound.kv.map((k) => ({ type: 'kv' as const, binding: k.binding })),
        ...bound.r2.map((b) => ({ type: 'r2' as const, binding: b.binding })),
      ]
    : [];
  const where = (binding: string) =>
    environment === 'preview' ? `the previews’ copy of ${binding}` : binding;
  return (
    <section className="panel operation-body storage">
      <div className="operation-title">
        <h2>
          <HardDrive size={18} aria-hidden="true" /> Storage
        </h2>
        {previews && (
          <label className="field-label">
            Environment
            <select
              className="text-input"
              value={environment}
              disabled={busy}
              onChange={(e) => setEnvironment(e.target.value as Environment)}
            >
              <option value="production">Production</option>
              <option value="preview">
                Previews (staging copies shared by all branch previews)
              </option>
            </select>
          </label>
        )}
      </div>
      <p>
        Browse the KV namespaces and R2 buckets{' '}
        {environment === 'preview'
          ? 'that branch previews use instead of production'
          : 'your app binds'}
        . Changes ask first and appear in Operation history, which records which
        key changed, never its value.
      </p>
      {bound && !stores.length && (
        <p className="operation-empty">
          No KV namespace or R2 bucket is bound to this app
          {environment === 'preview' ? '’s previews' : ''}.
        </p>
      )}
      {stores.length > 0 && (
        <div className="table-list" aria-label="Namespaces and buckets">
          {stores.map((s) => {
            const chosen =
              store?.type === s.type && store.binding === s.binding;
            return (
              <button
                key={`${s.type}:${s.binding}`}
                type="button"
                className={`button ${chosen ? 'primary' : 'secondary'}`}
                aria-pressed={chosen}
                disabled={busy}
                onClick={() => setStore(s)}
              >
                {s.binding}, {s.type === 'kv' ? 'KV' : 'R2'}
              </button>
            );
          })}
        </div>
      )}
      {store?.type === 'kv' && (
        <KvBrowser
          key={`${environment}:${store.binding}`}
          base={`${root}/storage/kv/${encodeURIComponent(store.binding)}`}
          environment={environment}
          where={where(store.binding)}
          {...shared}
        />
      )}
      {store?.type === 'r2' && (
        <R2Browser
          key={`${environment}:${store.binding}`}
          base={`${root}/storage/r2/${encodeURIComponent(store.binding)}`}
          binding={store.binding}
          environment={environment}
          where={where(store.binding)}
          {...shared}
        />
      )}
    </section>
  );
}

function KvBrowser({
  base,
  environment,
  where,
  busy,
  action,
  confirm,
  notice,
}: Shared & { base: string; environment: Environment; where: string }) {
  const [prefix, setPrefix] = useState(''),
    [keys, setKeys] = useState<
      { name: string; expiration: number | null }[] | null
    >(null),
    [cursor, setCursor] = useState<string | null>(null),
    [open, setOpen] = useState<Value | null>(null),
    [editing, setEditing] = useState<{
      key: string;
      value: string;
      adding: boolean;
    } | null>(null);
  async function list(more = false) {
    const query = new URLSearchParams({ environment, prefix });
    if (more && cursor) query.set('cursor', cursor);
    const data = await api<{
      keys: { name: string; expiration: number | null }[];
      cursor: string | null;
    }>(`${base}/keys?${query}`);
    setKeys((prev) => (more ? [...(prev ?? []), ...data.keys] : data.keys));
    setCursor(data.cursor);
  }
  useEffect(() => {
    void action(() => list());
  }, [base, environment]);
  async function show(key: string) {
    setEditing(null);
    setOpen(
      await api<Value>(
        `${base}/value?${new URLSearchParams({ environment, key })}`,
      ),
    );
  }
  const change = (method: string, body: Record<string, unknown>) =>
    journaled(
      `${base}/value`,
      method,
      JSON.stringify({
        ...body,
        environment,
        requestId: crypto.randomUUID(),
        confirm: true,
      }),
    );
  return (
    <div className="storage-browser">
      <form
        className="storage-search"
        onSubmit={(e) => {
          e.preventDefault();
          void action(() => list());
        }}
      >
        <label className="field-label">
          Key prefix
          <input
            className="text-input"
            value={prefix}
            placeholder="user:"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </label>
        <button className="button secondary" disabled={busy}>
          Search keys
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => {
            setOpen(null);
            setEditing({ key: '', value: '', adding: true });
          }}
        >
          Add a key
        </button>
      </form>
      {keys &&
        (keys.length ? (
          <div className="operation-list">
            {keys.map((k) => (
              <div className="operation-row" key={k.name}>
                <div>
                  <strong>{k.name}</strong>
                  {k.expiration && (
                    <p>
                      Expires {new Date(k.expiration * 1000).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="operation-badges">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    aria-label={`Open ${k.name}`}
                    onClick={() => void action(() => show(k.name))}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    aria-label={`Delete ${k.name}`}
                    onClick={() =>
                      confirm({
                        title: `Delete ${k.name} from ${where}?`,
                        text: 'The key and its value are removed for good. Other locations can keep serving the old value for up to a minute.',
                        action: async () => {
                          await change('DELETE', { key: k.name });
                          notice(`${k.name} was deleted.`);
                          setOpen((o) => (o?.key === k.name ? null : o));
                          await list();
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="operation-empty">
            {prefix
              ? 'No keys start with this prefix.'
              : 'This namespace has no keys yet.'}
          </p>
        ))}
      {cursor && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void action(() => list(true))}
        >
          Load more keys
        </button>
      )}
      {open && !editing && (
        <div className="storage-value" aria-label={`Value of ${open.key}`}>
          <h3>{open.key}</h3>
          {open.text !== null ? (
            <>
              <pre className="snippet">{open.text}</pre>
              {open.truncated && (
                <p className="field-hint">
                  Showing the first 64 KB
                  {open.size ? ` of ${sizeLabel(open.size)}` : ''}. Download the
                  value to see all of it.
                </p>
              )}
            </>
          ) : (
            <p className="field-hint">
              This value isn’t text
              {open.size !== null ? ` (${sizeLabel(open.size)})` : ''}. Download
              it to look inside.
            </p>
          )}
          <div className="integration-actions">
            {open.text !== null && !open.truncated && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  setEditing({
                    key: open.key,
                    value: open.text ?? '',
                    adding: false,
                  })
                }
              >
                Edit value
              </button>
            )}
            <a
              className="button secondary"
              href={`/api${base}/download?${new URLSearchParams({ environment, key: open.key })}`}
              download
            >
              <Download size={14} />
              Download
            </a>
          </div>
        </div>
      )}
      {editing && (
        <form
          className="operation-form stacked"
          onSubmit={(e) => {
            e.preventDefault();
            const { key, value } = editing;
            confirm({
              title: `Save ${key} in ${where}?`,
              text: 'This replaces any value stored under this key; its expiration and metadata stay as they are. Other locations can take up to a minute to see the change.',
              action: async () => {
                await change('PUT', { key, value });
                notice(`${key} was saved.`);
                setEditing(null);
                await list();
                await show(key);
              },
            });
          }}
        >
          <label className="field-label">
            Key
            <input
              className="text-input"
              required
              value={editing.key}
              readOnly={!editing.adding}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setEditing({ ...editing, key: e.target.value })}
            />
          </label>
          <label className="field-label">
            Value
            <textarea
              className="text-input sql-input"
              rows={8}
              value={editing.value}
              spellCheck={false}
              onChange={(e) =>
                setEditing({ ...editing, value: e.target.value })
              }
            />
          </label>
          <div className="integration-actions">
            <button
              className="button primary"
              disabled={busy || !editing.key.trim()}
            >
              Save
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function R2Browser({
  base,
  binding,
  environment,
  where,
  busy,
  action,
  confirm,
  notice,
}: Shared & {
  base: string;
  binding: string;
  environment: Environment;
  where: string;
}) {
  const [prefix, setPrefix] = useState(''),
    [listing, setListing] = useState<{
      objects: StoredObject[];
      folders: string[];
    } | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [file, setFile] = useState<File | null>(null),
    [key, setKey] = useState(''),
    // Changing it clears the file input after an upload.
    [picker, setPicker] = useState(0);
  async function list(at: string, more = false) {
    const query = new URLSearchParams({ environment, prefix: at });
    if (more && cursor) query.set('cursor', cursor);
    const data = await api<{
      objects: StoredObject[];
      folders: string[];
      cursor: string | null;
    }>(`${base}/objects?${query}`);
    setPrefix(at);
    setListing((prev) =>
      more && prev
        ? {
            objects: [...prev.objects, ...data.objects],
            folders: [...new Set([...prev.folders, ...data.folders])],
          }
        : data,
    );
    setCursor(data.cursor);
  }
  useEffect(() => {
    void action(() => list(''));
  }, [base, environment]);
  const parts = prefix.split('/').filter(Boolean);
  const download = (objectKey: string) =>
    `/api${base}/object?${new URLSearchParams({ environment, key: objectKey })}`;
  return (
    <div className="storage-browser">
      <nav className="storage-path" aria-label="Folder">
        <button
          type="button"
          className="text-link"
          disabled={busy || !prefix}
          onClick={() => void action(() => list(''))}
        >
          {binding}
        </button>
        {parts.map((part, i) => (
          <span key={i}>
            {' / '}
            <button
              type="button"
              className="text-link"
              disabled={busy || i === parts.length - 1}
              onClick={() =>
                void action(() => list(`${parts.slice(0, i + 1).join('/')}/`))
              }
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      {listing &&
        (listing.folders.length || listing.objects.length ? (
          <div className="operation-list">
            {listing.folders.map((folder) => (
              <div className="operation-row" key={folder}>
                <button
                  type="button"
                  className="text-link storage-folder"
                  disabled={busy}
                  onClick={() => void action(() => list(folder))}
                >
                  <Folder size={14} aria-hidden="true" />
                  {folder.slice(prefix.length)}
                </button>
              </div>
            ))}
            {listing.objects.map((o) => (
              <div className="operation-row" key={o.key}>
                <div>
                  <strong>{o.key.slice(prefix.length)}</strong>
                  <p>
                    {[
                      sizeLabel(o.size),
                      o.contentType,
                      o.lastModified &&
                        new Date(o.lastModified).toLocaleString(),
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                </div>
                <div className="operation-badges">
                  <a
                    className="button secondary"
                    href={download(o.key)}
                    download
                    aria-label={`Download ${o.key}`}
                  >
                    <Download size={14} />
                    Download
                  </a>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    aria-label={`Delete ${o.key}`}
                    onClick={() =>
                      confirm({
                        title: `Delete ${o.key} from ${where}?`,
                        text: 'The object is removed for good. R2 keeps no copy to restore.',
                        action: async () => {
                          await journaled(
                            `${base}/object`,
                            'DELETE',
                            JSON.stringify({
                              key: o.key,
                              environment,
                              requestId: crypto.randomUUID(),
                              confirm: true,
                            }),
                          );
                          notice(`${o.key} was deleted.`);
                          await list(prefix);
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="operation-empty">
            {prefix ? 'This folder is empty.' : 'This bucket is empty.'}
          </p>
        ))}
      {cursor && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void action(() => list(prefix, true))}
        >
          Load more
        </button>
      )}
      <form
        className="operation-form storage-upload"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return;
          const objectKey = key.trim();
          confirm({
            title: `Upload ${objectKey} to ${where}?`,
            text: `${file.name} (${sizeLabel(file.size)}) is stored under this key, replacing any object already there.`,
            action: async () => {
              const form = new FormData();
              form.set('key', objectKey);
              form.set('environment', environment);
              form.set('requestId', crypto.randomUUID());
              form.set('confirm', 'true');
              form.set('file', file);
              await journaled(`${base}/object`, 'PUT', form);
              notice(`${objectKey} was uploaded.`);
              setFile(null);
              setKey('');
              setPicker((n) => n + 1);
              await list(prefix);
            },
          });
        }}
      >
        <label className="field-label">
          File to upload
          <input
            key={picker}
            className="text-input"
            type="file"
            onChange={(e) => {
              const chosen = e.target.files?.[0] ?? null;
              setFile(chosen);
              if (chosen) setKey(`${prefix}${chosen.name}`);
            }}
          />
        </label>
        <label className="field-label">
          Key
          <input
            className="text-input"
            required
            value={key}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {file && file.size > MAX_UPLOAD && (
          <p className="field-hint" role="status">
            Files up to 25 MB can be uploaded here. Use Wrangler for larger
            ones.
          </p>
        )}
        <button
          className="button primary"
          disabled={busy || !file || !key.trim() || file.size > MAX_UPLOAD}
        >
          <Upload size={14} />
          Upload
        </button>
      </form>
    </div>
  );
}
