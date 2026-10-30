// The light client's verified history, and old blocks read from an archive node.
//
// Every block smoldot finalizes is recorded: number, hash, parent and state root. The record
// fills its gaps, and reaches back `historyBlocks`, from the archive node: each header there has
// to hash to what its child names, down from a recorded block, so the record stays as verified
// as what smoldot finalized. With it, a block number finds its hash.
//
// smoldot's peers keep only recent state, and asking them about an old block takes seconds to
// fail. So calls about a block smoldot doesn't hold, or holds but no longer recently, go to the
// archive node. Storage comes with a Merkle proof checked against the block's state root, headers
// are checked against their hash, block bodies against their header's extrinsics root, and the
// rest is passed on marked `unverified`.
import { AT } from './router.js';
import {
  ProofError,
  extrinsicsRoot,
  hash,
  headerHash,
  readProof,
  toHex,
} from './proof.js';

const RECENT = 200; // how many blocks behind the best smoldot's peers still hold the state of
const RECENT_KEPT = 1024; // imported blocks remembered as ones smoldot knows
const BATCH = 50; // headers per archive request while filling: Opentensor's node takes 50 calls a batch
const MAX_CALLS = 8; // archive requests at once
const MAX_WAITING = 256;
const ROOTS_KEPT = 256; // state roots of checked headers outside the record
const MAX_KEYS = 1000;
const MAX_ARCHIVE_BYTES = 8 << 20;
const UNVERIFIED =
  "An archive node's answer, not checked: no proof covers this call";
const UNVERIFIED_NUMBER =
  "An archive node's answer, not checked: older than the light client's verified history";

// Calls answered from what a proof or a hash settles.
const PROVEN = new Set([
  'state_getStorage',
  'state_getStorageAt',
  'state_getStorageHash',
  'state_getStorageHashAt',
  'state_queryStorageAt',
  'chain_getHeader',
  'chain_getBlock',
]);
const isHash = (value) =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const number = (header) => parseInt(header.number, 16);

export class ArchiveError extends Error {}

// The record, in the Durable Object's SQLite.
export function sqlStore(sql) {
  sql
    .exec(
      'CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, parent_hash TEXT NOT NULL, state_root TEXT NOT NULL)',
    )
    .toArray();
  const one = (query, ...args) => sql.exec(query, ...args).toArray()[0];
  return {
    byHash: (h) => one('SELECT * FROM blocks WHERE hash = ?', h),
    byNumber: (n) => one('SELECT * FROM blocks WHERE number = ?', n),
    lowest: () => one('SELECT * FROM blocks ORDER BY number LIMIT 1'),
    highest: () => one('SELECT * FROM blocks ORDER BY number DESC LIMIT 1'),
    below: (n) =>
      one(
        'SELECT * FROM blocks WHERE number < ? ORDER BY number DESC LIMIT 1',
        n,
      ),
    // The newest recorded block whose parent isn't recorded, above the lowest: a gap's top.
    gapTop: () =>
      one(
        'SELECT b.* FROM blocks b WHERE b.number > (SELECT MIN(number) FROM blocks) AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.number = b.number - 1) ORDER BY b.number DESC LIMIT 1',
      ),
    put(rows) {
      for (const r of rows)
        sql
          .exec(
            'INSERT OR REPLACE INTO blocks (number, hash, parent_hash, state_root) VALUES (?, ?, ?, ?)',
            r.number,
            r.hash,
            r.parent_hash,
            r.state_root,
          )
          .toArray();
    },
  };
}

// An archive node over JSON-RPC on HTTP.
export function archiveNode(
  url,
  fetcher = (input, init) => fetch(input, init),
) {
  let next = 0;
  async function post(body) {
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ArchiveError('The archive node did not answer');
    }
    if (!response.ok)
      throw new ArchiveError(
        `The archive node answered HTTP ${response.status}`,
      );
    const text = await response.text();
    if (text.length > MAX_ARCHIVE_BYTES)
      throw new ArchiveError("The archive node's answer is too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new ArchiveError("The archive node's answer isn't JSON");
    }
  }
  return {
    async call(method, params) {
      const reply = await post({ jsonrpc: '2.0', id: ++next, method, params });
      if (reply?.error)
        throw new ArchiveError(
          `The archive node refused: ${reply.error.message ?? reply.error.code}`,
        );
      return reply?.result ?? null;
    },
    async batch(calls) {
      const replies = await post(
        calls.map(([method, params], id) => ({
          jsonrpc: '2.0',
          id,
          method,
          params,
        })),
      );
      if (!Array.isArray(replies))
        throw new ArchiveError(
          replies?.error
            ? `The archive node refused: ${replies.error.message ?? replies.error.code}${replies.error.data ? ` (${replies.error.data})` : ''}`
            : "The archive node's batch answer isn't a list",
        );
      const byId = new Map(replies.map((r) => [r?.id, r?.result ?? null]));
      return calls.map((_, id) => byId.get(id) ?? null);
    },
  };
}

