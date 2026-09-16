import { test, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { RasterStore } from "../src/rasterStore.js"
import { TileRenderer } from "../src/tiles.js"

const execFileP = promisify(execFile)

test("sample reads a COG pixel at a WGS84 point", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tiles-sample-"))
  after(() => rm(root, { recursive: true, force: true }))
  const tif = path.join(root, "snap.tif")
  await execFileP("gdal_create", [
    "-of", "GTiff", "-outsize", "20", "20", "-bands", "1", "-burn", "7",
    "-a_srs", "EPSG:4326", "-a_ullr", "10", "10", "30", "0", tif
  ])
  const tiles = new TileRenderer(new RasterStore(root), path.join(root, "cache"))
  const sources = [{ path: "snap.tif", bbox: [10, 0, 30, 10] as [number, number, number, number] }]
  assert.equal(await tiles.sample(sources, 1, 20, 5), 7)
  assert.equal(await tiles.sample(sources, 1, 0, 0), null)
  assert.equal(await tiles.sample([], 1, 20, 5), null)
})

test("cache-miss renders pass through the concurrency gate; hung-up waiters skip rendering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tiles-gate-"))
  after(() => rm(root, { recursive: true, force: true }))
  const tif = path.join(root, "snap.tif")
  await execFileP("gdal_create", [
    "-of", "GTiff", "-outsize", "64", "64", "-bands", "1", "-burn", "7",
    "-a_srs", "EPSG:4326", "-a_ullr", "-180", "85", "180", "-85", tif
  ])
  const tiles = new TileRenderer(new RasterStore(root), path.join(root, "cache"), { maxConcurrentRenders: 2 })
  const sources = [{ path: "snap.tif", bbox: [-180, -85, 180, 85] as [number, number, number, number] }]
  const rendering = { colorMap: [{ value: 0, color: "#000000" }, { value: 10, color: "#ffffff" }] }

  let peak = 0
  const probe = setInterval(() => {
    peak = Math.max(peak, tiles.rendering)
  }, 1)
  const coords = [0, 1, 2, 3].flatMap(x => [0, 1].map(y => [x, y]))
  const results = await Promise.all(
    coords.map(([x, y]) => tiles.tile("layer", "snap", sources, "b1", rendering as never, 2, x, y))
  )
  clearInterval(probe)
  assert.equal(results.length, 8)
  for (const png of results) assert.ok(png && png.length > 0)
  assert.ok(peak >= 1 && peak <= 2, `peak concurrent renders ${peak}`)

  // A second, identical request is a cache hit and never takes a slot
  const again = await tiles.tile("layer", "snap", sources, "b1", rendering as never, 2, 0, 0)
  assert.deepEqual(again, results[0])

  // A queued request whose client hung up resolves null without rendering
  const dead = await tiles.tile("layer", "snap", sources, "b1", rendering as never, 3, 0, 0, () => false)
  assert.equal(dead, null)
})
