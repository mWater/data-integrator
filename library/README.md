# Integration library

The machine-readable, application-independent library: everything needed to
ingest the platform's data sources, shippable to any deployment. Three kinds of
content, each under its own directory:

- `integrations/<id>/`: one finished integration per directory,
  `definition.json` plus a single `code.py` or `code.mjs` that becomes
  `definition.code` at install. Definitions are templates: they omit `aoi`
  so an installed copy inherits the deployment default at run time.
  - `node apps/server/dist/cli.js library-install <id>` installs or updates
    an entry the way the Library page does: an update keeps the deployment's
    `aoi`, `trigger`, `limits` and still-valid `settingValues`.
  - `node apps/server/dist/cli.js install library/integrations/<id>`
    installs the directory as-is, replacing any installed definition
    outright (including `aoi`, `trigger`, `limits` and `settingValues`).
- `skills/<id>/`: reusable source and technique know-how the design agent
  loads on demand: how a source's protocols and file layouts work,
  independent of any particular integration built from it. One `SKILL.md`
  per skill: front matter (`name`, a one-line `description` shown in the
  agent's index, `verified` date), then freeform Markdown (endpoints,
  quirks, working snippets). Skills are prose the agent reads, never code it
  executes; the one-liner is what makes on-demand loading work, so write it
  to answer "when would I read this".
- `prompts/`: the design-session prompts each entry was built from, with
  scope and acceptance checks (see [prompts/README.md](prompts/README.md)).

Secret values never appear in the library. The format is specified in
[Integration Library Specification](../docs/spec/Integration%20Library%20Specification.md).
