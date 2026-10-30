// Realtime channels on Durable Objects with WebSocket hibernation: idle connections cost
// no duration. Channels named public:… accept anyone as a listener; other channels need a
// channel token signed by the app's server, or (for user:<id>) that user's sign-in token.
import { DurableObject } from 'cloudflare:workers';
import { verifyAccessToken } from './oidc';
import { tokenAlgorithm, verifyHs256 } from './jwt';
import { activeUser, readSettings, type Env } from './store';
import {
  hashToken,
  HttpError,
  json,
  now,
  randomToken,
  readJson,
  safeEqual,
} from './util';

// anonymous: a public listener; channel: a token signed by the app (its sub is the app's
// own identifier); user: a person signed in through this service, re-checked while connected.
type Identity = {
  kind: 'anonymous' | 'channel' | 'user';
  sub: string;
  info?: unknown;
  publish: boolean;
  exp?: number;
  ip?: string;
};
type Attachment = Identity & { connection: string };

const MAX_CONNECTIONS = 1000;
// Anonymous listeners get a share of a channel and a per-address limit, so one client
// can't hold every connection and lock members out.
const MAX_ANONYMOUS = 500;
const MAX_ANONYMOUS_PER_ADDRESS = 20;
const MAX_MESSAGE = 65536;
const channelName = /^[A-Za-z0-9_:.-]{1,128}$/;
const eventName = /^[A-Za-z0-9_:.-]{1,64}$/;

const member = (a: Identity) => ({
  sub: a.sub,
  ...(a.info === undefined ? {} : { info: a.info }),
});
const signedIn = (a: Identity) => a.kind !== 'anonymous';

