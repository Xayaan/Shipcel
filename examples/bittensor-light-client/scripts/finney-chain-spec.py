# Writes src/finney.json, the chain spec this light client starts from, out of Subtensor's raw
# Finney spec (raw_spec_finney.json in the subtensor repository, 12 MB): its descriptive fields,
# and the genesis given by its state root alone. The root comes from a full node's genesis
# header, which is trusted only because it hashes to Finney's genesis hash.
# Dropped: protocolId (smoldot no longer uses it), telemetry, the genesis storage, the code
# substitute for blocks long before the checkpoint, and Subtensor's grandpaWarpSyncCheckpoint,
# which smoldot doesn't read (scripts/finney-checkpoint.py turns it into src/finney-checkpoint.json).
# Usage: python3 -I scripts/finney-chain-spec.py <raw_spec_finney.json> src/finney.json [full node]
import hashlib, json, sys, urllib.request

GENESIS_HASH = '0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03'
raw_path, out = sys.argv[1], sys.argv[2]
node = sys.argv[3] if len(sys.argv) > 3 else 'https://entrypoint-finney.opentensor.ai:443'
spec = json.load(open(raw_path))
assert spec['id'] == 'bittensor' and spec['name'] == 'Bittensor', 'not the Finney spec'


def rpc(method, params):
    request = urllib.request.Request(
        node,
        data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    return json.load(urllib.request.urlopen(request, timeout=30))['result']


header = rpc('chain_getHeader', [GENESIS_HASH])
assert int(header['number'], 16) == 0 and not header['digest']['logs'], header
# SCALE: parent hash, number 0 (compact), state root, extrinsics root, empty digest.
encoded = (
    bytes.fromhex(header['parentHash'][2:])
    + b'\x00'
    + bytes.fromhex(header['stateRoot'][2:])
    + bytes.fromhex(header['extrinsicsRoot'][2:])
    + b'\x00'
)
assert '0x' + hashlib.blake2b(encoded, digest_size=32).hexdigest() == GENESIS_HASH, 'header does not hash to the genesis hash'

light = {key: spec[key] for key in ['name', 'id', 'chainType', 'bootNodes', 'properties', 'forkBlocks', 'badBlocks'] if key in spec}
light['telemetryEndpoints'] = None
light['codeSubstitutes'] = {}
light['genesis'] = {'stateRootHash': header['stateRoot']}
json.dump(light, open(out, 'w'), indent=1)
print(f"wrote {out}: genesis state root {header['stateRoot']}, {len(light['bootNodes'])} boot node(s)")
