#!/usr/bin/env bash
# Post-provisioning configuration that would otherwise be clicked through the UI:
# users, default area of interest, site title, library installs and first runs.
#   AOI=KEN USERS_FILE=/root/users.txt bash /opt/data-integrator/deploy/configure.sh
#
# Run as root on a host provisioned by setup.sh; safe to re-run (users are
# created once, passwords and the AOI are re-applied, installs are upserts).
#
# Configuration (environment variables):
#   AOI            ISO3 country code for the default area of interest (bbox +
#                  outline from the built-in country list), "global" to clear
#                  it so integrations use their full source extent, or unset
#                  to leave the current setting alone
#   USERS_FILE     (optional) file of "email<space>password[<space>role]" lines,
#                  role admin (default) | editor | viewer; blank lines and #
#                  comments ignored. Passwords may contain spaces: everything
#                  after the email up to a trailing role word is the password
#   SITE_TITLE     (optional) home page title, e.g. "Data Integrator Kenya"
#   SKIP_LIBRARY   (optional) space-separated library entry ids to leave uninstalled
#   INSTALL_LIBRARY default 1; set 0 to skip library installs entirely
#   RUN            default 1; queue a first run of every installed entry, which
#                  the service's scheduler workers drain in the background
#                  (watch progress on the Runs page or in journalctl -u data-integrator)
set -euo pipefail

AOI=${AOI:-}
USERS_FILE=${USERS_FILE:-}
SITE_TITLE=${SITE_TITLE:-}
SKIP_LIBRARY=${SKIP_LIBRARY:-}
INSTALL_LIBRARY=${INSTALL_LIBRARY:-1}
RUN=${RUN:-1}
APP_DIR=/opt/data-integrator
APP_USER=integrator
ENV_FILE=/etc/data-integrator/env
APP_UID=$(id -u "$APP_USER")

run_cli() {
  sudo -H -u "$APP_USER" env XDG_RUNTIME_DIR="/run/user/$APP_UID" \
    bash -c "set -a; . $ENV_FILE; set +a; cd $APP_DIR && node apps/server/dist/cli.js $*"
}

# Settings are plain jsonb rows; the CLI has no settings command, so write
# them directly and let `migrate` rebuild the AOI shape (it always does).
# Values travel as psql variables (:'name' quotes them) in SQL read from stdin.
psql_app() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt -d integrator "$@"
}

echo "==> Users"
if [ -n "$USERS_FILE" ]; then
  existing=$(run_cli user list | awk '{print $1}')
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    [ -z "${line// /}" ] && continue
    email=${line%% *}
    rest=${line#* }
    role=admin
    last=${rest##* }
    case "$last" in
      admin|editor|viewer) role=$last; rest=${rest% *} ;;
    esac
    password=$rest
    if ! grep -qx "$email" <<<"$existing"; then
      run_cli user add "$email" "$role" >/dev/null
      echo "created $email ($role)"
    else
      echo "exists  $email"
    fi
    printf '%s\n' "$password" | run_cli user passwd "$email" 2>/dev/null
  done < "$USERS_FILE"
else
  echo "(no USERS_FILE; skipped)"
fi

if [ -z "$AOI" ]; then
  echo "==> Default area of interest: (unchanged)"
elif [ "$AOI" = "global" ]; then
  echo "==> Default area of interest: global"
  psql_app -c "DELETE FROM app.settings WHERE key = 'default_aoi'"
else
  echo "==> Default area of interest: $AOI"
  aoi_json=$(cd "$APP_DIR" && node -e '
    import("./apps/server/dist/countries.js").then(m => {
      const c = m.COUNTRIES.find(c => c.iso3 === process.argv[1].toUpperCase())
      if (!c) { console.error("Unknown country code " + process.argv[1]); process.exit(1) }
      console.log(JSON.stringify({ bbox: c.bbox, countries: [c.iso3], name: c.name }))
    })' "$AOI")
  psql_app -v aoi="$aoi_json" <<'SQL'
INSERT INTO app.settings (key, value) VALUES ('default_aoi', :'aoi'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
SQL
  echo "$aoi_json"
fi
# migrate is a no-op on an up-to-date schema but always rebuilds data.aoi
if [ -n "$AOI" ]; then run_cli migrate >/dev/null; fi

if [ -n "$SITE_TITLE" ]; then
  echo "==> Site title: $SITE_TITLE"
  psql_app -v title="$SITE_TITLE" <<'SQL'
INSERT INTO app.settings (key, value) VALUES ('site_title', to_jsonb(:'title'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
SQL
fi

if [ "$INSTALL_LIBRARY" = "1" ]; then
  echo "==> Library"
  for dir in "$APP_DIR"/library/integrations/*/; do
    id=$(basename "$dir")
    case " $SKIP_LIBRARY " in
      *" $id "*) echo "skip    $id"; continue ;;
    esac
    run_cli library-install "$id"
  done
fi

# Settings are read per request, so no restart is needed; the service just
# has to be up for the changes to show (and to drain the run queue)
systemctl is-active --quiet data-integrator || systemctl restart data-integrator

if [ "$INSTALL_LIBRARY" = "1" ] && [ "$RUN" = "1" ]; then
  echo "==> Queue first runs"
  # The one-queued index makes this idempotent; the scheduler's workers claim
  # queued rows whatever their trigger
  psql_app -c "INSERT INTO app.runs (integration_id, trigger, status)
               SELECT id, 'manual', 'queued' FROM app.integrations
               WHERE enabled AND status = 'ready'
                 AND id NOT IN (SELECT integration_id FROM app.runs WHERE status IN ('queued', 'running'))
               ORDER BY id"
  psql_app -c "SELECT integration_id || '  ' || status FROM app.runs WHERE status IN ('queued', 'running') ORDER BY integration_id"
fi

echo
echo "Done. Users:"
run_cli user list
