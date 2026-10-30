// Account commands that follow Vercel's CLI: tokens, teams, usage, alerts, webhooks, dns
// and pricing. They read Shipcel's API. What a token may not do by itself (create a token,
// set up a webhook, change a team) goes through the browser: a token is created on the
// approval page `shipcel login` uses, and the rest names the dashboard page.
import {
  checkedOn,
  shipcelFree,
  cloudflareFree,
  workersPaid,
} from '../../../shared/pricing.ts';
import {
  CliError,
  ago,
  browserApproval,
  client,
  confirmed,
  dashboard,
  readConfig,
  table,
  text,
  writeConfig,
  type Args,
  type Client,
  type Io,
  type Project,
} from './core.ts';

const isoOf = (seconds: number) => new Date(seconds * 1000).toISOString();
const since = (seconds: number) => `${ago(isoOf(seconds))} ago`;
const dayOf = (seconds: number) => isoOf(seconds).slice(0, 10);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
// The plans' inline markup, for a terminal.
const plain = (text: string) =>
  text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
const page = (api: Client, hash: string) => `${api.url}/app/#${hash}`;
export const PLANS = {
  free: 'Workers Free',
  paid: 'Workers Paid',
  unknown: 'unknown, estimated as Workers Paid',
};

// tokens -------------------------------------------------------------------------------

type Token = {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  // The token this command came with.
  current: boolean;
};
// A token made from the terminal always expires (Shipcel refuses more than a year).
const TOKEN_DAYS = { usual: 90, most: 365 };

export async function tokens(io: Io, args: Args, api: Client) {
  const [, sub = 'ls'] = args._;
  if (sub === 'ls' || sub === 'list') return listTokens(io, args, api);
  if (sub === 'add' || sub === 'create') return addToken(io, args, api);
  if (sub === 'rm' || sub === 'remove' || sub === 'revoke')
    return removeToken(io, args, api);
  throw new CliError(
    `Unknown command tokens ${sub}. Run shipcel help tokens.`,
    2,
  );
}

async function listTokens(io: Io, args: Args, api: Client) {
  const list = await api.call<Token[]>('/tokens');
  if (args.flags.json) {
    io.out(JSON.stringify(list));
    return;
  }
  if (!list.length) {
    io.out('No API tokens. Create one: shipcel tokens add <name>');
    return;
  }
  for (const line of table([
    ['Name', 'Prefix', 'Created', 'Last used', 'Expires'],
    ...list.map((t) => [
      t.current ? `${t.name} (this computer)` : t.name,
      t.prefix,
      since(t.createdAt),
      t.lastUsedAt ? since(t.lastUsedAt) : 'never',
      t.expiresAt ? dayOf(t.expiresAt) : 'never',
    ]),
  ]))
    io.out(line);
}

function expiryDays(api: Client, flag: string | boolean | undefined) {
  const value = text(flag);
  if (value === undefined) return TOKEN_DAYS.usual;
  if (value === 'never')
    throw new CliError(
      `A token without an end date is made in the dashboard: ${page(api, 'developers')}`,
    );
  const days = Number(value.replace(/d$/, ''));
  if (!Number.isInteger(days) || days < 1 || days > TOKEN_DAYS.most)
    throw new CliError(
      `--expires takes a number of days from 1 to ${TOKEN_DAYS.most}, such as --expires 30.`,
      2,
    );
  return days;
}

