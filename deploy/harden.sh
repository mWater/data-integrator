#!/usr/bin/env bash
# Host guards for a Data Integrator host. Idempotent; setup.sh and update.sh run
# it on every provisioning and update, or run it yourself as root:
#   bash /opt/data-integrator/deploy/harden.sh
#
# Why each guard exists: job sandboxes and map tile renders are memory-hungry
# and small hosts run out of RAM. When the kernel's OOM killer picks the app
# user's systemd manager (user@<uid>.service), /run/user/<uid> disappears,
# rootless podman stops working, and the server keeps running with its
# scheduler disabled until someone notices.
#
# Configuration (environment variables):
#   APP_USER   default integrator
#   SWAP_GB    default 4; 0 skips the swapfile
set -euo pipefail

APP_USER=${APP_USER:-integrator}
SWAP_GB=${SWAP_GB:-4}
APP_UID=$(id -u "$APP_USER")

echo "--> swap"
if [ "$SWAP_GB" != "0" ] && [ ! -f /swapfile ]; then
  # Swap turns a memory spike into slowness instead of a kill
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "--> user manager survives OOM"
# The kernel must kill a job sandbox, never the manager that owns the runtime dir
mkdir -p /etc/systemd/system/user@.service.d
cat > /etc/systemd/system/user@.service.d/oom.conf <<'EOF'
[Service]
OOMScoreAdjust=-1000
EOF

echo "--> service pulls the user manager"
# A service restart (crash, OOM stop, deploy) brings the manager back with it
mkdir -p /etc/systemd/system/data-integrator.service.d
cat > /etc/systemd/system/data-integrator.service.d/user-manager.conf <<EOF
[Unit]
Wants=user@${APP_UID}.service
After=user@${APP_UID}.service
EOF

echo "--> unattended-upgrades leaves the service alone"
# needrestart would bounce the service mid-run whenever libc or openssl
# updates; the next deploy restarts it anyway
mkdir -p /etc/needrestart/conf.d
cat > /etc/needrestart/conf.d/data-integrator.conf <<'EOF'
$nrconf{override_rc}{qr(^data-integrator\.service$)} = 0;
$nrconf{override_rc}{qr(^user@\d+\.service$)} = 0;
EOF

systemctl daemon-reload
loginctl enable-linger "$APP_USER"
systemctl start "user@${APP_UID}.service"
