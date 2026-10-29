import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, readdir, access, rm, stat } from "node:fs/promises"
import { createServer, Server } from "node:http"
import { networkInterfaces, tmpdir } from "node:os"
import path from "node:path"
import { Runner, parseJobOutput, podmanScopeCgroup, scopeLimitsProblem } from "../src/runner.js"

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

const runner = new Runner({ network: "integrator-jobs-test", diskMonitorMs: 500 })

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

test("stdout past the cap reports the size, not broken JSON", { skip: !AVAILABLE }, async () => {
  const capped = new Runner({ network: "integrator-jobs-test", stdoutLimitBytes: 64 * 1024 })
  const result = await capped.run({
    image: ALPINE,
    payload: null,
    // Valid JSON until the cap cuts it off, which is how a too-big result looks
    command: ["sh", "-c", `printf '{"data":"'; head -c 200000 /dev/zero | tr '\\0' x; printf '"}'`]
  })
  assert.equal(result.status, "succeeded")
  assert.ok(result.stdoutTruncated)
  assert.equal(result.stdoutLimitBytes, 64 * 1024)
  assert.throws(() => parseJobOutput(result), /exceeded the 64 KB stdout limit.*tables\[\]/s)
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

test("abort handle kills the job with its reason", { skip: !AVAILABLE }, async () => {
  const result = await runner.run(
    { image: ALPINE, payload: null, command: ["sleep", "30"], limits: { timeoutMs: 60_000 } },
    { onStart: handle => setTimeout(() => handle.abort("disk quota exceeded (test)"), 1000) }
  )
  assert.equal(result.status, "failed")
  assert.equal(result.abortedReason, "disk quota exceeded (test)")
  assert.ok(result.durationMs < 30_000)
})

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

test("mounts: extra read-only host paths", { skip: !AVAILABLE }, async () => {
  const shared = await mkdtemp(path.join(tmpdir(), "job-shared-"))
  await writeFile(path.join(shared, "static.txt"), "static-data")
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    mounts: { readOnly: [{ hostPath: shared, containerPath: "/mnt/static" }] },
    command: ["sh", "-c", "cat /mnt/static/static.txt; touch /mnt/static/nope 2>/dev/null && echo WRITABLE || echo READONLY"]
  })
  assert.equal(result.status, "succeeded")
  assert.match(result.stdout, /static-data/)
  assert.match(result.stdout, /READONLY/)
})

test("workDiskMb: a job filling /work past its quota is killed", { skip: !AVAILABLE }, async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "job-work-"))
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    mounts: { workDir },
    limits: { workDiskMb: 5, timeoutMs: 60_000 },
    command: ["sh", "-c", "dd if=/dev/zero of=/work/blob bs=1M count=20 2>/dev/null; sleep 30"]
  })
  assert.equal(result.status, "failed")
  assert.match(result.abortedReason ?? "", /\/work reached \d+ MB, over the 5 MB quota/)
  assert.ok(result.durationMs < 30_000)
})

test("mounts: a tmpDir replaces the tmpfs at /tmp, beyond its size", { skip: !AVAILABLE }, async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "job-tmp-"))
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    mounts: { tmpDir },
    limits: { tmpfsMb: 4, tmpDiskMb: 64 },
    command: ["sh", "-c", "dd if=/dev/zero of=/tmp/blob bs=1M count=16 2>/dev/null && echo WROTE"]
  })
  assert.equal(result.status, "succeeded")
  assert.match(result.stdout, /WROTE/)
  assert.equal((await stat(path.join(tmpDir, "blob"))).size, 16 * 1024 * 1024)
})

test("tmpDiskMb: a job filling a disk-backed /tmp past its quota is killed", { skip: !AVAILABLE }, async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "job-tmp-"))
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    mounts: { tmpDir },
    limits: { tmpDiskMb: 5, timeoutMs: 60_000 },
    command: ["sh", "-c", "dd if=/dev/zero of=/tmp/blob bs=1M count=20 2>/dev/null; sleep 30"]
  })
  assert.equal(result.status, "failed")
  assert.match(result.abortedReason ?? "", /\/tmp reached \d+ MB, over the 5 MB quota/)
  assert.ok(result.durationMs < 30_000)
})

