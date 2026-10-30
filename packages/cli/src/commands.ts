// Everyday commands that follow Vercel's CLI: dev, pull, crons, rolling-release, metrics,
// budget, curl, httpstat, api, mcp, agent, upgrade. Each one calls Shipcel's existing API (or runs
// a tool on this computer); cli.ts signs in, finds the project and dispatches here.
import { WRANGLER_VERSION } from '../../../shared/local-deploy.ts';
import {
  packageManager,
  parseManifest,
  wranglerFiles,
} from '../../../shared/site-presets.ts';
import { PLANS } from './account.ts';
import {
  CliError,
  change,
  confirmed,
  decode,
  join,
  table,
  text,
  type Args,
  type Client,
  type Io,
  type Job,
  type Project,
} from './core.ts';

type Version = {
  id: string;
  live: number | null;
  previewUrl?: string | null;
};
const short = (id: string) => id.slice(0, 8);
const read = async (io: Io, path: string) =>
  (await io.fs.exists(path)) ? decode(await io.fs.readFile(path)) : null;

// dev ----------------------------------------------------------------------------------

// The command that runs this folder locally: the project's own dev script, or Wrangler's
// local runtime for a Worker or a folder of files.
export async function devCommand(io: Io, outputDirectory?: string) {
  const manifest = parseManifest(
    (await read(io, join(io.cwd, 'package.json'))) ?? '',
  );
  const files: Record<string, string | null> = {};
  for (const name of [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    ...wranglerFiles,
    'index.html',
  ])
    files[name] = (await io.fs.exists(join(io.cwd, name))) ? 'present' : null;
  const manager = packageManager(files, manifest ?? undefined);
  for (const script of ['dev', 'start'])
    if (manifest?.scripts?.[script]) return `${manager} run ${script}`;
  const wrangler = (await io.fs.exists(
    join(io.cwd, 'node_modules', 'wrangler', 'package.json'),
  ))
    ? 'npx wrangler'
    : `npx --yes wrangler@${WRANGLER_VERSION}`;
  if (wranglerFiles.some((name) => files[name])) return `${wrangler} dev`;
  const folder =
    outputDirectory &&
    (await io.fs.exists(join(io.cwd, outputDirectory, 'index.html')))
      ? outputDirectory
      : files['index.html']
        ? '.'
        : null;
  return folder ? `${wrangler} dev --assets ${folder}` : null;
}

export async function dev(io: Io, outputDirectory?: string) {
  const command = await devCommand(io, outputDirectory);
  if (!command)
    throw new CliError(
      'Shipcel doesn’t know how to run this folder: it has no dev or start script in package.json, no Wrangler configuration and no index.html.',
    );
  io.out(`Running: ${command}`);
  const code = await io.run(command, io.cwd);
  if (code !== 0)
    throw new CliError(`${command} stopped (exit code ${code}).`, code);
}

// env pull -----------------------------------------------------------------------------

