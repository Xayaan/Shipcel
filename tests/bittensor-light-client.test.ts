import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain JavaScript, like the rest of the example
import { Router } from '../examples/bittensor-light-client/src/router.js';
// @ts-expect-error -- plain JavaScript, like the rest of the example
import { workersPlatform } from '../examples/bittensor-light-client/src/platform.js';
// @ts-expect-error -- plain JavaScript, like the rest of the example
import * as access from '../examples/bittensor-light-client/src/access.js';
// @ts-expect-error -- plain JavaScript, like the rest of the example
import { blake2b256 } from '../examples/bittensor-light-client/src/blake2b.js';
// @ts-expect-error -- plain JavaScript, like the rest of the example
import * as proofs from '../examples/bittensor-light-client/src/proof.js';
// @ts-expect-error -- plain JavaScript, like the rest of the example
import * as history from '../examples/bittensor-light-client/src/history.js';
// @ts-expect-error -- plain JavaScript, like the rest of the example
import { MemoryTrace } from '../examples/bittensor-light-client/src/memory.js';
import { DatabaseSync } from 'node:sqlite';
// Read from Opentensor's archive node on 22 October 2026: block #9,000,000's header, its
// neighbours' and storage proofs for five keys, with the values the node gave for them.
import finney from './fixtures/finney-9000000.json';
// Blocks #9,000,000 (25 extrinsics) and #9,339,090 (139) from the same node, header and body.
import finneyBlocks from './fixtures/finney-blocks.json';

type Message = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: any;
  result?: unknown;
  error?: unknown;
};

// A stand-in for smoldot's chain: `answer` replies to what the router sends (or holds a request
// back by returning undefined); `push` queues anything else, such as a notification.
function fakeChain(answer: (request: Message) => Message | undefined) {
  const queue: string[] = [];
  const sent: Message[] = [];
  let wake: (() => void) | null = null;
  let full = false;
  let gone = false;
  const push = (message: Message) => {
    queue.push(JSON.stringify(message));
    wake?.();
  };
  return {
    sent,
    push,
    reply: (request: Message, body: Omit<Message, 'id'>) =>
      push({ jsonrpc: '2.0', id: request.id, ...body } as Message),
    fill: () => (full = true),
    stop: () => {
      gone = true;
      wake?.();
    },
    chain: {
      sendJsonRpc(text: string) {
        if (full)
          throw Object.assign(new Error('full'), { name: 'QueueFullError' });
        const request = JSON.parse(text);
        sent.push(request);
        const reply = answer(request);
        if (reply)
          queueMicrotask(() =>
            push({ jsonrpc: '2.0', id: request.id, ...reply }),
          );
      },
      async nextJsonRpcResponse() {
        while (!queue.length) {
          if (gone) throw new Error('The chain was removed');
          await new Promise<void>((resolve) => (wake = resolve));
        }
        return queue.shift()!;
      },
    },
  };
}

