import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { cellSizeFromInfo, resolveArtifactPath, storeArtifact } from "../src/catalog.js"
import { RasterStore } from "../src/rasterStore.js"

const execFileP = promisify(execFile)

test("resolveArtifactPath: relative, /out-prefixed, and escaping paths", () => {
  assert.equal(resolveArtifactPath("/tmp/job-x", "pop.tif"), "/tmp/job-x/pop.tif")
  // The live-session failure mode: agents naturally declare the absolute container path
  assert.equal(resolveArtifactPath("/tmp/job-x", "/out/pop.tif"), "/tmp/job-x/pop.tif")
  assert.equal(resolveArtifactPath("/tmp/job-x", "sub/pop.tif"), "/tmp/job-x/sub/pop.tif")
  assert.throws(() => resolveArtifactPath("/tmp/job-x", "../escape.tif"), /escapes/)
  assert.throws(() => resolveArtifactPath("/tmp/job-x", "/etc/passwd"), /escapes/)
  assert.throws(() => resolveArtifactPath("/tmp/job-x", "/out/../../etc/passwd"), /escapes/)
})

test("storeArtifact: a missing declared file reports what /out contains", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "catalog-out-"))
  await writeFile(path.join(outDir, "actual.tif"), "x")
  const store = new RasterStore(await mkdtemp(path.join(tmpdir(), "catalog-store-")))
  await assert.rejects(
    () =>
      storeArtifact(store, outDir, { layerId: "l", path: "declared.tif", timestamp: "2026-01-01T00:00:00Z" }, ["b"]),
    /not found in \/out[\s\S]*actual\.tif/
  )
})

test("storeArtifact: records the cell size in metres from the file's grid", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "catalog-out-"))
  const store = new RasterStore(await mkdtemp(path.join(tmpdir(), "catalog-store-")))
  // 20 columns over 20 degrees of longitude: one-degree cells
  await execFileP("gdal_create", [
    "-q", "-of", "GTiff", "-outsize", "20", "20", "-bands", "1", "-burn", "7",
    "-a_srs", "EPSG:4326", "-a_ullr", "10", "10", "30", "0", path.join(outDir, "geo.tif")
  ])
  const geo = await storeArtifact(store, outDir, { layerId: "l", path: "geo.tif", timestamp: "2026-01-01T00:00:00Z" }, ["b"])
  assert.equal(geo.cellSizeM, 111320)

  // A projected grid keeps its own units: 20 columns over 20 km
  await execFileP("gdal_create", [
    "-q", "-of", "GTiff", "-outsize", "20", "20", "-bands", "1", "-burn", "7",
    "-a_srs", "EPSG:3857", "-a_ullr", "0", "20000", "20000", "0", path.join(outDir, "proj.tif")
  ])
  const proj = await storeArtifact(store, outDir, { layerId: "l", path: "proj.tif", timestamp: "2026-01-01T00:00:00Z" }, ["b"])
  assert.equal(proj.cellSizeM, 1000)

  // Declared footprint and CRS do not bypass the file read
  const declared = await storeArtifact(
    store,
    outDir,
    { layerId: "l", path: "geo.tif", timestamp: "2026-01-01T00:00:00Z", footprint: [10, 0, 30, 10], crs: "EPSG:4326" },
    ["b"]
  )
  assert.equal(declared.cellSizeM, 111320)

  const empty = await storeArtifact(store, outDir, { layerId: "l", sources: [], timestamp: "2026-01-01T00:00:00Z" }, ["b"])
  assert.equal(empty.cellSizeM, null)
})

test("cellSizeFromInfo: geographic degrees convert, projected units pass through, no grid is null", () => {
  assert.equal(cellSizeFromInfo({ geoTransform: [0, 0.25, 0, 0, 0, -0.25], coordinateSystem: { wkt: 'GEOGCRS["WGS 84"]' } }), 27830)
  assert.equal(cellSizeFromInfo({ geoTransform: [0, 30, 0, 0, 0, -30], coordinateSystem: { wkt: 'PROJCRS["UTM"]' } }), 30)
  assert.equal(cellSizeFromInfo({}), null)
})
