import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { database } from './helpers/database';
import app from '../worker/index';

// OAuth for the MCP server (worker/oauth-server.ts): chat apps and agents that only sign in
// with OAuth (Claude.ai, ChatGPT) register as clients, send the owner to the dashboard to
// approve, and exchange the code for an API token, which the MCP server already accepts.
const origin = 'https://shipcel.test';
const callback = 'https://claude.ai/api/mcp/auth_callback';
let db: ReturnType<typeof database>;
let who: Awaited<ReturnType<ReturnType<typeof database>['user']>>;
const root = (path: string, init: RequestInit = {}) =>
  app.request(`${origin}${path}`, { redirect: 'manual', ...init }, db.env);
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge: b64url(digest) };
}
const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
async function register(redirect = callback) {
  const response = await root(
    '/oauth/register',
    jsonPost({ client_name: 'Claude', redirect_uris: [redirect] }),
  );
  return {
    status: response.status,
    client: (await response.json()) as Record<string, unknown>,
  };
}
const approvalId = (started: Response) =>
  new URL(started.headers.get('Location')!).hash.match(
    /^#oauth\/([\w-]+)$/,
  )![1];

beforeEach(async () => {
  db = database();
  who = await db.user(1);
});
afterEach(() => db.close());

describe('OAuth for the MCP server', () => {
  it('publishes the metadata MCP clients discover, and points at it from a refused /mcp call', async () => {
    const resource = (await (
      await root('/.well-known/oauth-protected-resource')
    ).json()) as Record<string, unknown>;
    expect(resource).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
    });
    const server = (await (
      await root('/.well-known/oauth-authorization-server')
    ).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      response_types_supported: ['code'],
    });
    const refused = await root('/mcp', jsonPost({}));
    expect(refused.status).toBe(401);
    expect(refused.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
  });

  it('registers public clients with HTTPS or loopback return addresses only', async () => {
    const made = await register();
    expect(made.status).toBe(201);
    expect(made.client).toMatchObject({
      client_name: 'Claude',
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    expect(String(made.client.client_id)).toMatch(/^mcp_[\w-]{20,}$/);
    expect((await register('http://localhost:3000/callback')).status).toBe(201);
    expect((await register('http://evil.test/callback')).status).toBe(400);
    expect(
      (await root('/oauth/register', jsonPost({ redirect_uris: [] }))).status,
    ).toBe(400);
  });

  it('sends the owner to the dashboard to approve, then exchanges the code once, with PKCE, for a token the MCP server accepts', async () => {
    const { client } = await register();
    const clientId = String(client.client_id);
    const { verifier, challenge } = await pkce();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'mcp',
      resource: `${origin}/mcp`,
    });
    const started = await root(`/oauth/authorize?${params}`);
    expect(started.status).toBe(302);
    expect(new URL(started.headers.get('Location')!).origin).toBe(origin);
    const id = approvalId(started);
    // The dashboard shows who is asking; deciding needs a signed-in developer or owner.
    expect((await db.request(`/oauth/${id}`)).status).toBe(401);
    const shown = (await (
      await db.request(`/oauth/${id}`, {}, who.cookie)
    ).json()) as Record<string, unknown>;
    expect(shown).toMatchObject({
      client: { name: 'Claude', redirectHost: 'claude.ai' },
      status: 'pending',
    });
    const approved = (await (
      await db.request(
        `/oauth/${id}/approve`,
        { method: 'POST', body: '{}' },
        who.cookie,
      )
    ).json()) as { redirect: string };
    const back = new URL(approved.redirect);
    expect(back.origin + back.pathname).toBe(callback);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;
    const exchange = (fields: Record<string, string>) =>
      root('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: callback,
          client_id: clientId,
          code_verifier: verifier,
          ...fields,
        }).toString(),
      });
    expect(
      (await exchange({ code_verifier: 'wrong-verifier-'.repeat(3) })).status,
    ).toBe(400);
    const granted = await exchange({});
    expect(granted.status).toBe(200);
    const tokens = (await granted.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBeGreaterThan(0);
    // A code works once.
    expect((await exchange({})).status).toBe(400);
    // The token works at the MCP server, and is listed under the agent's name.
    const listed = await root('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${tokens.access_token}`,
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(listed.status).toBe(200);
    const mine = (await (
      await db.request('/tokens', {}, who.cookie)
    ).json()) as { name: string }[];
    expect(mine.map((t) => t.name)).toContain('Claude (MCP)');
    // Denying sends the app back with an error and makes no token.
    const again = await root(`/oauth/authorize?${params}`);
    const denied = (await (
      await db.request(
        `/oauth/${approvalId(again)}/deny`,
        { method: 'POST', body: '{}' },
        who.cookie,
      )
    ).json()) as { redirect: string };
    expect(new URL(denied.redirect).searchParams.get('error')).toBe(
      'access_denied',
    );
    expect(
      (
        (await (await db.request('/tokens', {}, who.cookie)).json()) as {
          name: string;
        }[]
      ).filter((t) => t.name === 'Claude (MCP)'),
    ).toHaveLength(1);
  });

  it('refuses an authorization request with an unknown client, an unregistered return address or without S256', async () => {
    const { client } = await register();
    const base = {
      client_id: String(client.client_id),
      redirect_uri: callback,
      response_type: 'code',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    };
    for (const bad of [
      { client_id: 'mcp_nope' },
      { redirect_uri: 'https://other.test/cb' },
      { code_challenge_method: 'plain' },
      { code_challenge: '' },
    ])
      expect(
        (
          await root(
            `/oauth/authorize?${new URLSearchParams({ ...base, ...bad })}`,
          )
        ).status,
        JSON.stringify(bad),
      ).toBe(400);
  });
});
