// shipcel storage (alias blob, as on Vercel): the KV namespaces and R2 buckets an app's
// Worker binds, from the terminal. It uses Manage → Storage's routes (worker/storage.ts):
// reads go to Cloudflare, and every change is confirmed and journaled with its key.
import {
  CliError,
  change,
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

type Bound = {
  kv: { binding: string; id: string }[];
  r2: { binding: string; bucket: string; jurisdiction?: string }[];
};
type Target = { binding: string; kind: 'kv' | 'r2' };
// Shipcel takes text values up to 1 MB into KV and files up to 25 MB into R2.
const MAX_KV_TEXT = 1048576;
const MAX_R2_FILE = 25 * 1048576;
// Listings follow the cursor this many pages (100 each) at most.
const PAGES = 10;
const TYPES: Record<string, string> = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wasm: 'application/wasm',
};
const typeOf = (path: string) =>
  TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ??
  'application/octet-stream';
const size = (bytes: number | null) =>
  bytes === null
    ? ''
    : bytes < 1024
      ? `${bytes} B`
      : bytes < 1048576
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`;

export async function storage(
  io: Io,
  args: Args,
  api: Client,
  project: Project,
) {
  const [, sub = 'ls', ...rest] = args._;
  const environment = args.flags.preview ? 'preview' : 'production';
  const root = `/projects/${project.id}/storage`;
  const bound = await api.call<Bound>(`${root}?environment=${environment}`);
  const all: Target[] = [
    ...bound.kv.map((k) => ({ binding: k.binding, kind: 'kv' as const })),
    ...bound.r2.map((r) => ({ binding: r.binding, kind: 'r2' as const })),
  ];
  const where = environment === 'preview' ? ' (the previews’ copies)' : '';
  // The binding a command names, or the only one there is.
  const pick = (needed: number): [Target, string[]] => {
    const named = all.find((t) => t.binding === rest[0]);
    if (named) return [named, rest.slice(1)];
    if (all.length === 1 && rest.length < needed + 1) return [all[0], rest];
    if (!all.length)
      throw new CliError(
        `${project.name} binds no KV namespace or R2 bucket${where}.`,
      );
    throw new CliError(
      `Say which: ${all.map((t) => t.binding).join(', ')} (shipcel storage ls lists them).`,
      2,
    );
  };
  const query = (params: Record<string, string>) =>
    new URLSearchParams({ environment, ...params }).toString();
  if (sub === 'ls' || sub === 'list') {
    if (!rest.length) {
      if (args.flags.json) {
        io.out(JSON.stringify(bound));
        return;
      }
      if (!all.length) {
        io.out(`${project.name} binds no KV namespace or R2 bucket${where}.`);
        return;
      }
      for (const line of table([
        ['Binding', 'Kind', 'Where'],
        ...bound.kv.map((k) => [k.binding, 'KV namespace', k.id]),
        ...bound.r2.map((r) => [
          r.binding,
          'R2 bucket',
          `${r.bucket}${r.jurisdiction ? ` (${r.jurisdiction})` : ''}`,
        ]),
      ]))
        io.out(line);
      return;
    }
    const [target, [prefix = '']] = pick(1);
    return list(io, args, api, root, target, prefix, query);
  }
  if (sub === 'get') {
    const [target, [key, file]] = pick(2);
    if (!key)
      throw new CliError(
        'Say which key: shipcel storage get <binding> <key> [file]',
        2,
      );
    return get(io, args, api, root, target, key, file, query);
  }
  if (sub === 'put') {
    const [target, [key, file]] = pick(2);
    if (!key)
      throw new CliError(
        'Say which key: shipcel storage put <binding> <key> <file>',
        2,
      );
    return put(io, args, api, root, target, key, file, environment);
  }
  if (sub === 'rm' || sub === 'del' || sub === 'remove') {
    const [target, [key]] = pick(1);
    if (!key)
      throw new CliError(
        'Say which key: shipcel storage rm <binding> <key>',
        2,
      );
    await confirmed(
      io,
      args,
      `Delete ${key} from ${target.binding}${where}? It can't be brought back.`,
    );
    await api.call(
      `${root}/${target.kind}/${target.binding}/${target.kind === 'kv' ? 'value' : 'object'}`,
      { method: 'DELETE', body: change({ key, environment }) },
    );
    io.out(`Deleted ${key} from ${target.binding}.`);
    return;
  }
  throw new CliError(
    `Unknown command storage ${sub}. Run shipcel help storage.`,
    2,
  );
}

