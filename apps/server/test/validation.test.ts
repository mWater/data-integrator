import { test } from "node:test"
import assert from "node:assert/strict"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { validateDefinition } from "../src/install.js"
import { durationMs } from "../src/validation.js"

/** Definition with one numeric table column and one raster band, plus the given validation block. */
function withValidation(validation: unknown): IntegrationDefinition {
  return {
    id: "rules_demo",
    name: { _base: "en", en: "Rules demo" },
    trigger: {},
    runtime: "python",
    destinations: [
      { kind: "table", tableId: "readings", action: "append", columns: [{ id: "site", type: "text" }, { id: "level", type: "number" }] },
      { kind: "raster", layerId: "rain", temporality: "time-series", bands: [{ id: "mm" }] }
    ],
    code: "",
    contract: 2,
    validation: validation as IntegrationDefinition["validation"]
  }
}

test("durationMs: ISO 8601 durations, months as 30 days", () => {
  assert.equal(durationMs("P1D"), 86_400_000)
  assert.equal(durationMs("PT6H"), 6 * 3_600_000)
  assert.equal(durationMs("P1M"), 30 * 86_400_000)
  assert.equal(durationMs("P1W"), 7 * 86_400_000)
  assert.equal(durationMs("P1DT12H"), 36 * 3_600_000)
  for (const bad of ["P", "PT", "1D", "P1.5D", "daily"]) assert.equal(durationMs(bad), null, bad)
})

test("validateDefinition: validation rules must name real numeric fields and a known cadence", () => {
  validateDefinition(withValidation({
    expectedCadence: "P1D",
    ranges: [{ destinationId: "readings", field: "level", min: 0 }, { destinationId: "rain", field: "mm", min: 0, max: 2000 }]
  }))
  const rejects = (validation: unknown, pattern: RegExp) => assert.throws(() => validateDefinition(withValidation(validation)), pattern)
  rejects({ expectedCadence: "daily" }, /not an ISO 8601 duration/)
  rejects({ ranges: [{ destinationId: "readings", field: "level" }] }, /needs min, max, or both/)
  rejects({ ranges: [{ destinationId: "nowhere", field: "level", min: 0 }] }, /no destination nowhere/)
  rejects({ ranges: [{ destinationId: "readings", field: "site", min: 0 }] }, /not a number or integer column/)
  rejects({ ranges: [{ destinationId: "rain", field: "inches", min: 0 }] }, /not a band of rain/)
  rejects({ readings: { requiredColumns: ["site"] } }, /Unknown validation field/)
})

test("library entries never share a destination id, so any two can be installed together", async () => {
  const { readdir, readFile } = await import("node:fs/promises")
  const root = new URL("../../../library/integrations/", import.meta.url)
  const owners = new Map<string, string>()
  for (const id of await readdir(root)) {
    const definition = JSON.parse(await readFile(new URL(`${id}/definition.json`, root), "utf8")) as IntegrationDefinition
    validateDefinition(definition)
    for (const dest of definition.destinations) {
      const destId = dest.kind === "table" ? dest.tableId : dest.layerId
      assert.equal(owners.get(destId), undefined, `${destId} is written by both ${owners.get(destId)} and ${id}`)
      owners.set(destId, id)
    }
  }
})
