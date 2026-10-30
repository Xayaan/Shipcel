# Writes src/finney-checkpoint.json, where this light client starts verifying Finney: the
# grandpaWarpSyncCheckpoint of Subtensor's raw Finney spec, in the form of smoldot's database
# (smoldot reads a checkpoint only as a BABE chain's lightSyncState; patch 0002 lets it start
# from this database instead). Nothing here comes from the network: the header must hash to the
# checkpoint's block hash, and the authorities are read from that header.
# The checkpoint block enacts, with no delay, the GRANDPA change in its own digest: the spec's
# grandpaAuthoritySet (set 5) finalized the block itself, and the new authorities, as set 6,
# finalize the blocks after it, which is what smoldot needs. (Checked against Finney: the block's
# stored justification verifies with set 5, those of #8867840 and #8868352 with set 6.)
# Known peers come from a smoldot database, such as one a running light client saved, and only
# their public addresses are kept.
# Usage: python3 -I scripts/finney-checkpoint.py <raw_spec_finney.json> <smoldot database or -> src/finney-checkpoint.json
import hashlib, ipaddress, json, sys

GENESIS_HASH = '2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03'
CHECKPOINT_HASH = '511948e96e1d479d0a92d89bb976638780f2c65a93a5d5be710f22ee15c60200'
CHECKPOINT_NUMBER = 8867448
AURA_SLOT_MS = 12000
raw_path, peers_path, out = sys.argv[1:4]
checkpoint = json.load(open(raw_path))['grandpaWarpSyncCheckpoint']
header = bytes.fromhex(checkpoint['finalizedBlockHeader'][2:])
assert hashlib.blake2b(header, digest_size=32).hexdigest() == CHECKPOINT_HASH, 'the header is not the checkpoint block'


def compact(data, i):
    mode = data[i] & 3
    if mode == 0:
        return data[i] >> 2, i + 1
    if mode == 1:
        return int.from_bytes(data[i : i + 2], 'little') >> 2, i + 2
    if mode == 2:
        return int.from_bytes(data[i : i + 4], 'little') >> 2, i + 4
    length = (data[i] >> 2) + 4
    return int.from_bytes(data[i + 1 : i + 1 + length], 'little'), i + 1 + length


# Header: parent hash, number, state root, extrinsics root, then the digest's items.
number, i = compact(header, 32)
assert number == CHECKPOINT_NUMBER
i += 64
items, i = compact(header, i)
aura = grandpa = None
for _ in range(items):
    kind, engine = header[i], header[i + 1 : i + 5]
    length, i = compact(header, i + 5)
    data = header[i : i + length]
    i += length
    if kind == 4 and engine == b'aura' and data[0] == 1:  # Consensus, AuthoritiesChange
        count, j = compact(data, 1)
        aura = [data[j + 32 * k : j + 32 * (k + 1)].hex() for k in range(count)]
    if kind == 4 and engine == b'FRNK' and data[0] == 1:  # Consensus, ScheduledChange
        count, j = compact(data, 1)
        grandpa = [
            (data[j + 40 * k : j + 40 * k + 32].hex(), int.from_bytes(data[j + 40 * k + 32 : j + 40 * (k + 1)], 'little'))
            for k in range(count)
        ]
        delay = int.from_bytes(data[j + 40 * count : j + 40 * count + 4], 'little')
        assert delay == 0, 'only a change without delay takes effect at the checkpoint itself'
assert aura and len(set(aura)) == len(aura) == 20
assert grandpa and len({key for key, _ in grandpa}) == len(grandpa) == 20 and all(weight > 0 for _, weight in grandpa)

spec_set = bytes.fromhex(checkpoint['grandpaAuthoritySet'][2:])
spec_set_id = int.from_bytes(spec_set[:8], 'little')
count, j = compact(spec_set, 8)
assert j + 40 * count == len(spec_set), 'unexpected bytes after the checkpoint authority set'

nodes = {}
if peers_path != '-':
    for peer, addresses in json.load(open(peers_path)).get('nodes', {}).items():
        public = []
        for address in addresses:
            parts = address.split('/')
            try:
                if parts[1] in ('ip4', 'ip6') and not ipaddress.ip_address(parts[2]).is_global:
                    continue
            except (IndexError, ValueError):
                continue
            public.append(address)
        if public:
            nodes[peer] = public

database = {
    'genesisHash': GENESIS_HASH,
    'chain': {
        'version': '1',
        'finalized_block_header': header.hex(),
        'aura_slot_duration': AURA_SLOT_MS,
        'aura_finalized_authorities': [{'public_key': key} for key in aura],
        'grandpa_after_finalized_block_authorities_set_id': spec_set_id + 1,
        'grandpa_finalized_triggered_authorities': [{'public_key': key, 'weight': weight} for key, weight in grandpa],
    },
    'nodes': nodes,
}
json.dump(database, open(out, 'w'))
print(f'wrote {out}: block #{number}, {len(aura)} Aura authorities, GRANDPA set {spec_set_id + 1} ({len(grandpa)} authorities), {len(nodes)} peers')
