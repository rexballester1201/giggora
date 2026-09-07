#!/usr/bin/env bash
#
# Giggora — prepare the contracts project.
#
#   1. npm install (OpenZeppelin, pinned in contracts/package.json)
#   2. clone forge-std at a pinned tag into contracts/lib/
#
# forge-std is NOT taken from npm: the "forge-std" npm package is unrelated and
# stale (1.1.2 vs the real v1.16.x). It is cloned from source at a pinned tag so
# the test framework version is reproducible.
#
# contracts/lib/ is gitignored — re-run this after a fresh clone.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FORGE_STD_TAG="v1.16.2"
LIB_DIR="contracts/lib"
FORGE_STD_DIR="$LIB_DIR/forge-std"

echo ""
echo "  Giggora :: contracts setup"
echo "  =========================="

echo ""
echo "  1. Installing npm dependencies (OpenZeppelin)..."
( cd contracts && npm install --silent )
OZ_VERSION="$(node -p "require('./contracts/node_modules/@openzeppelin/contracts/package.json').version")"
echo "     @openzeppelin/contracts ${OZ_VERSION}"

echo ""
echo "  2. forge-std ${FORGE_STD_TAG}..."
mkdir -p "$LIB_DIR"
if [ -d "$FORGE_STD_DIR/.git" ]; then
  CURRENT="$(git -C "$FORGE_STD_DIR" describe --tags --exact-match 2>/dev/null || echo "unknown")"
  if [ "$CURRENT" = "$FORGE_STD_TAG" ]; then
    echo "     already at ${FORGE_STD_TAG}"
  else
    echo "     at ${CURRENT}, refetching ${FORGE_STD_TAG}..."
    git -C "$FORGE_STD_DIR" fetch --depth 1 origin tag "$FORGE_STD_TAG" --quiet
    git -C "$FORGE_STD_DIR" checkout --quiet "$FORGE_STD_TAG"
    echo "     now at ${FORGE_STD_TAG}"
  fi
else
  rm -rf "$FORGE_STD_DIR"
  git clone --depth 1 --branch "$FORGE_STD_TAG" --quiet \
    https://github.com/foundry-rs/forge-std.git "$FORGE_STD_DIR"
  echo "     cloned ${FORGE_STD_TAG}"
fi

if [ ! -f "$FORGE_STD_DIR/src/Test.sol" ]; then
  echo "  ERROR: forge-std/src/Test.sol missing after setup" >&2
  exit 1
fi

cat <<'MSG'

  Contracts are ready.

    bash scripts/forge.sh build
    bash scripts/forge.sh test -vv

MSG
