import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Activity as ActivityIcon,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Bot,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Database,
  ExternalLink,
  FileCode2,
  Folder,
  GitBranch as Github,
  Globe2,
  HardDrive,
  KeyRound,
  Layers3,
  LayoutGrid,
  Link2,
  LoaderCircle,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  UsersRound,
  X,
  Rocket,
  Wallet,
  Zap,
} from 'lucide-react';
import {
  allowsBindings,
  frameworks,
  getFramework,
  hasImportAdapter,
  hasKit,
  usesContainers,
  type Activity,
  type Framework,
  type FrameworkId,
  type Project,
  type ProjectInput,
  type ProjectSource,
} from '../shared/catalog';
import { projectNameFrom, projectSchema } from '../shared/validation';
import { RepositoryPicker } from './RepositoryPicker';
import { api, downloadKit } from './api';
import { OperationsPanel } from './Operations';
import { BudgetGuard } from './Budget';
import {
  ConnectionsPanel,
  DeploymentPanel,
  PlanPanel,
  SignIn,
} from './Integrations';
import { DevelopersPanel } from './Developers';
import { SharedVariablesPanel } from './SharedVariables';
import { CliSetup } from './CliSetup';
import { OAuthApprove } from './OAuthApprove';
import { AgentsPanel } from './Agents';
import { InvitationPage, roleNames, TeamPanel } from './Team';
import { capture } from './posthog';
import type { SessionStatus, ConnectionStatus } from '../shared/integrations';

type Page =
  | 'overview'
  | 'projects'
  | 'templates'
  | 'activity'
  | 'connections'
  | 'guide'
  | 'plan'
  | 'developers'
  | 'variables'
  | 'agents'
  | 'team'
  | 'invite'
  | 'cli-login'
  | 'cli-setup'
  | 'oauth';
const pageNames: Record<Page, string> = {
  overview: 'Overview',
  projects: 'Projects',
  templates: 'App catalog',
  activity: 'Activity',
  connections: 'Connections',
  guide: 'Getting started',
  plan: 'Plan & usage',
  developers: 'API & CLI',
  variables: 'Shared variables',
  agents: 'Build with AI agents',
  team: 'Team',
  invite: 'Join a workspace',
  'cli-login': 'Sign in the CLI',
  'cli-setup': 'Set up the CLI',
  oauth: 'Approve an AI agent',
};
// Hash routes look like #projects, #projects/<id>/deployments (a project, on one of its
// tabs: what the CLI links to), #cli-login?code=ABCD-EFGH or #cli-setup (the pages the CLI
// opens: signing in, approving it and connecting Cloudflare, without the dashboard around).
const route = () => {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const [name, project, tab] = path.split('/');
  return { name, project, tab, params: new URLSearchParams(query) };
};
// A project's newest non-preview deployment (GET /api/deployments/recent).
type RecentJob = {
  id: string;
  project_id: string;
  status: string;
  environment: string;
  live_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};
const detailTabs = ['overview', 'configuration', 'deployments', 'operations'];
const projectLink = () => {
  const { name, project, tab } = route();
  return name === 'projects' && project
    ? {
        id: project,
        tab: (detailTabs.includes(tab) ? tab : 'overview') as DetailTab,
      }
    : null;
};
const nav = [
  { id: 'overview', icon: LayoutGrid, label: 'Overview' },
  { id: 'projects', icon: Layers3, label: 'Projects' },
  { id: 'templates', icon: Box, label: 'App catalog' },
  { id: 'activity', icon: ActivityIcon, label: 'Activity' },
  { id: 'connections', icon: Link2, label: 'Connections' },
  { id: 'variables', icon: KeyRound, label: 'Shared variables' },
  { id: 'team', icon: UsersRound, label: 'Team' },
  { id: 'agents', icon: Bot, label: 'AI agents' },
  { id: 'developers', icon: Terminal, label: 'API & CLI' },
  { id: 'plan', icon: ShieldCheck, label: 'Plan & usage' },
] as const;
const actionNames = {
  'project.created': 'Project created',
  'kit.exported': 'Starter kit exported',
  'project.deleted': 'Project removed',
};

