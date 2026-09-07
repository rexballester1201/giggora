#!/usr/bin/env bash
#
# Giggora — backup (brief §8, §33).
#
# WHAT IS AND IS NOT WORTH BACKING UP, and why:
#
#   VALIDATOR KEYS — the only truly irreplaceable material. Lose one and that
#     validator is gone; you must vote in a replacement (docs/validator-rotation.md).
#     Lose enough at once and the chain drops below quorum permanently.
#     These are NOT backed up by this script, on purpose: a validator key that
#     travels to a backup server is a validator key with a second attack surface.
#     Back them up out of band, encrypted, in a key ceremony you control.
#
#   GENESIS + CONFIG — small, and the chain cannot be reconstructed without them.
#     Always backed up.
#
#   THE INDEXER DATABASE — large and FULLY REDERIVABLE from the chain. Backing it
#     up is a restore-time optimisation, not a data-safety measure: if it is lost,
#     re-run the indexer. Optional, and skipped by default at scale.
#
#   CHAIN DATA (Besu's own database) — not backed up. Any node can re-sync from
#     its peers, which is exactly what peers are for. Backing it up would be
#     backing up a cache.
#
# Usage:
#   bash scripts/backup.sh                 # config + genesis + schema
#   bash scripts/backup.sh --with-index    # also dump the indexer database
#   bash scripts/backup.sh --verify <dir>  # check a backup is restorable
#
set -euo pipefail
# Remember where the operator ran this from BEFORE cd-ing to the repo, so a
# relative --verify path means what they typed, not repo-root-relative.
INVOKE_DIR="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

BACKUP_ROOT="${BACKUP_ROOT:-$ROOT/backups}"
WITH_INDEX=0
VERIFY_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --with-index) WITH_INDEX=1; shift ;;
    --verify)
      VERIFY_DIR="${2:?--verify needs a directory}"
      case "$VERIFY_DIR" in /*|[A-Za-z]:*) ;; *) VERIFY_DIR="$INVOKE_DIR/$VERIFY_DIR" ;; esac
      shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# shellcheck disable=SC1091
set -a; source "$ROOT/.env"; set +a
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# --- verify mode -------------------------------------------------------------
if [ -n "$VERIFY_DIR" ]; then
  echo ""
  echo "  Verifying backup: $VERIFY_DIR"
  fail=0
  for f in genesis.json chain.config.json MANIFEST.txt; do
    if [ -f "$VERIFY_DIR/$f" ]; then
      echo "    present  $f"
    else
      echo "    MISSING  $f"; fail=1
    fi
  done

  if [ -f "$VERIFY_DIR/genesis.json" ]; then
    # A backup of an unparseable genesis restores nothing, so the file is
    # actually parsed rather than merely counted.
    #
    # The path is passed as ARGV and read with readFileSync, never require().
    # require() resolves relative paths against the module rather than the cwd,
    # and chokes on the MSYS-style paths this shell produces on Windows — which
    # made an earlier version of this check report a perfectly good genesis as
    # corrupt. A verifier that cries wolf is worse than no verifier.
    if node -e '
      const fs = require("fs");
      const g = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!g.config || !g.config.chainId) { console.error("no chainId"); process.exit(1); }
      if (!g.extraData || g.extraData.length < 10) { console.error("no extraData"); process.exit(1); }
      if (!g.alloc || Object.keys(g.alloc).length === 0) { console.error("empty alloc"); process.exit(1); }
      console.log("    valid    genesis.json (chainId " + g.config.chainId +
                  ", " + Object.keys(g.alloc).length + " alloc entries)");
    ' "$VERIFY_DIR/genesis.json"; then :; else
      echo "    INVALID  genesis.json failed structural checks"; fail=1
    fi
  fi

  if [ -f "$VERIFY_DIR/indexer.sql.gz" ]; then
    if gzip -t "$VERIFY_DIR/indexer.sql.gz" 2>/dev/null; then
      echo "    valid    indexer.sql.gz (gzip integrity ok)"
    else
      echo "    CORRUPT  indexer.sql.gz failed gzip integrity check"; fail=1
    fi
  fi

  echo ""
  if [ "$fail" -eq 0 ]; then echo "  Backup is restorable."; echo ""; exit 0
  else echo "  Backup is INCOMPLETE or CORRUPT."; echo ""; exit 1; fi
fi

# --- backup mode -------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

echo ""
echo "  Giggora backup -> $DEST"
echo ""

# 1. Genesis and config. Small, irreplaceable, always taken.
cp "$ROOT/blockchain/genesis/genesis.json" "$DEST/genesis.json"
cp "$ROOT/blockchain/config/chain.config.json" "$DEST/chain.config.json"
echo "    genesis.json + chain.config.json"

# 2. Schema, so a database can be rebuilt before replaying the chain.
mkdir -p "$DEST/migrations"
cp "$ROOT"/database/migrations/*.sql "$DEST/migrations/"
echo "    database migrations ($(ls "$ROOT"/database/migrations/*.sql | wc -l | tr -d ' ') files)"

# 3. Validator ADDRESSES (public), so a restore knows which keys it needs.
#    The private keys are deliberately NOT copied.
if [ -d "$ROOT/blockchain/nodes" ]; then
  {
    echo "# Validator public keys and addresses at backup time."
    echo "# PRIVATE KEYS ARE NOT IN THIS BACKUP - see the header of scripts/backup.sh."
    for d in "$ROOT"/blockchain/nodes/validator-*/; do
      [ -f "$d/key.pub" ] || continue
      echo "$(basename "$d"): $(tr -d '\n\r ' < "$d/key.pub")"
    done
  } > "$DEST/validator-pubkeys.txt"
  echo "    validator public keys (private keys deliberately excluded)"
fi

# 4. Indexer database, only on request. Rederivable, so not default.
if [ "$WITH_INDEX" -eq 1 ]; then
  if docker ps --format '{{.Names}}' | grep -q '^giggora-postgres$'; then
    echo -n "    dumping indexer database… "
    docker exec giggora-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner \
      | gzip > "$DEST/indexer.sql.gz"
    echo "$(du -h "$DEST/indexer.sql.gz" | cut -f1)"
  else
    echo "    SKIPPED indexer dump (giggora-postgres not running)"
  fi
fi

# 5. Manifest. A backup you cannot identify later is not a backup.
CHAIN_HEAD="$(curl -s --max-time 8 -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "$RPC_URL" 2>/dev/null | grep -oE '0x[0-9a-f]+' || echo "unavailable")"

{
  echo "Giggora backup"
  echo "created:        $STAMP"
  echo "network:        ${CHAIN_NETWORK:-unknown}"
  echo "chain id:       ${CHAIN_ID:-unknown}"
  echo "chain head:     $CHAIN_HEAD"
  echo "besu image:     ${BESU_IMAGE:-unknown}"
  echo "indexer dump:   $([ "$WITH_INDEX" -eq 1 ] && echo yes || echo no)"
  echo ""
  echo "NOT INCLUDED, BY DESIGN:"
  echo "  - validator private keys (back up out of band, encrypted)"
  echo "  - Besu chain data (re-syncs from peers)"
} > "$DEST/MANIFEST.txt"
echo "    MANIFEST.txt"

echo ""
echo "  Done. Verify it:"
echo "    bash scripts/backup.sh --verify $DEST"
echo ""