// Writes the names of the app's variables to a local file. Cloudflare never returns a
// secret's value, so secrets arrive empty, to fill in for local development; build
// variables that aren't secret come with their values. What the file already holds stays.
export async function envPull(
  io: Io,
  args: Args,
  api: Client,
  project: Project,
  named?: string,
) {
  const hasWrangler = (
    await Promise.all(
      wranglerFiles.map((name) => io.fs.exists(join(io.cwd, name))),
    )
  ).some(Boolean);
  // Wrangler's local runtime reads .dev.vars; other tools read .env.local, as on Vercel.
  const file = named ?? (hasWrangler ? '.dev.vars' : '.env.local');
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(file) || file.split('/').includes('..'))
    throw new CliError(
      'Name a file inside this folder, such as .env.local.',
      2,
    );
  const secrets = await api
    .call<{ name: string }[]>(`/projects/${project.id}/secrets`)
    .catch((error: unknown) => {
      if (
        error instanceof CliError &&
        /Deploy this project/.test(error.message)
      )
        return [];
      throw error;
    });
  // Build variables exist only for apps Cloudflare builds from GitHub.
  const built = await api.raw(
    `/projects/${project.id}/build-variables?environment=production`,
    undefined,
    'GET',
  );
  const variables =
    built.status === 200
      ? (built.data.variables as {
          name: string;
          secret: boolean;
          value: string | null;
        }[])
      : [];
  const wanted = new Map<string, string>();
  for (const s of secrets) wanted.set(s.name, '');
  for (const v of variables)
    if (!wanted.has(v.name))
      wanted.set(v.name, v.secret ? '' : (v.value ?? ''));
  const path = join(io.cwd, file);
  const current = (await read(io, path)) ?? '';
  const present = new Set(
    current
      .split(/\r?\n/)
      .map(
        (line) =>
          /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1],
      )
      .filter(Boolean),
  );
  const added = [...wanted].filter(([name]) => !present.has(name));
  if (args.flags.json) {
    io.out(JSON.stringify({ file, added: added.map(([name]) => name) }));
  }
  if (!added.length) {
    if (!args.flags.json)
      io.out(
        wanted.size
          ? `${file} already names all ${wanted.size} of ${project.name}’s variables.`
          : `${project.name} has no secrets or build variables yet. Add one with shipcel env add <NAME>.`,
      );
    return;
  }
  const quoted = (value: string) =>
    /^[\w./:@-]*$/.test(value) ? value : JSON.stringify(value);
  const lines = [
    ...(current
      ? []
      : [
          `# Variables of ${project.name}, from shipcel env pull. Cloudflare never returns a`,
          '# secret’s value: fill in the ones you need locally. Keep this file out of Git.',
        ]),
    ...added.map(([name, value]) => `${name}=${quoted(value)}`),
  ];
  await io.fs.writeFile(
    path,
    `${current}${current && !current.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`,
    0o600,
  );
  if (!args.flags.json) {
    io.out(
      `Added ${added.length} name${added.length === 1 ? '' : 's'} to ${file}: ${added.map(([name]) => name).join(', ')}.`,
    );
    io.out(
      'Secret values aren’t readable from Cloudflare, so they are empty: fill in what you need for local development.',
    );
  }
}

// crons --------------------------------------------------------------------------------

export async function crons(io: Io, args: Args, api: Client, project: Project) {
  const [, sub = 'ls', expression] = args._;
  const base = `/projects/${project.id}/schedules`;
  const current = async () =>
    (await api.call<{ cron: string }[]>(base)).map((s) => s.cron);
  const set = (list: string[]) =>
    api.call(base, { method: 'PUT', body: change({ crons: list }) });
  const wanted = () => {
    const value = expression?.trim().replace(/\s+/g, ' ');
    if (!value)
      throw new CliError(
        `Give the schedule in quotes: shipcel crons ${sub} "0 10 * * *" (minute hour day month weekday, in UTC).`,
        2,
      );
    return value;
  };
  switch (sub) {
    case 'ls':
    case 'list': {
      const list = await current();
      if (args.flags.json) io.out(JSON.stringify(list));
      else if (!list.length)
        io.out(
          'No schedules. Add one with shipcel crons add "0 10 * * *"; the app needs a scheduled() handler.',
        );
      else for (const cron of list) io.out(cron);
      return;
    }
    case 'add': {
      const cron = wanted();
      const list = await current();
      if (list.includes(cron))
        throw new CliError(`${project.name} already runs on ${cron}.`);
      await set([...list, cron]);
      io.out(
        `Added the schedule ${cron} (UTC). Cloudflare calls the app’s scheduled() handler; each run counts as a request.`,
      );
      return;
    }
    case 'rm':
    case 'remove': {
      const cron = wanted();
      const list = await current();
      if (!list.includes(cron))
        throw new CliError(`${project.name} has no schedule ${cron}.`);
      await confirmed(
        io,
        args,
        `Remove the schedule ${cron} from ${project.name}?`,
      );
      await set(list.filter((c) => c !== cron));
      io.out(`Removed the schedule ${cron}.`);
      return;
    }
    case 'run':
      throw new CliError(
        'Cloudflare runs schedules itself and has no call that triggers one. To test the handler, run the app locally (shipcel dev) and open /cdn-cgi/handler/scheduled.',
      );
    default:
      throw new CliError(
        `Unknown command crons ${sub}. Run shipcel help crons.`,
        2,
      );
  }
}

// rolling-release ----------------------------------------------------------------------

