#!/usr/bin/env bash
# Updates a host provisioned by setup.sh: optionally checks out a release, then
# rebuilds, migrates, re-applies host guards and restarts. Run as root on the host:
#   REF=v1.2.0 bash /opt/data-integrator/deploy/update.sh
#
# Configuration (environment variables):
#   REF      (optional) tag, branch or commit to fetch from origin and check out
#            (detached); unset builds /opt/data-integrator as it stands, e.g.
#            after copying a checkout there with rsync
#   IMAGES   default 0; set 1 to also rebuild the sandbox runtime images,
#            which is only needed when runtimes/ changed (it is slow)
set -euo pipefail

REF=${REF:-}
IMAGES=${IMAGES:-0}
APP_DIR=/opt/data-integrator
APP_USER=integrator
ENV_FILE=/etc/data-integrator/env
APP_UID=$(id -u "$APP_USER")

# A tree copied in as root has to go back to the app user before git or the build
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

git_app() {
  sudo -H -u "$APP_USER" git -C "$APP_DIR" "$@"
}

as_app() {
  sudo -H -u "$APP_USER" env XDG_RUNTIME_DIR="/run/user/$APP_UID" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "cd $APP_DIR && $*"
}

if [ -n "$REF" ]; then
  echo "==> Check out $REF"
  # Local edits would be silently carried along or block the checkout halfway
  if [ -n "$(git_app status --porcelain --untracked-files=no)" ]; then
    echo "ERROR: $APP_DIR has local changes; commit, stash or discard them first:" >&2
    git_app status --short --untracked-files=no >&2
    exit 1
  fi
  git_app fetch origin "$REF"
  git_app checkout --detach FETCH_HEAD
  git_app log -1 --format='    %h %s'
fi

echo "==> Install + build"
# No TTY over ssh, so pnpm must not stop to confirm rebuilding node_modules (it
# does whenever the store path changed, e.g. after the app user's home moved)
as_app "pnpm install --frozen-lockfile --config.confirmModulesPurge=false"
as_app "pnpm -r build"

if [ "$IMAGES" = "1" ]; then
  echo "==> Runtime images"
  as_app "podman build -t localhost/integrator-runtime-python:dev runtimes/python/"
  as_app "podman build -t localhost/integrator-runtime-node:dev runtimes/node/"
fi

# serve does not migrate at boot, so a schema change lands here or not at all
echo "==> Migrate"
as_app "set -a; . $ENV_FILE; set +a; node apps/server/dist/cli.js migrate"

echo "==> Host guards"
APP_USER="$APP_USER" bash "$APP_DIR/deploy/harden.sh"

echo "==> Restart"
systemctl restart data-integrator
systemctl is-active data-integrator

echo
echo "Done. Logs: journalctl -u data-integrator -f"
