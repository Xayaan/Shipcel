import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from './helpers/database';
import { cloudflareUploads } from './helpers/cloudflare-uploads';
import app from '../worker/index';

// Shipcel's MCP server, driven the way Claude Code, Codex or Cursor drive it: JSON-RPC over
// POST /mcp with an API token. Tool calls go through the real Shipcel API to a fake
// Cloudflare.
const CURRENT = '2026-07-28';
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

let db: ReturnType<typeof database>;
let fx: ReturnType<typeof cloudflareUploads>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
let token: string;
let nextId = 1;

type Rpc = {
  status: number;
  headers: Headers;
  body: {
    id?: number;
    result?: Record<string, unknown> & {
      content?: { type: string; text: string }[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    error?: { code: number; message: string; data?: Record<string, unknown> };
  } | null;
};

// A request in the current (stateless) revision: version and capabilities in _meta, and
// the method and tool name repeated in headers. `headers` overrides or (null) removes one.
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    legacy?: string;
    headers?: Record<string, string | null>;
    meta?: Record<string, unknown> | null;
    notification?: boolean;
    raw?: string;
    bearer?: string | null;
  } = {},
): Promise<Rpc> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  });
  const bearer = options.bearer === undefined ? token : options.bearer;
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
  let sent = params;
  if (options.legacy) {
    if (method !== 'initialize')
      headers.set('MCP-Protocol-Version', options.legacy);
  } else {
    headers.set('MCP-Protocol-Version', CURRENT);
    headers.set('Mcp-Method', method);
    if (typeof params.name === 'string') headers.set('Mcp-Name', params.name);
    if (options.meta !== null)
      sent = {
        ...params,
        _meta: {
          [VERSION_KEY]: CURRENT,
          [CAPABILITIES_KEY]: {},
          ...options.meta,
        },
      };
  }
  for (const [name, value] of Object.entries(options.headers ?? {}))
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  const response = await app.request(
    'https://shipcel.test/mcp',
    {
      method: 'POST',
      headers,
      body:
        options.raw ??
        JSON.stringify({
          jsonrpc: '2.0',
          ...(options.notification ? {} : { id: nextId++ }),
          method,
          params: sent,
        }),
    },
    db.env,
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}
async function tool(name: string, args: Record<string, unknown>) {
  const response = await rpc('tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  expect(response.body?.error).toBeUndefined();
  const result = response.body!.result!;
  return {
    ...result,
    text: result.content!.map((c) => c.text).join('\n'),
  };
}
async function newToken(user = who) {
  const response = await db.request(
    '/tokens',
    { method: 'POST', body: JSON.stringify({ name: 'Agent' }) },
    user.cookie,
  );
  return (await response.json()) as { id: string; token: string };
}

beforeEach(async () => {
  db = database();
  who = await db.user(1);
  await db.grant(who, 'github');
  await db.grant(who, 'cloudflare');
  fx = cloudflareUploads();
  vi.stubGlobal('fetch', vi.fn(fx.handler));
  token = (await newToken()).token;
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('MCP server access', () => {
  it('needs an API token, not a browser session', async () => {
    const anonymous = await rpc('tools/list', {}, { bearer: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('WWW-Authenticate')).toMatch(/^Bearer /);
    // A signed-in browser's cookie is not enough: agents authenticate with tokens.
    const cookie = await rpc(
      'tools/list',
      {},
      { bearer: null, headers: { Cookie: who.cookie } },
    );
    expect(cookie.status).toBe(401);
    const unknown = await rpc(
      'tools/list',
      {},
      { bearer: `cc_pat_${'x'.repeat(43)}` },
    );
    expect(unknown.status).toBe(401);
    const revoked = await newToken();
    expect(
      (
        await db.request(
          `/tokens/${revoked.id}`,
          { method: 'DELETE' },
          who.cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await rpc('tools/list', {}, { bearer: revoked.token })).status,
    ).toBe(401);
    expect((await rpc('tools/list')).status).toBe(200);
  });

  it('answers only POST, and refuses web pages on other origins', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await app.request(
        'https://shipcel.test/mcp',
        { method, headers: { Authorization: `Bearer ${token}` } },
        db.env,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
    const foreign = await rpc(
      'tools/list',
      {},
      { headers: { Origin: 'https://evil.example' } },
    );
    expect(foreign.status).toBe(403);
    expect(
      (
        await rpc(
          'tools/list',
          {},
          { headers: { Origin: 'https://shipcel.test' } },
        )
      ).status,
    ).toBe(200);
    // Only on Shipcel's own address.
    const elsewhere = await app.request(
      'https://shipcel-copy.example/mcp',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: '{}',
      },
      db.env,
    );
    expect(elsewhere.status).toBe(403);
  });

  it('refuses oversized requests before reading them', async () => {
    const response = await rpc(
      'tools/list',
      {},
      { raw: ' '.repeat(11 * 1024 * 1024) },
    );
    expect(response.status).toBe(413);
  });
});

describe('MCP protocol', () => {
  it('lets older clients initialize, then list tools', async () => {
    const init = await rpc(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-agent', version: '1.0.0' },
      },
      { legacy: '2025-06-18' },
    );
    expect(init.status).toBe(200);
    expect(init.body!.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: 'shipcel' },
    });
    expect(init.body!.result!.instructions).toContain('deploy_files');
    expect(init.body!.result!.resultType).toBeUndefined();
    // A version the server doesn't speak gets the newest one it does.
    const old = await rpc(
      'initialize',
      { protocolVersion: '2024-11-05', capabilities: {} },
      { legacy: '2024-11-05' },
    );
    expect(old.body!.result!.protocolVersion).toBe('2025-11-25');
    const initialized = await rpc(
      'notifications/initialized',
      {},
      { legacy: '2025-06-18', notification: true },
    );
    expect(initialized.status).toBe(202);
    expect(initialized.body).toBeNull();
    const list = await rpc('tools/list', {}, { legacy: '2025-06-18' });
    const tools = list.body!.result!.tools as {
      name: string;
      inputSchema: { type: string };
    }[];
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'create_project',
        'deploy_files',
        'get_project',
        'get_signin_info',
        'list_deployments',
        'list_projects',
        'list_secrets',
        'list_versions',
        'publish',
        'rollback',
        'set_secret',
      ].sort(),
    );
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
    expect(
      (await rpc('ping', {}, { legacy: '2025-06-18' })).body!.result,
    ).toEqual({});
    const unsupported = await rpc('tools/list', {}, { legacy: '1999-01-01' });
    expect(unsupported.status).toBe(400);
  });

  it('serves current clients statelessly, with metadata on every request', async () => {
    const discover = await rpc('server/discover');
    expect(discover.status).toBe(200);
    expect(discover.body!.result).toMatchObject({
      resultType: 'complete',
      capabilities: { tools: {}, prompts: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'shipcel' } },
    });
    expect(discover.body!.result!.supportedVersions).toEqual(
      expect.arrayContaining([CURRENT, '2025-11-25', '2025-06-18']),
    );
    const list = await rpc('tools/list');
    expect(list.body!.result!.resultType).toBe('complete');
    expect((list.body!.result!.tools as unknown[]).length).toBe(11);
    // initialize belongs to the older revisions.
    const init = await rpc('initialize', { protocolVersion: CURRENT });
    expect(init.status).toBe(404);
    expect(init.body!.error!.code).toBe(-32601);
  });

  it('checks that headers match the request body', async () => {
    const method = await rpc(
      'tools/list',
      {},
      { headers: { 'Mcp-Method': 'prompts/list' } },
    );
    expect(method.status).toBe(400);
    expect(method.body!.error!.code).toBe(-32020);
    const version = await rpc(
      'tools/list',
      {},
      { headers: { 'MCP-Protocol-Version': null } },
    );
    expect(version.body!.error!.code).toBe(-32020);
    const name = await rpc(
      'tools/call',
      { name: 'list_projects', arguments: {} },
      { headers: { 'Mcp-Name': null } },
    );
    expect(name.status).toBe(400);
    expect(name.body!.error!.code).toBe(-32020);
    const other = await rpc(
      'tools/call',
      { name: 'list_projects', arguments: {} },
      { headers: { 'Mcp-Name': 'rollback' } },
    );
    expect(other.body!.error!.code).toBe(-32020);
    // Names may be sent base64-encoded.
    const encoded = await rpc(
      'tools/call',
      { name: 'list_projects', arguments: {} },
      {
        headers: {
          'Mcp-Name': `=?base64?${Buffer.from('list_projects').toString('base64')}?=`,
        },
      },
    );
    expect(encoded.status).toBe(200);
    expect(encoded.body!.result!.isError).toBe(false);
  });

  it('refuses unsupported versions and missing metadata', async () => {
    const future = await rpc(
      'tools/list',
      {},
      {
        meta: { [VERSION_KEY]: '2099-01-01' },
        headers: { 'MCP-Protocol-Version': '2099-01-01' },
      },
    );
    expect(future.status).toBe(400);
    expect(future.body!.error).toMatchObject({
      code: -32022,
      data: { requested: '2099-01-01' },
    });
    expect(future.body!.error!.data!.supported).toContain(CURRENT);
    const capabilities = await rpc(
      'tools/list',
      {},
      { meta: { [CAPABILITIES_KEY]: undefined } },
    );
    expect(capabilities.status).toBe(400);
    expect(capabilities.body!.error!.code).toBe(-32602);
    // The current version in the header promises _meta in the body.
    const bare = await rpc('tools/list', {}, { meta: null });
    expect(bare.status).toBe(400);
    expect(bare.body!.error!.code).toBe(-32602);
  });

  it('reports malformed and unknown requests as JSON-RPC errors', async () => {
    const parse = await rpc('tools/list', {}, { raw: '{not json' });
    expect(parse.status).toBe(400);
    expect(parse.body!.error!.code).toBe(-32700);
    const batch = await rpc('tools/list', {}, { raw: '[]' });
    expect(batch.status).toBe(400);
    expect(batch.body!.error!.code).toBe(-32600);
    const nullId = await rpc(
      'tools/list',
      {},
      { raw: JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }) },
    );
    expect(nullId.body!.error!.code).toBe(-32600);
    const unknown = await rpc('resources/list');
    expect(unknown.status).toBe(404);
    expect(unknown.body!.error!.code).toBe(-32601);
    const tool = await rpc('tools/call', {
      name: 'format_disk',
      arguments: {},
    });
    expect(tool.body!.error!.code).toBe(-32602);
  });

  it('offers a prompt for building and deploying a site', async () => {
    const list = await rpc('prompts/list');
    expect(list.body!.result!.prompts).toEqual([
      expect.objectContaining({ name: 'build_and_deploy' }),
    ]);
    const prompt = await rpc('prompts/get', {
      name: 'build_and_deploy',
      arguments: { idea: 'a bakery menu page' },
    });
    const messages = prompt.body!.result!.messages as {
      content: { text: string };
    }[];
    expect(messages[0].content.text).toContain('a bakery menu page');
    expect(messages[0].content.text).toContain('deploy_files');
    expect(messages[0].content.text).toContain('Ask me before calling publish');
  });
});

