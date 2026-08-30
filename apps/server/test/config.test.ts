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
  assert.equal(config.viteDevUrl, null)
  assert.ok(config.basemap.upstream)
})

test("loadConfig: VITE_DEV_URL must be a local origin", () => {
  const config = loadConfig({ DATABASE_URL: DB, VITE_DEV_URL: "http://127.0.0.1:5173" })
  assert.equal(config.viteDevUrl, "http://127.0.0.1:5173")
  assert.throws(() => loadConfig({ DATABASE_URL: DB, VITE_DEV_URL: "https://example.com" }), /VITE_DEV_URL/)
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

// resolveAoi: the executor's tri-state resolution
import { resolveAoi } from "../src/executor.js"
import { IntegrationDefinition } from "@data-integrator/definitions"

const BASE = { id: "t", name: "T", trigger: {}, runtime: "node22", destinations: [], code: "", contract: 2 } as unknown as IntegrationDefinition
const DEFAULT = { bbox: [11.7, -18.1, 24.1, -4.4] as [number, number, number, number], countries: ["AGO"] }

test("resolveAoi: absent aoi inherits the deployment default", () => {
  const resolved = resolveAoi(BASE, DEFAULT)
  assert.deepEqual(resolved.aoi, { bbox: DEFAULT.bbox, countries: ["AGO"] })
})

test("resolveAoi: absent aoi with no default stays absent", () => {
  assert.equal("aoi" in resolveAoi(BASE, null), false)
})

test("resolveAoi: explicit null strips to full extent even with a default", () => {
  const resolved = resolveAoi({ ...BASE, aoi: null }, DEFAULT)
  assert.equal("aoi" in resolved, false)
})

test("resolveAoi: explicit box wins over the default", () => {
  const box = { bbox: [0, 0, 1, 1] as [number, number, number, number] }
  assert.deepEqual(resolveAoi({ ...BASE, aoi: box }, DEFAULT).aoi, box)
})
