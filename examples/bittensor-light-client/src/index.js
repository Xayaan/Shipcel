// A Bittensor (Finney) light client on Cloudflare: smoldot runs inside one Durable Object, talks
// to Finney's peers itself, verifies headers and GRANDPA finality, and answers JSON-RPC over
// WebSocket (/). GET /status reports what it has verified.
import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { start } from 'smoldot-client';
import bytecode from './smoldot.wasm';
import chainSpec from './finney.json';
import checkpoint from './finney-checkpoint.json';
import { workersPlatform } from './platform.js';
import { Router, error } from './router.js';
import { page } from './page.js';
import { RateLimit, clientOf, unlock } from './access.js';
import { History, archiveNode, sqlStore } from './history.js';
import { MemoryTrace } from './memory.js';

const HEARTBEAT_MS = 30_000; // an alarm this often keeps the object in memory
const SAVE_EVERY_MS = 10 * 60_000; // how often the verified state is saved for a restart
// smoldot's memory peaks while it syncs and compiles the runtime, and Wasm memory never shrinks:
// saving the state and filling the record wait until it has run this long, so that what they
// allocate doesn't add to that peak (and the state saved is a synced one).
const SETTLE_MS = 2 * 60_000;
// The memory trace (src/memory.js): a sample this often for the first 20 seconds of a start, on
// a timer, on each chunk received from a peer and on each line smoldot logs; then every 2
// seconds, until 3 minutes.
const SAMPLE_FAST_MS = 250;
const FAST_FOR_MS = 20_000;
const SAMPLE_SLOW_MS = 2_000;
const TRACE_FOR_MS = 3 * 60_000;
const MAX_BATCH = 100;
// Each caller (an IP address, or an IPv6 /64) may make 20 calls a second and 200 at once, enough
// for a full batch or a client starting up; beyond that the answer is 429. The RPC_KEY secret
// keeps everyone else out (README, "Keep it to yourself").
const RATE = { perSecond: 20, burst: 200 };
const MAX_SOCKETS_PER_CALLER = 8;
// Old blocks come from an archive node, checked where a proof can (src/history.js): Opentensor's
// public one unless ARCHIVE_URL names another ("off" for none). HISTORY_DAYS: how far back the
// verified record of block hashes reaches, 7,200 blocks a day.
const ARCHIVE_URL = 'https://archive.chain.opentensor.ai:443';
const HISTORY_DAYS = 7;
const FILL_PER_ALARM = 1000; // blocks recorded from the archive node per alarm
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });
    const unlocked = await unlock(request, env.RPC_KEY);
    if (!unlocked)
      return json(
        error(
          null,
          -32000,
          `This light client needs its key: ${new URL(request.url).origin}/<key>`,
        ),
        401,
      );
    const { pathname } = new URL(unlocked.url);
    // The heartbeat is the cron's, which calls the object directly.
    if (pathname === '/heartbeat') return json({ error: 'Not found' }, 404);
    if (
      pathname === '/' &&
      request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
    )
      return front(request, env);
    return lightClient(env).fetch(unlocked);
  },
  // Every minute: a request renews the object's 30 s of CPU (Cloudflare documents that for
  // requests and WebSocket messages, not alarms), and wakes it if it was evicted or its alarm lost.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      lightClient(env).fetch('https://light-client/heartbeat', {
        method: 'POST',
      }),
    );
  },
};

const lightClient = (env) =>
  env.LIGHT_CLIENT.get(env.LIGHT_CLIENT.idFromName('finney'));

