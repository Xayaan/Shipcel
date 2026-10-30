import { Hono } from 'hono';
import { z } from 'zod';
import { cloudflare, workerDatabases } from './providers';
import { AppError, now, type AppEnv } from './types';
import {
  change,
  confirmation,
  replay,
  target,
  type Target,
} from './operations';
import { workersSubdomain } from './health';
import {
  backendSchema,
  backendScript,
  backendVersion,
} from './generated/backend';

// Sign-in and realtime for a project: a Worker (services/backend) with its own D1 database
// and a Durable Object class, created in the project's Cloudflare account. Its signing key
// and realtime secret go straight into Cloudflare Worker secrets; Shipcel never stores them.
export const backends = new Hono<AppEnv>();

type Backend = {
  project_id: string;
  workspace_id: string;
  account_id: string;
  worker_name: string;
  worker_tag: string | null;
  database_id: string | null;
  client_id: string;
  version: string | null;
  status: string;
  error: string | null;
  url: string | null;
  started_at: number;
  updated_at: number;
  resource_suffix: string | null;
  data_binding: string | null;
  data_database_id: string | null;
};
type D1Rows = { results?: Record<string, unknown>[] }[];

// Worker names allow 63 characters; the database name adds "-db-" and an 8-character suffix.
export const backendWorkerName = (app: string) =>
  `${app.slice(0, 52).replace(/-+$/, '')}-backend`;
