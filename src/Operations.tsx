import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowUpRight,
  Bell,
  ChartColumn,
  Clock,
  Eye,
  Database,
  Globe2,
  HardDrive,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { api } from './api';
import { BackendPanel } from './Backend';
import { DataBrowser } from './DataBrowser';
import { HyperdrivePanel } from './Hyperdrive';
import { ScheduledBackups } from './Backups';
import { BuildVariables } from './BuildVariables';
import { NotificationsPanel } from './Notifications';
import { SecurityPanel } from './Security';
import { ObservabilityPanel } from './Observability';
import { VisitorsPanel } from './Visitors';
import { BuildLog } from './BuildLog';
import { StoragePanel } from './Storage';
import { PreviewAccess } from './PreviewAccess';
import { usesContainers, type Project } from '../shared/catalog';
import type { Deployment } from '../shared/integrations';

type Tab =
  | 'resources'
  | 'secrets'
  | 'schedules'
  | 'domains'
  | 'security'
  | 'history'
  | 'observability'
  | 'visitors'
  | 'notifications'
  | 'database'
  | 'storage'
  | 'backend';
// Five fields (minute hour day month weekday), as Cloudflare's Cron Triggers accept them.
const cronPattern = /^[\dA-Za-z*,/?#LW-]+( [\dA-Za-z*,/?#LW-]+){4}$/;
type MigrationPlan = {
  commit: string;
  binding: string;
  databaseId: string;
  migrationsDir: string;
  applied: string[];
  pending: { name: string; size: number; sha256: string; sql: string }[];
  warnings: string[];
  restorePoints: { operationId: string; bookmark: string; createdAt: number }[];
};
type Journaled<T> = { status: string; error?: string; result?: T };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
type Operation = {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: number;
  health?: string | null;
  health_detail?: string | null;
};
// Follow-up checks after Shipcel-started redeploys and version promotions.
const healthLabels: Record<string, string> = {
  pending: 'Checking health',
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  build_failed: 'Build failed',
  unknown: 'Not checked',
};
const healthTone: Record<string, string> = {
  healthy: 'green',
  unhealthy: 'warning',
  build_failed: 'warning',
};
type Version = {
  id: string;
  number?: number;
  createdAt?: string;
  message: string;
  // The share of traffic this version serves now, or null.
  live: number | null;
};
type Domain = { id: string; hostname: string; zone_id: string };
type CloudInfo = {
  worker: string;
  accountId: string;
  dashboardUrl: string;
  bindings: {
    name: string;
    type: string;
    id?: string;
    bucket_name?: string;
    namespace_id?: string;
  }[];
};
type Build = {
  build_uuid: string;
  build_outcome?: string | null;
  status?: string;
  created_at?: string;
  branch?: string;
  // Built by the branch preview trigger: it never changes production.
  preview?: boolean;
  health?: string;
  health_detail?: string | null;
  health_operation?: string;
};
export type Confirmation = {
  title: string;
  text: ReactNode;
  action: () => Promise<void>;
};

export function ConfirmOperation({
  value,
  busy,
  onConfirm,
  onCancel,
}: {
  value: Confirmation;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Read while rendering, before the dialog takes focus (effects run twice in development).
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    ref.current?.showModal();
    // Removing a dialog does not return focus. Send it back to what opened the dialog,
    // or to the current Manage tab when that control is gone.
    return () => {
      const target =
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected &&
        !opener.matches(':disabled')
          ? opener
          : document.querySelector<HTMLElement>(
              '.operation-nav [aria-selected="true"]',
            );
      target?.focus();
    };
  }, [opener]);
  return (
    <dialog
      ref={ref}
      className="operation-dialog"
      aria-labelledby="operation-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id="operation-title">{value.title}</h2>
      <div className="operation-dialog-copy">{value.text}</div>
      <div className="integration-actions">
        <button
          autoFocus
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button className="button primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Applying…' : 'Confirm change'}
        </button>
      </div>
    </dialog>
  );
}

// The Manage tabs, in the groups the page shows them in.
const TAB_GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: 'Deliver', tabs: ['history', 'domains', 'schedules'] },
  {
    label: 'Configure',
    tabs: ['resources', 'secrets', 'database', 'storage', 'backend'],
  },
  { label: 'Observe', tabs: ['observability', 'visitors', 'notifications'] },
  { label: 'Protect', tabs: ['security'] },
];
const TAB_IDS = TAB_GROUPS.flatMap((g) => g.tabs);
// The open tab lives in the address (#projects/<id>/operations/<tab>), so it can be linked
// to and comes back after a reload.
function tabFromHash(): Tab {
  const sub = location.hash.split('?')[0].slice(1).split('/')[3] ?? '';
  return (TAB_IDS as string[]).includes(sub) ? (sub as Tab) : 'resources';
}