const socket = () => ({
  sent: [] as Message[],
  subscriptions: new Set<string>(),
  closed: false,
  send(text: string) {
    this.sent.push(JSON.parse(text));
  },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function started(
  answer: (request: Message) => Message | undefined,
  options = {},
) {
  const fake = fakeChain(answer);
  const router = new Router(fake.chain, options);
  const pumping = router.pump();
  pumping.catch(() => {});
  return { ...fake, router, pumping };
}

describe('the light client router', () => {
  afterEach(() => vi.useRealTimers());

  it('answers each client under its own ID, even when two use the same one', async () => {
    const { router, sent } = started((request) => ({
      result: `answer to ${request.params[0]}`,
    }));
    const [a, b] = await Promise.all([
      router.request(null, {
        jsonrpc: '2.0',
        id: 1,
        method: 'chain_getHeader',
        params: ['a'],
      }),
      router.request(null, {
        jsonrpc: '2.0',
        id: 1,
        method: 'chain_getHeader',
        params: ['b'],
      }),
    ]);
    expect(a).toEqual({ jsonrpc: '2.0', id: 1, result: 'answer to a' });
    expect(b).toEqual({ jsonrpc: '2.0', id: 1, result: 'answer to b' });
    expect(new Set(sent.map((request) => request.id)).size).toBe(2);
  });

  it('sends notifications only to the connection that subscribed', async () => {
    let next = 0;
    const { router, push } = started(() => ({ result: `sub-${'ab'[next++]}` }));
    const a = socket();
    const b = socket();
    const reply = await router.request(a, {
      id: 'x',
      method: 'chain_subscribeNewHeads',
      params: [],
    });
    expect(reply).toEqual({ jsonrpc: '2.0', id: 'x', result: 'sub-a' });
    await router.request(b, {
      id: 'y',
      method: 'chain_subscribeNewHeads',
      params: [],
    });
    push({
      method: 'chain_newHead',
      params: { subscription: 'sub-a', result: { number: '0x1' } },
    });
    await settle();
    expect(a.sent).toEqual([
      {
        method: 'chain_newHead',
        params: { subscription: 'sub-a', result: { number: '0x1' } },
      },
    ]);
    expect(b.sent).toEqual([]);
  });

  it("doesn't let one connection close another's subscription", async () => {
    const { router, sent } = started(() => ({ result: 'sub-a' }));
    const a = socket();
    const b = socket();
    await router.request(a, {
      id: 1,
      method: 'chainHead_v1_follow',
      params: [false],
    });
    const stolen = await router.request(b, {
      id: 2,
      method: 'chainHead_v1_unfollow',
      params: ['sub-a'],
    });
    expect(stolen).toEqual({ jsonrpc: '2.0', id: 2, result: false });
    expect(sent.map((request) => request.method)).toEqual([
      'chainHead_v1_follow',
    ]);
  });

  it("closes a disconnected connection's subscriptions, including one confirmed after it left", async () => {
    const held: Message[] = [];
    const { router, sent, reply, push } = started((request) => {
      if (request.method === 'state_subscribeStorage') {
        held.push(request);
        return undefined;
      }
      return {
        result:
          request.method === 'chain_subscribeFinalizedHeads' ? 'sub-1' : true,
      };
    });
    const a = socket();
    await router.request(a, {
      id: 1,
      method: 'chain_subscribeFinalizedHeads',
      params: [],
    });
    const late = router.request(a, {
      id: 2,
      method: 'state_subscribeStorage',
      params: [['0x00']],
    });
    await settle();
    router.close(a);
    reply(held[0], { result: 'sub-2' });
    await late;
    await settle();
    expect(
      sent
        .filter((request) => request.method?.includes('unsubscribe'))
        .map((request) => [request.method, request.params]),
    ).toEqual([
      ['chain_unsubscribeFinalizedHeads', ['sub-1']],
      ['state_unsubscribeStorage', ['sub-2']],
    ]);
    push({
      method: 'chain_finalizedHead',
      params: { subscription: 'sub-1', result: {} },
    });
    await settle();
    expect(a.sent).toEqual([]);
  });

  it('keeps subscriptions for WebSocket connections and the operator methods for itself', async () => {
    const { router, sent } = started(() => ({ result: 'db' }));
    expect(
      await router.request(null, {
        id: 1,
        method: 'chain_subscribeNewHeads',
        params: [],
      }),
    ).toMatchObject({
      error: {
        message: 'chain_subscribeNewHeads needs a WebSocket connection',
      },
    });
    for (const method of [
      'sudo_unstable_p2pDiscover',
      'system_addReservedPeer',
      'chainHead_unstable_finalizedDatabase',
    ])
      expect(
        await router.request(socket(), { id: 2, method, params: [] }),
      ).toMatchObject({
        id: 2,
        error: { code: -32601 },
      });
    expect(sent).toEqual([]);
    expect(
      await router.request(
        null,
        { id: 3, method: 'chainHead_unstable_finalizedDatabase', params: [] },
        { trusted: true },
      ),
    ).toEqual({ jsonrpc: '2.0', id: 3, result: 'db' });
    expect(await router.request(null, { id: 4 })).toMatchObject({
      error: { code: -32600 },
    });
    expect(await router.request(null, [1])).toMatchObject({
      error: { code: -32600 },
    });
  });

  it('retries a call no peer could serve, up to three attempts, and nothing else', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { router, sent } = started((request) => {
      if (request.method === 'chain_getBlockHash')
        return { result: `0x${'b0'.repeat(32)}` };
      if (request.method === 'state_getStorage')
        return { error: { code: -32000, message: 'Invalid block' } };
      attempts++;
      return attempts < 3
        ? {
            error: {
              code: -32000,
              message:
                'Error trying to access the storage required for the runtime call',
            },
          }
        : { result: '0x01' };
    });
    const call = router.request(null, {
      id: 9,
      method: 'state_call',
      params: ['A_b', '0x'],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await call).toEqual({ jsonrpc: '2.0', id: 9, result: '0x01' });
    const storage = await router.request(null, {
      id: 10,
      method: 'state_getStorage',
      params: ['0x'],
    });
    expect(storage).toMatchObject({ error: { message: 'Invalid block' } });
    // Each names no block, so each is first pinned to the best one.
    expect(sent.map((request) => request.method)).toEqual([
      'chain_getBlockHash',
      'state_call',
      'state_call',
      'state_call',
      'chain_getBlockHash',
      'state_getStorage',
    ]);
  });

  it('runs at most four runtime calls at once and starts the next as one finishes', async () => {
    const held: Message[] = [];
    const { router, sent, reply } = started((request) => {
      if (request.method === 'state_call') {
        held.push(request);
        return undefined;
      }
      return { result: 'header' };
    });
    const calls = Array.from({ length: 6 }, (_, i) =>
      router.request(null, {
        id: i,
        method: 'state_call',
        params: ['A_b', `0x0${i}`],
      }),
    );
    await settle();
    expect(held).toHaveLength(4);
    expect(
      await router.request(null, {
        id: 'h',
        method: 'chain_getHeader',
        params: [],
      }),
    ).toMatchObject({
      result: 'header',
    });
    reply(held[0], { result: '0x' });
    await calls[0];
    await settle();
    expect(held).toHaveLength(5);
    expect(
      sent.filter((request) => request.method === 'state_call'),
    ).toHaveLength(5);
  });

  it('asks smoldot for metadata once per runtime version and shares the answer', async () => {
    let specVersion = 481;
    let failNext = false;
    const { router, sent } = started((request) => {
      if (request.method === 'chain_getBlockHash') return { result: '0xbest' };
      if (request.method === 'state_getRuntimeVersion')
        return {
          result: { specName: 'node-subtensor', specVersion, implVersion: 1 },
        };
      if (failNext) {
        failNext = false;
        return { error: { code: -32000, message: 'Execution failed' } };
      }
      return { result: `0xmeta${specVersion}` };
    });
    const metadataCalls = () =>
      sent.filter(
        (request) =>
          request.method === 'state_getMetadata' ||
          request.params?.[0]?.startsWith?.('Metadata'),
      );
    const ask = (id: number) =>
      router.request(null, { id, method: 'state_getMetadata', params: [] });
    expect(await Promise.all([ask(1), ask(2)])).toEqual([
      { jsonrpc: '2.0', id: 1, result: '0xmeta481' },
      { jsonrpc: '2.0', id: 2, result: '0xmeta481' },
    ]);
    expect(await ask(3)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: '0xmeta481',
    });
    expect(metadataCalls()).toEqual([
      expect.objectContaining({
        method: 'state_getMetadata',
        params: ['0xbest'],
      }),
    ]);
    const v15 = await router.request(null, {
      id: 4,
      method: 'state_call',
      params: ['Metadata_metadata_at_version', '0x0f000000'],
    });
    expect(v15).toEqual({ jsonrpc: '2.0', id: 4, result: '0xmeta481' });
    expect(metadataCalls()).toHaveLength(2);
    specVersion = 482;
    failNext = true;
    expect(await ask(5)).toMatchObject({
      id: 5,
      error: { message: 'Execution failed' },
    });
    expect(await ask(6)).toEqual({
      jsonrpc: '2.0',
      id: 6,
      result: '0xmeta482',
    });
    expect(metadataCalls()).toHaveLength(4);
  });

  it('answers with an error when smoldot is too slow, busy or gone', async () => {
    const { router, fill, stop, pumping } = started(() => undefined, {
      timeoutMs: 20,
    });
    expect(
      await router.request(null, {
        id: 1,
        method: 'system_health',
        params: [],
      }),
    ).toMatchObject({
      id: 1,
      error: { message: 'The light client did not answer in time' },
    });
    const waiting = router.request(null, {
      id: 2,
      method: 'system_health',
      params: [],
    });
    stop();
    await expect(pumping).rejects.toThrow('The chain was removed');
    expect(await waiting).toMatchObject({
      id: 2,
      error: { message: 'The light client is restarting' },
    });
    fill();
    expect(
      await router.request(null, {
        id: 3,
        method: 'system_health',
        params: [],
      }),
    ).toMatchObject({
      id: 3,
      error: { message: 'The light client is busy: retry shortly' },
    });
  });
});

// A connection's callbacks as smoldot gives them, recording each call.
function smoldotSide(address: object) {
  const calls: unknown[][] = [];
  return {
    calls,
    config: {
      address,
      onWritableBytes: (bytes: number) => calls.push(['writable', bytes]),
      onMessage: (data: Uint8Array) => calls.push(['message', [...data]]),
      onConnectionReset: (message: string) => calls.push(['reset', message]),
    },
  };
}

// A cloudflare:sockets Socket whose received bytes the test controls.
function fakeTcpSocket() {
  let receive!: ReadableStreamDefaultController<Uint8Array>;
  const written: number[][] = [];
  let closed = false;
  return {
    written,
    receive: (bytes: number[]) => receive.enqueue(new Uint8Array(bytes)),
    end: () => receive.close(),
    get closed() {
      return closed;
    },
    socket: {
      opened: Promise.resolve({}),
      closed: new Promise(() => {}),
      readable: new ReadableStream<Uint8Array>({
        start: (controller) => (receive = controller),
      }),
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => void written.push([...chunk]),
      }),
      close: async () => {
        closed = true;
      },
    },
  };
}