const settingsSchema = z
  .object({
    appName: z.string().trim().min(1).max(80),
    redirectUris: z.array(z.string().max(2048)).max(10),
    logoutUris: z.array(z.string().max(2048)).max(10),
    signin: z.boolean(),
    realtime: z.boolean(),
    // Sign-in by email: the sender address, on a domain onboarded for Cloudflare's Email
    // Service in the account, and whether passwords are allowed.
    emailFrom: z
      .string()
      .trim()
      .max(254)
      .refine(
        (v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        'Use a sender address like sign-in@your-domain.com, or leave it empty.',
      )
      .optional(),
    password: z.boolean().optional(),
  })
  .strict();
const providerSchema = z.enum(['github', 'google']);
// The data API: which tables of the app's D1 database the service opens, and who may read
// and change each (services/backend/src/data.ts checks the same).
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const access = z.enum(['public', 'signed-in', 'owner', 'none']);
// How many people each level reaches (services/backend/src/store.ts orders them the same).
const reach = { none: 0, owner: 1, 'signed-in': 2, public: 3 } as const;
const dataSchema = z
  .object({
    ...confirmation,
    binding: z.string().regex(identifier).nullable(),
    tables: z.record(
      z
        .string()
        .regex(identifier)
        .refine(
          (table) => !/^(_cf_|sqlite_|d1_)/i.test(table),
          'Cloudflare’s and SQLite’s own tables stay closed.',
        ),
      z
        .object({
          read: access,
          write: access.exclude(['public']),
          owner: z.string().regex(identifier).optional(),
        })
        .strict()
        .refine(
          (p) => (p.read !== 'owner' && p.write !== 'owner') || p.owner,
          'A table each user reads or changes only their own rows of names its owner column.',
        )
        .refine(
          (p) => p.read === 'none' || reach[p.write] <= reach[p.read],
          'No more people may change a table than read it: a change answers with the rows it reached.',
        ),
    ),
  })
  .strict();
// Tables a settings page lists at most (each costs a query through Cloudflare's API).
const MAX_TABLES = 40;

// Return addresses must be HTTPS, or HTTP on this machine for local development.
function returnAddress(uri: string) {
  try {
    const url = new URL(uri);
    return (
      !url.hash &&
      !url.username &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

const query = (
  t: Target,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
) =>
  cloudflare<D1Rows>(
    t.token,
    `${t.root}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      body: JSON.stringify(params.length ? { sql, params } : { sql }),
    },
    { errorDetail: true, timeout: 30000 },
  );

async function current(c: { env: AppEnv['Bindings'] }, projectId: string) {
  return c.env.DB.prepare('SELECT * FROM project_backends WHERE project_id=?')
    .bind(projectId)
    .first<Backend>();
}

const toBase64Url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const randomSecret = () =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

// An ES256 key with an RFC 7638 thumbprint as its key ID.
async function newSigningKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    'jwk',
    pair.privateKey,
  )) as JsonWebKey;
  const thumbprint = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
    ),
  );
  return JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x,
    y: jwk.y,
    d: jwk.d,
    kid: toBase64Url(thumbprint).slice(0, 16),
  });
}

async function setSecret(
  t: Target,
  script: string,
  name: string,
  text: string,
) {
  await cloudflare(t.token, `${script}/secrets`, {
    method: 'PUT',
    body: JSON.stringify({ name, text, type: 'secret_text' }),
  });
}

const missingOk = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof AppError && error.status === 404)) throw error;
  }
};

// Ownership is proven, never inferred from timing: a random suffix is recorded before
// anything is created, the database is named with it, and the Worker carries it in the
// CLOUDCEL_BACKEND_OWNER binding. An interrupted setup adopts only resources with that proof.
const OWNER_BINDING = 'CLOUDCEL_BACKEND_OWNER';
const newSuffix = () =>
  [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const databaseName = (b: Backend) =>
  b.resource_suffix
    ? `${b.worker_name}-db-${b.resource_suffix}`
    : `${b.worker_name}-db`;
const ownerMarker = (b: Backend) => `${b.project_id}:${b.resource_suffix}`;
const foreignWorker = (b: Backend) =>
  new AppError(
    409,
    `A Worker named ${b.worker_name} already exists in this account and Shipcel did not create it. Rename or remove it in Cloudflare, then try again.`,
  );

async function carriesMarker(t: Target, b: Backend) {
  if (!b.resource_suffix) return false;
  const settings = z
    .object({
      bindings: z
        .array(
          z
            .object({
              name: z.string(),
              type: z.string(),
              text: z.string().optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .parse(
      await cloudflare(
        t.token,
        `${t.root}/workers/scripts/${b.worker_name}/settings`,
      ),
    );
  return (settings.bindings ?? []).some(
    (x) =>
      x.type === 'plain_text' &&
      x.name === OWNER_BINDING &&
      x.text === ownerMarker(b),
  );
}

// The service Worker, or null when there is none. Throws for a same-named Worker
// Shipcel did not create, or one replaced since, so it is never replaced or removed.
async function serviceScript(t: Target, b: Backend) {
  let script:
    { tag?: string; created_on?: string; migration_tag?: string } | undefined;
  try {
    script = z
      .object({
        default_environment: z.object({
          script: z
            .object({
              tag: z.string().optional(),
              created_on: z.string().optional(),
              migration_tag: z.string().optional(),
            })
            .passthrough(),
        }),
      })
      .parse(
        await cloudflare(
          t.token,
          `${t.root}/workers/services/${b.worker_name}`,
        ),
      ).default_environment.script;
  } catch (error) {
    if (!(error instanceof AppError && error.status === 404)) throw error;
    return null;
  }
  if (!b.worker_tag && !(await carriesMarker(t, b))) throw foreignWorker(b);
  if (b.worker_tag && script.tag !== b.worker_tag)
    throw new AppError(
      409,
      `The ${b.worker_name} Worker was replaced outside Shipcel. No change was made.`,
    );
  return script;
}

// Uploads the service script. New secrets are bound on the first upload; later uploads
// keep the existing secrets. Never replaces a Worker Shipcel did not create.
async function upload(
  t: Target,
  b: Backend,
  secrets?: { signingKey: string; realtimeSecret: string },
) {
  const script = await serviceScript(t, b);
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2026-10-07',
    bindings: [
      { type: 'd1', name: 'DB', id: b.database_id },
      {
        type: 'durable_object_namespace',
        name: 'CHANNELS',
        class_name: 'Channel',
      },
      {
        type: 'plain_text',
        name: 'CLOUDCEL_BACKEND_VERSION',
        text: backendVersion,
      },
      { type: 'plain_text', name: OWNER_BINDING, text: ownerMarker(b) },
      // Cloudflare's Email Service, for sign-in links once a sender address is set.
      { type: 'send_email', name: 'EMAIL' },
      // The app's own database, for the data API.
      ...(b.data_database_id
        ? [{ type: 'd1', name: 'DATA', id: b.data_database_id }]
        : []),
      ...(secrets
        ? [
            {
              type: 'secret_text',
              name: 'SIGNING_KEY',
              text: secrets.signingKey,
            },
            {
              type: 'secret_text',
              name: 'REALTIME_SECRET',
              text: secrets.realtimeSecret,
            },
          ]
        : []),
    ],
    ...(secrets ? {} : { keep_bindings: ['secret_text'] }),
    ...(script?.migration_tag
      ? {}
      : {
          migrations: {
            new_tag: 'v1',
            steps: [{ new_sqlite_classes: ['Channel'] }],
          },
        }),
  };
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  form.set(
    'index.js',
    new Blob([backendScript], { type: 'application/javascript+module' }),
    'index.js',
  );
  return z
    .object({ tag: z.string().regex(/^[a-f0-9]{32}$/) })
    .passthrough()
    .parse(
      await cloudflare(t.token, `${t.root}/workers/scripts/${b.worker_name}`, {
        method: 'PUT',
        body: form,
      }),
    ).tag;
}

// The service's D1 database, including one an interrupted attempt created but never
// recorded: only a database with this setup's own suffixed name is adopted.
async function serviceDatabase(t: Target, b: Backend) {
  if (b.database_id) return b.database_id;
  if (!b.resource_suffix) return null;
  const name = databaseName(b);
  const existing = z
    .array(
      z.object({
        uuid: z.string(),
        name: z.string(),
        created_at: z.string().optional(),
      }),
    )
    .parse(
      await cloudflare(
        t.token,
        `${t.root}/d1/database?name=${encodeURIComponent(name)}`,
      ),
    )
    .find((d) => d.name === name);
  return existing?.uuid ?? null;
}

// Creates the D1 database, or adopts the one an interrupted attempt created.
async function database(t: Target, b: Backend) {
  const existing = await serviceDatabase(t, b);
  if (existing) return existing;
  return z.object({ uuid: z.string().uuid() }).parse(
    await cloudflare(t.token, `${t.root}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: databaseName(b) }),
    }),
  ).uuid;
}

