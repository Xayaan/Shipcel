import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  ExternalLink,
  FolderUp,
  Globe2,
  Lock,
  UploadCloud,
} from 'lucide-react';
import { api } from './api';
import { capture } from './posthog';
import { ConfirmOperation, type Confirmation } from './Operations';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_RULES_BYTES,
  MAX_WORKER_BYTES,
  assetHash,
  assetPathProblem,
  toBase64,
} from '../shared/assets';
import type { Project } from '../shared/catalog';
import './upload.css';

type Picked = { path: string; file: File };
type Prepared = Picked & { hash: string };
type UploadRow = {
  id: string;
  status: string;
  files: number;
  bytes: number;
  createdAt: number;
  versionId: string | null;
  url: string | null;
  previewUrl: string | null;
  published: boolean;
};
type Job = {
  live_url?: string | null;
  worker_name?: string;
  // An app with code or bindings, which Wrangler deploys from its folder.
  localAdapter?: string | null;
};
// What such an app is, by the adapter it was reviewed with.
const appKinds: Record<string, string> = {
  'configured-worker': 'a Worker with its own Wrangler configuration',
  nextjs: 'a Next.js app on OpenNext',
  astro: 'an Astro app with its Cloudflare adapter',
  sveltekit: 'a SvelteKit app with its Cloudflare adapter',
  python: 'a Python Worker',
};
type Result = {
  workerName: string;
  versionId: string;
  previewUrl: string | null;
  url: string | null;
  published: boolean;
};

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// Folders a build never needs to serve.
const skipped = (path: string) =>
  /(^|\/)(node_modules|\.git)(\/|$)/.test(path) || /\/\.DS_Store$/.test(path);

// Reads every file under a dropped folder (DataTransfer entries are read in batches).
async function readEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: Picked[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ path: `${prefix}/${entry.name}`, file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return;
    for (const child of batch)
      await readEntry(child, `${prefix}/${entry.name}`, out);
  }
}

// A single dropped or chosen folder is the site root: dist/index.html is served at /.
function rooted(picked: Picked[]) {
  const tops = new Set(picked.map((p) => p.path.split('/')[1]));
  const single =
    tops.size === 1 && picked.every((p) => p.path.split('/').length > 2);
  return picked.map((p) => ({
    ...p,
    path: single ? `/${p.path.split('/').slice(2).join('/')}` : p.path,
  }));
}

