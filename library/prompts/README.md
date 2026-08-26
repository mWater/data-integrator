# Library prompts

Standardized design-session prompts for the sources named in the ToR
architecture diagram. Each file is the prompt we give the designer agent to
build that source's library entry, plus the scoping decisions behind it and
the acceptance checks the result must pass before it ships.

These prompts are test inputs as much as instructions. They are written at
the level a competent operator would write: what to connect, which product,
what cadence, what the destination should look like. They deliberately omit
URLs, grid details, and format gotchas. When the agent struggles, the fix is
a skill in `library/skills/`, not a fatter prompt; which skills a source
needed is part of the validation record.

## Method

1. Start a design session and paste the prompt verbatim.
2. Steer only as an operator would (clarify intent, approve choices). Record
   every steer.
3. When the agent is stuck on source knowledge, stop, write or extend the
   skill, and start a fresh session so the run is reproducible.
4. Finish requires the platform's cold-run certification as always.
5. Before the entry ships to `library/integrations/`, run the acceptance
   checks in the prompt file against the ingested data.
6. Log the outcome in `RESULTS.md`: first try, steered, or skill added, plus
   session length and anything that should feed back into the platform.

## Sequencing

Easiest first, so loop problems surface on cheap sources; auth, incremental
state, and derived analytics enter one at a time.

| # | Prompt | Exercises | Notes |
|---|---|---|---|
| 1 | `ghsl_built_up` | static raster, public download | |
| 2 | `copernicus_dem_glo30` | static raster mosaic, tiled source | |
| 3 | `hydrosheds` | vector tables, GeoPackage path | |
| 4 | `spi_gdo` | time-series raster, incremental state | |
| 5 | `glofas_discharge` | secrets (CDS API), GRIB, daily cadence | |
| 6 | `fpar` | secrets, 10-daily cadence | |
| 7 | `flood_extent_gfm` | SAR-derived product, event-driven data | scope: GFM stands in for raw SAR |
| 8 | `insitu_sensors` | webhook trigger, tabular merge | generic entry, no single upstream |

Parked: UNICEF datasources (identified with UNICEF during the Deliverable 2
consultations; add prompts when named). FABDEM (CC BY-NC-SA, a non-commercial
license: needs a licensing decision before it can ship in this library; GLO-30
carries terrain until then).

## Prompt file format

Each file has three sections:

- **Prompt**: the verbatim text given to the agent. This is the record of
  what it took to make the connection.
- **Scope**: the product and access-path decisions the prompt encodes, and
  why.
- **Acceptance checks**: what a human verifies on the ingested data before
  the entry ships. Runnable checks reference the query API or SQL surface.
