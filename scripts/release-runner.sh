#!/usr/bin/env bash
# Releases the runner package and the runtime images at one version.
#
#   scripts/release-runner.sh <version>            build, test, push, publish, tag
#   scripts/release-runner.sh <version> --dry-run  everything except push, publish, tag
#
# The harness inside each image is the contract the runner depends on, so the
# npm package and both images are versioned together: RUNTIME_VERSION in
# packages/runner/src/images.ts is stamped from the same argument as
# package.json, and the harness contract tests run against the freshly built
# images before anything leaves this machine. A failing test pushes nothing.
#
# Needs: clean git tree, podman logged in to ghcr.io (podman login ghcr.io),
# npm logged in with publish rights on @mwater (pnpm login).
set -euo pipefail

VERSION="${1:-}"
DRY_RUN="${2:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch> [--dry-run]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 1
fi

REPOSITORY="ghcr.io/mwater/integration-runtime"
NODE_IMAGE="$REPOSITORY-node:$VERSION"
PYTHON_IMAGE="$REPOSITORY-python:$VERSION"

echo "== stamping $VERSION"
# npm version refuses a no-op, so write the field directly
node -e 'const fs=require("fs");const p="packages/runner/package.json";const j=JSON.parse(fs.readFileSync(p));j.version=process.argv[1];fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' "$VERSION"
sed -i "s/^export const RUNTIME_VERSION = \".*\"/export const RUNTIME_VERSION = \"$VERSION\"/" packages/runner/src/images.ts
grep -q "RUNTIME_VERSION = \"$VERSION\"" packages/runner/src/images.ts

echo "== building packages"
pnpm --filter @mwater/integration-runner build

echo "== building images"
podman build -t "$NODE_IMAGE" runtimes/node
podman build -t "$PYTHON_IMAGE" runtimes/python

echo "== testing the runner"
(cd packages/runner && pnpm test)

echo "== testing the harness contract against the release images"
(cd runtimes/node && RUNTIME_IMAGE_NODE="$NODE_IMAGE" pnpm test)
(cd runtimes/python && RUNTIME_IMAGE_PYTHON="$PYTHON_IMAGE" pnpm test)

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "== dry run: not pushing, publishing, or tagging"
  git checkout -- packages/runner/package.json packages/runner/src/images.ts
  exit 0
fi

echo "== pushing images"
podman push "$NODE_IMAGE"
podman push "$PYTHON_IMAGE"

echo "== publishing @mwater/integration-runner@$VERSION"
(cd packages/runner && pnpm publish --access public --no-git-checks)

# Runner tags are prefixed: plain vX.Y.Z tags are the application's releases
echo "== committing and tagging runner-v$VERSION"
git add packages/runner/package.json packages/runner/src/images.ts pnpm-lock.yaml
# Nothing to commit when the version was already stamped; the tag still applies
git diff --cached --quiet || git commit -m "Release integration runner $VERSION"
git tag "runner-v$VERSION"
echo "done: push the commit and tag with: git push && git push origin runner-v$VERSION"
