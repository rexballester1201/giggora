# shellcheck shell=bash
#
# Load a .env file into the environment of the calling script.
#
# .env is written by scripts/gen-config.mjs with UNQUOTED values, because that is
# how docker compose and the Node services read it. Some values contain spaces
# (CHAIN_TAGLINE, CHAIN_DESCRIPTION, CURRENCY_NAME), so the file cannot simply
# be `source`d: bash reads `KEY=first word` as an assignment prefix and tries to
# run the second word as a command, and `set -e` then kills the script. That is
# how create-genesis.sh failed on a fresh clone once the branding lines were
# added to .env.
#
# Each KEY=VALUE line is exported literally instead: no word splitting, and no
# expansion of $ or backticks in values.
#
# Usage:
#   source scripts/lib/load-env.sh
#   load_env_file .env

load_env_file() {
  local file="$1" line key
  if [ ! -f "$file" ]; then
    echo "  ERROR: $file is missing" >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    export "$key=${line#*=}"
  done < "$file"
}
