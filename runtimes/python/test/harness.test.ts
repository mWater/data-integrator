import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readdir, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Runner, parseJobOutput } from "@data-integrator/runner"

const execFileP = promisify(execFile)
const IMAGE = "localhost/integrator-runtime-python:dev"

async function ok(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(cmd, args)
    return true
  } catch {
    return false
  }
}

const PODMAN = await ok("podman", ["--version"])
const RUNSC = await access("/usr/local/bin/runsc").then(() => true, () => false)
const HAS_IMAGE = PODMAN && (await ok("podman", ["image", "exists", IMAGE]))
const AVAILABLE = PODMAN && RUNSC && HAS_IMAGE
if (PODMAN && RUNSC && !HAS_IMAGE) {
  console.error(`Skipping: build the image first (pnpm build:image in runtimes/python)`)
}

// Harness tests are network-free: every job runs with network:false
const runner = new Runner({ network: "integrator-jobs-pytest", egress: "open" })

before(async () => {
  if (!AVAILABLE) return
  await runner.ensureReady()
}, { timeout: 60_000 })

after(async () => {
  if (!AVAILABLE) return
  await runner.teardown()
})

const RUN_CODE = `
import numpy as np
import rasterio
from rasterio.transform import from_origin

def run(ctx):
    print("log line from integration")  # must land on stderr, not stdout
    data = (np.ones((64, 64)) * ctx.params["value"]).astype("float32")
    with rasterio.open(
        f"{ctx.out_dir}/layer.tif", "w", driver="GTiff",
        width=64, height=64, count=1, dtype="float32",
        crs="EPSG:4326", transform=from_origin(-10, 10, 0.1, 0.1),
    ) as dst:
        dst.write(data, 1)
    return {
        "rasters": [{"path": "layer.tif"}],
        "data": {"stats": [{"mean": float(data.mean())}]},
        "state": {"cursor": (ctx.previous_state or {}).get("cursor", 0) + 1},
    }
`

test("run mode: entrypoint, mounts, result JSON, print-redirect", { skip: !AVAILABLE }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "pyjob-out-"))
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      definition: { code: RUN_CODE },
      previousState: { cursor: 41 },
      params: { value: 2.5 }
    },
    mounts: { outDir }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  const output = parseJobOutput<{
    rasters: { path: string }[]
    data: { stats: { mean: number }[] }
    state: { cursor: number }
  }>(result)
  assert.equal(output.rasters[0].path, "layer.tif")
  assert.equal(output.data.stats[0].mean, 2.5)
  assert.equal(output.state.cursor, 42)
  assert.ok((await readdir(outDir)).includes("layer.tif"))
  assert.match(result.stderrTail, /log line from integration/)
  assert.doesNotMatch(result.stdout, /log line/)
}, { timeout: 120_000 })

test("snippet mode: prints go to stdout", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      mode: "snippet",
      code: `import rasterio, xarray, geopandas\nprint("libs ok", ctx.params["msg"])`,
      params: { msg: "hello" }
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /libs ok hello/)
}, { timeout: 120_000 })

test("exception produces failed status with traceback", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: { definition: { code: `def run(ctx):\n    raise ValueError("nope")` } }
  })
  assert.equal(result.status, "failed")
  assert.match(result.stderrTail, /ValueError: nope/)
}, { timeout: 120_000 })

test("gdal CLI is present for subprocess use", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      mode: "snippet",
      code: `import subprocess\nprint(subprocess.run(["gdalinfo", "--version"], capture_output=True, text=True).stdout)`
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /GDAL \d/)
}, { timeout: 120_000 })
