// Checks what an archive node says against hashes the light client trusts: a block header against
// its hash, and a storage value against the block's state root, through a Merkle proof of
// Substrate's storage trie (base-16, state versions 0 and 1).
import { blake2b256 } from './blake2b.js';

export class ProofError extends Error {}

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);
export function toHex(bytes) {
  let out = '0x';
  for (const byte of bytes) out += HEX[byte];
  return out;
}
export function fromHex(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex))
    throw new ProofError('Expected hex bytes');
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return bytes;
}
export const hash = (bytes) => toHex(blake2b256(bytes));

// SCALE's compact integers.
function compact(n) {
  if (n < 1 << 6) return [n << 2];
  if (n < 1 << 14) return [((n << 2) | 1) & 0xff, n >> 6];
  if (n < 1 << 30)
    return [((n << 2) | 2) & 0xff, (n >> 6) & 0xff, (n >> 14) & 0xff, n >>> 22];
  const bytes = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256))
    bytes.push(rest % 256);
  return [((bytes.length - 4) << 2) | 3, ...bytes];
}
function readCompact(bytes, at) {
  need(bytes, at, 1);
  const mode = bytes[at] & 3;
  if (mode === 0) return [bytes[at] >> 2, at + 1];
  if (mode === 1) {
    need(bytes, at, 2);
    return [(bytes[at] | (bytes[at + 1] << 8)) >> 2, at + 2];
  }
  if (mode === 2) {
    need(bytes, at, 4);
    const word =
      bytes[at] |
      (bytes[at + 1] << 8) |
      (bytes[at + 2] << 16) |
      (bytes[at + 3] << 24);
    return [word >>> 2, at + 4];
  }
  throw new ProofError('A length too large for a storage proof');
}
function need(bytes, at, count) {
  if (at + count > bytes.length) throw new ProofError('A node is cut short');
}

// A header's hash: BLAKE2b of its SCALE encoding.
export function headerHash(header) {
  const parent = fromHex(header.parentHash);
  const stateRoot = fromHex(header.stateRoot);
  const extrinsicsRoot = fromHex(header.extrinsicsRoot);
  if ([parent, stateRoot, extrinsicsRoot].some((h) => h.length !== 32))
    throw new ProofError('A header hash is not 32 bytes');
  const number =
    typeof header.number === 'string'
      ? parseInt(header.number, 16)
      : header.number;
  if (!Number.isSafeInteger(number) || number < 0)
    throw new ProofError('A header number is not a block number');
  const logs = (header.digest?.logs ?? []).map(fromHex);
  return hash(
    concat([
      parent,
      Uint8Array.from(compact(number)),
      stateRoot,
      extrinsicsRoot,
      Uint8Array.from(compact(logs.length)),
      ...logs,
    ]),
  );
}

