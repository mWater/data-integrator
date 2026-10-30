#!/usr/bin/env bash
# Provisions Data Integrator on a fresh Ubuntu 24.04 host as a systemd service.
# Run as root on the host; safe to re-run (keeps the env file and secret key):
#   ADMIN_EMAIL=you@example.org PUBLIC_HOSTNAME=integrator.example.org bash setup.sh
#
# Installs the stack from docs/Quickstart.md: Node 22 + pnpm, GDAL, rootless podman with
# the gVisor sandbox, PostgreSQL 16 + PostGIS. The source comes from REPO_URL,
# or from a checkout already copied to /opt/data-integrator, e.g. from your machine:
#   rsync -a --exclude node_modules --exclude .git/hooks ./ root@<host>:/opt/data-integrator/
#
# Configuration (environment variables):
#   ADMIN_EMAIL          (required) first admin account; password is printed once at the end
#   PUBLIC_HOSTNAME      (optional) DNS name already pointing at this host; installs
#                        Caddy as the TLS reverse proxy (Let's Encrypt certificate)
#                        and opens 80/443. Without it only SSH is reachable
#   OPENROUTER_API_KEY   (optional) seeds the AI provider in Settings on first start
#   ANTHROPIC_API_KEY    (optional) alternative provider, same seeding
#   REPO_URL             git URL cloned when /opt/data-integrator holds no checkout;
#                        default https://github.com/mWater/data-integrator.git; set
#                        it empty to insist on a copied checkout
#   REPO_REF             branch/tag to clone, default main
#   GVISOR_RELEASE       default 20260803.0; gVisor release whose runsc is installed
#   SETUP_FIREWALL       default 1; ufw allowing only SSH (plus 80/443 with
#                        PUBLIC_HOSTNAME). The app listens on all interfaces, so
#                        this keeps plain-HTTP :8080 private
set -euo pipefail

