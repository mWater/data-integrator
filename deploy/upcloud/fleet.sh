#!/usr/bin/env bash
# Drives setup.sh / configure-demo.sh / push.sh across a fleet of servers
# from a hosts file, in parallel, with one log per host. Run locally from
# anywhere in the checkout:
#
#   ./deploy/upcloud/fleet.sh setup      hosts.txt   # provision every host (rsync + setup.sh)
#   ./deploy/upcloud/fleet.sh configure  hosts.txt   # users, AOI, title, library (+ first runs)
#   ./deploy/upcloud/fleet.sh users      hosts.txt   # (re)apply the users file only: new users added, passwords reset
#   ./deploy/upcloud/fleet.sh push       hosts.txt   # day-2 update of every host
#   ./deploy/upcloud/fleet.sh tunnel     hosts.txt <name> <cloudflare tunnel token>
#   ./deploy/upcloud/fleet.sh status     hosts.txt   # service state + run queue per host
#   ./deploy/upcloud/fleet.sh health     hosts.txt   # one health block per host; exit 1 if any needs attention
#   ./deploy/upcloud/fleet.sh secrets    hosts.txt <name>   # copy that host's integration secrets to the others
#   ./deploy/upcloud/fleet.sh rerun      hosts.txt   # queue a run wherever the latest run failed
#   ./deploy/upcloud/fleet.sh install    hosts.txt <id> [<id>...]   # install or update library entries (skips nolib hosts; updates keep the host's AOI, schedule, limits) and queue a first run of new ones
#   ./deploy/upcloud/fleet.sh cli        hosts.txt <args...>   # run the server CLI on every host, e.g. backfill-cell-sizes
#
# hosts.txt: one host per line, "name ip aoi [nolib]"; # comments allowed.
#   kenya     94.237.1.2   KEN
#   internal  94.237.1.5   global  nolib
# name becomes the site title ("Data Integrator Kenya"), aoi is an ISO3 code or
# "global", nolib installs nothing from the library.
#
# Environment:
#   ADMIN_EMAIL         (setup) first admin; default clayton@mwater.co
#   OPENROUTER_API_KEY  (setup) passed through to the boxes, seeding AI Settings; unset = AI off
#   USERS_FILE          (configure) "email password [role]" lines; default .dev/conference-users.txt
#   IMAGES=1            (push) also rebuild the sandbox images
#   LOG_DIR             default .dev/fleet-logs
set -euo pipefail

cd "$(dirname "$0")/../.."
HERE=deploy/upcloud
cmd=${1:?usage: fleet.sh setup|configure|push|tunnel|status|cli hosts.txt [args]}
hosts_file=${2:?hosts file required}
shift 2
ADMIN_EMAIL=${ADMIN_EMAIL:-clayton@mwater.co}
USERS_FILE=${USERS_FILE:-.dev/conference-users.txt}
LOG_DIR=${LOG_DIR:-.dev/fleet-logs}
mkdir -p "$LOG_DIR"
SSH="ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

# Parsed hosts: name ip aoi flags
hosts=()
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%%#*}
  [ -z "${line// /}" ] && continue
  hosts+=("$line")
done < "$hosts_file"
[ ${#hosts[@]} -gt 0 ] || { echo "no hosts in $hosts_file" >&2; exit 1; }

title_for() { local n=$1; echo "Data Integrator ${n^}"; }

# Runs one host's step in the background, logging to $LOG_DIR/<name>.<cmd>.log
each_host() {
  local fn=$1 pids=() names=()
  for h in "${hosts[@]}"; do
    read -r name ip aoi flags <<<"$h"
    log="$LOG_DIR/$name.$cmd.log"
    echo "==> $name ($ip) -> $log"
    ( $fn "$name" "$ip" "$aoi" "${flags:-}" ) >"$log" 2>&1 &
    pids+=($!); names+=("$name")
  done
  local rc=0 i
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then echo "ok    ${names[$i]}"; else echo "FAIL  ${names[$i]}  (see $LOG_DIR/${names[$i]}.$cmd.log)"; rc=1; fi
  done
  return $rc
}

# Fresh VMs can accept TCP before sshd is ready; give them a few minutes
wait_for_ssh() {
  local ip=$1 i
  for i in $(seq 1 30); do
    $SSH -o ConnectTimeout=10 "root@$ip" true 2>/dev/null && return 0
    sleep 10
  done
  echo "ssh to $ip never came up" >&2
  return 1
}

do_setup() {
  local name=$1 ip=$2
  wait_for_ssh "$ip"
  rsync -a -e "$SSH" --exclude node_modules --exclude .git/hooks ./ "root@$ip:/opt/data-integrator/"
  $SSH "root@$ip" "ADMIN_EMAIL=$ADMIN_EMAIL OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-} bash /opt/data-integrator/$HERE/setup.sh"
}

do_configure() {
  local name=$1 ip=$2 aoi=$3 flags=$4 lib=1
  case " $flags " in *" nolib "*) lib=0 ;; esac
  scp -q -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$USERS_FILE" "root@$ip:/root/users.txt"
  $SSH "root@$ip" "AOI=$aoi SITE_TITLE='$(title_for "$name")' USERS_FILE=/root/users.txt INSTALL_LIBRARY=$lib bash /opt/data-integrator/$HERE/configure-demo.sh"
}

do_users() {
  local name=$1 ip=$2
  scp -q -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$USERS_FILE" "root@$ip:/root/users.txt"
  $SSH "root@$ip" "USERS_FILE=/root/users.txt INSTALL_LIBRARY=0 bash /opt/data-integrator/$HERE/configure-demo.sh"
}

do_push() {
  local name=$1 ip=$2
  IMAGES=${IMAGES:-0} "$HERE/push.sh" "root@$ip"
}

# The server CLI on a host, as the app user with its env; stdin passes through
remote_cli() {
  local ip=$1; shift
  $SSH "root@$ip" "sudo -H -u integrator env XDG_RUNTIME_DIR=/run/user/\$(id -u integrator) bash -c 'set -a; . /etc/data-integrator/env; set +a; cd /opt/data-integrator && node apps/server/dist/cli.js $*'"
}

ip_of() {
  local want=$1 h name ip _
  for h in "${hosts[@]}"; do
    read -r name ip _ <<<"$h"
    [ "$name" = "$want" ] && { echo "$ip"; return 0; }
  done
  echo "no host named $want in $hosts_file" >&2
  return 1
}

do_rerun() {
  local name=$1 ip=$2
  $SSH "root@$ip" "sudo -u postgres psql -qAt -d integrator -c \"
    INSERT INTO app.runs (integration_id, trigger, status)
    SELECT i.id, 'manual', 'queued' FROM app.integrations i
    WHERE i.enabled AND i.status = 'ready'
      AND (SELECT r.status FROM app.runs r WHERE r.integration_id = i.id ORDER BY r.scheduled_at DESC LIMIT 1) IN ('failed', 'timeout')
    RETURNING integration_id || '  queued'\""
}

do_install() {
  local name=$1 ip=$2 flags=$4 id
  case " $flags " in *" nolib "*) echo "nolib host, skipped"; return 0 ;; esac
  for id in "${INSTALL_IDS[@]}"; do
    existed=$($SSH "root@$ip" "sudo -u postgres psql -qAt -d integrator -c \"SELECT 1 FROM app.integrations WHERE id = '$id'\"")
    remote_cli "$ip" library-install "$id"
    # An update keeps its schedule; only a new install gets a first run now
    [ -n "$existed" ] && continue
    $SSH "root@$ip" "sudo -u postgres psql -qAt -d integrator -c \"
      INSERT INTO app.runs (integration_id, trigger, status) VALUES ('$id', 'manual', 'queued')
      ON CONFLICT DO NOTHING RETURNING integration_id || '  queued'\""
  done
}