async function list(
  io: Io,
  args: Args,
  api: Client,
  root: string,
  target: Target,
  prefix: string,
  query: (params: Record<string, string>) => string,
) {
  const rows: string[][] = [];
  const folders: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const params: Record<string, string> = { prefix };
    if (cursor) params.cursor = cursor;
    if (target.kind === 'kv') {
      const page = await api.call<{
        keys: { name: string; expiration: number | null }[];
        cursor: string | null;
      }>(`${root}/kv/${target.binding}/keys?${query(params)}`);
      rows.push(
        ...page.keys.map((k) => [
          k.name,
          k.expiration
            ? `expires ${new Date(k.expiration * 1000).toISOString().slice(0, 10)}`
            : '',
        ]),
      );
      cursor = page.cursor;
    } else {
      const page = await api.call<{
        objects: {
          key: string;
          size: number | null;
          lastModified: string | null;
        }[];
        folders: string[];
        cursor: string | null;
      }>(`${root}/r2/${target.binding}/objects?${query(params)}`);
      folders.push(...page.folders);
      rows.push(
        ...page.objects.map((o) => [
          o.key,
          size(o.size),
          o.lastModified ? o.lastModified.slice(0, 10) : '',
        ]),
      );
      cursor = page.cursor;
    }
    pages++;
  } while (cursor && pages < PAGES);
  if (args.flags.json) {
    io.out(
      JSON.stringify({
        keys: rows.map((r) => r[0]),
        ...(target.kind === 'r2' ? { folders } : {}),
        more: !!cursor,
      }),
    );
    return;
  }
  if (!rows.length && !folders.length) {
    io.out(`Nothing in ${target.binding}${prefix ? ` under ${prefix}` : ''}.`);
    return;
  }
  for (const folder of folders) io.out(`${folder}  (folder)`);
  for (const line of table(rows)) io.out(line);
  if (cursor)
    io.out(
      `More than ${rows.length}: narrow it down, shipcel storage ls ${target.binding} <prefix>.`,
    );
}

async function get(
  io: Io,
  args: Args,
  api: Client,
  root: string,
  target: Target,
  key: string,
  file: string | undefined,
  query: (params: Record<string, string>) => string,
) {
  // A KV value that is readable text prints, unless a file is named.
  if (target.kind === 'kv' && !file) {
    const value = await api.call<{
      text: string | null;
      truncated: boolean;
    }>(`${root}/kv/${target.binding}/value?${query({ key })}`);
    if (value.text !== null && !value.truncated) {
      io.out(value.text);
      return;
    }
    throw new CliError(
      `${key} isn't text, or is over 64 KB: save it to a file, shipcel storage get ${target.binding} ${key} <file>.`,
    );
  }
  const path = file && file !== '-' ? resolve(io.cwd, file) : undefined;
  const out =
    file === '-'
      ? null
      : (path ?? join(io.cwd, key.split('/').pop() || 'download'));
  if (out && (await io.fs.exists(out)) && !args.flags.yes)
    throw new CliError(`${out} is already there. Pass --yes to replace it.`);
  const bytes = await api.download(
    `${root}/${target.kind}/${target.binding}/${target.kind === 'kv' ? 'download' : 'object'}?${query({ key })}`,
    'GET',
  );
  if (!out) {
    io.out(decode(bytes));
    return;
  }
  await io.fs.writeFile(out, bytes);
  io.out(`Saved ${key} (${size(bytes.length)}) to ${out}.`);
}

async function put(
  io: Io,
  args: Args,
  api: Client,
  root: string,
  target: Target,
  key: string,
  file: string | undefined,
  environment: string,
) {
  const value = text(args.flags.value);
  if (!file && value === undefined)
    throw new CliError(
      `Give a file, or --value "text" for KV: shipcel storage put ${target.binding} ${key} <file>`,
      2,
    );
  const content = file
    ? await io.fs.readFile(resolve(io.cwd, file))
    : new TextEncoder().encode(value);
  if (target.kind === 'kv') {
    if (content.length > MAX_KV_TEXT)
      throw new CliError('KV values are up to 1 MB here.');
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new CliError(
        'Shipcel puts text into KV. For a file, use an R2 bucket, or Wrangler.',
      );
    }
    await confirmed(
      io,
      args,
      `Put ${key} into ${target.binding}, replacing what is there?`,
    );
    await api.call(`${root}/kv/${target.binding}/value`, {
      method: 'PUT',
      body: change({ key, value: body, environment }),
    });
    io.out(`Put ${key} into ${target.binding} (${size(content.length)}).`);
    return;
  }
  if (content.length > MAX_R2_FILE)
    throw new CliError(
      'Files up to 25 MB go through Shipcel. Use Wrangler for larger ones.',
    );
  await confirmed(
    io,
    args,
    `Upload ${key} to ${target.binding}, replacing what is there?`,
  );
  const form = new FormData();
  form.set('key', key);
  form.set('environment', environment);
  const { requestId } = change();
  form.set('requestId', requestId);
  form.set('confirm', 'true');
  form.set(
    'file',
    new File([new Uint8Array(content)], key.split('/').pop() || 'file', {
      type: typeOf(file ?? key),
    }),
  );
  await api.form(`${root}/r2/${target.binding}/object`, form);
  io.out(`Uploaded ${key} to ${target.binding} (${size(content.length)}).`);
}
