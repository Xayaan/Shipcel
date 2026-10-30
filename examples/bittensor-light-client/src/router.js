// Shares one smoldot chain between many JSON-RPC clients. smoldot answers on a single queue, so
// every request goes in under an ID of the router's own, its answer goes back to the client that
// asked under the client's ID, and a subscription's notifications go to the client that opened it.

// Methods that open a subscription, and the method that closes each one.
export const SUBSCRIBE = {
  chain_subscribeAllHeads: 'chain_unsubscribeAllHeads',
  chain_subscribeFinalizedHeads: 'chain_unsubscribeFinalizedHeads',
  chain_subscribeNewHeads: 'chain_unsubscribeNewHeads',
  state_subscribeRuntimeVersion: 'state_unsubscribeRuntimeVersion',
  state_subscribeStorage: 'state_unsubscribeStorage',
  author_submitAndWatchExtrinsic: 'author_unwatchExtrinsic',
  chainHead_v1_follow: 'chainHead_v1_unfollow',
  transactionWatch_v1_submitAndWatch: 'transactionWatch_v1_unwatch',
  sudo_network_unstable_watch: 'sudo_network_unstable_unwatch',
  statement_subscribeStatement: 'statement_unsubscribeStatement',
};
const UNSUBSCRIBE = new Set(Object.values(SUBSCRIBE));

// Methods for the operator only: they change whom the light client connects to (any address a
// caller names) or read its saved state.
const PRIVATE =
  /^(sudo_|system_(add|remove)ReservedPeer$|chainHead_unstable_finalizedDatabase$)/;

// Notifications after which smoldot has ended the subscription itself.
const ENDS_SUBSCRIPTION = {
  chainHead_v1_followEvent: (result) => result?.event === 'stop',
  transactionWatch_v1_watchEvent: (result) =>
    ['finalized', 'error', 'invalid', 'dropped'].includes(result?.event),
};

// Calls that run the Finney runtime on a proof of its storage fetched from a peer. Peers turn
// some proof requests away under load, so only a few run at a time.
const RUNTIME_CALLS = new Set([
  'state_call',
  'state_getMetadata',
  'payment_queryInfo',
  'payment_queryFeeDetails',
  'system_accountNextIndex',
  'system_dryRun',
]);
const MAX_WAITING = 256;

// smoldot's answers when no peer provided what a call needed; it documents that trying the same
// call again might succeed.
const RETRYABLE =
  /^(Error trying to access the storage required for the runtime call|Failed to retrieve block information from the network)$/;
const ATTEMPTS = 3;

// Metadata is compiled into the runtime and every client asks for it when it connects: one answer
// per runtime version is kept, and concurrent asks share it.
const METADATA_CALLS = new Set([
  'Metadata_metadata',
  'Metadata_metadata_at_version',
  'Metadata_metadata_versions',
]);
const METADATA_KEPT = 4;
function metadataRequest(method, params) {
  if (!Array.isArray(params)) return null;
  if (method === 'state_getMetadata')
    return { at: params[0] ?? null, key: method };
  if (method === 'state_call' && METADATA_CALLS.has(params[0]))
    return { at: params[2] ?? null, key: `${params[0]}(${params[1] ?? '0x'})` };
  return null;
}

// Calls about one block, and where among their parameters the block's hash goes. What a block
// hash pins down never changes, so these calls are pinned to the best block when they name none,
// answered once while they run, and kept.
export const AT = new Map([
  ['chain_getHeader', 0],
  ['chain_getBlock', 0],
  ['state_getMetadata', 0],
  ['state_getRuntimeVersion', 0],
  ['chain_getRuntimeVersion', 0],
  ['state_getStorage', 1],
  ['state_getStorageAt', 1],
  ['state_getStorageHash', 1],
  ['state_getStorageHashAt', 1],
  ['state_getStorageSize', 1],
  ['state_getStorageSizeAt', 1],
  ['state_queryStorageAt', 1],
  ['state_getReadProof', 1],
  ['payment_queryInfo', 1],
  ['payment_queryFeeDetails', 1],
  ['state_call', 2],
  ['state_callAt', 2],
  ['state_getKeysPaged', 3],
  ['state_getKeysPagedAt', 3],
]);
const CACHE_CHARS = 4_000_000; // answers kept, counted in characters of their JSON
const CACHE_ENTRY_CHARS = 512_000;

