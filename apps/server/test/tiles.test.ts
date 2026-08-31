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
  assert.equal(await tiles.sample("snap.tif", 1, 20, 5), 7)
  assert.equal(await tiles.sample("snap.tif", 1, 0, 0), null)
})
