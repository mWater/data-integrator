# Quickstart

From clean checkout to a running server with a user, data, and the designer
agent. Commands assume Linux and a POSIX shell.

## Prerequisites

- **Node.js 22+** and **pnpm**.
- **podman** (rootless) and **nftables** - the job sandbox and its egress
  policy. `apt install podman nftables` or equivalent.
- **gVisor** - `runsc` at `/usr/local/bin/runsc`
  (https://gvisor.dev/docs/user_guide/install/).
- **GDAL CLI tools** - `apt install gdal-bin` (gdalinfo, gdalwarp, gdaldem,
  ogr2ogr; used for the raster catalog, tiles, and GeoPackage extracts).
- **PostgreSQL 16 + PostGIS** - anywhere reachable; a local container works:

```sh
podman run -d --name integrator-pg \
  -e POSTGRES_PASSWORD=changeme \
  -p 127.0.0.1:15432:5432 \
  docker.io/postgis/postgis:16-3.4
```

## Build

```sh
pnpm install
pnpm -r build                       # packages, server, UI
podman build -t localhost/integrator-runtime-python:dev runtimes/python/
podman build -t localhost/integrator-runtime-node:dev runtimes/node/
```

## Configure

Everything is environment variables; only `DATABASE_URL` is required.

| variable | default | purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres connection URL |
| `RASTER_STORE_PATH` | `./raster-store` | COG store (plain directory; mount S3 via FUSE if desired) |
| `WORK_ROOT` | `./work` | persistent per-integration /work caches |
| `TILE_CACHE_PATH` | `./tile-cache` | rendered tile cache |
| `PORT` | `8080` | HTTP port |
| `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` | (none) | enables the designer agent; without one the platform runs with the session API disabled |
| `AGENT_MODEL` | `anthropic/claude-sonnet-5` (OpenRouter) / `claude-sonnet-5` (Anthropic) | agent model override |
| `INTEGRATOR_SECRET_KEY` | (none) | 32-byte base64/hex key encrypting integration secrets; `openssl rand -base64 32`. Only needed once definitions declare secrets |
| `RUNTIME_IMAGE_PYTHON` / `RUNTIME_IMAGE_NODE` | `localhost/integrator-runtime-{python,node}:dev` | runtime image overrides |

```sh
export DATABASE_URL=postgres://postgres:changeme@127.0.0.1:15432/postgres
```

## Initialize and create the first user

```sh
node apps/server/dist/cli.js migrate
node apps/server/dist/cli.js user add you@example.org admin
# prints a generated password once; change it with:
# echo 'new-password' | node apps/server/dist/cli.js user passwd you@example.org
```

Roles: `admin` (everything), `editor` (integrations and agent sessions),
`viewer` (read-only). More user commands: `user list`, `user disable <email>`,
`user enable <email>`, `user token <email> [name]`.

## Run the server

```sh
export OPENROUTER_API_KEY=sk-or-...     # optional: enables the agent
node apps/server/dist/cli.js serve
```

Open http://127.0.0.1:8080, sign in, and you have the whole loop: integrations,
data previews, manual runs, the map, and design sessions.

## Install and run a library integration

```sh
node apps/server/dist/cli.js install library/worldpop_population
node apps/server/dist/cli.js run worldpop_population
```

Or click Run Now on the integration's page. `library/chirps_rainfall` adds a
time-series layer; `library/rainfall_stats` derives population-weighted
rainfall from the other two (install and run those first).

## Design an integration with the agent

In the UI: New Integration on the landing page, then describe what to build.
From a terminal instead:

```sh
node apps/server/dist/cli.js agent my_integration
```

The agent explores the source with sandboxed snippets, writes the definition
and code, test-runs through the real executor, and can only finish after the
code passes a cold run (fresh workspace, no cached state).

## Use the API

```sh
TOKEN=$(node apps/server/dist/cli.js user token you@example.org scripts | tail -1)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/tables
```

See [API.md](API.md) and `GET /api/openapi.json` for the full interface.

## Tests

```sh
pnpm -r test
```

Runner and executor tests need podman, runsc, and the runtime images built
above; they spin up ephemeral PostGIS containers and skip themselves when the
stack is missing.
