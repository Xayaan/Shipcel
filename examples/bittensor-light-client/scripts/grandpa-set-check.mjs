// Prints which GRANDPA authority set IDs verify the stored justification of each block given: a
// justification's precommits are signed over (precommit, round, set ID). Use it when the
// checkpoint changes, to find the set that finalizes the blocks after it.
// Usage: node scripts/grandpa-set-check.mjs <node address> <block number>...
// The node must keep justifications for those blocks; Opentensor's archive node does
// (https://archive.chain.opentensor.ai:443). Nodes keep them for blocks that change the
// authorities and every 512th block.
import { createPublicKey, verify } from 'node:crypto';

const [node, ...blocks] = process.argv.slice(2);
if (!node || !blocks.length) {
  console.error(
    'Usage: node scripts/grandpa-set-check.mjs <node address> <block number>...',
  );
  process.exit(2);
}
let nextId = 0;
async function call(method, params) {
  const response = await fetch(node, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// SCALE: round (u64), target hash and number, then the signed precommits.
function decode(bytes) {
  let at = 0;
  const take = (n) => bytes.subarray(at, (at += n));
  const u32 = () => take(4).readUInt32LE(0);
  const compact = () => {
    const mode = bytes[at] & 3;
    if (mode === 0) return take(1)[0] >> 2;
    if (mode === 1) return take(2).readUInt16LE(0) >> 2;
    if (mode === 2) return take(4).readUInt32LE(0) >>> 2;
    throw new Error('unexpected length');
  };
  const round = take(8).readBigUInt64LE(0);
  take(32);
  const target = u32();
  const precommits = Array.from({ length: compact() }, () => ({
    hash: Buffer.from(take(32)),
    number: u32(),
    signature: Buffer.from(take(64)),
    key: Buffer.from(take(32)),
  }));
  return { round, target, precommits };
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function signs({ hash, number, signature, key }, round, setId) {
  const payload = Buffer.alloc(53);
  payload[0] = 1; // Message::Precommit
  hash.copy(payload, 1);
  payload.writeUInt32LE(number, 33);
  payload.writeBigUInt64LE(round, 37);
  payload.writeBigUInt64LE(BigInt(setId), 45);
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI, key]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, payload, publicKey, signature);
}

const engine = (id) =>
  Array.isArray(id)
    ? String.fromCharCode(...id)
    : Buffer.from(id.slice(2), 'hex').toString();
const bytes = (data) =>
  Array.isArray(data) ? Buffer.from(data) : Buffer.from(data.slice(2), 'hex');

for (const block of blocks) {
  const hash = await call('chain_getBlockHash', [Number(block)]);
  const { justifications } = await call('chain_getBlock', [hash]);
  const grandpa = justifications?.find(([id]) => engine(id) === 'FRNK');
  if (!grandpa) {
    console.log(`#${block}: no stored GRANDPA justification`);
    continue;
  }
  const { round, target, precommits } = decode(bytes(grandpa[1]));
  const sets = [];
  for (let setId = 0; setId < 1000; setId++)
    if (signs(precommits[0], round, setId)) sets.push(setId);
  const all =
    sets.length === 1 && precommits.every((p) => signs(p, round, sets[0]));
  console.log(
    `#${block}: justification for #${target}, round ${round}, ${precommits.length} precommits; ` +
      (sets.length
        ? `set ${sets.join(', ')}${all ? ', every precommit verifies' : ''}`
        : 'no set ID from 0 to 999 verifies'),
  );
  await new Promise((resolve) => setTimeout(resolve, 1000)); // public nodes rate-limit
}
