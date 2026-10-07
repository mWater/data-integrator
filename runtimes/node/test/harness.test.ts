import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Runner, parseJobOutput } from "@mwater/integration-runner"

const execFileP = promisify(execFile)
/** Image under test; the release script points this at the versioned build. */
const IMAGE = process.env.RUNTIME_IMAGE_NODE ?? "localhost/integrator-runtime-node:dev"

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
  console.error(`Skipping: build the image first (pnpm build:image in runtimes/node)`)
}

const runner = new Runner({ network: "integrator-jobs-nodetest", egress: "open" })

before(async () => {
  if (!AVAILABLE) return
  await runner.ensureReady()
}, { timeout: 60_000 })

after(async () => {
  if (!AVAILABLE) return
  await runner.teardown()
})

const RUN_CODE = `
import { parse } from "csv-parse/sync"
import { writeFile } from "node:fs/promises"

export default async function run(ctx) {
  console.log("log line from integration") // must land on stderr, not stdout
  const rows = parse(ctx.params.csv, { columns: true })
  await writeFile(\`\${ctx.outDir}/report.txt\`, \`rows=\${rows.length}\`)
  return {
    data: { sites: rows },
    state: { cursor: (ctx.previousState?.cursor ?? 0) + 1, catalog: ctx.catalog }
  }
}
`

/** What the server tells the job it has already published, per raster destination. */
const CATALOG = { rain: { snapshots: [{ timestamp: "2026-01-01T00:00:00Z", sources: 1 }] } }

test("run mode: entrypoint, curated lib import, mounts, print-redirect", { skip: !AVAILABLE }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "nodejob-out-"))
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      definition: { code: RUN_CODE },
      previousState: { cursor: 7 },
      params: { csv: "name,type\nWell A,borehole\nWell B,spring" },
      catalog: CATALOG
    },
    mounts: { outDir }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  const output = parseJobOutput<{ data: { sites: unknown[] }; state: { cursor: number; catalog: unknown } }>(result)
  assert.equal(output.data.sites.length, 2)
  assert.equal(output.state.cursor, 8)
  assert.deepEqual(output.state.catalog, CATALOG)
  assert.equal(await readFile(path.join(outDir, "report.txt"), "utf8"), "rows=2")
  assert.match(result.stderrTail, /log line from integration/)
  assert.doesNotMatch(result.stdout, /log line/)
}, { timeout: 120_000 })

test("run mode: child stdio inherit cannot corrupt the result channel", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      definition: {
        code: `import { spawnSync } from "node:child_process"
export default async function run() {
  spawnSync("sh", ["-c", "echo CONTAMINANT"], { stdio: "inherit" })
  return { state: { ok: true } }
}
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
      code: `import { XMLParser } from "fast-xml-parser"\nconsole.log("libs ok", ctx.params.msg)`,
      params: { msg: "hello" }
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /libs ok hello/)
}, { timeout: 120_000 })

test("large results survive process exit (pipe buffer flush)", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      definition: {
        code: `export default async function run() {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ site: "01646500", time: new Date(i * 60000).toISOString(), value: i }))
  return { data: { readings: rows } }
}`
      }
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  const output = parseJobOutput<{ data: { readings: unknown[] } }>(result)
  assert.equal(output.data.readings.length, 5000)
}, { timeout: 120_000 })

test("exception produces failed status with stack", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: { definition: { code: `export default async function run() { throw new Error("nope") }` } }
  })
  assert.equal(result.status, "failed")
  assert.match(result.stderrTail, /Error: nope/)
}, { timeout: 120_000 })

test("multi-file job: entry imports sibling modules and curated libraries", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      files: {
        "jobs/main.js": `import { double } from "../lib/math.js"
import { format } from "date-fns"
export default async function run(ctx) {
  return { state: { value: double(ctx.params.n), year: format(new Date(0), "yyyy") } }
}`,
        "lib/math.js": `export const double = n => n * 2`
      },
      entry: "jobs/main.js",
      params: { n: 21 }
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.deepEqual(parseJobOutput<{ state: unknown }>(result).state, { value: 42, year: "1970" })
}, { timeout: 120_000 })

test("multi-file job: snippets can import the files", { skip: !AVAILABLE }, async () => {
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      mode: "snippet",
      files: { "lib/math.js": `export const double = n => n * 2` },
      code: `import { double } from "./lib/math.js"\nconsole.log("doubled", double(4))`
    }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  assert.match(result.stdout, /doubled 8/)
}, { timeout: 120_000 })

test("multi-file job: paths escaping the code directory are rejected", { skip: !AVAILABLE }, async () => {
  for (const bad of ["../escape.js", "/tmp/abs.js", "a/./b.js"]) {
    const result = await runner.run({
      image: IMAGE,
      network: false,
      payload: { files: { [bad]: "export default async function run() { return {} }" }, entry: bad }
    })
    assert.equal(result.status, "failed", bad)
    assert.match(result.stderrTail, /invalid file path/, bad)
  }
}, { timeout: 120_000 })
