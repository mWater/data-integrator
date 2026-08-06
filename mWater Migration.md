# mWater Migration

Notes on moving the existing mWater integrator (isolated-vm) onto the runner and
runtime images defined in Architecture.md. mWater-internal; not part of the
open-source design.

## Contract versions

- v1 (legacy): the isolated-vm dialect. Code is the body of an async IIFE with a
  top-level `return`; magic globals (`secrets`, `previousState`, `webhookData`);
  emulated text-only `fetch` with a 2MB cap; bespoke `parseCSV`, `btoa`/`atob`, and a
  `setTimeout` whose callbacks fire only if awaited; no imports. Every restriction was
  a consequence of in-engine isolation.
- v2: the entrypoint contract in Architecture.md. All new authoring is v2.

## Compat wrapper

The `node22` image carries a v1 wrapper alongside the v2 harness:

- Wraps the code body in an async function and binds the v1 globals.
- `parseCSV` shim built from the same csvParser source, for identical behavior.
- Exits when the returned promise resolves, preserving the v1 semantics that
  un-awaited `setTimeout` callbacks never fire.
- Real fetch is a superset of legal v1 behavior; the caps and missing methods were
  limitations, not behaviors code could rely on. Binary bodies were impossible in v1,
  so no code depends on the text-mangling.

## Process

1. `import_integrations` design gains a contract version field; all existing rows are
   v1.
2. Verify, not assume: run the production integration corpus under the compat wrapper
   and diff outputs against isolated-vm before cutover.
3. mwater-server swaps `executeScript()` for the runner client; destination adapter
   for custom tablesets written in the monorepo.
4. v1 is frozen: runs indefinitely under compat, never authored anew. The agent
   upgrades v1 to v2 opportunistically when an integration is opened for editing. No
   flag day.
5. Delete isolated-vm (and its native-build/node-pinning constraints).