describe('the light client platform', () => {
  it('counts bytes received and connections open, closed from either side once', async () => {
    let activity = 0;
    const sockets = [fakeTcpSocket(), fakeTcpSocket()];
    let next = 0;
    const platform = workersPlatform({
      connect: () => sockets[next++].socket,
      onActivity: () => activity++,
    });
    const first = smoldotSide({ ty: 'tcp', hostname: '10.0.0.1', port: 30333 });
    const second = smoldotSide({
      ty: 'tcp',
      hostname: '10.0.0.2',
      port: 30333,
    });
    const firstConnection = platform.connect(first.config);
    platform.connect(second.config);
    expect(platform.stats()).toEqual({ received: 0, open: 2 });
    await settle();
    sockets[0].receive([1, 2, 3]);
    sockets[1].receive([4]);
    await settle();
    expect(platform.stats()).toEqual({ received: 4, open: 2 });
    expect(activity).toBe(2);
    // smoldot closes the first, the peer the second; closing again counts nothing.
    firstConnection.reset();
    firstConnection.reset();
    sockets[1].end();
    await settle();
    expect(platform.stats()).toEqual({ received: 4, open: 0 });
    expect(second.calls.filter(([type]) => type === 'reset')).toHaveLength(1);
  });

  it('reaches smoldot only from a later task, even when connecting fails at once', async () => {
    const platform = workersPlatform({
      connect: () => {
        throw new Error('blocked address');
      },
    });
    const side = smoldotSide({ ty: 'tcp', hostname: '10.0.0.1', port: 30333 });
    const connection = platform.connect(side.config);
    expect(side.calls).toEqual([]);
    await settle();
    expect(side.calls).toEqual([['reset', 'blocked address']]);
    expect(() => connection.reset()).not.toThrow();
  });

  it('carries TCP bytes both ways, reports written bytes and ends with the socket', async () => {
    const tcp = fakeTcpSocket();
    let asked: unknown;
    const platform = workersPlatform({
      connect: (address: unknown, options: unknown) => {
        asked = [address, options];
        return tcp.socket;
      },
    });
    const side = smoldotSide({
      ty: 'tcp',
      hostname: '2001:db8::1',
      port: 30333,
    });
    const connection = platform.connect(side.config);
    expect(asked).toEqual([
      { hostname: '[2001:db8::1]', port: 30333 },
      { allowHalfOpen: true },
    ]);
    await settle();
    connection.send([new Uint8Array([1, 2]), new Uint8Array([3])]);
    tcp.receive([9, 8]);
    await settle();
    tcp.end();
    await settle();
    expect(tcp.written).toEqual([[1, 2], [3]]);
    // Reading and writing are independent, so only each one's own order is fixed.
    const of = (kind: string) => side.calls.filter(([type]) => type === kind);
    expect(of('writable')).toEqual([
      ['writable', 1024 * 1024],
      ['writable', 2],
      ['writable', 1],
    ]);
    expect(of('message')).toEqual([['message', [9, 8]]]);
    expect(side.calls.at(-1)).toEqual(['reset', 'EOF when reading socket']);
  });

  it('stays silent once smoldot has reset a TCP connection', async () => {
    const tcp = fakeTcpSocket();
    const platform = workersPlatform({ connect: () => tcp.socket });
    const side = smoldotSide({ ty: 'tcp', hostname: '1.2.3.4', port: 30333 });
    const connection = platform.connect(side.config);
    await settle();
    connection.reset();
    tcp.receive([1]);
    tcp.end();
    await settle();
    expect(tcp.closed).toBe(true);
    expect(side.calls).toEqual([['writable', 1024 * 1024]]);
  });

  it('opens WebSocket peers through fetch and passes binary messages', async () => {
    const listeners: Record<string, (event: any) => void> = {};
    const sent: number[][] = [];
    const ws = {
      binaryType: '',
      accept: vi.fn(),
      addEventListener: (type: string, listener: (event: any) => void) =>
        (listeners[type] = listener),
      send: (data: Uint8Array) => void sent.push([...data]),
      close: vi.fn(),
    };
    const fetch = vi.fn(async () => ({ status: 101, webSocket: ws }));
    const platform = workersPlatform({ connect: () => null, fetch });
    const side = smoldotSide({
      ty: 'websocket',
      url: 'ws://bootnode.example:30333',
    });
    const connection = platform.connect(side.config);
    await settle();
    expect(fetch).toHaveBeenCalledWith('http://bootnode.example:30333', {
      headers: { Upgrade: 'websocket' },
    });
    expect(ws.accept).toHaveBeenCalled();
    connection.send([new Uint8Array([1]), new Uint8Array([2, 3])]);
    listeners.message({ data: new Uint8Array([7]).buffer });
    await settle();
    listeners.close({ code: 1006, reason: '' });
    expect(sent).toEqual([[1, 2, 3]]);
    expect(side.calls).toEqual([
      ['writable', 1024 * 1024],
      ['message', [7]],
      ['writable', 3],
      ['reset', 'Error code 1006'],
    ]);
  });

  it('resets a WebSocket peer that answers without upgrading', async () => {
    const platform = workersPlatform({
      connect: () => null,
      fetch: async () => ({ status: 404, webSocket: null }),
    });
    const side = smoldotSide({
      ty: 'websocket',
      url: 'wss://peer.example:443',
    });
    platform.connect(side.config);
    await settle();
    expect(side.calls).toEqual([['reset', 'HTTP 404 instead of a WebSocket']]);
  });
});