export function OperationsPanel({ project }: { project: Project }) {
  const root = `/projects/${project.id}`;
  const [tab, setTab] = useState<Tab>(tabFromHash),
    [loading, setLoading] = useState(true),
    [ready, setReady] = useState(false),
    [liveUrl, setLiveUrl] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [cloud, setCloud] = useState<CloudInfo | null>(null),
    [history, setHistory] = useState<Operation[]>([]),
    [secrets, setSecrets] = useState<{ name: string; type: string }[] | null>(
      null,
    ),
    // The ones set from Shared variables, which the next shared change replaces.
    [sharedSecrets, setSharedSecrets] = useState<string[]>([]),
    [domains, setDomains] = useState<Domain[] | null>(null),
    [domainsError, setDomainsError] = useState(''),
    [versions, setVersions] = useState<Version[] | null>(null),
    [splitting, setSplitting] = useState<{ id: string; share: string } | null>(
      null,
    ),
    [builds, setBuilds] = useState<Build[] | null>(null),
    // The build whose log is open under it in Builds & versions.
    [openLog, setOpenLog] = useState<string | null>(null),
    // The Worker's cron schedules as Cloudflare has them, and the edited list.
    [schedules, setSchedules] = useState<string[] | null>(null),
    [cronDraft, setCronDraft] = useState<string[]>([]),
    // Direct-upload projects have no Git builds.
    [uploads, setUploads] = useState(false);
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]),
    [zonePage, setZonePage] = useState<number | null>(1),
    [zoneId, setZoneId] = useState(''),
    [hostname, setHostname] = useState('');
  const [secretName, setSecretName] = useState(''),
    [secretValue, setSecretValue] = useState(''),
    [buildPage, setBuildPage] = useState<number | null>(1),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [migrationPlan, setMigrationPlan] = useState<MigrationPlan | null>(
      null,
    ),
    [migrationConsent, setMigrationConsent] = useState(false),
    [exportLink, setExportLink] = useState<{
      url: string;
      filename: string;
    } | null>(null),
    [restoreAt, setRestoreAt] = useState(''),
    [previewAvailable, setPreviewAvailable] = useState(false),
    // Branch previews have staging copies of KV namespaces and R2 buckets.
    [previewStorage, setPreviewStorage] = useState(false),
    [dbEnvironment, setDbEnvironment] = useState<'production' | 'preview'>(
      'production',
    );
  const d1Bindings = (cloud?.bindings || [])
    .filter((b) => b.type === 'd1')
    .map((b) => b.name);
  // The D1 binding the Database tab works on: the checked one, else the first bound D1.
  async function databaseBinding() {
    let info = cloud;
    if (!info) {
      info = await api<CloudInfo>(`${root}/cloud`);
      setCloud(info);
    }
    const binding =
      migrationPlan?.binding ??
      info.bindings.find((b) => b.type === 'd1')?.name;
    if (!binding) throw new Error('This Worker has no D1 database binding.');
    return binding;
  }
  // Cloudflare cancels an export that is not polled, so keep polling until it completes.
  async function exportDatabase(binding: string) {
    const requestId = crypto.randomUUID();
    let bookmark: string | undefined;
    for (let attempt = 0; attempt < 400; attempt++) {
      const step = await api<{
        status: string;
        bookmark?: string;
        filename?: string;
        url?: string;
      }>(`${root}/databases/${encodeURIComponent(binding)}/export`, {
        method: 'POST',
        body: JSON.stringify({
          requestId,
          confirm: true,
          environment: dbEnvironment,
          ...(bookmark ? { bookmark } : {}),
        }),
      });
      if (step.status === 'complete' && step.url) {
        setExportLink({
          url: step.url,
          filename: step.filename || 'export.sql',
        });
        setNotice(
          'Export ready. The download link works for one hour and gives access to all data in the database.',
        );
        return;
      }
      bookmark = step.bookmark;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error(
      'The export is taking longer than expected. Check its progress in Cloudflare.',
    );
  }
  async function checkMigrations(binding = migrationPlan?.binding) {
    let info = cloud;
    if (!info) {
      info = await api<CloudInfo>(`${root}/cloud`);
      setCloud(info);
    }
    const available = info.bindings
      .filter((b) => b.type === 'd1')
      .map((b) => b.name);
    const chosen =
      binding && available.includes(binding) ? binding : available[0];
    setMigrationConsent(false);
    if (!chosen) {
      setMigrationPlan(null);
      throw new Error('This Worker has no D1 database binding.');
    }
    setMigrationPlan(
      await api<MigrationPlan>(
        `${root}/migrations?binding=${encodeURIComponent(chosen)}&environment=${dbEnvironment}`,
      ),
    );
  }
  async function loadHistory() {
    setHistory(await api<Operation[]>(`${root}/operations`));
  }
  async function checkHealth(id: string) {
    await api(`${root}/operations/${id}/health`, { method: 'POST' });
  }
  // The server checks a change at most every 20 seconds; poll while checks are pending.
  useEffect(() => {
    const pending = history.filter((o) => o.health === 'pending');
    if (!pending.length) return;
    let alive = true;
    const timer = setTimeout(() => {
      void Promise.allSettled(pending.map((o) => checkHealth(o.id)))
        .then(() => api<Operation[]>(`${root}/operations`))
        .then((records) => {
          if (alive) setHistory(records);
        })
        .catch(() => {});
    }, 20000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [history, root]);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<Deployment[]>(`${root}/deployments`),
      api<Operation[]>(`${root}/operations`),
    ])
      .then(([jobs, records]) => {
        if (alive) {
          const settled = (j: Deployment) =>
            !['queued', 'provisioning', 'building'].includes(j.status);
          setReady(jobs.some((j) => j.environment !== 'preview' && settled(j)));
          setLiveUrl(
            jobs.find((j) => j.environment !== 'preview' && j.live_url)
              ?.live_url ?? null,
          );
          setHistory(records);
          // Branch previews have a staging database once they are set up.
          const production = jobs.find(
            (j) => j.environment !== 'preview' && j.status === 'deployed',
          );
          setUploads(production?.adapter === 'direct-upload');
          if (production && production.adapter !== 'direct-upload')
            void api<{ status: string; resources?: { type: string }[] }>(
              `${root}/previews?details=0`,
            )
              .then((p) => {
                if (!alive || p.status === 'off') return;
                const types = (p.resources ?? []).map((r) => r.type);
                setPreviewAvailable(types.includes('d1'));
                setPreviewStorage(types.includes('kv') || types.includes('r2'));
              })
              .catch(() => undefined);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [root]);
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
  async function loadSecrets() {
    const [names, shared] = await Promise.all([
      api<{ name: string; type: string }[]>(`${root}/secrets`),
      api<{ variables: { name: string; projects: { id: string }[] }[] }>(
        '/shared-variables',
      ),
    ]);
    setSecrets(names);
    setSharedSecrets(
      shared.variables
        .filter((v) => v.projects.some((p) => p.id === project.id))
        .map((v) => v.name),
    );
  }
  async function mutate(
    path: string,
    method: string,
    body: Record<string, unknown>,
    success: string,
  ) {
    const requestId = crypto.randomUUID();
    const data = await api<{ status: string; error?: string }>(
      `${root}${path}`,
      { method, body: JSON.stringify({ ...body, requestId, confirm: true }) },
    );
    if (data.status !== 'succeeded')
      throw new Error(
        data.error || 'This operation needs review in Cloudflare.',
      );
    setNotice(success);
  }
  async function loadSchedules() {
    const list = (await api<{ cron: string }[]>(`${root}/schedules`)).map(
      (s) => s.cron,
    );
    setSchedules(list);
    setCronDraft(list);
  }
  useEffect(() => {
    if (tab !== 'schedules' || !ready || schedules !== null) return;
    void action(loadSchedules);
  }, [tab, ready]);
  async function loadVersions() {
    setVersions(await api<Version[]>(`${root}/versions`));
  }
  // The Domains tab loads its domains and the account's zones; a failure there stays in
  // its own panel. Git builds load with Builds & versions.
  async function loadDomains() {
    setDomainsError('');
    try {
      const [list, data] = await Promise.all([
        api<Domain[]>(`${root}/domains`),
        api<{ zones: typeof zones; nextPage: number | null }>(
          `${root}/zones?page=1`,
        ),
      ]);
      setDomains(list);
      setZones(data.zones);
      setZonePage(data.nextPage);
    } catch (e) {
      setDomainsError((e as Error).message);
    }
  }
  useEffect(() => {
    if (tab !== 'domains' || !ready || domains !== null) return;
    void loadDomains();
  }, [tab, ready]);
  useEffect(() => {
    if (tab !== 'history' || !ready || uploads || builds !== null) return;
    void action(() => loadBuilds(true));
  }, [tab, ready, uploads]);
  // Versions load with the tab, so a rollback is one click and a confirmation away.
  useEffect(() => {
    if (tab !== 'history' || !ready || versions !== null) return;
    let alive = true;
    void api<Version[]>(`${root}/versions`)
      .then((list) => {
        if (alive) setVersions(list);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [tab, ready, root]);
  async function confirm() {
    if (!confirmation) return;
    await action(async () => {
      try {
        await confirmation.action();
      } finally {
        setSecretValue('');
        await loadHistory();
      }
    });
    // Closed once controls are enabled again, so focus can return to them.
    setConfirmation(null);
  }
  async function loadZones() {
    const data = await api<{ zones: typeof zones; nextPage: number | null }>(
      `${root}/zones?page=${zonePage || 1}`,
    );
    setZones((prev) => [
      ...prev,
      ...data.zones.filter((z) => !prev.some((p) => p.id === z.id)),
    ]);
    setZonePage(data.nextPage);
  }
  async function loadBuilds(reset = false) {
    const data = await api<{ builds: Build[]; nextPage: number | null }>(
      `${root}/builds?page=${reset ? 1 : buildPage || 1}`,
    );
    setBuilds((prev) =>
      reset
        ? data.builds
        : [
            ...(prev || []),
            ...data.builds.filter(
              (b) => !prev?.some((p) => p.build_uuid === b.build_uuid),
            ),
          ],
    );
    setBuildPage(data.nextPage);
  }
  const tabs: { id: Tab; label: string; icon: typeof Database }[] = [
    { id: 'resources', label: 'Resources', icon: Database },
    { id: 'secrets', label: 'Secrets & variables', icon: KeyRound },
    { id: 'schedules', label: 'Schedules', icon: Clock },
    { id: 'domains', label: 'Domains', icon: Globe2 },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'history', label: 'Builds & versions', icon: RotateCcw },
    { id: 'observability', label: 'Analytics & logs', icon: ChartColumn },
    { id: 'visitors', label: 'Visitors', icon: Eye },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'database', label: 'Database', icon: ScrollText },
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'backend', label: 'Sign-in & realtime', icon: UsersRound },
  ];
  const byId = Object.fromEntries(tabs.map((t) => [t.id, t])) as Record<
    Tab,
    (typeof tabs)[number]
  >;
  const select = (id: Tab) => {
    setTab(id);
    setError('');
    window.history.replaceState(
      null,
      '',
      `#projects/${project.id}/operations/${id}`,
    );
  };
  // Arrow keys move within a group, like any tab strip.
  const arrows = (event: KeyboardEvent, ids: Tab[]) => {
    const at = ids.indexOf(tab);
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? ids[(at + 1) % ids.length]
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? ids[(at - 1 + ids.length) % ids.length]
          : event.key === 'Home'
            ? ids[0]
            : event.key === 'End'
              ? ids[ids.length - 1]
              : null;
    if (!next) return;
    event.preventDefault();
    select(next);
    document.getElementById(`manage-tab-${next}`)?.focus();
  };
  return (
    <div className="operations-layout">
      {!loading && ready && (
        <nav className="operation-nav" aria-label="Manage">
          {TAB_GROUPS.map((g) => (
            <div className="operation-group" key={g.label}>
              <span
                className="operation-group-label"
                id={`manage-group-${g.label.toLowerCase()}`}
              >
                {g.label}
              </span>
              <div
                role="tablist"
                aria-labelledby={`manage-group-${g.label.toLowerCase()}`}
              >
                {g.tabs.map((id) => {
                  const t = byId[id];
                  return (
                    <button
                      key={id}
                      id={`manage-tab-${id}`}
                      type="button"
                      role="tab"
                      className="operation-tab"
                      aria-selected={tab === id}
                      aria-controls="manage-panel"
                      tabIndex={tab === id ? 0 : -1}
                      onClick={() => select(id)}
                      onKeyDown={(e) => arrows(e, g.tabs)}
                    >
                      <t.icon size={15} aria-hidden="true" />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="connection-notice" role="status">
          {notice}
        </div>
      )}
      {loading ? (
        <section className="panel operation-body">
          <p>Loading project operations…</p>
        </section>
      ) : !ready ? (
        <>
          <section className="panel operation-body state-card">
            <ShieldCheck size={24} aria-hidden="true" />
            <h2>Deploy this project first</h2>
            <p>
              After its first deploy, this is where you manage the app’s
              resources, secrets, domains, builds, analytics and security.
            </p>
            <a
              className="button primary"
              href={`#projects/${project.id}/deployments`}
            >
              Open Deployments
            </a>
          </section>
          {/* The one thing that works before a deploy: a Postgres or MySQL database,
              because the app's configuration carries its id. */}
          <HyperdrivePanel
            root={root}
            busy={busy}
            action={action}
            confirm={setConfirmation}
            notice={setNotice}
          />
        </>
      ) : (
        <div
          id="manage-panel"
          className="manage-panel"
          role="tabpanel"
          aria-labelledby={`manage-tab-${tab}`}
        >
          {tab === 'resources' && (
            <section className="panel operation-body">
              <div className="operation-title">
                <h2>Connected resources</h2>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () =>
                      setCloud(await api<CloudInfo>(`${root}/cloud`)),
                    )
                  }
                >
                  <RefreshCw size={14} />
                  Load resources
                </button>
              </div>
              <p>
                Read the bindings on the deployed Worker. Resource values and
                secrets are never shown in this inventory.
              </p>
              {cloud && (
                <>
                  <a
                    className="text-link"
                    href={cloud.dashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {cloud.worker}
                    <ArrowUpRight size={14} />
                  </a>
                  {cloud.bindings.length ? (
                    <div className="operation-list">
                      {cloud.bindings.map((b) => (
                        <div className="operation-row" key={b.name}>
                          <div>
                            <strong>{b.name}</strong>
                            <p>{b.type}</p>
                          </div>
                          <code>
                            {b.id ||
                              b.bucket_name ||
                              b.namespace_id ||
                              'Configured'}
                          </code>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="operation-empty">
                      This Worker has no resource bindings.
                    </div>
                  )}
                </>
              )}
              <p className="field-hint">
                Database migrations and data restores are separate from
                application version changes. Review them before applying changes
                to production.
              </p>
            </section>
          )}
          {tab === 'schedules' && (
            <section className="panel operation-body">
              <div className="operation-title">
                <h2>Cron schedules</h2>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void action(loadSchedules)}
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
              </div>
              <p>
                Cloudflare runs your Worker&apos;s <code>scheduled()</code>{' '}
                handler on these schedules, in UTC. Each run counts as a
                request, and the free plan allows 5 schedules per Cloudflare
                account. If your repository&apos;s Wrangler configuration lists{' '}
                <code>triggers.crons</code>, each deploy replaces these with
                that list.
              </p>
              {schedules && (
                <form
                  className="operation-form stacked"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const crons = cronDraft.map((c) => c.trim());
                    setConfirmation({
                      title: crons.length
                        ? 'Save these schedules?'
                        : 'Remove every schedule?',
                      text: crons.length
                        ? `Cloudflare will run the Worker on ${crons.join(', ')} (UTC), replacing its current schedules.`
                        : 'The Worker stops running on a timer. Requests are not affected.',
                      action: async () => {
                        await mutate(
                          '/schedules',
                          'PUT',
                          { crons },
                          crons.length
                            ? 'Schedules saved.'
                            : 'Every schedule was removed.',
                        );
                        await loadSchedules();
                      },
                    });
                  }}
                >
                  {cronDraft.length === 0 && (
                    <p className="operation-empty">No schedules.</p>
                  )}
                  {cronDraft.map((value, i) => (
                    <div className="schedule-row" key={i}>
                      <label className="field-label">
                        Schedule {i + 1}
                        <input
                          className="text-input"
                          value={value}
                          spellCheck={false}
                          aria-invalid={!cronPattern.test(value.trim())}
                          onChange={(e) =>
                            setCronDraft(
                              cronDraft.map((c, j) =>
                                j === i ? e.target.value : c,
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="button secondary"
                        aria-label={`Remove schedule ${i + 1}`}
                        onClick={() =>
                          setCronDraft(cronDraft.filter((_, j) => j !== i))
                        }
                      >
                        <Trash2 size={14} />
                        Remove
                      </button>
                    </div>
                  ))}
                  <p className="field-hint">
                    Five fields: minute, hour, day of month, month, weekday. For
                    example <code>*/30 * * * *</code> runs every 30 minutes, and{' '}
                    <code>0 9 * * MON-FRI</code> at 09:00 UTC on weekdays.
                  </p>
                  <div className="integration-actions">
                    {cronDraft.length < 5 && (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setCronDraft([...cronDraft, ''])}
                      >
                        Add schedule
                      </button>
                    )}
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        cronDraft.join('\n') === schedules.join('\n') ||
                        cronDraft.some((c) => !cronPattern.test(c.trim())) ||
                        new Set(cronDraft.map((c) => c.trim())).size !==
                          cronDraft.length
                      }
                    >
                      Save schedules
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
          {tab === 'secrets' && (
            <>
              <section className="panel operation-body">
                <div className="operation-title">
                  <h2>Runtime secrets</h2>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action(loadSecrets)}
                  >
                    <RefreshCw size={14} />
                    Load secret names
                  </button>
                </div>
                <p>
                  Values are sent directly to Cloudflare and cannot be retrieved
                  here. Adding or replacing a secret updates the live Worker.
                </p>
                <form
                  className="operation-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setConfirmation({
                      title: `Set ${secretName}?`,
                      text: 'This changes a runtime secret on the production Worker. Existing code starts using the new value. The value will not be stored in Shipcel.',
                      action: async () => {
                        await mutate(
                          '/secrets',
                          'PUT',
                          { name: secretName, value: secretValue },
                          'Runtime secret saved in Cloudflare.',
                        );
                        setSecretName('');
                        await loadSecrets();
                      },
                    });
                  }}
                >
                  <label className="field-label">
                    Secret name
                    <input
                      className="text-input"
                      required
                      pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"
                      value={secretName}
                      onChange={(e) => setSecretName(e.target.value)}
                      placeholder="API_KEY"
                    />
                  </label>
                  <label className="field-label">
                    Secret value
                    <input
                      className="text-input"
                      required
                      type="password"
                      autoComplete="new-password"
                      maxLength={4096}
                      value={secretValue}
                      onChange={(e) => setSecretValue(e.target.value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !secretName || !secretValue}
                  >
                    Save runtime secret
                  </button>
                </form>
                {secrets && (
                  <div className="operation-list">
                    {secrets.length ? (
                      secrets.map((s) => (
                        <div className="operation-row" key={s.name}>
                          <div>
                            <strong>{s.name}</strong>
                            <p>
                              {sharedSecrets.includes(s.name)
                                ? 'Value hidden. Set from Shared variables, which replaces it on the next change there.'
                                : 'Value hidden'}
                            </p>
                          </div>
                          <button
                            className="button secondary"
                            disabled={busy}
                            aria-label={`Remove secret ${s.name}`}
                            onClick={() =>
                              setConfirmation({
                                title: `Remove ${s.name}?`,
                                text: 'This removes the secret from the production Worker. Requests depending on it may fail.',
                                action: async () => {
                                  await mutate(
                                    `/secrets/${encodeURIComponent(s.name)}`,
                                    'DELETE',
                                    {},
                                    'Runtime secret removed.',
                                  );
                                  await loadSecrets();
                                },
                              })
                            }
                          >
                            <Trash2 size={14} />
                            Remove
                          </button>
                        </div>
                      ))
                    ) : (
                      <p className="operation-empty">
                        No runtime secrets configured.
                      </p>
                    )}
                  </div>
                )}
              </section>
              {!uploads && (
                <BuildVariables
                  root={root}
                  busy={busy}
                  action={action}
                  mutate={mutate}
                  confirm={setConfirmation}
                />
              )}
            </>
          )}
          {tab === 'domains' && (
            <>
              <section className="panel operation-body">
                <div className="operation-title">
                  <h2>Custom domains</h2>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action(loadDomains)}
                  >
                    <RefreshCw size={14} />
                    Refresh domains
                  </button>
                </div>
                {domainsError && (
                  <p className="inline-error" role="alert">
                    {domainsError}
                  </p>
                )}
                {liveUrl && (
                  <p>
                    Your app is live at its free workers.dev address, with no
                    domain to buy:{' '}
                    <a href={liveUrl} target="_blank" rel="noreferrer">
                      {liveUrl}
                    </a>
                    . A custom domain is optional.
                  </p>
                )}
                <p>
                  Connect an unused hostname from an active Cloudflare zone in
                  this project's account. Existing DNS records or Worker
                  bindings must be reviewed in Cloudflare first.
                </p>
                {zonePage !== 1 && !zones.length && !domainsError && (
                  <p className="field-hint">
                    This account has no active zones yet. Add your domain to
                    Cloudflare first, then come back.
                  </p>
                )}
                {zones.length > 0 && zonePage !== null && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action(loadZones)}
                  >
                    Load more zones
                  </button>
                )}
                {zones.length > 0 && (
                  <form
                    className="operation-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setConfirmation({
                        title: `Connect ${hostname}?`,
                        text: 'Cloudflare will route this hostname to your production Worker and manage its certificate. Certificate activation may take time.',
                        action: async () => {
                          await mutate(
                            '/domains',
                            'POST',
                            { hostname, zoneId },
                            'Domain attached. Check certificate and routing status in Cloudflare before announcing it.',
                          );
                          setHostname('');
                          setDomains(await api(`${root}/domains`));
                        },
                      });
                    }}
                  >
                    <label className="field-label">
                      Cloudflare zone
                      <select
                        className="text-input"
                        required
                        value={zoneId}
                        onChange={(e) => setZoneId(e.target.value)}
                      >
                        <option value="">Choose a zone</option>
                        {zones.map((z) => (
                          <option key={z.id} value={z.id}>
                            {z.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-label">
                      Hostname
                      <input
                        className="text-input"
                        required
                        maxLength={253}
                        value={hostname}
                        onChange={(e) => setHostname(e.target.value)}
                        placeholder="app.example.com"
                      />
                    </label>
                    <button
                      className="button primary"
                      disabled={busy || !zoneId || !hostname}
                    >
                      Connect domain
                    </button>
                  </form>
                )}
                {domains && (
                  <div className="operation-list">
                    {domains.length ? (
                      domains.map((d) => (
                        <div className="operation-row" key={d.id}>
                          <strong>{d.hostname}</strong>
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                title: `Disconnect ${d.hostname}?`,
                                text: 'Requests to this custom hostname will stop reaching the Worker. The Worker itself will remain deployed.',
                                action: async () => {
                                  await mutate(
                                    `/domains/${d.id}`,
                                    'DELETE',
                                    {},
                                    'Domain disconnected from this Worker.',
                                  );
                                  setDomains(await api(`${root}/domains`));
                                },
                              })
                            }
                          >
                            Disconnect
                          </button>
                        </div>
                      ))
                    ) : (
                      <p className="operation-empty">
                        No custom domains attached.
                      </p>
                    )}
                  </div>
                )}
              </section>
              <PreviewAccess
                root={root}
                busy={busy}
                action={action}
                confirm={setConfirmation}
                notice={setNotice}
              />
            </>
          )}
          {tab === 'backend' && (
            <BackendPanel
              root={root}
              busy={busy}
              liveUrl={liveUrl}
              action={action}
              mutate={mutate}
              confirm={setConfirmation}
            />
          )}
          {tab === 'database' && (
            <>
              <section className="panel operation-body">
                <div className="operation-title">
                  <h2>D1 migrations</h2>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action(() => checkMigrations())}
                  >
                    <RefreshCw size={14} />
                    Check migrations
                  </button>
                </div>
                <p>
                  Shipcel compares the migrations directory at the
                  production-branch head with the database&apos;s d1_migrations
                  table, like <code>wrangler d1 migrations apply</code>. Nothing
                  runs until you review and approve it.
                </p>
                {previewAvailable && (
                  <label className="field-label">
                    Environment
                    <select
                      className="text-input"
                      value={dbEnvironment}
                      disabled={busy}
                      onChange={(e) => {
                        setDbEnvironment(
                          e.target.value as 'production' | 'preview',
                        );
                        setMigrationPlan(null);
                        setMigrationConsent(false);
                        setExportLink(null);
                      }}
                    >
                      <option value="production">Production</option>
                      <option value="preview">
                        Previews (staging copy shared by all branch previews)
                      </option>
                    </select>
                  </label>
                )}
                {d1Bindings.length > 1 && (
                  <label className="field-label">
                    D1 binding
                    <select
                      className="text-input"
                      value={migrationPlan?.binding || ''}
                      disabled={busy}
                      onChange={(e) =>
                        void action(() => checkMigrations(e.target.value))
                      }
                    >
                      {d1Bindings.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {migrationPlan && (
                  <>
                    <p className="field-hint">
                      {migrationPlan.binding}, database{' '}
                      <code>{migrationPlan.databaseId}</code>, commit{' '}
                      {migrationPlan.commit.slice(0, 7)},{' '}
                      {migrationPlan.migrationsDir}/,{' '}
                      {plural(
                        migrationPlan.applied.length,
                        'applied migration',
                      )}
                    </p>
                    {migrationPlan.warnings.map((warning) => (
                      <p className="field-hint" key={warning}>
                        {warning}
                      </p>
                    ))}
                    {migrationPlan.pending.length ? (
                      <>
                        <div className="operation-list">
                          {migrationPlan.pending.map((m) => (
                            <div className="operation-row" key={m.name}>
                              <div>
                                <strong>{m.name}</strong>
                                <p>
                                  {m.size.toLocaleString()} bytes, SHA-256{' '}
                                  {m.sha256.slice(0, 12)}
                                </p>
                                <details className="migration-sql">
                                  <summary>View SQL</summary>
                                  <pre>{m.sql}</pre>
                                </details>
                              </div>
                            </div>
                          ))}
                        </div>
                        <label className="deploy-consent">
                          <input
                            type="checkbox"
                            checked={migrationConsent}
                            onChange={(e) =>
                              setMigrationConsent(e.target.checked)
                            }
                          />
                          <span>
                            I reviewed these migrations. They change data in
                            this production database and are not undone by a
                            code rollback.
                          </span>
                        </label>
                        <button
                          className="button primary"
                          disabled={busy || !migrationConsent}
                          onClick={() => {
                            const plan = migrationPlan;
                            setConfirmation({
                              title: `Apply ${plural(plan.pending.length, 'migration')} to ${plan.binding}?`,
                              text: 'Shipcel first records a Time Travel restore point, then runs each reviewed file in order and records it in d1_migrations. It stops at the first failure. Migrations change production data and are not undone by a code rollback.',
                              action: async () => {
                                try {
                                  const data = await api<
                                    Journaled<{
                                      applied: string[];
                                      bookmark: string;
                                    }>
                                  >(`${root}/migrations`, {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      requestId: crypto.randomUUID(),
                                      confirm: true,
                                      binding: plan.binding,
                                      environment: dbEnvironment,
                                      commit: plan.commit,
                                      migrations: plan.pending.map(
                                        ({ name, sha256 }) => ({
                                          name,
                                          sha256,
                                        }),
                                      ),
                                    }),
                                  });
                                  if (
                                    data.status !== 'succeeded' ||
                                    !data.result
                                  )
                                    throw new Error(
                                      data.error ||
                                        'The migration needs review in Cloudflare.',
                                    );
                                  setNotice(
                                    `Applied ${plural(data.result.applied.length, 'migration')}. Restore point ${data.result.bookmark} was recorded first.`,
                                  );
                                } finally {
                                  await checkMigrations(plan.binding).catch(
                                    () => {},
                                  );
                                }
                              },
                            });
                          }}
                        >
                          {`Apply ${plural(migrationPlan.pending.length, 'migration')}`}
                        </button>
                      </>
                    ) : (
                      <p className="operation-empty">
                        No pending migrations. The database matches the
                        repository.
                      </p>
                    )}
                    {migrationPlan.restorePoints.length > 0 && (
                      <div className="operation-list">
                        <h3>Restore points</h3>
                        {migrationPlan.restorePoints.map((point) => (
                          <div
                            className="operation-row"
                            key={point.operationId}
                          >
                            <div>
                              <strong>
                                {new Date(
                                  point.createdAt * 1000,
                                ).toLocaleString()}
                              </strong>
                              <p>
                                Bookmark {point.bookmark}, recorded before the
                                migrations of operation{' '}
                                {point.operationId.slice(0, 8)}
                              </p>
                            </div>
                            <button
                              className="button secondary"
                              disabled={busy}
                              aria-label={`Restore to before ${point.operationId}`}
                              onClick={() => {
                                const binding = migrationPlan.binding;
                                setConfirmation({
                                  title: 'Restore this database?',
                                  text: `This overwrites the database with its state at bookmark ${point.bookmark}, recorded before those migrations ran. Data written since then is lost. Cloudflare returns a new bookmark so the restore itself can be undone.`,
                                  action: async () => {
                                    try {
                                      const data = await api<
                                        Journaled<{
                                          undoBookmark: string | null;
                                        }>
                                      >(`${root}/migrations/restore`, {
                                        method: 'POST',
                                        body: JSON.stringify({
                                          requestId: crypto.randomUUID(),
                                          confirm: true,
                                          operationId: point.operationId,
                                          environment: dbEnvironment,
                                        }),
                                      });
                                      if (data.status !== 'succeeded')
                                        throw new Error(
                                          data.error ||
                                            'The restore needs review in Cloudflare.',
                                        );
                                      setNotice(
                                        `Database restored to ${point.bookmark}.${data.result?.undoBookmark ? ` To undo this restore, restore bookmark ${data.result.undoBookmark} with wrangler d1 time-travel restore.` : ''}`,
                                      );
                                    } finally {
                                      await checkMigrations(binding).catch(
                                        () => {},
                                      );
                                    }
                                  },
                                });
                              }}
                            >
                              <RotateCcw size={14} />
                              Restore
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
                <div className="operation-list">
                  <h3>Backups</h3>
                  <p>
                    Cloudflare D1 Time Travel keeps point-in-time history: 7
                    days on Workers Free and 30 days on Workers Paid. Export a
                    SQL dump for a copy outside Cloudflare.
                  </p>
                  <div className="integration-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const binding = await databaseBinding();
                          setConfirmation({
                            title: `Export ${binding} as a SQL dump?`,
                            text: 'The database cannot serve queries while Cloudflare exports it; large databases take longer. Shipcel keeps polling until the export finishes. The download link works for one hour and gives access to all data, so do not share it.',
                            action: () => exportDatabase(binding),
                          });
                        })
                      }
                    >
                      Export SQL dump
                    </button>
                    {exportLink && (
                      <a
                        className="text-link"
                        href={exportLink.url}
                        rel="noreferrer"
                        download={exportLink.filename}
                      >
                        Download {exportLink.filename}
                      </a>
                    )}
                  </div>
                  <div className="operation-form">
                    <label className="field-label">
                      Restore to
                      <input
                        className="text-input"
                        type="datetime-local"
                        value={restoreAt}
                        onChange={(e) => setRestoreAt(e.target.value)}
                      />
                    </label>
                    <button
                      className="button secondary"
                      disabled={busy || !restoreAt}
                      onClick={() =>
                        void action(async () => {
                          const binding = await databaseBinding();
                          const timestamp = new Date(restoreAt).toISOString();
                          setConfirmation({
                            title: `Restore ${binding} to ${new Date(restoreAt).toLocaleString()}?`,
                            text: 'This overwrites the database with its state at that time. Data written since then is lost. Cloudflare returns a bookmark so the restore itself can be undone.',
                            action: async () => {
                              const data = await api<{
                                status: string;
                                error?: string;
                                result?: { undoBookmark: string | null };
                              }>(
                                `${root}/databases/${encodeURIComponent(binding)}/restore`,
                                {
                                  method: 'POST',
                                  body: JSON.stringify({
                                    requestId: crypto.randomUUID(),
                                    confirm: true,
                                    timestamp,
                                    environment: dbEnvironment,
                                  }),
                                },
                              );
                              if (data.status !== 'succeeded')
                                throw new Error(
                                  data.error ||
                                    'The restore needs review in Cloudflare.',
                                );
                              setNotice(
                                `Database restored to ${new Date(timestamp).toLocaleString()}.${data.result?.undoBookmark ? ` To undo this restore, restore bookmark ${data.result.undoBookmark} with wrangler d1 time-travel restore.` : ''}`,
                              );
                            },
                          });
                        })
                      }
                    >
                      Restore to this time
                    </button>
                  </div>
                </div>
                <ScheduledBackups
                  root={root}
                  bindings={d1Bindings}
                  busy={busy}
                  confirm={setConfirmation}
                  notice={setNotice}
                />
              </section>
              <DataBrowser
                root={root}
                busy={busy}
                environment={dbEnvironment}
                action={action}
                confirm={setConfirmation}
              />
              <HyperdrivePanel
                root={root}
                busy={busy}
                action={action}
                confirm={setConfirmation}
                notice={setNotice}
              />
            </>
          )}
          {tab === 'storage' && (
            <StoragePanel
              root={root}
              previews={previewStorage}
              busy={busy}
              action={action}
              confirm={setConfirmation}
              notice={setNotice}
            />
          )}
          {tab === 'security' && (
            <SecurityPanel
              root={root}
              busy={busy}
              action={action}
              confirm={setConfirmation}
              notice={setNotice}
            />
          )}
          {tab === 'notifications' && (
            <NotificationsPanel
              root={root}
              busy={busy}
              action={action}
              confirm={setConfirmation}
              notice={setNotice}
            />
          )}
          {tab === 'observability' && (
            <ObservabilityPanel root={root} busy={busy} action={action} />
          )}
          {tab === 'visitors' && (
            <VisitorsPanel root={root} busy={busy} action={action} />
          )}
          {tab === 'history' && (
            <>
              {!uploads && (
                <section className="panel operation-body">
                  <div className="operation-title">
                    <h2>Native build history</h2>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void action(() => loadBuilds(true))}
                    >
                      <RefreshCw size={14} />
                      Refresh builds
                    </button>
                  </div>
                  <p>
                    These records come from Cloudflare, including builds
                    triggered by production-branch pushes. Shipcel checks the
                    homepage after each new production build, whether it was
                    started here or by a push (push builds are picked up within
                    about five minutes). Branch preview builds are listed too;
                    they never change production.
                  </p>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
                        title: 'Rebuild the production branch?',
                        text: 'This starts a new build of the current production-branch commit in Cloudflare. It can incur build and infrastructure charges.',
                        action: async () => {
                          await mutate(
                            '/redeploy',
                            'POST',
                            {},
                            'Build requested. Shipcel checks the homepage after the build succeeds; follow it in Operation history.',
                          );
                          await loadBuilds(true);
                        },
                      })
                    }
                  >
                    Redeploy production
                  </button>
                  {builds && (
                    <div className="operation-list">
                      {builds.length ? (
                        builds.map((b) => (
                          <div
                            className="operation-row build-row"
                            key={b.build_uuid}
                          >
                            <div>
                              <strong>{b.build_uuid.slice(0, 8)}</strong>
                              <p>
                                {b.preview
                                  ? `Preview of ${b.branch || 'a branch'}`
                                  : b.branch || 'Production'}{' '}
                                , {b.created_at || 'Time unavailable'}
                              </p>
                              {b.health_detail && <p>{b.health_detail}</p>}
                              <button
                                type="button"
                                className="text-link"
                                aria-expanded={openLog === b.build_uuid}
                                onClick={() =>
                                  setOpenLog(
                                    openLog === b.build_uuid
                                      ? null
                                      : b.build_uuid,
                                  )
                                }
                              >
                                {openLog === b.build_uuid
                                  ? 'Hide the log'
                                  : 'Logs'}
                              </button>
                              {openLog === b.build_uuid && (
                                <BuildLog root={root} build={b.build_uuid} />
                              )}
                              {b.health === 'pending' && b.health_operation && (
                                <button
                                  className="text-link"
                                  disabled={busy}
                                  onClick={() =>
                                    void action(async () => {
                                      await checkHealth(b.health_operation!);
                                      await loadBuilds(true);
                                    })
                                  }
                                >
                                  Check health now
                                </button>
                              )}
                            </div>
                            <div className="operation-badges">
                              <span className="badge">
                                {b.build_outcome || b.status || 'In progress'}
                              </span>
                              {b.health && (
                                <span
                                  className={`badge ${healthTone[b.health] ?? ''}`}
                                >
                                  {healthLabels[b.health] ?? b.health}
                                </span>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="operation-empty">
                          No builds returned by Cloudflare.
                        </p>
                      )}
                      {buildPage && (
                        <button
                          className="text-link"
                          disabled={busy}
                          onClick={() => void action(() => loadBuilds())}
                        >
                          Load more builds
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
              <section className="panel operation-body">
                <div className="operation-title">
                  <h2>Versions and rollback</h2>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action(loadVersions)}
                  >
                    <RefreshCw size={14} />
                    {versions ? 'Refresh versions' : 'Load versions'}
                  </button>
                </div>
                <p>
                  Every deploy is a saved version. Roll back in one click, send
                  all traffic to any version, or try a version on a share of
                  traffic first. Shipcel confirms the change is serving and
                  checks the homepage. Rolling back does not restore database
                  data, undo migrations, or revert other resources, and the next
                  deploy replaces what is serving.
                </p>
                {usesContainers(project.framework) && (
                  <p className="field-hint">
                    Containers that use the default scheduling policy keep the
                    image from their latest rollout: promoting a version changes
                    the Worker code only. Redeploy an earlier commit to roll
                    back the container image as well.
                  </p>
                )}
                {versions &&
                  (() => {
                    const name = (v: Version) =>
                      v.number ? `Version ${v.number}` : v.id.slice(0, 8);
                    const serving = (v: Version) => typeof v.live === 'number';
                    // Versions are newest first; the one before the live version is next in the list.
                    const liveAt = versions.findIndex((v) => v.live === 100);
                    const current = liveAt >= 0 ? versions[liveAt] : null;
                    const previous =
                      liveAt >= 0 ? versions[liveAt + 1] : undefined;
                    const split = versions.filter(serving);
                    const promote = (v: Version, text: string) =>
                      setConfirmation({
                        title: `Send all traffic to ${name(v)}?`,
                        text,
                        action: async () => {
                          await mutate(
                            '/rollback',
                            'POST',
                            { versionId: v.id },
                            'Version promoted. Shipcel is confirming it is serving and checking the homepage; follow it in Operation history.',
                          );
                          await loadVersions();
                        },
                      });
                    return (
                      <>
                        {previous && (
                          <button
                            className="button primary rollback-button"
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                title: `Roll back to ${name(previous)}?`,
                                text: `All traffic goes back to ${name(previous)}${previous.createdAt ? `, deployed ${new Date(previous.createdAt).toLocaleString()}` : ''}. Database changes and migrations are not undone. Shipcel then checks the homepage.`,
                                action: async () => {
                                  await mutate(
                                    '/rollback',
                                    'POST',
                                    { versionId: previous.id },
                                    `Rolled back to ${name(previous)}. Shipcel is confirming it is serving and checking the homepage; follow it in Operation history.`,
                                  );
                                  await loadVersions();
                                },
                              })
                            }
                          >
                            <RotateCcw size={14} />
                            Roll back to {name(previous)}
                          </button>
                        )}
                        {split.length > 1 && (
                          <p className="field-hint">
                            Traffic is split:{' '}
                            {split
                              .map((v) => `${v.live}% to ${name(v)}`)
                              .join(', ')}
                            . Send all traffic to one of them to finish.
                          </p>
                        )}
                        <div className="operation-list">
                          {versions.length ? (
                            versions.map((v) => (
                              <div className="operation-row" key={v.id}>
                                <div>
                                  <strong>{name(v)}</strong>
                                  <p>
                                    {v.createdAt
                                      ? new Date(v.createdAt).toLocaleString()
                                      : 'Time unavailable'}
                                    {v.message ? `, ${v.message}` : ''}
                                  </p>
                                  {splitting?.id === v.id && current && (
                                    <form
                                      className="split-form"
                                      onSubmit={(e) => {
                                        e.preventDefault();
                                        const share = Number(splitting.share);
                                        setConfirmation({
                                          title: `Send ${share}% of traffic to ${name(v)}?`,
                                          text: `${100 - share}% stays on ${name(current)}. Each request goes to one of them at random. Shipcel checks ${name(v)} once it is serving. Send all traffic to either version to finish, or roll back.`,
                                          action: async () => {
                                            await mutate(
                                              '/traffic',
                                              'POST',
                                              {
                                                versions: [
                                                  {
                                                    versionId: v.id,
                                                    percentage: share,
                                                  },
                                                  {
                                                    versionId: current.id,
                                                    percentage: 100 - share,
                                                  },
                                                ],
                                              },
                                              `${share}% of traffic now goes to ${name(v)}. Follow its health check in Operation history.`,
                                            );
                                            setSplitting(null);
                                            await loadVersions();
                                          },
                                        });
                                      }}
                                    >
                                      <label className="field-label">
                                        Share for {name(v)} (%)
                                        <input
                                          className="text-input"
                                          type="number"
                                          inputMode="numeric"
                                          min={1}
                                          max={99}
                                          required
                                          value={splitting.share}
                                          onChange={(e) =>
                                            setSplitting({
                                              id: v.id,
                                              share: e.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                      <button
                                        className="button primary"
                                        disabled={
                                          busy ||
                                          !/^[1-9][0-9]?$/.test(splitting.share)
                                        }
                                      >
                                        Review split
                                      </button>
                                      <button
                                        type="button"
                                        className="text-link"
                                        onClick={() => setSplitting(null)}
                                      >
                                        Cancel
                                      </button>
                                    </form>
                                  )}
                                </div>
                                <div className="operation-badges">
                                  {serving(v) && (
                                    <span className="badge green">
                                      Live, {v.live}%
                                    </span>
                                  )}
                                  {v.live !== 100 && (
                                    <button
                                      className="button secondary"
                                      disabled={busy}
                                      aria-label={`Send all traffic to ${name(v)}`}
                                      onClick={() =>
                                        promote(
                                          v,
                                          'This routes all production traffic to this version. Database changes are not rolled back. Cloudflare may reject an incompatible version; Shipcel will not force it.',
                                        )
                                      }
                                    >
                                      Promote
                                    </button>
                                  )}
                                  {!serving(v) &&
                                    current &&
                                    splitting?.id !== v.id && (
                                      <button
                                        className="button secondary"
                                        disabled={busy}
                                        aria-label={`Split traffic with ${name(v)}`}
                                        onClick={() =>
                                          setSplitting({
                                            id: v.id,
                                            share: '10',
                                          })
                                        }
                                      >
                                        Split traffic
                                      </button>
                                    )}
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="operation-empty">
                              No uploaded versions available.
                            </p>
                          )}
                        </div>
                      </>
                    );
                  })()}
              </section>
            </>
          )}
        </div>
      )}
      <section className="panel operation-body">
        <div className="operation-title">
          <h2>Operation history</h2>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void action(loadHistory)}
          >
            Refresh operations
          </button>
        </div>
        {history.length ? (
          <div className="operation-list">
            {history.map((o) => (
              <div className="operation-row" key={o.id}>
                <div>
                  <strong>{o.kind.replaceAll('.', ': ')}</strong>
                  <p>
                    {new Date(o.created_at * 1000).toLocaleString()}
                    {o.error ? `, ${o.error}` : ''}
                  </p>
                  {o.health_detail && <p>{o.health_detail}</p>}
                  {o.health === 'pending' && (
                    <button
                      className="text-link"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await checkHealth(o.id);
                          await loadHistory();
                        })
                      }
                    >
                      Check health now
                    </button>
                  )}
                  {o.status === 'needs_attention' && (
                    <button
                      className="text-link"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          // Read-only: learns whether the change took effect; nothing is repeated.
                          await api(`${root}/operations/${o.id}/reconcile`, {
                            method: 'POST',
                          });
                          await loadHistory();
                        })
                      }
                    >
                      Check Cloudflare
                    </button>
                  )}
                </div>
                <div className="operation-badges">
                  <span className="badge">{o.status.replaceAll('_', ' ')}</span>
                  {o.health && (
                    <span className={`badge ${healthTone[o.health] ?? ''}`}>
                      {healthLabels[o.health] ?? o.health}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="operation-empty">
            No operations have been recorded for this project.
          </p>
        )}
      </section>
      {confirmation && (
        <ConfirmOperation
          value={confirmation}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setConfirmation(null);
            setSecretValue('');
          }}
        />
      )}
    </div>
  );
}
