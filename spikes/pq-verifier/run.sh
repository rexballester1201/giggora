#!/usr/bin/env bash
#
# Giggora PQ-verifier spike: run the Foundry suite in the SAME pinned Foundry
# image the contracts use (read from scripts/forge.sh, so there is one digest).
#
# Usage:
#   bash run.sh                       # forge test -vv --gas-report
#   bash run.sh build --sizes         # any other forge arguments
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

FOUNDRY_IMAGE="$(sed -n 's/^FOUNDRY_IMAGE="\(.*\)"$/\1/p' ../../scripts/forge.sh)"
if [ -z "$FOUNDRY_IMAGE" ]; then
  echo "  ERROR: could not read FOUNDRY_IMAGE from scripts/forge.sh" >&2
  exit 1
fi
if [ ! -f fixtures/cases.bin ]; then
  echo "  ERROR: fixtures/cases.bin missing. Run: bash fetch.sh && node make-fixtures.mjs" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "  ERROR: Docker daemon not reachable." >&2
  exit 1
fi

if command -v cygpath >/dev/null 2>&1; then
  HOST_DIR="$(cygpath -m "$PWD")"
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
else
  HOST_DIR="$PWD"
fi

if [ $# -eq 0 ]; then
  set -- test -vv --gas-report
fi

docker volume create giggora-foundry-cache >/dev/null 2>&1 || true
docker run --rm \
  -v "${HOST_DIR}:/work" \
  -v "giggora-foundry-cache:/root/.svm" \
  -w /work \
  --entrypoint sh \
  "$FOUNDRY_IMAGE" \
  -c 'forge "$@"' forge "$@"