describe('who may use the light client, and how much', () => {
  const at = (path: string, init?: RequestInit) =>
    new Request(`https://light.example${path}`, init);
  const onward = async (request: Request, key?: string) => {
    const unlocked = await access.unlock(request, key);
    return unlocked && new URL(unlocked.url).pathname;
  };

  it('lets in only addresses that start with the key, and takes the key off', async () => {
    // Without a key, every request goes on as it came.
    const open = at('/status');
    expect(await access.unlock(open, undefined)).toBe(open);
    expect(await access.unlock(open, '')).toBe(open);
    const key = 'c0ffee'.repeat(8);
    expect(await onward(at(`/${key}`), key)).toBe('/');
    expect(await onward(at(`/${key}/`), key)).toBe('/');
    expect(await onward(at(`/${key}/status`), key)).toBe('/status');
    for (const path of [
      '/',
      '/status',
      `/${key}x`,
      `/${key.slice(1)}`,
      `/${key.toUpperCase()}`,
      `/status/${key}`,
    ])
      expect(await onward(at(path), key), path).toBeNull();
    // What a request carries goes on with it.
    const posted = await access.unlock(
      at(`/${key}`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '192.0.2.1' },
        body: '{"id":1}',
      }),
      key,
    );
    expect(posted.method).toBe('POST');
    expect(posted.headers.get('cf-connecting-ip')).toBe('192.0.2.1');
    expect(await posted.text()).toBe('{"id":1}');
  });

  it('allows each caller a burst, then a steady rate, and says how long to wait', () => {
    let now = 1_000_000;
    const limit = new access.RateLimit({
      perSecond: 2,
      burst: 5,
      now: () => now,
    });
    expect([1, 2, 3, 4, 5].map(() => limit.take('a'))).toEqual([0, 0, 0, 0, 0]);
    expect(limit.take('a')).toBe(1);
    expect(limit.take('b')).toBe(0);
    now += 1000;
    expect(limit.take('a', 2)).toBe(0);
    expect(limit.take('a')).toBe(1);
    // A batch counts each call, and a refused one takes nothing.
    now += 10_000;
    expect(limit.take('a', 4)).toBe(0);
    expect(limit.take('a', 4)).toBe(2);
    now += 1500;
    expect(limit.take('a', 4)).toBe(0);
  });

  it('forgets callers whose allowance is whole again, and keeps at most so many', () => {
    let now = 0;
    const limit = new access.RateLimit({
      perSecond: 1,
      burst: 2,
      maxClients: 3,
      now: () => now,
    });
    limit.take('a');
    limit.take('b', 2);
    now += 1000;
    limit.forget();
    expect(limit.size).toBe(1);
    // b's allowance is half back, not whole.
    expect(limit.take('b', 2)).toBe(1);
    // Past the most, the callers seen longest ago go first.
    limit.take('c', 2);
    limit.take('b'); // b again: now the one seen most recently
    limit.take('d', 2);
    limit.take('e', 2);
    expect(limit.size).toBe(3);
    expect(limit.take('b')).toBe(1); // kept, its allowance spent
    expect(limit.take('c', 2)).toBe(0); // forgotten, so whole again
  });

  it('counts IPv6 callers by their /64', () => {
    expect(access.clientOf('192.0.2.7')).toBe('192.0.2.7');
    expect(access.clientOf(null)).toBe('unknown');
    expect(access.clientOf('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(
      new Set(
        [
          '2001:db8:85a3:42::1',
          '2001:0db8:85a3:0042:ffff:ffff:ffff:ffff',
          '2001:DB8:85A3:42:0:0:0:9',
        ].map(access.clientOf),
      ),
    ).toEqual(new Set(['2001:db8:85a3:42::/64']));
    expect(access.clientOf('2001:db8:85a3:43::1')).toBe(
      '2001:db8:85a3:43::/64',
    );
    expect(access.clientOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(access.clientOf('::1')).toBe('0:0:0:0::/64');
  });
});

describe('the hash and the proofs old blocks are checked with', () => {
  it('hashes as BLAKE2b-256 does, across block boundaries', () => {
    // Python's hashlib.blake2b(digest_size=32) of the bytes (i * 7 + 3) % 256.
    const expected: Record<number, string> = {
      0: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
      1: 'e88bd757ad5b9bedf372d8d3f0cf6c962a469db61a265f6418e1ffed86da29ec',
      63: 'a69e023685fa5f19fca13acc02142a9cf8450ce5b77966586e0d000c4a4ea942',
      127: 'c9ae3859964b35f04c54b36d33cf299d7290ee621005d28e51598a943560aaaa',
      128: 'f0501d06597880592bc49234eef100ec1ff349058d0e9d9b753504e24af86dd6',
      129: 'a34a4e1e03c541dfbf3099c4b6c143c022ced65c28bd7e8a10e0a098461aecf0',
      256: 'd93ebb9c802f5630ab22516fd82b6c21bc8bd551d531349b715f046ed11ed871',
      257: '4ce481b24d387422d2bc2baa03d1afd55a1327939ff537c71eb9b38709268649',
      4096: '3b7dcca5dcb409b9ee1d33ac58a03966d5e86581278891945e3d2fd80e3aad58',
    };
    for (const [length, digest] of Object.entries(expected)) {
      const data = Uint8Array.from(
        { length: Number(length) },
        (_, i) => (i * 7 + 3) % 256,
      );
      expect(proofs.toHex(blake2b256(data)), `${length} bytes`).toBe(
        `0x${digest}`,
      );
    }
  });

  it("checks headers against their hashes and storage against a block's state root", () => {
    expect(proofs.headerHash(finney.header)).toBe(finney.hash);
    for (const { hash, header } of finney.headers)
      expect(proofs.headerHash(header)).toBe(hash);
    expect(finney.headers[0].hash).toBe(finney.header.parentHash);
    expect(
      proofs.headerHash({ ...finney.header, number: '0x895441' }),
    ).not.toBe(finney.hash);
    const root = finney.header.stateRoot;
    // A small value, a timestamp, two accounts (stored by hash), and an account that isn't there.
    for (const read of finney.reads) {
      const value = proofs.readProof(root, read.key, read.proof);
      expect(value && proofs.toHex(value), read.name).toBe(read.value);
    }
    expect(
      finney.multi.keys.map((key) =>
        proofs.toHex(proofs.readProof(root, key, finney.multi.proof)),
      ),
    ).toEqual(finney.reads.slice(0, 3).map((read) => read.value));
  });

  it('reads the older encoding too: a long partial key and a long value kept inline', () => {
    // A trie of one key: its root is a leaf holding all 64 nibbles of the key (63 in the
    // header byte, one more after it) and a 100-byte value, its length in two bytes.
    const key = Uint8Array.from({ length: 32 }, (_, i) => i * 8 + 1);
    const value = Uint8Array.from({ length: 100 }, (_, i) => 255 - i);
    const leaf = Uint8Array.from([
      0x40 | 63,
      1,
      ...key,
      (100 << 2) | 1,
      (100 << 2) >> 8,
      ...value,
    ]);
    const root = proofs.toHex(blake2b256(leaf));
    const proof = [proofs.toHex(leaf)];
    expect(proofs.readProof(root, proofs.toHex(key), proof)).toEqual(value);
    // A key that shares the leaf's first 63 nibbles but not the last isn't there.
    const other = key.slice();
    other[31] ^= 0x01;
    expect(proofs.readProof(root, proofs.toHex(other), proof)).toBeNull();
    expect(
      proofs.readProof(root, proofs.toHex(key.slice(0, 31)), proof),
    ).toBeNull();
    // Nor is one that goes on past the leaf's whole path.
    expect(
      proofs.readProof(root, proofs.toHex(Uint8Array.from([...key, 0])), proof),
    ).toBeNull();
  });

  it("rebuilds a block's extrinsics root as Finney's runtime does, and only from its own extrinsics", () => {
    // Substrate's root of the empty trie.
    expect(proofs.trieRoot([])).toBe(
      '0x03170a2e7597b7b7e3d84c05391d139a62b157e78786d8c082f29dcf4c111314',
    );
    for (const { number, hash, block } of finneyBlocks) {
      const { header, extrinsics } = block;
      expect(proofs.headerHash(header), `#${number}`).toBe(hash);
      // Finney's runtime builds it as state version 0, whatever its state uses.
      expect(proofs.extrinsicsRoot(extrinsics, 0), `#${number}`).toBe(
        header.extrinsicsRoot,
      );
      expect(proofs.extrinsicsRoot(extrinsics, 1)).not.toBe(
        header.extrinsicsRoot,
      );
      const swapped = [extrinsics[1], extrinsics[0], ...extrinsics.slice(2)];
      const changed = extrinsics.map((x, i) =>
        i === extrinsics.length - 1
          ? `${x.slice(0, -2)}${x.endsWith('00') ? '01' : '00'}`
          : x,
      );
      for (const other of [swapped, changed, extrinsics.slice(0, -1)])
        expect(proofs.extrinsicsRoot(other, 0)).not.toBe(header.extrinsicsRoot);
    }
  });

  it('builds tries that its own proofs read back, values kept by hash in version 1', () => {
    const entries: [Uint8Array, Uint8Array][] = [
      [Uint8Array.of(1, 2), Uint8Array.from({ length: 56 }, (_, i) => i)],
      [Uint8Array.of(1, 3), Uint8Array.of(7)],
      [Uint8Array.of(1), Uint8Array.of(9, 9)], // a value where two keys part
      [Uint8Array.of(9), new Uint8Array(0)],
      // Version 1 keeps a value by hash from 33 bytes: a real proof of System.BlockHash at
      // #9,000,000 keeps a 32-byte one inline.
      [Uint8Array.of(2, 1), new Uint8Array(32).fill(7)],
      [Uint8Array.of(2, 2), new Uint8Array(33).fill(8)],
      // Leaves whose nibble counts fall on the header's edges: 63 (all the first byte holds),
      // 318 (63 and a 255), and 399.
      [
        Uint8Array.from({ length: 32 }, (_, i) => (i ? 0x5a : 0xf3)),
        Uint8Array.of(5),
      ],
      [
        Uint8Array.from({ length: 160 }, (_, i) => (i ? 0xa5 : 0xe0)),
        Uint8Array.of(6),
      ],
      [Uint8Array.of(0xe1), Uint8Array.of(8)],
      [Uint8Array.from({ length: 200 }, (_, i) => i), Uint8Array.of(1, 2, 3)],
      // Values kept by hash under long partial keys: a leaf's (39 nibbles) and a branch's (31).
      [
        Uint8Array.from({ length: 20 }, (_, i) => (i ? 0x3c : 0xd7)),
        new Uint8Array(40).fill(9),
      ],
      [
        Uint8Array.from({ length: 16 }, (_, i) => (i ? 0x69 : 0xc4)),
        new Uint8Array(40).fill(4),
      ],
      [
        Uint8Array.from({ length: 17 }, (_, i) =>
          i === 16 ? 0 : i ? 0x69 : 0xc4,
        ),
        Uint8Array.of(1),
      ],
      [
        Uint8Array.from({ length: 17 }, (_, i) =>
          i === 16 ? 0x10 : i ? 0x69 : 0xc4,
        ),
        Uint8Array.of(2),
      ],
      // A leaf of exactly 32 bytes, the smallest child kept by hash.
      [Uint8Array.of(3, 0x10), new Uint8Array(29).fill(3)],
      [Uint8Array.of(3, 0x20), Uint8Array.of(1)],
    ];
    const roots = [0, 1].map((version) => {
      const nodes: Uint8Array[] = [];
      const root = proofs.trieRoot(entries, version, nodes);
      const proof = nodes.map((node) => proofs.toHex(node));
      for (const [key, value] of entries)
        expect(
          proofs.toHex(proofs.readProof(root, proofs.toHex(key), proof)),
          `version ${version}`,
        ).toBe(proofs.toHex(value));
      expect(proofs.readProof(root, '0x0104', proof)).toBeNull();
      return { root, nodes: nodes.length };
    });
    // Version 1 keeps the 56-, 33- and both 40-byte values as nodes of their own, not the 32-byte one.
    expect(roots[1].nodes).toBe(roots[0].nodes + 4);
    expect(roots[1].root).not.toBe(roots[0].root);
  });

  it('refuses a proof missing a node, with any node changed, or for another block', () => {
    const read = finney.reads[2];
    const root = finney.header.stateRoot;
    expect(() =>
      proofs.readProof(root, read.key, read.proof.slice(0, -1)),
    ).toThrow(proofs.ProofError);
    for (let i = 0; i < read.proof.length; i++) {
      const changed = read.proof.map((node, j) =>
        j === i
          ? `${node.slice(0, -2)}${node.endsWith('00') ? '01' : '00'}`
          : node,
      );
      expect(
        () => proofs.readProof(root, read.key, changed),
        `node ${i}`,
      ).toThrow(proofs.ProofError);
    }
    expect(() =>
      proofs.readProof(
        finney.headers[0].header.stateRoot,
        read.key,
        read.proof,
      ),
    ).toThrow('lacks the state root');
    expect(() => proofs.readProof(root, read.key, ['0xzz'])).toThrow(
      proofs.ProofError,
    );
  });
});

