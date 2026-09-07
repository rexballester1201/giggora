#!/usr/bin/env bash
#
# Giggora — firewall for the PUBLIC RPC host.
#
# This is the only host that faces the internet, and only on 443. Besu itself
# binds to 127.0.0.1; Caddy is the sole public listener.
#
set -euo pipefail

PEERS="${PEERS:?set PEERS to the validator IPs}"
P2P_PORT="${P2P_PORT:-30303}"
SSH_FROM="${SSH_FROM:?set SSH_FROM to your admin IP or CIDR}"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing

ufw allow from "$SSH_FROM" to any port 22 proto tcp comment 'admin ssh'

# Public TLS. Port 80 is open only so ACME HTTP-01 can complete; Caddy redirects.
ufw allow 80/tcp  comment 'acme http-01'
ufw allow 443/tcp comment 'giggora rpc (tls)'

# p2p to the validators only.
for ip in $PEERS; do
  ufw allow from "$ip" to any port "$P2P_PORT" proto tcp comment "giggora p2p $ip"
  ufw allow from "$ip" to any port "$P2P_PORT" proto udp comment "giggora disc $ip"
done

# NEVER open 8545/8546 directly. TLS termination and rate limiting live in Caddy;
# exposing Besu directly bypasses both.
ufw --force enable
ufw status verbose