// The same page as `shipcel login`: the person approves, in the browser, the token this
// asks for; the CLI shows it once and keeps nothing.
async function addToken(io: Io, args: Args, api: Client) {
  const name = args._.slice(2).join(' ').trim();
  if (!name)
    throw new CliError(
      'Name the token: shipcel tokens add <name>, such as shipcel tokens add "CI deploy".',
      2,
    );
  if (name.length > 60)
    throw new CliError('A token’s name is at most 60 characters.', 2);
  const days = expiryDays(api, args.flags.expires);
  // A deploy token: it deploys one project and nothing else, for a CI system that signs in
  // with a secret (Bitbucket Pipelines, Gitea Actions, GitLab on a host of its own).
  const wanted = text(args.flags.project);
  const project = wanted
    ? ((await api.call<Project[]>('/projects')).find(
        (p) => p.name === wanted || p.id === wanted,
      ) ?? null)
    : null;
  if (wanted && !project)
    throw new CliError(`There is no project ${wanted}. shipcel ls lists them.`);
  const created = await browserApproval(
    io,
    client(io, api.url),
    {
      host: io.hostname.slice(0, 64),
      token: {
        name,
        expiresInDays: days,
        ...(project ? { projectId: project.id } : {}),
      },
    },
    {
      approve: 'approve the token',
      denied: 'The token was denied in the browser; none was created.',
      expired: 'The code expired. Run shipcel tokens add again.',
    },
  );
  if (args.flags.json) {
    io.out(
      JSON.stringify({
        id: created.id,
        name: created.name,
        token: created.token,
        expiresAt: created.expiresAt,
      }),
    );
    return;
  }
  io.out(
    project
      ? `Created the deploy token ${name}, which deploys only ${project.name}, until ${dayOf(created.expiresAt as number)}. Shipcel shows it only now:`
      : `Created the token ${name}, which acts as you until ${dayOf(created.expiresAt as number)}. Shipcel shows it only now:`,
  );
  io.out(created.token as string);
  io.out(
    'In CI, set it as SHIPCEL_TOKEN, with SHIPCEL_URL. shipcel tokens rm revokes it.',
  );
}

async function removeToken(io: Io, args: Args, api: Client) {
  const ref = args._.slice(2).join(' ').trim();
  if (!ref)
    throw new CliError(
      'Say which token: shipcel tokens rm <name|prefix>. shipcel tokens ls lists them.',
      2,
    );
  const list = await api.call<Token[]>('/tokens');
  const found = list.filter(
    (t) => t.id === ref || t.prefix === ref || t.name === ref,
  );
  if (!found.length)
    throw new CliError(`No token ${ref}. shipcel tokens ls lists them.`);
  if (found.length > 1)
    throw new CliError(
      `${found.length} tokens are called ${ref}. Name one by its prefix: ${found.map((t) => t.prefix).join(', ')}.`,
    );
  const [token] = found;
  await confirmed(
    io,
    args,
    token.current
      ? `Revoke ${token.name} (${token.prefix}), the token this command signs in with? You'll need shipcel login again.`
      : `Revoke ${token.name} (${token.prefix})? Anything that uses it stops working.`,
  );
  await api.call(`/tokens/${token.id}`, { method: 'DELETE' });
  // Forget it here too when it is the one this computer saved.
  const config = await readConfig(io);
  const saved = !!config.token?.startsWith(token.prefix);
  if (saved) await writeConfig(io, { url: config.url });
  io.out(
    `Revoked ${token.name}.${saved ? ' This computer is signed out: shipcel login signs in again.' : ''}`,
  );
}

// teams --------------------------------------------------------------------------------

type Workspace = {
  id: string;
  name: string;
  kind: string;
  role: string;
  current: boolean;
};

export async function teams(io: Io, args: Args, api: Client) {
  const [, sub = 'ls'] = args._;
  if (['add', 'create', 'invite', 'rm', 'remove', 'members'].includes(sub))
    throw new CliError(
      `Teams are made, and people invited, changed or removed, in the dashboard by an owner: ${page(api, 'team')}`,
    );
  if (sub !== 'ls' && sub !== 'list')
    throw new CliError(
      `Unknown command teams ${sub}. Run shipcel help teams.`,
      2,
    );
  const list = await api.call<Workspace[]>('/me/workspaces');
  if (args.flags.json) {
    io.out(JSON.stringify(list));
    return;
  }
  for (const line of table([
    ['Workspace', 'Role', 'Kind'],
    ...list.map((w) => [
      w.current ? `${w.name} (this sign-in)` : w.name,
      w.role,
      w.kind === 'team' ? 'team' : 'personal',
    ]),
  ]))
    io.out(line);
  if (list.length > 1)
    io.out(
      'A sign-in works in one workspace: shipcel switch signs in to another.',
    );
}

