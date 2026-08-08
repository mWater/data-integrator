import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveArtifactPath, storeArtifact } from "../src/catalog.js"
import { RasterStore } from "../src/rasterStore.js"

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
