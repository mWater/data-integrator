import { test } from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { Ajv2020 } from "ajv/dist/2020.js"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { validateDefinition } from "../src/install.js"

const REPO = new URL("../../../", import.meta.url)
const SCHEMA_URL = new URL("docs/spec/integration-definition.schema.json", REPO)
const SPEC_URL = new URL("docs/spec/Integration%20Library%20Specification.md", REPO)
const LIBRARY_URL = new URL("library/integrations/", REPO)

/** The published schema, compiled by an off-the-shelf draft 2020-12 validator, as another implementation would. */
const schemaAccepts = new Ajv2020({ allErrors: true, strictTypes: false }).compile(
  JSON.parse(await readFile(SCHEMA_URL, "utf8"))
)

/** Whether the reference implementation's validator accepts the document. */
function serverAccepts(document: unknown): boolean {
  try {
    validateDefinition(document as IntegrationDefinition)
    return true
  } catch {
    return false
  }
}

/** A definition using every part of the format, valid under both validators. */
const BASE = {
  id: "schema_demo",
  name: { _base: "en", en: "Schema demo", fr: "Démo du schéma" },
  description: { _base: "en", en: "Exercises every part of the format." },
  source: {
    name: { _base: "en", en: "Demo source" },
    url: "https://example.org/",
    provider: "Example",
    license: "CC-BY-4.0",
    documentation: "https://example.org/docs",
    limitations: { _base: "en", en: "Not real data." }
  },
  trigger: { cron: "0 6 * * 1-5", webhook: true, webhookDelaySeconds: 60 },
  secrets: ["API_KEY"],
  aoi: { bbox: [43, -26, 51, -11], countries: ["MDG"] },
  inputs: {
    boundaries: {
      kind: "table",
      tableId: "admin_boundaries",
      columns: ["shape_id"],
      where: [{ column: "level", op: "in", value: [1, 2] }],
      format: "gpkg"
    },
    rain: { kind: "raster", layerId: "rainfall", select: { latest: 3 } },
    dem: { kind: "raster", layerId: "elevation", select: "current" },
    history: { kind: "raster", layerId: "spi3", select: { from: "2026-01-01", to: "2026-06-30" } }
  },
  files: { inventory: { description: { _base: "en", en: "Water point inventory" }, accept: [".xlsx", ".csv"] } },
  runtime: "python",
  limits: { cpus: 0.5, memoryMb: 2048, timeoutMs: 600000, workDiskMb: 1024, tmpDiskMb: 512 },
  destinations: [
    {
      kind: "table",
      tableId: "readings",
      name: { _base: "en", en: "Readings" },
      description: { _base: "en", en: "One row per site and day." },
      action: "merge",
      mergeColumns: ["site", "day"],
      columns: [
        { id: "site", type: "text" },
        { id: "day", type: "date" },
        { id: "level", name: { _base: "en", en: "Level" }, type: "number", units: "m" },
        { id: "status", type: "enum", enumValues: [{ id: "ok", name: { _base: "en", en: "OK" } }] }
      ]
    },
    {
      kind: "raster",
      layerId: "rain_total",
      name: { _base: "en", en: "Rain total" },
      temporality: "time-series",
      retention: { days: 365 },
      bands: [
        {
          id: "mm",
          units: "mm",
          nodata: -9999,
          rendering: { colorMap: [{ value: 0, color: "#ffffff" }, { value: 500, color: "#08306b80" }], resampling: "average" }
        }
      ]
    }
  ],
  validation: {
    expectedCadence: "P1D",
    ranges: [{ destinationId: "readings", field: "level", min: 0 }, { destinationId: "rain_total", field: "mm", min: 0, max: 5000 }]
  },
  settings: {
    history_days: { label: { _base: "en", en: "History" }, type: "integer", default: 30, min: 1, max: 365, appliesOn: "rebuild" },
    simplified: { label: { _base: "en", en: "Simplified" }, type: "boolean", default: false },
    product: {
      label: { _base: "en", en: "Product" },
      type: "choice",
      default: "daily",
      choices: [{ value: "daily", label: { _base: "en", en: "Daily" } }, { value: "monthly", label: { _base: "en", en: "Monthly" } }]
    },
    station: { label: { _base: "en", en: "Station" }, type: "text", default: "A1", pattern: "[A-Z][0-9]+" }
  },
  settingValues: { history_days: 90, product: "monthly" },
  code: "def run(ctx):\n    return {}\n",
  contract: 2
}