async function record(
  c: { env: AppEnv['Bindings'] },
  projectId: string,
  fields: Partial<Backend>,
) {
  const entries = Object.entries(fields);
  await c.env.DB.prepare(
    `UPDATE project_backends SET ${entries.map(([k]) => `${k}=?`).join(',')},updated_at=? WHERE project_id=?`,
  )
    .bind(...entries.map(([, v]) => v ?? null), now(), projectId)
    .run();
}

async function readSettings(t: Target, b: Backend) {
  const rows = (
    await query(t, b.database_id!, 'SELECT key, value FROM settings')
  )[0]?.results as { key: string; value: string }[] | undefined;
  const map = new Map((rows ?? []).map((r) => [r.key, r.value]));
  const list = (key: string) => {
    try {
      const value = JSON.parse(map.get(key) ?? '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  return {
    appName: map.get('app_name') ?? '',
    redirectUris: list('redirect_uris'),
    logoutUris: list('logout_uris'),
    githubClientId: map.get('github_client_id') ?? null,
    googleClientId: map.get('google_client_id') ?? null,
    emailFrom: map.get('email_from') || null,
    password: map.get('password') === 'on',
    signin: map.get('signin') !== 'off',
    realtime: map.get('realtime') !== 'off',
    dataTables: JSON.parse(map.get('data_tables') || '{}') as Record<
      string,
      unknown
    >,
  };
}

// The tables of one of the app's databases and their columns, as the data API sees them.
async function schemaOf(t: Target, databaseId: string) {
  const tables = ((
    await query(
      t,
      databaseId,
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name LIMIT ${MAX_TABLES}`,
    )
  )[0]?.results ?? []) as { name: string }[];
  const schema: Record<string, string[]> = {};
  for (const { name } of tables.filter((row) => identifier.test(row.name)))
    schema[name] = (
      ((await query(t, databaseId, `PRAGMA table_info("${name}")`))[0]
        ?.results ?? []) as { name: string }[]
    ).map((c) => c.name);
  return schema;
}

// Before setup the database name's random suffix isn't chosen yet, so it shows as "…".
const plan = (worker: string, b?: Backend) => ({
  workerName: worker,
  databaseName: b ? databaseName(b) : `${worker}-db-…`,
  appSecrets: [
    'CLOUDCEL_AUTH_ISSUER',
    'CLOUDCEL_CLIENT_ID',
    'CLOUDCEL_REALTIME_URL',
    'CLOUDCEL_REALTIME_SECRET',
  ],
});

backends.get('/projects/:id/backend', async (c) => {
  const t = await target(c);
  const b = await current(c, t.p.id);
  if (!b)
    return c.json({
      status: 'off',
      latestVersion: backendVersion,
      plan: plan(backendWorkerName(t.job.worker_name)),
    });
  const active = b.status === 'active' && b.database_id && b.url;
  // The service stays manageable (and removable) when its database can't be read.
  let settings = null,
    settingsError: string | null = null;
  if (active)
    try {
      settings = await readSettings(t, b);
    } catch (error) {
      settingsError =
        error instanceof AppError
          ? error.message
          : 'Shipcel could not read the service settings.';
    }
  return c.json({
    status: b.status,
    error: b.error,
    url: b.url,
    clientId: b.client_id,
    version: b.version,
    latestVersion: backendVersion,
    updateAvailable: Boolean(active && b.version !== backendVersion),
    workerName: b.worker_name,
    plan: plan(b.worker_name, b),
    settings,
    settingsError,
  });
});

// Enables the service, or continues an attempt that stopped part-way. Every step can
// run again safely: the database and Worker are adopted only when they carry this setup's
// suffix or owner marker.
backends.post('/projects/:id/backend', async (c) => {
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true);
  const kind = 'backend.enable';
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  if ((await current(c, t.p.id))?.status === 'active')
    throw new AppError(409, 'Sign-in and realtime are already on.');
  // Another Shipcel app in the account may already be deployed under the service's name.
  const name = backendWorkerName(t.job.worker_name);
  if (
    await c.env.DB.prepare(
      'SELECT 1 FROM deployment_jobs WHERE account_id=? AND worker_name=?',
    )
      .bind(t.job.account_id, name)
      .first()
  )
    throw new AppError(
      409,
      `Another Shipcel app in this account is deployed as ${name}, the name sign-in and realtime needs. Rename that app's Worker first.`,
    );
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      const existing = await current(c, t.p.id);
      // The suffix is recorded before anything is created in Cloudflare.
      if (!existing)
        await c.env.DB.prepare(
          "INSERT INTO project_backends(project_id,workspace_id,account_id,worker_name,client_id,status,started_at,updated_at,resource_suffix) VALUES (?,?,?,?,?,'enabling',?,?,?)",
        )
          .bind(
            t.p.id,
            t.who.workspaceId,
            t.job.account_id,
            name,
            `cc_${randomSecret().slice(0, 24)}`,
            now(),
            now(),
            newSuffix(),
          )
          .run();
      else
        await record(c, t.p.id, {
          status: 'enabling',
          error: null,
          ...(existing.resource_suffix ? {} : { resource_suffix: newSuffix() }),
        });
      const b = (await current(c, t.p.id))!;
      try {
        const subdomain = await workersSubdomain(t.token, t.job.account_id);
        if (!subdomain)
          throw new AppError(
            409,
            'Claim a free workers.dev subdomain for this account first.',
          );
        b.database_id = await database(t, b);
        await record(c, t.p.id, { database_id: b.database_id });
        await query(t, b.database_id, backendSchema);
        const url = `https://${b.worker_name}.${subdomain}.workers.dev`;
        const app = t.job.live_url ?? null;
        // Defaults the owner can change later; existing settings are kept on retries.
        await query(
          t,
          b.database_id,
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('client_id', ?)",
          [b.client_id],
        );
        await query(
          t,
          b.database_id,
          "INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', ?), ('redirect_uris', ?), ('logout_uris', ?), ('signin', 'on'), ('realtime', 'on')",
          [
            t.p.name,
            JSON.stringify(app ? [`${app}auth/callback`] : []),
            JSON.stringify(app ? [app] : []),
          ],
        );
        const realtimeSecret = randomSecret();
        const tag = await upload(t, b, {
          signingKey: await newSigningKey(),
          realtimeSecret,
        });
        await record(c, t.p.id, { worker_tag: tag });
        await cloudflare(
          t.token,
          `${t.root}/workers/scripts/${b.worker_name}/subdomain`,
          { method: 'POST', body: JSON.stringify({ enabled: true }) },
        );
        // The app reads these to talk to the service; no copying of keys by hand.
        for (const [name, value] of [
          ['CLOUDCEL_AUTH_ISSUER', url],
          ['CLOUDCEL_CLIENT_ID', b.client_id],
          [
            'CLOUDCEL_REALTIME_URL',
            `${url.replace(/^https/, 'wss')}/realtime/channels/`,
          ],
          ['CLOUDCEL_REALTIME_SECRET', realtimeSecret],
        ])
          await setSecret(t, t.script, name, value);
        await record(c, t.p.id, {
          status: 'active',
          version: backendVersion,
          url,
          error: null,
        });
        return { url, clientId: b.client_id, version: backendVersion };
      } catch (error) {
        await record(c, t.p.id, {
          status: 'needs_attention',
          error:
            error instanceof AppError
              ? error.message
              : 'Setup stopped part-way. Try again: Shipcel continues where it stopped.',
        });
        throw error;
      }
    },
    { intent: { workerName: backendWorkerName(t.job.worker_name) } },
  );
});

// Removes the service: the app's CLOUDCEL_* secrets, the service Worker with its realtime
// channels, and its D1 database with every user account. It cannot be undone, so the
// owner types the Worker name. Nothing is removed if the Worker is not Shipcel's.
backends.delete('/projects/:id/backend', async (c) => {
  const input = z
    .object({ ...confirmation, confirmName: z.string().max(80) })
    .strict()
    .parse(await c.req.json());
  const t = await target(c, true);
  const kind = 'backend.remove';
  const previous = await replay(c, t, kind, input.requestId);
  if (previous) return previous;
  const b = await current(c, t.p.id);
  if (!b)
    throw new AppError(
      404,
      'Sign-in and realtime are not on for this project.',
    );
  if (input.confirmName !== b.worker_name)
    throw new AppError(400, `Type ${b.worker_name} to confirm the removal.`);
  return change(
    c,
    t,
    kind,
    input.requestId,
    async () => {
      // A same-named Worker that was never this service's (setup stopped before its upload)
      // is left alone; one that replaced the recorded Worker stops the removal.
      let script = null;
      try {
        script = await serviceScript(t, b);
      } catch (error) {
        if (!(
          error instanceof AppError &&
          error.status === 409 &&
          !b.worker_tag
        ))
          throw error;
      }
      const databaseId = await serviceDatabase(t, b);
      for (const name of plan(b.worker_name).appSecrets)
        await missingOk(
          cloudflare(t.token, `${t.script}/secrets/${name}`, {
            method: 'DELETE',
          }),
        );
      if (script)
        await missingOk(
          cloudflare(
            t.token,
            `${t.root}/workers/scripts/${b.worker_name}?force=true`,
            { method: 'DELETE' },
          ),
        );
      if (databaseId)
        await missingOk(
          cloudflare(t.token, `${t.root}/d1/database/${databaseId}`, {
            method: 'DELETE',
          }),
        );
      await c.env.DB.prepare('DELETE FROM project_backends WHERE project_id=?')
        .bind(t.p.id)
        .run();
      return { removed: b.worker_name };
    },
    { intent: { workerName: b.worker_name } },
  );
});

async function activeBackend(c: Parameters<typeof target>[0], write = true) {
  const t = await target(c, write);
  const b = await current(c, t.p.id);
  if (!b || b.status !== 'active' || !b.database_id || !b.url)
    throw new AppError(409, 'Turn on sign-in and realtime first.');
  return { t, b };
}

// Secrets and code go only to the recorded service Worker: never to a Worker that took
// its name after it was deleted or replaced.
async function requireServiceWorker(t: Target, b: Backend) {
  if (!(await serviceScript(t, b)))
    throw new AppError(
      409,
      `The ${b.worker_name} Worker is missing from your Cloudflare account. Remove sign-in & realtime, then turn it on again.`,
    );
}

backends.put('/projects/:id/backend/settings', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const { requestId, confirm, ...rest } = body;
  z.object(confirmation).parse({ requestId, confirm });
  const input = settingsSchema.parse(rest);
  for (const uri of [...input.redirectUris, ...input.logoutUris])
    if (!returnAddress(uri))
      throw new AppError(
        400,
        `${uri.slice(0, 100)} is not a valid return address. Use https:// (or http://localhost while developing), without a #fragment.`,
      );
  const { t, b } = await activeBackend(c);
  return change(c, t, 'backend.settings', requestId as string, async () => {
    await query(
      t,
      b.database_id!,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)',
      [
        'app_name',
        input.appName,
        'redirect_uris',
        JSON.stringify(input.redirectUris),
        'logout_uris',
        JSON.stringify(input.logoutUris),
        'signin',
        input.signin ? 'on' : 'off',
        'realtime',
        input.realtime ? 'on' : 'off',
        'email_from',
        input.emailFrom ?? '',
        'password',
        input.password ? 'on' : 'off',
      ],
    );
    return { saved: true };
  });
});

