import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, readdir, access } from "node:fs/promises"
import { createServer, Server } from "node:http"
import { networkInterfaces, tmpdir } from "node:os"
import path from "node:path"
import { Runner, parseJobOutput } from "../src/runner.js"

const execFileP = promisify(execFile)
const ALPINE = "docker.io/library/alpine:3.20"
const GDAL_IMG = "ghcr.io/osgeo/gdal:alpine-small-latest"

async function ok(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(cmd, args)
    return true
  } catch {
    return false
  }
}

// Stack availability decides whether the suite runs at all
const PODMAN = await ok("podman", ["--version"])
const RUNSC = await access("/usr/local/bin/runsc").then(() => true, () => false)
const AVAILABLE = PODMAN && RUNSC
const HAS_GDAL_IMG = AVAILABLE && (await ok("podman", ["image", "exists", GDAL_IMG]))
const NET_TESTS = AVAILABLE && !process.env.SKIP_NET_TESTS

function lanIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address
    }
  }
  return null
}

const runner = new Runner({ network: "integrator-jobs-test" })

before(async () => {
  if (!AVAILABLE) return
  await execFileP("podman", ["pull", "-q", ALPINE])
  await runner.ensureReady()
}, { timeout: 120_000 })

after(async () => {
  if (!AVAILABLE) return
  await runner.teardown()
})

test("echo job succeeds and returns JSON", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    command: ["sh", "-c", `cat > /dev/null; echo '{"ok":true}'`]
  })
  assert.equal(result.status, "succeeded")
  assert.deepEqual(parseJobOutput(result), { ok: true })
})

test("payload arrives on stdin", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: ALPINE,
    payload: { a: 1, s: "x" },
    command: ["sh", "-c", "cat"]
  })
  assert.equal(result.status, "succeeded")
  assert.deepEqual(JSON.parse(result.stdout), { a: 1, s: "x" })
})

test("nonzero exit reports failed with stderr tail", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    command: ["sh", "-c", "echo boom >&2; exit 3"]
  })
  assert.equal(result.status, "failed")
  assert.equal(result.exitCode, 3)
  assert.match(result.stderrTail, /boom/)
})

test("timeout kills the job", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    command: ["sleep", "60"],
    limits: { timeoutMs: 3000 }
  })
  assert.equal(result.status, "timeout")
  assert.ok(result.durationMs < 30_000)
}, { timeout: 60_000 })

test("mounts: /in readable+readonly, /out writable and collected", { skip: !AVAILABLE }, async () => {
  const inDir = await mkdtemp(path.join(tmpdir(), "job-in-"))
  const outDir = await mkdtemp(path.join(tmpdir(), "job-out-"))
  await writeFile(path.join(inDir, "input.txt"), "hello-input")

  const result = await runner.run({
    image: ALPINE,
    payload: null,
    mounts: { inDir, outDir },
    command: ["sh", "-c", "cp /in/input.txt /out/copied.txt; touch /in/nope 2>/dev/null && echo WRITABLE || echo READONLY"]
  })
  assert.equal(result.status, "succeeded")
  assert.match(result.stdout, /READONLY/)
  assert.equal(await readFile(path.join(outDir, "copied.txt"), "utf8"), "hello-input")
})

test("stderr streams to hook lines", { skip: !AVAILABLE }, async () => {
  const lines: string[] = []
  await runner.run(
    {
      image: ALPINE,
      payload: null,
      command: ["sh", "-c", "echo one >&2; echo two >&2"]
    },
    { onStderrLine: line => lines.push(line) }
  )
  assert.deepEqual(lines.filter(l => l.length > 0), ["one", "two"])
})

test("egress: private blocked, public allowed", { skip: !NET_TESTS }, async t => {
  const ip = lanIp()
  if (!ip) return t.skip("no LAN IP")

  const server: Server = createServer((_req, res) => res.end("hi"))
  await new Promise<void>(resolve => server.listen(8099, ip, resolve))
  try {
    const priv = await runner.run({
      image: ALPINE,
      payload: null,
      command: ["wget", "-q", "-T", "5", "-O", "/dev/null", `http://${ip}:8099/`]
    })
    assert.equal(priv.status, "failed", "private egress must be blocked")

    const pub = await runner.run({
      image: ALPINE,
      payload: null,
      command: ["wget", "-q", "-T", "15", "-O", "/dev/null", "https://example.com"]
    })
    assert.equal(pub.status, "succeeded", "public egress must work")
  } finally {
    server.close()
  }
}, { timeout: 90_000 })

test("network:false gives no network at all", { skip: !NET_TESTS }, async () => {
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    network: false,
    command: ["wget", "-q", "-T", "5", "-O", "/dev/null", "https://example.com"]
  })
  assert.equal(result.status, "failed")
}, { timeout: 30_000 })

test("GDAL pipeline under gVisor writes a COG artifact", { skip: !HAS_GDAL_IMG }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "job-gdal-"))
  const script =
    "set -e; " +
    "gdal_create -of GTiff -outsize 256 256 -bands 1 -ot Float32 -burn 1.5 -a_srs EPSG:4326 -a_ullr -10 10 10 -10 /tmp/src.tif; " +
    "gdal_translate -q -of COG -co COMPRESS=DEFLATE /tmp/src.tif /out/result.tif; " +
    "echo '{\"rasters\":[{\"path\":\"result.tif\"}]}'"
  const result = await runner.run({
    image: GDAL_IMG,
    payload: null,
    mounts: { outDir },
    command: ["sh", "-c", script]
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  const artifacts = await readdir(outDir)
  assert.ok(artifacts.includes("result.tif"))
  assert.deepEqual(parseJobOutput<{ rasters: { path: string }[] }>(result).rasters[0].path, "result.tif")
}, { timeout: 120_000 })