type Header = {
  parentHash: string;
  number: string;
  stateRoot: string;
  extrinsicsRoot: string;
  digest: { logs: string[] };
};
// The record's SQL on Node's SQLite, as the Durable Object's runs it.
const sql = () => {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (query: string, ...args: any[]) => ({
      toArray: () => db.prepare(query).all(...args),
    }),
  };
};
// Headers chained by their real hashes, from block `from` on.
function chainOf(length: number, from: number) {
  const headers: Header[] = [];
  let parentHash = `0x${'11'.repeat(32)}`;
  for (let i = 0; i < length; i++) {
    const header = {
      parentHash,
      number: `0x${(from + i).toString(16)}`,
      stateRoot: `0x${(i % 256).toString(16).padStart(2, '0').repeat(32)}`,
      extrinsicsRoot: `0x${'ee'.repeat(32)}`,
      digest: { logs: [] },
    };
    headers.push(header);
    parentHash = proofs.headerHash(header);
  }
  return headers;
}
// An archive node that answers from `chain` and from the fixture.
function archiveOf(
  chain: Header[] = [],
  answers: Record<string, (params: any[]) => unknown> = {},
) {
  const byHash = new Map<string, unknown>(
    chain.map((h) => [proofs.headerHash(h), h]),
  );
  byHash.set(finney.hash, finney.header);
  const known: Record<string, (params: any[]) => unknown> = {
    chain_getBlockHash: ([n]) => {
      const header = chain.find((h) => parseInt(h.number, 16) === n);
      return header ? proofs.headerHash(header) : null;
    },
    chain_getHeader: ([hash]) => byHash.get(hash) ?? null,
    state_getReadProof: ([keys]) => ({
      at: finney.hash,
      proof:
        keys.length > 1
          ? finney.multi.proof
          : finney.reads.find((read) => read.key === keys[0])!.proof,
    }),
    ...answers,
  };
  const node = {
    calls: [] as string[],
    async call(method: string, params: any[]) {
      node.calls.push(method);
      if (!known[method])
        throw new history.ArchiveError(`The archive node refused: ${method}`);
      return known[method](params);
    },
    batch: (calls: [string, any[]][]) =>
      Promise.all(calls.map(([m, p]) => node.call(m, p).catch(() => null))),
  };
  return node;
}

