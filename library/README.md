# Integration library

The machine-readable, application-independent deliverable: everything needed
to ingest the target data sources, shippable to any deployment. Two kinds of
content, each under its own directory:

- `integrations/<id>/` — one finished integration per directory:
  `definition.json` plus a single `code.py` or `code.mjs` that becomes
  `definition.code` at install. Install with
  `cli.js install library/integrations/<id>`; definitions are templates
  (omit `aoi` to inherit the deployment default at run time).
- `skills/<id>/` — reusable source and technique know-how the design agent
  loads on demand: how a source's protocols and file layouts work,
  independent of any particular integration built from it. One `SKILL.md`
  per skill: frontmatter (`name`, one-line `description` shown in the
  agent's index, `verified` date), then freeform markdown — endpoints,
  quirks, working snippets. Skills are prose the agent reads, never code it
  executes; the one-liner is what makes on-demand loading work, so write it
  to answer "when would I read this".

Secret values never appear in the library. See Architecture.md for the
definition format.
