#!/usr/bin/env bash
#
# Giggora — run Foundry via Docker.
#
# Foundry is not installed natively on every dev machine (and installing it on
# Windows is awkward), so the pinned image is used instead. This keeps the
# compiler version reproducible, which matters because the deployed bytecode
# must be reproducible for contract verification later (brief §19).
#
# A named volume caches downloaded solc binaries, otherwise every --rm run
# re-downloads the compiler.
#
# Usage:
#   bash scripts/forge.sh build
#   bash scripts/forge.sh test -vvv
#   bash scripts/forge.sh fmt --check
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FOUNDRY_IMAGE="ghcr.io/foundry-rs/foundry:stable"
CACHE_VOLUME="giggora-foundry-cache"

if [ $# -eq 0 ]; then
  echo "usage: bash scripts/forge.sh <forge args...>" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "  ERROR: Docker daemon not reachable." >&2
  echo "  On Windows, try: powershell -ExecutionPolicy Bypass -File scripts/fix-docker.ps1" >&2
  exit 1
fi

if command -v cygpath >/dev/null 2>&1; then
  HOST_CONTRACTS="$(cygpath -m "$PWD/contracts")"
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
else
  HOST_CONTRACTS="$PWD/contracts"
fi

docker volume create "$CACHE_VOLUME" >/dev/null 2>&1 || true

# The foundry image's entrypoint takes a single shell string.
docker run --rm \
  -v "${HOST_CONTRACTS}:/work" \
  -v "${CACHE_VOLUME}:/root/.svm" \
  -w /work \
  --entrypoint sh \
  "$FOUNDRY_IMAGE" \
  -c "forge $*"