describe('the verified history and old blocks', () => {
  it('records what smoldot finalizes, finds block hashes, and sends old blocks to the archive node', async () => {
    const chain = chainOf(400, 9000);
    const hashOf = (n: number) => proofs.headerHash(chain[n - 9000]);
    const h = new history.History({
      store: history.sqlStore(sql()),
      archive: archiveOf(chain),
      historyBlocks: 0,
    });
    for (const header of chain) h.imported(header);
    for (const header of chain.slice(100)) h.finalized(header);
    const key = finney.reads[0].key;
    // smoldot answers for the last 200 blocks it imported; the archive node for the rest.
    expect(h.route('state_getStorage', [key, hashOf(9399)])).toBe('smoldot');
    expect(h.route('state_getStorage', [key, hashOf(9199)])).toBe('smoldot');
    expect(h.route('state_getStorage', [key, hashOf(9198)])).toBe('archive');
    expect(
      h.route('state_call', ['Core_version', '0x', `0x${'99'.repeat(32)}`]),
    ).toBe('archive');
    expect(h.route('state_getStorage', [key])).toBe('smoldot');
    expect(h.route('toString', [hashOf(9000)])).toBe('smoldot');
    // A recorded number is verified, an older one is the archive node's (marked), a newer smoldot's.
    expect(await h.blockHash(9300)).toEqual({ result: hashOf(9300) });
    expect(await h.blockHash(9050)).toEqual({
      result: hashOf(9050),
      unverified: expect.stringContaining('older than'),
    });
    expect(await h.blockHash(9400)).toBeNull();
    expect(h.status()).toEqual({ from: 9100, to: 9399 });
    // After a restart smoldot knows none of them until it imports blocks again.
    h.restarted();
    expect(h.route('state_getStorage', [key, hashOf(9399)])).toBe('archive');
    // Without an archive node, everything stays with smoldot.
    const alone = new history.History({ store: history.sqlStore(sql()) });
    expect(alone.route('state_getStorage', [key, hashOf(9000)])).toBe(
      'smoldot',
    );
    expect(
      await alone.answer('state_getStorage', [key, hashOf(9000)]),
    ).toBeNull();
  });

  it('reads old storage through a proof checked against the block, and passes on, marked, what no proof covers', async () => {
    const archive = archiveOf([], { state_call: () => '0x1234' });
    const h = new history.History({ store: history.sqlStore(sql()), archive });
    h.finalized(finney.header); // recorded: its state root is known
    for (const read of finney.reads)
      expect(
        await h.answer('state_getStorage', [read.key, finney.hash]),
        read.name,
      ).toEqual({ result: read.value });
    expect(archive.calls).not.toContain('chain_getHeader');
    const account = finney.reads[2];
    expect(
      await h.answer('state_getStorageHash', [account.key, finney.hash]),
    ).toEqual({
      result: proofs.toHex(blake2b256(proofs.fromHex(account.value!))),
    });
    expect(
      await h.answer('state_queryStorageAt', [finney.multi.keys, finney.hash]),
    ).toEqual({
      result: [
        {
          block: finney.hash,
          changes: finney.multi.keys.map((key, i) => [
            key,
            finney.reads[i].value,
          ]),
        },
      ],
    });
    expect(await h.answer('chain_getHeader', [finney.hash])).toEqual({
      result: finney.header,
    });
    expect(
      await h.answer('state_call', ['Core_version', '0x', finney.hash]),
    ).toEqual({
      result: '0x1234',
      unverified: expect.stringContaining('no proof'),
    });
    expect(
      await h.answer('state_getKeysPaged', ['0x00', 1, null, finney.hash]),
    ).toEqual({
      error: {
        code: -32000,
        message: 'The archive node refused: state_getKeysPaged',
      },
    });
    expect(
      await h.answer('state_getStorage', [['not hex'], finney.hash]),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await h.answer('state_queryStorageAt', [
        Array.from({ length: 1001 }, () => finney.reads[0].key),
        finney.hash,
      ]),
    ).toMatchObject({ error: { code: -32602 } });
    // A block outside the record: its header is checked against the hash first.
    const fresh = new history.History({
      store: history.sqlStore(sql()),
      archive: archiveOf(),
    });
    expect(
      await fresh.answer('state_getStorage', [
        finney.reads[0].key,
        finney.hash,
      ]),
    ).toEqual({ result: finney.reads[0].value });
    // What doesn't check out is refused, not passed on.
    const lying = (answers: Record<string, (params: any[]) => unknown>) =>
      new history.History({
        store: history.sqlStore(sql()),
        archive: archiveOf([], answers),
      });
    const changed = account.proof.map((node, i) =>
      i === 3
        ? `${node.slice(0, -2)}${node.endsWith('00') ? '01' : '00'}`
        : node,
    );
    expect(
      await lying({ state_getReadProof: () => ({ proof: changed }) }).answer(
        'state_getStorage',
        [account.key, finney.hash],
      ),
    ).toEqual({
      error: {
        code: -32000,
        message: expect.stringContaining("didn't check out"),
      },
    });
    const otherRoot = {
      ...finney.header,
      stateRoot: finney.headers[0].header.stateRoot,
    };
    for (const method of ['state_getStorage', 'chain_getHeader'])
      expect(
        await lying({ chain_getHeader: () => otherRoot }).answer(
          method,
          method === 'chain_getHeader'
            ? [finney.hash]
            : [account.key, finney.hash],
        ),
        method,
      ).toEqual({
        error: {
          code: -32000,
          message: expect.stringContaining("doesn't hash"),
        },
      });
    expect(
      await lying({ chain_getHeader: () => null }).answer('chain_getHeader', [
        finney.hash,
      ]),
    ).toBeNull();
  });

  it("serves an old block's body only when its extrinsics make its header's extrinsics root", async () => {
    const [{ hash, block }] = finneyBlocks;
    const serving = (body: unknown) =>
      new history.History({
        store: history.sqlStore(sql()),
        archive: archiveOf([], { chain_getBlock: () => body }),
      });
    const signed = { block, justifications: [['FRNK', '0x00']] };
    expect(await serving(signed).answer('chain_getBlock', [hash])).toEqual({
      result: { block, justifications: null },
    });
    const changed = block.extrinsics.map((x, i) =>
      i === 3 ? `${x.slice(0, -2)}${x.endsWith('00') ? '01' : '00'}` : x,
    );
    for (const body of [
      { block: { ...block, extrinsics: changed } },
      { block: { ...block, extrinsics: block.extrinsics.slice(1) } },
      { block: { ...block, extrinsics: 'none' } },
    ])
      expect(await serving(body).answer('chain_getBlock', [hash])).toEqual({
        error: {
          code: -32000,
          message: expect.stringContaining(
            "don't make its header's extrinsics root",
          ),
        },
      });
    expect(
      await serving({
        block: { ...block, header: finneyBlocks[1].block.header },
      }).answer('chain_getBlock', [hash]),
    ).toEqual({
      error: { code: -32000, message: expect.stringContaining("doesn't hash") },
    });
    expect(await serving(null).answer('chain_getBlock', [hash])).toBeNull();
    // A runtime that builds the root as version 1 is taken too.
    const header = {
      ...block.header,
      extrinsicsRoot: proofs.extrinsicsRoot(block.extrinsics, 1),
    };
    const later = { header, extrinsics: block.extrinsics };
    expect(
      await serving({ block: later }).answer('chain_getBlock', [
        proofs.headerHash(header),
      ]),
    ).toEqual({ result: { block: later, justifications: null } });
  });

  it('talks JSON-RPC to the archive node, and says why when it refuses', async () => {
    const replies: unknown[] = [];
    const bodies: unknown[] = [];
    const node = history.archiveNode(
      'https://archive.example',
      async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return typeof reply === 'number'
          ? new Response('', { status: reply })
          : new Response(
              typeof reply === 'string' ? reply : JSON.stringify(reply),
            );
      },
    );
    replies.push({ jsonrpc: '2.0', id: 1, result: '0xabc' });
    expect(await node.call('chain_getBlockHash', [1])).toBe('0xabc');
    expect(bodies[0]).toMatchObject({
      method: 'chain_getBlockHash',
      params: [1],
    });
    // A batch's answers come back in any order.
    replies.push([
      { id: 1, result: 'b' },
      { id: 0, result: 'a' },
    ]);
    expect(
      await node.batch([
        ['m', [0]],
        ['m', [1]],
        ['m', [2]],
      ]),
    ).toEqual(['a', 'b', null]);
    for (const [reply, message] of [
      [
        { error: { message: 'Unknown block' } },
        'The archive node refused: Unknown block',
      ],
      [503, 'The archive node answered HTTP 503'],
      ['<html>', "The archive node's answer isn't JSON"],
      [new TypeError('fetch failed'), 'The archive node did not answer'],
    ] as const) {
      replies.push(reply);
      await expect(node.call('m', [])).rejects.toThrow(message);
    }
    replies.push({
      error: {
        code: -32010,
        message: 'The batch request was too large',
        data: 'Exceeded max limit of 50',
      },
    });
    await expect(node.batch([['m', []]])).rejects.toThrow(
      'The archive node refused: The batch request was too large (Exceeded max limit of 50)',
    );
  });

  it('fills gaps and history from the archive node, each header checked against its child', async () => {
    const chain = chainOf(700, 5000);
    const at = (n: number) => chain[n - 5000];
    const store = history.sqlStore(sql());
    const h = new history.History({
      store,
      archive: archiveOf(chain),
      historyBlocks: 250,
    });
    h.finalized(at(5599));
    expect(await h.fill(150)).toBe(150);
    expect(h.status()).toEqual({ from: 5449, to: 5599 });
    expect(await h.fill()).toBe(100); // to 250 blocks below the newest
    expect(h.status()).toEqual({ from: 5349, to: 5599 });
    expect(await h.fill()).toBe(0);
    for (const n of [5349, 5500, 5598])
      expect(store.byNumber(n)).toMatchObject({
        hash: proofs.headerHash(at(n)),
        parent_hash: at(n).parentHash,
        state_root: at(n).stateRoot,
      });
    // A gap, as after the light client was down: filled down to the block below it.
    h.finalized(at(5699));
    expect(await h.fill()).toBe(99);
    expect(h.status()).toEqual({ from: 5349, to: 5699 });
    expect(store.byNumber(5650)).toMatchObject({
      hash: proofs.headerHash(at(5650)),
    });
    // An archive node whose block #5550 isn't the one the chain names: filling stops there.
    const changed = chain.map((header, i) =>
      i === 550 ? { ...header, stateRoot: `0x${'00'.repeat(32)}` } : header,
    );
    const misled = new history.History({
      store: history.sqlStore(sql()),
      archive: archiveOf(changed),
      historyBlocks: 250,
    });
    misled.finalized(at(5599));
    expect(await misled.fill()).toBe(48);
    expect(misled.status()).toEqual({ from: 5551, to: 5599 });
    // A recorded block below a gap that isn't the parent the checked chain leads to: filling
    // stops at the gap, and doesn't go on below the wrong block.
    const wrongStore = history.sqlStore(sql());
    wrongStore.put([
      {
        number: 5500,
        hash: `0x${'aa'.repeat(32)}`,
        parent_hash: at(5500).parentHash,
        state_root: at(5500).stateRoot,
      },
    ]);
    const wrong = new history.History({
      store: wrongStore,
      archive: archiveOf(chain),
      historyBlocks: 1000,
    });
    wrong.finalized(at(5599));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await wrong.fill()).toBe(98);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('the record is inconsistent'),
    );
    errors.mockRestore();
    // A recorded block whose number is off by one, and an archive node whose numbers are off the
    // same way: the parent's header names another number, and nothing is recorded under it.
    const offStore = history.sqlStore(sql());
    offStore.put([
      {
        number: 5601,
        hash: `0x${'ab'.repeat(32)}`,
        parent_hash: proofs.headerHash(at(5599)),
        state_root: at(5599).stateRoot,
      },
    ]);
    const off = new history.History({
      store: offStore,
      archive: archiveOf(chain, {
        chain_getBlockHash: ([n]) => proofs.headerHash(at(n - 1)),
      }),
      historyBlocks: 10,
    });
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await off.fill()).toBe(0);
    expect(offStore.byNumber(5600)).toBeUndefined();
    warnings.mockRestore();
  });

  it('asks the archive node at most eight things at once', async () => {
    let open = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const archive = {
      async call() {
        open++;
        most = Math.max(most, open);
        await new Promise<void>((resolve) => release.push(resolve));
        open--;
        return '0x01';
      },
      batch: async () => [],
    };
    const h = new history.History({ store: history.sqlStore(sql()), archive });
    const answers = Array.from({ length: 12 }, (_, i) =>
      h.answer('state_call', ['m', '0x', `0x${String(i).padStart(64, '0')}`]),
    );
    await settle();
    expect(open).toBe(8);
    while (release.length) {
      release.shift()!();
      await settle();
    }
    expect(await Promise.all(answers)).toHaveLength(12);
    expect(most).toBe(8);
  });
});