/** One change applied to a copy of BASE. */
type Edit = (definition: any) => void

/** A copy of BASE with one edit applied. */
function variant(edit: Edit): unknown {
  const copy = structuredClone(BASE)
  edit(copy)
  return copy
}

test("the schema and the server both accept a definition that uses every part of the format", () => {
  assert.equal(schemaAccepts(BASE), true, JSON.stringify(schemaAccepts.errors))
  validateDefinition(BASE as unknown as IntegrationDefinition)
})

test("the bundled library conforms: every definition validates and has the code file of its runtime", async () => {
  const ids = await readdir(LIBRARY_URL)
  assert.ok(ids.length > 0)
  for (const id of ids) {
    const definition = JSON.parse(await readFile(new URL(`${id}/definition.json`, LIBRARY_URL), "utf8"))
    assert.equal(schemaAccepts(definition), true, `${id}: ${JSON.stringify(schemaAccepts.errors)}`)
    assert.equal(definition.id, id, `${id}: the directory name is the integration id`)
    const codeFiles = (await readdir(new URL(`${id}/`, LIBRARY_URL))).filter(name => name.startsWith("code."))
    assert.deepEqual(codeFiles, [definition.runtime === "python" ? "code.py" : "code.mjs"], id)
  }
})

test("the example in the specification validates", async () => {
  const spec = await readFile(SPEC_URL, "utf8")
  const example = /## 2\. Integration definition[\s\S]*?```json\n([\s\S]*?)\n```/.exec(spec)
  assert.ok(example, "section 2 opens with a JSON example")
  assert.equal(schemaAccepts(JSON.parse(example[1])), true, JSON.stringify(schemaAccepts.errors))
})

test("violations of the specification's structural rules are rejected by the schema and by the server", () => {
  const cases: [string, Edit][] = [
    ["id outside the identifier grammar", d => { d.id = "Bad-Id" }],
    ["name as a plain string", d => { d.name = "Schema demo" }],
    ["name missing", d => { delete d.name }],
    ["source without a name", d => { delete d.source.name }],
    ["enum value name as a plain string", d => { d.destinations[0].columns[3].enumValues[0].name = "OK" }],
    ["contract other than 2", d => { d.contract = 1 }],
    ["trigger missing", d => { delete d.trigger }],
    ["code missing", d => { delete d.code }],
    ["destinations missing", d => { delete d.destinations }],
    ["unknown runtime", d => { d.runtime = "ruby" }],
    ["bbox with three numbers", d => { d.aoi.bbox = [43, -26, 51] }],
    ["bbox longitude out of range", d => { d.aoi.bbox = [43, -26, 200, -11] }],
    ["secret name starting with a digit", d => { d.secrets = ["9KEY"] }],
    ["secret named twice", d => { d.secrets = ["API_KEY", "API_KEY"] }],
    ["file slot with an empty accept list", d => { d.files.inventory.accept = [] }],
    ["file slot extension in upper case", d => { d.files.inventory.accept = [".XLSX"] }],
    ["file slot id outside the grammar", d => { d.files = { "Inventory File": {} } }],
    ["cron that is not five fields", d => { d.trigger.cron = "every day" }],
    ["webhookDelaySeconds above a day", d => { d.trigger.webhookDelaySeconds = 90000 }],
    ["input id outside the grammar", d => { d.inputs = { "Rain!": d.inputs.rain } }],
    ["unknown table action", d => { d.destinations[0].action = "upsert" }],
    ["merge without mergeColumns", d => { delete d.destinations[0].mergeColumns }],
    ["column type outside the vocabulary", d => { d.destinations[0].columns[0].type = "string" }],
    ["column id outside the grammar", d => { d.destinations[0].columns[0].id = "Site" }],
    ["band id outside the grammar", d => { d.destinations[1].bands[0].id = "MM" }],
    ["retention on a current-only layer", d => { d.destinations[1].temporality = "current-only" }],
    ["retention of zero days", d => { d.destinations[1].retention.days = 0 }],
    ["unknown validation field", d => { d.validation.requiredColumns = ["site"] }],
    ["cadence that is not an ISO 8601 duration", d => { d.validation.expectedCadence = "daily" }],
    ["range rule without a bound", d => { d.validation.ranges = [{ destinationId: "readings", field: "level" }] }],
    ["setting type outside the four values", d => { d.settings.history_days.type = "float" }],
    ["choice setting without choices", d => { delete d.settings.product.choices }],
    ["integer setting with a text default", d => { d.settings.history_days.default = "thirty" }],
    ["setting id outside the grammar", d => { d.settings = { "History Days": d.settings.history_days }; d.settingValues = {} }]
  ]
  for (const [name, edit] of cases) {
    const document = variant(edit)
    assert.equal(schemaAccepts(document), false, `schema should reject: ${name}`)
    assert.equal(serverAccepts(document), false, `server should reject: ${name}`)
  }
})

