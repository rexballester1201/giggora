#!/usr/bin/env bash
#
# Giggora — reproducible genesis generation (brief §6).
#
# The same chain.config.json always produces the same genesis, except for the
# validator node keys, which are freshly generated unless --keep-keys is passed.
#
# Steps:
#   1. Generate qbftConfigFile.json + .env from chain.config.json
#   2. Run `besu operator generate-blockchain-config` (via Docker)
#   3. Distribute the generated validator keys to per-node data directories
#   4. Derive validator-1's enode URL and write BOOTNODE_ENODE into .env
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

GENESIS_DIR="$ROOT/blockchain/genesis"
NETWORK_FILES="$GENESIS_DIR/networkFiles"
NODES_DIR="$ROOT/blockchain/nodes"

# Docker on Windows needs a Windows-style host path, and MSYS must be told not
# to rewrite the container-side paths.
if command -v cygpath >/dev/null 2>&1; then
  HOST_GENESIS_DIR="$(cygpath -m "$GENESIS_DIR")"
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
else
  HOST_GENESIS_DIR="$GENESIS_DIR"
fi

echo ""
echo "  Giggora :: genesis generation"
echo "  ============================="

# --- 1. config ---------------------------------------------------------------
node scripts/gen-config.mjs

# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a

# --- preflight ---------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  cat <<'MSG'

  ERROR: the Docker daemon is not reachable.

  Start Docker Desktop, wait for it to report "Engine running", then re-run
  this script. Everything up to this point (config generation) already
  succeeded and does not need to be repeated.

MSG
  exit 1
fi

# --- 2. generate genesis + validator keys ------------------------------------
if [ -d "$NETWORK_FILES" ]; then
  echo "  Removing previous networkFiles/ ..."
  rm -rf "$NETWORK_FILES"
fi

echo "  Running besu operator generate-blockchain-config ..."
set +e
BESU_OUT="$(docker run --rm \
  -v "${HOST_GENESIS_DIR}:/genesis" \
  "$BESU_IMAGE" \
  operator generate-blockchain-config \
    --config-file=/genesis/qbftConfigFile.json \
    --to=/genesis/networkFiles \
    --private-key-file-name=key 2>&1)"
BESU_EXIT=$?
set -e

# Besu 26.8.1 exits 1 with "Output directory already exists" even when --to is a
# genuinely absent path, while still writing complete and correct output.
# Reproducible on Docker Desktop / Windows bind mounts. So the exit code is not
# trustworthy here — validate the actual artifacts instead. We do NOT blanket-
# ignore the failure: anything other than this specific known-benign case is
# still treated as fatal.
BENIGN="Output directory already exists"

if [ ! -f "$NETWORK_FILES/genesis.json" ]; then
  echo "  ERROR: besu produced no genesis.json (exit $BESU_EXIT)" >&2
  echo "$BESU_OUT" >&2
  exit 1
fi

# Relative path: node resolves it from the repo root we cd'd into. An absolute
# MSYS path (/d/...) would not resolve on Windows.
VALIDATION="$(node -e "
const fs = require('fs');
const g = JSON.parse(fs.readFileSync('blockchain/genesis/networkFiles/genesis.json','utf8'));
if (g.config.chainId !== $CHAIN_ID) { console.error('chainId mismatch: expected $CHAIN_ID, got ' + g.config.chainId); process.exit(1); }
if (!g.extraData || g.extraData.length < 10) { console.error('missing or empty extraData validator list'); process.exit(1); }
console.log('chainId ' + g.config.chainId + ', extraData ' + g.extraData.length + ' chars');
" 2>&1)" || {
  echo "  ERROR: generated genesis.json failed validation" >&2
  echo "  $VALIDATION" >&2
  exit 1
}

KEY_COUNT="$(find "$NETWORK_FILES/keys" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$KEY_COUNT" -ne "$VALIDATOR_COUNT" ]; then
  echo "  ERROR: expected $VALIDATOR_COUNT validator keys, found $KEY_COUNT (exit $BESU_EXIT)" >&2
  echo "$BESU_OUT" >&2
  exit 1
fi

if [ "$BESU_EXIT" -ne 0 ]; then
  if echo "$BESU_OUT" | grep -q "$BENIGN"; then
    echo "  NOTE: besu exited $BESU_EXIT with \"$BENIGN\"."
    echo "        This is a known Besu quirk and the output is correct."
    echo "        Validated: genesis.json (chainId $CHAIN_ID) + $KEY_COUNT validator keys."
  else
    echo "  ERROR: besu failed with an unrecognised error (exit $BESU_EXIT)" >&2
    echo "$BESU_OUT" >&2
    exit 1
  fi
