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
required. All variables are read and validated once at startup
(`apps/server/src/config.ts`); `.env.example` at the repository root documents
every one, and `node --env-file=.env` loads a local copy for development.
Runtime behavior an administrator owns — like the deployment's default area of
interest — lives in the Settings page, not the environment.

| variable | default | purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres connection URL |
| `RASTER_STORE_PATH` | `./raster-store` | COG store (plain directory; mount S3 via FUSE if desired) |
| `WORK_ROOT` | `./work` | persistent per-integration /work caches |
| `TILE_CACHE_PATH` | `./tile-cache` | rendered tile cache |
| `LIBRARY_PATH` | `./library` | integration library root; the designer agent loads `skills/` from here |
| `PORT` | `8080` | HTTP port |
| `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` | (none) | enables the AI agents; without a model configured the platform runs with the session API disabled |
| `LLM_BASE_URL` | (none) | any OpenAI-compatible endpoint (vLLM, Ollama, LiteLLM, Azure…) instead of a hosted provider; takes precedence over the keys above. Requires `AGENT_MODEL` |
| `LLM_API_KEY` | (none) | API key for `LLM_BASE_URL`, if the endpoint needs one |
| `AGENT_MODEL` | `openai/gpt-5.6-sol` (OpenRouter) / `claude-sonnet-5` (Anthropic) | agent model override, see Choosing a model below |
| `AGENT_EFFORT` | `medium` for the default model, else model default | reasoning effort for OpenRouter models: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `INTEGRATOR_SECRET_KEY` | (none) | 32-byte base64/hex key encrypting integration secrets; `openssl rand -base64 32`. Only needed once definitions declare secrets |
| `RUNTIME_IMAGE_PYTHON` / `RUNTIME_IMAGE_NODE` | `localhost/integrator-runtime-{python,node}:dev` | runtime image overrides |

```sh
export DATABASE_URL=postgres://postgres:changeme@127.0.0.1:15432/postgres
```

### Choosing a model

`AGENT_MODEL` takes any OpenRouter model id. Guidance from running the same
design task across models (2026-08):

- `openai/gpt-5.6-sol` (default, at medium effort): wrote the strongest code in
  our tests (retry policies, sentinel handling, debugged a live 503) at about
  half the cost of cached Sonnet, twice as fast. `AGENT_EFFORT=high` cost 6x
  medium for no visible gain.
- `anthropic/claude-sonnet-5`: equally careful engineering and the most tested
  on long sessions. Prompt caching is applied automatically, cutting
  long-session cost roughly 4x.
- `openai/gpt-5.6-terra`: the value pick. Near-parity agentic quality at a
  fraction of the cost; fast.
- `z-ai/glm-5.2`: the open-weights route when self-hosting the model matters.
  Fully workflow-compliant and thorough in our test, but billed well above its
  list price (hidden reasoning tokens), landing near Sonnet cost with twice the
  steps.
- `openai/gpt-5.6-luna`: fine for simple table integrations at trivial cost,
  but weak long-context recall makes it risky for long raster sessions.
- `google/gemini-3.6-flash`: not recommended; costs more than Terra, uses
  about twice the tokens per task, and produced weaker code in our tests.

## Initialize and create the first user

```sh
node apps/server/dist/cli.js migrate
node apps/server/dist/cli.js user add you@example.org admin
# prints a generated password once; change it with:
# echo 'new-password' | node apps/server/dist/cli.js user passwd you@example.org
```

Roles: `admin` (everything, including credentials, settings, users, and
making dashboards public), `editor` (integrations, dashboards, and agent
sessions), `viewer` (read-only, plus Explore questions). More user commands: `user list`, `user disable <email>`,
`user enable <email>`, `user token <email> [name]`.

Once the first admin exists, further users are managed in the UI under
**Settings → Users** (add, reset password, change role, disable/enable), and
every signed-in user can change their own password there. The CLI commands
remain for bootstrap and for recovering a locked-out admin.

## Run the server

```sh
export OPENROUTER_API_KEY=sk-or-...     # optional: enables the agent
node apps/server/dist/cli.js serve
```

Open http://127.0.0.1:8080, sign in, and you have the whole loop: integrations,
data previews, manual runs, the map, and design sessions.

## Install and run a library integration

In the UI: set your deployment's default area of interest once (Settings,
country picker), then open Library and click Install — the entry inherits the
default AOI and its suggested schedule, and can start its first ingest
immediately. From a terminal instead:

```sh
node apps/server/dist/cli.js library-install worldpop_population
node apps/server/dist/cli.js run worldpop_population
```

Or click Run Now on the integration's page. `library/integrations/chirps_rainfall`
adds a time-series layer; `library/integrations/rainfall_stats` derives population-weighted
rainfall from the other two (install and run those first).

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
...) resolve there — use absolute paths in your `.env` (including
`LIBRARY_PATH`) when developing, or the Library page will come up empty.

## Design an integration with the agent

In the UI: New Integration on the landing page, then describe what to build.
From a terminal instead:

```sh
node apps/server/dist/cli.js agent                    # new integration
node apps/server/dist/cli.js agent chirps_rainfall    # edit an installed one
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

Translation uses the same model configuration as the agent
(`OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`, optionally `AGENT_MODEL`), read
from the environment or the repository-root `.env`. Extraction needs no key.

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