test("labels: orphaned job containers are found and killed by label", { skip: !AVAILABLE }, async () => {
  const running = runner.run({
    image: ALPINE,
    payload: null,
    labels: { "test.owner": "orphan-sweep" },
    command: ["sleep", "30"],
    limits: { timeoutMs: 60_000 }
  })
  await new Promise(resolve => setTimeout(resolve, 2000))
  assert.equal(await runner.killLabelled("test.owner", "orphan-sweep"), 1)
  const result = await running
  assert.notEqual(result.status, "succeeded")
  assert.ok(result.durationMs < 30_000)
  assert.equal(await runner.killLabelled("test.owner", "orphan-sweep"), 0)
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

test("egress: rules are re-applied when the keeper dies between jobs", { skip: !NET_TESTS }, async t => {
  const ip = lanIp()
  if (!ip) return t.skip("no LAN IP")

  const server: Server = createServer((_req, res) => res.end("hi"))
  await new Promise<void>(resolve => server.listen(8098, ip, resolve))
  try {
    // Losing the keeper tears down the netns and its drop rules with it
    await execFileP("podman", ["rm", "-f", "integrator-jobs-test-keeper"])
    const afterKeeperLoss = await runner.run({
      image: ALPINE,
      payload: null,
      command: ["wget", "-q", "-T", "5", "-O", "/dev/null", `http://${ip}:8098/`]
    })
    assert.equal(afterKeeperLoss.status, "failed", "private egress must stay blocked after keeper loss")

    await execFileP("podman", ["unshare", "--rootless-netns", "nft", "delete", "table", "inet", "integrator_egress"])
    const afterRulesLoss = await runner.run({
      image: ALPINE,
      payload: null,
      command: ["wget", "-q", "-T", "5", "-O", "/dev/null", `http://${ip}:8098/`]
    })
    assert.equal(afterRulesLoss.status, "failed", "private egress must stay blocked after the ruleset is lost")
  } finally {
    server.close()
  }
}, { timeout: 90_000 })

test("egress meter: traffic is counted per job, including concurrent jobs", { skip: !NET_TESTS }, async () => {
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      runner.run({
        image: ALPINE,
        payload: null,
        // Reads stdin first, as the harness does, so it starts only once metered. Retries
        // because the public internet occasionally drops a lookup or stalls a download.
        command: ["sh", "-c", "cat > /dev/null; for i in 1 2 3; do wget -q -T 15 -O /dev/null https://example.com && exit 0; sleep 2; done; exit 1"]
      })
    )
  )
  for (const result of results) {
    assert.equal(result.status, "succeeded", result.stderrTail)
    assert.ok((result.egressBytes ?? 0) > 500, `metered ${result.egressBytes} bytes`)
  }
}, { timeout: 90_000 })

test("egress quota: a job transferring past egressMb fails with the reason", { skip: !NET_TESTS }, async () => {
  const quick = new Runner({ network: "integrator-jobs-test", diskMonitorMs: 500 })
  const result = await quick.run({
    image: ALPINE,
    payload: null,
    limits: { egressMb: 2, timeoutMs: 60_000 },
    command: ["sh", "-c", "cat > /dev/null; wget -q -T 10 -O /dev/null 'https://speed.cloudflare.com/__down?bytes=20000000'; echo DONE"]
  })
  assert.equal(result.status, "failed")
  assert.match(result.abortedReason ?? "", /network traffic reached \d+ MB, over the 2 MB quota/)
}, { timeout: 90_000 })