backends.get('/projects/:id/backend/data', async (c) => {
  const { t, b } = await activeBackend(c, false);
  const databases = await workerDatabases(t.token, t.script);
  const chosen = c.req.query('binding') ?? b.data_binding;
  const database =
    databases.find((d) => d.binding === chosen) ?? databases[0] ?? null;
  return c.json({
    binding: b.data_binding,
    databases: databases.map((d) => d.binding),
    tables: (await readSettings(t, b)).dataTables,
    schema: database ? await schemaOf(t, database.id) : {},
  });
});

// Opens tables of one of the app's databases to the data API, or closes it (binding null).
// The service Worker is uploaded again when the database it has as DATA changes.
backends.put('/projects/:id/backend/data', async (c) => {
  const input = dataSchema.parse(await c.req.json());
  const { t, b } = await activeBackend(c);
  await requireServiceWorker(t, b);
  const database = input.binding
    ? (await workerDatabases(t.token, t.script)).find(
        (d) => d.binding === input.binding,
      )
    : null;
  if (input.binding && !database)
    throw new AppError(
      409,
      `The app’s Worker has no D1 database bound as ${input.binding}. Deploy it with that binding first.`,
    );
  if (database) {
    const schema = await schemaOf(t, database.id);
    for (const [table, policy] of Object.entries(input.tables)) {
      if (!schema[table])
        throw new AppError(
          409,
          `The ${input.binding} database has no table ${table}.`,
        );
      if (policy.owner && !schema[table].includes(policy.owner))
        throw new AppError(
          409,
          `Table ${table} has no ${policy.owner} column.`,
        );
    }
  }
  const tables = database ? input.tables : {};
  const open = (opened: Record<string, unknown>) =>
    query(
      t,
      b.database_id!,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['data_tables', JSON.stringify(opened)],
    );
  return change(c, t, 'backend.data', input.requestId, async () => {
    const id = database?.id ?? null;
    if (id !== b.data_database_id) {
      // Every table closes before the service's database changes, so an upload that fails
      // leaves none of them open on the wrong one.
      await open({});
      const next = {
        ...b,
        data_binding: database ? input.binding : null,
        data_database_id: id,
      };
      await record(c, t.p.id, {
        worker_tag: await upload(t, next),
        data_binding: next.data_binding,
        data_database_id: id,
      });
    }
    await open(tables);
    return {
      binding: database ? input.binding : null,
      tables: Object.keys(tables),
    };
  });
});