export class History {
  #store;
  #archive;
  #historyBlocks;
  #recent = new Map(); // hash -> number, for blocks smoldot imported
  #best = 0;
  #roots = new Map(); // hash -> state root, for checked headers outside the record
  #calls = 0;
  #waiting = [];

  constructor({ store, archive = null, historyBlocks = 7 * 7200 }) {
    this.#store = store;
    this.#archive = archive;
    this.#historyBlocks = historyBlocks;
  }

  // A block smoldot imported: one it knows.
  imported(header) {
    const n = number(header);
    const h = headerHash(header);
    this.#recent.delete(h);
    this.#recent.set(h, n);
    if (this.#recent.size > RECENT_KEPT)
      this.#recent.delete(this.#recent.keys().next().value);
    if (n > this.#best) this.#best = n;
  }

  // A block smoldot finalized: recorded.
  finalized(header) {
    this.#store.put([
      {
        number: number(header),
        hash: headerHash(header),
        parent_hash: header.parentHash,
        state_root: header.stateRoot,
      },
    ]);
    this.imported(header);
  }

  // After a restart smoldot no longer knows the blocks it hadn't finalized.
  restarted() {
    this.#recent.clear();
    this.#best = 0;
  }

  proves(method) {
    return PROVEN.has(method);
  }

