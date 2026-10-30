// The data API: rows of the app's own D1 database (the DATA binding) over HTTP, for the
// app's pages to read and change with a signed-in user's access token. Only the tables the
// app's owner opened in Shipcel are reachable, each with who may read and who may change it
// (row-level security). Each change goes out on realtime channels, so pages can follow a
// table as it changes.
import { corsHeaders, verifyAccessToken } from './oidc';
import { publish } from './realtime';
import {
  activeUser,
  identifier,
  readSettings,
  type Access,
  type Env,
  type Settings,
  type TablePolicy,
} from './store';
import { HttpError, json, readJson } from './util';

// Rows one read returns at most, and rows one insert takes.
const MAX_READ = 200;
const MAX_INSERT = 100;
// A change event carries its rows up to this size; past it, listeners get a count to refetch.
const MAX_EVENT = 32768;
const OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
};
const RESERVED = new Set(['select', 'order', 'limit', 'offset']);
type Row = Record<string, unknown>;
type Caller = { sub: string } | null;

const quote = (name: string) => `"${name}"`;

// The signed-in user an access token names, or null without one.
async function caller(request: Request, env: Env): Promise<Caller> {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  if (!header.startsWith('Bearer '))
    throw new HttpError(
      401,
      'Send the access token as a Bearer token.',
      'invalid_token',
    );
  const { claims } = await verifyAccessToken(request, env, header.slice(7));
  try {
    await activeUser(env, claims.sub as string);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    throw new HttpError(
      403,
      'This account can’t use the data API.',
      'access_denied',
    );
  }
  return { sub: claims.sub as string };
}

function allow(access: Access, who: Caller, doing: 'read' | 'change') {
  if (access === 'none')
    throw new HttpError(
      403,
      `This table can’t be ${doing === 'read' ? 'read' : 'changed'} through the data API.`,
      'access_denied',
    );
  if (access !== 'public' && !who)
    throw new HttpError(
      401,
      'Sign in first, and send the user’s access token.',
      'invalid_token',
    );
}

async function columnsOf(db: D1Database, table: string, policy: TablePolicy) {
  const { results } = await db
    .prepare(`PRAGMA table_info(${quote(table)})`)
    .all<{ name: string }>();
  if (!results.length)
    throw new HttpError(
      404,
      `The app’s database has no table ${table}.`,
      'not_found',
    );
  const known = new Set(
    results.map((c) => c.name).filter((n) => identifier.test(n)),
  );
  if (policy.owner && !known.has(policy.owner))
    throw new HttpError(
      409,
      `Table ${table} has no ${policy.owner} column to say whose a row is. Change the data API settings in Shipcel.`,
    );
  return known;
}

function column(name: string, known: Set<string>) {
  if (!known.has(name))
    throw new HttpError(400, `Unknown column ${name.slice(0, 64)}.`);
  return quote(name);
}

// Filters from the query string, as column=operator.value (PostgREST's form).
function filters(params: URLSearchParams, known: Set<string>) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    const name = column(key, known);
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    const value = raw.slice(dot + 1);
    if (op === 'is' && (value === 'null' || value === 'notnull'))
      clauses.push(`${name} IS ${value === 'null' ? '' : 'NOT '}NULL`);
    else if (Object.hasOwn(OPERATORS, op)) {
      clauses.push(`${name} ${OPERATORS[op]} ?`);
      values.push(value);
    } else
      throw new HttpError(
        400,
        `Filter ${key} as ${key}=eq.value, or with neq, gt, gte, lt, lte, like, is.null or is.notnull.`,
      );
  }
  return { clauses, values };
}

function cell(value: unknown) {
  if (value === null || typeof value === 'string' || typeof value === 'number')
    return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new HttpError(400, 'Values are strings, numbers, true, false or null.');
}

