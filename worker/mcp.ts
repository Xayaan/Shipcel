// Shipcel's MCP server, so people can build and deploy with their own AI agent (Claude
// Code, Codex, Cursor…). Shipcel runs no model itself. Streamable HTTP at POST /mcp,
// authenticated with an API token. It speaks the stateless 2026-07-28 revision (per-request
// _meta, server/discover) and, for older clients, the initialize-based 2025 revisions.
// Every tool calls Shipcel's own HTTP API with the caller's token, so an agent can do
// exactly what the token can and no more.
import { assetHash, fromBase64, toBase64 } from '../shared/assets';

const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED = [...MODERN, ...LEGACY];
const SERVER_INFO = { name: 'shipcel', title: 'Shipcel', version: '0.1.0' };
// Files travel inline as JSON, so a request is kept well under a Worker's memory.
export const MCP_MAX_BYTES = 10 * 1024 * 1024;
const KEY = {
  version: 'io.modelcontextprotocol/protocolVersion',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
};

export const INSTRUCTIONS = `Shipcel deploys apps into the user's own Cloudflare account and manages them.
To ship a site: create_project (or use list_projects), then deploy_files with the built files
(HTML, CSS, JS, images; optionally a _worker.js ES module for requests no file matches, and
_redirects/_headers). The first deploy of a project is unpublished: only its preview address works
(anyone with that link can open it). Call publish only when the user wants the app public
at its free workers.dev address. Serving static
files is free on Cloudflare; a _worker.js runs on Cloudflare's free plan of 100,000 requests
a day. If you can run commands, the Shipcel CLI deploys a whole build folder at once.
Apps that need a database, storage or other Cloudflare bindings deploy from Git in the
Shipcel dashboard instead. Projects are Free-only by default, so nothing billable is created.`;

type Json = Record<string, unknown>;
export type Api = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<{ status: number; data: unknown }>;
// A problem the agent can act on: reported as a tool result with isError, not a protocol error.
class ToolError extends Error {}

