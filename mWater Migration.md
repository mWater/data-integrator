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
submitting it: a compiled v1 shim, then `export default async function run(ctx)` that
installs the v1 globals (`secrets`, `previousState`, `webhookData`, `global`, `parseCSV`,
`btoa`/`atob`, v1-shaped `fetch`, `console`, `setTimeout`) on `globalThis` and compiles
the original code with the `AsyncFunction` constructor. Function-constructor bodies are
sloppy mode even inside a module, so undeclared assignments, top-level `return`,
reassigning `previousState` and shadowing a global with `let` all behave as in
isolated-vm. The v1 `fetch` returns a plain object with a cached body (`text()` and
`json()` repeatable). The harness exits as soon as `run()` resolves, so un-awaited timers
never fire. The runner, image and harness are used exactly as released. Details and the
known behaviour differences (redirects, JSON vs structured clone, no 2 MB cap, wall-clock
timeout) are in the monorepo's `docs/proposals/integrations-unification.md`.

## Process

1. `import_integrations` design gains a contract version field; all existing rows are
   v1.
2. Verify, not assume: run the production integration corpus through the wrapper and
   diff outputs and wall times against isolated-vm before cutover.
3. mwater-server's cron claim loop swaps `executeScript()` for the runner; destination
   adapter for custom tablesets written in the monorepo.
4. v1 is frozen: runs indefinitely through the wrapper, never authored anew. The agent
   upgrades v1 to v2 opportunistically when an integration is opened for editing. No
   flag day.
5. Delete isolated-vm (and its native-build/node-pinning constraints).
