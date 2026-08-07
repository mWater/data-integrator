import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Runner, parseJobOutput } from "@data-integrator/runner"

const execFileP = promisify(execFile)
const IMAGE = "localhost/integrator-runtime-node:dev"

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
    state: { cursor: (ctx.previousState?.cursor ?? 0) + 1 }
  }
}
`

test("run mode: entrypoint, curated lib import, mounts, print-redirect", { skip: !AVAILABLE }, async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "nodejob-out-"))
  const result = await runner.run({
    image: IMAGE,
    network: false,
    payload: {
      definition: { code: RUN_CODE },
      previousState: { cursor: 7 },
      params: { csv: "name,type\nWell A,borehole\nWell B,spring" }
    },
    mounts: { outDir }
  })
  assert.equal(result.status, "succeeded", result.stderrTail)
  const output = parseJobOutput<{ data: { sites: unknown[] }; state: { cursor: number } }>(result)
  assert.equal(output.data.sites.length, 2)
  assert.equal(output.state.cursor, 8)
  assert.equal(await readFile(path.join(outDir, "report.txt"), "utf8"), "rows=2")
  assert.match(result.stderrTail, /log line from integration/)
  assert.doesNotMatch(result.stdout, /log line/)
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