// Sends a share of production traffic to a version, the rest staying on the one that
// serves now (Cloudflare's gradual deployments split between two versions).
export async function rollingRelease(
  io: Io,
  args: Args,
  api: Client,
  project: Project,
  versions: Version[],
  find: (ref: string) => Version,
) {
  const [, sub = 'status'] = args._;
  const live = versions.filter((v) => v.live !== null);
  const describe = (v: Version) => `${short(v.id)} ${v.live}%`;
  const all = (target: Version) =>
    api.call(`/projects/${project.id}/rollback`, {
      method: 'POST',
      body: change({ versionId: target.id }),
    });
  const target = () => {
    const ref = text(args.flags.dpl) ?? args._[2];
    if (!ref)
      throw new CliError(
        `Name the version: shipcel rolling-release ${sub} --dpl <version|preview url>.`,
        2,
      );
    return find(ref);
  };
  switch (sub) {
    case 'status': {
      if (args.flags.json) io.out(JSON.stringify(live));
      else if (live.length < 2)
        io.out(
          live.length
            ? `No rolling release: ${short(live[0].id)} serves all production traffic.`
            : 'This project serves no production traffic yet.',
        );
      else io.out(`Rolling release: ${live.map(describe).join(', ')}.`);
      return;
    }
    case 'start':
    case 'approve': {
      const to = target();
      const percent = Number(
        text(args.flags.percent) ?? (sub === 'start' ? '10' : ''),
      );
      if (!Number.isInteger(percent) || percent < 1 || percent > 99)
        throw new CliError(
          '--percent takes a share from 1 to 99. To send everything, use shipcel rolling-release complete.',
          2,
        );
      // The rest stays on the version that serves now.
      const others = live.filter((v) => v.id !== to.id);
      if (others.length !== 1)
        throw new CliError(
          live.length === 1 && live[0].id === to.id
            ? 'That version already serves all production traffic.'
            : 'Production has no single current version to share traffic with. Deploy to production first.',
        );
      if (sub === 'start' && live.length > 1)
        throw new CliError(
          `A rolling release is already running (${live.map(describe).join(', ')}). Move it on with approve, or end it with complete or abort.`,
        );
      if (sub === 'approve' && to.live === null)
        throw new CliError(
          `${short(to.id)} isn’t in a rolling release. Start one: shipcel rolling-release start --dpl ${short(to.id)}.`,
        );
      await confirmed(
        io,
        args,
        `Send ${percent}% of ${project.name}’s production traffic to ${short(to.id)}, and ${100 - percent}% to ${short(others[0].id)}?`,
      );
      await api.call(`/projects/${project.id}/traffic`, {
        method: 'POST',
        body: change({
          versions: [
            { versionId: to.id, percentage: percent },
            { versionId: others[0].id, percentage: 100 - percent },
          ],
        }),
      });
      io.out(
        `${short(to.id)} now serves ${percent}% of production traffic; ${short(others[0].id)} serves ${100 - percent}%.`,
      );
      io.out(
        `Next: shipcel rolling-release approve --dpl ${short(to.id)} --percent <more>, complete, or abort.`,
      );
      return;
    }
    case 'complete': {
      const to = target();
      if (to.live === 100)
        throw new CliError(
          'That version already serves all production traffic.',
        );
      await confirmed(
        io,
        args,
        `Send all of ${project.name}’s production traffic to ${short(to.id)}?`,
      );
      await all(to);
      io.out(`${short(to.id)} now serves all production traffic.`);
      return;
    }
    case 'abort': {
      if (live.length < 2) throw new CliError('No rolling release is running.');
      // Production goes back to the version that was serving: the other one when the
      // version being released is named, otherwise the one with the larger share.
      const ref = text(args.flags.dpl) ?? args._[2];
      const [first, second] = [...live].sort(
        (a, b) => (b.live ?? 0) - (a.live ?? 0),
      );
      if (!ref && first.live === second.live)
        throw new CliError(
          'Both versions serve the same share. Name the one being released: shipcel rolling-release abort --dpl <version>.',
        );
      const released = ref ? find(ref) : second;
      const back = live.find((v) => v.id !== released.id);
      if (!back || released.live === null)
        throw new CliError(
          `${short(released.id)} isn’t in the rolling release (${live.map(describe).join(', ')}).`,
        );
      await confirmed(
        io,
        args,
        `Send all of ${project.name}’s production traffic back to ${short(back.id)}?`,
      );
      await all(back);
      io.out(`Aborted: ${short(back.id)} serves all production traffic again.`);
      return;
    }
    default:
      throw new CliError(
        `Unknown command rolling-release ${sub}. Run shipcel help rolling-release.`,
        2,
      );
  }
}