test("egress meter: ensureReady sweeps meters of vanished jobs only", { skip: !NET_TESTS }, async () => {
  const nft = (...args: string[]) => execFileP("podman", ["unshare", "--rootless-netns", "nft", ...args])
  await nft("add", "counter", "inet", "integrator_meter", "c_job_deadbeef")
  await nft("add", "chain", "inet", "integrator_meter", "j_job_deadbeef")
  await nft("add", "rule", "inet", "integrator_meter", "j_job_deadbeef", "counter", "name", "c_job_deadbeef")
  await nft("add", "element", "inet", "integrator_meter", "jobs4", "{ 10.89.250.250 : jump j_job_deadbeef }")

  // A live job's meter must survive a sweep run while it is transferring
  const live = runner.run({
    image: ALPINE,
    payload: null,
    command: ["sh", "-c", "cat > /dev/null; sleep 4; wget -q -T 15 -O /dev/null https://example.com"]
  })
  await new Promise(resolve => setTimeout(resolve, 2500))
  await runner.ensureReady()
  const { stdout } = await nft("list", "table", "inet", "integrator_meter")
  assert.doesNotMatch(stdout, /job_deadbeef/)
  const result = await live
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.ok((result.egressBytes ?? 0) > 500, `metered ${result.egressBytes} bytes`)
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

/** MAC address of the test network's bridge, inside the rootless netns. */
async function bridgeMac(): Promise<string> {
  const { stdout: bridge } = await execFileP("podman", ["network", "inspect", "--format", "{{.NetworkInterface}}", "integrator-jobs-test"])
  const { stdout } = await execFileP("podman", ["unshare", "--rootless-netns", "ip", "-j", "link", "show", "dev", bridge.trim()])
  return (JSON.parse(stdout) as { address: string }[])[0].address
}

test("the job bridge keeps its MAC while job containers join and leave", { skip: !NET_TESTS }, async () => {
  // An unpinned bridge takes the lowest MAC among its ports, so six joining jobs move it most times
  await runner.ensureReady()
  const before = await bridgeMac()
  const jobs = [1, 2, 3, 4, 5, 6].map(() =>
    runner.run({ image: ALPINE, payload: null, command: ["sh", "-c", "cat > /dev/null; sleep 4"] })
  )
  await new Promise(resolve => setTimeout(resolve, 2500))
  const during = await bridgeMac()
  await Promise.all(jobs)
  assert.equal(during, before, "MAC changed as jobs joined")
  assert.equal(await bridgeMac(), before, "MAC changed as jobs left")
}, { timeout: 60_000 })

test("overlapping networked jobs all get a network, and every job container is removed", { skip: !NET_TESTS }, async () => {
  // Batches back to back, so starts overlap other jobs' starts and teardowns
  const label = `overlap-${Date.now()}`
  for (let round = 0; round < 8; round++) {
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        runner.run({
          image: ALPINE,
          payload: null,
          labels: { "integrator-test": label },
          // Retries ride out a flaky remote; a job left with no network fails every attempt
          command: ["sh", "-c", "cat > /dev/null; for i in 1 2 3; do wget -q -T 10 -O /dev/null https://example.com && exit 0; sleep 2; done; exit 1"]
        })
      )
    )
    for (const result of results) assert.equal(result.status, "succeeded", `round ${round}: ${result.stderrTail}`)
  }
  const offline = await runner.run({ image: ALPINE, payload: null, network: false, labels: { "integrator-test": label }, command: ["true"] })
  assert.equal(offline.status, "succeeded")
  const { stdout } = await execFileP("podman", ["ps", "-a", "-q", "--filter", `label=integrator-test=${label}`])
  assert.equal(stdout.trim(), "", "no job container is left behind")
}, { timeout: 180_000 })

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

/** gVisor sandbox processes on the host */
async function sandboxCount(): Promise<number> {
  try {
    const { stdout } = await execFileP("pgrep", ["-fc", "^runsc-sandbox"])
    return Number(stdout.trim())
  } catch {
    return 0
  }
}

