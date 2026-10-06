#!/usr/bin/env bash
# Swap the Caddy + sslip.io front end for a Cloudflare Tunnel on a server
# provisioned by setup.sh, putting it on a real hostname (e.g.
# integrator-demo.mwater.co) with no inbound web ports at all: cloudflared
# dials out to Cloudflare and proxies to the app on 127.0.0.1:8080.
#
# One-time, in the Cloudflare Zero Trust dashboard (Networks -> Tunnels):
#   1. Create a tunnel (Cloudflared connector) and copy its token
#   2. On the tunnel's Public Hostname tab, add the hostname ->
#      HTTP://127.0.0.1:8080 (this also creates the DNS record)
#
# Then run as root on the server:
#   CLOUDFLARE_TUNNEL_TOKEN=eyJ... bash /opt/data-integrator/deploy/upcloud/cloudflare-tunnel.sh
#
# Safe to re-run; a new token replaces the old one. To go back to Caddy:
# cloudflared service uninstall, systemctl enable --now caddy, and reopen
# 80/443 in ufw.
set -euo pipefail

CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:?set CLOUDFLARE_TUNNEL_TOKEN=<token from the Zero Trust dashboard>}
export DEBIAN_FRONTEND=noninteractive

echo "==> cloudflared"
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
  apt-get install -qy /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi

echo "==> Tunnel service"
# service install refuses to overwrite an existing install, so drop it first
if [ -f /etc/systemd/system/cloudflared.service ]; then
  cloudflared service uninstall || true
  systemctl daemon-reload
fi
cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"

echo "==> Retire Caddy (Cloudflare terminates TLS now)"
if command -v caddy >/dev/null; then
  systemctl disable --now caddy || true
fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw delete allow 80/tcp || true
  ufw delete allow 443/tcp || true
fi

echo
echo "============================================================"
echo " Done. The tunnel connects outbound; only SSH remains open."
echo " URL: the Public Hostname configured on the tunnel."
echo
echo " Tunnel:   systemctl status cloudflared"
echo " Logs:     journalctl -u cloudflared -f"
echo "============================================================"
