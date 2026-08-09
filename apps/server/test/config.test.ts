import { test } from "node:test"
import assert from "node:assert/strict"
import { loadConfig } from "../src/config.js"
import { parseDefaultAoi } from "../src/settings.js"
import { COUNTRIES } from "../src/countries.js"

const DB = "postgres://u:p@localhost:5432/db"

test("loadConfig: minimal valid environment applies defaults", () => {
  const config = loadConfig({ DATABASE_URL: DB })
  assert.equal(config.databaseUrl, DB)
  assert.equal(config.port, 8080)
  assert.equal(config.rasterStorePath, "./raster-store")
  assert.equal(config.secretKey, null)
  assert.equal(config.agent.openrouterKey, null)
  assert.ok(config.basemap.upstream)
})

test("loadConfig: reports every problem at once", () => {
  assert.throws(
    () => loadConfig({ PORT: "eighty", AGENT_EFFORT: "extreme" }),
    (err: Error) =>
      err.message.includes("DATABASE_URL") &&
      err.message.includes("PORT") &&
      err.message.includes("AGENT_EFFORT")
  )
})

test("loadConfig: rejects non-postgres DATABASE_URL", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: "mysql://nope" }), /postgres/)
})

test("loadConfig: rejects a malformed secret key", () => {
  assert.throws(() => loadConfig({ DATABASE_URL: DB, INTEGRATOR_SECRET_KEY: "tooshort" }), /32 bytes/)
})

test("loadConfig: basemap off disables the proxy", () => {
  const config = loadConfig({ DATABASE_URL: DB, BASEMAP_UPSTREAM: "off" })
  assert.equal(config.basemap.upstream, null)
})

test("countries: plausible list with the pilot countries", () => {
  assert.ok(COUNTRIES.length > 200)
  const mdg = COUNTRIES.find(c => c.iso3 === "MDG")
  const ago = COUNTRIES.find(c => c.iso3 === "AGO")
  assert.ok(mdg && ago)
  const [west, south, east, north] = mdg!.bbox
  assert.ok(west > 42 && east < 51 && south > -26 && north < -11)
  assert.ok(west < east && south < north)
})

test("parseDefaultAoi: accepts a country selection and normalizes codes", () => {
  const aoi = parseDefaultAoi({ bbox: [11.7, -18.1, 24.1, -4.4], countries: ["ago"], name: "Angola" })
  assert.deepEqual(aoi, { bbox: [11.7, -18.1, 24.1, -4.4], countries: ["AGO"], name: "Angola" })
})

test("parseDefaultAoi: accepts an antimeridian-crossing box", () => {
  const aoi = parseDefaultAoi({ bbox: [174.5, -21.7, -178.2, -12.4] })
  assert.deepEqual(aoi.bbox, [174.5, -21.7, -178.2, -12.4])
})

test("parseDefaultAoi: rejects malformed values", () => {
  assert.throws(() => parseDefaultAoi({ bbox: [1, 2, 3] }), /bbox must be/)
  assert.throws(() => parseDefaultAoi({ bbox: [0, 10, 10, 5] }), /south < north/)
  assert.throws(() => parseDefaultAoi({ bbox: [200, 0, 10, 5] }), /longitudes/)
  assert.throws(() => parseDefaultAoi({ bbox: [0, 0, 10, 5], countries: ["XXX"] }), /Unknown country/)
})