test("a job whose limits cannot be applied never runs and leaves nothing behind", { skip: !AVAILABLE }, async () => {
  const before = await sandboxCount()
  // A systemctl that always fails stands in for a host where the cap cannot be set
  const fakeBin = await mkdtemp(path.join(tmpdir(), "fake-bin-"))
  await writeFile(path.join(fakeBin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${fakeBin}:${savedPath}`
  let result
  try {
    result = await runner.run({
      image: ALPINE,
      payload: null,
      network: false,
      labels: { "test.owner": "cap-fail" },
      command: ["sleep", "30"],
      limits: { timeoutMs: 60_000 }
    })
  } finally {
    process.env.PATH = savedPath
  }
  assert.equal(result.status, "failed")
  assert.match(result.abortedReason ?? "", /could not be applied/)
  assert.ok(result.durationMs < 20_000, `took ${result.durationMs} ms`)
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(await runner.killLabelled("test.owner", "cap-fail"), 0, "container left behind")
  assert.equal(await sandboxCount(), before, "sandbox process left behind")
})

test("podman's scope is found whether podman is in it or already in its runtime child", () => {
  const scope = "/user.slice/user-1000.slice/user@1000.service/user.slice/podman-42.scope"
  assert.equal(podmanScopeCgroup(scope, 42), scope)
  // --cgroups=split moves podman into scope/runtime tens of milliseconds after the scope
  assert.equal(podmanScopeCgroup(scope + "/runtime", 42), scope)
  // Before the move, and another process's scope, are not podman's
  assert.equal(podmanScopeCgroup("/user.slice/user-1000.slice/user@1000.service/app.slice/app-x.scope", 42), null)
  assert.equal(podmanScopeCgroup("/user.slice/user-1000.slice/user@1000.service/user.slice/podman-420.scope/runtime", 42), null)
})

test("scope limit verification reads the kernel's files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cgroup-"))
  const limits = { memoryMb: 512, cpus: 1.5, tasksMax: 300 }
  await writeFile(path.join(dir, "memory.max"), "536870912\n")
  await writeFile(path.join(dir, "memory.swap.max"), "0\n")
  await writeFile(path.join(dir, "pids.max"), "300\n")
  await writeFile(path.join(dir, "cpu.max"), "150000 100000\n")
  assert.equal(await scopeLimitsProblem(dir, limits), null)

  await writeFile(path.join(dir, "memory.max"), "max\n")
  await rm(path.join(dir, "pids.max"))
  const problem = await scopeLimitsProblem(dir, limits)
  assert.match(problem ?? "", /memory\.max is "max", expected "536870912"/)
  assert.match(problem ?? "", /pids\.max unreadable/)
})

test("memory limit is enforced under gVisor", { skip: !AVAILABLE }, async () => {
  // gVisor's tmpfs lives in sandbox memory, so filling /tmp past memoryMb must kill the job
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    limits: { memoryMb: 128, tmpfsMb: 2048, timeoutMs: 60_000 },
    command: ["sh", "-c", "dd if=/dev/zero of=/tmp/fill bs=1M count=1024 2>/dev/null; echo SURVIVED"]
  })
  // Killed by the kernel's OOM killer, not aborted by the runner for a cap it could not apply
  assert.equal(result.status, "failed")
  assert.equal(result.abortedReason, undefined)
  assert.doesNotMatch(result.stdout, /SURVIVED/)
}, { timeout: 90_000 })

test("memory within the limit is unaffected", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    limits: { memoryMb: 512, tmpfsMb: 1024, timeoutMs: 60_000 },
    // Holds the memory long enough for the peak sampler to see it
    command: ["sh", "-c", "dd if=/dev/zero of=/tmp/fill bs=1M count=200 2>/dev/null; sleep 0.5; echo SURVIVED"]
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /SURVIVED/)
  assert.match(result.cgroup ?? "", /\/podman-\d+\.scope$/)
  assert.ok((result.memoryPeakBytes ?? 0) > 100 * 1024 * 1024, `peak ${result.memoryPeakBytes}`)
  assert.ok((result.memoryPeakBytes ?? Infinity) <= (512 + 256) * 1024 * 1024, `peak ${result.memoryPeakBytes}`)
}, { timeout: 90_000 })

test("process limit is enforced under gVisor", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: ALPINE,
    payload: null,
    limits: { pidsMax: 32, timeoutMs: 60_000 },
    command: ["sh", "-c", "n=0; while [ $n -lt 600 ]; do sleep 20 & n=$((n+1)); done; wait; echo SURVIVED"]
  })
  assert.equal(result.status, "failed")
  assert.equal(result.abortedReason, undefined)
  assert.doesNotMatch(result.stdout, /SURVIVED/)
}, { timeout: 90_000 })
