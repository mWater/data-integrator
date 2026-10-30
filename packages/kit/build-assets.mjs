/**
 * Builds the versioned kit runtime assets served at /kit/<version>/:
 *   react-core.js — react + react-dom/client + jsx-runtime bundled once
 *   react.js, jsx-runtime.js, react-dom-client.js — facades with static named
 *     exports over the single core (import-map targets)
 *   kit.js  — @kit/ui bundle (react external, resolved via the import map)
 *   kit.css — Tailwind output + MapLibre css
 *   maplibre-worker.cjs — MapLibre's tile worker as a classic-script bundle
 */

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const outdir = "assets"
mkdirSync(outdir, { recursive: true })

const common = {
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error"
}

await build({
  ...common,
  stdin: {
    contents: `
      import * as React from "react"
      import * as ReactDOMClient from "react-dom/client"
      import * as JSX from "react/jsx-runtime"
      export { React, ReactDOMClient, JSX }
    `,
    resolveDir: process.cwd(),
    loader: "js"
  },
  outfile: `${outdir}/react-core.js`
})

/** Writes a facade module re-exporting one core namespace with static names. */
async function writeFacade(outfile, coreName, specifier) {
  const mod = await import(specifier)
  const names = Object.keys(mod).filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n))
  const lines = [
    `import { ${coreName} as m } from "./react-core.js";`,
    ...names.map((n) => `export const ${n} = m.${n};`)
  ]
  if ("default" in mod) lines.push("export default m.default ?? m;")
  writeFileSync(`${outdir}/${outfile}`, lines.join("\n") + "\n")
}

await writeFacade("react.js", "React", "react")
await writeFacade("jsx-runtime.js", "JSX", "react/jsx-runtime")
await writeFacade("react-dom-client.js", "ReactDOMClient", "react-dom/client")

await build({
  ...common,
  entryPoints: ["src/index.ts"],
  outfile: `${outdir}/kit.js`,
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
  jsx: "automatic"
})

// MapLibre's tile worker, bundled as a single CLASSIC script. The sandboxed
// frame's opaque origin blocks module workers outright, so the kit points
// MapLibre at this file; the .cjs suffix selects MapLibre's classic-worker path
const maplibreDist = path.dirname(require.resolve("maplibre-gl/dist/maplibre-gl.css"))
await build({
  ...common,
  format: "iife",
  entryPoints: [path.join(maplibreDist, "maplibre-gl-worker.mjs")],
  outfile: `${outdir}/maplibre-worker.cjs`
})

// Tailwind over the kit sources, then MapLibre's stylesheet, then our overrides
// of it: popup.css only wins if it lands after the stylesheet it corrects
execFileSync("npx", ["@tailwindcss/cli", "-i", "src/css/kit.css", "-o", `${outdir}/kit.tw.css`, "--minify"], {
  stdio: "inherit"
})
const tw = readFileSync(`${outdir}/kit.tw.css`, "utf8")
const maplibre = readFileSync(require.resolve("maplibre-gl/dist/maplibre-gl.css"), "utf8")
const popup = readFileSync("src/css/popup.css", "utf8")
writeFileSync(`${outdir}/kit.css`, tw + "\n" + maplibre + "\n" + popup)
unlinkSync(`${outdir}/kit.tw.css`)

console.log("kit assets built into assets/")
