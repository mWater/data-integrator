# node runtime image: standard Node + curated libraries + harness.
# Curated libraries only; integrations never install packages at run time.
# Pinned release, bumped deliberately with the runtime version.
FROM docker.io/library/node:22.23.2-slim

RUN mkdir /runtime && cd /runtime \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund csv-parse fast-xml-parser date-fns \
 && npm cache clean --force

# No USER: under rootless podman, container root is already an unprivileged host
# user (userns), gVisor sandboxes above that, and mounts stay writable.
COPY harness.mjs /harness/harness.mjs
ENV HOME=/tmp
ENTRYPOINT ["node", "/harness/harness.mjs"]