export function DirectUpload({
  project,
  job,
  onDeployed,
}: {
  project: Project;
  job: Job | null;
  onDeployed: () => Promise<void>;
}) {
  const [files, setFiles] = useState<Picked[]>([]),
    [ignored, setIgnored] = useState(0),
    [appName, setAppName] = useState(project.name),
    [spa, setSpa] = useState(true),
    [publish, setPublish] = useState(false),
    [progress, setProgress] = useState(''),
    [result, setResult] = useState<Result | null>(null),
    [history, setHistory] = useState<UploadRow[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dragging, setDragging] = useState(false),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const first = !job;
  // A folder of files can't replace an app with code or bindings: it deploys from its folder.
  const app = job?.localAdapter ?? null;

  async function loadHistory() {
    setHistory(await api<UploadRow[]>(`/projects/${project.id}/uploads`));
  }
  useEffect(() => {
    if (job) void loadHistory().catch(() => {});
    // Once per project, as soon as its deployment is known (it loads after this mounts).
  }, [project.id, Boolean(job)]);

  function accept(picked: Picked[]) {
    setResult(null);
    setError('');
    const kept = rooted(picked).filter((p) => !skipped(p.path));
    setIgnored(picked.length - kept.length);
    setFiles(kept);
    const pages = kept.filter((p) => p.path.endsWith('.html'));
    setSpa(pages.length === 1 && pages[0].path === '/index.html');
  }
  async function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const out: Picked[] = [];
    const entries = [...event.dataTransfer.items]
      .map((i) => i.webkitGetAsEntry?.())
      .filter((e): e is FileSystemEntry => !!e);
    if (entries.length)
      for (const entry of entries) await readEntry(entry, '', out);
    else
      for (const file of event.dataTransfer.files)
        out.push({ path: `/${file.name}`, file });
    accept(out);
  }

  const special = (name: string) => files.find((f) => f.path === `/${name}`);
  const assets = files.filter(
    (f) => !['/_worker.js', '/_redirects', '/_headers'].includes(f.path),
  );
  const totalBytes = assets.reduce((sum, f) => sum + f.file.size, 0);
  const problems = [
    ...(assets.length > MAX_FILES
      ? [`Up to ${MAX_FILES.toLocaleString()} files can be deployed.`]
      : []),
    ...assets
      .filter((f) => f.file.size > MAX_FILE_BYTES)
      .slice(0, 3)
      .map((f) => `${f.path} is larger than 24 MB.`),
    ...assets
      .map((f) => [f.path, assetPathProblem(f.path)] as const)
      .filter(([, problem]) => problem)
      .slice(0, 3)
      .map(([path, problem]) => `${path} ${problem}.`),
    ...((special('_worker.js')?.file.size ?? 0) > MAX_WORKER_BYTES
      ? ['_worker.js is larger than 1 MB.']
      : []),
    ...['_redirects', '_headers']
      .filter((n) => (special(n)?.file.size ?? 0) > MAX_RULES_BYTES)
      .map((n) => `${n} is larger than 64 KB.`),
  ];

  async function deploy() {
    const encoded = async (f: Picked) =>
      toBase64(new Uint8Array(await f.file.arrayBuffer()));
    setProgress('Preparing files…');
    const prepared: Prepared[] = [];
    for (const [i, f] of assets.entries()) {
      prepared.push({ ...f, hash: assetHash(await encoded(f), f.path) });
      if (i % 50 === 0)
        setProgress(`Preparing files… ${i + 1} of ${assets.length}`);
    }
    const created = await api<{
      uploadId: string;
      missing: string[];
      maxRequestBytes: number;
    }>(`/projects/${project.id}/uploads`, {
      method: 'POST',
      body: JSON.stringify({
        files: prepared.map((f) => ({
          path: f.path,
          hash: f.hash,
          size: f.file.size,
        })),
        ...(first ? { workerName: appName } : {}),
      }),
    });
    // Identical files share a hash; each is sent once, in batches under the request limit.
    const byHash = new Map(prepared.map((f) => [f.hash, f]));
    const needed = created.missing
      .map((h) => byHash.get(h))
      .filter((f): f is Prepared => !!f);
    const limit = created.maxRequestBytes - 1024 * 1024;
    let sent = 0;
    while (sent < needed.length) {
      const batch: { hash: string; content: string }[] = [];
      let bytes = 0;
      while (sent < needed.length) {
        const f = needed[sent];
        const content = await encoded(f);
        if (batch.length && bytes + content.length > limit) break;
        batch.push({ hash: f.hash, content });
        bytes += content.length;
        sent++;
      }
      setProgress(`Uploading… ${sent} of ${needed.length} new files`);
      await api(`/projects/${project.id}/uploads/${created.uploadId}/files`, {
        method: 'POST',
        body: JSON.stringify({ files: batch }),
      });
    }
    setProgress('Deploying…');
    const text = async (name: string) => {
      const f = special(name);
      return f ? f.file.text() : undefined;
    };
    const worker = special('_worker.js');
    const deployed = await api<{ result: Result }>(
      `/projects/${project.id}/uploads/${created.uploadId}/deploy`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          confirm: true,
          spa,
          ...(first ? { publish } : {}),
          ...(worker ? { workerModule: await encoded(worker) } : {}),
          ...(special('_redirects')
            ? { redirects: await text('_redirects') }
            : {}),
          ...(special('_headers') ? { headers: await text('_headers') } : {}),
        }),
      },
    );
    setResult(deployed.result);
    capture('direct_upload_deployed', {
      initial_deployment: first,
      file_count: assets.length,
      total_bytes: totalBytes,
      single_page_app: spa,
      published: deployed.result.published,
    });
    setFiles([]);
    setProgress('');
    await loadHistory();
    await onDeployed();
  }
  function run(work: () => Promise<void>) {
    return async () => {
      setBusy(true);
      setError('');
      try {
        await work();
      } catch (e) {
        setError((e as Error).message);
        setProgress('');
      } finally {
        setBusy(false);
      }
    };
  }
  const toggle = (enabled: boolean) =>
    setConfirmation({
      title: enabled ? 'Publish this app?' : 'Unpublish this app?',
      text: enabled
        ? `Anyone with the address can open it at its workers.dev address. Each upload also keeps its own preview address.`
        : 'Its workers.dev address stops answering. Preview addresses keep working for whoever has them.',
      action: async () => {
        await api(
          `/projects/${project.id}/${enabled ? 'publish' : 'unpublish'}`,
          {
            method: 'POST',
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              confirm: true,
            }),
          },
        );
        capture(enabled ? 'site_published' : 'site_unpublished');
        await loadHistory();
        await onDeployed();
      },
    });

  const latest = history?.find((h) => h.status === 'deployed');
  return (
    <section className="panel deployment-panel direct-upload">
      <div className="panel-heading">
        <h2>
          <UploadCloud size={17} aria-hidden="true" />
          {first
            ? 'Or drag and drop a folder'
            : app
              ? 'Deploys from your computer'
              : 'Direct uploads'}
        </h2>
        <span className="badge">{app ? 'Wrangler' : 'No Git needed'}</span>
      </div>
      <div className="detail-panel-content">
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {app ? (
          <p>
            This project is {appKinds[app] ?? 'an app with code or bindings'}.
            It is built on your computer and deployed by Wrangler, which reaches
            your Cloudflare account through Shipcel. To deploy it again, run{' '}
            <code>shipcel</code> in its folder for a preview, or{' '}
            <code>shipcel --prod</code> for production.
          </p>
        ) : (
          <p>
            Drop your site&apos;s built folder, such as <code>dist</code> or{' '}
            <code>build</code>. Shipcel uploads only files Cloudflare
            doesn&apos;t already have and deploys them to your own Cloudflare
            account. An optional <code>_worker.js</code> handles requests no
            file matches, and <code>_redirects</code> and <code>_headers</code>{' '}
            work as usual.
          </p>
        )}
        <div
          hidden={Boolean(app)}
          className={`drop-zone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => void run(() => onDrop(e))()}
        >
          <FolderUp size={28} aria-hidden="true" />
          <p>Drop a folder here</p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => folderInput.current?.click()}
          >
            Choose a folder
          </button>
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            aria-label="Folder to deploy"
            {...{ webkitdirectory: '' }}
            onChange={(e) =>
              accept(
                [...(e.target.files ?? [])].map((file) => ({
                  path: `/${file.webkitRelativePath || file.name}`,
                  file,
                })),
              )
            }
          />
        </div>
        {assets.length > 0 && (
          <div className="upload-summary">
            <p>
              <strong>
                {assets.length.toLocaleString()} file
                {assets.length === 1 ? '' : 's'}
              </strong>
              , {size(totalBytes)}
              {ignored
                ? `, ${ignored} skipped (node_modules, .git and system files)`
                : ''}
              {special('_worker.js') ? ', with _worker.js' : ''}
            </p>
            {problems.length > 0 && (
              <ul className="upload-problems" role="alert">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {first && (
              <label className="field-label">
                App name
                <input
                  className="text-input"
                  value={appName}
                  maxLength={63}
                  onChange={(e) => setAppName(e.target.value.toLowerCase())}
                  aria-describedby="upload-name-hint"
                />
                <span className="field-hint" id="upload-name-hint">
                  Your free address will be {appName}
                  .your-subdomain.workers.dev.
                </span>
              </label>
            )}
            <label className="deploy-consent">
              <input
                type="checkbox"
                checked={spa}
                onChange={(e) => setSpa(e.target.checked)}
              />
              <span>
                Single-page app: send addresses that match no file to
                index.html. (A 404.html file is used instead when there is one.)
              </span>
            </label>
            {first && (
              <label className="deploy-consent">
                <input
                  type="checkbox"
                  checked={publish}
                  onChange={(e) => setPublish(e.target.checked)}
                />
                <span>
                  Publish now. Leave this off to keep the app unpublished: only
                  its preview address works, for anyone you share it with.
                  Manage → Domains can ask for a sign-in first.
                </span>
              </label>
            )}
            <button
              className="button primary"
              disabled={busy || problems.length > 0}
              onClick={() =>
                setConfirmation({
                  title: first
                    ? 'Deploy this folder?'
                    : 'Deploy a new version?',
                  text: first
                    ? `Shipcel creates the ${appName} Worker in your Cloudflare account with these ${assets.length} files.${publish ? ' It will be public at its workers.dev address.' : ' It stays unpublished until you publish it: only its preview address works, for anyone you share that link with.'} Static files are free to serve on Cloudflare.`
                    : `This replaces what ${job?.worker_name} serves with these ${assets.length} files. You can roll back to the previous version in Manage → Builds & versions.`,
                  action: deploy,
                })
              }
            >
              {busy ? progress || 'Working…' : 'Deploy'}
            </button>
          </div>
        )}
        {busy && progress && (
          <p className="field-hint" role="status">
            {progress}
          </p>
        )}
        {result && (
          <div className="upload-result" role="status">
            <strong>Deployed.</strong>{' '}
            {result.published && result.url ? (
              <a href={result.url} target="_blank" rel="noreferrer">
                {result.url} <ExternalLink size={13} aria-hidden="true" />
              </a>
            ) : (
              'Not published: only the preview address below works, for anyone you share it with.'
            )}
            {result.previewUrl && (
              <p>
                Preview of this version:{' '}
                <a href={result.previewUrl} target="_blank" rel="noreferrer">
                  {result.previewUrl}
                </a>
              </p>
            )}
          </div>
        )}
        {job && (
          <div className="publish-row">
            {job.live_url ? (
              <>
                <Globe2 size={16} aria-hidden="true" />
                <span>
                  Published at{' '}
                  <a href={job.live_url} target="_blank" rel="noreferrer">
                    {job.live_url}
                  </a>
                </span>
                {/* Separate keys: one button must not fade into the other. */}
                <button
                  key="unpublish"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => toggle(false)}
                >
                  Unpublish
                </button>
              </>
            ) : (
              <>
                <Lock size={16} aria-hidden="true" />
                <span>Not published: only preview addresses work.</span>
                <button
                  key="publish"
                  className="button primary"
                  disabled={busy}
                  onClick={() => toggle(true)}
                >
                  Publish
                </button>
              </>
            )}
          </div>
        )}
        {history && history.length > 0 && (
          <div className="operation-list">
            <h3>{app ? 'Deploys' : 'Uploads'}</h3>
            {history.map((h) => (
              <div className="operation-row" key={h.id}>
                <div>
                  <strong>
                    {new Date(h.createdAt * 1000).toLocaleString()}
                  </strong>
                  <p>
                    {h.files.toLocaleString()} files, {size(h.bytes)},{' '}
                    {h.status === 'deployed'
                      ? h === latest
                        ? 'live version'
                        : 'earlier version'
                      : h.status}
                    {h.previewUrl && (
                      <>
                        {', '}
                        <a href={h.previewUrl} target="_blank" rel="noreferrer">
                          preview
                        </a>
                      </>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {confirmation && (
        <ConfirmOperation
          value={confirmation}
          busy={busy}
          onConfirm={() =>
            void (async () => {
              const pending = confirmation;
              setConfirmation(null);
              await run(pending.action)();
            })()
          }
          onCancel={() => setConfirmation(null)}
        />
      )}
    </section>
  );
}
