// What every shipcel command is built from: the injected surroundings (`Io`), arguments,
// the saved sign-in, and the HTTP client for Shipcel's API. Commands live in cli.ts (the
// deploy flows) and commands.ts (everyday ones); nothing here knows about a command.

export type Io = {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  hostname: string;
  isTTY: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: typeof fetch;
  open: (url: string) => Promise<void>;
  // Runs a shell command in a folder, attached to the terminal; resolves with its exit code.
  // `env` adds to the command's environment; a name set to undefined is taken out of it.
  // `quiet` keeps what the command prints off the terminal unless it fails.
  run: (
    command: string,
    cwd: string,
    env?: Record<string, string | undefined>,
    quiet?: boolean,
  ) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  ask: (question: string) => Promise<string>;
  // Asks without showing what is typed.
  askSecret: (question: string) => Promise<string>;
  // Everything piped to the command, when it isn't a terminal.
  stdin: () => Promise<string>;
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(
      path: string,
      data: string | Uint8Array,
      mode?: number,
    ): Promise<void>;
    mkdir(path: string, mode?: number): Promise<void>;
    remove(path: string): Promise<void>;
    readdir(
      path: string,
    ): Promise<{ name: string; dir: boolean; file: boolean }[]>;
    size(path: string): Promise<number>;
    exists(path: string): Promise<boolean>;
  };
};

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

export type Args = { _: string[]; flags: Record<string, string | boolean> };
export const BOOLEAN = new Set([
  'prod',
  'prebuilt',
  'publish',
  'create',
  'spa',
  'no-spa',
  'yes',
  'json',
  'help',
  'version',
  'app',
  'errors',
  'follow',
  'skip-checks',
  'cloudflare-builds',
  'database',
  'build',
  'preview',
  'plain',
  'write',
  'dry-run',
  'all',
  'open',
  'proxied',
]);
export const SHORT: Record<string, string> = {
  h: 'help',
  y: 'yes',
  v: 'version',
};

export function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^-[a-z]$/.test(a) && SHORT[a[1]]) args.flags[SHORT[a[1]]] = true;
    else if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (BOOLEAN.has(name)) args.flags[name] = true;
      else if (inline !== undefined) args.flags[name] = inline;
      else if (i + 1 < argv.length) args.flags[name] = argv[++i];
      else throw new CliError(`--${name} needs a value.`, 2);
    } else args._.push(a);
  }
  return args;
}

export const join = (...parts: string[]) =>
  parts
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/(.)\/$/, '$1');
export const resolve = (base: string, path: string) =>
  /^([\\/]|[a-zA-Z]:[\\/])/.test(path) ? path : join(base, path);
export const parent = (path: string) =>
  path.replace(/[\\/]+[^\\/]+[\\/]*$/, '');
export const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export const text = (flag: string | boolean | undefined) =>
  typeof flag === 'string' ? flag : undefined;

// Config ------------------------------------------------------------------------------

export type Config = { url?: string; token?: string };
const configHome = (io: Io) =>
  io.env.XDG_CONFIG_HOME ?? join(io.home, '.config');
export const configDir = (io: Io) =>
  io.env.SHIPCEL_CONFIG_DIR ??
  io.env.CLOUDCEL_CONFIG_DIR ??
  join(configHome(io), 'shipcel');

