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

# PINNED BY DIGEST, not by tag. The header above promises reproducible bytecode
# for contract verification; ":stable" is a MOVING tag and delivered whatever
# Foundry had published that day, so the promise was false. This digest is the
# image that produced the contract builds recorded in git history.
#   upstream revision: b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2
# To upgrade: pull the new tag, run the full contract suite, and record the new
# digest here in the same commit as any bytecode change.
FOUNDRY_IMAGE="ghcr.io/foundry-rs/foundry@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46"
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

# The image's entrypoint takes a shell string. Arguments are handed to that
# shell as its own positional parameters ("$@"; the literal `forge` is $0), so
# each survives intact. The old `-c "forge $*"` flattened them into one string
# and re-split it, so any argument with whitespace or quotes broke — e.g.
#   forge test --match-test "transfer reverts"
docker run --rm \
  -v "${HOST_CONTRACTS}:/work" \
  -v "${CACHE_VOLUME}:/root/.svm" \
  -w /work \
  --entrypoint sh \
  "$FOUNDRY_IMAGE" \
  -c 'forge "$@"' forge "$@"