// metrics ------------------------------------------------------------------------------

export async function metrics(
  io: Io,
  args: Args,
  api: Client,
  project: Project,
) {
  const since = text(args.flags.since) ?? '24h';
  if (since !== '24h' && since !== '7d' && since !== '30d')
    throw new CliError('--since takes 24h, 7d or 30d.', 2);
  const data = await api.call<{
    totals: {
      requests: number;
      errors: number;
      subrequests: number;
      cpuP50: number;
      cpuP99: number;
      wallP50?: number;
      wallP99?: number;
    };
    statuses: Record<string, number>;
  }>(`/projects/${project.id}/analytics?range=${since}`);
  if (args.flags.json) {
    io.out(JSON.stringify(data));
    return;
  }
  const { totals } = data;
  const share = totals.requests
    ? ` (${((totals.errors / totals.requests) * 100).toFixed(2)}%)`
    : '';
  io.out(
    `${project.name}, last ${since === '24h' ? '24 hours' : since === '7d' ? '7 days' : '30 days'}`,
  );
  for (const line of table([
    ['Requests', totals.requests.toLocaleString('en-US')],
    ['Errors', `${totals.errors.toLocaleString('en-US')}${share}`],
    ['Subrequests', totals.subrequests.toLocaleString('en-US')],
    ['Response time, median', `${totals.wallP50 ?? 0} ms`],
    ['Response time, 99th percentile', `${totals.wallP99 ?? 0} ms`],
    ['CPU time, median', `${totals.cpuP50} ms`],
    ['CPU time, 99th percentile', `${totals.cpuP99} ms`],
    ...Object.entries(data.statuses)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => [
        `Outcome: ${status}`,
        count.toLocaleString('en-US'),
      ]),
  ]))
    io.out(line);
}

// budget -------------------------------------------------------------------------------

type BudgetView = {
  budget: { monthlyCents: number; onExceed: 'alert' | 'pause' };
  deployed: boolean;
  labels: Record<string, string>;
  check: {
    plan: 'free' | 'paid' | 'unknown';
    estimateCents: number;
    accountCents: number;
    state: 'ok' | 'over' | 'paused';
    meters: { label: string; mine: number; included: number; cents: number }[];
    missing: { meters: string[]; reason: string }[];
    error: string | null;
  } | null;
};
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// The budget guard's reading of the project: what it costs this month beyond what
// Cloudflare includes, against its budget. An owner sets the budget, and pauses or resumes
// the app, in the dashboard: an API token can't.
export async function budget(
  io: Io,
  args: Args,
  api: Client,
  project: Project,
  dashboardUrl: string,
) {
  const [, sub = 'show'] = args._;
  if (sub !== 'show' && sub !== 'check')
    throw new CliError(
      `Unknown command budget ${sub}. Run shipcel help budget.`,
      2,
    );
  const view = await api.call<BudgetView>(
    `/projects/${project.id}/budget${sub === 'check' ? '/check' : ''}`,
    sub === 'check' ? { method: 'POST' } : {},
  );
  if (args.flags.json) {
    io.out(JSON.stringify(view));
    return;
  }
  const { budget: set, check } = view;
  io.out(
    `${project.name}: a budget of ${dollars(set.monthlyCents)} a month beyond what Cloudflare includes; over it, ${set.onExceed === 'pause' ? 'the app is paused' : 'an alert only'}.`,
  );
  if (!view.deployed)
    io.out('Nothing is deployed yet: the guard starts with the first deploy.');
  else if (!check) io.out('Not checked yet. Run shipcel budget check.');
  else {
    io.out(
      `This month so far: ${dollars(check.estimateCents)}${check.state === 'paused' ? ', over the budget: the app is PAUSED' : check.state === 'over' ? ', over the budget' : ''}. Cloudflare plan: ${PLANS[check.plan]}.`,
    );
    if (check.meters.length)
      for (const line of table([
        ['Usage', 'This app', 'Included', 'Cost'],
        ...check.meters.map((m) => [
          m.label,
          m.mine.toLocaleString('en-US', { maximumFractionDigits: 0 }),
          m.included.toLocaleString('en-US'),
          dollars(m.cents),
        ]),
      ]))
        io.out(`  ${line}`);
    if (check.accountCents > check.estimateCents)
      io.out(
        `The whole Cloudflare account, Workers Shipcel doesn't manage included: ${dollars(check.accountCents)}.`,
      );
    const unread = check.missing.flatMap((m) =>
      m.meters.map((meter) => view.labels[meter] ?? meter),
    );
    if (unread.length)
      io.out(
        `Cloudflare didn't report ${unread.join(', ')}, so the estimate may be low.`,
      );
    if (check.error) io.out(`The last check failed: ${check.error}`);
  }
  io.out(
    `An owner changes the budget, or pauses or resumes the app, in the dashboard: ${dashboardUrl}`,
  );
}