// What / answers without reaching the Durable Object: the page, a description of the endpoint,
// and for JSON-RPC over HTTP, where the WebSocket is. JSON-RPC is over WebSocket only, the
// cheapest way: Cloudflare counts 20 messages as one Durable Object request, and an HTTP call as
// a Worker request and a Durable Object request.
function front(request, env) {
  // Whoever got here came with the key, if there is one.
  const base = `${new URL(request.url).origin}${env.RPC_KEY ? `/${env.RPC_KEY}` : ''}`;
  const webSocket = `${base.replace(/^http/, 'ws')}/`;
  if (request.method === 'POST')
    return json(
      error(null, -32600, `JSON-RPC is over WebSocket only: ${webSocket}`),
      405,
      { allow: 'GET' },
    );
  if (request.headers.get('accept')?.includes('text/html'))
    return new Response(page, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  return json({
    name: 'Bittensor light client',
    chain: 'Bittensor (Finney)',
    jsonRpc: { webSocket },
    status: `${base}/status`,
  });
}

export class LightClient extends DurableObject {
  #running = null; // { client, chain, router, startedAt, startedFrom, memory }
  #starting = null;
  #lastSave = 0;
  #limit = new RateLimit(RATE);
  #sockets = new Map(); // caller -> WebSockets open
  #history = null; // kept across restarts of smoldot: the record is in SQLite
  #trace = null;
  #startToken = null; // the latest start's, so that an earlier start's samples stop

  async fetch(request) {
    const url = new URL(request.url);
    const running = await this.#ensureRunning();
    if (url.pathname === '/heartbeat') return new Response('ok');
    const caller = clientOf(request.headers.get('cf-connecting-ip'));
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket')
      return this.#webSocket(running, caller);
    const wait = this.#limit.take(caller);
    if (wait) return tooMany(wait);
    if (url.pathname === '/status') return json(await this.#status(running));
    return json({ error: 'Not found' }, 404);
  }

  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    this.#limit.forget();
    const running = await this.#ensureRunning();
    logMemory(running);
    if (Date.now() - running.startedAt < SETTLE_MS) return;
    if (Date.now() - this.#lastSave >= SAVE_EVERY_MS) await this.#save(running);
    try {
      await this.#history.fill(FILL_PER_ALARM);
    } catch (cause) {
      console.warn(`Filling the verified history stopped: ${cause?.message}`);
    }
  }

  #ensureRunning() {
    if (this.#running) return Promise.resolve(this.#running);
    this.#starting ??= this.#start().finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #start() {
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    const startedAt = Date.now();
    this.#trace ??= new MemoryTrace(this.ctx.storage.sql);
    const previousStart = this.#trace.begin(startedAt);
    if (previousStart) console.log(describePrevious(previousStart));
    const memory = captureMemory();
    const token = {};
    this.#startToken = token;
    let lastSample = 0;
    let platform = null;
    const sample = (source) => {
      const now = Date.now();
      const ms = now - startedAt;
      if (this.#startToken !== token || ms >= TRACE_FOR_MS) return false;
      const every = ms < FAST_FOR_MS ? SAMPLE_FAST_MS : SAMPLE_SLOW_MS;
      if (source !== 'log' && now - lastSample < every) return true;
      lastSample = now;
      const { received, open } = platform.stats();
      this.#trace.record(startedAt, {
        ms,
        bytes: memory.bytes() ?? 0,
        received,
        connections: open,
        source,
        note: lastLog,
      });
      return true;
    };
    platform = workersPlatform({ connect, onActivity: () => sample('io') });
    onLog = () => sample('log');
    const sampler = setInterval(() => {
      if (!sample('timer')) clearInterval(sampler);
    }, SAMPLE_FAST_MS);
    const client = start(
      { maxLogLevel: 3, logCallback: log, forbidWebRtc: true },
      { wasm: bytecode },
      platform,
    );
    const saved = await this.ctx.storage.get('database');
    const options = {
      chainSpec: JSON.stringify(chainSpec),
      jsonRpcMaxPendingRequests: 512,
      jsonRpcMaxSubscriptions: 4096,
    };
    let chain;
    let startedFrom = saved ? 'saved state' : 'checkpoint';
    try {
      chain = await client.addChain({
        ...options,
        databaseContent: saved ?? JSON.stringify(checkpoint),
      });
    } catch (cause) {
      if (!saved) throw cause;
      console.warn(
        `The saved state was refused (${cause?.message}); starting from the checkpoint`,
      );
      await this.ctx.storage.delete('database');
      chain = await client.addChain({
        ...options,
        databaseContent: JSON.stringify(checkpoint),
      });
      startedFrom = 'checkpoint';
    }
    this.#history ??= this.#newHistory();
    this.#history.restarted();
    const router = new Router(chain, { history: this.#history });
    const running = {
      client,
      chain,
      router,
      startedAt,
      startedFrom,
      memory,
      previousStart,
      sockets: new Set(),
    };
    this.#running = running;
    router.pump().catch((cause) => {
      console.error(`The light client stopped: ${cause?.message ?? cause}`);
      if (this.#running === running) this.#running = null;
      for (const socket of running.sockets)
        socket.close(1011, 'The light client is restarting');
      try {
        client.terminate();
      } catch {}
    });
    this.#follow(router);
    return running;
  }

  #newHistory() {
    const url = this.env.ARCHIVE_URL ?? ARCHIVE_URL;
    const days = Number(this.env.HISTORY_DAYS ?? HISTORY_DAYS);
    return new History({
      store: sqlStore(this.ctx.storage.sql),
      archive: url && url !== 'off' ? archiveNode(url) : null,
      historyBlocks:
        Math.round(
          (Number.isFinite(days) && days >= 0 ? days : HISTORY_DAYS) * 7200,
        ) || 0,
    });
  }

  // The light client's own subscriptions: every block smoldot imports (blocks it knows) and
  // every block it finalizes (recorded).
  #follow(router) {
    const listen = (method, onHeader) =>
      router.request(
        {
          subscriptions: new Set(),
          closed: false,
          send: (text) => {
            const header = JSON.parse(text).params?.result;
            try {
              if (header) onHeader(header);
            } catch (cause) {
              console.warn(
                `A header that couldn't be recorded: ${cause?.message}`,
              );
            }
          },
        },
        { id: 0, method, params: [] },
        { trusted: true },
      );
    listen('chain_subscribeAllHeads', (header) =>
      this.#history.imported(header),
    );
    listen('chain_subscribeFinalizedHeads', (header) =>
      this.#history.finalized(header),
    );
  }

  // Lets smoldot write a snapshot of what it has verified (the finalized block, its authorities
  // and the peers it knows) so a restart warp-syncs from there instead of from the checkpoint.
  async #save(running) {
    const answer = await running.router.request(
      null,
      {
        id: 0,
        method: 'chainHead_unstable_finalizedDatabase',
        params: [1_000_000],
      },
      { trusted: true },
    );
    if (typeof answer.result !== 'string') return;
    await this.ctx.storage.put('database', answer.result);
    this.#lastSave = Date.now();
  }

  #webSocket(running, caller) {
    const wait = this.#limit.take(caller);
    if (wait) return tooMany(wait);
    const open = this.#sockets.get(caller) ?? 0;
    if (open >= MAX_SOCKETS_PER_CALLER)
      return json(
        error(
          null,
          -32005,
          `At most ${MAX_SOCKETS_PER_CALLER} WebSockets at once from one address`,
        ),
        429,
      );
    this.#sockets.set(caller, open + 1);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const connection = {
      send: (text) => server.send(text),
      subscriptions: new Set(),
      closed: false,
    };
    running.sockets.add(server);
    const reply = (body) => {
      try {
        if (!connection.closed) server.send(JSON.stringify(body));
      } catch {} // closing; close() follows from its close event
    };
    server.addEventListener('message', async (event) => {
      const message = parse(
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data),
      );
      const wait = this.#limit.take(caller, callsIn(message));
      if (wait)
        return reply(
          slowDown(Array.isArray(message) ? null : (message?.id ?? null), wait),
        );
      if (message === undefined)
        return reply(error(null, -32700, 'Parse error'));
      // What /status reports, for a page that keeps to its WebSocket.
      if (message?.method === 'lightclient_status')
        return reply({
          jsonrpc: '2.0',
          id: message.id ?? null,
          result: await this.#status(running),
        });
      if (!Array.isArray(message))
        return reply(await running.router.request(connection, message));
      if (message.length === 0 || message.length > MAX_BATCH)
        return reply(
          error(null, -32600, `A batch holds 1 to ${MAX_BATCH} requests`),
        );
      reply(
        await Promise.all(
          message.map((each) => running.router.request(connection, each)),
        ),
      );
    });
    const close = () => {
      if (connection.closed) return; // a socket can report both close and error
      running.sockets.delete(server);
      running.router.close(connection);
      const left = this.#sockets.get(caller) - 1;
      if (left > 0) this.#sockets.set(caller, left);
      else this.#sockets.delete(caller);
    };
    server.addEventListener('close', close);
    server.addEventListener('error', close);
    return new Response(null, { status: 101, webSocket: client });
  }

  async #status(running) {
    const call = async (method, params = []) =>
      (await running.router.request(null, { id: 0, method, params })).result;
    const [health, finalizedHash, best] = await Promise.all([
      call('system_health'),
      call('chain_getFinalizedHead'),
      call('chain_getHeader'),
    ]);
    const finalized = finalizedHash
      ? await call('chain_getHeader', [finalizedHash])
      : null;
    return {
      chain: 'Bittensor (Finney)',
      genesisHash:
        '0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03',
      syncing: health?.isSyncing ?? null,
      peers: health?.peers ?? null,
      finalized: finalized
        ? { number: parseInt(finalized.number, 16), hash: finalizedHash }
        : null,
      best: best
        ? { number: parseInt(best.number, 16), parentHash: best.parentHash }
        : null,
      startedFrom: running.startedFrom,
      uptimeSeconds: Math.round((Date.now() - running.startedAt) / 1000),
      wasmMemoryBytes: running.memory.bytes(),
      previousStart: running.previousStart,
      lastSaved: this.#lastSave ? new Date(this.#lastSave).toISOString() : null,
      history: this.#history.status(),
      cache: running.router.cacheStats(),
    };
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...headers },
  });