  // Who answers a call about one block: smoldot for a block it holds and recently, the archive
  // node for the rest.
  route(method, params) {
    if (!this.#archive || !AT.has(method) || !Array.isArray(params))
      return 'smoldot';
    const at = params[AT.get(method)];
    if (!isHash(at)) return 'smoldot';
    const n = this.#recent.get(at);
    return n !== undefined && n >= this.#best - RECENT ? 'smoldot' : 'archive';
  }

  // A block number's hash: from the record, verified; older than the record, from the archive
  // node, unverified. Null when the number isn't finalized yet, for smoldot to answer.
  async blockHash(n) {
    if (!Number.isSafeInteger(n) || n < 0) return null;
    const row = this.#store.byNumber(n);
    if (row) return { result: row.hash };
    const highest = this.#store.highest();
    if (!highest || n > highest.number || !this.#archive) return null;
    return this.#guarded(async () => ({
      result: await this.#call('chain_getBlockHash', [n]),
      unverified: UNVERIFIED_NUMBER,
    }));
  }

  // The archive node's answer to a call about one block, checked where a proof or a hash can.
  // Null when it doesn't know the block.
  answer(method, params) {
    if (!this.#archive) return Promise.resolve(null);
    return this.#guarded(async () => {
      const at = params[AT.get(method)];
      if (method === 'chain_getHeader') {
        const header = await this.#header(at);
        return header && { result: header };
      }
      if (method === 'chain_getBlock') return this.#block(at);
      if (!PROVEN.has(method)) {
        const result = await this.#call(method, params);
        return { result, unverified: UNVERIFIED };
      }
      const keys = method === 'state_queryStorageAt' ? params[0] : [params[0]];
      if (
        !Array.isArray(keys) ||
        keys.length === 0 ||
        keys.length > MAX_KEYS ||
        !keys.every(
          (k) => typeof k === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(k),
        )
      )
        return { error: { code: -32602, message: 'Invalid storage keys' } };
      const root = await this.#stateRoot(at);
      if (!root) return null;
      const reply = await this.#call('state_getReadProof', [keys, at]);
      const values = keys.map((key) =>
        readProof(root, key, reply?.proof ?? []),
      );
      const value = values[0] && toHex(values[0]);
      if (method === 'state_queryStorageAt')
        return {
          result: [
            {
              block: at,
              changes: keys.map((key, i) => [
                key,
                values[i] && toHex(values[i]),
              ]),
            },
          ],
        };
      if (method.startsWith('state_getStorageHash'))
        return { result: values[0] && hash(values[0]) };
      return { result: value };
    });
  }

  // How far the record reaches.
  status() {
    return {
      from: this.#store.lowest()?.number ?? null,
      to: this.#store.highest()?.number ?? null,
    };
  }

  // Fills the record from the archive node, newest gap first, then back to `historyBlocks`
  // below the newest block, at most `budget` blocks. Returns how many it recorded.
  async fill(budget = 1000) {
    let filled = 0;
    while (this.#archive && filled < budget) {
      const highest = this.#store.highest();
      if (!highest) break;
      const lowest = this.#store.lowest();
      const top = this.#store.gapTop() ?? lowest;
      const below =
        top.number === lowest.number ? null : this.#store.below(top.number);
      const floor = below
        ? below.number + 1
        : Math.max(0, highest.number - this.#historyBlocks);
      const high = top.number - 1;
      const low = Math.max(floor, high - Math.min(BATCH, budget - filled) + 1);
      if (high < low) break;
      const numbers = [];
      for (let n = high; n >= low; n--) numbers.push(n);
      const hashes = await this.#archive.batch(
        numbers.map((n) => ['chain_getBlockHash', [n]]),
      );
      const headers = await this.#archive.batch(
        hashes.map((h) => ['chain_getHeader', [h]]),
      );
      // Down from the recorded block: each header must hash to the parent its child names.
      const rows = [];
      let expected = top.parent_hash;
      for (const [i, n] of numbers.entries()) {
        const header = headers[i];
        let ok = false;
        try {
          ok =
            !!header && number(header) === n && headerHash(header) === expected;
        } catch {} // a header that doesn't decode doesn't match
        if (!ok) {
          this.#store.put(rows);
          console.warn(
            `The archive node's block #${n} isn't the one the light client verified; filling stopped`,
          );
          return filled + rows.length;
        }
        rows.push({
          number: n,
          hash: expected,
          parent_hash: header.parentHash,
          state_root: header.stateRoot,
        });
        expected = header.parentHash;
      }
      this.#store.put(rows);
      filled += rows.length;
      if (below && low === below.number + 1 && expected !== below.hash) {
        console.error(
          `Recorded block #${below.number} isn't the parent of #${low}: the record is inconsistent`,
        );
        break;
      }
    }
    return filled;
  }

  async #header(at) {
    const header = await this.#call('chain_getHeader', [at]);
    if (!header) return null;
    if (headerHash(header) !== at)
      throw new ProofError("The header doesn't hash to the block's hash");
    return header;
  }

  // A block whose header hashes to its hash and whose extrinsics make the header's extrinsics
  // root. Finney's runtime builds that root as state version 0 (its Core API is older than 5);
  // version 1 is taken too, for when it moves on. Either way only the real extrinsics make it.
  // The justifications that come with a block aren't checked, so they aren't passed on.
  async #block(at) {
    const block = (await this.#call('chain_getBlock', [at]))?.block;
    if (!block) return null;
    if (headerHash(block.header) !== at)
      throw new ProofError(
        "The block's header doesn't hash to the block's hash",
      );
    const { extrinsics } = block;
    if (
      !Array.isArray(extrinsics) ||
      ![0, 1].some(
        (version) =>
          extrinsicsRoot(extrinsics, version) === block.header.extrinsicsRoot,
      )
    )
      throw new ProofError(
        "The block's extrinsics don't make its header's extrinsics root",
      );
    return {
      result: {
        block: { header: block.header, extrinsics },
        justifications: null,
      },
    };
  }

  async #stateRoot(at) {
    const row = this.#store.byHash(at);
    if (row) return row.state_root;
    const known = this.#roots.get(at);
    if (known) return known;
    const header = await this.#header(at);
    if (!header) return null;
    this.#roots.set(at, header.stateRoot);
    if (this.#roots.size > ROOTS_KEPT)
      this.#roots.delete(this.#roots.keys().next().value);
    return header.stateRoot;
  }

  // Archive failures and proofs that don't check out become JSON-RPC errors.
  async #guarded(run) {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof ProofError)
        return {
          error: {
            code: -32000,
            message: `The archive node's answer didn't check out: ${cause.message}`,
          },
        };
      if (cause instanceof ArchiveError)
        return { error: { code: -32000, message: cause.message } };
      throw cause;
    }
  }

  async #call(method, params) {
    if (this.#calls < MAX_CALLS) this.#calls++;
    else if (this.#waiting.length >= MAX_WAITING)
      throw new ArchiveError('The archive node is busy: retry shortly');
    else await new Promise((resolve) => this.#waiting.push(resolve)); // a finished call hands over its place
    try {
      return await this.#archive.call(method, params);
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#calls--;
    }
  }
}
