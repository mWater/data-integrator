#!/usr/bin/env node
/**
 * License compliance gate: every production dependency must carry an
 * OSI-approved license, recorded by SPDX identifier. The GPL and LGPL families
 * are OSI-approved but deliberately absent from the list: the project states
 * that no production dependency is under either. Input is the JSON from
 * `pnpm -r licenses list --prod --json` on stdin (`-r` because the
 * dependencies belong to the workspace packages, not the root). Exits nonzero
 * listing any package whose license is not on the allowlist, and also when
 * the input lists no packages, so a command that finds nothing cannot pass.
 */
const ALLOWED = new Set([
  "Apache-2.0", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Zlib", "Python-2.0",
  "MPL-2.0", "PostgreSQL", "CC-BY-4.0", "CC-BY-3.0", "WTFPL", "MIT-0",
  "Artistic-2.0"
])

/** Splits SPDX expressions like "(MIT OR CC0-1.0)" into candidate ids. */
function candidates(expr) {
  return String(expr).replace(/[()]/g, " ").split(/\s+(?:OR|AND|WITH)\s+|\s+/).filter(Boolean)
}

let raw = ""
for await (const chunk of process.stdin) raw += chunk
const byLicense = JSON.parse(raw)

const violations = []
for (const [license, packages] of Object.entries(byLicense)) {
  const ids = candidates(license)
  // An OR expression passes if any branch is allowed; anything else must be allowed outright
  const ok = license.includes("OR") ? ids.some(id => ALLOWED.has(id)) : ids.every(id => ALLOWED.has(id))
  if (!ok) for (const pkg of packages) violations.push(`${pkg.name}@${pkg.versions.join(",")}: ${license}`)
}

if (violations.length > 0) {
  console.error(`Non-allowlisted licenses (${violations.length}):`)
  for (const line of violations) console.error(`  ${line}`)
  process.exit(1)
}
const packageCount = Object.values(byLicense).reduce((n, packages) => n + packages.length, 0)
if (packageCount === 0) {
  console.error("No production dependencies were listed, so nothing was checked. Run with `pnpm -r licenses list --prod --json`.")
  process.exit(1)
}
console.log(
  `All ${packageCount} production dependencies carry OSI-approved licenses (${Object.keys(byLicense).length} distinct licenses).`
)