test("the schema rejects unknown fields and wrong shapes anywhere in the document", () => {
  const cases: [string, Edit][] = [
    ["unknown top-level field", d => { d.schedule = "daily" }],
    ["misspelled field inside a destination", d => { d.destinations[0].mergeColumn = ["site"] }],
    ["unknown field on a column", d => { d.destinations[0].columns[2].unit = "m" }],
    ["unknown field on a trigger", d => { d.trigger.timezone = "UTC" }],
    ["memory limit as text", d => { d.limits.memoryMb = "2GB" }],
    ["locale key that is not a language tag", d => { d.name = { _base: "en", en: "Demo", "en us": "Demo" } }],
    ["color that is not hex", d => { d.destinations[1].bands[0].rendering.colorMap[0].color = "white" }],
    ["in filter with a single value", d => { d.inputs.boundaries.where[0].value = 1 }],
    ["latest as text", d => { d.inputs.rain.select = { latest: "three" } }],
    ["input of an unknown kind", d => { d.inputs.rain.kind = "vector" }]
  ]
  for (const [name, edit] of cases) {
    assert.equal(schemaAccepts(variant(edit)), false, `schema should reject: ${name}`)
  }
})

// Section 2.14 of the specification lists these as the rules a JSON Schema
// cannot express. A case moving out of this test means that list has changed.
test("rules that relate one field to another pass the schema and are caught by the server", () => {
  const cases: [string, Edit][] = [
    ["base locale absent from a localized string", d => { d.name = { _base: "fr", en: "Schema demo" } }],
    ["bbox with south above north", d => { d.aoi.bbox = [43, -11, 51, -26] }],
    ["country code that is not assigned", d => { d.aoi.countries = ["XXX"] }],
    ["cron field out of range", d => { d.trigger.cron = "61 6 * * *" }],
    ["merge column that is not declared", d => { d.destinations[0].mergeColumns = ["site", "hour"] }],
    ["input reading the definition's own destination", d => { d.inputs.boundaries.tableId = "readings" }],
    ["range rule naming a missing destination", d => { d.validation.ranges[0].destinationId = "nowhere" }],
    ["range rule on a text column", d => { d.validation.ranges[0].field = "site" }],
    ["range rule naming a missing band", d => { d.validation.ranges[1].field = "inches" }],
    ["choice values repeated", d => { d.settings.product.choices[1].value = "daily"; d.settingValues = {} }],
    ["default that is not one of the choices", d => { d.settings.product.default = "hourly" }],
    ["integer default outside its bounds", d => { d.settings.history_days.default = 1000 }],
    ["pattern that is not a regular expression", d => { d.settings.station.pattern = "(" }],
    ["text default that does not match its pattern", d => { d.settings.station.default = "a1" }],
    ["value for an undeclared setting", d => { d.settingValues.depth = 3 }],
    ["value of the wrong type for its setting", d => { d.settingValues.history_days = "ninety" }]
  ]
  for (const [name, edit] of cases) {
    const document = variant(edit)
    assert.equal(schemaAccepts(document), true, `schema is expected to accept: ${name}: ${JSON.stringify(schemaAccepts.errors)}`)
    assert.equal(serverAccepts(document), false, `server should reject: ${name}`)
  }
})
