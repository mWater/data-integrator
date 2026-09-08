#!/usr/bin/env bash
# Day-2 deploy to a server already provisioned by setup.sh: push the working
# tree, rebuild, apply migrations, restart the service.
#
# Run from anywhere in the checkout:
#   ./deploy/upcloud/push.sh root@<ip>
#
# Configuration (environment variables):
#   IMAGES   default 0; set 1 to also rebuild the sandbox runtime images,
#            which is only needed when runtimes/ changed (it is slow)
set -euo pipefail

TARGET=${1:?usage: push.sh root@<ip>}
IMAGES=${IMAGES:-0}
APP_DIR=/opt/pathfinder
APP_USER=integrator
ENV_FILE=/etc/pathfinder/env

# Push the whole checkout regardless of where this was invoked from
cd "$(dirname "$0")/../.."

echo "==> Push $PWD -> $TARGET:$APP_DIR"
# No --delete: a file deleted or renamed locally lingers on the server, so
# reprovision from scratch if that ever matters
rsync -a --exclude node_modules --exclude .git/hooks ./ "$TARGET:$APP_DIR/"

echo "==> Rebuild, migrate, restart"
ssh "$TARGET" "APP_DIR=$APP_DIR APP_USER=$APP_USER ENV_FILE=$ENV_FILE IMAGES=$IMAGES bash -s" <<'REMOTE'
set -euo pipefail

# rsync ran as root, so hand the tree back before building as the app user
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

as_app() {
  sudo -H -u "$APP_USER" env XDG_RUNTIME_DIR="/run/user/$(id -u "$APP_USER")" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "cd $APP_DIR && $*"
}

echo "--> install + build"
as_app "pnpm install"
as_app "pnpm -r build"

if [ "$IMAGES" = "1" ]; then
  echo "--> runtime images"
  as_app "podman build -t localhost/pathfinder-runtime-python:dev runtimes/python/"
  as_app "podman build -t localhost/pathfinder-runtime-node:dev runtimes/node/"
fi

# serve does not migrate at boot, so a schema change lands here or not at all
echo "--> migrate"
as_app "set -a; . $ENV_FILE; set +a; node apps/server/dist/cli.js migrate"

echo "--> restart"
systemctl restart pathfinder
systemctl is-active pathfinder
REMOTE

echo
echo "Done. Logs: ssh $TARGET journalctl -u pathfinder -f"
