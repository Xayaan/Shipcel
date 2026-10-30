#!/bin/sh
# Rebuilds ../src/smoldot.wasm: smoldot's light client at the npm-smoldot-v3.7.0 tag with this
# folder's eight patches, compiled as smoldot's own npm package is (wasm-node/javascript/prepare.mjs
# --release). Local paths are remapped so the file holds none of this computer's.
# Needs git and Rust with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown).
# Usage: sh smoldot/build.sh [empty work directory]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=${1:-$(mktemp -d)}
tag=npm-smoldot-v3.7.0
commit=cd98d7fa6a69e0ea66b23c0a2fb6d36c9063c4bb

git clone --quiet --depth 1 --branch "$tag" https://github.com/paritytech/smoldot.git "$work/smoldot"
cd "$work/smoldot"
if [ "$(git rev-parse HEAD)" != "$commit" ]; then
  echo "$tag is not commit $commit" >&2
  exit 1
fi
git apply "$here/0001-aura-from-finalized-header-digest.patch" \
  "$here/0002-bootstrap-from-database-without-light-sync-state.patch" \
  "$here/0003-ruzstd-0.9.1-for-rustsec-2026-0344.patch" \
  "$here/0004-reuse-the-warp-synced-runtime.patch" \
  "$here/0005-zstd-decode-in-steps-into-an-exact-buffer.patch" \
  "$here/0006-database-leaves-out-code-too-large-to-fit.patch" \
  "$here/0007-legacy-runtime-calls-use-pinned-runtimes.patch" \
  "$here/0008-compile-the-runtime-once-from-a-stream.patch"

RUSTFLAGS="--remap-path-prefix=$work/smoldot=/smoldot --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${RUSTUP_HOME:-$HOME/.rustup}=/rustup" \
  cargo build --locked --package smoldot-light-wasm --target wasm32-unknown-unknown --no-default-features --profile min-size-release

cp target/wasm32-unknown-unknown/min-size-release/smoldot_light_wasm.wasm "$here/../src/smoldot.wasm"
rustc --version
shasum -a 256 "$here/../src/smoldot.wasm"
