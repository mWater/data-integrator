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

## v1 on the v2 harness

No compat wrapper ships in the image. mWater wraps a v1 body into a v2 module before
submitting it: the csvParser source inlined, then `export default async function
run(ctx)` binding `secrets`, `previousState` and `webhookData` from `ctx` around the
original code. Top-level `return` works inside the function; `fetch`, `btoa`, `atob`,
`setTimeout` and `console` are native in Node 22; the harness exits as soon as `run()`
resolves, so un-awaited timers never fire; the v1 result `{ data, state }` is a subset
of `RunResult`. The wrapper is one function in mWater and the runner, image and
harness are used exactly as released.

## Process

1. `import_integrations` design gains a contract version field; all existing rows are
   v1.
2. Verify, not assume: run the production integration corpus through the wrapper and
   diff outputs against isolated-vm before cutover; scan for top-level declarations
   that would collide with the wrapper's bindings.
3. mwater-server swaps `executeScript()` for the runner client; destination adapter
   for custom tablesets written in the monorepo.
4. v1 is frozen: runs indefinitely through the wrapper, never authored anew. The agent
   upgrades v1 to v2 opportunistically when an integration is opened for editing. No
   flag day.
5. Delete isolated-vm (and its native-build/node-pinning constraints).
