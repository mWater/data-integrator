# python runtime image: GDAL CLI + geospatial Python stack + harness.
# Curated libraries only; integrations never install packages at run time.
# Pinned release: the floating -latest tag serves dev builds, and two builds of
# one runtime version must not differ. Bump deliberately with the version.
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.3

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip libeccodes0 \
 && rm -rf /var/lib/apt/lists/*

# requirements.txt pins every package pip installs (generated from requirements.in
# by `pnpm lock`); the lock build passes REQUIREMENTS=requirements.in instead.
ARG REQUIREMENTS=requirements.txt
COPY requirements.in requirements.txt /runtime/
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /runtime/$REQUIREMENTS \
 && python3 -m pip check

# No USER: under rootless podman, container root is already an unprivileged host
# user (userns), gVisor sandboxes above that, and mounts stay writable.
COPY harness.py /harness/harness.py
ENV HOME=/tmp
ENTRYPOINT ["python3", "/harness/harness.py"]