describe('the per-block cache and the archive route', () => {
  const BEST = `0x${'b0'.repeat(32)}`;
  const smoldot = (request: Message): Message | undefined => {
    if (request.method === 'chain_getBlockHash') return { result: BEST };
    if (request.method === 'state_getStorage')
      return { result: `0x${request.params[1].slice(2, 6)}` };
    if (request.method === 'state_getKeysPaged') return { result: [] };
    if (request.method === 'state_call')
      return {
        error: { code: -32000, message: 'No node available for storage query' },
      };
    return undefined;
  };
  const read = (
    router: InstanceType<typeof Router>,
    id: number,
    block?: string,
  ) =>
    router.request(null, {
      id,
      method: 'state_getStorage',
      params: block ? ['0x00', block] : ['0x00'],
    });

  it('answers a call about one block once, shares it while it runs, and keeps it', async () => {
    const { router, sent } = started(smoldot);
    const [a, b] = await Promise.all([
      read(router, 1, BEST),
      read(router, 2, BEST),
    ]);
    expect(a).toEqual({ jsonrpc: '2.0', id: 1, result: '0xb0b0' });
    expect(b).toEqual({ jsonrpc: '2.0', id: 2, result: '0xb0b0' });
    expect(await read(router, 3, BEST)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: '0xb0b0',
    });
    expect(sent.filter((r) => r.method === 'state_getStorage')).toHaveLength(1);
    expect(router.cacheStats()).toMatchObject({
      entries: 1,
      hits: 2,
      misses: 1,
    });
  });

  it('pins a call that names no block to the best block, so it is kept too', async () => {
    let best = BEST;
    const { router, sent } = started((request) =>
      request.method === 'chain_getBlockHash'
        ? { result: best }
        : smoldot(request),
    );
    const reads = () => sent.filter((r) => r.method === 'state_getStorage');
    expect(await read(router, 1)).toMatchObject({ result: '0xb0b0' });
    expect(reads()[0].params).toEqual(['0x00', BEST]);
    await read(router, 2);
    expect(reads()).toHaveLength(1);
    best = `0x${'c0'.repeat(32)}`;
    expect(await read(router, 3)).toMatchObject({ result: '0xc0c0' });
    expect(reads()).toHaveLength(2);
    // The block goes in its own place: fourth for state_getKeysPaged.
    await router.request(null, {
      id: 4,
      method: 'state_getKeysPaged',
      params: ['0x00', 10],
    });
    expect(sent.find((r) => r.method === 'state_getKeysPaged')!.params).toEqual(
      ['0x00', 10, null, best],
    );
  });

  it('keeps no errors, and past its size forgets the least recently used', async () => {
    const { router, sent } = started(smoldot, { cacheChars: 20 });
    const call = (id: number) =>
      router.request(null, {
        id,
        method: 'state_call',
        params: ['Core_version', '0x', BEST],
      });
    expect(await call(1)).toMatchObject({
      error: { message: 'No node available for storage query' },
    });
    await call(2);
    expect(sent.filter((r) => r.method === 'state_call')).toHaveLength(2);
    // Each answer here is 8 characters of JSON, so two fit.
    const [first, second, third] = ['a1', 'a2', 'a3'].map(
      (b) => `0x${b.repeat(32)}`,
    );
    await read(router, 3, first);
    await read(router, 4, second);
    await read(router, 5, first); // now the most recently used
    await read(router, 6, third); // second goes
    expect(router.cacheStats()).toMatchObject({ entries: 2 });
    const before = sent.length;
    await read(router, 7, first);
    expect(sent).toHaveLength(before);
    await read(router, 8, second);
    expect(sent).toHaveLength(before + 1);
    // An answer bigger than one entry may be is never kept.
    const tight = started(smoldot, { cacheEntryChars: 5 });
    await read(tight.router, 1, first);
    await read(tight.router, 2, first);
    expect(
      tight.sent.filter((r) => r.method === 'state_getStorage'),
    ).toHaveLength(2);
  });

  it('sends old blocks to the archive node, and falls back to it when smoldot fails a call a proof can answer', async () => {
    const OLD = `0x${'01'.repeat(32)}`;
    const UNKNOWN = `0x${'0f'.repeat(32)}`;
    const FAILING = `0x${'e0'.repeat(32)}`;
    const fake = {
      route: (_method: string, params: unknown[]) =>
        params.includes(OLD) ||
        params.includes(UNKNOWN) ||
        params.includes(BEST)
          ? 'archive'
          : 'smoldot',
      proves: (method: string) => method === 'state_getStorage',
      answer: async (method: string, params: unknown[]) =>
        params.includes(UNKNOWN)
          ? null
          : {
              result: '0xa4c1',
              ...(method === 'state_call' ? { unverified: 'not checked' } : {}),
            },
      blockHash: async (n: number) =>
        n === 7
          ? { result: OLD, unverified: 'older' }
          : n === 8
            ? { result: BEST }
            : null,
    };
    const { router, sent } = started(
      (request) =>
        request.method === 'state_getStorage' && request.params[1] === FAILING
          ? {
              error: {
                code: -32000,
                message: 'Storage query errors: RemoteCouldntAnswer',
              },
            }
          : smoldot(request),
      { history: fake },
    );
    // An old block: the archive node answers, and smoldot isn't asked.
    expect(
      await router.request(null, {
        id: 1,
        method: 'state_call',
        params: ['Core_version', '0x', OLD],
      }),
    ).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: '0xa4c1',
      unverified: 'not checked',
    });
    expect(sent.some((r) => r.method === 'state_call')).toBe(false);
    // A block the archive node doesn't know: smoldot answers.
    expect(await read(router, 2, UNKNOWN)).toMatchObject({ result: '0x0f0f' });
    // smoldot fails a call a proof can answer: the archive node's checked answer stands in.
    expect(await read(router, 3, FAILING)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: '0xa4c1',
    });
    // Not for a call no proof covers: smoldot's error stands.
    expect(
      await router.request(null, {
        id: 4,
        method: 'state_call',
        params: ['Core_version', '0x', `0x${'b1'.repeat(32)}`],
      }),
    ).toMatchObject({
      error: { message: 'No node available for storage query' },
    });
    // A call that names no block stays with smoldot, which just named its best block, whatever
    // the route would say for that block.
    expect(await read(router, 9)).toMatchObject({ result: '0xb0b0' });
    // Block numbers: the record's, the archive node's (marked), else smoldot's.
    for (const [id, params, expected] of [
      [5, [8], { result: BEST }],
      [6, ['0x7'], { result: OLD, unverified: 'older' }],
      [7, [], { result: BEST }],
    ] as const)
      expect(
        await router.request(null, {
          id,
          method: 'chain_getBlockHash',
          params: [...params],
        }),
      ).toEqual({ jsonrpc: '2.0', id, ...expected });
  });
});