// GitHub and Google sign-in: the client ID is a setting, the client secret a Worker secret.
backends.put('/projects/:id/backend/providers/:provider', async (c) => {
  const provider = providerSchema.parse(c.req.param('provider'));
  const input = z
    .object({
      ...confirmation,
      clientId: z.string().regex(/^[\w.-]{1,200}$/),
      clientSecret: z.string().min(1).max(500),
    })
    .strict()
    .parse(await c.req.json());
  const { t, b } = await activeBackend(c);
  await requireServiceWorker(t, b);
  return change(
    c,
    t,
    `backend.provider:${provider}`,
    input.requestId,
    async () => {
      await setSecret(
        t,
        `${t.root}/workers/scripts/${b.worker_name}`,
        `${provider.toUpperCase()}_CLIENT_SECRET`,
        input.clientSecret,
      );
      await query(
        t,
        b.database_id!,
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        [`${provider}_client_id`, input.clientId],
      );
      return { provider, clientId: input.clientId };
    },
    { intent: { provider } },
  );
});
backends.delete('/projects/:id/backend/providers/:provider', async (c) => {
  const provider = providerSchema.parse(c.req.param('provider'));
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const { t, b } = await activeBackend(c);
  await requireServiceWorker(t, b);
  return change(
    c,
    t,
    `backend.provider-off:${provider}`,
    input.requestId,
    async () => {
      await query(t, b.database_id!, 'DELETE FROM settings WHERE key=?', [
        `${provider}_client_id`,
      ]);
      await missingOk(
        cloudflare(
          t.token,
          `${t.root}/workers/scripts/${b.worker_name}/secrets/${provider.toUpperCase()}_CLIENT_SECRET`,
          { method: 'DELETE' },
        ),
      );
      return { provider, removed: true };
    },
  );
});

