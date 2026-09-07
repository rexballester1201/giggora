#!/usr/bin/env bash
#
# Giggora — firewall for a VALIDATOR host (brief §30, §32).
#
# A validator holds a signing key and must be unreachable from the internet.
# The only inbound traffic it accepts is p2p from the OTHER validators and the
# RPC node, by explicit IP. Not a subnet, not "any" — a list.
#
# Run as root on each validator host. Set PEERS to every OTHER node's address.
#
set -euo pipefail

# Every other validator plus the RPC node. NOT this host.
PEERS="${PEERS:?set PEERS to a space-separated list of peer IPs}"
P2P_PORT="${P2P_PORT:-30303}"
SSH_FROM="${SSH_FROM:?set SSH_FROM to your admin IP or CIDR — never leave SSH open to the world}"

echo "Resetting ufw…"
ufw --force reset

ufw default deny incoming
ufw default allow outgoing

# SSH, restricted to the admin source. An unrestricted SSH port on a host
# holding a validator key is the whole game.
ufw allow from "$SSH_FROM" to any port 22 proto tcp comment 'admin ssh'

# p2p, per peer, TCP for RLPx and UDP for discovery.
for ip in $PEERS; do
  ufw allow from "$ip" to any port "$P2P_PORT" proto tcp comment "giggora p2p $ip"
  ufw allow from "$ip" to any port "$P2P_PORT" proto udp comment "giggora disc $ip"
done

# Deliberately NOT opened:
#   8545 JSON-RPC   — binds to 127.0.0.1; use an SSH tunnel for local checks
#   9545 metrics    — binds to 127.0.0.1; scrape over the private network
#   Anything else
ufw --force enable
ufw status verbose