fi

cp "$NETWORK_FILES/genesis.json" "$GENESIS_DIR/genesis.json"
echo "  Wrote blockchain/genesis/genesis.json"

# --- 3. distribute keys ------------------------------------------------------
# Besu emits networkFiles/keys/<0xADDRESS>/{key,key.pub}. Sort for determinism
# so validator-N always maps to the same key across reruns of this script.
mapfile -t KEY_DIRS < <(find "$NETWORK_FILES/keys" -mindepth 1 -maxdepth 1 -type d | sort)

if [ "${#KEY_DIRS[@]}" -ne "$VALIDATOR_COUNT" ]; then
  echo "  ERROR: expected $VALIDATOR_COUNT key dirs, found ${#KEY_DIRS[@]}" >&2
  exit 1
fi

rm -rf "$NODES_DIR"
echo ""
echo "  Validators:"
for i in "${!KEY_DIRS[@]}"; do
  n=$((i + 1))
  src="${KEY_DIRS[$i]}"
  dest="$NODES_DIR/validator-$n"
  mkdir -p "$dest"
  cp "$src/key" "$dest/key"
  cp "$src/key.pub" "$dest/key.pub"
  printf '    validator-%s  %s\n' "$n" "$(basename "$src")"
done

# The RPC node is deliberately NOT given a validator key. Besu generates its own
# p2p identity on first start, so it syncs and serves RPC but never proposes.
mkdir -p "$NODES_DIR/rpc"

# --- 4. bootnode enode -------------------------------------------------------
# The host MUST be an IP literal. Besu rejects a DNS hostname here with
# "Invalid enode URL syntax ... Invalid ip address", which crash-loops every
# node that uses this bootnode. BOOTNODE_IP comes from gen-config.mjs and is
# pinned in docker-compose.yml as validator-1's static address.
PUBKEY="$(tr -d '\n\r ' < "$NODES_DIR/validator-1/key.pub" | sed 's/^0x//')"
ENODE="enode://${PUBKEY}@${BOOTNODE_IP}:${P2P_PORT}"

# Replace the placeholder line written by gen-config.mjs.
tmp="$(mktemp)"
sed "s|^BOOTNODE_ENODE=.*|BOOTNODE_ENODE=${ENODE}|" "$ROOT/.env" > "$tmp"
mv "$tmp" "$ROOT/.env"

# --- 5. static peer list ----------------------------------------------------
# UDP peer discovery only forms a star through the bootnode on this network:
# every node connects to validator-1 and to nobody else, so QBFT validators
# cannot exchange prepare/commit messages and the chain stalls at block 1.
#
# For a fixed validator set the correct answer is not discovery but an explicit
# peer list. Besu reads <data-path>/static-nodes.json on startup and maintains
# persistent connections to everything in it.
echo ""
echo "  Static peer list:"
ENODES=()
for i in $(seq 1 "$VALIDATOR_COUNT"); do
  pub="$(tr -d '\n\r ' < "$NODES_DIR/validator-$i/key.pub" | sed 's/^0x//')"
  ipvar="VALIDATOR_${i}_IP"
  ENODES+=("enode://${pub}@${!ipvar}:${P2P_PORT}")
done

# Each node gets every OTHER node, never itself: Besu rejects self-references.
write_static_nodes() {
  # 'n' must be local: without it the loop below clobbers the caller's loop
  # variable and every node gets logged under the last index.
  local dest="$1" self_index="$2" first=1 json="[" n
  for n in $(seq 1 "$VALIDATOR_COUNT"); do
    [ "$n" = "$self_index" ] && continue
    [ $first -eq 1 ] && first=0 || json="${json},"
    json="${json}\"${ENODES[$((n - 1))]}\""
  done
  json="${json}]"
  printf '%s\n' "$json" > "$dest/static-nodes.json"
}

for i in $(seq 1 "$VALIDATOR_COUNT"); do
  write_static_nodes "$NODES_DIR/validator-$i" "$i"
  printf '    validator-%s  -> %s peers\n' "$i" "$((VALIDATOR_COUNT - 1))"
done
write_static_nodes "$NODES_DIR/rpc" "0"
printf '    rpc          -> %s peers\n' "$VALIDATOR_COUNT"

cat <<MSG

  Bootnode
    ${ENODE}

  Genesis is ready. Start the network with:

    bash scripts/start-network.sh

  Keys live in blockchain/nodes/ and are gitignored. They are DEVNET keys and
  carry no value — never reuse them on testnet or mainnet.

MSG
