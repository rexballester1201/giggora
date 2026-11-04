#!/usr/bin/env bash
#
# Giggora PQ-verifier spike: fetch everything, pinned, and verify it.
#
#   1. Fireblocks Labs' evm-ml-dsa-verifier at a pinned commit          -> vendor/
#   2. NIST ACVP ML-DSA sigGen + sigVer vectors at a pinned commit,
#      each checked by SHA-256                                          -> cache/
#   3. @noble/post-quantum, exactly as package-lock.json pins it        -> node_modules/
#
# Everything lands in gitignored folders. Safe to re-run: it only fetches what
# is missing or wrong, and fails on any commit or digest mismatch.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VERIFIER_REPO="https://github.com/fireblocks-labs/evm-ml-dsa-verifier.git"
VERIFIER_COMMIT="cca262b537a5ac2ee55efb427e5c61de0308e566"   # 2026-09-02, MIT
VERIFIER_DIR="vendor/evm-ml-dsa-verifier"

ACVP_COMMIT="975de31eb83d87039ec88934fdc47d8c312b892d"       # usnistgov/ACVP-Server, 2026-08-12
ACVP_BASE="https://raw.githubusercontent.com/usnistgov/ACVP-Server/${ACVP_COMMIT}/gen-val/json-files"
ACVP_FILES=(
  "ML-DSA-sigGen-FIPS204 72dcaf5f69853ca267ccd16af9cb40949786aca0fcfbf05d1ebeba132b93af22"
  "ML-DSA-sigVer-FIPS204 47cdd6314c7f746d02421ffcba89d4dbc7bb875ac49e07a029fdfc26fba55437"
)

echo "1. verifier @ ${VERIFIER_COMMIT:0:7}"
if [ ! -d "$VERIFIER_DIR/.git" ]; then
  mkdir -p vendor
  git clone --quiet "$VERIFIER_REPO" "$VERIFIER_DIR"
fi
if [ "$(git -C "$VERIFIER_DIR" rev-parse HEAD)" != "$VERIFIER_COMMIT" ]; then
  git -C "$VERIFIER_DIR" fetch --quiet origin
  git -C "$VERIFIER_DIR" checkout --quiet --detach "$VERIFIER_COMMIT"
fi
HEAD_NOW="$(git -C "$VERIFIER_DIR" rev-parse HEAD)"
if [ "$HEAD_NOW" != "$VERIFIER_COMMIT" ]; then
  echo "   ERROR: verifier is at $HEAD_NOW, expected $VERIFIER_COMMIT" >&2
  exit 1
fi
if [ -n "$(git -C "$VERIFIER_DIR" status --porcelain)" ]; then
  echo "   ERROR: $VERIFIER_DIR has local changes; refusing to test a modified verifier" >&2
  exit 1
fi
echo "   ok"

echo "2. NIST ACVP vectors @ ${ACVP_COMMIT:0:7}"
mkdir -p cache
for entry in "${ACVP_FILES[@]}"; do
  name="${entry%% *}"
  want="${entry##* }"
  file="cache/$name.json"
  have=""
  if [ -f "$file" ]; then have="$(sha256sum "$file" | cut -d' ' -f1)"; fi
  if [ "$have" != "$want" ]; then
    curl -sSfL -o "$file" "$ACVP_BASE/$name/internalProjection.json"
    have="$(sha256sum "$file" | cut -d' ' -f1)"
  fi
  if [ "$have" != "$want" ]; then
    echo "   ERROR: $file has sha256 $have, expected $want" >&2
    exit 1
  fi
  echo "   $name ok"
done

echo "3. @noble/post-quantum from the lockfile"
npm ci --no-audit --no-fund --silent
node -e "const v = require('./node_modules/@noble/post-quantum/package.json').version; if (v !== '0.7.1') { console.error('   ERROR: noble is ' + v); process.exit(1); } console.log('   ok (' + v + ')');"

echo ""
echo "  Next: node make-fixtures.mjs, then bash run.sh"
