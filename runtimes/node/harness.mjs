#!/usr/bin/env node
/**
 * Runtime harness: maps the job payload onto the integration entrypoint.
 *
 * stdin:  JSON { mode?, definition?, code?, secrets?, previousState?, webhookData?, params? }
 * stdout: run mode: JSON-serialized return value of the default-export run(ctx).
 *         Reserved for the result; console output is redirected to stderr.
 *         snippet mode: whatever the code prints (returned raw to the agent).
 * stderr: logs and stack traces.
 * exit:   0 success, 1 failure.
 */
import { readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs"

const CODE_PATH = "/tmp/_integration.mjs"

function buildCtx(payload) {
  return {
    definition: payload.definition ?? {},
    secrets: payload.secrets ?? {},
    previousState: payload.previousState ?? null,
    webhookData: payload.webhookData ?? null,
    params: payload.params ?? {},
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

  // run mode: stdout is the result channel, so console output becomes stderr logs
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest)
  let result
  try {
    const module = await import(CODE_PATH)
    if (typeof module.default !== "function") {
      console.error("harness: integration must default-export run(ctx)")
      return 1
    }
    result = await module.default(ctx)
  } finally {
    process.stdout.write = realWrite
  }

  process.stdout.write(JSON.stringify(result ?? {}))
  return 0
}

main().then(
  code => process.exit(code),
  err => {
    console.error(err?.stack ?? String(err))
    process.exit(1)
  }
)
