/**
 * In-server dashboard build: esbuild bundle + TypeScript typecheck + Tailwind.
 * Compile and typecheck parse the source but never execute it; execution of
 * generated code happens only in the sandboxed browser iframe.
 */

import { build } from "esbuild"
import ts from "typescript"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createRequire } from "node:module"

const execFileP = promisify(execFile)
const require = createRequire(import.meta.url)

/** Imports dashboard source may use; everything else fails the build. */
const ALLOWED_IMPORTS = new Set(["react", "react/jsx-runtime", "@kit/ui"])

/**
 * The kit version this server builds against, recorded on each saved version
 * as provenance. It is not a pin: the loader uses the current kit either way.
 */
export { KIT_VERSION } from "@data-integrator/kit/version"

/** Result of a dashboard build. */
export interface DashboardBuildResult {
  /** True when the bundle compiled and typechecked. */
  ok: boolean
  /** Compiled ESM (mount wrapper included); present when ok. */
  bundleJs?: string
  /** Tailwind output for the source; present when ok. */
  bundleCss?: string
  /** Compile/typecheck errors, one message per line, for the agent or UI. */
  errors: string[]
}

/** Entry wrapper: imports the dashboard source and mounts it. */
const ENTRY = `import Dashboard from "di:source"
import { mountDashboard } from "@kit/ui"
mountDashboard(Dashboard)
`

function kitTypesPath(): string {
  return path.join(path.dirname(require.resolve("@data-integrator/kit")), "index.d.ts")
}

function reactTypesDir(): string {
  return path.dirname(require.resolve("@types/react/package.json"))
}

// LanguageService over two virtual files, reused across builds for speed
let service: ts.LanguageService | null = null
let currentSource = ""
let sourceVersion = 0

const FILE_NAME = "/dashboard/dashboard.tsx"

function compilerOptions(): ts.CompilerOptions {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
    noEmit: true,
    skipLibCheck: true,
    paths: {
      "@kit/ui": [kitTypesPath()],
      react: [path.join(reactTypesDir(), "index.d.ts")],
      "react/jsx-runtime": [path.join(reactTypesDir(), "jsx-runtime.d.ts")]
    },
    baseUrl: "/"
  }
}

function getService(): ts.LanguageService {
  if (service) return service
  const options = compilerOptions()
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [FILE_NAME],
    getScriptVersion: (f) => (f === FILE_NAME ? String(sourceVersion) : "1"),
    getScriptSnapshot: (f) => {
      if (f === FILE_NAME) return ts.ScriptSnapshot.fromString(currentSource)
      if (ts.sys.fileExists(f)) return ts.ScriptSnapshot.fromString(ts.sys.readFile(f)!)
      return undefined
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  }
  service = ts.createLanguageService(host, ts.createDocumentRegistry())
  return service
}

function typecheck(source: string): string[] {
  currentSource = source
  sourceVersion++
  const svc = getService()
  const diagnostics = [
    ...svc.getSyntacticDiagnostics(FILE_NAME),
    ...svc.getSemanticDiagnostics(FILE_NAME)
  ]
  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n")
    if (d.file && d.start != null) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
      return `dashboard.tsx(${line + 1},${character + 1}): ${message}`
    }
    return message
  })
}

async function bundle(source: string): Promise<{ js?: string; errors: string[] }> {
  try {
    const result = await build({
      stdin: { contents: ENTRY, resolveDir: "/", loader: "ts" },
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      external: [...ALLOWED_IMPORTS],
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "dashboard-source",
          setup(b) {
            b.onResolve({ filter: /^di:source$/ }, () => ({ path: "di:source", namespace: "di" }))
            b.onLoad({ filter: /.*/, namespace: "di" }, () => ({
              contents: source,
              loader: "tsx",
              resolveDir: "/"
            }))
            // Any import outside the allowlist is a build error, not a resolution attempt
            b.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === "entry-point" || ALLOWED_IMPORTS.has(args.path)) return undefined
              return {
                errors: [
                  { text: `import "${args.path}" is not allowed: dashboards may import only react and @kit/ui` }
                ]
              }
            })
          }
        }
      ]
    })
    // Belt and braces: esbuild auto-externalizes some specifiers (node:*)
    // before resolve plugins run, so verify the final import list too
    const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports)
    const disallowed = imports.filter((i) => i.external && !ALLOWED_IMPORTS.has(i.path))
    if (disallowed.length > 0) {
      return {
        errors: disallowed.map(
          (i) => `import "${i.path}" is not allowed: dashboards may import only react and @kit/ui`
        )
      }
    }
    return { js: result.outputFiles[0].text, errors: [] }
  } catch (err) {
    const messages =
      err && typeof err === "object" && "errors" in err
        ? (err as { errors: { text: string }[] }).errors.map((e) => e.text)
        : [String(err)]
    return { errors: messages }
  }
}

async function tailwind(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "di-dashboard-"))
  try {
    await writeFile(path.join(dir, "dashboard.tsx"), source)
    // Theme + utilities only: preflight ships once in kit.css. Absolute import
    // paths because the temp dir has no node_modules to resolve against.
    const tw = path.dirname(require.resolve("tailwindcss/package.json"))
    // Explicit @source: auto-detection cannot be trusted in a bare temp dir
    await writeFile(
      path.join(dir, "entry.css"),
      `@import "${tw}/theme.css" layer(theme);\n@import "${tw}/utilities.css" layer(utilities);\n@source "./dashboard.tsx";\n`
    )
    const cliDir = path.dirname(require.resolve("@tailwindcss/cli/package.json"))
    const binField = JSON.parse(await readFile(path.join(cliDir, "package.json"), "utf8")).bin
    const cli = path.join(cliDir, typeof binField === "string" ? binField : (Object.values(binField)[0] as string))
    await execFileP(process.execPath, [cli, "-i", "entry.css", "-o", "out.css", "--minify"], {
      cwd: dir
    })
    return await readFile(path.join(dir, "out.css"), "utf8")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Builds dashboard source into a bundle pair; returns errors instead of throwing. */
export async function buildDashboard(source: string): Promise<DashboardBuildResult> {
  const [typeErrors, bundled] = await Promise.all([
    Promise.resolve().then(() => typecheck(source)),
    bundle(source)
  ])
  const errors = [...bundled.errors, ...typeErrors]
  if (errors.length > 0) return { ok: false, errors }
  const bundleCss = await tailwind(source)
  return { ok: true, bundleJs: bundled.js, bundleCss, errors: [] }
}
