// BLAKE2b with a 32-byte output (RFC 7693), the hash Substrate uses for block headers and its
// storage trie. WebCrypto doesn't offer it. 64-bit words are kept as pairs of 32-bit halves,
// low half first: word i is v[2i] and v[2i + 1].

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372,
  0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

// v[a] += w[b], as 64-bit words.
function add(v, a, w, b) {
  const low = v[a] + w[b];
  v[a + 1] = v[a + 1] + w[b + 1] + (low > 0xffffffff ? 1 : 0);
  v[a] = low;
}

// v[d] = (v[d] ^ v[a]) rotated right by n bits.
function xorRotate(v, d, a, n) {
  const low = v[d] ^ v[a];
  const high = v[d + 1] ^ v[a + 1];
  if (n === 32) {
    v[d] = high;
    v[d + 1] = low;
  } else if (n < 32) {
    v[d] = (low >>> n) | (high << (32 - n));
    v[d + 1] = (high >>> n) | (low << (32 - n));
  } else {
    const k = n - 32;
    v[d] = (high >>> k) | (low << (32 - k));
    v[d + 1] = (low >>> k) | (high << (32 - k));
  }
}

function mix(v, m, a, b, c, d, x, y) {
  add(v, a, v, b);
  add(v, a, m, x);
  xorRotate(v, d, a, 32);
  add(v, c, v, d);
  xorRotate(v, b, c, 24);
  add(v, a, v, b);
  add(v, a, m, y);
  xorRotate(v, d, a, 16);
  add(v, c, v, d);
  xorRotate(v, b, c, 63);
}

function compress(h, block, length, last) {
  const m = new Uint32Array(32);
  for (let i = 0; i < 32; i++)
    m[i] =
      block[i * 4] |
      (block[i * 4 + 1] << 8) |
      (block[i * 4 + 2] << 16) |
      (block[i * 4 + 3] << 24);
  const v = new Uint32Array(32);
  v.set(h);
  v.set(IV, 16);
  v[24] ^= length; // the byte count so far, as a 64-bit word (word 12)
  v[25] ^= Math.floor(length / 0x100000000);
  if (last) {
    v[28] = ~v[28]; // word 14
    v[29] = ~v[29];
  }
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10];
    mix(v, m, 0, 8, 16, 24, s[0] * 2, s[1] * 2);
    mix(v, m, 2, 10, 18, 26, s[2] * 2, s[3] * 2);
    mix(v, m, 4, 12, 20, 28, s[4] * 2, s[5] * 2);
    mix(v, m, 6, 14, 22, 30, s[6] * 2, s[7] * 2);
    mix(v, m, 0, 10, 20, 30, s[8] * 2, s[9] * 2);
    mix(v, m, 2, 12, 22, 24, s[10] * 2, s[11] * 2);
    mix(v, m, 4, 14, 16, 26, s[12] * 2, s[13] * 2);
    mix(v, m, 6, 8, 18, 28, s[14] * 2, s[15] * 2);
  }
  for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[i + 16];
}

export function blake2b256(input) {
  const h = IV.slice();
  h[0] ^= 0x01010020; // no key, a 32-byte output
  const block = new Uint8Array(128);
  let offset = 0;
  while (input.length - offset > 128) {
    block.set(input.subarray(offset, offset + 128));
    offset += 128;
    compress(h, block, offset, false);
  }
  block.fill(0);
  block.set(input.subarray(offset));
  compress(h, block, input.length, true);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = h[i >> 2] >>> ((i & 3) * 8);
  return out;
}
