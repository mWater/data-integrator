# mWater Data Integrator

Open-source, self-hosted platform that ingests water and climate data
(satellite rasters, gridded forecasts, sensor feeds, national databases,
uploaded spreadsheets), harmonizes it, and stores it in PostgreSQL/PostGIS
plus a file-backed raster store. Data is reached through a documented REST
API, a STAC catalog, SQL, dashboards, and Explore, an optional AI assistant
for plain-language questions. An AI designer builds and tests the ingestion
pipelines; pipeline code runs in sandboxed containers (podman + gVisor).

Developed by [mWater](https://www.mwater.co) for the UNICEF WASH Innovation
Hub, with initial deployments in Angola and Madagascar. It is the reference
implementation of the vendor-neutral architecture in
[docs/spec/](docs/spec/).

## What it does

- **Integrations.** Each data source is one integration: a definition
  (source, schedule, area of interest, destinations, limits, validation
  rules) plus one code file run in a sandbox. Runs are triggered by cron,
  webhook, upload, or hand. Install them from the bundled library (WorldPop,
  GHSL, Copernicus DEM, HydroSHEDS, GloFAS, drought and vegetation indices,
  flood extent, in-situ sensors and more), import them from another
  deployment, or design new ones with the agent.
- **AI designer.** Describe a source in a conversation; the agent reads
  documentation, probes the source in the sandbox, writes the definition and
  code, and must pass a cold run before anything is installed. Credentials
  are requested through a form in the session and never reach the model.
- **Sandbox.** Integration code runs in rootless podman with gVisor, memory,
  CPU, time and disk limits capped by the deployment, read-only inputs, and
  egress to public addresses only.
- **Data stores.** Tables land in Postgres with declared types and units.
  Rasters become immutable Cloud Optimized GeoTIFF snapshots, served as map
  tiles, downloadable, listed over STAC, and registered as out-db PostGIS
  rasters so SQL can join pixel values with vector rows.
- **Quality.** Range and vocabulary rules flag runs without rejecting data;
  integrations that stop delivering are flagged against their expected
  cadence; every run records its inputs, file versions and definition
  version.
- **Access.** Local accounts with admin, editor and viewer roles; personal
  access tokens for the API; tables as JSON, CSV or GeoJSON; agent-designed
  dashboards over frozen, parameterized SQL, optionally public; Explore for
  questions answered with tables, charts and maps that show their SQL.
- **Operations.** Daily AI token caps, snapshot retention, housekeeping of
  logs and scratch data, disk guards, and a web UI in English, French,
  Portuguese, Spanish, Malagasy and Kiswahili.

Everything except the designer, Explore and dashboard building works with no
AI model configured. The model provider is swappable: OpenRouter,
Anthropic, or any OpenAI-compatible endpoint, including self-hosted open
weights.

## Getting started

- [Quickstart](docs/Quickstart.md): a development install on one machine.
- [Deployment](docs/Deployment.md): a production install on a dedicated
  Ubuntu host, with TLS, updates and backups.

## Documentation

- [Architecture](docs/Architecture.md): how the implementation is put together
- [Database](docs/Database.md): schema, migrations, raster store layout
- [API](docs/API.md): tokens, tables, rasters, STAC, webhooks, files
- [Dashboards](docs/Dashboards.md): agent-designed dashboards over frozen SQL
- [Integration Files](docs/Integration%20Files.md): uploaded files integrations read
- [Exceptions Register](docs/Exceptions%20Register.md): proprietary dependencies (only optional hosted AI models) and their justification
- [System Architecture](docs/spec/System%20Architecture.md),
  [Integration Library Specification](docs/spec/Integration%20Library%20Specification.md),
  [Interoperability and Standards Mapping](docs/spec/Interoperability%20and%20Standards%20Mapping.md):
  the vendor-neutral specifications

## Repository layout

| Path | Contents |
|---|---|
| `apps/server` | Node/TypeScript server: API, scheduler, run executor, agents, CLI |
| `apps/ui` | React operator UI, served by the server |
| `packages/runner` | podman + gVisor job runner, published as [`@mwater/integration-runner`](https://www.npmjs.com/package/@mwater/integration-runner) |
| `packages/definitions` | Integration definition types |
| `packages/kit` | Component kit that agent-designed dashboards are built from |
| `runtimes/` | Python and Node sandbox images and their job harnesses |
| `library/` | Integration library entries, agent skills, standardized design prompts |
| `deploy/` | Host provisioning and update scripts |
| `docs/` | Implementation docs and the architecture specifications |

## Releasing the runner

The runner package and the two runtime images share one version, because the
harness inside the images is the contract the runner depends on. Never publish
one without the others.

```sh
gh auth refresh -h github.com -s write:packages,read:packages
gh auth token | podman login ghcr.io -u <github-user> --password-stdin
npm login                                  # an account in the @mwater npm org
scripts/release-runner.sh 0.3.0 --dry-run  # stamps, builds, tests; pushes nothing
scripts/release-runner.sh 0.3.0            # pushes images, publishes, commits, tags
git push && git push origin runner-v0.3.0
```

The first push of a new image name creates it private on GitHub; make it
public in the organization's package settings, then check that an anonymous
`podman pull` works. Consumers pin the package version and take the image
tags from its `RUNTIME_IMAGES` export.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, code conventions, and how pull
requests are handled. Report vulnerabilities privately per
[SECURITY.md](SECURITY.md), never through an issue.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