function concat(parts) {
  const bytes = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function nibblesOf(bytes) {
  const nibbles = [];
  for (const byte of bytes) nibbles.push(byte >> 4, byte & 0x0f);
  return nibbles;
}

// A block's extrinsics root: the trie of its extrinsics, each under its index (SCALE compact),
// so a body can be checked against the header that names it.
export function extrinsicsRoot(extrinsics, version) {
  return trieRoot(
    extrinsics.map((hex, i) => [Uint8Array.from(compact(i)), fromHex(hex)]),
    version,
  );
}

// The root of the trie Substrate keeps `entries` ([key, value] bytes) in. A child node of 32
// bytes or more is kept by its hash, a smaller one inline; state version 1 also keeps a value of
// 33 bytes or more by its hash, where version 0 keeps every value inline. `nodes`, when given,
// collects what a proof of the entries would hold: the root, every node and value kept by hash.
export function trieRoot(entries, version = 1, nodes = null) {
  const byHash = (bytes) => {
    nodes?.push(bytes);
    return blake2b256(bytes);
  };
  const encode = (partial, value, children) => {
    const hashed = version === 1 && value !== null && value.length >= 33;
    const [prefix, prefixBits] = !children
      ? hashed
        ? [0x20, 3]
        : [0x40, 2]
      : value === null
        ? [0x80, 2]
        : hashed
          ? [0x10, 4]
          : [0xc0, 2];
    const packed = new Uint8Array(Math.ceil(partial.length / 2));
    for (let i = partial.length - 1, j = packed.length - 1; i >= 0; i -= 2, j--)
      packed[j] = partial[i] | (i > 0 ? partial[i - 1] << 4 : 0);
    const parts = [nodeHeader(prefix, prefixBits, partial.length), packed];
    if (children) {
      let bitmap = 0;
      children.forEach((child, k) => {
        if (child) bitmap |= 1 << k;
      });
      parts.push(Uint8Array.of(bitmap & 0xff, bitmap >> 8));
    }
    if (value !== null)
      parts.push(
        hashed
          ? byHash(value)
          : concat([Uint8Array.from(compact(value.length)), value]),
      );
    for (const child of children ?? [])
      if (child) {
        const ref = child.length >= 32 ? byHash(child) : child;
        parts.push(Uint8Array.from(compact(ref.length)), ref);
      }
    return concat(parts);
  };
  // A leaf for one key, else a branch where the keys part, at the nibbles they all share.
  const node = (items, depth) => {
    if (items.length === 0) return Uint8Array.of(0);
    const [first] = items;
    let end = items.length === 1 ? first.nibbles.length : depth;
    if (items.length > 1)
      while (
        items.every(
          (it) =>
            it.nibbles.length > end && it.nibbles[end] === first.nibbles[end],
        )
      )
        end++;
    const partial = first.nibbles.slice(depth, end);
    if (items.length === 1) return encode(partial, first.value, null);
    const children = [];
    for (let k = 0; k < 16; k++) {
      const group = items.filter(
        (it) => it.nibbles.length > end && it.nibbles[end] === k,
      );
      children.push(group.length ? node(group, end + 1) : null);
    }
    const here = items.find((it) => it.nibbles.length === end);
    return encode(partial, here ? here.value : null, children);
  };
  const root = node(
    entries.map(([key, value]) => ({ nibbles: nibblesOf(key), value })),
    0,
  );
  return toHex(byHash(root));
}
// The first byte holds the kind and as much of the nibble count as fits; the rest follows in
// bytes of 255 and a last smaller one.
function nodeHeader(prefix, prefixBits, size) {
  const max = 0xff >> prefixBits;
  if (size < max) return Uint8Array.of(prefix | size);
  const bytes = [prefix | max];
  let rest = size - max;
  for (; rest >= 255; rest -= 255) bytes.push(255);
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

// A trie node: { leaf, partial (nibbles), value ({ inline } or { hash }), children (16) }.
function decodeNode(bytes) {
  const first = bytes[0];
  if (bytes.length === 1 && first === 0) return null; // the empty trie
  let leaf, hasValue, hashedValue, prefixBits;
  if (first >> 6 === 0b01)
    [leaf, hasValue, hashedValue, prefixBits] = [true, true, false, 2];
  else if (first >> 6 === 0b10)
    [leaf, hasValue, hashedValue, prefixBits] = [false, false, false, 2];
  else if (first >> 6 === 0b11)
    [leaf, hasValue, hashedValue, prefixBits] = [false, true, false, 2];
  else if (first >> 5 === 0b001)
    [leaf, hasValue, hashedValue, prefixBits] = [true, true, true, 3];
  else if (first >> 4 === 0b0001)
    [leaf, hasValue, hashedValue, prefixBits] = [false, true, true, 4];
  else throw new ProofError('A node of no known kind');
  let at = 1;
  const max = 0xff >> prefixBits;
  let count = first & max;
  if (count === max)
    for (;;) {
      need(bytes, at, 1);
      const more = bytes[at++];
      count += more;
      if (more < 255) break;
    }
  const partialBytes = Math.ceil(count / 2);
  need(bytes, at, partialBytes);
  const partial = [];
  if (count % 2) {
    if (bytes[at] >> 4) throw new ProofError('A node with bad padding');
    partial.push(bytes[at++] & 0x0f);
  }
  for (const end = at + Math.floor(count / 2); at < end; at++)
    partial.push(bytes[at] >> 4, bytes[at] & 0x0f);
  let bitmap = 0;
  if (!leaf) {
    need(bytes, at, 2);
    bitmap = bytes[at] | (bytes[at + 1] << 8);
    at += 2;
  }
  let value = null;
  if (hasValue)
    if (hashedValue) {
      need(bytes, at, 32);
      value = { hash: toHex(bytes.subarray(at, at + 32)) };
      at += 32;
    } else {
      let length;
      [length, at] = readCompact(bytes, at);
      need(bytes, at, length);
      value = { inline: bytes.subarray(at, at + length) };
      at += length;
    }
  const children = [];
  for (let i = 0; i < 16; i++) {
    if (!(bitmap & (1 << i))) {
      children.push(null);
      continue;
    }
    let length;
    [length, at] = readCompact(bytes, at);
    need(bytes, at, length);
    const child = bytes.subarray(at, at + length);
    children.push(length === 32 ? { hash: toHex(child) } : { inline: child });
    at += length;
  }
  return { leaf, partial, value, children };
}

// The value at `key` in the trie whose root is `root`, or null when the proof shows there is
// none. Throws a ProofError when the proof doesn't settle it: a node or the value is missing, or
// a node doesn't decode.
export function readProof(root, key, proof) {
  const nodes = new Map();
  for (const item of proof) {
    const bytes = fromHex(item);
    nodes.set(hash(bytes), bytes);
  }
  const lookup = (h, what) => {
    const bytes = nodes.get(h);
    if (!bytes) throw new ProofError(`The proof lacks ${what}`);
    return bytes;
  };
  const nibbles = nibblesOf(fromHex(key));
  let bytes = lookup(root, 'the state root');
  let at = 0;
  for (;;) {
    const node = decodeNode(bytes);
    if (!node) return null;
    for (let i = 0; i < node.partial.length; i++)
      if (nibbles[at + i] !== node.partial[i]) return null;
    at += node.partial.length;
    if (node.leaf || at === nibbles.length) {
      if (at !== nibbles.length || !node.value) return null;
      return node.value.inline ?? lookup(node.value.hash, 'a value');
    }
    const child = node.children[nibbles[at++]];
    if (!child) return null;
    bytes = child.inline ?? lookup(child.hash, "a node on the key's path");
  }
}