describe('MCP tools, against the real Shipcel API', () => {
  it('creates, deploys, publishes and rolls back a site', async () => {
    expect((await tool('list_projects', {})).text).toContain('No projects yet');
    const created = await tool('create_project', { name: 'agent-site' });
    expect(created.isError).toBe(false);
    expect(created.structuredContent).toMatchObject({
      name: 'agent-site',
      framework: 'static',
      freeOnly: true,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]).toString(
      'base64',
    );
    const first = await tool('deploy_files', {
      project: 'agent-site',
      files: [
        { path: '/index.html', content: '<h1>Hi</h1>' },
        { path: '/logo.png', content: png, encoding: 'base64' },
        {
          path: '/_worker.js',
          content: 'export default { fetch: (r, env) => env.ASSETS.fetch(r) };',
        },
        { path: '/_redirects', content: '/old /new 301' },
      ],
    });
    expect(first.isError).toBe(false);
    expect(first.text).toContain('Deployed 2 files (2 new) to agent-site.');
    expect(first.text).toContain(
      'Preview: https://00000001-agent-site.test-account.workers.dev',
    );
    expect(first.text).toContain(
      'Not published: only the preview address works',
    );
    expect(
      [...fx.state.stored.values()].map((f) => [
        Buffer.from(f.content, 'base64').toString('base64'),
        f.type,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [
          Buffer.from('<h1>Hi</h1>').toString('base64'),
          'text/html; charset=utf-8',
        ],
        [png, 'image/png'],
      ]),
    );
    expect(fx.state.workers.get('agent-site')!.metadata).toMatchObject({
      main_module: '_worker.js',
      assets: { config: { _redirects: '/old /new 301' } },
    });
    expect(fx.state.route).toEqual({ enabled: false, previews_enabled: true });

    const published = await tool('publish', {
      project: 'agent-site',
      public: true,
    });
    expect(published.text).toBe(
      'Published at https://agent-site.test-account.workers.dev/.',
    );
    expect(fx.state.route!.enabled).toBe(true);
    const project = await tool('get_project', { project: 'agent-site' });
    expect(project.structuredContent).toMatchObject({
      deployment: {
        adapter: 'direct-upload',
        url: 'https://agent-site.test-account.workers.dev/',
      },
      latestPreview: 'https://00000001-agent-site.test-account.workers.dev',
    });

    // A second deploy uploads only the changed file and stays public.
    const second = await tool('deploy_files', {
      project: 'agent-site',
      files: [
        { path: '/index.html', content: '<h1>Hello again</h1>' },
        { path: '/logo.png', content: png, encoding: 'base64' },
      ],
    });
    expect(second.text).toContain('Deployed 2 files (1 new) to agent-site.');
    expect(second.text).toContain(
      'Live: https://agent-site.test-account.workers.dev/',
    );
    const versions = await tool('list_versions', { project: 'agent-site' });
    expect(
      (versions.structuredContent!.versions as { live: number | null }[]).map(
        (v) => v.live,
      ),
    ).toEqual([100, null]);
    const rollback = await tool('rollback', { project: 'agent-site' });
    expect(rollback.text).toContain(
      '00000001-0000-4000-8000-000000000000 now serves all traffic',
    );
    expect(fx.state.live).toBe('00000001-0000-4000-8000-000000000000');
    const again = await tool('rollback', { project: 'agent-site' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('no earlier version');

    const secret = await tool('set_secret', {
      project: 'agent-site',
      name: 'API_KEY',
      value: 'sk-very-secret-value',
    });
    expect(secret.text).toBe('Saved the runtime secret API_KEY.');
    expect(JSON.stringify(secret)).not.toContain('sk-very-secret-value');
    expect(fx.state.secrets.get('API_KEY')).toBe('sk-very-secret-value');
    expect((await tool('list_secrets', { project: 'agent-site' })).text).toBe(
      'API_KEY',
    );
    expect(
      (await tool('get_signin_info', { project: 'agent-site' })).text,
    ).toContain('not on');
    // Nothing the agent did left the API token in Shipcel's records or responses.
    expect(
      JSON.stringify(
        db.sqlite.prepare('SELECT * FROM project_operations').all(),
      ),
    ).not.toContain(token);
  });

  it('reports problems as tool errors the agent can read', async () => {
    const missing = await tool('deploy_files', {
      project: 'nope',
      files: [{ path: '/index.html', content: 'x' }],
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('No project nope');
    await tool('create_project', { name: 'agent-site' });
    const binary = await tool('deploy_files', {
      project: 'agent-site',
      files: [{ path: '/a.png', content: '%%%', encoding: 'base64' }],
    });
    expect(binary.isError).toBe(true);
    expect(binary.text).toContain('not valid base64');
    const name = await tool('create_project', { name: 'Bad Name' });
    expect(name.isError).toBe(true);
    expect(name.text).toContain('lowercase letters');
    const path = await tool('deploy_files', {
      project: 'agent-site',
      files: [{ path: 'no-slash.html', content: 'x' }],
    });
    expect(path.isError).toBe(true);
    expect(fx.state.workers.size).toBe(0);
  });

  it('acts only as the token’s owner', async () => {
    const other = await db.user(2);
    const created = await db.request(
      '/projects',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'someone-else', framework: 'static' }),
      },
      other.cookie,
    );
    const { id } = (await created.json()) as { id: string };
    expect((await tool('list_projects', {})).text).not.toContain(
      'someone-else',
    );
    for (const ref of ['someone-else', id]) {
      const result = await tool('get_project', { project: ref });
      expect(result.isError).toBe(true);
    }
  });
});