export class Channel extends DurableObject<Env> {
  private sockets() {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, a: ws.deserializeAttachment() as Attachment }));
  }

  private members() {
    const seen = new Map<string, ReturnType<typeof member>>();
    for (const { a } of this.sockets())
      if (signedIn(a) && !seen.has(a.sub)) seen.set(a.sub, member(a));
    return [...seen.values()];
  }

  private broadcast(message: unknown, except?: WebSocket) {
    const text = JSON.stringify(message);
    for (const { ws } of this.sockets())
      if (ws !== except)
        try {
          ws.send(text);
        } catch {
          // A closing socket; its close handler cleans up.
        }
  }

  private recheckSeconds() {
    const value = Number(this.env.REALTIME_RECHECK_SECONDS);
    return Number.isFinite(value) && value > 0 ? value : 300;
  }

  // Sockets opened with a sign-in token are re-checked: closed when the token expires, or
  // within the recheck interval when the account is disabled or deleted. The alarm only
  // runs while such sockets exist.
  private async scheduleRecheck() {
    const users = this.sockets().filter(({ a }) => a.kind === 'user');
    if (!users.length) return;
    const soonest = Math.min(...users.map(({ a }) => a.exp ?? Infinity));
    const at = Math.min(
      Date.now() + this.recheckSeconds() * 1000,
      soonest * 1000,
    );
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const users = this.sockets().filter(({ a }) => a.kind === 'user');
    if (!users.length) return;
    const subs = [...new Set(users.map(({ a }) => a.sub))];
    const active = new Set<string>();
    for (let i = 0; i < subs.length; i += 50) {
      const batch = subs.slice(i, i + 50);
      const { results } = await this.env.DB.prepare(
        `SELECT id FROM users WHERE disabled=0 AND id IN (${batch.map(() => '?').join(',')})`,
      )
        .bind(...batch)
        .all<{ id: string }>();
      for (const r of results) active.add(r.id);
    }
    const time = now();
    for (const { ws, a } of users)
      if (!active.has(a.sub) || (a.exp !== undefined && a.exp <= time))
        try {
          ws.close(4001, active.has(a.sub) ? 'Sign-in expired' : 'Signed out');
        } catch {
          // Already closed.
        }
    await this.scheduleRecheck();
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const identity = JSON.parse(
        request.headers.get('X-Cloudcel-Identity') ?? 'null',
      ) as Identity;
      const sockets = this.sockets();
      if (sockets.length >= MAX_CONNECTIONS)
        return new Response('This channel is full.', { status: 503 });
      if (identity.kind === 'anonymous') {
        const anonymous = sockets.filter(({ a }) => a.kind === 'anonymous');
        if (
          anonymous.length >= MAX_ANONYMOUS ||
          anonymous.filter(({ a }) => a.ip && a.ip === identity.ip).length >=
            MAX_ANONYMOUS_PER_ADDRESS
        )
          return new Response('Too many listeners on this channel.', {
            status: 429,
          });
      }
      const channel = url.searchParams.get('channel') ?? '';
      const pair = new WebSocketPair();
      const alreadyPresent =
        signedIn(identity) && sockets.some(({ a }) => a.sub === identity.sub);
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({
        ...identity,
        connection: randomToken(8),
      } satisfies Attachment);
      pair[1].send(
        JSON.stringify({ type: 'welcome', channel, members: this.members() }),
      );
      if (signedIn(identity) && !alreadyPresent)
        this.broadcast(
          { type: 'presence', event: 'join', member: member(identity) },
          pair[1],
        );
      if (identity.kind === 'user') await this.scheduleRecheck();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/publish' && request.method === 'POST') {
      const body = (await request.json()) as { event: string; data: unknown };
      // "server": true marks messages from the app's server; members' messages carry "from"
      // instead, so no channel token can pass itself off as the server.
      this.broadcast({
        type: 'message',
        event: body.event,
        data: body.data,
        server: true,
      });
      return json({ delivered: this.ctx.getWebSockets().length });
    }
    if (url.pathname === '/presence') return json({ members: this.members() });
    return new Response('Not found.', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const sender = ws.deserializeAttachment() as Attachment;
    const reply = (text: string) =>
      ws.send(JSON.stringify({ type: 'error', message: text }));
    if (typeof message !== 'string' || message.length > MAX_MESSAGE)
      return reply('Messages must be text, up to 64 KB.');
    if (!sender.publish) return reply('This connection can only listen.');
    let parsed: { event?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      return reply('Messages must be JSON.');
    }
    if (typeof parsed.event !== 'string' || !eventName.test(parsed.event))
      return reply('Give each message an event name.');
    this.broadcast(
      {
        type: 'message',
        event: parsed.event,
        data: parsed.data ?? null,
        from: sender.sub,
      },
      ws,
    );
  }

  async webSocketClose(ws: WebSocket) {
    this.left(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  private left(ws: WebSocket) {
    const leaving = ws.deserializeAttachment() as Attachment | null;
    try {
      ws.close(1000, 'closed');
    } catch {
      // Already closed.
    }
    if (!leaving || !signedIn(leaving)) return;
    const stillHere = this.sockets().some(
      ({ ws: other, a }) => other !== ws && a.sub === leaving.sub,
    );
    if (!stillHere)
      this.broadcast(
        { type: 'presence', event: 'leave', member: member(leaving) },
        ws,
      );
  }
}

const allows = (patterns: unknown, channel: string) =>
  Array.isArray(patterns) &&
  patterns.some(
    (p) =>
      typeof p === 'string' &&
      (p === channel ||
        (p.endsWith('*') && channel.startsWith(p.slice(0, -1)))),
  );

async function identityFor(
  request: Request,
  env: Env,
  channel: string,
): Promise<Identity> {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) {
    if (!channel.startsWith('public:'))
      throw new HttpError(401, 'This channel needs a token.', 'invalid_token');
    // Only a hash of the address is kept, to count connections per address.
    const address = request.headers.get('CF-Connecting-IP');
    return {
      kind: 'anonymous',
      sub: 'anonymous',
      publish: false,
      ...(address ? { ip: (await hashToken(address)).slice(0, 16) } : {}),
    };
  }
  if (tokenAlgorithm(token) === 'HS256') {
    if (!env.REALTIME_SECRET)
      throw new HttpError(500, 'Realtime is not configured.', 'server_error');
    const claims = await verifyHs256(token, env.REALTIME_SECRET);
    if (
      typeof claims.sub !== 'string' ||
      claims.sub.length > 256 ||
      !allows(claims.channels, channel)
    )
      throw new HttpError(
        403,
        'This token does not allow this channel.',
        'access_denied',
      );
    const info = claims.info;
    if (info !== undefined && JSON.stringify(info).length > 1024)
      throw new HttpError(400, 'Token info is limited to 1 KB.');
    return {
      kind: 'channel',
      sub: claims.sub,
      info,
      publish: claims.publish === true,
    };
  }
  // A sign-in access token lets an active user listen on public channels and their own
  // user:<id> channel.
  const { claims } = await verifyAccessToken(request, env, token);
  if (
    channel !== `user:${claims.sub}` &&
    !channel.startsWith('public:') &&
    !channel.startsWith('signed-in:')
  )
    throw new HttpError(
      403,
      'Sign-in tokens can join public and signed-in: channels, and your own user channel.',
      'access_denied',
    );
  try {
    await activeUser(env, claims.sub as string);
  } catch (error) {
    if (error instanceof HttpError)
      throw new HttpError(
        403,
        'This account can’t use realtime.',
        'access_denied',
      );
    throw error;
  }
  return {
    kind: 'user',
    sub: claims.sub as string,
    publish: false,
    exp: claims.exp,
  };
}