// usage --------------------------------------------------------------------------------

type Usage = {
  month: string;
  plan: keyof typeof PLANS | null;
  account: { cents: number; readAt: number } | null;
  notEstimated: string;
  projects: {
    name: string;
    estimateCents: number;
    projectedCents: number;
    budgetCents: number;
    onExceed: 'alert' | 'pause';
    state: 'ok' | 'over' | 'paused';
    readAt: number | null;
  }[];
};

export async function usage(io: Io, args: Args, api: Client) {
  const u = await api.call<Usage>('/usage');
  if (args.flags.json) {
    io.out(JSON.stringify(u));
    return;
  }
  const month = new Date(`${u.month}-01T00:00:00Z`).toLocaleDateString(
    'en-US',
    { month: 'long', year: 'numeric', timeZone: 'UTC' },
  );
  if (!u.projects.length) {
    io.out(
      `${month}: no deployed app has been read yet. The budget guard reads each app's usage from Cloudflare every five minutes once it is deployed.`,
    );
    return;
  }
  io.out(`${month} so far${u.plan ? `, on ${PLANS[u.plan]}` : ''}.`);
  if (u.account)
    io.out(
      `The whole Cloudflare account, beyond what Cloudflare includes: ${dollars(u.account.cents)} (read ${since(u.account.readAt)}).`,
    );
  for (const line of table([
    ['Project', 'This month', 'By month end', 'Budget', 'Over it'],
    ...u.projects.map((p) => [
      `${p.name}${p.state === 'paused' ? ' (paused)' : ''}`,
      p.readAt ? dollars(p.estimateCents) : 'not read yet',
      p.readAt ? dollars(p.projectedCents) : '',
      dollars(p.budgetCents),
      p.onExceed === 'pause' ? 'pause' : 'alert only',
    ]),
  ]))
    io.out(line);
  io.out(
    `Costs beyond what Cloudflare includes, from Cloudflare's usage figures. ${u.notEstimated}`,
  );
}

// alerts -------------------------------------------------------------------------------

type Alert = {
  project: string;
  kind: string;
  severity: 'error' | 'warning';
  message: string;
  at: number;
};

// The linked project's, or (--all, or in a folder that isn't linked) the workspace's.
export async function alerts(
  io: Io,
  args: Args,
  api: Client,
  project: Project | null,
) {
  const { alerts: found } = await api.call<{ alerts: Alert[] }>(
    `/alerts${project ? `?project=${encodeURIComponent(project.id)}` : ''}`,
  );
  if (args.flags.json) {
    io.out(JSON.stringify(found));
    return;
  }
  if (!found.length) {
    io.out(
      project
        ? `Nothing needs attention in ${project.name}.`
        : 'Nothing needs attention.',
    );
    return;
  }
  for (const line of table([
    ['When', 'Project', 'Alert'],
    ...found.map((a) => [
      since(a.at),
      a.project,
      `${a.severity === 'error' ? 'Error' : 'Warning'}: ${a.message}`,
    ]),
  ]))
    io.out(line);
}

// webhooks -----------------------------------------------------------------------------

type Webhook = {
  host: string;
  events: string[];
  lastStatus: string | null;
  lastError: string | null;
  lastSentAt: number | null;
};

