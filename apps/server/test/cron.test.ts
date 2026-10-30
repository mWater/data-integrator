import { test } from "node:test"
import assert from "node:assert/strict"
import { cronMatches, parseCron } from "../src/cron.js"

/** UTC date helper. */
function at(iso: string): Date {
  return new Date(iso)
}

test("parseCron: field forms — wildcard, value, list, range, step", () => {
  const spec = parseCron("*/15 6 1-3,15 */2 1-5")
  assert.deepEqual([...spec.minute], [0, 15, 30, 45])
  assert.deepEqual([...spec.hour], [6])
  assert.deepEqual([...spec.dayOfMonth], [1, 2, 3, 15])
  assert.deepEqual([...spec.month], [1, 3, 5, 7, 9, 11])
  assert.deepEqual([...spec.dayOfWeek], [1, 2, 3, 4, 5])
})

test("parseCron: 7 is Sunday like 0", () => {
  assert.ok(parseCron("0 0 * * 7").dayOfWeek.has(0))
})

test("parseCron: rejects malformed expressions", () => {
  assert.throws(() => parseCron("0 6 5 *"), /5 fields/)
  assert.throws(() => parseCron("60 * * * *"), /out of range/)
  assert.throws(() => parseCron("* * 0 * *"), /out of range/)
  assert.throws(() => parseCron("* * * * 8"), /out of range/)
  assert.throws(() => parseCron("a * * * *"), /Invalid cron minute/)
  assert.throws(() => parseCron("*/0 * * * *"), /Invalid cron step/)
  assert.throws(() => parseCron("5-2 * * * *"), /out of range/)
})

test("cronMatches: the library entries' cadences fire when expected", () => {
  const chirps = parseCron("0 6 5 * *")
  assert.ok(cronMatches(chirps, at("2026-08-05T06:00:00Z")))
  assert.ok(!cronMatches(chirps, at("2026-08-05T06:01:00Z")))
  assert.ok(!cronMatches(chirps, at("2026-08-06T06:00:00Z")))

  const monthly = parseCron("0 0 1 * *")
  assert.ok(cronMatches(monthly, at("2026-09-01T00:00:00Z")))
  assert.ok(!cronMatches(monthly, at("2026-09-02T00:00:00Z")))
})

test("cronMatches: vixie either-day rule when both day fields are restricted", () => {
  // 2026-08-10 is a Monday and not the 1st: dow matches, dom does not
  const both = parseCron("0 0 1 * 1")
  assert.ok(cronMatches(both, at("2026-08-10T00:00:00Z")), "day-of-week alone matches")
  assert.ok(cronMatches(both, at("2026-08-01T00:00:00Z")), "day-of-month alone matches (a Saturday)")
  assert.ok(!cronMatches(both, at("2026-08-11T00:00:00Z")), "neither matches (a Tuesday, the 11th)")

  // Only dom restricted: dow must be wildcard-true, dom must match
  const domOnly = parseCron("0 0 1 * *")
  assert.ok(!cronMatches(domOnly, at("2026-08-10T00:00:00Z")))
})
