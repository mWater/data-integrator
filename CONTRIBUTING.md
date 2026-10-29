# Contributing

Thanks for your interest. This is an open-source platform built by
[mWater](https://www.mwater.co) for the UNICEF WASH Innovation Hub, and it is
meant to be run and extended by others.

## Licensing of contributions

The project is Apache 2.0 (see [LICENSE](LICENSE)). By submitting a pull
request you agree that your contribution is licensed under the same terms, per
section 5 of the license. Inbound equals outbound; there is no separate CLA.

Do not paste code from another project unless its license permits it and you
say so in the pull request. If a contribution carries a third-party notice that
must be preserved, add it to [NOTICE](NOTICE) in the same pull request.

## Getting set up

[docs/Quickstart.md](docs/Quickstart.md) takes a clean checkout to a running
server with a user and data. You need Node 22+, pnpm, rootless podman, nftables, gVisor,
the GDAL CLI tools, and PostgreSQL 16 with PostGIS.

```sh
pnpm install
pnpm build
pnpm test
```

The suites are real: they run jobs in containers and talk to Postgres, so they are
not fast. Server tests need a PostGIS database: an ephemeral podman container, or
`TEST_DATABASE_URL`. Tests that need podman, gVisor, or a runtime image skip themselves
when it is missing, so build the images first (`pnpm build:image` in `runtimes/node`
and `runtimes/python`, as CI does in `.github/workflows/ci.yml`) for a full run.

## Where things live

[docs/Architecture.md](docs/Architecture.md) is the map. In short: `apps/server` is the
Node server, API, executor, and agent; `apps/ui` is the React operator UI;
`packages/runner` is the podman + gVisor job executor; `packages/definitions`
is the integration definition format; `packages/kit` is the dashboard component
kit; `runtimes/` holds the sandbox images; `library/` holds integration
definitions and agent skills.

[docs/Database.md](docs/Database.md) covers the schema and migrations,
[docs/Dashboards.md](docs/Dashboards.md) the dashboard pipeline, and
[docs/API.md](docs/API.md) the documented query interface. Open issues are the
list of what is not done yet, and a good place to find work.

## Code conventions

Match the surrounding code. There is no linter to argue with, so the existing
files are the specification: TypeScript throughout, no semicolons, double
quotes, two-space indent, ES modules with `.js` import specifiers.

Every exported type, interface, function, and interface member carries a short
TSDoc comment. Files open with a block comment saying what the module is for
and what decision it encodes. Comments document live constraints, not the
history of past bugs.

User-visible strings in `apps/ui` go through `ez-localize` using the tagged
template form, `` T`Save` ``. Run `pnpm localize` in `apps/ui` to re-extract
after adding strings.

## Pull requests

- One concern per pull request. Say what changed and why in the description.
- Add or update tests for behavior you change. Server tests live in
  `apps/server/test`.
- Update the docs in the same pull request when you change behavior they
  describe. A schema change is a new numbered file in
  `apps/server/migrations` plus the matching edit to `docs/Database.md`.
- CI runs the full suite on every pull request and must pass.

## Security

Do not report vulnerabilities through issues or pull requests. See
[SECURITY.md](SECURITY.md).