// Each project's webhook (an owner's to see). Adding, testing and removing one stays in the
// dashboard, so a token can't send a project's events somewhere new.
export async function webhooks(
  io: Io,
  args: Args,
  api: Client,
  project: Project | null,
  everyProject: () => Promise<Project[]>,
) {
  const [, sub = 'ls'] = args._;
  if (['add', 'create', 'rm', 'remove', 'test'].includes(sub))
    throw new CliError(
      `Webhooks are added, tested and removed in the dashboard, under Manage → Notifications, so a token can't send your projects' events somewhere new: ${project ? dashboard(api, project, 'operations') : page(api, 'projects')}`,
    );
  if (sub !== 'ls' && sub !== 'list')
    throw new CliError(
      `Unknown command webhooks ${sub}. Run shipcel help webhooks.`,
      2,
    );
  const projects = project ? [project] : await everyProject();
  const found: { project: string; webhook: Webhook | null }[] = [];
  for (const p of projects)
    found.push({
      project: p.name,
      webhook: (
        await api.call<{ webhook: Webhook | null }>(
          `/projects/${p.id}/notifications`,
        )
      ).webhook,
    });
  if (args.flags.json) {
    io.out(JSON.stringify(found));
    return;
  }
  if (!found.length) {
    io.out('No projects yet.');
    return;
  }
  for (const { project: name, webhook } of found) {
    if (!webhook) {
      io.out(`${name}: no webhook.`);
      continue;
    }
    const last = webhook.lastSentAt
      ? `last sent ${since(webhook.lastSentAt)}: ${webhook.lastStatus ?? 'unknown'}${webhook.lastError ? ` (${webhook.lastError})` : ''}`
      : 'nothing sent yet';
    io.out(
      `${name}: ${webhook.host}, for ${webhook.events.length ? `${webhook.events.join(', ')} and ` : ''}budget alerts; ${last}.`,
    );
  }
}

// pricing ------------------------------------------------------------------------------

// Shipcel's plan and Cloudflare's, from the same data as the site's /pricing/. A word
// narrows it down: shipcel pricing d1.
export function pricing(io: Io, args: Args, url: string | null) {
  const query = args._.slice(1).join(' ').trim().toLowerCase();
  const has = (...texts: string[]) =>
    !query || texts.some((t) => t.toLowerCase().includes(query));
  const ours = shipcelFree.map(plain).filter((t) => has('Shipcel Free', t));
  const theirs = cloudflareFree.filter((r) =>
    has(r.service, `Workers Free: ${r.free}`, `Workers Paid: ${r.paid}`),
  );
  const paidNotes = workersPaid.map(plain).filter((t) => has(t));
  const full = url ? ` The whole table: ${url}/pricing/` : '';
  if (args.flags.json) {
    io.out(
      JSON.stringify({
        checkedOn,
        shipcelFree: ours,
        cloudflare: theirs,
        workersPaid: paidNotes,
      }),
    );
    return;
  }
  if (!ours.length && !theirs.length && !paidNotes.length)
    throw new CliError(`Nothing about “${query}” in the plans.${full}`);
  if (!query)
    io.out(
      'Shipcel is free: $0 a month, no card, up to 100 projects (shipcel pricing shipcel lists everything in it).',
    );
  else if (ours.length) {
    io.out('Shipcel Free, $0 a month:');
    for (const t of ours) io.out(`  ${t}`);
  }
  if (theirs.length) {
    io.out(
      `Cloudflare, in your own account (list prices, checked ${checkedOn}):`,
    );
    for (const r of theirs) {
      io.out(`  ${r.service}`);
      io.out(`    Workers Free: ${r.free}`);
      io.out(`    Workers Paid: ${r.paid}`);
    }
  }
  if (query && paidNotes.length) for (const t of paidNotes) io.out(`  ${t}`);
  if (!query)
    io.out(
      `Workers Paid is $5 a month per Cloudflare account. Narrow it down: shipcel pricing d1.${full}`,
    );
}

// dns ----------------------------------------------------------------------------------

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  priority?: number;
};