// curl, httpstat -----------------------------------------------------------------------

// The address a request goes to: production, or the preview address of one version.
function address(
  args: Args,
  job: Job | null,
  find: (ref: string) => Version,
  path = '/',
) {
  if (!path.startsWith('/') || /[\s'"\\`$]/.test(path))
    throw new CliError(
      'Give a path that starts with /, such as /api/hello.',
      2,
    );
  const ref = text(args.flags.deployment);
  const base = ref ? find(ref).previewUrl : job?.live_url;
  if (!base)
    throw new CliError(
      ref
        ? 'That version has no preview address.'
        : 'This project has no public address yet. Deploy it with shipcel --prod, or name a version: --deployment <version>.',
    );
  return `${base.replace(/\/$/, '')}${path}`;
}

export async function curl(
  io: Io,
  args: Args,
  job: Job | null,
  find: (ref: string) => Version,
  timing: boolean,
) {
  const url = address(args, job, find, args._[1]);
  // Where the time goes, as curl measures it.
  const format = [
    'DNS lookup:     %{time_namelookup}s',
    'TCP connect:    %{time_connect}s',
    'TLS handshake:  %{time_appconnect}s',
    'First byte:     %{time_starttransfer}s',
    'Total:          %{time_total}s',
    'Status:         %{http_code}',
  ].join('\\n');
  const command = timing
    ? `curl -sS -o /dev/null -w '${format}\\n' '${url}'`
    : `curl -sS -i '${url}'`;
  if (timing) io.out(url);
  const code = await io.run(command, io.cwd);
  if (code !== 0)
    throw new CliError(`curl stopped with exit code ${code}.`, code);
}

// api ----------------------------------------------------------------------------------

export async function apiCall(io: Io, args: Args, api: Client) {
  const path = args._[1];
  if (!path?.startsWith('/') || path.startsWith('//'))
    throw new CliError(
      'Give a path of Shipcel’s API that starts with /, such as /projects.',
      2,
    );
  const method = (
    text(args.flags.method) ?? (args.flags.data ? 'POST' : 'GET')
  ).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    throw new CliError('--method takes GET, POST, PUT, PATCH or DELETE.', 2);
  let body: unknown;
  const data = text(args.flags.data);
  if (data !== undefined)
    try {
      body = JSON.parse(data);
    } catch {
      throw new CliError(
        '--data takes JSON, such as \'{"name":"my-app"}\'.',
        2,
      );
    }
  const { status, data: answer } = await api.raw(
    path.replace(/^\/api(?=\/)/, ''),
    body,
    method,
  );
  io.out(JSON.stringify(answer, null, 2));
  if (status >= 400) throw new CliError(`Shipcel answered ${status}.`);
}

// mcp, agent ---------------------------------------------------------------------------

export async function mcp(io: Io, args: Args, url: string) {
  const endpoint = `${url}/mcp`;
  const server = {
    type: 'http',
    url: endpoint,
    headers: { Authorization: 'Bearer ${SHIPCEL_TOKEN}' },
  };
  if (args.flags.write) {
    const path = join(io.cwd, '.mcp.json');
    let settings: { mcpServers?: Record<string, unknown> } = {};
    const current = await read(io, path);
    if (current !== null)
      try {
        settings = JSON.parse(current);
      } catch {
        throw new CliError('.mcp.json isn’t valid JSON, so it was left alone.');
      }
    await io.fs.writeFile(
      path,
      `${JSON.stringify({ ...settings, mcpServers: { ...settings.mcpServers, shipcel: server } }, null, 2)}\n`,
    );
    io.out(
      'Wrote .mcp.json: agents that read it (Claude Code, among others) can now use Shipcel in this folder.',
    );
    io.out(
      'It holds no token. Each person sets SHIPCEL_TOKEN to an API token of their own (dashboard → API & CLI).',
    );
    return;
  }
  if (args.flags.json) {
    io.out(JSON.stringify({ endpoint, mcpServers: { shipcel: server } }));
    return;
  }
  io.out(`Shipcel’s MCP server: ${endpoint}`);
  io.out(
    'Your agent signs in with an API token, read from SHIPCEL_TOKEN (create one in the dashboard under API & CLI).',
  );
  io.out('');
  io.out('Claude Code:');
  io.out(
    `  claude mcp add --transport http --scope user shipcel ${endpoint} --header "Authorization: Bearer $SHIPCEL_TOKEN"`,
  );
  io.out('Codex (~/.codex/config.toml):');
  io.out(
    `  [mcp_servers.shipcel]\n  url = "${endpoint}"\n  bearer_token_env_var = "SHIPCEL_TOKEN"`,
  );
  io.out('Cursor (~/.cursor/mcp.json):');
  io.out(
    `  ${JSON.stringify({ mcpServers: { shipcel: { url: endpoint, headers: { Authorization: 'Bearer ${env:SHIPCEL_TOKEN}' } } } })}`,
  );
  io.out('');
  io.out('For this folder only: shipcel mcp --write adds it to .mcp.json.');
}

const agentMarker = '<!-- shipcel:deploy -->';
const agentNotes = `${agentMarker}
## Deploying with Shipcel

This project deploys to its owner's own Cloudflare account through Shipcel.

- \`shipcel\` builds the project in this folder and deploys a preview: a new version with its own address. Production keeps serving the current version.
- \`shipcel --prod\` deploys to production. \`shipcel promote <version>\` makes a preview the production version; \`shipcel rollback\` goes back to the previous one.
- \`shipcel ls\` lists versions, \`shipcel logs\` shows requests and errors, \`shipcel env add <NAME>\` sets a secret (the value is read from standard input, never from an argument).
- In scripts, pass \`--yes\` and \`--json\`, and set \`SHIPCEL_URL\` and \`SHIPCEL_TOKEN\`.
- Never print or commit tokens. Changes to production, secrets, domains and schedules need the owner's go-ahead.
`;

// Adds deploy notes for coding agents to AGENTS.md, once.
export async function agentInit(io: Io, args: Args) {
  if (args._[1] !== 'init')
    throw new CliError('Use shipcel agent init. Run shipcel help agent.', 2);
  const path = join(io.cwd, 'AGENTS.md');
  const current = await read(io, path);
  if (current?.includes(agentMarker)) {
    io.out('AGENTS.md already has Shipcel’s deploy notes.');
    return;
  }
  await io.fs.writeFile(
    path,
    `${current ? `${current}${current.endsWith('\n') ? '' : '\n'}\n` : '# Notes for coding agents\n\n'}${agentNotes}`,
  );
  io.out(
    current
      ? 'Added Shipcel’s deploy notes to AGENTS.md.'
      : 'Created AGENTS.md with Shipcel’s deploy notes.',
  );
}

// upgrade ------------------------------------------------------------------------------

// Every Shipcel serves the CLI that matches it: upgrading installs that one again.
export async function upgrade(
  io: Io,
  args: Args,
  url: string,
  version: string,
) {
  const command = `npm install -g ${url}/cli/shipcel.tgz`;
  if (args.flags['dry-run']) {
    io.out(command);
    return;
  }
  io.out(`This is shipcel ${version}.`);
  await confirmed(
    io,
    args,
    `Install the CLI this Shipcel serves, with: ${command}?`,
  );
  const code = await io.run(command, io.cwd);
  if (code !== 0)
    throw new CliError(`${command} failed (exit code ${code}).`, code);
  io.out('Done. Run shipcel --version to see what is installed.');
}
