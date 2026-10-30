import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readdir, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Runner, parseJobOutput } from "@mwater/integration-runner"

const execFileP = promisify(execFile)
/** Image under test; the release script points this at the versioned build. */
const IMAGE = process.env.RUNTIME_IMAGE_PYTHON ?? "localhost/integrator-runtime-python:dev"

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
        "state": {"cursor": (ctx.previous_state or {}).get("cursor", 0) + 1, "catalog": ctx.catalog},
    }
`

/** What the server tells the job it has already published, per raster destination. */
const CATALOG = { rain: { snapshots: [{ timestamp: "2026-01-01T00:00:00Z", sources: 1 }] } }

test("run mode: entrypoint, mounts, result JSON, print-redirect", { skip: !AVAILABLE }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "pyjob-out-"))
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      definition: { code: RUN_CODE },
      previousState: { cursor: 41 },
      params: { value: 2.5 },
      catalog: CATALOG
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

test("run mode: subprocess stdout cannot corrupt the result channel", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      definition: {
        code: `import subprocess
def run(ctx):
    subprocess.run(["sh", "-c", "echo CONTAMINANT"], check=True)  # inherits fd 1
    return {"state": {"ok": True}}
`
      }
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  const output = parseJobOutput<{ state: { ok: boolean } }>(result)
  assert.equal(output.state.ok, true)
  assert.doesNotMatch(result.stdout, /CONTAMINANT/)
  assert.match(result.stderrTail, /CONTAMINANT/)
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

test("multi-file job: packages and relative imports", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      files: {
        "flood/__init__.py": "",
        "flood/grids.py": "def double(n):\n    return n * 2\n",
        "flood/daily.py": "from .grids import double\n\ndef run(ctx):\n    return {'state': {'value': double(ctx.params['n'])}}\n"
      },
      entry: "flood/daily.py",
      params: { n: 21 }
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.deepEqual(parseJobOutput<{ state: unknown }>(result).state, { value: 42 })
}, { timeout: 120_000 })

test("multi-file job: snippets can import the files", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      mode: "snippet",
      files: { "flood/grids.py": "def double(n):\n    return n * 2\n" },
      code: "from flood.grids import double\nprint('doubled', double(4))"
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /doubled 8/)
}, { timeout: 120_000 })

test("multi-file job: paths escaping the code directory are rejected", { skip: !AVAILABLE }, async () => {
  for (const bad of ["../escape.py", "/tmp/abs.py", "a/./b.py"]) {
    const result = await runner.run({
      image: IMAGE,
      network: false,
      payload: { files: { [bad]: "def run(ctx):\n    return {}\n" }, entry: bad }
    })
    assert.equal(result.status, "failed", bad)
    assert.match(result.stderrTail, /invalid file path/, bad)
  }
}, { timeout: 120_000 })

test("GRIB stack: eccodes writes and cfgrib reads a GRIB2 message", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      mode: "snippet",
      code: `import eccodes, xarray
gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
with open("/tmp/sample.grib2", "wb") as f:
    eccodes.codes_write(gid, f)
eccodes.codes_release(gid)
ds = xarray.open_dataset("/tmp/sample.grib2", engine="cfgrib", backend_kwargs={"indexpath": ""})
print("grib vars", sorted(ds.data_vars), dict(ds.sizes))`
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /grib vars/)
}, { timeout: 120_000 })

test("forecast and array libraries import (cdsapi, scipy, ecmwf-opendata)", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      mode: "snippet",
      code: `import cdsapi, scipy.ndimage, ecmwf.opendata\nprint("forecast libs ok")`
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /forecast libs ok/)
}, { timeout: 120_000 })