// The DNS records of the zones in the workspace's Cloudflare account, in Vercel's order:
// shipcel dns add <domain> <name> <type> <value>.
export async function dnsCommand(io: Io, args: Args, api: Client) {
  const [, sub = 'ls', zone, ...rest] = args._;
  if (sub === 'ls' || sub === 'list') {
    if (!zone) {
      const zones =
        await api.call<{ name: string; status: string | null }[]>('/dns');
      if (args.flags.json) {
        io.out(JSON.stringify(zones));
        return;
      }
      if (!zones.length) {
        io.out(
          'The connected Cloudflare account has no zones. Add your domain to Cloudflare first.',
        );
        return;
      }
      for (const line of table([
        ['Zone', 'Status'],
        ...zones.map((z) => [z.name, z.status ?? '']),
      ]))
        io.out(line);
      return;
    }
    const { records } = await api.call<{ records: DnsRecord[] }>(
      `/dns/${encodeURIComponent(zone)}/records`,
    );
    if (args.flags.json) {
      io.out(JSON.stringify(records));
      return;
    }
    if (!records.length) {
      io.out(`${zone} has no DNS records.`);
      return;
    }
    for (const line of table([
      ['ID', 'Type', 'Name', 'Value', 'Proxied', 'TTL'],
      ...records.map((r) => [
        r.id,
        r.type,
        r.name,
        `${r.priority !== undefined ? `${r.priority} ` : ''}${r.content}`,
        r.proxied ? 'yes' : 'no',
        r.ttl === 1 ? 'auto' : String(r.ttl),
      ]),
    ]))
      io.out(line);
    return;
  }
  if (sub === 'add' || sub === 'create') {
    const [name, type, ...value] = rest;
    if (!zone || !name || !type || !value.length)
      throw new CliError(
        'shipcel dns add <domain> <name> <type> <value>, such as shipcel dns add example.com www CNAME shop.example.net',
        2,
      );
    const upper = type.toUpperCase();
    const ttl = text(args.flags.ttl);
    const priority = text(args.flags.priority);
    const body: Record<string, unknown> = {
      type: upper,
      name,
      content:
        upper === 'MX' && value.length > 1 && !priority
          ? value[1]
          : value.join(' '),
      ...(ttl ? { ttl: ttl === 'auto' ? 1 : Number(ttl) } : {}),
      ...(args.flags.proxied ? { proxied: true } : {}),
      ...(upper === 'MX'
        ? { priority: Number(priority ?? (value.length > 1 ? value[0] : NaN)) }
        : {}),
      confirm: true,
    };
    await confirmed(
      io,
      args,
      `Add ${upper} ${name} → ${String(body.content)} to ${zone}?`,
    );
    const created = await api.call<DnsRecord>(
      `/dns/${encodeURIComponent(zone)}/records`,
      {
        method: 'POST',
        body,
      },
    );
    if (args.flags.json) {
      io.out(JSON.stringify(created));
      return;
    }
    io.out(
      `Added ${created.type} ${created.name} → ${created.content} (${created.id}).`,
    );
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const [id] = rest;
    if (!zone || !id)
      throw new CliError(
        'shipcel dns rm <domain> <record id>. shipcel dns ls <domain> lists the IDs.',
        2,
      );
    const { records } = await api.call<{ records: DnsRecord[] }>(
      `/dns/${encodeURIComponent(zone)}/records`,
    );
    const found = records.find((r) => r.id === id);
    if (!found)
      throw new CliError(
        `${zone} has no record ${id}. shipcel dns ls ${zone} lists them.`,
      );
    await confirmed(
      io,
      args,
      `Delete ${found.type} ${found.name} → ${found.content} from ${zone}? What uses it stops resolving.`,
    );
    await api.call(`/dns/${encodeURIComponent(zone)}/records/${id}`, {
      method: 'DELETE',
      body: { confirm: true },
    });
    io.out(`Deleted ${found.type} ${found.name}.`);
    return;
  }
  throw new CliError(`Unknown command dns ${sub}. Run shipcel help dns.`, 2);
}
