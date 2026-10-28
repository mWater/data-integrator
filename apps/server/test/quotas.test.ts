import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile, readdir, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { IntegrationDefinition } from "@data-integrator/definitions"
import { DEFAULT_JOB_MEMORY_MB, effectiveJobLimits, effectiveWorkQuotaMb, freeDiskMb } from "../src/executor.js"
import { JOB_LIMIT_DEFAULTS } from "@mwater/integration-runner"
import { RasterStore } from "../src/rasterStore.js"
import { TileRenderer } from "../src/tiles.js"

/** Minimal definition with the given workDiskMb declaration. */
function definitionWith(workDiskMb?: number): IntegrationDefinition {
  return {
    id: "quota_demo",
    name: "Quota demo",
    trigger: {},
    runtime: "node",
    destinations: [],
    code: "",
    contract: 2,
    ...(workDiskMb !== undefined ? { limits: { workDiskMb } } : {})
  }
}

test("effectiveWorkQuotaMb: ceiling is both default and cap", () => {
  // No ceiling configured: the declaration stands alone
  assert.equal(effectiveWorkQuotaMb(definitionWith(), {}), null)
  assert.equal(effectiveWorkQuotaMb(definitionWith(512), {}), 512)
  // Ceiling configured: applies when nothing is declared, caps what is
  assert.equal(effectiveWorkQuotaMb(definitionWith(), { workQuotaMb: 2048 }), 2048)
  assert.equal(effectiveWorkQuotaMb(definitionWith(512), { workQuotaMb: 2048 }), 512)
  assert.equal(effectiveWorkQuotaMb(definitionWith(99999), { workQuotaMb: 2048 }), 2048)
  // 0 disables the ceiling
  assert.equal(effectiveWorkQuotaMb(definitionWith(), { workQuotaMb: 0 }), null)
})

test("effectiveJobLimits: deployment ceilings lower what definitions request", () => {
  const requested = { cpus: 16, memoryMb: 65536, timeoutMs: 86_400_000 }
  const capped = effectiveJobLimits(requested, { jobMax: { cpus: 4, memoryMb: 8192, timeoutMs: 3_600_000 } })
  assert.deepEqual([capped.cpus, capped.memoryMb, capped.timeoutMs], [4, 8192, 3_600_000])
  assert.equal(capped.notes.length, 3)
  assert.match(capped.notes[1], /memoryMb 65536 lowered to the deployment maximum 8192 \(JOB_MAX_MEMORY_MB\)/)

  // Within the ceilings, or no ceilings: requests stand, nothing logged; gaps take the runner defaults
  const within = effectiveJobLimits({ cpus: 2, memoryMb: 4096 }, { jobMax: { cpus: 4, memoryMb: 8192 } })
  assert.deepEqual([within.cpus, within.memoryMb, within.timeoutMs, within.notes.length], [2, 4096, JOB_LIMIT_DEFAULTS.timeoutMs, 0])
  assert.equal(effectiveJobLimits(requested, { jobMax: { memoryMb: 0 } }).memoryMb, 65536)

  // Defaults are capped too, silently: nothing was asked for
  const small = effectiveJobLimits(undefined, { jobMax: { cpus: 1, memoryMb: 1024, timeoutMs: 60_000 } })
  assert.deepEqual([small.cpus, small.memoryMb, small.timeoutMs, small.notes.length], [1, 1024, 60_000, 0])
  assert.equal(effectiveJobLimits(undefined, {}).memoryMb, DEFAULT_JOB_MEMORY_MB)
})

test("freeDiskMb: real filesystems report, bogus paths are null", async () => {
  const free = await freeDiskMb(tmpdir())
  assert.ok(free !== null && free > 0)
  assert.equal(await freeDiskMb("/nonexistent/nowhere"), null)
})

test("tile cache eviction removes oldest files until the budget fits", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tile-cache-"))
  const tiles = new TileRenderer(new RasterStore("/nonexistent"), cacheDir)

  // Three 1 MB files, oldest first; a 2 MB budget must evict exactly the oldest
  const megabyte = Buffer.alloc(1024 * 1024)
  const now = Date.now() / 1000
  for (const [i, name] of ["old", "mid", "new"].entries()) {
    const dir = path.join(cacheDir, "layer", name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "tile.png"), megabyte)
    await utimes(path.join(dir, "tile.png"), now - (3 - i) * 3600, now - (3 - i) * 3600)
  }

  assert.equal(await tiles.evictToBudget(4), 0)
  assert.equal(await tiles.evictToBudget(2), 1)
  const survivors: string[] = []
  for (const name of ["old", "mid", "new"]) {
    const entries = await readdir(path.join(cacheDir, "layer", name)).catch(() => [])
    if (entries.length > 0) survivors.push(name)
  }
  assert.deepEqual(survivors, ["mid", "new"])
  // 0 disables eviction entirely
  assert.equal(await tiles.evictToBudget(0), 0)
})
