# Quickstart

From clean checkout to a running server with a user, data, and the designer
agent, on one machine, for development and evaluation. Commands assume Linux
and a POSIX shell. For a production install, follow
[Deployment](Deployment.md) instead.

## Prerequisites

- **Node.js 22+** and **pnpm**.
- **podman** (rootless) and **nftables** - the job sandbox and its egress
  policy. `apt install podman nftables` or equivalent.
- **gVisor** - `runsc` at `/usr/local/bin/runsc`
  (https://gvisor.dev/docs/user_guide/install/).
- **GDAL CLI tools** - `apt install gdal-bin` (gdalinfo, gdalwarp, gdaldem,
  ogr2ogr; used for the raster catalog, tiles, and GeoPackage extracts).
- **PostgreSQL 16 + PostGIS** - anywhere reachable, but the Postgres server
  process must be able to read `RASTER_STORE_PATH` at the same absolute path:
  runs register snapshots as out-db rasters, and a run fails if the database
  cannot open the files. A local container works with the store mounted in:

```sh
mkdir -p $PWD/raster-store
podman run -d --name integrator-pg \
  -e POSTGRES_PASSWORD=changeme \
  -p 127.0.0.1:15432:5432 \
  -v $PWD/raster-store:$PWD/raster-store:ro \
  docker.io/postgis/postgis:16-3.4
```

  For a host-installed Postgres, grant the `postgres` user traverse access to
  the path instead (e.g. `setfacl -m u:postgres:x ~` when the store lives
  under your home directory).

## Build

```sh
pnpm install
pnpm -r build                       # packages, server, UI
podman build -t localhost/integrator-runtime-python:dev runtimes/python/
podman build -t localhost/integrator-runtime-node:dev runtimes/node/
```

## Configure

Infrastructure wiring is environment variables; only `DATABASE_URL` is
required. They are read and validated once at startup
(`apps/server/src/config.ts`), except the AI seed variables, which
`apps/server/src/aiSettings.ts` reads only to fill empty AI settings.
[`.env.example`](../.env.example) at the repository root documents every
variable, including job ceilings, disk guards, tile rendering, and the basemap
proxy; `node --env-file=.env` loads a local copy. Runtime behavior an
administrator owns, like the deployment's default area of interest, lives in
the Settings page, not the environment.

The common ones:

| variable | default | purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres connection URL |
| `RASTER_STORE_PATH` | `./raster-store` | COG store (plain directory; mount S3 via FUSE if desired) |
| `WORK_ROOT` | `./work` | persistent per-integration /work caches |
| `TILE_CACHE_PATH` | `./tile-cache` | rendered tile cache |
| `FILE_STORE_PATH` | `./file-store` | uploaded integration files, every version kept ([Integration Files](Integration%20Files.md)) |
| `FILE_UPLOAD_MAX_MB` | `100` | largest accepted upload; a proxy in front must allow at least this much |
| `LIBRARY_PATH` | `./library` | integration library root; the designer agent loads `skills/` from here |
| `PORT` | `8080` | HTTP port |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `AGENT_MODEL` | (none) | seed the AI settings when the database has none (see AI provider below); ignored once Settings holds a provider |
| `AGENT_EFFORT` | `medium` for the default model, else model default | reasoning effort for OpenRouter models: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `INTEGRATOR_SECRET_KEY` | (none) | 32-byte base64/hex key encrypting integration secrets and the AI provider key; `openssl rand -base64 32`. Needed once definitions declare secrets or an admin saves a hosted AI provider |
| `RUNTIME_IMAGE_PYTHON` / `RUNTIME_IMAGE_NODE` | `localhost/integrator-runtime-{python,node}:dev` | runtime image overrides |

```sh
export DATABASE_URL=postgres://postgres:changeme@127.0.0.1:15432/postgres
```

### AI provider

The AI features (integration designer, Explore, dashboard builder) are off
until an admin picks a provider in Settings, AI features: OpenRouter,
Anthropic, or any OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM, Azure…),
which keeps all AI traffic on your own infrastructure when the endpoint is
local. Saving sends one short test request and refuses settings the provider
does not answer; the change applies at once, without a restart. The key is
stored encrypted under `INTEGRATOR_SECRET_KEY` and never shown again. Switching
provider asks every user to accept the data notice again. Daily token caps
(Settings, AI features, Daily limits) default to 5M tokens per user and 25M
per deployment per UTC day.

### Choosing a model

The Model field depends on the provider: an OpenRouter model id (default
`openai/gpt-6.1-sol`), an Anthropic model id (default `claude-opus-5-5`), or,
for a custom endpoint, the model name it serves (required). Recommended:

- `openai/gpt-6.1-sol`, the OpenRouter default. Runs at medium reasoning
  effort; `AGENT_EFFORT` raises or lowers it, and higher effort costs more.
- `anthropic/claude-opus-5.5` on OpenRouter, or `claude-opus-5-5` with the
  Anthropic provider (its default). On OpenRouter, Anthropic models get prompt
  caching automatically, which cuts the cost of long sessions.
- `openai/gpt-6.1-terra`, the cheaper option, for routine integrations and
  Explore questions.

For a self-hosted model, use a custom endpoint: any OpenAI-compatible server
works. The designer's work is long, tool-heavy sessions, so a model needs
reliable tool calling and long-context recall; try one design session and
check its cold run before relying on it.