function requireServerKey(request: Request, env: Env) {
  const header = request.headers.get('Authorization') ?? '';
  if (
    !env.REALTIME_SECRET ||
    !header.startsWith('Bearer ') ||
    !safeEqual(header.slice(7), env.REALTIME_SECRET)
  )
    throw new HttpError(
      401,
      'The realtime secret is required.',
      'invalid_token',
    );
}

const stub = (env: Env, channel: string) =>
  env.CHANNELS.get(env.CHANNELS.idFromName(channel));

// An event from the service itself to a channel's members.
export const publish = (
  env: Env,
  channel: string,
  event: string,
  data: unknown,
) =>
  stub(env, channel).fetch(
    new Request('https://channel/publish', {
      method: 'POST',
      body: JSON.stringify({ event, data }),
    }),
  );

function decodeChannel(raw: string) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

// /realtime/channels/<name>[/messages|/presence]
export async function realtime(request: Request, env: Env, path: string) {
  const settings = await readSettings(env);
  if (!settings.realtime)
    throw new HttpError(404, 'Realtime is turned off for this app.');
  const match = path.match(
    /^\/realtime\/channels\/([^/]+)(\/messages|\/presence)?$/,
  );
  const channel = match ? decodeChannel(match[1]) : '';
  if (!match || !channelName.test(channel))
    throw new HttpError(404, 'Unknown channel address.');
  if (!match[2]) {
    if (request.headers.get('Upgrade') !== 'websocket')
      throw new HttpError(426, 'Connect with a WebSocket.');
    const identity = await identityFor(request, env, channel);
    return stub(env, channel).fetch(
      new Request(
        `https://channel/connect?channel=${encodeURIComponent(channel)}`,
        {
          headers: {
            Upgrade: 'websocket',
            'X-Cloudcel-Identity': JSON.stringify(identity),
          },
        },
      ),
    );
  }
  requireServerKey(request, env);
  if (match[2] === '/presence' && request.method === 'GET')
    return stub(env, channel).fetch(new Request('https://channel/presence'));
  if (match[2] === '/messages' && request.method === 'POST') {
    const body = (await readJson(request, MAX_MESSAGE)) as {
      event?: unknown;
      data?: unknown;
    } | null;
    if (!body || typeof body.event !== 'string' || !eventName.test(body.event))
      throw new HttpError(400, 'Send {"event": "name", "data": …}.');
    return publish(env, channel, body.event, body.data ?? null);
  }
  throw new HttpError(405, 'Method not allowed.');
}
