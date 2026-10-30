// Checks a running light client: its status, Finney reads compared byte for byte with a full node
// at the same finalized block, and a WebSocket subscription to finalized heads.
// Usage: node scripts/check.mjs <light client address> [full node address]
// The full node defaults to Opentensor's public Finney entrypoint. With a key, the light
// client's address is https://<host>/<key>.
const [address, fullNode = 'https://entrypoint-finney.opentensor.ai:443'] =
  process.argv.slice(2);
if (!address) {
  console.error(
    'Usage: node scripts/check.mjs <light client address> [full node address]',
  );
  process.exit(2);
}
// Every other address is under it: /status, and the WebSocket.
const base = new URL(address.endsWith('/') ? address : `${address}/`);
let failures = 0;
const report = (ok, line) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`);
};

let nextId = 0;
// The full node, over HTTP.
async function call(url, method, params = []) {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  return { ...(await response.json()), ms: Date.now() - started };
}

// The light client, over its WebSocket: the only way it answers JSON-RPC.
const socket = new WebSocket(base.href.replace(/^http/, 'ws'));
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error(`No WebSocket at ${base.href}`));
});
const waiting = new Map(); // request ID -> resolve
const heads = []; // finalized block numbers, once subscribed
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'chain_finalizedHead')
    heads.push(parseInt(message.params.result.number, 16));
  waiting.get(message.id)?.(message);
  waiting.delete(message.id);
};
function light(method, params = []) {
  const started = Date.now();
  const id = ++nextId;
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ error: { message: 'no answer in 60 s' }, ms: 60_000 }),
      60_000,
    );
    waiting.set(id, (answer) => {
      clearTimeout(timer);
      resolve({ ...answer, ms: Date.now() - started });
    });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

const status = await (await fetch(new URL('status', base))).json();
report(
  status.finalized && status.syncing === false,
  `status: finalized #${status.finalized?.number}, best #${status.best?.number}, ${status.peers} peers, ` +
    `started from the ${status.startedFrom} ${status.uptimeSeconds} s ago, ${Math.round(status.wasmMemoryBytes / 1e6)} MB of Wasm memory`,
);

const overHttp = await fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'system_health' }),
});
report(
  overHttp.status === 405,
  `JSON-RPC over HTTP is refused (${overHttp.status}), for the WebSocket`,
);

// Compares JSON values whatever the order of their keys.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

// Reads at the light client's finalized block; the full node must still have its state.
const at = status.finalized.hash;
const reads = [
  [
    'System.Number',
    'state_getStorage',
    ['0x26aa394eea5630e07c48ae0c9558cef702a5c1b19ab7a04f536c519aca4983ac', at],
  ],
  [
    'Timestamp.Now',
    'state_getStorage',
    ['0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb', at],
  ],
  // smoldot's runtime version lacks the full node's newer systemVersion field.
  [
    'runtime version',
    'state_getRuntimeVersion',
    [at],
    ({ systemVersion, ...rest }) => rest,
  ],
  [
    'subnet 1 hyperparameters',
    'state_call',
    ['SubnetInfoRuntimeApi_get_subnet_hyperparams', '0x0100', at],
  ],
  [
    'subnet 1 neurons (lite)',
    'state_call',
    ['NeuronInfoRuntimeApi_get_neurons_lite', '0x0100', at],
  ],
  [
    'all subnets (dynamic info)',
    'state_call',
    ['SubnetInfoRuntimeApi_get_all_dynamic_info', '0x', at],
  ],
  ['metadata', 'state_getMetadata', [at]],
];
for (const [name, method, params, comparable = (result) => result] of reads) {
  const [ours, full] = await Promise.all([
    light(method, params),
    call(fullNode, method, params),
  ]);
  const size =
    typeof ours.result === 'string'
      ? `${(ours.result.length - 2) / 2} bytes`
      : 'object';
  if (ours.error)
    report(false, `${name}: ${ours.error.message} (${ours.ms} ms)`);
  else if (full.error)
    report(
      true,
      `${name}: ${size} in ${ours.ms} ms (the full node refused: ${full.error.message})`,
    );
  else {
    const same =
      JSON.stringify(canonical(ours.result)) ===
      JSON.stringify(canonical(comparable(full.result)));
    report(
      same,
      `${name}: ${size} in ${ours.ms} ms, ${same ? 'identical to' : 'DIFFERENT from'} the full node`,
    );
  }
}

const refused = await light('sudo_unstable_p2pDiscover', [
  '/ip4/192.0.2.1/tcp/30333',
]);
report(
  refused.error?.code === -32601,
  'operator methods are refused to callers',
);

// Two finalized heads on the same WebSocket: Finney finalizes about every 12 seconds.
await light('chain_subscribeFinalizedHeads');
const until = Date.now() + 60_000;
while (heads.length < 2 && Date.now() < until)
  await new Promise((resolve) => setTimeout(resolve, 500));
socket.close();
report(
  heads.length >= 2 && heads[1] > heads[0],
  `WebSocket: finalized heads ${
    heads
      .slice(0, 2)
      .map((n) => `#${n}`)
      .join(', ') || 'none in 60 s'
  }`,
);

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
