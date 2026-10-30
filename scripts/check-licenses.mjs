#!/usr/bin/env node
/**
 * License compliance gate: every production dependency must carry an
 * OSI-approved license, recorded by SPDX identifier. Input is the JSON from
 * `pnpm licenses list --prod --json` on stdin. Exits nonzero listing any
 * package whose license is not on the allowlist.
 */
const ALLOWED = new Set([
  "Apache-2.0", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Zlib", "Python-2.0",
  "MPL-2.0", "PostgreSQL", "CC-BY-4.0", "CC-BY-3.0", "WTFPL", "MIT-0",
  "Artistic-2.0", "LGPL-3.0", "LGPL-3.0-only", "LGPL-3.0-or-later", "LGPL-2.1", "LGPL-2.1-only", "LGPL-2.1-or-later"
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
console.log(`All production dependency licenses are OSI-approved (${Object.keys(byLicense).length} distinct licenses).`)
