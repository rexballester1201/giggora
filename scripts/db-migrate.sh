#!/usr/bin/env bash
#
# Giggora — apply database migrations (brief §21).
#
# Migrations are plain .sql files applied in filename order. Every one must be
# idempotent (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE) so re-running this
# is always safe.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# .env values may contain spaces, so it is loaded line by line, not sourced.
# shellcheck source=lib/load-env.sh
source scripts/lib/load-env.sh
load_env_file .env

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

if ! docker ps --format '{{.Names}}' | grep -q '^giggora-postgres$'; then
  echo "  ERROR: giggora-postgres is not running. Start it with:" >&2
  echo "    docker compose -p giggora up -d postgres" >&2
  exit 1
fi

echo ""
echo "  Applying migrations to database '${POSTGRES_DB}'..."
for f in database/migrations/*.sql; do
  name="$(basename "$f")"
  printf '    %-28s' "$name"
  docker exec -i giggora-postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -f "/migrations/$name"
  echo "ok"
done

echo ""
echo "  Tables:"
docker exec giggora-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT '    ' || tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
echo ""
