#!/usr/bin/env node
/**
 * Runtime harness: maps the job payload onto the integration entrypoint.
 *
 * stdin:  JSON { mode?, definition?, code?, files?, entry?, secrets?, previousState?, webhookData?, params?, catalog? }
 * stdout: run mode: JSON-serialized return value of the default-export run(ctx).
 *         Reserved for the result; console and child-process output are
 *         redirected to stderr (fd-level).
 *         snippet mode: whatever the code prints (returned raw to the agent).
 * stderr: logs and stack traces.
 * exit:   0 success, 1 failure.
 */
import { readFileSync, writeFileSync, symlinkSync, existsSync, openSync, closeSync, writeSync, mkdirSync } from "node:fs"
import path from "node:path"

/** Directory the job's source is written to; curated libraries resolve from /tmp/node_modules above it */
const CODE_DIR = "/tmp/code"
/** Module written for single-string code and for snippets */
const CODE_FILE = "_integration.mjs"

/** Rejects file paths that could escape the code directory or are not plain relative paths */
function checkPath(file) {
  const parts = file.split("/")
  if (file.length === 0 || file.startsWith("/") || file.includes("\\") || parts.some(p => p === "" || p === "." || p === "..")) {
    throw new Error(`harness: invalid file path ${JSON.stringify(file)}`)
  }
}

/** Writes the job's files under CODE_DIR, defaulting the package to ES modules */
function writeFiles(files) {
  mkdirSync(CODE_DIR, { recursive: true })
  if (!("package.json" in files)) writeFileSync(path.join(CODE_DIR, "package.json"), `{"type":"module"}`)
  for (const [file, source] of Object.entries(files)) {
    checkPath(file)
    const target = path.join(CODE_DIR, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
}

function buildCtx(payload) {
  return {
    definition: payload.definition ?? {},
    secrets: payload.secrets ?? {},
    previousState: payload.previousState ?? null,
    webhookData: payload.webhookData ?? null,
    params: payload.params ?? {},
    catalog: payload.catalog ?? {},
    inDir: "/in",
    workDir: "/work",
    outDir: "/out",
    tmpDir: "/tmp"
  }
}

async function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"))
  const files = payload.files ?? {}
  const code = payload.code ?? payload.definition?.code
  const snippet = payload.mode === "snippet"
  if (snippet ? !code : !code && !payload.entry) {
    console.error("harness: no code in payload")
    return 1
  }
  if (payload.entry !== undefined && !snippet && !(payload.entry in files)) {
    console.error(`harness: entry ${JSON.stringify(payload.entry)} is not in files`)
    return 1
  }

  // Curated libraries live in the read-only image; make them resolvable from /tmp
  if (!existsSync("/tmp/node_modules")) {
    symlinkSync("/runtime/node_modules", "/tmp/node_modules")
  }
  writeFiles(files)
  // A multi-file job runs its entry; snippets and single-string code run as one module beside the files
  const entry = !snippet && payload.entry !== undefined ? payload.entry : CODE_FILE
  if (entry === CODE_FILE) writeFileSync(path.join(CODE_DIR, CODE_FILE), code)
  const modulePath = path.join(CODE_DIR, entry)
  const ctx = buildCtx(payload)

  if (snippet) {
    globalThis.ctx = ctx
    await import(modulePath)
    return 0
  }

  // run mode: stdout is the result channel. Re-point fd 1 at stderr at the
  // OS level so child processes (stdio: "inherit") physically cannot corrupt
  // the result; the reopened descriptor carries the result out. Console
  // output keeps going to stderr through the stream-level redirect.
  const resultFd = openSync("/proc/self/fd/1", "w")
  closeSync(1)
  const redirected = openSync("/proc/self/fd/2", "w")
  if (redirected !== 1) console.error(`harness: fd redirect landed on ${redirected}, not 1`)
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest)

  const module = await import(modulePath)
  if (typeof module.default !== "function") {
    console.error("harness: integration must default-export run(ctx)")
    return 1
  }
  const result = await module.default(ctx)

  // writeSync completes before process.exit can discard buffered pipe output
  writeSync(resultFd, JSON.stringify(result ?? {}))
  closeSync(resultFd)
  return 0
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err?.stack ?? String(err))
    process.exit(1)
  }
)