do_cli() {
  local name=$1 ip=$2
  remote_cli "$ip" "${CLI_ARGS[@]}"
}

do_status() {
  local name=$1 ip=$2
  $SSH "root@$ip" "systemctl is-active data-integrator; sudo -u postgres psql -qAt -d integrator -c \"SELECT status || ' ' || count(*) FROM app.runs GROUP BY status ORDER BY status\"; df -h /var/lib/data-integrator | tail -1"
}

# Runs the read-only health report on every host in parallel and prints the
# blocks in hosts-file order; exits 1 when any host reported a problem
do_health() {
  local color=0 tmp pids=() names=() ips=() rc=0 i
  [ -t 1 ] && color=1
  tmp=$(mktemp -d)
  for h in "${hosts[@]}"; do
    read -r name ip _ <<<"$h"
    ( $SSH -o ConnectTimeout=15 "root@$ip" "HEALTH_COLOR=$color bash -s" < "$HERE/health-remote.sh" > "$tmp/$name" 2>&1
      code=$?
      [ $code -eq 255 ] && echo "  unreachable over ssh" >> "$tmp/$name"
      exit $code ) &
    pids+=($!); names+=("$name"); ips+=("$ip")
  done
  for i in "${!pids[@]}"; do
    wait "${pids[$i]}" || rc=1
    echo "== ${names[$i]} (${ips[$i]})"
    cat "$tmp/${names[$i]}"
  done
  rm -rf "$tmp"
  return $rc
}

case "$cmd" in
  setup)     each_host do_setup ;;
  configure) each_host do_configure ;;
  users)     each_host do_users ;;
  push)      each_host do_push ;;
  rerun)     each_host do_rerun ;;
  install)
    [ $# -gt 0 ] || { echo "install needs one or more library entry ids" >&2; exit 1; }
    for id in "$@"; do
      [ -d "library/integrations/$id" ] || { echo "no library entry $id" >&2; exit 1; }
    done
    INSTALL_IDS=("$@")
    each_host do_install ;;
  cli)
    [ $# -gt 0 ] || { echo "cli needs the CLI arguments to run" >&2; exit 1; }
    CLI_ARGS=("$@")
    each_host do_cli ;;
  secrets)
    # Plaintext travels source -> this machine -> targets over ssh, never to disk
    src=${1:?secrets needs <source host name>}
    src_ip=$(ip_of "$src")
    exported=$(remote_cli "$src_ip" secret export)
    echo "$exported" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const [i,s] of Object.entries(o))console.log(`  ${i}: ${Object.keys(s).join(", ")}`)'
    for h in "${hosts[@]}"; do
      read -r name ip _ <<<"$h"
      [ "$ip" = "$src_ip" ] && continue
      echo "==> $name ($ip)"
      printf '%s' "$exported" | remote_cli "$ip" secret import
    done ;;
  status)
    for h in "${hosts[@]}"; do
      read -r name ip _ <<<"$h"
      echo "== $name ($ip)"; do_status "$name" "$ip" || true
    done ;;
  health)
    do_health ;;
  tunnel)
    want=${1:?tunnel needs <name> <token>}; token=${2:?tunnel needs <name> <token>}
    for h in "${hosts[@]}"; do
      read -r name ip _ <<<"$h"
      [ "$name" = "$want" ] || continue
      $SSH "root@$ip" "CLOUDFLARE_TUNNEL_TOKEN=$token bash /opt/data-integrator/$HERE/cloudflare-tunnel.sh"
      exit
    done
    echo "no host named $want in $hosts_file" >&2; exit 1 ;;
  *) echo "unknown command $cmd" >&2; exit 1 ;;
esac