const project = {
  type: 'string',
  description: 'The project name or ID (see list_projects).',
};
const onlyProject = {
  type: 'object',
  properties: { project },
  required: ['project'],
  additionalProperties: false,
};
const TOOLS = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List the projects in the Shipcel workspace.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_project',
    title: 'Create a project',
    description:
      'Create a project to deploy files to. Names are 3–48 lowercase letters, numbers and single hyphens, starting with a letter. The first deploy uses the name as the app address unless app_name is given.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        framework: {
          type: 'string',
          enum: ['static', 'worker', 'react', 'vue', 'hono'],
          description: 'Defaults to static.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_project',
    title: 'Get a project',
    description:
      'Show a project with its deployment, public address (if published) and latest preview address.',
    inputSchema: onlyProject,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'deploy_files',
    title: 'Deploy files',
    description:
      'Deploy files to a project as a new version, in the user’s own Cloudflare account. Send every file of the site each time (unchanged files are not uploaded again). Paths start with "/" (for example /index.html). Use encoding "base64" for binary files. A file at /_worker.js becomes the ES module that handles requests no file matches (env.ASSETS.fetch(request) serves the files); /_redirects and /_headers configure routing. The first deploy stays unpublished (only its preview address works) unless publish is true. A call carries up to 10 MB; for bigger sites use the Shipcel CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        project,
        files: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              encoding: { type: 'string', enum: ['utf8', 'base64'] },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
        publish: {
          type: 'boolean',
          description:
            'Make the app public. First deploys stay unpublished otherwise; later deploys keep the current setting.',
        },
        spa: {
          type: 'boolean',
          description:
            'Serve /index.html for paths that match no file (a single-page app).',
        },
        app_name: {
          type: 'string',
          description:
            'The app’s address name, on a project’s first deploy only.',
        },
      },
      required: ['project', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish',
    title: 'Publish or unpublish',
    description:
      'Turn a project’s public workers.dev address on (public: true) or off (public: false). Preview addresses keep working. Ask the user before publishing.',
    inputSchema: {
      type: 'object',
      properties: { project, public: { type: 'boolean' } },
      required: ['project', 'public'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_deployments',
    title: 'List deployments',
    description:
      'List a project’s deployments (Git builds and direct uploads), newest first.',
    inputSchema: onlyProject,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_versions',
    title: 'List versions',
    description:
      'List a project’s Worker versions, newest first; live is the share of traffic each serves now.',
    inputSchema: onlyProject,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'rollback',
    title: 'Roll back',
    description:
      'Send all traffic to an earlier version: the one before the live version, or version_id. Database changes are not undone.',
    inputSchema: {
      type: 'object',
      properties: { project, version_id: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'list_secrets',
    title: 'List runtime secrets',
    description:
      'List the names of a project’s runtime secrets. Values are never shown.',
    inputSchema: onlyProject,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'set_secret',
    title: 'Set a runtime secret',
    description:
      'Set a runtime secret on a project’s Worker, such as an API key its _worker.js reads from env. The value is stored only in Cloudflare and never shown again.',
    inputSchema: {
      type: 'object',
      properties: {
        project,
        name: {
          type: 'string',
          description: 'Like API_KEY: letters, digits and underscores.',
        },
        value: { type: 'string' },
      },
      required: ['project', 'name', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_signin_info',
    title: 'Get sign-in & realtime details',
    description:
      'Get a project’s sign-in (OpenID Connect) and realtime details: issuer, client ID and realtime address, or how to turn them on.',
    inputSchema: onlyProject,
    annotations: { readOnlyHint: true },
  },
];

const PROMPT = {
  name: 'build_and_deploy',
  title: 'Build and deploy a site',
  description: 'Build a site or small app that fits Shipcel, and deploy it.',
  arguments: [{ name: 'idea', description: 'What to build', required: true }],
};

const text = (value: string) => ({ type: 'text', text: value });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function call<T = Json>(
  api: Api,
  path: string,
  init?: { method?: string; body?: unknown },
) {
  const { status, data } = await api(path, init);
  if (status >= 400) {
    const message = (data as Json | null)?.error;
    throw new ToolError(
      typeof message === 'string' ? message : `Shipcel answered ${status}.`,
    );
  }
  return data as T;
}
// Every change is confirmed by the agent calling the tool; each call is its own operation.
const confirmed = () => ({ requestId: crypto.randomUUID(), confirm: true });
const str = (args: Json, key: string) => {
  const value = args[key];
  if (typeof value !== 'string' || !value)
    throw new ToolError(`${key} is required.`);
  return value;
};

async function findProject(api: Api, args: Json) {
  const ref = str(args, 'project');
  const projects = await call<{ id: string; name: string }[]>(api, '/projects');
  const found = projects.find((p) => p.id === ref || p.name === ref);
  if (!found)
    throw new ToolError(
      `No project ${ref}. Use list_projects, or create_project to make one.`,
    );
  return found;
}

const SPECIAL = ['/_worker.js', '/_redirects', '/_headers'];

async function deployFiles(api: Api, args: Json) {
  const target = await findProject(api, args);
  if (!Array.isArray(args.files) || !args.files.length)
    throw new ToolError('files is required.');
  const assets: { path: string; base64: string; size: number; hash: string }[] =
    [];
  const special: Record<string, string> = {};
  for (const file of args.files as Json[]) {
    const path = String(file?.path ?? '');
    const content = String(file?.content ?? '');
    let bytes: Uint8Array;
    if (file?.encoding === 'base64') {
      try {
        bytes = fromBase64(content);
      } catch {
        throw new ToolError(`${path} is not valid base64.`);
      }
    } else bytes = new TextEncoder().encode(content);
    if (SPECIAL.includes(path)) {
      special[path] = new TextDecoder().decode(bytes);
      continue;
    }
    // The hash covers exactly the base64 that is uploaded.
    const base64 = toBase64(bytes);
    assets.push({
      path,
      base64,
      size: bytes.length,
      hash: assetHash(base64, path),
    });
  }
  if (!assets.length)
    throw new ToolError(
      'Send at least one file to serve, such as /index.html.',
    );
  const upload = await call<{
    uploadId: string;
    workerName: string;
    missing: string[];
    maxRequestBytes: number;
  }>(api, `/projects/${target.id}/uploads`, {
    method: 'POST',
    body: {
      files: assets.map(({ path, hash, size }) => ({ path, hash, size })),
      ...(typeof args.app_name === 'string'
        ? { workerName: args.app_name }
        : {}),
    },
  });
  const byHash = new Map(assets.map((a) => [a.hash, a]));
  const needed = upload.missing
    .map((hash) => byHash.get(hash))
    .filter((a) => a !== undefined);
  const room = upload.maxRequestBytes - 1024 * 1024;
  for (let i = 0; i < needed.length;) {
    const batch: { hash: string; content: string }[] = [];
    let bytes = 0;
    while (
      i < needed.length &&
      (!batch.length || bytes + needed[i].base64.length <= room)
    ) {
      batch.push({ hash: needed[i].hash, content: needed[i].base64 });
      bytes += needed[i].base64.length;
      i++;
    }
    await call(api, `/projects/${target.id}/uploads/${upload.uploadId}/files`, {
      method: 'POST',
      body: { files: batch },
    });
  }
  const { result } = await call<{
    result: {
      workerName: string;
      versionId: string;
      previewUrl: string | null;
      url: string | null;
      published: boolean;
    };
  }>(api, `/projects/${target.id}/uploads/${upload.uploadId}/deploy`, {
    method: 'POST',
    body: {
      ...confirmed(),
      ...(typeof args.publish === 'boolean' ? { publish: args.publish } : {}),
      ...(typeof args.spa === 'boolean' ? { spa: args.spa } : {}),
      ...(special['/_worker.js'] !== undefined
        ? {
            workerModule: toBase64(
              new TextEncoder().encode(special['/_worker.js']),
            ),
          }
        : {}),
      ...(special['/_redirects'] ? { redirects: special['/_redirects'] } : {}),
      ...(special['/_headers'] ? { headers: special['/_headers'] } : {}),
    },
  });
  return {
    summary: [
      `Deployed ${plural(assets.length, 'file')} (${needed.length} new) to ${result.workerName}.`,
      result.previewUrl ? `Preview: ${result.previewUrl}` : '',
      result.published && result.url
        ? `Live: ${result.url}`
        : 'Not published: only the preview address works, for anyone with the link (the publish tool makes it public).',
    ]
      .filter(Boolean)
      .join('\n'),
    structured: {
      project: target.name,
      files: assets.length,
      uploaded: needed.length,
      ...result,
    },
  };
}

type Version = {
  id: string;
  number?: number;
  createdAt?: string;
  message?: string;
  live: number | null;
};

async function runTool(
  api: Api,
  name: string,
  args: Json,
): Promise<{ summary: string; structured: Json }> {
  switch (name) {
    case 'list_projects': {
      const list = await call<Json[]>(api, '/projects');
      const projects = list.map((p) => ({
        id: p.id,
        name: p.name,
        framework: p.framework,
        freeOnly: p.freeOnly,
      }));
      return {
        summary: projects.length
          ? projects
              .map((p) => `${p.name} (${p.framework}, ${p.id})`)
              .join('\n')
          : 'No projects yet. Use create_project.',
        structured: { projects },
      };
    }
    case 'create_project': {
      const created = await call<Json>(api, '/projects', {
        method: 'POST',
        body: {
          name: str(args, 'name'),
          framework: args.framework ?? 'static',
        },
      });
      return {
        summary: `Created the project ${created.name} (${created.id}). It is Free-only: nothing that can bill is created.`,
        structured: created,
      };
    }
    case 'get_project': {
      const p = await findProject(api, args);
      const jobs = await call<Json[]>(api, `/projects/${p.id}/deployments`);
      const production = jobs.find((j) => j.environment !== 'preview');
      const uploads =
        production?.adapter === 'direct-upload'
          ? await call<Json[]>(api, `/projects/${p.id}/uploads`)
          : [];
      const latestPreview =
        (uploads.find((u) => u.previewUrl)?.previewUrl as string) ?? null;
      const url = (production?.live_url as string | null) ?? null;
      return {
        summary: production
          ? `${p.name}: ${production.status}, ${url ? `live at ${url}` : 'not public'}${latestPreview ? `; latest preview ${latestPreview}` : ''}.`
          : `${p.name} has not been deployed yet. Use deploy_files.`,
        structured: {
          id: p.id,
          name: p.name,
          deployment: production
            ? {
                adapter: production.adapter,
                status: production.status,
                worker: production.worker_name,
                url,
              }
            : null,
          latestPreview,
        },
      };
    }
    case 'deploy_files':
      return deployFiles(api, args);
    case 'publish': {
      const p = await findProject(api, args);
      if (typeof args.public !== 'boolean')
        throw new ToolError('public is required: true or false.');
      const { result } = await call<{
        result: { published: boolean; url: string | null };
      }>(api, `/projects/${p.id}/${args.public ? 'publish' : 'unpublish'}`, {
        method: 'POST',
        body: confirmed(),
      });
      return {
        summary: result.published
          ? `Published${result.url ? ` at ${result.url}` : ''}.`
          : 'Unpublished: only preview addresses work.',
        structured: result,
      };
    }
    case 'list_deployments': {
      const p = await findProject(api, args);
      const jobs = await call<Json[]>(api, `/projects/${p.id}/deployments`);
      const deployments = jobs.map((j) => ({
        id: j.id,
        environment: j.environment,
        adapter: j.adapter,
        status: j.status,
        worker: j.worker_name,
        branch: j.branch || null,
        commit: j.commit_sha || null,
        url: j.live_url,
        error: j.error,
        createdAt: j.created_at,
      }));
      return {
        summary: deployments.length
          ? deployments
              .map(
                (d) =>
                  `${d.createdAt} ${d.environment} ${d.adapter}: ${d.status}${d.url ? ` (${d.url})` : ''}`,
              )
              .join('\n')
          : 'No deployments yet.',
        structured: { deployments },
      };
    }
    case 'list_versions': {
      const p = await findProject(api, args);
      const versions = await call<Version[]>(api, `/projects/${p.id}/versions`);
      return {
        summary: versions.length
          ? versions
              .map((v) =>
                [
                  v.live === null ? '' : `[live ${v.live}%]`,
                  v.id,
                  v.createdAt ?? '',
                  v.message ?? '',
                ]
                  .filter(Boolean)
                  .join(' '),
              )
              .join('\n')
          : 'No versions yet.',
        structured: { versions },
      };
    }
    case 'rollback': {
      const p = await findProject(api, args);
      let to = typeof args.version_id === 'string' ? args.version_id : null;
      if (!to) {
        const versions = await call<Version[]>(
          api,
          `/projects/${p.id}/versions`,
        );
        const live = versions.findIndex((v) => v.live === 100);
        if (live === -1)
          throw new ToolError(
            'Traffic is split between versions; pass version_id.',
          );
        to = versions[live + 1]?.id ?? null;
        if (!to)
          throw new ToolError('There is no earlier version to go back to.');
      }
      await call(api, `/projects/${p.id}/rollback`, {
        method: 'POST',
        body: { ...confirmed(), versionId: to },
      });
      return {
        summary: `Version ${to} now serves all traffic. Database changes are not undone.`,
        structured: { versionId: to },
      };
    }
    case 'list_secrets': {
      const p = await findProject(api, args);
      const secrets = await call<{ name: string }[]>(
        api,
        `/projects/${p.id}/secrets`,
      );
      const names = secrets.map((s) => s.name);
      return {
        summary: names.length ? names.join('\n') : 'No runtime secrets.',
        structured: { names },
      };
    }
    case 'set_secret': {
      const p = await findProject(api, args);
      const secret = str(args, 'name');
      await call(api, `/projects/${p.id}/secrets`, {
        method: 'PUT',
        body: { ...confirmed(), name: secret, value: str(args, 'value') },
      });
      return {
        summary: `Saved the runtime secret ${secret}.`,
        structured: { name: secret },
      };
    }
    case 'get_signin_info': {
      const p = await findProject(api, args);
      const info = await call<Json>(api, `/projects/${p.id}/backend`);
      if (info.status !== 'active' || typeof info.url !== 'string')
        return {
          summary:
            'Sign-in & realtime is not on for this project. The owner can turn it on in the Shipcel dashboard: open the project, then Sign-in & realtime.',
          structured: { status: info.status },
        };
      const realtimeUrl = `${info.url.replace(/^https/, 'wss')}/realtime/channels/`;
      const appSecrets = [
        'CLOUDCEL_AUTH_ISSUER',
        'CLOUDCEL_CLIENT_ID',
        'CLOUDCEL_REALTIME_URL',
        'CLOUDCEL_REALTIME_SECRET',
      ];
      return {
        summary: `Sign-in is OpenID Connect (authorization code with PKCE S256, public client). Issuer ${info.url}, client ID ${info.clientId}. Realtime: ${realtimeUrl}<channel>. The app’s Worker already has ${appSecrets.join(', ')} as runtime secrets.`,
        structured: {
          status: 'active',
          issuer: info.url,
          clientId: info.clientId,
          realtimeUrl,
          appSecrets,
        },
      };
    }
  }
  throw new Error(`No tool ${name}`);
}

// ---------------------------------------------------------------------------------------
// JSON-RPC over HTTP.

const respond = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { 'Content-Type': 'application/json' }),
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
const failure = (
  id: unknown,
  code: number,
  message: string,
  status: number,
  data?: unknown,
) =>
  respond(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    status,
  );

// Header values may be sent as =?base64?…?= when they aren't plain ASCII.
function headerValue(value: string | null) {
  const encoded = value?.match(/^=\?base64\?(.*)\?=$/);
  if (!encoded) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      fromBase64(encoded[1]),
    );
  } catch {
    return null;
  }
}

export async function mcp(
  request: Request,
  deps: {
    // Shipcel's own origin; browsers on any other origin are refused.
    origin: string;
    authenticate: (token: string) => Promise<boolean>;
    // Shipcel's API, called as the token's owner.
    api: (token: string) => Api;
  },
) {
  if (request.method !== 'POST') return respond(null, 405, { Allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== deps.origin)
    return failure(
      null,
      -32600,
      'Requests from this origin are not allowed.',
      403,
    );
  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
  if (!token || !(await deps.authenticate(token)))
    return respond(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32001,
          message:
            'Send an API token from Shipcel (API & CLI) as Authorization: Bearer <token>.',
        },
      },
      401,
      {
        // Where an OAuth-capable client finds the authorization server (RFC 9728).
        'WWW-Authenticate': `Bearer realm="shipcel", error="invalid_token", resource_metadata="${deps.origin}/.well-known/oauth-protected-resource"`,
      },
    );
  let message: Json;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return failure(null, -32700, 'Parse error.', 400);
  }
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    message.jsonrpc !== '2.0' ||
    typeof message.method !== 'string' ||
    (message.id !== undefined &&
      typeof message.id !== 'string' &&
      typeof message.id !== 'number')
  )
    return failure(null, -32600, 'Invalid request.', 400);
  const id = message.id as string | number | undefined;
  const method = message.method;
  // Notifications (no id) need no answer.
  if (id === undefined) return respond(null, 202);
  const params = (
    message.params && typeof message.params === 'object' ? message.params : {}
  ) as Json;
  const meta = (
    params._meta && typeof params._meta === 'object' ? params._meta : {}
  ) as Json;
  const header = request.headers.get('MCP-Protocol-Version');
  const modern =
    typeof meta[KEY.version] === 'string' ||
    (header !== null && MODERN.includes(header));

  if (modern) {
    const version = meta[KEY.version];
    if (typeof version !== 'string')
      return failure(id, -32602, `Missing ${KEY.version} in _meta.`, 400);
    if (!MODERN.includes(version))
      return failure(id, -32022, 'Unsupported protocol version.', 400, {
        supported: SUPPORTED,
        requested: version,
      });
    const capabilities = meta[KEY.capabilities];
    if (!capabilities || typeof capabilities !== 'object')
      return failure(id, -32602, `Missing ${KEY.capabilities} in _meta.`, 400);
    const mismatch = (name: string) =>
      failure(id, -32020, `The ${name} header doesn’t match the request.`, 400);
    if (header !== version) return mismatch('MCP-Protocol-Version');
    if (request.headers.get('Mcp-Method') !== method)
      return mismatch('Mcp-Method');
    if (
      ['tools/call', 'prompts/get', 'resources/read'].includes(method) &&
      headerValue(request.headers.get('Mcp-Name')) !==
        (params.name ?? params.uri)
    )
      return mismatch('Mcp-Name');
  } else if (
    header !== null &&
    !LEGACY.includes(header) &&
    method !== 'initialize'
  )
    return failure(id, -32022, 'Unsupported protocol version.', 400, {
      supported: SUPPORTED,
      requested: header,
    });

  const ok = (result: Json) =>
    respond({
      jsonrpc: '2.0',
      id,
      result: modern
        ? {
            resultType: 'complete',
            ...result,
            _meta: { [KEY.serverInfo]: SERVER_INFO },
          }
        : result,
    });
  const invalid = (problem: string) =>
    failure(id, -32602, problem, modern ? 400 : 200);
  const capabilities = { tools: {}, prompts: {} };

  switch (method) {
    case 'initialize':
      if (modern) break;
      return ok({
        protocolVersion: LEGACY.includes(String(params.protocolVersion))
          ? params.protocolVersion
          : LEGACY[0],
        capabilities,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case 'server/discover':
      return ok({
        supportedVersions: SUPPORTED,
        capabilities,
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'prompts/list':
      return ok({ prompts: [PROMPT] });
    case 'prompts/get': {
      if (params.name !== PROMPT.name)
        return invalid(`Unknown prompt: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Json;
      const idea =
        typeof args.idea === 'string' && args.idea
          ? args.idea
          : 'a small website';
      return ok({
        description: PROMPT.description,
        messages: [
          {
            role: 'user',
            content: text(
              `Build ${idea}, then deploy it with Shipcel.

Keep to what Shipcel deploys directly: static HTML, CSS and JavaScript (the built output if you use a bundler), plus an optional /_worker.js ES module for API routes:
export default { async fetch(request, env) { /* … */ return env.ASSETS.fetch(request); } }
No database or other bindings in this path.

Steps: find or create the project (list_projects, create_project), deploy every file with deploy_files, then show me the preview address. Ask me before calling publish.`,
            ),
          },
        ],
      });
    }
    case 'tools/call': {
      const name = String(params.name ?? '');
      if (!TOOLS.some((t) => t.name === name))
        return invalid(`Unknown tool: ${name}`);
      const args = (
        params.arguments && typeof params.arguments === 'object'
          ? params.arguments
          : {}
      ) as Json;
      try {
        const result = await runTool(deps.api(token), name, args);
        return ok({
          content: [text(result.summary)],
          structuredContent: result.structured,
          isError: false,
        });
      } catch (error) {
        if (error instanceof ToolError)
          return ok({ content: [text(error.message)], isError: true });
        console.error('MCP tool failed', name, error);
        return failure(id, -32603, 'Internal error.', 500);
      }
    }
  }
  return failure(id, -32601, `Method not found: ${method}`, modern ? 404 : 200);
}