function FrameworkIcon({
  framework,
  small = false,
}: {
  framework: Framework;
  small?: boolean;
}) {
  return (
    <span
      className={`framework-icon ${framework.color} ${small ? 'small' : ''}`}
      aria-hidden="true"
    >
      {framework.symbol}
    </span>
  );
}
function Badge({
  children,
  tone = '',
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
// The budget guard's last reading, when it needs attention.
function BudgetBadge({ project }: { project: Project }) {
  if (project.budget === 'over')
    return <Badge tone="warning">Over budget</Badge>;
  return null;
}
function formatDate(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(date));
}
// What a project is doing: the budget guard's pause, or its newest non-preview deployment.
const deployStatus = (p: Project, job?: RecentJob) =>
  p.budget === 'paused'
    ? 'Paused'
    : !job
      ? 'Not deployed'
      : job.status === 'failed'
        ? 'Failed'
        : ['deployed', 'succeeded'].includes(job.status)
          ? 'Live'
          : 'Building';
const statusTone = (status: string) =>
  status === 'Live'
    ? 'green'
    : status === 'Paused' || status === 'Failed'
      ? 'danger'
      : status === 'Building'
        ? 'warning'
        : '';

export default function App() {
  const initial = route().name;
  const [page, setPage] = useState<Page>(
    initial in pageNames ? (initial as Page) : 'overview',
  );
  const [cliCode, setCliCode] = useState(
    () => route().params.get('code') ?? '',
  );
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [creating, setCreating] = useState<FrameworkId | false>(false);
  const [selected, setSelected] = useState<Project | null>(null);
  // A project created from GitHub opens on Deployments, ready to review and deploy.
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  // A project named in the address, opened once the projects have loaded.
  const [linked, setLinked] = useState(projectLink);
  const [recent, setRecent] = useState<Record<string, RecentJob>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [mobileNav, setMobileNav] = useState(false);

  async function refresh() {
    setLoadError('');
    try {
      const nextSession = await api<SessionStatus>('/auth/session');
      setSession(nextSession);
      if (!nextSession.user) {
        setProjects([]);
        setActivity([]);
        setSelected(null);
        return;
      }
      const [nextProjects, nextActivity, connections, jobs] = await Promise.all(
        [
          api<Project[]>('/projects'),
          api<Activity[]>('/activity'),
          api<ConnectionStatus>('/connections'),
          api<RecentJob[]>('/deployments/recent').catch(
            () => [] as RecentJob[],
          ),
        ],
      );
      setProjects(nextProjects);
      setActivity(nextActivity);
      setConnectionStatus(connections);
      setRecent(Object.fromEntries(jobs.map((j) => [j.project_id, j])));
      setSelected((prev) =>
        prev ? nextProjects.find((p) => p.id === prev.id) || null : null,
      );
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const handler = () => {
      const { name: next, params } = route();
      if (next in pageNames) {
        setPage(next as Page);
        setCliCode(params.get('code') ?? '');
        setSelected(null);
        setLinked(projectLink());
      }
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (!linked || loading) return;
    const project = projects.find((p) => p.id === linked.id);
    if (project) {
      setDetailTab(linked.tab);
      setSelected(project);
    } else {
      setToast('That project isn’t in this workspace.');
      history.replaceState(null, '', '#projects');
    }
    setLinked(null);
  }, [linked, loading, projects]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  // The workspace the session is in, and what this person may do there.
  const workspaces = session?.user?.workspaces ?? [];
  const workspace = workspaces.find((w) => w.id === session?.user?.workspaceId);
  const viewer = session?.user?.role === 'viewer';
  // The Overview's working surface: the newest deploy, the budget guard, what needs a hand.
  const status = (p: Project) => deployStatus(p, recent[p.id]);
  const lastDeploy = projects
    .map((project) => ({ project, job: recent[project.id] }))
    .filter((x): x is { project: Project; job: RecentJob } => Boolean(x.job))
    .sort((a, b) => b.job.updated_at - a.job.updated_at)[0];
  const paused = projects.filter((p) => p.budget === 'paused');
  const overBudget = projects.filter((p) => p.budget === 'over');
  const budgetLine = paused.length
    ? `${paused.length} paused for going over budget`
    : overBudget.length
      ? `${overBudget.length} over budget`
      : projects.length
        ? 'All apps within budget'
        : 'No apps yet';
  const notDeployed = projects.filter(
    (p) => !recent[p.id] && p.budget !== 'paused',
  );
  const attention: { text: string; go: () => void }[] = [
    ...(connectionStatus && !connectionStatus.cloudflare.connected
      ? [{ text: 'Connect Cloudflare', go: () => go('connections') }]
      : []),
    ...(connectionStatus && !connectionStatus.github.connected
      ? [{ text: 'Connect GitHub', go: () => go('connections') }]
      : []),
    ...paused.map((p) => ({
      text: `${p.name} is paused: over its budget`,
      go: () => openTab(p, 'overview'),
    })),
    ...projects
      .filter((p) => recent[p.id]?.status === 'failed')
      .map((p) => ({
        text: `${p.name}: the last deploy failed`,
        go: () => openTab(p, 'deployments'),
      })),
    ...(notDeployed.length
      ? [
          {
            text:
              notDeployed.length === 1
                ? `${notDeployed[0].name} is not deployed yet`
                : `${notDeployed.length} projects are not deployed yet`,
            go: () => go('projects'),
          },
        ]
      : []),
  ].slice(0, 4);
  function create(framework: FrameworkId) {
    if (viewer)
      setToast(
        'Viewers can’t create projects. Ask a workspace owner for developer access.',
      );
    else setCreating(framework);
  }
  function open(project: Project) {
    openTab(project, 'overview');
  }
  function openTab(project: Project, tab: DetailTab) {
    setDetailTab(tab);
    setSelected(project);
  }
  async function switchWorkspace(id: string) {
    await api('/auth/workspace', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: id }),
    });
    setSelected(null);
    await refresh();
  }
  function go(next: Page) {
    setPage(next);
    location.hash = next;
    setSelected(null);
    setQuery('');
    setFilter('all');
    setMobileNav(false);
  }
  const visible = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' || p.framework === filter),
  );
  const resourceCount = projects.reduce(
    (total, p) => total + Number(p.database) + Number(p.storage),
    0,
  );
  const title = selected ? selected.name : pageNames[page];
  // An AI agent's OAuth sign-in: allow or deny it, after signing in with GitHub if needed.
  if (page === 'oauth')
    return session ? (
      <OAuthApprove id={route().project ?? ''} session={session} />
    ) : (
      <main className="signin-page">
        <p>Loading…</p>
      </main>
    );
  // The CLI's own pages work before signing in, and send the person back afterwards.
  if (page === 'cli-login' || page === 'cli-setup')
    return session ? (
      <CliSetup
        code={page === 'cli-login' ? cliCode : ''}
        session={session}
        onRefresh={refresh}
      />
    ) : (
      <main className="signin-page">
        {loadError ? (
          <div className="inline-error" role="alert">
            {loadError}
          </div>
        ) : (
          <p>Loading…</p>
        )}
      </main>
    );
  if (session && !session.user)
    return <SignIn configured={session.githubConfigured} />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {mobileNav && (
        <button
          className="sidebar-scrim"
          onClick={() => setMobileNav(false)}
          aria-label="Dismiss navigation overlay"
        />
      )}
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <button
          className="icon-button sidebar-close"
          onClick={() => setMobileNav(false)}
          aria-label="Close navigation"
        >
          <X size={18} />
        </button>
        <button
          className="brand"
          onClick={() => go('overview')}
          aria-label="Shipcel home"
        >
          <img src="/favicon.svg" alt="" />
          <span>Shipcel</span>
        </button>
        <div className="workspace">
          <span className="workspace-avatar">
            {(workspace?.name ?? 'P').slice(0, 1).toUpperCase()}
          </span>
          <div className="workspace-switcher">
            {workspaces.length > 1 ? (
              <label>
                <span className="sr-only">Workspace</span>
                <select
                  value={workspace?.id ?? ''}
                  onChange={(e) =>
                    void switchWorkspace(e.target.value).catch((err) =>
                      setLoadError((err as Error).message),
                    )
                  }
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({roleNames[w.role]})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div>
                <strong>
                  {workspace?.kind === 'team'
                    ? workspace.name
                    : 'Personal workspace'}
                </strong>
                <span>
                  {session?.user?.local ? 'Local workspace' : 'Free plan'}
                </span>
              </div>
            )}
          </div>
          <span className="workspace-local" title="Local workspace">
            <span />
          </span>
        </div>
        <div className="nav-label">Workspace</div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => go(item.id)}
              aria-current={page === item.id ? 'page' : undefined}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === 'projects' && projects.length > 0 && (
                <span className="nav-count">{projects.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === 'guide' ? 'active' : ''}`}
            onClick={() => go('guide')}
          >
            <BookOpen size={18} />
            Getting started
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <span className="profile-avatar">
              {session?.user?.login.slice(0, 1).toUpperCase() || 'Y'}
            </span>
            <div>
              <strong>{session?.user?.login || 'Your workspace'}</strong>
              {session?.user?.local ? (
                <span>On this device</span>
              ) : (
                <button
                  className="profile-logout"
                  onClick={() => {
                    void api('/auth/logout', { method: 'POST' })
                      .then(refresh)
                      .catch((e) => setLoadError(e.message));
                  }}
                >
                  Sign out
                </button>
              )}
            </div>
            <span className="local-indicator" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <span>
              {workspace?.kind === 'team'
                ? workspace.name
                : 'Personal workspace'}
            </span>
            <ChevronRight size={14} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            <span className="alpha-label">
              <span />
              {session?.user?.local ? 'Local workspace' : 'Free plan'}
            </span>
            <a
              className="docs-link"
              href="/docs/"
              target="_blank"
              rel="noreferrer"
            >
              Docs <ArrowUpRight size={14} />
            </a>
          </div>
        </header>
        <main id="main">
          {loadError && (
            <div className="error-banner" role="alert">
              <span>{loadError}</span>
              <button onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {selected ? (
            <ProjectDetail
              key={selected.id}
              initialTab={detailTab}
              status={status(selected)}
              project={selected}
              onBack={() => {
                setSelected(null);
                history.replaceState(null, '', '#projects');
              }}
              onRefresh={refresh}
              onDeleted={() => {
                setSelected(null);
                history.replaceState(null, '', '#projects');
                void refresh();
                setToast('Project removed.');
              }}
              notify={setToast}
              owner={session?.user?.role === 'owner'}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>{title}</h1>
                  <p>
                    {page === 'overview'
                      ? 'The latest deploy, budgets and what needs your attention.'
                      : page === 'projects'
                        ? 'Every app in this workspace.'
                        : page === 'templates'
                          ? `${frameworks.length} starter kits to start from. A GitHub repository on any of their runtimes imports as it is.`
                          : page === 'activity'
                            ? 'A record of what happens in your workspace.'
                            : page === 'connections'
                              ? 'GitHub for your code, Cloudflare for where it runs.'
                              : page === 'plan'
                                ? 'Shipcel’s Free plan, and what this workspace uses of it.'
                                : page === 'developers'
                                  ? 'Deploy from your terminal, an AI agent or a script.'
                                  : page === 'variables'
                                    ? 'Secrets several projects use, set on each of them at once.'
                                    : page === 'agents'
                                      ? 'Connect Claude Code, Codex, Cursor or another agent you use.'
                                      : page === 'team'
                                        ? 'The people who share this workspace, and what each may do.'
                                        : page === 'invite'
                                          ? 'Accept an invitation to a shared workspace.'
                                          : 'Your apps, in your own Cloudflare account.'}
                  </p>
                </div>
                {['overview', 'projects'].includes(page) && !viewer && (
                  <button
                    className="button primary"
                    onClick={() => create('react')}
                  >
                    <Plus size={17} />
                    New project
                  </button>
                )}
              </div>

              {page === 'overview' && (
                <>
                  <section
                    className="overview-strip"
                    aria-label="Workspace status"
                  >
                    <div>
                      <span>
                        <Rocket size={16} />
                        Last deploy
                      </span>
                      {lastDeploy ? (
                        <>
                          <strong className="stat-text">
                            {lastDeploy.project.name}:{' '}
                            {deployStatus(
                              lastDeploy.project,
                              lastDeploy.job,
                            ).toLowerCase()}
                            ,{' '}
                            {formatDate(
                              new Date(
                                lastDeploy.job.updated_at * 1000,
                              ).toISOString(),
                            )}
                          </strong>
                          <button
                            className="text-link"
                            onClick={() =>
                              openTab(lastDeploy.project, 'deployments')
                            }
                          >
                            Open its deployments <ArrowUpRight size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <strong className="stat-text">No deploys yet</strong>
                          <small>
                            From GitHub, the terminal, a dropped folder or an AI
                            agent.
                          </small>
                        </>
                      )}
                    </div>
                    <div>
                      <span>
                        <Wallet size={16} />
                        Budgets
                      </span>
                      <strong className="stat-text">{budgetLine}</strong>
                      <button className="text-link" onClick={() => go('plan')}>
                        Plan & usage <ArrowUpRight size={13} />
                      </button>
                    </div>
                    <div>
                      <span>
                        <Bell size={16} />
                        Needs attention
                      </span>
                      {attention.length ? (
                        <ul className="attention-list">
                          {attention.map((item) => (
                            <li key={item.text}>
                              <button className="text-link" onClick={item.go}>
                                {item.text} <ArrowUpRight size={13} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <strong className="stat-text">Nothing right now</strong>
                      )}
                    </div>
                  </section>
                  <div className="section-heading">
                    <div>
                      <h2>
                        Your projects{' '}
                        <span className="count">{projects.length}</span>
                      </h2>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => go('projects')}
                    >
                      View all projects <ArrowRight size={15} />
                    </button>
                  </div>
                  {loading ? (
                    <div className="loading">
                      <LoaderCircle className="spin" size={20} />
                      Loading your workspace…
                    </div>
                  ) : projects.length ? (
                    <ProjectList
                      status={status}
                      projects={projects.slice(0, 3)}
                      onSelect={open}
                    />
                  ) : (
                    <div className="empty-projects">
                      <div className="empty-project-icon">
                        <Folder size={23} />
                        <span>
                          <Plus size={11} />
                        </span>
                      </div>
                      <div>
                        <h3>No projects yet</h3>
                        <p>
                          Start from a starter kit or a GitHub repository, or
                          run <code>shipcel</code> in your app’s folder.
                        </p>
                      </div>
                      <button
                        className="button secondary"
                        onClick={() => create('react')}
                      >
                        Create project <ArrowRight size={15} />
                      </button>
                    </div>
                  )}
                  <div className="section-heading template-heading">
                    <div>
                      <h2>Starter kits</h2>
                      <p>
                        A working app to start from, with its Cloudflare
                        configuration.
                      </p>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => go('templates')}
                    >
                      Explore app catalog <ArrowRight size={15} />
                    </button>
                  </div>
                  <div className="quick-templates">
                    {(['react', 'nextjs', 'hono', 'wordpress'] as const).map(
                      (id) => {
                        const f = getFramework(id);
                        return (
                          <button
                            className="quick-template"
                            key={id}
                            onClick={() => create(id)}
                          >
                            <FrameworkIcon framework={f} />
                            <h3>
                              {f.name}
                              <ArrowUpRight size={15} />
                            </h3>
                            <p>{f.subtitle}</p>
                            <span className="stage-text ready">
                              <span />
                              Starter kit
                            </span>
                          </button>
                        );
                      },
                    )}
                  </div>
                </>
              )}

              {page === 'projects' && (
                <>
                  <div className="list-toolbar">
                    <label className="search-field">
                      <Search size={17} />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search projects…"
                        aria-label="Search projects"
                      />
                    </label>
                    <label className="select-field">
                      <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        aria-label="Filter projects by framework"
                      >
                        <option value="all">All frameworks</option>
                        {frameworks.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} />
                    </label>
                    <span className="result-count">
                      {visible.length} project{visible.length !== 1 && 's'}
                    </span>
                  </div>
                  {loading ? (
                    <div className="loading">
                      <LoaderCircle className="spin" size={20} />
                      Loading projects…
                    </div>
                  ) : visible.length ? (
                    <ProjectList
                      status={status}
                      projects={visible}
                      onSelect={open}
                    />
                  ) : (
                    <div className="large-empty">
                      <Layers3 size={32} />
                      <h2>
                        {query || filter !== 'all'
                          ? 'No matching projects'
                          : 'No projects yet'}
                      </h2>
                      <p>
                        {query || filter !== 'all'
                          ? 'Try a different name or framework.'
                          : 'Start from a starter kit or a GitHub repository, or run shipcel in your app’s folder.'}
                      </p>
                      <button
                        className="button primary"
                        onClick={() =>
                          query || filter !== 'all'
                            ? (setQuery(''), setFilter('all'))
                            : create('react')
                        }
                      >
                        {query || filter !== 'all'
                          ? 'Clear filters'
                          : 'Create project'}
                      </button>
                    </div>
                  )}
                </>
              )}

              {page === 'templates' && (
                <>
                  <div className="catalog-grid">
                    {frameworks.map((f) => (
                      <button
                        className="catalog-card"
                        key={f.id}
                        onClick={() => create(f.id)}
                      >
                        <div className="catalog-card-top">
                          <FrameworkIcon framework={f} />
                          <Badge tone="green">Starter kit</Badge>
                        </div>
                        <h2>
                          {f.name}
                          <ArrowUpRight size={16} />
                        </h2>
                        <p>{f.description}</p>
                        <div className="runtime-label">
                          <Cloud size={14} />
                          {f.runtime}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {page === 'activity' && (
                <section className="panel activity-panel">
                  <div className="panel-heading">
                    <h2>Workspace activity</h2>
                    <Badge>Latest 100 events</Badge>
                  </div>
                  {activity.length ? (
                    activity.map((event) => (
                      <div className="activity-row" key={event.id}>
                        <div
                          className={`activity-symbol ${event.kind === 'project.deleted' ? 'muted' : ''}`}
                        >
                          {event.kind === 'kit.exported' ? (
                            <ArrowDownToLine size={17} />
                          ) : event.kind === 'project.deleted' ? (
                            <Trash2 size={17} />
                          ) : (
                            <Plus size={17} />
                          )}
                        </div>
                        <div>
                          <strong>{actionNames[event.kind]}</strong>
                          <span>{event.projectName}</span>
                        </div>
                        <time dateTime={event.createdAt}>
                          {formatDate(event.createdAt)}
                        </time>
                      </div>
                    ))
                  ) : (
                    <div className="large-empty">
                      <ActivityIcon size={30} />
                      <h2>No activity yet</h2>
                      <p>
                        Projects created and removed, and starter kits exported,
                        appear here.
                      </p>
                      <button
                        className="button secondary"
                        onClick={() => create('react')}
                      >
                        Create project
                      </button>
                    </div>
                  )}
                </section>
              )}

              {page === 'connections' && (
                <ConnectionsPanel session={session} onRefresh={refresh} />
              )}
              {page === 'plan' && <PlanPanel />}
              {page === 'developers' && <DevelopersPanel />}
              {page === 'variables' && <SharedVariablesPanel />}
              {page === 'agents' && (
                <AgentsPanel onTokens={() => go('developers')} />
              )}
              {page === 'team' &&
                (workspace && !session?.user?.local ? (
                  <TeamPanel
                    workspace={workspace}
                    login={session!.user!.login}
                    onChanged={refresh}
                  />
                ) : (
                  <section className="panel operation-body">
                    <p>
                      Teams need a GitHub sign-in: each person signs in with
                      their own GitHub account.
                    </p>
                  </section>
                ))}
              {page === 'invite' && (
                <InvitationPage
                  code={cliCode}
                  onJoined={async () => {
                    await refresh();
                    go('overview');
                  }}
                />
              )}

              {page === 'guide' && <Guide onCreate={() => create('react')} />}
            </>
          )}
          <footer className="page-footer">
            <span>
              <img src="/favicon.svg" alt="" />
              Shipcel
            </span>
            <span>Cloudflare bills your apps’ usage to your account.</span>
          </footer>
        </main>
      </div>
      {creating && (
        <CreateProject
          initial={creating}
          github={connectionStatus?.github}
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            setDetailTab(
              project.source === 'github' ? 'deployments' : 'overview',
            );
            setSelected(project);
            setPage('projects');
            history.replaceState(null, '', '#projects');
            void refresh();
            setToast(
              project.source === 'github'
                ? 'Project created. Review the repository and deploy.'
                : 'Project created.',
            );
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={18} />
          {toast}
          <button
            className="icon-button"
            onClick={() => setToast('')}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectList({
  projects,
  status,
  onSelect,
}: {
  projects: Project[];
  status: (p: Project) => string;
  onSelect: (p: Project) => void;
}) {
  return (
    <div className="project-list">
      {projects.map((project) => {
        const f = getFramework(project.framework);
        return (
          <button
            className="project-row"
            key={project.id}
            onClick={() => onSelect(project)}
          >
            <FrameworkIcon framework={f} small />
            <div className="project-name">
              <strong>{project.name}</strong>
              <span>
                {project.repository
                  ? project.repository.replace('https://github.com/', '')
                  : f.subtitle}
              </span>
            </div>
            <span className="project-runtime">{f.runtime}</span>
            <div className="resource-icons">
              {project.database && (
                <Database size={16} aria-label="D1 database planned" />
              )}
              {project.storage && (
                <HardDrive size={16} aria-label="R2 bucket planned" />
              )}
            </div>
            <Badge tone={statusTone(status(project))}>{status(project)}</Badge>
            <BudgetBadge project={project} />
            <ChevronRight size={17} className="row-chevron" />
          </button>
        );
      })}
    </div>
  );
}

// A new project starts from a starter kit or from a GitHub repository, never both: only the
// chosen path's fields show. Kits include runtimes still in research, saved as plans.
const choice = (list: readonly Framework[], id: FrameworkId) =>
  list.some((f) => f.id === id) ? id : 'react';

function CreateProject({
  initial,
  github,
  onClose,
  onCreated,
}: {
  initial: FrameworkId;
  github: ConnectionStatus['github'] | undefined;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState<ProjectSource>('kit');
  const [name, setName] = useState('');
  // Whether the person typed the name; until then it follows the chosen repository.
  const [named, setNamed] = useState(false);
  // A starter kit is chosen; a repository's runtime is read from the repository itself.
  const [kitFramework, setKitFramework] = useState(choice(frameworks, initial));
  const [database, setDatabase] = useState(false);
  const [storage, setStorage] = useState(false);
  const [freeOnly, setFreeOnly] = useState(true);
  const [repository, setRepository] = useState('');
  // What the chosen repository runs, from its root files; `error` when it couldn't be read.
  const [detected, setDetected] = useState<{
    repository: string;
    framework: FrameworkId | null;
    error?: string;
  } | null>(null);
  const latest = useRef('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const detectedFramework =
    detected?.repository === repository ? detected.framework : null;
  const framework = source === 'kit' ? kitFramework : detectedFramework;
  const f = getFramework(kitFramework);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  function chooseKit(next: FrameworkId) {
    setKitFramework(next);
    setDatabase((prev) => allowsBindings(next) && prev);
    setStorage((prev) => allowsBindings(next) && prev);
  }
  function switchSource(next: ProjectSource) {
    setSource(next);
    setError('');
    // A starter kit has no repository.
    setRepository('');
    setDetected(null);
    latest.current = '';
  }
  // The repository's root files say what it runs, as Vercel detects a framework on import.
  async function chooseRepository(fullName: string) {
    latest.current = fullName;
    setRepository(fullName);
    setDetected(null);
    if (!fullName) return;
    if (!named) setName(projectNameFrom(fullName.split('/')[1]));
    let found: FrameworkId | null = null;
    let error: string | undefined;
    try {
      found = (
        await api<{ framework: FrameworkId | null }>(
          `/repositories/detect?repository=${encodeURIComponent(fullName)}`,
        )
      ).framework;
    } catch (e) {
      error = (e as Error).message;
    }
    if (latest.current !== fullName) return;
    setDetected({
      repository: fullName,
      framework: found && hasImportAdapter(found) ? found : null,
      ...(error ? { error } : {}),
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    const input: ProjectInput =
      source === 'kit'
        ? {
            name,
            framework: kitFramework,
            source,
            repository: '',
            database,
            storage,
            freeOnly,
          }
        : {
            name,
            framework: detectedFramework ?? 'static',
            source,
            repository: repository ? `https://github.com/${repository}` : '',
            database: false,
            storage: false,
            freeOnly,
          };
    const parsed = projectSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const project = await api<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      capture('project_created', {
        source: parsed.data.source,
        framework: parsed.data.framework,
        has_database: parsed.data.database,
        has_storage: parsed.data.storage,
        free_only: parsed.data.freeOnly,
      });
      onCreated(project);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const nameField = (
    <>
      <label className="field-label" htmlFor="project-name">
        Project name
      </label>
      <input
        autoFocus={source === 'kit'}
        id="project-name"
        className="text-input"
        placeholder="my-app"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNamed(true);
        }}
        maxLength={48}
        required
      />
      <p className="field-hint">Lowercase letters, numbers, and hyphens.</p>
    </>
  );
  const freeOnlyField = (
    <>
      <label
        className={`resource-option free-only-option ${freeOnly ? 'checked' : ''}`}
      >
        <ShieldCheck size={20} />
        <div>
          <strong>Free-only</strong>
          <span>
            Shipcel won’t create anything Cloudflare can bill for: no R2 storage
            or containers. Everything else stops at Cloudflare’s free limits
            while your account stays on Workers Free.
          </span>
        </div>
        <input
          type="checkbox"
          checked={freeOnly}
          onChange={(e) => {
            setFreeOnly(e.target.checked);
            if (e.target.checked) setStorage(false);
          }}
        />
      </label>
      {freeOnly && usesContainers(framework) && (
        <p className="field-hint">
          Containers need Cloudflare’s Workers Paid plan ($5 a month). Turn off
          Free-only to create this project.
        </p>
      )}
    </>
  );
  const waiting =
    source === 'github' &&
    (!github?.connected || !repository || !detectedFramework);
  return (
    <dialog
      ref={dialog}
      className="create-dialog"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !busy) onClose();
      }}
      aria-labelledby="create-title"
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <h2 id="create-title">Create a project</h2>
            <p>From a starter kit or one of your GitHub repositories.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close create project"
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">
          <fieldset className="source-choice">
            <legend className="field-label">Start from</legend>
            <label
              className={`source-option ${source === 'kit' ? 'checked' : ''}`}
            >
              <input
                type="radio"
                name="source"
                checked={source === 'kit'}
                onChange={() => switchSource('kit')}
              />
              <div>
                <strong>Starter kit</strong>
                <span>
                  A ready-made app to export, push to GitHub, and deploy.
                </span>
              </div>
            </label>
            <label
              className={`source-option ${source === 'github' ? 'checked' : ''}`}
            >
              <input
                type="radio"
                name="source"
                checked={source === 'github'}
                onChange={() => switchSource('github')}
              />
              <div>
                <strong>GitHub repository</strong>
                <span>Deploy an app you already have on GitHub.</span>
              </div>
            </label>
          </fieldset>
          {source === 'kit' ? (
            <>
              {nameField}
              <label className="field-label" htmlFor="framework">
                Starter kit
              </label>
              <div className="framework-select">
                <FrameworkIcon framework={f} small />
                <select
                  id="framework"
                  value={kitFramework}
                  onChange={(e) => chooseKit(e.target.value as FrameworkId)}
                >
                  {frameworks.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} />
              </div>
              <div className="framework-info">
                <span>{f.runtime}</span>
                <p>{f.description}</p>
              </div>
              {allowsBindings(kitFramework) && (
                <>
                  <div className="field-label resources-label">
                    Add to your infrastructure
                  </div>
                  <label
                    className={`resource-option ${database ? 'checked' : ''}`}
                  >
                    <Database size={20} />
                    <div>
                      <strong>SQL database</strong>
                      <span>Cloudflare D1, binding: DB</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={database}
                      onChange={(e) => setDatabase(e.target.checked)}
                    />
                  </label>
                  <label
                    className={`resource-option ${storage ? 'checked' : ''} ${freeOnly ? 'disabled' : ''}`}
                  >
                    <HardDrive size={20} />
                    <div>
                      <strong>File storage</strong>
                      <span>
                        {freeOnly
                          ? 'Cloudflare R2 can bill beyond 10 GB. Turn off Free-only to add it.'
                          : 'Cloudflare R2, binding: FILES, bills beyond its free tier'}
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={storage}
                      disabled={freeOnly}
                      onChange={(e) => setStorage(e.target.checked)}
                    />
                  </label>
                </>
              )}
              {freeOnlyField}
            </>
          ) : !github?.connected ? (
            <div className="setup-required">
              <Github size={21} />
              <div>
                <strong>Connect GitHub to choose a repository</strong>
                <p>Shipcel lists the repositories you grant its GitHub App.</p>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  onClose();
                  location.hash = 'connections';
                }}
              >
                Open Connections
                <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            <>
              <RepositoryPicker
                value={repository}
                onChange={(next) => void chooseRepository(next)}
                installUrl={github.installUrl}
                disabled={busy}
              />
              {nameField}
              <p className="field-label" id="runtime">
                Framework or runtime
              </p>
              {!repository ? (
                <p className="field-hint">
                  Shipcel reads the repository you choose and detects what it
                  runs.
                </p>
              ) : detected?.repository !== repository ? (
                <p className="field-hint" role="status">
                  Reading {repository}…
                </p>
              ) : detected.framework ? (
                <div
                  className="framework-select detected-runtime"
                  role="status"
                  aria-labelledby="runtime"
                >
                  <FrameworkIcon
                    framework={getFramework(detected.framework)}
                    small
                  />
                  <span>
                    <strong>{getFramework(detected.framework).name}</strong>,
                    detected from {repository}
                  </span>
                </div>
              ) : (
                <div className="inline-error" role="alert">
                  {detected.error ? (
                    <>
                      Shipcel couldn’t read {repository}: {detected.error}{' '}
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => void chooseRepository(repository)}
                      >
                        Try again
                      </button>
                    </>
                  ) : (
                    `Shipcel couldn’t tell what ${repository} runs: its root has no package.json, Wrangler configuration, pyproject.toml or index.html. Choose another repository, or add one of them and push.`
                  )}
                </div>
              )}
              {freeOnlyField}
            </>
          )}
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <span>
            <ShieldCheck size={15} />
            No cloud resources created
          </span>
          <button className="button primary" disabled={busy || waiting}>
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Plus size={17} />
            )}
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

