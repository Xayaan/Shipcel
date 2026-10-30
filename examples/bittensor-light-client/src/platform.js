// smoldot's platform on Cloudflare Workers: peers over TCP through Cloudflare's socket API (most
// Finney nodes listen on plain TCP 30333) or over WebSocket through fetch's upgrade. There is no
// WebRTC. smoldot calls connect() from inside its own Wasm execution, so nothing here may throw
// at it or call back into it synchronously: every outcome reaches it from a later task.
// `connect` is cloudflare:sockets' connect(), passed in so this file also runs outside Workers.
// `stats()` reports the bytes received from peers and the connections open, and `onActivity` is
// called after each chunk received, for the memory trace (src/memory.js).
export function workersPlatform({
  connect,
  fetch = globalThis.fetch,
  onActivity = () => {},
}) {
  const stats = { received: 0, open: 0 };
  return {
    performanceNow: () => performance.now(),
    getRandomValues: (buffer) => crypto.getRandomValues(buffer),
    connect: (config) => {
      stats.open++;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        stats.open--;
      };
      const counted = {
        ...config,
        onMessage: (message, ...rest) => {
          stats.received += message.byteLength;
          config.onMessage(message, ...rest);
          onActivity();
        },
        onConnectionReset: (message) => {
          end();
          config.onConnectionReset(message);
        },
      };
      const connection =
        config.address.ty === 'tcp'
          ? tcp(connect, counted)
          : webSocket(fetch, counted);
      return {
        ...connection,
        reset: () => {
          end();
          connection.reset();
        },
      };
    },
    stats: () => ({ ...stats }),
  };
}

const describe = (cause) =>
  cause instanceof Error ? cause.message : String(cause);

// The callbacks smoldot gave for one connection, silenced once it is reset from either side.
function callbacks(config) {
  let open = true;
  const guard =
    (callback) =>
    (...args) => {
      if (!open) return;
      try {
        callback(...args);
      } catch {} // smoldot itself has stopped
    };
  return {
    get open() {
      return open;
    },
    writable: guard(config.onWritableBytes),
    message: guard(config.onMessage),
    reset: (message) => {
      if (!open) return;
      open = false;
      try {
        config.onConnectionReset(message);
      } catch {}
    },
    close: () => {
      open = false;
    },
  };
}

const later = (callback) => setTimeout(callback, 0);
const unusable = { send() {}, closeSend() {}, openOutSubstream() {} };

function tcp(connect, config) {
  const events = callbacks(config);
  const { hostname, port } = config.address;
  let socket;
  try {
    socket = connect(
      { hostname: hostname.includes(':') ? `[${hostname}]` : hostname, port },
      { allowHalfOpen: true },
    );
  } catch (cause) {
    later(() => events.reset(describe(cause)));
    return { ...unusable, reset: events.close };
  }
  const writer = socket.writable.getWriter();
  socket.closed.catch(() => {});
  socket.opened.then(
    () => events.writable(1024 * 1024),
    (cause) => events.reset(describe(cause)),
  );
  (async () => {
    const reader = socket.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return events.reset('EOF when reading socket');
      if (value.byteLength) events.message(value);
    }
  })().catch((cause) => events.reset(describe(cause)));
  return {
    reset() {
      events.close();
      socket.close().catch(() => {});
    },
    // smoldot's buffers are already copies out of its memory.
    send(buffers) {
      for (const buffer of buffers)
        writer.write(buffer).then(
          () => events.writable(buffer.byteLength),
          (cause) => events.reset(describe(cause)),
        );
    },
    closeSend() {
      writer.close().catch(() => {});
    },
    openOutSubstream() {
      throw new Error('Wrong connection type');
    },
  };
}

function webSocket(fetch, config) {
  const events = callbacks(config);
  let socket = null;
  const opening = fetch(config.address.url.replace(/^ws/, 'http'), {
    headers: { Upgrade: 'websocket' },
  }).then((response) => {
    if (!response.webSocket)
      throw new Error(`HTTP ${response.status} instead of a WebSocket`);
    socket = response.webSocket;
    socket.binaryType = 'arraybuffer';
    socket.accept();
    if (!events.open) return socket.close();
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string')
        events.message(new Uint8Array(event.data));
    });
    socket.addEventListener('close', (event) =>
      events.reset(
        `Error code ${event.code}${event.reason ? `: ${event.reason}` : ''}`,
      ),
    );
    socket.addEventListener('error', () => events.reset('WebSocket error'));
    events.writable(1024 * 1024);
  });
  opening.catch((cause) => events.reset(describe(cause)));
  return {
    reset() {
      events.close();
      opening.then(
        () => socket?.close(),
        () => {},
      );
    },
    // A Workers WebSocket queues what it is given and has no bufferedAmount, so the bytes are
    // reported writable again once they are handed over.
    send(buffers) {
      let total = 0;
      for (const buffer of buffers) total += buffer.byteLength;
      try {
        socket.send(buffers.length === 1 ? buffers[0] : concat(buffers, total));
      } catch (cause) {
        return later(() => events.reset(describe(cause)));
      }
      later(() => events.writable(total));
    },
    closeSend() {
      throw new Error('Wrong connection type');
    },
    openOutSubstream() {
      throw new Error('Wrong connection type');
    },
  };
}

function concat(buffers, total) {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    joined.set(buffer, offset);
    offset += buffer.byteLength;
  }
  return joined;
}