// A row's columns and values. A new row belongs to the signed-in user; a change never
// moves a row to someone else.
function rowFor(
  body: unknown,
  known: Set<string>,
  policy: TablePolicy,
  who: Caller,
  kind: 'insert' | 'update',
) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'Send a row as a JSON object.');
  const row: Row = { ...(body as Row) };
  if (policy.owner) {
    if (policy.owner in row && row[policy.owner] !== who!.sub)
      throw new HttpError(
        403,
        `A row’s ${policy.owner} is the signed-in user’s id.`,
        'access_denied',
      );
    if (kind === 'insert') row[policy.owner] = who!.sub;
    else delete row[policy.owner];
  }
  const names = Object.keys(row);
  if (!names.length) throw new HttpError(400, 'Send at least one column.');
  return {
    names: names.map((n) => column(n, known)),
    values: names.map((n) => cell(row[n])),
  };
}

// D1's own words for a broken constraint (a duplicate key, a missing value), without its codes.
async function run<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/constraint|cannot store/i.test(message))
      throw new HttpError(
        409,
        `The table refused this change: ${message
          .replace(/^D1_ERROR:\s*/, '')
          .replace(/:\s*SQLITE_\w+$/, '')
          .slice(0, 200)}`,
        'conflict',
      );
    throw error;
  }
}

// Sends a change to whoever may read the rows: a public or signed-in table's channel, or
// each owner's own user channel.
async function announce(
  env: Env,
  settings: Settings,
  table: string,
  policy: TablePolicy,
  kind: 'insert' | 'update' | 'delete',
  rows: Row[],
) {
  if (!settings.realtime || !rows.length || policy.read === 'none') return;
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const channel =
      policy.read === 'owner'
        ? `user:${String(row[policy.owner!])}`
        : `${policy.read}:data:${table}`;
    const group = groups.get(channel);
    if (group) group.push(row);
    else groups.set(channel, [row]);
  }
  for (const [channel, changed] of groups) {
    const full = { table, rows: changed };
    const data =
      JSON.stringify(full).length <= MAX_EVENT
        ? full
        : { table, count: changed.length };
    await publish(env, channel, `data:${kind}`, data).catch((error) =>
      console.error('Data API change not announced', channel, error),
    );
  }
}

type Where = { sql: string; values: unknown[] };

