# Library prompts

Standardized design-session prompts for the sources named in the platform's
architecture. Each file is the prompt we give the designer agent to
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
4. Finishing the session requires the platform's cold-run certification.
5. Before the entry ships to `library/integrations/`, run the acceptance
   checks in the prompt file against the ingested data.

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
| 9 | `fapar_anomaly_gdo` | ten-daily time-series, full-cadence snapshots | hand-authored from the GDO skill |
| 10 | `drought_risk_gdo` | categorical raster | RDrI-Agri stands in for the Europe-only CDI |
| 11 | `worldpop_population` | annual time-series raster, country-keyed files mosaicked per snapshot | |
| 12 | (none) | ten-daily time-series raster on a daily poll | entry `gdo_soil_moisture_anomaly`, no prompt |
| 13 | (none) | monthly forecast issues, categorical plus continuous bands | entry `gdo_spi3_forecast`, no prompt |
| 14 | (none) | five-year epoch time-series raster, tiled source, whole-world mode | entry `ghs_population`, no prompt |
| 15 | (none) | vector tables, versioned release, per-country files | entry `mwater_admin_regions`, no prompt |

FABDEM is not in the library: its CC BY-NC-SA license is non-commercial.
GLO-30 carries terrain.

## Prompt file format

Each file has three sections:

- **Prompt**: the verbatim text given to the agent. This is the record of
  what it took to make the connection.
- **Scope**: the product and access-path decisions the prompt encodes, and
  why.
- **Acceptance checks**: what a human verifies on the ingested data before
  the entry ships. Runnable checks reference the query API or SQL surface.
