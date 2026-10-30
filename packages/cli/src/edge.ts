// What Cloudflare does in front of an app: shipcel cache purge (its custom domains' cache),
// shipcel security (the firewall of their zones) and shipcel redirects (the `_redirects`
// file Workers reads from the app's static files). Redirects ship with the app's files, so
// a change applies with the next deploy.
import {
  CliError,
  confirmed,
  decode,
  join,
  resolve,
  table,
  text,
  type Args,
  type Client,
  type Io,
  type Project,
} from './core.ts';

export async function cache(io: Io, args: Args, api: Client, project: Project) {
  const [, sub, ...urls] = args._;
  if (sub !== 'purge')
    throw new CliError(
      'shipcel cache purge [url…] empties the cache of the app’s custom domains.',
      2,
    );
  for (const url of urls)
    if (!/^https?:\/\//.test(url))
      throw new CliError(
        `${url} isn't a web address: give whole URLs, such as https://shop.example.com/logo.png.`,
        2,
      );
  await confirmed(
    io,
    args,
    urls.length
      ? `Purge ${urls.length} URL${urls.length === 1 ? '' : 's'} from Cloudflare's cache?`
      : `Purge everything Cloudflare has cached for ${project.name}'s custom domains?`,
  );
  const { purged } = await api.call<{
    purged: { hosts?: string[]; urls?: string[] };
  }>(`/projects/${project.id}/cache/purge`, {
    method: 'POST',
    body: { ...(urls.length ? { urls } : {}), confirm: true },
  });
  io.out(
    purged.urls
      ? `Purged ${purged.urls.length} URL${purged.urls.length === 1 ? '' : 's'}.`
      : `Purged the cache of ${purged.hosts!.join(', ')}.`,
  );
}

// security -----------------------------------------------------------------------------

type FirewallRule = {
  id: string;
  action: string;
  summary: string;
  enabled: boolean;
  ours: boolean;
};
type Zone = {
  id: string;
  name: string;
  hosts: string[];
  managed: boolean | null;
  bots: boolean | null;
  aiBots: boolean | null;
  underAttack: boolean | null;
  rules: FirewallRule[] | null;
  rateLimits:
    | (FirewallRule & { requests: number | null; period: number | null })[]
    | null;
  denied: string[];
};
type Security = { workersDev: boolean | null; zones: Zone[] };
// The settings that cover a whole zone, by the word the command takes.
const SETTINGS = {
  managed: { field: 'managed', label: 'Free Managed Ruleset', note: '' },
  bots: {
    field: 'bots',
    label: 'Bot Fight Mode',
    note: ' It may challenge API clients and mobile apps too.',
  },
  'ai-bots': { field: 'aiBots', label: 'AI crawler blocking', note: '' },
  'under-attack': {
    field: 'underAttack',
    label: 'Under Attack mode',
    note: ' Every visitor gets a challenge page first.',
  },
} as const;
type Setting = keyof typeof SETTINGS;
const MATCHES = { country: 'countries', ip: 'IPs', path: 'path' } as const;
type SecurityRequest =
  | { kind: 'ls' }
  | { kind: 'setting'; key: Setting; on: boolean }
  | {
      kind: 'rule';
      action: 'block' | 'challenge';
      match: keyof typeof MATCHES;
      values: string[];
    }
  | { kind: 'rm'; id: string }
  | { kind: 'rate-limit'; path: string; requests: number }
  | { kind: 'rate-limit-off' };
const NO_DOMAIN =
  "This app has no custom domain. Cloudflare's DDoS protection covers its workers.dev address, but the firewall belongs to a domain's zone: shipcel domains add <hostname>.";

// What was asked, checked before anything is asked or sent.
function securityRequest(sub: string, rest: string[]): SecurityRequest {
  if (sub === 'ls' || sub === 'status') return { kind: 'ls' };
  if (Object.keys(SETTINGS).includes(sub)) {
    if (rest[0] !== 'on' && rest[0] !== 'off')
      throw new CliError(`shipcel security ${sub} on|off`, 2);
    return { kind: 'setting', key: sub as Setting, on: rest[0] === 'on' };
  }
  if (sub === 'block' || sub === 'challenge') {
    const [match = '', ...words] = rest;
    const values = words
      .flatMap((w) => w.split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      !Object.keys(MATCHES).includes(match) ||
      !values.length ||
      (match === 'path' && values.length !== 1)
    )
      throw new CliError(
        `shipcel security ${sub} country <codes…> | ip <addresses…> | path <path>`,
        2,
      );
    return {
      kind: 'rule',
      action: sub,
      match: match as keyof typeof MATCHES,
      values,
    };
  }
  if (sub === 'rm' || sub === 'remove') {
    if (!/^[a-f0-9]{32}$/.test(rest[0] ?? ''))
      throw new CliError(
        'shipcel security rm <rule id>, as shipcel security lists it',
        2,
      );
    return { kind: 'rm', id: rest[0] };
  }
  if (sub === 'rate-limit') {
    if (rest[0] === 'off') return { kind: 'rate-limit-off' };
    const [path, requests] = rest;
    if (!path?.startsWith('/') || !/^\d+$/.test(requests ?? ''))
      throw new CliError(
        'shipcel security rate-limit <path> <requests per 10 seconds> | off',
        2,
      );
    return { kind: 'rate-limit', path, requests: Number(requests) };
  }
  throw new CliError(
    `Unknown command security ${sub}. Run shipcel help security.`,
    2,
  );
}

const onOff = (value: boolean | null) =>
  value === null ? 'not shown' : value ? 'on' : 'off';

function showSecurity(io: Io, s: Security) {
  if (!s.zones.length) io.out(NO_DOMAIN);
  for (const zone of s.zones) {
    io.out(`${zone.name}: ${zone.hosts.join(', ')}`);
    for (const line of table([
      ['Setting', 'State'],
      ...Object.values(SETTINGS).map((x) => [x.label, onOff(zone[x.field])]),
    ]))
      io.out(line);
    if (zone.rules?.length)
      for (const line of table([
        ['Rule', 'What it does', 'Made by'],
        ...zone.rules.map((r) => [
          r.id,
          `${r.summary}${r.enabled ? '' : ' (off)'}`,
          r.ours ? 'this app' : 'elsewhere',
        ]),
      ]))
        io.out(line);
    else if (zone.rules)
      io.out('No rules. shipcel security block country <code> adds one.');
    for (const r of zone.rateLimits ?? [])
      io.out(
        `Rate limit: ${r.summary}${r.enabled ? '' : ' (off)'}, ${r.ours ? 'set by this app' : 'made elsewhere'}.`,
      );
    if (zone.rateLimits && !zone.rateLimits.length)
      io.out('No rate limit. shipcel security rate-limit /api 100 sets one.');
    if (zone.denied.length)
      io.out(
        `Not shown: this Cloudflare connection has no ${zone.denied.join(' or ')} permission. Cloudflare sign-ins set up from 23 October 2026 ask for it; set up an older one again on Connections.`,
      );
  }
  if (s.zones.length && s.workersDev)
    io.out(
      "This app also answers at its workers.dev address, which Cloudflare's DDoS protection covers but no zone firewall does. shipcel unpublish turns it off.",
    );
}

export async function security(
  io: Io,
  args: Args,
  api: Client,
  project: Project,
) {
  const [, sub = 'ls', ...rest] = args._;
  const request = securityRequest(sub, rest);
  const root = `/projects/${project.id}/security`;
  const current = await api.call<Security>(root);
  if (request.kind === 'ls') {
    if (args.flags.json) io.out(JSON.stringify(current, null, 2));
    else showSecurity(io, current);
    return;
  }
  if (!current.zones.length) throw new CliError(NO_DOMAIN);
  const zones = current.zones.map((z) => z.name).join(', ');
  const whole = current.zones.length === 1 ? 'the zone' : 'these zones';
  switch (request.kind) {
    case 'setting': {
      const setting = SETTINGS[request.key];
      const state = request.on ? 'on' : 'off';
      await confirmed(
        io,
        args,
        `Turn ${setting.label} ${state} for ${zones}? It covers every host name in ${whole}.${request.on ? setting.note : ''}`,
      );
      await api.call(root, {
        method: 'PUT',
        body: { [setting.field]: request.on, confirm: true },
      });
      io.out(`${setting.label} is ${state} for ${zones}.`);
      return;
    }
    case 'rule': {
      await confirmed(
        io,
        args,
        `${request.action === 'block' ? 'Block' : 'Challenge'} ${MATCHES[request.match]} ${request.values.join(', ')} on ${current.zones.flatMap((z) => z.hosts).join(', ')}?`,
      );
      const { added, summary } = await api.call<{
        added: { zone: string; id: string }[];
        summary: string;
      }>(`${root}/rules`, {
        method: 'POST',
        body: {
          action: request.action,
          match: request.match,
          values: request.values,
          confirm: true,
        },
      });
      for (const a of added)
        io.out(`Added rule ${a.id} on ${a.zone}: ${summary}.`);
      return;
    }
    case 'rm':
      await confirmed(io, args, `Remove rule ${request.id}?`);
      await api.call(`${root}/rules/${request.id}`, {
        method: 'DELETE',
        body: { confirm: true },
      });
      io.out(`Removed rule ${request.id}.`);
      return;
    case 'rate-limit': {
      await confirmed(
        io,
        args,
        `Allow each visitor at most ${request.requests} requests per 10 seconds to ${request.path} on ${zones}? It counts that path on every host name in ${whole}.`,
      );
      const updated = await api.call<Security>(`${root}/rate-limit`, {
        method: 'PUT',
        body: { path: request.path, requests: request.requests, confirm: true },
      });
      for (const zone of updated.zones) {
        const ours = zone.rateLimits?.find((r) => r.ours);
        if (ours)
          io.out(
            `${zone.name}: ${ours.summary}. It counts that path on every host name in the zone.`,
          );
      }
      return;
    }
    case 'rate-limit-off': {
      await confirmed(io, args, `Remove this app's rate limit from ${zones}?`);
      const { removed } = await api.call<{ removed: string[] }>(
        `${root}/rate-limit`,
        { method: 'DELETE', body: { confirm: true } },
      );
      io.out(`Removed the rate limit from ${removed.join(', ')}.`);
    }
  }
}

// redirects ----------------------------------------------------------------------------

// Workers' limits for `_redirects`: 2,000 static and 100 dynamic rules, 1,000 characters each.
const LIMITS = { static: 2000, dynamic: 100, line: 1000 };
const CODES = ['301', '302', '303', '307', '308'];
type Rule = { line: number; from: string; to: string; code: string };
const dynamic = (from: string) => /[*:]/.test(from);

// The project's `_redirects`: where its static files come from (public/ or static/ in most
// frameworks), or the folder itself for a folder of files.
async function redirectsFile(io: Io, args: Args) {
  const named = text(args.flags.file);
  if (named) return resolve(io.cwd, named);
  for (const dir of ['public', 'static', ''])
    if (await io.fs.exists(join(io.cwd, dir, '_redirects')))
      return join(io.cwd, dir, '_redirects');
  for (const dir of ['public', 'static'])
    if (await io.fs.exists(join(io.cwd, dir)))
      return join(io.cwd, dir, '_redirects');
  return join(io.cwd, '_redirects');
}

function parse(content: string) {
  const rules: Rule[] = [];
  const problems: string[] = [];
  content.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [from, to, code = '302', ...extra] = line.split(/\s+/);
    if (raw.length > LIMITS.line)
      problems.push(`Line ${i + 1} is over ${LIMITS.line} characters.`);
    if (!from?.startsWith('/') || !to || extra.length || !CODES.includes(code))
      problems.push(
        `Line ${i + 1} isn't "/from /to [${CODES.join('|')}]": ${line}`,
      );
    else rules.push({ line: i + 1, from, to, code });
  });
  const counts = {
    dynamic: rules.filter((r) => dynamic(r.from)).length,
    static: rules.filter((r) => !dynamic(r.from)).length,
  };
  if (counts.static > LIMITS.static)
    problems.push(
      `${counts.static} static redirects: Workers takes ${LIMITS.static}.`,
    );
  if (counts.dynamic > LIMITS.dynamic)
    problems.push(
      `${counts.dynamic} dynamic redirects: Workers takes ${LIMITS.dynamic}.`,
    );
  return { rules, problems, counts };
}