// A caller over the rate limit: the JSON-RPC error, and the HTTP answer that carries it.
const slowDown = (id, seconds) =>
  error(id, -32005, `Too many requests: try again in ${seconds} s`);
const tooMany = (seconds) =>
  json(slowDown(null, seconds), 429, { 'retry-after': String(seconds) });
// How many calls a message counts as: each one in a batch, up to the largest batch taken.
const callsIn = (message) =>
  Array.isArray(message) ? Math.min(Math.max(message.length, 1), MAX_BATCH) : 1;
// A message as JSON, or undefined when it isn't.
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// smoldot warns on every call of the legacy API, which most Bittensor tools use, and on each
// malformed message from a peer.
const QUIET = /legacy JSON-RPC API|protocolId|protocol-error/;
// The last line smoldot logged, and what records a memory sample then (src/memory.js).
let lastLog = '';
let onLog = null;
function log(level, target, message) {
  if (QUIET.test(message)) return;
  const line = `[${target}] ${message}`;
  lastLog = line.slice(0, 80);
  onLog?.();
  if (level <= 1) console.error(line);
  else if (level === 2) console.warn(line);
  else console.log(line);
}

// smoldot instantiates its Wasm itself; keeping hold of the instance's memory lets /status report
// how much of the object's 128 MB it uses.
function captureMemory() {
  const instantiate = WebAssembly.instantiate;
  let memory = null;
  WebAssembly.instantiate = async (...args) => {
    WebAssembly.instantiate = instantiate;
    const instance = await instantiate(...args);
    memory = instance.exports?.memory ?? null;
    return instance;
  };
  return { bytes: () => memory?.buffer.byteLength ?? null };
}

// Wasm memory only grows, and Cloudflare resets the object past 128 MB. Each new high is logged,
// once, so the logs show how close smoldot comes.
function logMemory(running) {
  const bytes = running.memory.bytes();
  if (!bytes || bytes <= (running.loggedMemory ?? 0)) return;
  running.loggedMemory = bytes;
  console.log(`[light-client] Wasm memory: ${mib(bytes)} MiB`);
}
const mib = (bytes) => (bytes / 1048576).toFixed(1);
// The previous start's peak and last samples, as one log line.
function describePrevious({ bytes, atMs, lastMs, samples }) {
  const seconds = (ms) => (ms / 1000).toFixed(2);
  const each = samples.map(
    (s) =>
      `${seconds(s.ms)} s: ${mib(s.bytes)} MiB, ${s.source}, ${(s.received / 1e6).toFixed(2)} MB received, ${s.connections} connections${s.note ? `, after ${s.note}` : ''}`,
  );
  return `[light-client] The previous start reached ${mib(bytes)} MiB of Wasm memory at ${seconds(atMs)} s; its last sample was at ${seconds(lastMs)} s. Its last samples: ${each.join(' | ')}`;
}
