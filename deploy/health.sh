#!/usr/bin/env bash
# Read-only health report for a Data Integrator host, printed as a few indented
# lines; exit status 1 when anything needs attention, so cron can alert. As root:
#   bash /opt/data-integrator/deploy/health.sh   (or: ssh root@<host> bash -s < deploy/health.sh)
#
# Environment:
#   APP_USER      default integrator
#   APP_DIR       default /opt/data-integrator
#   EXTRA_UNITS   (optional) space-separated systemd units to report on too, e.g.
#                 a tunnel or proxy in front of the app; one not installed is skipped
#   HEALTH_COLOR  default 0; 1 colours the output
set -uo pipefail

APP_USER=${APP_USER:-integrator}
APP_DIR=${APP_DIR:-/opt/data-integrator}
APP_UID=$(id -u "$APP_USER" 2>/dev/null || echo 1000)
problems=()

# Colour only when the caller's stdout is a terminal (passed through as HEALTH_COLOR=1)
if [ "${HEALTH_COLOR:-0}" = "1" ]; then RED=$'\e[31m'; GREEN=$'\e[32m'; DIM=$'\e[2m'; OFF=$'\e[0m'; else RED=; GREEN=; DIM=; OFF=; fi
bad() { problems+=("$1"); printf '%s' "$RED$1$OFF"; }
good() { printf '%s' "$GREEN$1$OFF"; }
state() { # label unit → coloured "label state"
  local s; s=$(systemctl is-active "$2" 2>/dev/null || true)
  if [ "$s" = "active" ]; then printf '%s ' "$1 $(good active)"; else printf '%s ' "$1 $(bad "${s:-missing}")"; fi
}

build=$(git -c safe.directory='*' -C "$APP_DIR" log -1 --format=%h 2>/dev/null || echo "?")
since=$(systemctl show -p ActiveEnterTimestamp --value data-integrator 2>/dev/null)
printf '  %sbuild %s, service since %s%s\n' "$DIM" "$build" "${since:-never}" "$OFF"

# Services
printf '  '
state service data-integrator
state "user manager" "user@${APP_UID}.service"
# The reverse proxy setup.sh installs with PUBLIC_HOSTNAME, and any extra units
for unit in caddy ${EXTRA_UNITS:-}; do
  unit=${unit%.service}
  if systemctl list-unit-files "$unit.service" >/dev/null 2>&1; then state "$unit" "$unit.service"; fi
done
if sudo -u postgres psql -qAt -d integrator -c 'SELECT 1' >/dev/null 2>&1; then printf 'db %s ' "$(good ok)"; else printf 'db %s ' "$(bad down)"; fi
if [ -n "$since" ]; then
  sched=$(journalctl -u data-integrator --since "$since" --no-pager 2>/dev/null | grep -o 'Scheduler running\|No job runner available' | head -1)
  case "$sched" in
    "Scheduler running") printf 'scheduler %s' "$(good running)" ;;
    "No job runner"*) printf 'scheduler %s' "$(bad disabled)" ;;
    *) printf 'scheduler %s' "$(bad unknown)" ;;
  esac
fi
printf '\n'

# Host
read -r mem_total mem_avail <<<"$(free -m | awk 'NR==2{print $2, $7}')"
swap=$(swapon --show --noheadings 2>/dev/null | awk '{print $3}' | head -1)
disk=$(df -h /var/lib/data-integrator 2>/dev/null | awk 'NR==2{print $5}')
disk_pct=${disk%\%}
newest=$(ls /boot/vmlinuz-* 2>/dev/null | sort -V | tail -1 | sed 's#.*vmlinuz-##')
printf '  ram %s MB (%s free) | swap %s | disk %s | up %s | kernel %s\n' \
  "$mem_total" "$mem_avail" \
  "$( [ -n "$swap" ] && echo "$swap" || bad none )" \
  "$( [ "${disk_pct:-0}" -ge 85 ] && bad "$disk" || echo "$disk" )" \
  "$(uptime -p | sed 's/up //')" \
  "$( [ "$(uname -r)" = "$newest" ] && echo current || echo "$DIM$(uname -r), $newest pending reboot$OFF" )"
[ "${mem_avail:-0}" -lt 1024 ] && bad "only ${mem_avail} MB free" >/dev/null

# Runs
q() { sudo -u postgres psql -qAt -d integrator -c "$1" 2>/dev/null; }
read -r queued running ok24 failed24 <<<"$(q "SELECT count(*) FILTER (WHERE status='queued'), count(*) FILTER (WHERE status='running'),
  count(*) FILTER (WHERE status='succeeded' AND scheduled_at > now() - interval '24 hours'),
  count(*) FILTER (WHERE status IN ('failed','timeout') AND scheduled_at > now() - interval '24 hours') FROM app.runs" | tr '|' ' ')"
stale=$(q "SELECT count(*) FROM app.runs WHERE status='running' AND heartbeat_at < now() - interval '2 minutes'")
printf '  runs: %s queued, %s running%s, last 24h %s ok / %s failed\n' \
  "${queued:-?}" "${running:-?}" \
  "$( [ "${stale:-0}" -gt 0 ] && printf ' (%s)' "$(bad "$stale stale heartbeat")" )" \
  "${ok24:-?}" "$( [ "${failed24:-0}" -gt 0 ] && echo "$RED${failed24}$OFF" || echo "${failed24:-?}" )"

# Enabled integrations whose latest run failed, oldest first
while IFS='|' read -r id age err; do
  [ -n "$id" ] || continue
  bad "FAILING" >/dev/null
  printf '  %sFAILING%s %-28s %-8s %s\n' "$RED" "$OFF" "$id" "$age" "$err"
done <<<"$(q "SELECT r.integration_id,
    CASE WHEN age < interval '1 hour' THEN extract(minute from age)::int || 'm ago'
         WHEN age < interval '1 day' THEN extract(hour from age)::int || 'h ago'
         ELSE extract(day from age)::int || 'd ago' END,
    left(regexp_replace(coalesce(r.error, ''), E'\\\\s+', ' ', 'g'), 90)
  FROM (SELECT DISTINCT ON (integration_id) integration_id, status, error, now() - coalesce(finished_at, scheduled_at) AS age
        FROM app.runs WHERE integration_id IS NOT NULL ORDER BY integration_id, scheduled_at DESC) r
  JOIN app.integrations i ON i.id = r.integration_id AND i.enabled AND i.status = 'ready'
  WHERE r.status IN ('failed', 'timeout') ORDER BY age DESC")"

[ ${#problems[@]} -eq 0 ]
