#!/usr/bin/env bash
#
# Giggora — start the local devnet (brief §7).
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  echo "  ERROR: .env missing. Run: bash scripts/create-genesis.sh" >&2
  exit 1
fi

if [ ! -f blockchain/genesis/genesis.json ]; then
  echo "  ERROR: genesis not generated. Run: bash scripts/create-genesis.sh" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

if [ -z "${BOOTNODE_ENODE:-}" ]; then
  echo "  ERROR: BOOTNODE_ENODE is empty. Re-run: bash scripts/create-genesis.sh" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "  ERROR: Docker daemon not reachable. Start Docker Desktop and retry." >&2
  exit 1
fi

echo ""
echo "  Starting ${CHAIN_NAME} ${CHAIN_NETWORK} (chain ID ${CHAIN_ID}) ..."
docker compose up -d

cat <<MSG

  ${CHAIN_NAME} is starting.

    RPC (HTTP)   ${RPC_URL}
    RPC (WS)     ${WS_URL}
    Chain ID     ${CHAIN_ID}
    Currency     ${CURRENCY_SYMBOL}

  Validators expose debug RPC on 127.0.0.1:8551-8554 (devnet only).

  Verify the network:   node scripts/verify-network.mjs
  Follow logs:          docker compose logs -f
  Stop:                 docker compose down

MSG