## Initialize and create the first user

```sh
node apps/server/dist/cli.js migrate
node apps/server/dist/cli.js user add you@example.org admin
# prints a generated password once; change it with:
# echo 'new-password' | node apps/server/dist/cli.js user passwd you@example.org
```

Roles: `admin` (everything, including credentials, settings, users, and
making dashboards public), `editor` (integrations, dashboards, and agent
sessions), `viewer` (read-only, plus Explore questions). More user commands:
`user list`, `user disable <email>`, `user enable <email>`,
`user token <email> [name]`.

Once the first admin exists, further users are managed in the UI under
**Settings → Users** (add, reset password, change role, disable/enable), and
every signed-in user can change their own password there. The CLI commands
remain for bootstrap and for recovering a locked-out admin.

## Run the server

```sh
node apps/server/dist/cli.js serve      # then set the AI provider in Settings
```

Open http://127.0.0.1:8080, sign in, and you have the whole loop: integrations,
data previews, manual runs, the map, and design sessions.

## Install and run a library integration

In the UI: set your deployment's default area of interest once (Settings,
country picker), then open Library and click Install: the entry inherits the
default AOI and its suggested schedule, and can start its first ingest
immediately. From a terminal instead (set the default area in Settings first:
without one, WorldPop ingests the current year for the whole world, about
10 GB of source):

```sh
node apps/server/dist/cli.js library-install worldpop_population
node apps/server/dist/cli.js run worldpop_population
```

Or click Run Now on the integration's page. Two more entries that need no
credentials: `copernicus_spi3` adds a monthly drought-index time series
(raster), and `hydrosheds_hydrography` loads catchment and river tables
(`hydrobasins`, `hydrorivers`) to query through the API. Entries that need an
account, like `glofas_river_discharge` and `clms_fpar_10daily`, declare
credentials an admin sets on the integration's page before the first run.

## Develop live (no rebuilds)

One command instead of the build-and-serve loop:

```sh
set -a; . ./.env; set +a          # export the .env vars to child processes
pnpm dev
```

This runs both dev processes in parallel with prefixed output: the API
server from source (`tsx watch`, restarting on change) and the Vite UI with
hot reload. Open the same URL as production: http://127.0.0.1:$PORT
(8080 unless `PORT` is set in `.env`). UI edits apply instantly; server
edits restart the process. Ctrl+C stops both. (`set -a` makes every
variable the sourced `.env` defines exported, so they reach pnpm's child
processes; `set +a` turns that back off.)

One caveat: the server dev process runs with `apps/server` as its working
directory, so the relative path defaults (`./library`, `./raster-store`,
...) resolve there: use absolute paths in your `.env` (including
`LIBRARY_PATH`) when developing, or the Library page will come up empty.

## Design an integration with the agent

In the UI: New Integration on the landing page, then describe what to build.
From a terminal instead:

```sh
node apps/server/dist/cli.js agent                      # new integration
node apps/server/dist/cli.js agent worldpop_population  # edit an installed one
```

The agent explores the source with sandboxed snippets, writes the definition
and code, test-runs through the real executor, and can only finish after the
code passes a cold run (fresh workspace, no cached state).

## Use the API

```sh
TOKEN=$(node apps/server/dist/cli.js user token you@example.org scripts | tail -1)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/tables
```

Rasters are also browsable as a STAC catalog at `/api/stac`. See
[API](API.md) and `GET /api/openapi.json` for the full interface.

## Translate the interface

Users pick their language under Settings; the choice is per browser. The
catalog lives at `apps/ui/src/localizations.json` and ships with the app, so no
configuration is needed to *use* a translation.

To add strings or languages, work from `apps/ui`:

```sh
pnpm localize                            # re-extract T`...` strings from src/
pnpm localize --translate all            # fill every missing translation
pnpm localize --translate fr,pt          # or just these locales
```

Translation is a build-time tool with its own model configuration
(`OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`, optionally `AGENT_MODEL`), read
from the environment or the repository-root `.env`; the server's AI settings
are not involved. Extraction needs no key.

Run `pnpm localize` after any change that adds or edits UI text, and commit the
updated `localizations.json` alongside it. Strings the extractor no longer finds
are listed under `unused` rather than deleted, so a temporarily removed string
keeps its translations.

For human review, round-trip a spreadsheet:

```sh
pnpm localize --export fr                # writes localizations-fr.xlsx at the repo root
pnpm localize --import fr --file ../../localizations-fr.xlsx
```

To add a language, append it to the `locales` array in
`apps/ui/src/localizations.json` and run `pnpm localize --translate <code>`.
Translator guidance and the product glossary live in
`apps/ui/scripts/translation-context.md`; edit that first if a term is coming
out wrong across a whole locale.

In UI code, always write strings as tagged templates so the extractor sees them:

```tsx
<button>{T`Run now`}</button>
setNotice(T`Installed ${name}.`)
```

Never build a localized string at module scope: a language switch re-renders
the tree but does not re-evaluate modules, so a top-level `const LABEL = T\`…\``
would stay in the old language. Put it in a function instead (see
`apps/ui/src/activity.ts`).

## Tests

```sh
pnpm -r test
```

Runner and executor tests need podman, runsc, and the runtime images built
above; they spin up ephemeral PostGIS containers and skip themselves when the
stack is missing.
