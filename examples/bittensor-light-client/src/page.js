// What a browser sees at /: the blocks this light client has verified, live over its own
// WebSocket JSON-RPC, and how to connect to it.
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bittensor light client</title>
<style>
  :root { --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e3de; --accent: #0f766e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141413; --card: #1f1f1d; --text: #ecece8; --muted: #9a9a93; --line: #33332f; --accent: #5eead4; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 32px 0 8px; }
  p { margin: 0 0 12px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .label { font-size: .8rem; color: var(--muted); }
  .value { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
  .accent { color: var(--accent); }
  code, pre { font: .85rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; overflow-x: auto; margin: 0; }
  ol { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  li { display: flex; gap: 12px; justify-content: space-between; padding: 8px 14px; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  li:first-child { border-top: 0; }
  li code { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<main>
  <h1>Bittensor light client</h1>
  <p>Finney, verified here: smoldot runs in a Cloudflare Durable Object, talks to Finney's peers itself, follows finality with GRANDPA proofs, checks each new header's Aura seal, and answers JSON-RPC.</p>
  <div class="grid" aria-live="polite">
    <div class="card"><div class="label">Finalized</div><div class="value accent" id="finalized">…</div></div>
    <div class="card"><div class="label">Best</div><div class="value" id="best">…</div></div>
    <div class="card"><div class="label">Peers</div><div class="value" id="peers">…</div></div>
    <div class="card"><div class="label">Running for</div><div class="value" id="uptime">…</div></div>
    <div class="card"><div class="label">Verified history</div><div class="value" id="history">…</div></div>
  </div>
  <h2>Finalized blocks, as they are verified</h2>
  <ol id="blocks"><li><span>Waiting for the next one…</span></li></ol>
  <h2>Connect</h2>
  <p>JSON-RPC over WebSocket, subscriptions included, at this address:</p>
  <pre id="ws"></pre>
  <p style="margin-top:12px">For example:</p>
  <pre id="example"></pre>
  <p style="margin-top:12px"><a id="status-link" href="/status">/status</a> reports the same as JSON: <span id="started"></span></p>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  // With a key, this page is at /<key>, and every other address is under it.
  const base = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) : location.pathname;
  const wsUrl = location.origin.replace(/^http/, 'ws') + base + '/';
  $('ws').textContent = wsUrl;
  $('status-link').href = base + '/status';
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getFinalizedHead', params: [] });
  $('example').textContent = 'npx wscat -c ' + wsUrl + '\\n> ' + body;
  const blocks = [];
  function finalized(header) {
    const number = parseInt(header.number, 16);
    $('finalized').textContent = '#' + number.toLocaleString('en');
    if (blocks[0]?.number === number) return;
    blocks.unshift({ number, at: new Date(), parent: header.parentHash });
    blocks.length = Math.min(blocks.length, 8);
    $('blocks').replaceChildren(...blocks.map((block) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = '#' + block.number.toLocaleString('en') + '  ' + block.at.toLocaleTimeString();
      const right = document.createElement('code');
      right.textContent = 'parent ' + block.parent.slice(0, 18) + '…';
      li.append(left, right);
      return li;
    }));
  }
  let delay = 1000;
  let socket = null;
  function connect() {
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      delay = 1000;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_subscribeFinalizedHeads', params: [] }));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chain_subscribeNewHeads', params: [] }));
      status();
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'chain_finalizedHead') finalized(message.params.result);
      if (message.method === 'chain_newHead') $('best').textContent = '#' + parseInt(message.params.result.number, 16).toLocaleString('en');
      if (message.id === 'status' && message.result) showStatus(message.result);
    };
    socket.onclose = () => setTimeout(connect, (delay = Math.min(delay * 2, 30000)));
  }
  // What /status reports, asked over the same WebSocket: 20 messages cost what one request does.
  function status() {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'status', method: 'lightclient_status', params: [] }));
  }
  function showStatus(s) {
    $('peers').textContent = s.peers ?? '…';
    const m = Math.floor(s.uptimeSeconds / 60);
    $('uptime').textContent = m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
    $('started').textContent = 'started from the ' + s.startedFrom + ', ' + Math.round(s.wasmMemoryBytes / 1e6) + ' MB of Wasm memory.';
    // Block hashes recorded since, at 12 seconds a block; older blocks come from an archive node.
    if (s.history?.from != null) {
      const hours = ((s.history.to - s.history.from + 1) * 12) / 3600;
      $('history').textContent = hours < 48 ? hours.toFixed(1) + ' h' : (hours / 24).toFixed(1) + ' days';
      $('history').title = '#' + s.history.from.toLocaleString('en') + ' to #' + s.history.to.toLocaleString('en');
    }
  }
  connect();
  setInterval(status, 15000);
</script>
</body>
</html>
`;
