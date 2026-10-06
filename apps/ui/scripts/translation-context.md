# Translation context

Guidance passed to the translation model (and useful for human translators
working from an exported spreadsheet) alongside every batch of strings.

## Who reads this interface

Operators and data staff at a national water or health ministry, or at an NGO
running a country deployment. They are comfortable with data work but are not
necessarily programmers. Prefer the plain wording a technically-literate
colleague would use over literal translations of English computing jargon.

## Product vocabulary

Translate these consistently. Where a locale has an established term in
government statistics or GIS work, prefer it over a coinage.

| English | Meaning in this product |
| --- | --- |
| integration | One configured pipeline that ingests a data source on a schedule. Not "integration" in the arithmetic sense. |
| definition | The saved specification of an integration: its source, schedule and transforms. |
| design session | A working conversation with the AI agent that builds an integration or dashboard. |
| cold run | A test run starting from an empty slate, ignoring anything previously ingested. |
| warm run | A normal incremental run that keeps existing data. |
| certified | An integration whose cold run succeeded, so it is safe to install. |
| layer | A raster or vector map layer produced by an integration. |
| area of interest (AOI) | The bounding box or country an integration is clipped to. |
| dashboard | A saved page of charts, tables and maps built from ingested data. |
| library | The catalog of ready-made integrations a deployment can install. |
| snapshot | One point-in-time version of a layer's data. |
| assistant | The AI that answers questions about ingested data. |

## Conventions

- Keep the register terse and functional. Buttons, headings and status lines,
  not prose. Match the brevity of the English.
- Placeholders `{0}`, `{1}` are substituted at runtime with names, counts and
  dates. Keep every placeholder, and move it wherever the target language needs
  it, but never reorder what each one means.
- Preserve leading and trailing spaces, ellipses (…), middots (·) and
  surrounding punctuation exactly.
- Do not translate: mWater Data Integrator, PostgreSQL, PostGIS, GeoTIFF, COG, CSV,
  SQL, WorldPop, CHIRPS, OpenStreetMap, or any other product, format or dataset
  name.
- Where English uses sentence case for headings and title case for buttons,
  follow the target language's own convention rather than copying the English
  casing.
- Some strings differ only in singular versus plural (`{0} row` / `{0} rows`).
  Translate each into the form that locale uses for that count; if the language
  needs a form neither slot covers, use the closest natural wording rather than
  inventing a new placeholder.
