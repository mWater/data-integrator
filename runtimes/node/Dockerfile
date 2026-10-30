# node runtime image: standard Node + curated libraries + harness.
# Curated libraries only; integrations never install packages at run time.
# Pinned release, bumped deliberately with the runtime version.
FROM docker.io/library/node:22.23.2-slim

# Exact versions and a lockfile, so two builds of one runtime version are identical.
# Add or bump a library in libs/package.json, then: npm install --package-lock-only (in libs/)
COPY libs/package.json libs/package-lock.json /runtime/
RUN cd /runtime \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# No USER: under rootless podman, container root is already an unprivileged host
# user (userns), gVisor sandboxes above that, and mounts stay writable.
COPY harness.mjs /harness/harness.mjs
ENV HOME=/tmp
ENTRYPOINT ["node", "/harness/harness.mjs"]