const apply =
  'They apply to the app’s static files from the next deploy (shipcel --prod), not to requests its code answers.';

export async function redirects(io: Io, args: Args) {
  const [, sub = 'ls', ...rest] = args._;
  const file = await redirectsFile(io, args);
  const shown = file.startsWith(`${io.cwd}/`)
    ? file.slice(io.cwd.length + 1)
    : file;
  const content = (await io.fs.exists(file))
    ? decode(await io.fs.readFile(file))
    : '';
  const { rules, problems, counts } = parse(content);
  if (sub === 'ls' || sub === 'list') {
    if (args.flags.json) {
      io.out(JSON.stringify({ file: shown, rules, problems }));
      return;
    }
    if (!rules.length)
      io.out(
        `No redirects in ${shown}. Add one: shipcel redirects add /old /new`,
      );
    else {
      for (const line of table([
        ['From', 'To', 'Status'],
        ...rules.map((r) => [r.from, r.to, r.code]),
      ]))
        io.out(line);
      io.out(
        `${rules.length} redirect${rules.length === 1 ? '' : 's'} (${counts.dynamic} dynamic) in ${shown}. ${apply}`,
      );
    }
    for (const p of problems) io.out(`Problem: ${p}`);
    if (problems.length) throw new CliError(`Fix ${shown} before deploying.`);
    return;
  }
  if (sub === 'add') {
    const [from, to] = rest;
    const code = text(args.flags.status) ?? '301';
    if (
      !from?.startsWith('/') ||
      !to ||
      !(to.startsWith('/') || /^https?:\/\//.test(to))
    )
      throw new CliError(
        'shipcel redirects add /from /to [--status 301], such as shipcel redirects add /old /new',
        2,
      );
    if (!CODES.includes(code))
      throw new CliError(`--status takes ${CODES.join(', ')}.`, 2);
    if (/\s/.test(from + to))
      throw new CliError('A redirect’s paths have no spaces.', 2);
    if (rules.some((r) => r.from === from))
      throw new CliError(
        `${from} already redirects. shipcel redirects rm ${from} first.`,
      );
    const next = parse(
      `${content}${content && !content.endsWith('\n') ? '\n' : ''}${from} ${to} ${code}\n`,
    );
    if (next.problems.length > problems.length)
      throw new CliError(next.problems.at(-1)!);
    await io.fs.writeFile(
      file,
      `${content}${content && !content.endsWith('\n') ? '\n' : ''}${from} ${to} ${code}\n`,
    );
    io.out(`Added ${from} → ${to} (${code}) to ${shown}. ${apply}`);
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const [from] = rest;
    if (!from) throw new CliError('shipcel redirects rm /from', 2);
    const gone = rules.filter((r) => r.from === from).map((r) => r.line);
    if (!gone.length)
      throw new CliError(`${shown} has no redirect from ${from}.`);
    await io.fs.writeFile(
      file,
      content
        .split('\n')
        .filter((_, i) => !gone.includes(i + 1))
        .join('\n'),
    );
    io.out(`Removed ${from} from ${shown}. ${apply}`);
    return;
  }
  throw new CliError(
    `Unknown command redirects ${sub}. Run shipcel help redirects.`,
    2,
  );
}
