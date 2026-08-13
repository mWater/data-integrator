/**
 * The kit's asset version. Dashboards load kit.js/kit.css from
 * /kit/<version>/..., which the server serves immutable for a year, so this
 * string is the cache key for those bytes.
 *
 * Bump it whenever the built assets change. There is only one kit on disk and
 * the server ignores the version segment when resolving a file, so this pins
 * nothing: every dashboard runs against the current kit whatever it was built
 * with. Both the server (stamping provenance on saved versions) and the UI
 * (building the frame URL) read this one constant, so a bump takes effect
 * everywhere at once.
 *
 * Because stored bundles resolve @kit/ui to the current kit and are never
 * rebuilt on a bump, the kit's exported names and prop contracts are
 * append-only for as long as that holds.
 *
 * Dependency-free on purpose: the server imports it without pulling in React.
 */
export const KIT_VERSION = "6"
