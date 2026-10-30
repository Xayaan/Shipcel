# bittensor-light-client

A Bittensor (Finney) light client that runs on Cloudflare. [smoldot](https://github.com/paritytech/smoldot) runs inside one Durable Object. It connects to Finney's peers itself, follows finality with GRANDPA proofs from its checkpoint on, and checks each new header's Aura seal. It answers JSON-RPC over WebSocket, subscriptions included: only over WebSocket, the cheapest way on Cloudflare. Storage reads are checked against a verified block's state root. Runtime API calls, such as a subnet's neurons, run in smoldot on proofs of the storage they read. No RPC provider sits between you and the chain. Old blocks come from an archive node, checked the same way wherever a proof can settle them, and answers about a block are kept, so asking again costs nothing ("Old blocks" and "Answers kept", below).

**On Cloudflare: not running yet.** Deployed on 23 October 2026, its Durable Object went over Cloudflare's 128 MB memory limit within seconds of each start, and Cloudflare reset it, again and again. So did a build with seven smoldot patches on 24 October: measured locally, it started at 31–33 MiB, around the 32 MiB step where V8 begins counting it as 64. An eighth patch brings the start to 25 MiB, and the first runtime calls take it to 37.6 MiB (`smoldot/README.md`; "Memory", under Limits). The object now records its memory across Cloudflare's resets, so the next deploy shows where Cloudflare draws the line.

It needs **Workers Paid** ($5 a month). A Durable Object on Workers Free has 10 ms of CPU per request, and verifying blocks takes more. For one person's use, the $5 is all it costs. Kept in memory all month, the object uses about 330,000 of the 400,000 GB-seconds of Durable Object time that Workers Paid includes; other Durable Objects in the account share the rest. The heartbeat (every 30 seconds) and the cron (every minute) take about 130,000 of the 1 million included Durable Object requests. That leaves about 17 million WebSocket messages a month before each further million costs about $0.0075. Cloudflare counts 20 incoming messages as one request, and answers and notifications cost nothing. Over HTTP, each call would count as a Worker request and a Durable Object request, so the light client answers JSON-RPC over WebSocket only. The record of verified blocks adds about 7,200 rows to the Durable Object's SQLite a day (about 1.5 MB), inside what Workers Paid includes, and filling a week of it asks the archive node about 2,000 times, once.

## Deploy

Copy it out of the Shipcel folder first (Shipcel's own dev server watches that folder), then deploy it from its own folder:

```sh
cp -R examples/bittensor-light-client ~/bittensor-light-client
cd ~/bittensor-light-client
shipcel deploy --prod
node scripts/check.mjs https://bittensor-light-client.<your-subdomain>.workers.dev
```

`shipcel` installs the one dependency (`smoldot` 3.7.0) and deploys with Wrangler. The first request starts the light client, which warp-syncs from its checkpoint to Finney's finalized block (within 5 seconds when run locally). `scripts/check.mjs` compares the light client's answers with a full node's at the same block, byte for byte, and follows two finalized heads over WebSocket.

Open the address in a browser to see the blocks it verifies. Use it as a Finney endpoint:

```sh
wss://bittensor-light-client.<your-subdomain>.workers.dev/        # JSON-RPC, batches of up to 100
https://bittensor-light-client.<your-subdomain>.workers.dev/       # the page
https://bittensor-light-client.<your-subdomain>.workers.dev/status
```

## Keep it to yourself

Anyone who finds the address can use it, and their requests count toward your bill. To keep it to yourself, give it a key: make one, then set it as the app's `RPC_KEY` secret from the app's folder (Shipcel deploys it with the current code):

```sh
openssl rand -hex 24
shipcel env add RPC_KEY
```

From then on the key goes right after the host, and any other address is refused with 401 by the Worker, before it reaches the Durable Object. A stranger's requests then count only toward the 10 million Worker requests Workers Paid includes.

```sh
wss://bittensor-light-client.<your-subdomain>.workers.dev/<key>       # JSON-RPC
https://bittensor-light-client.<your-subdomain>.workers.dev/<key>      # the page
node scripts/check.mjs https://bittensor-light-client.<your-subdomain>.workers.dev/<key>
```

The page and `/status` move under it too. Treat the address like a password: it shows in your own Workers Logs. `shipcel env update RPC_KEY` changes the key, and `shipcel env rm RPC_KEY` opens the light client to everyone again.

With a key or without, each caller (an IP address, or an IPv6 /64) may make 20 calls a second and up to 200 at once, and a batch counts each call in it. Beyond that, a call is answered with the JSON-RPC error -32005, and a new WebSocket with 429 and `Retry-After`. One address may hold 8 WebSockets at once. Both limits are at the top of `src/index.js`.

## Old blocks

smoldot's peers keep only recent state, and asking them about an old block takes seconds to fail. So the light client keeps a record of the blocks it verified, and asks an archive node about the rest: Opentensor's public one, unless `ARCHIVE_URL` names another.

- **The record.** Every block smoldot finalizes goes into the Durable Object's SQLite: its number, hash, parent and state root. Each alarm fills any gaps and reaches back `HISTORY_DAYS` (7 by default, 50,400 blocks), 1,000 blocks at a time, from the archive node. Each header from it has to hash to the hash its child names, down from a recorded block, so the record is as verified as what smoldot finalized. `chain_getBlockHash` answers from it: smoldot itself knows only its best block's hash.
- **Checked:** storage at an old block (`state_getStorage`, `state_getStorageHash` and `state_queryStorageAt`, and their `…At` names) comes with a Merkle proof from the archive node, checked against the block's state root. The root comes from the record, or from a header checked against the block's hash. Old headers (`chain_getHeader`) are checked against their hash too.
- **Old blocks (`chain_getBlock`)** are checked whole. The header has to hash to the block's hash, and the extrinsics have to rebuild the root the header names: the trie of the extrinsics, each under its index. Finney's runtime builds that trie as state version 0, its Core API being older than 5. Version 1 is taken too, for when that changes. Only the real extrinsics make the root either way. A block's justifications aren't checked, so they come back as `null`.
- **Marked, not checked:** what no proof covers, at blocks more than 200 behind the best. That means runtime calls (`state_call`, such as a subnet's neurons), `state_getMetadata`, `state_getRuntimeVersion`, `state_getKeysPaged`, and block numbers older than the record. Their answers carry `"unverified"` next to `result`, saying why; for them, the archive node's word is all there is.
- **Refused:** a proof or a header that doesn't check out is answered with an error, never passed on.

Set `ARCHIVE_URL` or `HISTORY_DAYS` with `shipcel env add`. `ARCHIVE_URL=off` turns the archive node off, and old blocks then go to smoldot, which mostly can't answer them. Filling asks for 50 headers per request, the most Opentensor's node takes at once, and no more than 8 requests to it run at a time.

## Answers kept

An answer about one block never changes, so the light client keeps it. The same call about the same block is answered from memory, in 2 to 8 ms locally against about 0.5 s, and identical calls arriving together share one answer. A call that names no block is first pinned to the best block, so it's kept until the next one. Up to 4 MB of answers are kept, none over 512 KB, and the least recently used goes first; errors aren't kept. `/status` reports the cache.

## What it trusts

- **The starting point:** the checkpoint in Subtensor's own Finney chain spec (block #8,867,448), and the genesis hash. From there it verifies GRANDPA finality with that block's authorities, each later authority set, each new header's Aura seal, and storage proofs against verified state roots.
- **Finney's validators,** as every light client does: GRANDPA finality holds while two thirds of them are honest. The best block, ahead of finality, is checked only by its Aura seal.
- **Peers, only to be available:** a peer can withhold answers, but can't forge a block, a finality proof or a storage value.
- **The archive node,** for checked answers about old blocks, only to be available. Answers marked `unverified` trust it outright.
- **Its own saved state:** every 10 minutes it saves what it verified (the finalized block, its authorities, the peers it knows) in the Durable Object's storage, and a restart warp-syncs from there.

## How it works

- `src/index.js`: the Worker and the `LightClient` Durable Object. The Worker answers `/` itself: the page, a description of the endpoint, and 405 for JSON-RPC over HTTP, with the WebSocket's address. None of these costs a Durable Object request. The page asks for its status over its WebSocket (`lightclient_status`, what `/status` reports). Everything else goes to one object, which starts smoldot with `src/smoldot.wasm`, the chain spec and the saved state or the checkpoint. An alarm every 30 seconds keeps it in memory. Cloudflare renews a Durable Object's 30 seconds of CPU with each incoming request or WebSocket message, and doesn't say whether an alarm counts. So the cron sends it a request every minute, which also wakes it if it was ever evicted.
- `src/platform.js`: smoldot's connections on Workers. Peers are reached over TCP with Cloudflare's socket API (most Finney nodes listen on TCP 30333) or over WebSocket through `fetch`.
- `src/access.js`: the key, checked by the Worker, and the rate limit, kept by the Durable Object. It sees every request, so its count is exact, and a restart forgives everyone.
- `src/router.js`: one smoldot chain shared by every client. Each request goes in under the router's own ID, so clients' IDs never collide. Notifications go only to the connection that subscribed, and a closed connection's subscriptions are closed. At most 4 runtime calls run at once. Calls no peer could serve are retried twice. Metadata is computed once per runtime version. Answers about one block are kept ("Answers kept"), and calls about old blocks go to the archive node.
- `src/history.js`: the record of verified blocks, the archive node, and what's checked of its answers ("Old blocks").
- `src/proof.js` and `src/blake2b.js`: checking a header against its hash, a storage value against a state root through a Merkle proof of Substrate's storage trie (state versions 0 and 1), and a block's extrinsics against its extrinsics root, by rebuilding their trie. BLAKE2b, the hash they use, isn't in WebCrypto.
- Refused to callers: smoldot's `sudo_*` methods, `system_addReservedPeer` and `system_removeReservedPeer`, which would let anyone point it at any address, and its saved state.
- `src/finney.json` and `src/finney-checkpoint.json`: the chain spec and the checkpoint, made from Subtensor's raw Finney spec by the scripts in `scripts/`.
- `src/memory.js`: smoldot's Wasm memory, recorded in SQLite from the moment each start begins: every 250 ms, on each chunk received from a peer and on each line smoldot logs for the first 20 seconds, then every 2 seconds, until 3 minutes. Each sample also has the bytes received, the connections open and smoldot's last log line. The next start logs how high the previous one went and its last six samples (`[light-client] The previous start reached …`), and `/status` reports them (`previousStart`): Cloudflare loses the logs of the requests it cuts short when it resets an object.
- `smoldot/`: why smoldot is patched (eight small patches: two to follow Finney, a security fix in its zstd decoder, and five that keep its memory down), how `src/smoldot.wasm` is rebuilt reproducibly, and its license.

## Updating the checkpoint

`src/finney-checkpoint.json` comes from the `grandpaWarpSyncCheckpoint` of Subtensor's raw Finney spec. When the spec gets a newer one:

1. Put its block hash and number in `scripts/finney-checkpoint.py`.
2. Run it with the spec and a database the light client saved (for its peers).
3. Check the GRANDPA set it wrote: `node scripts/grandpa-set-check.mjs https://archive.chain.opentensor.ai:443 <checkpoint> <a later multiple of 512>`. The later block's justification must verify with that set.

The script assumes, as at #8,867,448, that the checkpoint block enacts a GRANDPA change without delay.

## Limits

- **Old blocks depend on the archive node.** Some answers about them are only the archive node's word, marked as such ("Old blocks"). Without one (`ARCHIVE_URL=off`), old state mostly can't be read.
- **Large runtime calls can fail.** A call needs one peer to prove all the storage it reads. `DelegateInfoRuntimeApi_get_delegates` failed this way: "Error trying to access the storage required for the runtime call", after 19 seconds.
- **BLS12-381 host functions.** Subtensor's runtime imports some that smoldot lacks (smoldot warns at start). A call that reaches one fails with an error; it can't return a wrong answer.
- **Memory.** Cloudflare gives an isolate 128 MB, counting its JavaScript heap and its WebAssembly allocations. V8 counts smoldot's Wasm memory in steps (32 MiB, then 64, then 128), plus an estimate for smoldot's compiled code. Wasm memory never shrinks, so smoldot's highest point is what counts. Unpatched, a restart from a saved state took smoldot to 57 MiB and the first `state_getMetadata`, which every Bittensor tool asks for, to 75 MiB. V8 counted that as 128 MiB, and Cloudflare reset the object (23 October 2026). Measured with V8's GC trace (`--trace-gc-verbose`) in the local runtime on 24 October:
  - With seven patches, a restart from a saved state, in the order Cloudflare runs it, reached 31–33 MiB, and Cloudflare still reset the object.
  - With eight, it reaches 25 MiB: V8's count of memory outside its heap peaks at 43 MiB, or 80 MiB with smoldot's code compiled up front.
  - The metadata, a subnet's neurons, all subnets' dynamic info and 22 calls at once then take it to 37.6 MiB, which V8 counts as 64: 76.5 MiB, or about 111 MiB compiled up front. Each runtime upgrade adds a second runtime for a while, so smoldot's memory will reach that step anyway.

  The JavaScript heap adds 5–10 MiB. Saving the state and filling the record wait until smoldot has run 2 minutes, so they don't add to its start. `/status` reports the Wasm memory and the previous start's peak, and the object logs each new high (`[light-client] Wasm memory: …`).

- **WebSocket only.** JSON-RPC over HTTP gets 405 and the WebSocket's address. Bittensor's own tools connect over WebSocket, but that the Python SDK and polkadot.js work against this light client hasn't been checked.
- **A connection holds at most 64 subscriptions.**
- **Each caller's share:** 20 calls a second, 200 at once, 8 WebSockets ("Keep it to yourself").
- **One object, one place.** Requests from far away travel to where the Durable Object runs.

## Evidence

On Cloudflare (Workers Paid), it didn't run: Cloudflare reset the Durable Object for going over its memory limit, every time it started, unpatched (23 October 2026) and with seven patches (24 October). Its logs showed each start reset 12 to 25 seconds in ("Memory", under Limits). The eight-patch build hasn't run there yet.

With the eight patches, the same way on 24 October 2026 (Linux, live Finney): `scripts/check.mjs` passed every check, each answer identical to a full node's (`System.Number`, `Timestamp.Now`, the runtime version, subnet 1's hyperparameters and neurons, all subnets' dynamic info, the metadata), and 22 runtime calls at once all succeeded, in 2.2 s. The first metadata request took 0.5–1.6 s instead of about 3.

What follows ran locally, with `wrangler dev` (workerd) on 22 October 2026. From the checkpoint it warp-synced to Finney's finalized block (#9,334,180) within 5 seconds of the first request, then followed finality block by block. These answers were identical to a full node's at the same finalized block: `System.Number`, `Timestamp.Now`, `state_getRuntimeVersion` (but for the full node's newer `systemVersion` field, which smoldot doesn't return), `state_getMetadata`, `SubnetInfoRuntimeApi_get_subnet_hyperparams`, `NeuronInfoRuntimeApi_get_neurons_lite` (subnet 1: 47 KB in 3.4 s) and `SubnetInfoRuntimeApi_get_all_dynamic_info` (53 KB in 1.2 s). `state_getMetadata` (364 KB) took under a second, 24 concurrent metadata requests all succeeded, and so did 12 concurrent neuron queries (6 s). Over WebSocket, `chain_subscribeFinalizedHeads` and `chainHead_v1_follow` delivered every block, and a second connection couldn't close the first one's subscription. A restart resumed from the saved state and caught up in under 30 seconds. Finney upgraded its runtime during the session (spec 481 to 482), and the light client followed: the new metadata (367,676 bytes) matched the full node's.
The key and the rate limit, the same way on 22 October (Linux, live Finney, finalized #9,337,926 within seconds of the first request):

- **The key.** Without it, or with a wrong one, the Worker answered 401, and `/heartbeat` was refused from outside.
- **The rate limit.** Three batches of 100 calls in a row got 200, 200, then 429 with `Retry-After: 5`. From one address, 8 WebSockets opened and a ninth was refused; closing them made room again. Over a WebSocket, batches beyond the allowance got -32005 while a single call still went through.
- **End to end.** `scripts/check.mjs` passed every check through the keyed address, and the page under `/<key>` showed verified blocks over its WebSocket. Without a key, the same build answered at `/` as before.

WebSocket only, the same way later on 22 October:

- **HTTP refused.** A JSON-RPC call over HTTP got 405 from the Worker, with the WebSocket's address, with and without a key.
- **End to end over WebSocket.** `scripts/check.mjs` passed every check through the keyed address. Storage reads took about 0.5 s, subnet 1's neurons 1.5 s and the metadata 0.4 s.
- **The page** took its status over its WebSocket, with no requests to `/status`, and Wasm memory reached 81 MB.

Old blocks and the cache, the same way later on 22 October, against Opentensor's public archive node:

- **Checked answers matched the archive node.** `state_getStorage` at block #9,000,000 took 407 ms; asked again, 8 ms from the cache. `state_queryStorageAt` (two keys) and `chain_getHeader` matched too.
- **The unchecked ones were marked.** `chain_getBlockHash(9000000)`, from before the record, and a `state_call` at #9,000,000 both came back marked `unverified`.
- **The record.** It filled 2,572 blocks in its first 50 seconds. 20 block numbers spread across it gave the archive node's hashes, unmarked. A read at a recorded block from earlier that run took 225 ms.
- **Latest storage reads:** 544 ms, then 2 ms from the cache within the same block.
- **End to end.** `scripts/check.mjs` passed every check.
- **What it found:** Opentensor's node takes at most 50 calls per batch, so filling asks for 50 at a time.
- **smoldot alone, as probed that day:** it fetched block #9,000,000 from a peer once (an archive peer happened to be connected), then failed. At #5,000,000, #1,000,000 and #10 it couldn't fetch even the header, failing after 4 to 9 seconds. It returns `null` for `chain_getBlockHash` of any block but its best.

Block bodies, the same way later on 22 October:

- **Old blocks matched the archive node.** `chain_getBlock` at #9,000,000 (25 extrinsics) took 1.5 s and at #9,339,090 (139 extrinsics) 0.8 s, both checked. Headers and extrinsics were identical to the archive node's, and asking again took 2 to 5 ms.
- **Recent blocks** came from smoldot (15 extrinsics, 443 ms).
- **What it found:** Finney builds its extrinsics root as state version 0, with each extrinsic exactly as JSON-RPC gives it (length included). All three blocks tried matched only that way. A real proof also kept a 32-byte value inline and 56-byte ones by hash, which fits Substrate's cut-off of 33 bytes for version 1.
