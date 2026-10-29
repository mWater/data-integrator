# @data-integrator/definitions

TypeScript types for integration definitions, the machine-readable library
format specified in
[Integration Library Specification](../../docs/spec/Integration%20Library%20Specification.md).
A definition declares source, trigger, AOI, inputs, file slots, runtime,
limits, destinations, validation rules, and the single self-contained code
file. Secret values never appear in definitions.

Also exported:

- `InManifest` and related types: the `/in/manifest.json` a job reads.
- `SUPPORTED_LOCALES`: the locales the UI supports, in picker order.
- `localizeString(value, locale)`: resolves a localized string, falling back
  to its base locale.
- `toLocalizedString(text, base)`: wraps plain text as a localized string.
- The job contract types (`RunResult`, `RasterArtifact`, `TableArtifact`, ...),
  re-exported from `@mwater/integration-runner`.

This package holds types only. Structural validation of definitions lives in
the server (`apps/server/src/install.ts`, `validateDefinition`).
