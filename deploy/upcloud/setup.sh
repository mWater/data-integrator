#!/usr/bin/env bash
# One-shot provisioning for a throwaway test server on a fresh Ubuntu 24.04 VM
# (written for UpCloud, but nothing here is UpCloud-specific). Installs the full
# stack from Quickstart.md and leaves the server running as a systemd service.
# The app is published only through a Cloudflare tunnel (cloudflare-tunnel.sh),
# so no web ports are opened.
#
# Run as root:
#   ADMIN_EMAIL=you@example.org ./setup.sh
#
# Configuration (environment variables):
#   ADMIN_EMAIL          (required) first admin account; password is printed once at the end
#   OPENROUTER_API_KEY   (optional) enables the designer agent
#   ANTHROPIC_API_KEY    (optional) alternative agent provider
#   REPO_URL             (optional) git URL to clone if /opt/data-integrator doesn't exist
#                        yet; for a private repo, rsync your checkout there instead
#   REPO_REF             (optional) branch/tag to clone, default main
#   GVISOR_RELEASE       default 20260803.0; gVisor release whose runsc is installed
#   CLOUDFLARE_TUNNEL_TOKEN (optional) installs the Cloudflare tunnel at the end;
#                        without it, run cloudflare-tunnel.sh later
#   SETUP_FIREWALL       default 1; ufw allowing only SSH (the app itself listens
#                        on all interfaces, so this keeps :8080 private)
set -euo pipefail

ADMIN_EMAIL=${ADMIN_EMAIL:?set ADMIN_EMAIL=you@example.org}
REPO_REF=${REPO_REF:-main}
SETUP_FIREWALL=${SETUP_FIREWALL:-1}
APP_DIR=/opt/data-integrator
APP_USER=integrator
DATA_DIR=/var/lib/data-integrator
ENV_FILE=/etc/data-integrator/env
GVISOR_RELEASE=${GVISOR_RELEASE:-20260803.0}
export DEBIAN_FRONTEND=noninteractive

echo "==> Base packages"
apt-get update -q
apt-get install -qy curl git ca-certificates gnupg openssl gdal-bin \
  podman uidmap slirp4netns passt nftables \
  postgresql-16 postgresql-16-postgis-3

echo "==> Node.js 22 + pnpm"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -qy nodejs
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable pnpm

echo "==> gVisor (runsc)"
if [ ! -x /usr/local/bin/runsc ]; then
  arch=$(uname -m)
  # A pinned release keeps every host on the same sandbox runtime; releases
  # after this one publish a tarball instead of the bare runsc binary
  url=https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${arch}
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/runsc" "$url/runsc"
  curl -fsSL -o "$tmp/runsc.sha512" "$url/runsc.sha512"
  (cd "$tmp" && sha512sum -c runsc.sha512)
  install -m 0755 "$tmp/runsc" /usr/local/bin/runsc
  rm -rf "$tmp"
fi

echo "==> PostgreSQL database"
systemctl enable --now postgresql
# A host provisioned under an earlier name keeps its database; refuse rather
# than create an empty second one beside it and switch the env to that
if [ -f "$ENV_FILE" ]; then
  current_db=$(sed -n 's|^DATABASE_URL=.*/\([^/?]*\).*|\1|p' "$ENV_FILE")
  if [ -n "$current_db" ] && [ "$current_db" != "integrator" ]; then
    echo "ERROR: $ENV_FILE points at database '$current_db', not 'integrator'." >&2
    echo "Rename it first (ALTER DATABASE $current_db RENAME TO integrator, and the role likewise)" >&2
    echo "or remove the DATABASE_URL line to provision a fresh database." >&2
    exit 1
  fi
fi
DB_PASS=$(openssl rand -hex 16)
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='integrator'" | grep -q 1 ||
  sudo -u postgres psql -c "CREATE USER integrator PASSWORD '${DB_PASS}'"
sudo -u postgres psql -c "ALTER USER integrator PASSWORD '${DB_PASS}'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='integrator'" | grep -q 1 ||
  sudo -u postgres createdb -O integrator integrator
sudo -u postgres psql -d integrator -c "CREATE EXTENSION IF NOT EXISTS postgis"
# Migrations run as the unprivileged integrator user, so the superuser-only parts
# happen here: postgis_raster is not a trusted extension, and 0006 needs the
# sql_engine role to exist (ADMIN OPTION lets that migration grant it onward).
sudo -u postgres psql -d integrator -c "CREATE EXTENSION IF NOT EXISTS postgis_raster"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sql_engine'" | grep -q 1 ||
  sudo -u postgres psql -c "CREATE ROLE sql_engine NOLOGIN"
sudo -u postgres psql -c "GRANT sql_engine TO integrator WITH ADMIN OPTION"

