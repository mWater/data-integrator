#!/usr/bin/env node
/**
 * Runtime harness: maps the job payload onto the integration entrypoint.
 *
 * stdin:  JSON { mode?, definition?, code?, secrets?, previousState?, webhookData?, params?, catalog? }
 * stdout: run mode: JSON-serialized return value of the default-export run(ctx).
 *         Reserved for the result; console and child-process output are
 *         redirected to stderr (fd-level).
 *         snippet mode: whatever the code prints (returned raw to the agent).
 * stderr: logs and stack traces.
 * exit:   0 success, 1 failure.
 */
import { readFileSync, writeFileSync, symlinkSync, existsSync, openSync, closeSync, writeSync } from "node:fs"

const CODE_PATH = "/tmp/_integration.mjs"

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
    outDir: "/out"
  }
}

async function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"))
  const code = payload.code ?? payload.definition?.code
  if (!code) {
    console.error("harness: no code in payload")
    return 1
  }

  // Curated libraries live in the read-only image; make them resolvable from /tmp
  if (!existsSync("/tmp/node_modules")) {
    symlinkSync("/runtime/node_modules", "/tmp/node_modules")
  }
  writeFileSync(CODE_PATH, code)
  const ctx = buildCtx(payload)

  if (payload.mode === "snippet") {
    globalThis.ctx = ctx
    await import(CODE_PATH)
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

  const module = await import(CODE_PATH)
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
