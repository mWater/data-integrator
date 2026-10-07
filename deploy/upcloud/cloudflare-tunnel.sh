#!/usr/bin/env bash
# Publishes a server provisioned by setup.sh on its hostname (e.g.
# integrator-angola.mwater.co) through a Cloudflare Tunnel: cloudflared dials
# out to Cloudflare and proxies to the app on 127.0.0.1:8080, so the server
# keeps no inbound web ports. setup.sh runs this itself when given
# CLOUDFLARE_TUNNEL_TOKEN.
#
# One-time, in the Cloudflare Zero Trust dashboard (Networks -> Tunnels):
#   1. Create a tunnel (Cloudflared connector) and copy its token
#   2. On the tunnel's Public Hostname tab, add the hostname ->
#      HTTP://127.0.0.1:8080 (this also creates the DNS record)
#
# Then run as root on the server:
#   CLOUDFLARE_TUNNEL_TOKEN=eyJ... bash /opt/data-integrator/deploy/upcloud/cloudflare-tunnel.sh
#
# Safe to re-run; a new token replaces the old one.
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

echo
echo "============================================================"
echo " Done. The tunnel connects outbound; only SSH remains open."
echo " URL: the Public Hostname configured on the tunnel."
echo
echo " Tunnel:   systemctl status cloudflared"
echo " Logs:     journalctl -u cloudflared -f"
echo "============================================================"