describe("the light client's memory trace", () => {
  const at = (ms: number, bytes: number, note = '') => ({
    ms,
    bytes,
    received: ms * 1000,
    connections: 3,
    source: 'timer',
    note,
  });

  it('reports how high the previous start went, when, and its last samples', () => {
    const trace = new MemoryTrace(sql());
    expect(trace.begin(1000)).toBeNull();
    trace.record(1000, at(250, 20 << 20));
    trace.record(
      1000,
      at(500, 33 << 20, '[runtime-bittensor] Successfully compiled'),
    );
    trace.record(1000, at(750, 33 << 20));
    trace.record(1000, at(1000, 31 << 20));
    const previous = trace.begin(2000);
    expect(previous).toMatchObject({
      bytes: 33 << 20,
      atMs: 500,
      lastMs: 1000,
    });
    // The start's own row, then its samples, oldest first.
    expect(previous.samples.map((s: { ms: number }) => s.ms)).toEqual([
      0, 250, 500, 750, 1000,
    ]);
    expect(previous.samples[2]).toEqual({
      ...at(500, 33 << 20, '[runtime-bittensor] Successfully compiled'),
    });
  });

  it('keeps only the start before the current one, and its last six samples', () => {
    const trace = new MemoryTrace(sql());
    trace.begin(1);
    trace.record(1, at(250, 50 << 20));
    trace.begin(2);
    for (let i = 1; i <= 10; i++) trace.record(2, at(i * 250, i << 20));
    // A late sample of the first start is no longer kept.
    trace.record(1, at(9999, 60 << 20));
    const previous = trace.begin(3);
    expect(previous.bytes).toBe(10 << 20);
    expect(previous.samples.map((s: { ms: number }) => s.ms)).toEqual([
      1250, 1500, 1750, 2000, 2250, 2500,
    ]);
    // A start reset before its first sample is still the one reported next.
    expect(trace.begin(4)).toMatchObject({ bytes: 0, atMs: 0, lastMs: 0 });
  });
});
