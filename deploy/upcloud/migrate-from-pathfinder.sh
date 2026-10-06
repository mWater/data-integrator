#!/usr/bin/env bash
# One-time move of a host provisioned under the Pathfinder name to the Data
# Integrator layout, so setup.sh, push.sh, fleet.sh and harden.sh work on it
# again. Idempotent: each step checks for the old name and skips when it is
# already gone, so a host with some pieces already renamed (or an interrupted
# run) is fine.
#
#   pathfinder.service            -> data-integrator.service
#   unix user/group pathfinder    -> integrator (same uid; home moves)
#   database + role pathfinder    -> integrator (fresh password in the env)
#   /opt/pathfinder               -> /opt/data-integrator
#   /etc/pathfinder/env           -> /etc/data-integrator/env
#   /var/lib/pathfinder           -> /var/lib/data-integrator
#   PATHFINDER_SECRET_KEY         -> INTEGRATOR_SECRET_KEY (same value)
#   site title "Pathfinder X"     -> "Data Integrator X"
#
# The app user's podman storage is reset (its paths embed the old home), so
# the runtime images must be rebuilt. Leaves the service stopped; then push:
#
#   ssh root@<ip> bash -s < deploy/upcloud/migrate-from-pathfinder.sh
#   IMAGES=1 ./deploy/upcloud/push.sh root@<ip>
#   (on the host) cli.js register-rasters --all   # out-db paths follow the store
set -euo pipefail

OLD=pathfinder
NEW_USER=integrator
NEW_DB=integrator
NEW_UNIT=data-integrator
NEW_APP=/opt/data-integrator
NEW_ETC=/etc/data-integrator
NEW_DATA=/var/lib/data-integrator
ENV_FILE=$NEW_ETC/env

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
cd /

echo "==> Preflight"
# A host first provisioned as Data Integrator can still hold that era's
# integrator database and role beside the live pathfinder ones. Refuse before
# changing anything; park the stale pair under another name first.
old_env=/etc/$OLD/env
[ -f "$old_env" ] || old_env=$ENV_FILE
live_db=$(sed -n 's|^DATABASE_URL=.*/\([^/?]*\).*|\1|p' "$old_env" 2>/dev/null || true)
live_role=$(sed -n 's|^DATABASE_URL=postgres://\([^:@]*\).*|\1|p' "$old_env" 2>/dev/null || true)
q1() { sudo -u postgres psql -qAt -c "$1"; }
if [ -n "$live_db" ] && [ "$live_db" != "$NEW_DB" ] && [ -n "$(q1 "SELECT 1 FROM pg_database WHERE datname = '$NEW_DB'")" ]; then
  echo "database $NEW_DB already exists beside the live $live_db; park it first, e.g." >&2
  echo "  sudo -u postgres psql -c 'ALTER DATABASE $NEW_DB RENAME TO ${NEW_DB}_pre_pathfinder'" >&2
  exit 1
fi
if [ -n "$live_role" ] && [ "$live_role" != "$NEW_USER" ] && [ -n "$(q1 "SELECT 1 FROM pg_roles WHERE rolname = '$NEW_USER'")" ]; then
  echo "role $NEW_USER already exists beside the live $live_role; park it first, e.g." >&2
  echo "  sudo -u postgres psql -c 'ALTER ROLE $NEW_USER RENAME TO ${NEW_USER}_pre_pathfinder'" >&2
  exit 1
fi

echo "==> Stop the old service"
if [ -f /etc/systemd/system/$OLD.service ]; then
  systemctl disable --now $OLD.service || true
  rm -rf /etc/systemd/system/$OLD.service /etc/systemd/system/$OLD.service.d
  rm -f /etc/needrestart/conf.d/$OLD.conf
  systemctl daemon-reload
fi