// Rows as PostgREST reads them: select, filters, order, limit and offset.
async function readRows(
  db: D1Database,
  table: string,
  params: URLSearchParams,
  known: Set<string>,
  where: Where,
) {
  const select = params.get('select');
  const list = select
    ? select
        .split(',')
        .map((n) => column(n.trim(), known))
        .join(', ')
    : '*';
  const order = (params.get('order') ?? '')
    .split(',')
    .filter(Boolean)
    .map((part) => {
      const [name, direction = 'asc'] = part.split('.');
      if (!['asc', 'desc'].includes(direction))
        throw new HttpError(
          400,
          'Order as order=column.asc or order=column.desc.',
        );
      return `${column(name, known)} ${direction.toUpperCase()}`;
    });
  const limit = Number(params.get('limit') ?? 50);
  const offset = Number(params.get('offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ)
    throw new HttpError(400, `A limit is 1 to ${MAX_READ}.`);
  if (!Number.isInteger(offset) || offset < 0)
    throw new HttpError(400, 'An offset is 0 or more.');
  const { results } = await db
    .prepare(
      `SELECT ${list} FROM ${quote(table)} WHERE ${where.sql}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ? OFFSET ?`,
    )
    .bind(...where.values, limit, offset)
    .all<Row>();
  return results;
}

async function insertRows(
  request: Request,
  db: D1Database,
  table: string,
  known: Set<string>,
  policy: TablePolicy,
  who: Caller,
) {
  const body = await readJson(request, 1024 * 1024);
  const rows = (Array.isArray(body) ? body : [body]).map((r) =>
    rowFor(r, known, policy, who, 'insert'),
  );
  if (rows.length > MAX_INSERT)
    throw new HttpError(400, `Insert up to ${MAX_INSERT} rows at a time.`);
  const results = await run(() =>
    db.batch(
      rows.map((r) =>
        db
          .prepare(
            `INSERT INTO ${quote(table)} (${r.names.join(', ')}) VALUES (${r.names.map(() => '?').join(', ')}) RETURNING *`,
          )
          .bind(...r.values),
      ),
    ),
  );
  return results.flatMap((r) => r.results as Row[]);
}

// Changes or deletes the rows a filter names, among those the user may change.
async function changeRows(
  request: Request,
  db: D1Database,
  table: string,
  known: Set<string>,
  policy: TablePolicy,
  who: Caller,
  where: Where,
) {
  let statement: D1PreparedStatement;
  if (request.method === 'PATCH') {
    const change = rowFor(
      await readJson(request, 1024 * 1024),
      known,
      policy,
      who,
      'update',
    );
    statement = db
      .prepare(
        `UPDATE ${quote(table)} SET ${change.names.map((n) => `${n} = ?`).join(', ')} WHERE ${where.sql} RETURNING *`,
      )
      .bind(...change.values, ...where.values);
  } else
    statement = db
      .prepare(`DELETE FROM ${quote(table)} WHERE ${where.sql} RETURNING *`)
      .bind(...where.values);
  return (await run(() => statement.all<Row>())).results;
}

async function handle(
  request: Request,
  env: Env,
  settings: Settings,
  path: string,
) {
  const table = path.slice('/data/'.length);
  const policy = Object.hasOwn(settings.dataTables, table)
    ? settings.dataTables[table]
    : null;
  if (!env.DATA || !policy)
    throw new HttpError(
      404,
      `The data API has no table ${table.slice(0, 64)}.`,
      'not_found',
    );
  const method = request.method;
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method))
    throw new HttpError(405, 'Use GET, POST, PATCH or DELETE.');
  const reading = method === 'GET';
  const who = await caller(request, env);
  allow(reading ? policy.read : policy.write, who, reading ? 'read' : 'change');
  // A change answers with the rows it reached, so a table no one reads only takes new rows.
  if (!reading && method !== 'POST' && policy.read === 'none')
    throw new HttpError(
      403,
      'Rows of a table no one reads can’t be changed or deleted through the data API.',
      'access_denied',
    );
  const db = env.DATA;
  const known = await columnsOf(db, table, policy);
  const params = new URL(request.url).searchParams;
  const { clauses, values } = filters(params, known);
  const named = clauses.length > 0;
  // Row-level security: a user reads, or changes, only their own rows.
  if ((reading ? policy.read : policy.write) === 'owner') {
    clauses.push(`${quote(policy.owner!)} = ?`);
    values.push(who!.sub);
  }
  const where = { sql: clauses.length ? clauses.join(' AND ') : '1', values };
  if (reading)
    return json({ rows: await readRows(db, table, params, known, where) });
  if (method === 'POST') {
    const inserted = await insertRows(request, db, table, known, policy, who);
    await announce(env, settings, table, policy, 'insert', inserted);
    return json({ rows: inserted }, { status: 201 });
  }
  if (!named)
    throw new HttpError(400, 'Name the rows with a filter, such as id=eq.5.');
  const changed = await changeRows(
    request,
    db,
    table,
    known,
    policy,
    who,
    where,
  );
  await announce(
    env,
    settings,
    table,
    policy,
    method === 'PATCH' ? 'update' : 'delete',
    changed,
  );
  return json({ rows: changed });
}

// /data/<table>: the app's pages call it from its own addresses (its return addresses).
export async function data(request: Request, env: Env, path: string) {
  const settings = await readSettings(env);
  const cors = corsHeaders(request, settings, 'GET, POST, PATCH, DELETE');
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });
  let response: Response;
  try {
    response = await handle(request, env, settings, path);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    response = json(
      { error: error.code, error_description: error.message },
      {
        status: error.status,
        headers: { 'X-Content-Type-Options': 'nosniff' },
      },
    );
  }
  for (const [name, value] of Object.entries(cors))
    response.headers.set(name, value);
  return response;
}
