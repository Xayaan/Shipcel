// A fake Cloudflare for deploys from a computer: it answers the calls the real Wrangler
// 4.148 makes for `deploy` and `versions upload` (the shapes Wrangler reads were found by
// running it against a stand-in), and Shipcel's own calls on that path. It records what it
// received. The OAuth token is the one tests/helpers/database.ts grants.
export const account = 'a'.repeat(32);
export const oauth = 'Bearer cloudflare-access-secret';

type Binding = Record<string, unknown> & { name: string; type: string };
type Worker = {
  tag: string;
  bindings: Binding[];
  migrationTag: string | null;
  // The settings a script upload carries (metadata) and the parts sent with it.
  metadata: Record<string, unknown>;
  parts: Record<string, { type: string; size: number }>;
};

export function cloudflareWrangler() {
  const state = {
    workers: new Map<string, Worker>(),
    // An upload session for a new name leaves an empty Worker (seen live, 9 Oct 2026).
    placeholders: new Set<string>(),
    stored: new Map<string, string>(),
    d1: [] as { uuid: string; name: string }[],
    kv: [] as { id: string; title: string }[],
    r2: [] as { name: string }[],
    // Objects written to R2 buckets, by `<bucket>/<key>`: what a deploy filled.
    objects: new Map<string, string>(),
    route: {} as Record<
      string,
      { enabled: boolean; previews_enabled?: boolean }
    >,
    schedules: {} as Record<string, { cron: string }[]>,
    // Which tool Cloudflare says uploaded each Worker last. Seen live (13 Oct 2026): an
    // upload that arrived without Wrangler's user agent was filed as "api". That the user
    // agent is what decides is Shipcel's reading of it, not something Cloudflare documents.
    from: {} as Record<string, 'wrangler' | 'api'>,
    settings: {} as Record<string, Record<string, unknown>>,
    // Versions newest first; the one production serves (the larger share of a split);
    // deployments newest first, each with the share every version gets.
    versions: [] as { id: string; metadata: Record<string, unknown> }[],
    live: null as string | null,
    deployments: [] as { version_id: string; percentage: number }[][],
    secrets: [] as string[],
    // Rows of Cloudflare's analytics for the Worker, one per hour and outcome.
    usage: [
      {
        sum: { requests: 1200, errors: 6, subrequests: 30 },
        // Cloudflare's percentiles are in microseconds.
        quantiles: {
          cpuTimeP50: 1400,
          cpuTimeP99: 9000,
          wallTimeP50: 35_000,
          wallTimeP99: 410_000,
        },
        dimensions: { datetimeHour: '2026-10-13T00:00:00Z', status: 'success' },
      },
    ] as Record<string, unknown>[],
    calls: [] as {
      method: string;
      path: string;
      authorization: string | null;
      // The tool the caller says it is.
      agent: string | null;
      body?: unknown;
    }[],
    // Set to make the next matching call fail the way Cloudflare would.
    fail: null as null | {
      match: RegExp;
      status: number;
      code: number;
      result?: unknown;
    },
    // Set to make the next upload session answer with a token but no readable file list.
    garbledSession: false,
  };
  const cf = (result: unknown, status = 200, extra: object = {}) =>
    Response.json(
      { success: true, errors: [], messages: [], result, ...extra },
      { status },
    );
  const error = (
    status: number,
    code: number,
    message: string,
    result: unknown = null,
  ) =>
    Response.json(
      {
        success: false,
        errors: [{ code, message }],
        messages: [],
        result,
      },
      { status },
    );
  let counter = 0;
  const versionId = () =>
    `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const form = async (init: RequestInit, headers: Headers) =>
    init.body instanceof FormData
      ? init.body
      : new Response(init.body as BodyInit, {
          headers: { 'Content-Type': headers.get('Content-Type') ?? '' },
        }).formData();
  // What a metadata binding becomes in the Worker's settings.
  function settle(name: string, sent: Binding[], before: Binding[]) {
    return sent.map((b) =>
      b.type === 'inherit'
        ? (before.find((old) => old.name === b.name) ?? b)
        : b.type === 'd1'
          ? { ...b, id: b.id }
          : b,
    );
  }

  const handler = async (
    raw: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(raw));
    const path = url.pathname.replace('/client/v4', '');
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const call = {
      method,
      path: path + url.search,
      authorization: headers.get('Authorization'),
      agent: headers.get('User-Agent'),
      body: undefined as unknown,
    };
    state.calls.push(call);
    if (state.fail?.match.test(`${method} ${path}`)) {
      const { status, code, result } = state.fail;
      state.fail = null;
      return error(status, code, 'Cloudflare refused this in the test', result);
    }
    if (typeof init.body === 'string')
      try {
        call.body = JSON.parse(init.body);
      } catch {
        call.body = init.body;
      }
    const root = `/accounts/${account}`;
    if (path === '/graphql')
      return Response.json({
        data: {
          viewer: { accounts: [{ workersInvocationsAdaptive: state.usage }] },
        },
        errors: null,
      });
    if (path === `${root}/workers/subdomain`)
      return cf({ subdomain: 'test-account' });
    if (path === `${root}/workers/scripts` && method === 'GET')
      return cf(
        [...state.workers].map(([id, w]) => ({
          id,
          tag: w.tag,
          migration_tag: w.migrationTag,
        })),
      );
    if (path === `${root}/workers/assets/upload`) {
      if (headers.get('Authorization') !== 'Bearer upload-jwt')
        return error(401, 10000, 'Authentication error');
      for (const [hash, value] of (await form(init, headers)).entries())
        state.stored.set(hash, await (value as File).text());
      return cf({ jwt: 'completion-jwt' }, 201);
    }
    for (const [kind, key, id] of [
      ['d1/database', 'name', 'uuid'],
      ['storage/kv/namespaces', 'title', 'id'],
      ['r2/buckets', 'name', 'name'],
    ] as const) {
      const list = (
        kind === 'd1/database'
          ? state.d1
          : kind === 'r2/buckets'
            ? state.r2
            : state.kv
      ) as Record<string, string>[];
      if (path === `${root}/${kind}`) {
        if (method === 'GET')
          return kind === 'r2/buckets' ? cf({ buckets: list }) : cf(list);
        const name = String((call.body as Record<string, unknown>)[key]);
        if (list.some((r) => r[key] === name))
          return error(400, 7502, `${name} already exists`);
        const made = {
          [key]: name,
          [id]:
            kind === 'd1/database'
              ? `60000000-0000-4000-8000-${String(list.length + 1).padStart(12, '0')}`
              : kind === 'r2/buckets'
                ? name
                : `${String(list.length + 1).padStart(2, '0')}${'b'.repeat(30)}`,
        };
        list.push(made);
        return cf(made);
      }
      if (path.startsWith(`${root}/${kind}/`) && method === 'GET') {
        const wanted = decodeURIComponent(
          path.slice(`${root}/${kind}/`.length),
        );
        const found = list.find((r) => r[id] === wanted);
        return found ? cf(found) : error(404, 7404, 'not found');
      }
    }
    if (headers.get('Authorization') !== oauth)
      return error(401, 10000, 'Authentication error');
    const object = path.match(
      /^\/accounts\/a{32}\/r2\/buckets\/([a-z0-9-]+)\/objects\/(.+)$/,
    );
    if (object && method === 'PUT') {
      if (!state.r2.some((b) => b.name === object[1]))
        return error(404, 10006, 'The specified bucket does not exist.');
      state.objects.set(
        `${object[1]}/${decodeURIComponent(object[2])}`,
        await new Response(init.body as BodyInit).text(),
      );
      return cf({ key: decodeURIComponent(object[2]) });
    }
    const name = path.match(
      /^\/accounts\/a{32}\/workers\/(?:scripts|services|workers)\/([a-z0-9-]+)/,
    )?.[1];
    if (!name) throw new Error(`Unexpected ${method} ${url}`);
    const worker = state.workers.get(name);
    const script = `${root}/workers/scripts/${name}`;
    if (path === `${root}/workers/services/${name}`) {
      if (worker)
        return cf({
          id: name,
          default_environment: {
            environment: 'production',
            script: {
              tag: worker.tag,
              last_deployed_from: state.from[name] ?? 'wrangler',
              migration_tag: worker.migrationTag ?? undefined,
              deployment_id: 'd'.repeat(32),
              has_modules: true,
              has_assets: true,
            },
          },
        });
      return state.placeholders.has(name)
        ? cf({
            id: name,
            default_environment: {
              script: {
                tag: 'e'.repeat(32),
                deployment_id: '',
                has_assets: false,
                has_modules: false,
              },
            },
          })
        : error(404, 10090, 'This Worker does not exist on your account.');
    }
    if (path === `${root}/workers/workers/${name}`)
      return cf({
        id: name,
        name,
        subdomain: {
          ...(state.route[name] ?? { enabled: false, previews_enabled: false }),
          preview_url_suffix: `-${name}.test-account.workers.dev`,
        },
      });
    if (path === `${script}/assets-upload-session`) {
      if (!worker) state.placeholders.add(name);
      const { manifest } = call.body as {
        manifest: Record<string, { hash: string }>;
      };
      if (state.garbledSession) {
        state.garbledSession = false;
        return cf({ jwt: 'upload-jwt', buckets: 'not a list' });
      }
      const needed = [
        ...new Set(Object.values(manifest).map((m) => m.hash)),
      ].filter((h) => !state.stored.has(h));
      return needed.length
        ? cf({ jwt: 'upload-jwt', buckets: [needed] })
        : cf({ jwt: 'completion-jwt', buckets: [] });
    }
    const missing = () =>
      error(404, 10007, 'workers.api.error.script_not_found');
    if (path === `${script}/secrets`) {
      if (!worker) return missing();
      if (method === 'PUT')
        state.secrets.push((call.body as { name: string }).name);
      return cf(state.secrets.map((n) => ({ name: n, type: 'secret_text' })));
    }
    if (path === `${script}/settings` && method === 'GET')
      return worker ? cf({ bindings: worker.bindings }) : missing();
    if (path === `${script}/script-settings`) {
      if (!worker) return missing();
      if (method === 'PATCH')
        state.settings[name] = {
          ...state.settings[name],
          ...(call.body as Record<string, unknown>),
        };
      return cf({
        logpush: false,
        tags: [],
        tail_consumers: null,
        observability: null,
        ...state.settings[name],
      });
    }
    const upload = async () => {
      const sent = await form(init, headers);
      const metadata = JSON.parse(String(sent.get('metadata'))) as Record<
        string,
        unknown
      >;
      call.body = metadata;
      state.from[name] = /^wrangler\//.test(headers.get('User-Agent') ?? '')
        ? 'wrangler'
        : 'api';
      const parts: Worker['parts'] = {};
      for (const [key, value] of sent.entries())
        if (typeof value !== 'string')
          parts[key] = { type: value.type, size: value.size };
      return { metadata, parts };
    };
    if (path === script && method === 'PUT') {
      const { metadata, parts } = await upload();
      if (
        (metadata.assets as { jwt?: string } | undefined)?.jwt &&
        (metadata.assets as { jwt: string }).jwt !== 'completion-jwt'
      )
        return error(400, 10021, 'The asset upload token is not valid.');
      const migrations = metadata.migrations as
        { new_tag?: string } | undefined;
      const next: Worker = {
        tag: worker?.tag ?? 'c'.repeat(32),
        bindings: settle(
          name,
          (metadata.bindings ?? []) as Binding[],
          worker?.bindings ?? [],
        ),
        migrationTag: migrations?.new_tag ?? worker?.migrationTag ?? null,
        metadata,
        parts,
      };
      state.placeholders.delete(name);
      state.workers.set(name, next);
      if (metadata.observability)
        state.settings[name] = {
          ...state.settings[name],
          observability: metadata.observability,
        };
      const id = versionId();
      state.versions.unshift({ id, metadata });
      state.live = id;
      state.deployments.unshift([{ version_id: id, percentage: 100 }]);
      return cf({
        id: name,
        tag: next.tag,
        etag: 'e'.repeat(64),
        deployment_id: id.replace(/-/g, ''),
        startup_time_ms: 5,
        pipeline_hash: 'p',
        mutable_pipeline_id: 'm',
      });
    }
    if (path === `${script}/versions`) {
      if (!worker) return missing();
      if (method === 'POST') {
        const { metadata, parts } = await upload();
        const id = versionId();
        state.versions.unshift({ id, metadata });
        // The version's bindings and code take effect when it is deployed.
        worker.metadata = { ...worker.metadata, pending: { metadata, parts } };
        return cf({
          id,
          number: state.versions.length,
          startup_time_ms: 5,
          resources: { script: { etag: 'e'.repeat(64) } },
          metadata: { has_preview: true },
        });
      }
      return cf({
        items: state.versions.map((v, i) => ({
          id: v.id,
          number: state.versions.length - i,
          metadata: { created_on: '2026-10-13T00:00:00.000Z' },
          annotations: v.metadata.annotations ?? {},
        })),
      });
    }
    if (path === `${script}/deployments`) {
      if (method === 'POST') {
        if (!worker) return missing();
        const { versions } = call.body as {
          versions: { version_id: string; percentage: number }[];
        };
        if (
          versions.some(
            (v) => !state.versions.some((k) => k.id === v.version_id),
          )
        )
          return error(400, 10014, 'Unknown version');
        state.live = [...versions].sort(
          (a, b) => b.percentage - a.percentage,
        )[0].version_id;
        state.deployments.unshift(versions);
        const pending = worker.metadata.pending as
          | { metadata: Record<string, unknown>; parts: Worker['parts'] }
          | undefined;
        if (pending)
          state.workers.set(name, {
            ...worker,
            bindings: settle(
              name,
              (pending.metadata.bindings ?? []) as Binding[],
              worker.bindings,
            ),
            metadata: pending.metadata,
            parts: pending.parts,
          });
        return cf({ id: '50000000-0000-4000-8000-000000000001' });
      }
      return cf({
        deployments: state.deployments.map((versions) => ({
          id: '50000000-0000-4000-8000-000000000001',
          source: 'wrangler',
          strategy: 'percentage',
          // Cloudflare says who deployed and with what message; Wrangler doesn't need it.
          author_email: 'owner@example.com',
          annotations: { 'workers/message': 'a private note' },
          versions,
        })),
      });
    }
    const one = path.match(/\/versions\/([0-9a-f-]{36})$/)?.[1];
    if (one && method === 'GET')
      return state.versions.some((v) => v.id === one)
        ? cf({ id: one, number: 1 })
        : error(404, 10014, 'Unknown version');
    if (path === `${script}/subdomain`) {
      if (method === 'POST') {
        state.route[name] = call.body as (typeof state.route)[string];
        return cf(state.route[name]);
      }
      return cf(
        state.route[name] ?? { enabled: false, previews_enabled: false },
      );
    }
    if (path === `${script}/schedules`) {
      if (method === 'PUT')
        state.schedules[name] = call.body as { cron: string }[];
      return cf({ schedules: state.schedules[name] ?? [] });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { state, handler };
}