// Before Cloudcel became Shipcel, the sign-in was kept in ~/.config/cloudcel: it is read
// until the next sign-in (or sign-out) is saved in the new place.
export async function readConfig(io: Io): Promise<Config> {
  const earlier =
    io.env.SHIPCEL_CONFIG_DIR || io.env.CLOUDCEL_CONFIG_DIR
      ? []
      : [join(configHome(io), 'cloudcel')];
  for (const dir of [configDir(io), ...earlier])
    try {
      return JSON.parse(
        new TextDecoder().decode(
          await io.fs.readFile(join(dir, 'config.json')),
        ),
      );
    } catch {
      // Not there, or not readable: the earlier place, then none.
    }
  return {};
}
export async function writeConfig(io: Io, config: Config) {
  await io.fs.mkdir(configDir(io), 0o700);
  await io.fs.writeFile(
    join(configDir(io), 'config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    0o600,
  );
}

// Shipcel's own service. A Shipcel someone runs themselves is given once, with
// shipcel login --url (or SHIPCEL_URL), and kept with the token.
export const SHIPCEL_COM = 'https://shipcel.com';

// An environment variable left empty, as an unset CI secret is, counts as not set.
const given = (value?: string) =>
  value && value.trim() ? value.trim() : undefined;

export function baseUrl(
  io: Io,
  config: Config,
  flag?: string | boolean,
  token?: string | boolean,
) {
  let url =
    text(flag) ??
    given(io.env.SHIPCEL_URL) ??
    given(io.env.CLOUDCEL_URL) ??
    config.url;
  if (!url) {
    // A token given by hand belongs to one Shipcel. Sent to shipcel.com by default, a token for
    // a Shipcel someone runs themselves would reach the wrong service.
    if (
      text(token) ??
      given(io.env.SHIPCEL_TOKEN) ??
      given(io.env.CLOUDCEL_TOKEN)
    )
      throw new CliError(
        'This token needs the address of its Shipcel too: set SHIPCEL_URL (https://shipcel.com for shipcel.com), or pass --url.',
      );
    url = SHIPCEL_COM;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`${url} is not a web address.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
    throw new CliError('Use an https:// address (http:// only for localhost).');
  return parsed.origin;
}

// HTTP --------------------------------------------------------------------------------

export type Client = {
  url: string;
  call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  // The status with the answer, for requests whose refusals the CLI acts on.
  raw(
    path: string,
    body?: unknown,
    method?: string,
  ): Promise<{ status: number; data: Record<string, unknown> }>;
  failure(status: number, data: Record<string, unknown>): CliError;
  download(path: string, method?: string): Promise<Uint8Array>;
  // A multipart request, for files (shipcel storage put).
  form<T>(path: string, form: FormData, method?: string): Promise<T>;
};

// A Shipcel on this computer that doesn't answer is usually one that isn't running.
function unreachable(url: string) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* Said below without the host. */
  }
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
    host.endsWith('.localhost')
    ? `Could not reach Shipcel at ${url}. Is it running? Start it in its own folder with npm run dev, then run this again.`
    : `Could not reach Shipcel at ${url}. Check the address and your connection, then run this again.`;
}

export function client(io: Io, url: string, token?: string): Client {
  const request = async (path: string, method: string, body?: unknown) => {
    try {
      return await io.fetch(`${url}/api${path}`, {
        method,
        redirect: 'error',
        headers: {
          ...(token
            ? { Authorization: `Bearer ${token}` }
            : { 'X-Shipcel-Request': '1' }),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(unreachable(url));
    }
  };
  const failure = (status: number, data: Record<string, unknown>) =>
    status === 401
      ? new CliError(
          token
            ? 'Your Shipcel token is no longer valid. Run shipcel login.'
            : 'Sign in first: run shipcel login.',
        )
      : new CliError(
          typeof data.error === 'string'
            ? data.error
            : `Shipcel answered ${status}.`,
        );
  return {
    url,
    async call<T>(
      path: string,
      init: { method?: string; body?: unknown } = {},
    ) {
      const response = await request(path, init.method ?? 'GET', init.body);
      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) throw failure(response.status, data);
      return data as T;
    },
    failure,
    async raw(path: string, body?: unknown, method = 'POST') {
      const response = await request(path, method, body);
      return {
        status: response.status,
        data: (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >,
      };
    },
    async download(path: string, method = 'POST') {
      const response = await request(path, method);
      if (!response.ok)
        throw failure(
          response.status,
          (await response.json().catch(() => ({}))) as Record<string, unknown>,
        );
      return new Uint8Array(await response.arrayBuffer());
    },
    async form<T>(path: string, form: FormData, method = 'PUT') {
      let response: Response;
      try {
        response = await io.fetch(`${url}/api${path}`, {
          method,
          redirect: 'error',
          headers: token
            ? { Authorization: `Bearer ${token}` }
            : { 'X-Shipcel-Request': '1' },
          body: form,
        });
      } catch {
        throw new CliError(unreachable(url));
      }
      const data = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) throw failure(response.status, data);
      return data as T;
    },
  };
}

// A device-code approval, for `shipcel login` and `shipcel tokens add`: Shipcel shows a
// code, the person approves it on the page that opens, and the CLI polls until the page is
// decided. Resolves with what the approval handed out (a token, once).
export async function browserApproval(
  io: Io,
  api: Client,
  body: Record<string, unknown>,
  words: { approve: string; denied: string; expired: string },
) {
  const start = await api.call<{
    code: string;
    deviceSecret: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
  }>('/cli/login', { method: 'POST', body });
  io.out(`Visit ${start.verificationUrl}`);
  io.out(
    `Sign in with GitHub there if it asks, check that it shows the code ${start.code}, then ${words.approve}.`,
  );
  await io.open(start.verificationUrl).catch(() => {});
  io.out('Waiting for you in the browser…');
  let wait = Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await io.sleep(wait);
    const { status, data } = await api.raw('/cli/login/poll', {
      deviceSecret: start.deviceSecret,
    });
    if (status === 202) continue;
    if (status === 429) {
      wait += 1000;
      continue;
    }
    if (status === 200 && typeof data.token === 'string') return data;
    if (status === 403) throw new CliError(words.denied);
    throw new CliError(words.expired);
  }
  throw new CliError(words.expired);
}

// A change Shipcel journals: each request carries its own ID and explicit consent.
export const change = (body: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  confirm: true,
  ...body,
});

export async function confirmed(io: Io, args: Args, question: string) {
  if (args.flags.yes) return;
  if (!io.isTTY)
    throw new CliError(`${question} Pass --yes to confirm in scripts.`);
  const answer = (await io.ask(`${question} [y/N] `)).trim();
  if (!/^y(es)?$/i.test(answer)) throw new CliError('Nothing was changed.');
}

export const yes = (answer: string, fallback: boolean) =>
  answer.trim() ? /^y(es)?$/i.test(answer.trim()) : fallback;

export type Project = {
  id: string;
  name: string;
  framework: string;
  source?: string;
  repository?: string;
  freeOnly?: boolean;
  createdAt?: string;
};
export type Job = {
  id?: string;
  adapter: string;
  environment?: string;
  status: string;
  step?: string;
  error?: string | null;
  worker_name: string;
  live_url: string | null;
  branch?: string;
  repository_name?: string;
};

export const production = async (api: Client, project: Project) =>
  (await api.call<Job[]>(`/projects/${project.id}/deployments`)).find(
    (j) => j.environment !== 'preview',
  ) ?? null;
export const dashboard = (api: Client, project: Project, tab = '') =>
  `${api.url}/app/#projects/${project.id}${tab ? `/${tab}` : ''}`;

export const ago = (iso?: string) => {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return seconds < 60
    ? `${Math.floor(seconds)}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
};
export function table(rows: string[][]) {
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => r[i].length)),
  );
  return rows.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i])))
      .join('  ')
      .trimEnd(),
  );
}