echo "==> Unix user $OLD -> $NEW_USER"
if id $OLD >/dev/null 2>&1; then
  if id $NEW_USER >/dev/null 2>&1; then
    echo "both $OLD and $NEW_USER exist; resolve by hand" >&2; exit 1
  fi
  uid=$(id -u $OLD)
  # Podman's storage database records absolute paths under the old home, so
  # it cannot follow the move; reset it while the old user still works
  sudo -H -u $OLD env XDG_RUNTIME_DIR=/run/user/$uid podman system reset --force || true
  loginctl disable-linger $OLD || true
  systemctl stop "user@$uid.service" || true
  pkill -KILL -u "$uid" || true
  sleep 1
  usermod -l $NEW_USER -d /home/$NEW_USER -m $OLD
  groupmod -n $NEW_USER $OLD
  sed -i "s/^$OLD:/$NEW_USER:/" /etc/subuid /etc/subgid
  rm -f /var/lib/systemd/linger/$OLD
  loginctl enable-linger $NEW_USER
fi

move_dir() {
  local from=$1 to=$2
  [ -e "$from" ] || return 0
  if [ -e "$to" ]; then
    # A half-moved host can have both; only an empty skeleton may be dropped
    if [ -n "$(find "$from" -type f -print -quit)" ]; then
      echo "both $from and $to exist and $from holds files; resolve by hand" >&2; exit 1
    fi
    rm -rf "$from"
  else
    mv "$from" "$to"
  fi
}

echo "==> Directories"
move_dir /opt/$OLD $NEW_APP
move_dir /etc/$OLD $NEW_ETC
move_dir /var/lib/$OLD $NEW_DATA
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE after the move; is this a provisioned host?" >&2; exit 1; }

echo "==> Database and role -> $NEW_DB"
url=$(sed -n 's|^DATABASE_URL=||p' "$ENV_FILE")
cur_user=$(printf '%s' "$url" | sed -n 's|^postgres://\([^:@]*\).*|\1|p')
cur_db=$(printf '%s' "$url" | sed -n 's|.*/\([^/?]*\)\(?.*\)\{0,1\}$|\1|p')
psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt "$@"; }
if [ -n "$cur_db" ] && [ "$cur_db" != "$NEW_DB" ]; then
  psql_su -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$cur_db' AND pid <> pg_backend_pid()" >/dev/null
  psql_su -c "ALTER DATABASE \"$cur_db\" RENAME TO $NEW_DB"
fi
if [ -n "$cur_user" ] && [ "$cur_user" != "$NEW_USER" ]; then
  psql_su -c "ALTER ROLE \"$cur_user\" RENAME TO $NEW_USER"
fi
# A rename can clear the password (MD5), and the URL changes anyway
db_pass=$(openssl rand -hex 16)
psql_su -c "ALTER ROLE $NEW_USER PASSWORD '$db_pass'"
# Home page titles were set per host as "Pathfinder <Country>"
psql_su -d $NEW_DB -c "UPDATE app.settings SET value = to_jsonb(replace(value #>> '{}', 'Pathfinder', 'Data Integrator')) WHERE key = 'site_title' AND value #>> '{}' LIKE '%Pathfinder%'"

echo "==> Environment file"
sed -i \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://$NEW_USER:$db_pass@127.0.0.1:5432/$NEW_DB|" \
  -e "s|^PATHFINDER_SECRET_KEY=|INTEGRATOR_SECRET_KEY=|" \
  -e "s|/var/lib/$OLD/|$NEW_DATA/|g" \
  "$ENV_FILE"
chown root:$NEW_USER "$ENV_FILE"
chmod 640 "$ENV_FILE"
chown -R $NEW_USER:$NEW_USER "$NEW_APP"

echo "==> Unit $NEW_UNIT (left stopped; push.sh starts it)"
uid=$(id -u $NEW_USER)
cat > /etc/systemd/system/$NEW_UNIT.service <<EOF
[Unit]
Description=mWater Data Integrator test server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=$NEW_USER
EnvironmentFile=$ENV_FILE
Environment=XDG_RUNTIME_DIR=/run/user/$uid
WorkingDirectory=$NEW_APP
ExecStart=/usr/bin/node apps/server/dist/cli.js serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $NEW_UNIT.service
systemctl start "user@$uid.service"

echo
echo "Done. Next: IMAGES=1 push.sh to this host, then register-rasters --all."