export const error = (id, code, message) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Router {
  #chain;
  #nextId = 0;
  #pending = new Map(); // router ID -> { client, id, method, params, resolve, timer }
  #subscriptions = new Map(); // subscription ID -> { client, unsubscribe }
  #timeoutMs;
  #maxSubscriptions;
  #maxRuntimeCalls;
  #runtimeCalls = 0;
  #waiting = [];
  #metadata = new Map(); // runtime version and call -> Promise of the answer
  #history;
  #kept = new Map(); // call pinned to a block -> { answer, size }, the least recently used first
  #keptChars = 0;
  #cacheChars;
  #cacheEntryChars;
  #running = new Map(); // call pinned to a block -> Promise of the answer
  #hits = 0;
  #misses = 0;

  // `history`: old blocks, from src/history.js. Without it every call goes to smoldot.
  constructor(
    chain,
    {
      timeoutMs = 30_000,
      maxSubscriptionsPerClient = 64,
      maxRuntimeCalls = 4,
      history = null,
      cacheChars = CACHE_CHARS,
      cacheEntryChars = CACHE_ENTRY_CHARS,
    } = {},
  ) {
    this.#chain = chain;
    this.#timeoutMs = timeoutMs;
    this.#maxSubscriptions = maxSubscriptionsPerClient;
    this.#maxRuntimeCalls = maxRuntimeCalls;
    this.#history = history;
    this.#cacheChars = cacheChars;
    this.#cacheEntryChars = cacheEntryChars;
  }

  cacheStats() {
    return {
      entries: this.#kept.size,
      chars: this.#keptChars,
      hits: this.#hits,
      misses: this.#misses,
    };
  }

  // A client is { send(text), subscriptions: Set } for a WebSocket, or null for a single HTTP
  // request. Resolves with the response object; a WebSocket's notifications go to its send().
  // Only the Worker's own calls are trusted with the operator's methods.
  request(client, message, { trusted = false } = {}) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      typeof message.method !== 'string'
    )
      return Promise.resolve(
        error(message?.id ?? null, -32600, 'Invalid request'),
      );
    const { id = null, method, params = [] } = message;
    if (!trusted && PRIVATE.test(method))
      return Promise.resolve(error(id, -32601, `${method} is not available`));
    if (SUBSCRIBE[method]) {
      if (!client)
        return Promise.resolve(
          error(id, -32000, `${method} needs a WebSocket connection`),
        );
      if (client.subscriptions.size >= this.#maxSubscriptions)
        return Promise.resolve(
          error(
            id,
            -32000,
            `At most ${this.#maxSubscriptions} subscriptions per connection`,
          ),
        );
    }
    if (UNSUBSCRIBE.has(method)) {
      const owner = this.#subscriptions.get(
        Array.isArray(params) ? params[0] : undefined,
      );
      if (!client || owner?.client !== client)
        return Promise.resolve({ jsonrpc: '2.0', id, result: false });
    }
    if (method === 'chain_getBlockHash' && this.#history)
      return this.#blockHash(client, id, params);
    if (AT.has(method) && Array.isArray(params))
      return this.#read(id, method, params);
    return this.#direct(client, id, method, params);
  }

  #direct(client, id, method, params) {
    const metadata = metadataRequest(method, params);
    if (metadata) return this.#cachedMetadata(id, method, params, metadata);
    if (RUNTIME_CALLS.has(method))
      return this.#runtimeCall(client, id, method, params);
    return this.#retrying(client, id, method, params);
  }

  // A call about one block, pinned to the best block when it names none. Old blocks go to the
  // archive node; a block smoldot just named as its best stays with smoldot.
  async #read(id, method, params) {
    const index = AT.get(method);
    const latest = params[index] == null;
    const pinned = latest ? await this.#pin(params, index) : params;
    if (!pinned) return this.#direct(null, id, method, params);
    const archive =
      !latest && this.#history?.route(method, pinned) === 'archive';
    // Metadata from smoldot has its own cache, one answer per runtime version.
    const keep = archive || !metadataRequest(method, pinned);
    const answer = await this.#shared(
      `${method}${JSON.stringify(pinned)}`,
      keep,
      () => this.#fetch(method, pinned, archive),
    );
    return { ...answer, id };
  }

  async #pin(params, index) {
    const best = (await this.#send(null, 0, 'chain_getBlockHash', [])).result;
    if (typeof best !== 'string') return null;
    const pinned = [...params];
    while (pinned.length < index) pinned.push(null);
    pinned[index] = best;
    return pinned;
  }

  // From the archive node when the block is old, else from smoldot. When smoldot fails a call a
  // proof can answer, the archive node's checked answer stands in.
  async #fetch(method, params, archive) {
    if (archive) {
      const answer = await this.#history.answer(method, params);
      if (answer) return { jsonrpc: '2.0', id: 0, ...answer };
    }
    const answer = await this.#direct(null, 0, method, params);
    if (answer.error && !archive && this.#history?.proves(method)) {
      const checked = await this.#history.answer(method, params);
      if (checked && !checked.error)
        return { jsonrpc: '2.0', id: 0, ...checked };
    }
    return answer;
  }

  // The same call shares one answer while it runs; a good answer is kept, and past the cache's
  // size the least recently used goes first.
  async #shared(key, keep, produce) {
    const kept = this.#kept.get(key);
    if (kept) {
      this.#kept.delete(key);
      this.#kept.set(key, kept);
      this.#hits++;
      return kept.answer;
    }
    let running = this.#running.get(key);
    if (running) this.#hits++;
    else {
      this.#misses++;
      running = produce().finally(() => this.#running.delete(key));
      this.#running.set(key, running);
    }
    const answer = await running;
    if (keep && !answer.error && !this.#kept.has(key)) this.#keep(key, answer);
    return answer;
  }

  #keep(key, answer) {
    const size = JSON.stringify(answer.result ?? null).length;
    if (size > this.#cacheEntryChars) return;
    this.#kept.set(key, { answer, size });
    this.#keptChars += size;
    for (const [oldest, { size: freed }] of this.#kept) {
      if (this.#keptChars <= this.#cacheChars) break;
      this.#kept.delete(oldest);
      this.#keptChars -= freed;
    }
  }

  // A block number's hash: smoldot knows only its best block's, the record knows the rest.
  async #blockHash(client, id, params) {
    const raw = Array.isArray(params) ? params[0] : undefined;
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^0x[0-9a-fA-F]{1,13}$/.test(raw)
          ? parseInt(raw, 16)
          : undefined;
    const answer = n === undefined ? null : await this.#history.blockHash(n);
    return answer
      ? { jsonrpc: '2.0', id, ...answer }
      : this.#direct(client, id, 'chain_getBlockHash', params);
  }

  async #cachedMetadata(id, method, params, { at, key }) {
    const block =
      at ?? (await this.#send(null, 0, 'chain_getBlockHash', [])).result;
    const version =
      block &&
      (await this.#send(null, 0, 'state_getRuntimeVersion', [block])).result;
    if (!version) return this.#runtimeCall(null, id, method, params);
    const cacheKey = `${version.specName}/${version.specVersion}/${version.implVersion}/${key}`;
    let answer = this.#metadata.get(cacheKey);
    if (!answer) {
      const pinned =
        method === 'state_getMetadata'
          ? [block]
          : [params[0], params[1] ?? '0x', block];
      answer = this.#runtimeCall(null, 0, method, pinned).then((reply) => {
        if (reply.error) this.#metadata.delete(cacheKey);
        return reply;
      });
      this.#metadata.set(cacheKey, answer);
      if (this.#metadata.size > METADATA_KEPT)
        this.#metadata.delete(this.#metadata.keys().next().value);
    }
    const reply = await answer;
    return reply.error
      ? { ...reply, id }
      : { jsonrpc: '2.0', id, result: reply.result };
  }

  async #runtimeCall(client, id, method, params) {
    if (this.#runtimeCalls < this.#maxRuntimeCalls) this.#runtimeCalls++;
    else if (this.#waiting.length >= MAX_WAITING)
      return error(id, -32000, 'The light client is busy: retry shortly');
    else await new Promise((resolve) => this.#waiting.push(resolve)); // a finished call hands over its slot
    try {
      return await this.#retrying(client, id, method, params);
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#runtimeCalls--;
    }
  }

  async #retrying(client, id, method, params) {
    for (let attempt = 1; ; attempt++) {
      const answer = await this.#send(client, id, method, params);
      if (
        !answer.error ||
        attempt === ATTEMPTS ||
        !RETRYABLE.test(answer.error.message)
      )
        return answer;
      await sleep(300 * attempt);
    }
  }

  #send(client, id, method, params) {
    return new Promise((resolve) => {
      const routerId = `r${++this.#nextId}`;
      const timer = setTimeout(() => {
        this.#pending.delete(routerId);
        resolve(error(id, -32000, 'The light client did not answer in time'));
      }, this.#timeoutMs);
      this.#pending.set(routerId, {
        client,
        id,
        method,
        params,
        resolve,
        timer,
      });
      try {
        this.#chain.sendJsonRpc(
          JSON.stringify({ jsonrpc: '2.0', id: routerId, method, params }),
        );
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(routerId);
        const busy = cause?.name === 'QueueFullError';
        resolve(
          error(
            id,
            -32000,
            busy
              ? 'The light client is busy: retry shortly'
              : 'The light client is restarting',
          ),
        );
      }
    });
  }

  // Closes everything a disconnected WebSocket client still had open. A subscription it asked
  // for that smoldot hasn't confirmed yet is closed when the confirmation arrives.
  close(client) {
    client.closed = true;
    for (const subscription of client.subscriptions) {
      const owned = this.#subscriptions.get(subscription);
      this.#subscriptions.delete(subscription);
      if (owned) this.#unsubscribe(owned.unsubscribe, subscription);
    }
    client.subscriptions.clear();
  }

  #unsubscribe(method, subscription) {
    try {
      this.#chain.sendJsonRpc(
        JSON.stringify({
          jsonrpc: '2.0',
          id: `closed${++this.#nextId}`,
          method,
          params: [subscription],
        }),
      );
    } catch {}
  }

  // Reads smoldot's answers until the chain goes away, then fails whatever is still waiting.
  async pump() {
    try {
      for (;;)
        this.#deliver(JSON.parse(await this.#chain.nextJsonRpcResponse()));
    } catch (cause) {
      for (const [routerId, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve(
          error(pending.id, -32000, 'The light client is restarting'),
        );
        this.#pending.delete(routerId);
      }
      throw cause;
    }
  }

  #deliver(message) {
    if (message.id !== undefined && message.id !== null) {
      const pending = this.#pending.get(message.id);
      if (!pending) return; // timed out, or an unsubscribe for a closed connection
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      const { client, method } = pending;
      if (SUBSCRIBE[method] && message.result !== undefined && client) {
        if (client.closed) {
          this.#unsubscribe(SUBSCRIBE[method], message.result);
        } else {
          this.#subscriptions.set(message.result, {
            client,
            unsubscribe: SUBSCRIBE[method],
          });
          client.subscriptions.add(message.result);
        }
      }
      if (UNSUBSCRIBE.has(method) && client) {
        const subscription = pending.params[0];
        this.#subscriptions.delete(subscription);
        client.subscriptions.delete(subscription);
      }
      pending.resolve({ ...message, id: pending.id });
      return;
    }
    const subscription = message.params?.subscription;
    const owner = this.#subscriptions.get(subscription);
    if (!owner) return;
    if (ENDS_SUBSCRIPTION[message.method]?.(message.params.result)) {
      this.#subscriptions.delete(subscription);
      owner.client.subscriptions.delete(subscription);
    }
    try {
      owner.client.send(JSON.stringify(message));
    } catch {} // the socket closed; close() follows from its close event
  }
}