echo "==> App user"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
APP_UID=$(id -u "$APP_USER")
loginctl enable-linger "$APP_USER"

echo "==> Source tree"
if [ ! -d "$APP_DIR/.git" ]; then
  if [ -n "${REPO_URL:-}" ]; then
    git clone --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
  else
    echo "ERROR: $APP_DIR is not a git checkout and REPO_URL is not set." >&2
    echo "Either set REPO_URL, or rsync a checkout to $APP_DIR first, e.g. from your machine:" >&2
    echo "  rsync -a --exclude node_modules --exclude .git/hooks ./ root@<ip>:$APP_DIR/" >&2
    exit 1
  fi
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

as_app() {
  sudo -H -u "$APP_USER" env XDG_RUNTIME_DIR="/run/user/$APP_UID" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "cd $APP_DIR && $*"
}

echo "==> Build (pnpm + runtime images; this is the slow part)"
as_app "pnpm install --frozen-lockfile"
as_app "pnpm -r build"
as_app "podman build -t localhost/integrator-runtime-python:dev runtimes/python/"
as_app "podman build -t localhost/integrator-runtime-node:dev runtimes/node/"

echo "==> Environment file"
mkdir -p "$DATA_DIR"/{raster-store,work,tile-cache} /etc/data-integrator
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
# Out-db raster SQL: Postgres reads the COGs directly (postgres user needs
# traverse+read on the store) and the out-db settings are superuser-set
chmod 755 "$DATA_DIR" "$DATA_DIR"/raster-store
setfacl -R -d -m u:postgres:rX "$DATA_DIR"/raster-store 2>/dev/null || true
setfacl -R -m u:postgres:rX "$DATA_DIR"/raster-store 2>/dev/null || true
sudo -u postgres psql -c "ALTER DATABASE integrator SET postgis.enable_outdb_rasters = on" || true
sudo -u postgres psql -c "ALTER DATABASE integrator SET postgis.gdal_enabled_drivers = 'ENABLE_ALL'" || true
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
DATABASE_URL=postgres://integrator:${DB_PASS}@127.0.0.1:5432/integrator
PORT=8080
RASTER_STORE_PATH=${DATA_DIR}/raster-store
WORK_ROOT=${DATA_DIR}/work
TILE_CACHE_PATH=${DATA_DIR}/tile-cache
INTEGRATOR_SECRET_KEY=$(openssl rand -base64 32)
EOF
  [ -n "${OPENROUTER_API_KEY:-}" ] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" >> "$ENV_FILE"
  [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> "$ENV_FILE"
else
  # keep the existing file (and its secret key), but refresh the DB password we just set
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://integrator:${DB_PASS}@127.0.0.1:5432/integrator|" "$ENV_FILE"
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

echo "==> Migrate + admin user"
run_cli() {
  sudo -H -u "$APP_USER" env XDG_RUNTIME_DIR="/run/user/$APP_UID" \
    bash -c "set -a; . $ENV_FILE; set +a; cd $APP_DIR && node apps/server/dist/cli.js $*"
}
run_cli migrate
ADMIN_OUTPUT=$(run_cli user add "$ADMIN_EMAIL" admin 2>&1) || ADMIN_OUTPUT="(user add failed - probably already exists: $ADMIN_OUTPUT)"

echo "==> systemd service"
cat > /etc/systemd/system/data-integrator.service <<EOF
[Unit]
Description=mWater Data Integrator test server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=${APP_USER}
EnvironmentFile=${ENV_FILE}
Environment=XDG_RUNTIME_DIR=/run/user/${APP_UID}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node apps/server/dist/cli.js serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
APP_USER="$APP_USER" bash "$APP_DIR/deploy/upcloud/harden.sh"
systemctl enable --now data-integrator

if [ "$SETUP_FIREWALL" = "1" ]; then
  # The tunnel dials out, so nothing but SSH needs to be reachable
  echo "==> Firewall (SSH only)"
  apt-get install -qy ufw
  ufw allow OpenSSH
  ufw --force enable
fi

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  CLOUDFLARE_TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" bash "$APP_DIR/deploy/upcloud/cloudflare-tunnel.sh"
  NEXT=" Served at the Cloudflare tunnel's public hostname."
else
  NEXT=" Not public yet: install the Cloudflare tunnel (deploy/upcloud/README.md).
 Until then: ssh -L 8080:127.0.0.1:8080 root@<this host>, then http://localhost:8080"
fi

echo
echo "============================================================"
echo " Done.${NEXT:+
$NEXT}"
echo
echo " Admin account:"
echo "   ${ADMIN_OUTPUT}"
echo
echo " Service:  systemctl status data-integrator"
echo " Logs:     journalctl -u data-integrator -f"
echo "============================================================"
