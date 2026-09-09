import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRuleset, EGRESS_TABLE } from "../src/egress.js"

test("default ruleset drops private ranges and accepts established replies first", () => {
  const rules = buildRuleset()
  assert.match(rules, new RegExp(`delete table inet ${EGRESS_TABLE}`))
  assert.ok(rules.indexOf("ct state established,related accept") < rules.indexOf("ip daddr"))
  assert.match(rules, /10\.0\.0\.0\/8, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16/)
  assert.match(rules, /fc00::\/7, fe80::\/10/)
})

test("blocked addresses join the drop sets by family", () => {
  const rules = buildRuleset(["203.0.113.7", "198.51.100.0/24", "2001:db8::1", "2001:db8:1::/48"])
  assert.match(rules, /ip daddr \{ [^}]*203\.0\.113\.7, 198\.51\.100\.0\/24 \} drop/)
  assert.match(rules, /ip6 daddr \{ [^}]*2001:db8::1, 2001:db8:1::\/48 \} drop/)
})

test("anything that is not an address or CIDR is rejected, never interpolated", () => {
  assert.throws(() => buildRuleset(["evil.example"]), /not an IPv4\/IPv6 address/)
  assert.throws(() => buildRuleset(["10.0.0.1; drop"]), /not an IPv4\/IPv6 address/)
  assert.throws(() => buildRuleset([""]), /not an IPv4\/IPv6 address/)
})