ADMIN_EMAIL=${ADMIN_EMAIL:?set ADMIN_EMAIL=you@example.org}
PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME:-}
REPO_URL=${REPO_URL-https://github.com/mWater/data-integrator.git}
REPO_REF=${REPO_REF:-main}
SETUP_FIREWALL=${SETUP_FIREWALL:-1}
APP_DIR=/opt/data-integrator
APP_USER=integrator
DATA_DIR=/var/lib/data-integrator
ENV_FILE=/etc/data-integrator/env
GVISOR_RELEASE=${GVISOR_RELEASE:-20260803.0}
export DEBIAN_FRONTEND=noninteractive

if [ -n "$PUBLIC_HOSTNAME" ] && ! [[ $PUBLIC_HOSTNAME =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "ERROR: PUBLIC_HOSTNAME must be a bare DNS name (no scheme, port or path), got '$PUBLIC_HOSTNAME'" >&2
  exit 1
fi

echo "==> Base packages"
apt-get update -q
apt-get install -qy curl git ca-certificates gnupg openssl gdal-bin acl \
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
# An env file that already points at another database keeps it; refuse rather
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
DATABASE_URL="postgres://integrator:${DB_PASS}@127.0.0.1:5432/integrator"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='integrator'" | grep -q 1 ||
  sudo -u postgres psql -c "CREATE USER integrator"
# The password goes over stdin: a command-line argument shows in process listings
sudo -u postgres psql -q -v ON_ERROR_STOP=1 <<SQL
ALTER USER integrator PASSWORD '${DB_PASS}';
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='integrator'" | grep -q 1 ||
  sudo -u postgres createdb -O integrator integrator
sudo -u postgres psql -d integrator -c "CREATE EXTENSION IF NOT EXISTS postgis"
# Migrations run as the unprivileged integrator user, so the superuser-only parts
# happen here: postgis_raster is not a trusted extension, and the schema
# migration needs the sql_engine role to exist (ADMIN OPTION lets it grant
# the role onward).
sudo -u postgres psql -d integrator -c "CREATE EXTENSION IF NOT EXISTS postgis_raster"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sql_engine'" | grep -q 1 ||
  sudo -u postgres psql -c "CREATE ROLE sql_engine NOLOGIN"
sudo -u postgres psql -c "GRANT sql_engine TO integrator WITH ADMIN OPTION"

echo "==> App user"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
APP_UID=$(id -u "$APP_USER")
loginctl enable-linger "$APP_USER"

echo "==> Source tree"
if [ ! -f "$APP_DIR/package.json" ]; then
  if [ -n "$REPO_URL" ]; then
    git clone --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
  else
    echo "ERROR: $APP_DIR holds no checkout and REPO_URL is empty." >&2
    echo "Either set REPO_URL, or rsync a checkout to $APP_DIR first, e.g. from your machine:" >&2
    echo "  rsync -a --exclude node_modules --exclude .git/hooks ./ root@<host>:$APP_DIR/" >&2
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
mkdir -p "$DATA_DIR"/{raster-store,work,tile-cache,file-store} /etc/data-integrator
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
# Out-db raster SQL: Postgres reads the COGs directly (postgres user needs
# traverse+read on the store) and the out-db settings are superuser-set
chmod 755 "$DATA_DIR" "$DATA_DIR"/raster-store
setfacl -R -d -m u:postgres:rX "$DATA_DIR"/raster-store 2>/dev/null || true
setfacl -R -m u:postgres:rX "$DATA_DIR"/raster-store 2>/dev/null || true
sudo -u postgres psql -c "ALTER DATABASE integrator SET postgis.enable_outdb_rasters = on" || true
sudo -u postgres psql -c "ALTER DATABASE integrator SET postgis.gdal_enabled_drivers = 'ENABLE_ALL'" || true
# Written with builtins only and created 0640 before any secret goes in, so
# neither the DB password nor the secret key is ever world-readable or in argv
if [ ! -f "$ENV_FILE" ]; then
  install -m 640 -o root -g "$APP_USER" /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
DATABASE_URL=${DATABASE_URL}
PORT=8080
RASTER_STORE_PATH=${DATA_DIR}/raster-store
WORK_ROOT=${DATA_DIR}/work
TILE_CACHE_PATH=${DATA_DIR}/tile-cache
FILE_STORE_PATH=${DATA_DIR}/file-store
INTEGRATOR_SECRET_KEY=$(openssl rand -base64 32)
EOF
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" >> "$ENV_FILE"; fi
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> "$ENV_FILE"; fi
else
  # Keep the existing file (and its secret key), but refresh the DB password just set
  tmp_env=$(mktemp "$ENV_FILE.XXXXXX")
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      DATABASE_URL=*) printf 'DATABASE_URL=%s\n' "$DATABASE_URL" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$ENV_FILE" > "$tmp_env"
  # Uploaded files belong with the data, not under the checkout the service runs in
  grep -q '^FILE_STORE_PATH=' "$tmp_env" || echo "FILE_STORE_PATH=${DATA_DIR}/file-store" >> "$tmp_env"
  mv "$tmp_env" "$ENV_FILE"
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
Description=Data Integrator
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
APP_USER="$APP_USER" bash "$APP_DIR/deploy/harden.sh"
systemctl enable data-integrator
# Restart rather than start: on a re-run the DB password above has changed
systemctl restart data-integrator

# The port the app listens on, as the service sees it
APP_PORT=$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)
APP_PORT=${APP_PORT:-8080}

if [ -n "$PUBLIC_HOSTNAME" ]; then
  echo "==> Caddy (HTTPS for $PUBLIC_HOSTNAME)"
  apt-get install -qy caddy
  # Caddy's limit must not undercut the app's own, or large uploads fail at
  # the proxy with a bare 413; the headroom covers request framing
  upload_mb=$(sed -n 's/^FILE_UPLOAD_MAX_MB=//p' "$ENV_FILE" | tail -1)
  [[ ${upload_mb:-} =~ ^[0-9]+$ ]] || upload_mb=100
  body_mb=$(( 10#$upload_mb + 10 ))
  cat > /etc/caddy/Caddyfile <<EOF
# Written by data-integrator deploy/setup.sh; re-running it overwrites this file
${PUBLIC_HOSTNAME} {
	request_body {
		max_size ${body_mb}MiB
	}
	reverse_proxy 127.0.0.1:${APP_PORT} {
		# The app marks its session cookie Secure only when this says https
		header_up X-Forwarded-Proto {scheme}
	}
}
EOF
  systemctl enable caddy
  systemctl reload-or-restart caddy
fi

if [ "$SETUP_FIREWALL" = "1" ]; then
  echo "==> Firewall"
  apt-get install -qy ufw
  ufw allow OpenSSH
  if [ -n "$PUBLIC_HOSTNAME" ]; then
    # 80 serves the ACME challenge and the redirect to HTTPS; 443/udp is HTTP/3
    ufw allow 80/tcp
    ufw allow 443
  fi
  ufw --force enable
fi

if [ -n "$PUBLIC_HOSTNAME" ]; then
  NEXT=" Served at https://${PUBLIC_HOSTNAME} once its DNS record points at this host
 (Caddy retries the certificate until then: journalctl -u caddy -f)."
else
  NEXT=" Not public: only SSH is reachable. Re-run with PUBLIC_HOSTNAME to serve over HTTPS.
 Until then: ssh -L 8080:127.0.0.1:${APP_PORT} root@<this host>, then http://localhost:8080"
fi

echo
echo "============================================================"
echo " Done."
echo "$NEXT"
echo
echo " Admin account:"
echo "   ${ADMIN_OUTPUT}"
echo
echo " Service:  systemctl status data-integrator"
echo " Logs:     journalctl -u data-integrator -f"
echo "============================================================"
