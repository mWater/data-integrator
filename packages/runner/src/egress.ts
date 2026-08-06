/**
 * nftables ruleset applied inside podman's rootless infra netns. See Spike Notes.md:
 * jobs must run on a bridge network (slirp default has no filterable hop, gVisor's
 * netstack transmits via AF_PACKET), rules hook forward, and established/related must
 * be accepted first or NAT-reversed replies are dropped and all egress dies.
 */
export const EGRESS_TABLE = "integrator_egress"

/** Private, link-local, CGNAT (Tailscale), and metadata ranges. */
const BLOCKED_V4 = "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10"
const BLOCKED_V6 = "fc00::/7, fe80::/10"

/** Renders the complete nftables ruleset; declare-delete-recreate makes it idempotent. */
export function buildRuleset(): string {
  return `table inet ${EGRESS_TABLE}
delete table inet ${EGRESS_TABLE}
table inet ${EGRESS_TABLE} {
  chain filter_forward {
    type filter hook forward priority 0; policy accept;
    ct state established,related accept
    ip daddr { ${BLOCKED_V4} } drop
    ip6 daddr { ${BLOCKED_V6} } drop
  }
}
`
}