type DetailTab = 'overview' | 'configuration' | 'deployments' | 'operations';
function ProjectDetail({
  project,
  initialTab,
  status,
  onBack,
  onRefresh,
  onDeleted,
  notify,
  owner,
}: {
  project: Project;
  initialTab: DetailTab;
  // Not deployed, Building, Live, Failed or Paused (deployStatus).
  status: string;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onDeleted: () => void;
  notify: (s: string) => void;
  // Billing decisions (budgets, pausing) are a workspace owner's.
  owner: boolean;
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  // The project page has an address (#projects/<id>/<tab>), so a tab can be linked
  // to and comes back after a reload. Manage adds its own section after the tab.
  useEffect(() => {
    const address = `#projects/${project.id}/${tab}`;
    if (!location.hash.startsWith(address))
      history.replaceState(null, '', address);
  }, [project.id, tab]);
  const [config, setConfig] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const f = getFramework(project.framework);
  // A project from GitHub deploys its repository; only kit projects export a kit.
  const kit = hasKit(project.framework) && project.source === 'kit';
  const importable = hasImportAdapter(project.framework);
  useEffect(() => {
    if (kit)
      void api<Record<string, unknown>>(`/projects/${project.id}/config`)
        .then((data) => setConfig(JSON.stringify(data, null, 2)))
        .catch((error) => setError(error.message));
  }, [project.id, kit]);
  async function exportProject() {
    setBusy(true);
    setError('');
    try {
      await downloadKit(project.id, project.name);
      capture('starter_kit_exported', { framework: project.framework });
      await onRefresh();
      notify('Starter kit downloaded. Follow the included README to deploy.');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setFreeOnly(freeOnly: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(`/projects/${project.id}/free-only`, {
        method: 'PUT',
        body: JSON.stringify(
          freeOnly ? { freeOnly } : { freeOnly, confirm: true },
        ),
      });
      setConfirmPaid(false);
      await onRefresh();
      notify(
        freeOnly
          ? 'Free-only is on: Shipcel won’t create anything that can bill.'
          : 'Free-only is off: R2 storage and containers are allowed, and Cloudflare may bill for them.',
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeProject() {
    setBusy(true);
    setError('');
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' });
      capture('project_deleted', {
        source: project.source,
        framework: project.framework,
      });
      onDeleted();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        All projects
      </button>
      <div className="detail-heading">
        <FrameworkIcon framework={f} />
        <div>
          <h1>{project.name}</h1>
          <p>
            {f.name}, created {formatDate(project.createdAt)}
          </p>
        </div>
        <Badge tone={statusTone(status)}>{status}</Badge>
        <Badge tone={project.freeOnly ? 'green' : 'warning'}>
          {project.freeOnly ? 'Free-only' : 'Paid features allowed'}
        </Badge>
        <BudgetBadge project={project} />
        {kit && (
          <button
            className="button primary"
            onClick={() => void exportProject()}
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ArrowDownToLine size={16} />
            )}
            Export starter kit
          </button>
        )}
      </div>
      <div className="tabs">
        <button
          className={tab === 'overview' ? 'active' : ''}
          aria-current={tab === 'overview' ? 'page' : undefined}
          onClick={() => setTab('overview')}
        >
          Overview
        </button>
        {importable && (
          <button
            className={tab === 'operations' ? 'active' : ''}
            aria-current={tab === 'operations' ? 'page' : undefined}
            onClick={() => setTab('operations')}
          >
            Manage
          </button>
        )}
        {importable && (
          <button
            className={tab === 'deployments' ? 'active' : ''}
            aria-current={tab === 'deployments' ? 'page' : undefined}
            onClick={() => setTab('deployments')}
          >
            Deployments
          </button>
        )}
        {kit && (
          <button
            className={tab === 'configuration' ? 'active' : ''}
            aria-current={tab === 'configuration' ? 'page' : undefined}
            onClick={() => setTab('configuration')}
          >
            Configuration
          </button>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {tab === 'overview' ? (
        <div className="detail-grid">
          <div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Deployment plan</h2>
                <Badge>Configuration</Badge>
              </div>
              <div className="detail-panel-content">
                <p>{f.description}</p>
                <div className="plan-resource">
                  <Zap size={20} />
                  <div>
                    <strong>{f.runtime}</strong>
                    <span>
                      {kit
                        ? 'Included in your starter configuration'
                        : importable
                          ? 'Configured in your repository'
                          : 'Adapter validation pending'}
                    </span>
                  </div>
                  <Badge>
                    {kit ? 'Configured' : importable ? 'Repository' : 'Planned'}
                  </Badge>
                </div>
                {project.database && (
                  <div className="plan-resource">
                    <Database size={20} />
                    <div>
                      <strong>D1 SQL database</strong>
                      <span>DB binding, created on the first deploy</span>
                    </div>
                    <Badge>Draft binding</Badge>
                  </div>
                )}
                {project.storage && (
                  <div className="plan-resource">
                    <HardDrive size={20} />
                    <div>
                      <strong>R2 object storage</strong>
                      <span>FILES binding, created on the first deploy</span>
                    </div>
                    <Badge>Draft binding</Badge>
                  </div>
                )}
                {project.framework === 'wordpress' && (
                  <div className="requirements-box">
                    <strong>Before WordPress can be hosted</strong>
                    <ul>
                      <li>External MySQL service and database credentials</li>
                      <li>Durable media uploads, plugins, and themes</li>
                      <li>Container restart and update compatibility</li>
                      <li>
                        Cron, transactional email, backups, and restore tests
                      </li>
                    </ul>
                    <p>
                      Cloudflare container disk is ephemeral by default. These
                      requirements are not provisioned by this alpha.
                    </p>
                    <p>
                      What works today: export the site to files with a
                      static-export plugin and deploy the folder with{' '}
                      <code>shipcel deploy</code>, or keep WordPress as the
                      editor and deploy a front end that reads its REST API.
                    </p>
                  </div>
                )}
                <a
                  className="text-link"
                  href={f.docs}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the runtime documentation <ArrowUpRight size={14} />
                </a>
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>Billing</h2>
                <Badge tone={project.freeOnly ? 'green' : 'warning'}>
                  {project.freeOnly ? 'Free-only' : 'Can bill'}
                </Badge>
              </div>
              <div className="detail-panel-content">
                {project.freeOnly ? (
                  <p>
                    Shipcel won’t create anything Cloudflare can bill for in
                    this project: no R2 storage and no containers. Workers,
                    static files, D1, KV and Durable Objects stop at
                    Cloudflare’s free limits instead of billing, as long as the
                    Cloudflare account stays on the Workers Free plan.
                  </p>
                ) : (
                  <p>
                    This project may use R2 storage and containers. Cloudflare
                    bills R2 beyond its free tier, and containers need Workers
                    Paid ($5 a month per account) plus usage.
                  </p>
                )}
                {project.freeOnly ? (
                  confirmPaid ? (
                    <div className="delete-project">
                      <p>
                        Allow R2 storage and containers? Cloudflare may bill
                        your account for them.
                      </p>
                      <div>
                        <button
                          className="button danger"
                          disabled={busy}
                          onClick={() => void setFreeOnly(false)}
                        >
                          Turn off Free-only
                        </button>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => setConfirmPaid(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirmPaid(true)}
                    >
                      Allow paid features
                    </button>
                  )
                ) : (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void setFreeOnly(true)}
                  >
                    Turn on Free-only
                  </button>
                )}
                <BudgetGuard
                  projectId={project.id}
                  owner={owner}
                  notify={notify}
                  onChanged={onRefresh}
                />
              </div>
            </section>
            <section className="panel source-panel">
              <div className="panel-heading">
                <h2>Source repository</h2>
                <Github size={18} />
              </div>
              <div className="detail-panel-content">
                {project.repository ? (
                  <a
                    className="repo-link"
                    href={project.repository}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {project.repository.replace('https://github.com/', '')}
                    <ExternalLink size={14} />
                  </a>
                ) : (
                  <strong>No repository added</strong>
                )}
                <p>
                  Connect a repository on Deployments, and every push to it
                  deploys.
                </p>
              </div>
            </section>
          </div>
          <aside>
            <section className="next-steps">
              <h2>
                {kit
                  ? 'Deploy this starter kit'
                  : importable
                    ? 'Deploy this repository'
                    : 'Next steps'}
              </h2>
              {importable && !kit ? (
                <>
                  <ol>
                    <li>
                      <span>1</span>
                      <div>
                        <strong>Configure the adapter</strong>
                        <p>
                          Run <code>npx wrangler setup</code> in your
                          repository, review the changes, and commit them with
                          package-lock.json.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>Connect your accounts</strong>
                        <p>
                          Connect GitHub and choose a Cloudflare account in
                          Connections.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>Review and deploy</strong>
                        <p>
                          Inspect the repository, review the resources it
                          requests, and approve the exact commit.
                        </p>
                      </div>
                    </li>
                  </ol>
                  <button
                    className="button primary full"
                    onClick={() => setTab('deployments')}
                  >
                    <Zap size={16} />
                    Open deployments
                  </button>
                </>
              ) : kit ? (
                <>
                  <ol>
                    <li>
                      <span>1</span>
                      <div>
                        <strong>Download the starter kit</strong>
                        <p>
                          Its source, its Wrangler configuration and a README
                          with each command.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>Sign in with Wrangler</strong>
                        <p>
                          In the kit’s folder, run <code>npm install</code>,
                          then <code>npx wrangler login</code> for the
                          Cloudflare account it goes to.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>Deploy</strong>
                        <p>
                          Run <code>npm run deploy</code>. To deploy every push
                          instead, put the kit on GitHub and connect it on
                          Deployments.
                        </p>
                      </div>
                    </li>
                  </ol>
                  <button
                    className="button primary full"
                    onClick={() => void exportProject()}
                    disabled={busy}
                  >
                    <ArrowDownToLine size={16} />
                    {busy ? 'Preparing…' : 'Download starter kit'}
                  </button>
                </>
              ) : null}
              <div className="ownership-small">
                <ShieldCheck size={16} />
                <span>
                  Your infrastructure bill goes directly to Cloudflare.
                </span>
              </div>
            </section>
            <div className="delete-project">
              {confirmDelete ? (
                <>
                  <p>
                    Remove this project? Shipcel stops tracking its deployments.
                    Exported files, cloud resources and auto-deploy triggers
                    stay in your Cloudflare account.
                  </p>
                  <div>
                    <button
                      className="button danger"
                      disabled={busy}
                      onClick={() => void removeProject()}
                    >
                      Remove
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="text-link muted"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={14} />
                  Remove project
                </button>
              )}
            </div>
          </aside>
        </div>
      ) : tab === 'operations' ? (
        <OperationsPanel project={project} />
      ) : tab === 'deployments' ? (
        <DeploymentPanel project={project} onRefresh={onRefresh} />
      ) : (
        <section className="panel config-panel">
          <div className="panel-heading">
            <h2>
              <FileCode2 size={17} />
              wrangler.json
            </h2>
            <button
              className="text-link"
              disabled={!config}
              onClick={() =>
                void navigator.clipboard
                  .writeText(config)
                  .then(() => notify('Configuration copied.'))
                  .catch(() =>
                    setError(
                      'Clipboard unavailable. Select the configuration text to copy it.',
                    ),
                  )
              }
            >
              Copy configuration
            </button>
          </div>
          <pre>{config || 'Loading configuration…'}</pre>
          <p>
            Resource IDs are placeholders until you create resources in your
            account. The exported deploy script checks D1 IDs before deployment.
          </p>
        </section>
      )}
    </>
  );
}

function Guide({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="guide-layout">
      <section className="panel">
        <div className="panel-heading">
          <h2>Ways to deploy</h2>
        </div>
        <div className="guide-steps">
          {[
            {
              icon: Github,
              title: 'From GitHub',
              text: 'Connect GitHub and Cloudflare in Connections, create a project from a repository and deploy it from its Deployments tab. Every push to the production branch deploys again.',
            },
            {
              icon: Terminal,
              title: 'From your terminal',
              text: (
                <>
                  Run <code>shipcel</code> in your app’s folder: it signs you in
                  once, recognises the framework, builds on your computer and
                  deploys. API & CLI has the install command.
                </>
              ),
            },
            {
              icon: Folder,
              title: 'Drag and drop',
              text: 'Drop a built folder, such as dist, on a project’s Deployments tab. A new app stays unpublished, with only its preview address working, until you publish it.',
            },
            {
              icon: Box,
              title: 'A starter kit',
              text: `Pick one of the ${frameworks.length} kits in the App catalog: a working app with its Cloudflare configuration, to download and deploy.`,
            },
            {
              icon: Bot,
              title: 'Your AI agent',
              text: 'Connect Claude Code, Codex, Cursor or another agent in AI agents. It can create projects, deploy and roll back for you.',
            },
          ].map((way) => (
            <div className="guide-step" key={way.title}>
              <div>
                <h3>
                  <way.icon size={18} />
                  {way.title}
                </h3>
                <p>{way.text}</p>
              </div>
            </div>
          ))}
          <button className="button primary" onClick={onCreate}>
            Create a project <ArrowRight size={16} />
          </button>
        </div>
      </section>
      <aside>
        <div className="guide-aside">
          <CircleHelp size={23} />
          <h2>More in the docs</h2>
          <p>Each way in, step by step, and what common messages mean.</p>
          <a
            className="text-link"
            href="/docs/getting-started/"
            target="_blank"
            rel="noreferrer"
          >
            Getting started <ArrowUpRight size={14} />
          </a>
          <h3>What’s built</h3>
          <p>Every feature, marked built, beta or not yet.</p>
          <a
            className="text-link"
            href="/features/"
            target="_blank"
            rel="noreferrer"
          >
            Features <ArrowUpRight size={14} />
          </a>
        </div>
      </aside>
    </div>
  );
}