backends.get('/projects/:id/backend/users', async (c) => {
  const { t, b } = await activeBackend(c, false);
  const [rows, count] = await Promise.all([
    query(
      t,
      b.database_id!,
      'SELECT u.id, u.email, u.email_verified, u.name, u.disabled, u.created_at, u.last_sign_in_at, (SELECT group_concat(provider) FROM identities i WHERE i.user_id=u.id) AS providers, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id=u.id) AS passkeys FROM users u ORDER BY u.created_at DESC LIMIT 200',
    ),
    query(t, b.database_id!, 'SELECT COUNT(*) AS total FROM users'),
  ]);
  return c.json({
    total: Number(count[0]?.results?.[0]?.total ?? 0),
    users: (rows[0]?.results ?? []).map((u) => ({
      id: String(u.id),
      email: (u.email as string | null) ?? null,
      emailVerified: u.email_verified === 1,
      name: (u.name as string | null) ?? null,
      disabled: u.disabled === 1,
      createdAt: Number(u.created_at),
      lastSignInAt:
        u.last_sign_in_at == null ? null : Number(u.last_sign_in_at),
      providers: u.providers ? String(u.providers).split(',') : [],
      passkeys: Number(u.passkeys ?? 0),
    })),
  });
});

const userId = z.string().regex(/^[\w-]{10,64}$/);
// Disabling a user also ends their sessions and refresh tokens.
backends.post('/projects/:id/backend/users/:userId/:action', async (c) => {
  const id = userId.parse(c.req.param('userId'));
  const action = z
    .enum(['disable', 'enable', 'delete'])
    .parse(c.req.param('action'));
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const { t, b } = await activeBackend(c);
  return change(
    c,
    t,
    `backend.user-${action}:${id}`,
    input.requestId,
    async () => {
      // The ID matches [\w-] only, so it can be inlined and the statements run as one batch.
      const sql =
        action === 'enable'
          ? `UPDATE users SET disabled=0 WHERE id='${id}';`
          : action === 'disable'
            ? `UPDATE users SET disabled=1 WHERE id='${id}'; DELETE FROM sessions WHERE user_id='${id}'; UPDATE refresh_tokens SET revoked=1 WHERE user_id='${id}';`
            : `DELETE FROM sessions WHERE user_id='${id}'; DELETE FROM refresh_tokens WHERE user_id='${id}'; DELETE FROM passkeys WHERE user_id='${id}'; DELETE FROM identities WHERE user_id='${id}'; DELETE FROM users WHERE id='${id}';`;
      await query(t, b.database_id!, sql);
      return { userId: id, action };
    },
  );
});

// A new realtime secret for both the service and the app.
backends.post('/projects/:id/backend/realtime-secret', async (c) => {
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const { t, b } = await activeBackend(c);
  await requireServiceWorker(t, b);
  return change(c, t, 'backend.rotate', input.requestId, async () => {
    const secret = randomSecret();
    await setSecret(
      t,
      `${t.root}/workers/scripts/${b.worker_name}`,
      'REALTIME_SECRET',
      secret,
    );
    await setSecret(t, t.script, 'CLOUDCEL_REALTIME_SECRET', secret);
    return { rotated: true };
  });
});

// Installs the service version bundled with this Shipcel release, keeping keys and data.
backends.post('/projects/:id/backend/update', async (c) => {
  const input = z
    .object(confirmation)
    .strict()
    .parse(await c.req.json());
  const { t, b } = await activeBackend(c);
  await requireServiceWorker(t, b);
  return change(c, t, 'backend.update', input.requestId, async () => {
    await query(t, b.database_id!, backendSchema);
    const tag = await upload(t, b);
    await record(c, t.p.id, { worker_tag: tag, version: backendVersion });
    return { version: backendVersion };
  });
});
