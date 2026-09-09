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

/** Shape of an address or CIDR accepted into the ruleset; anything else is rejected, not interpolated. */
const V4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/
const V6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/

/**
 * Renders the complete nftables ruleset; declare-delete-recreate makes it
 * idempotent. Extra addresses (a deployment's own public IPs, its private
 * network) join the default private-range drop set.
 */
export function buildRuleset(blockedAddresses: string[] = []): string {
  const v4 = [BLOCKED_V4]
  const v6 = [BLOCKED_V6]
  for (const address of blockedAddresses) {
    if (V4.test(address)) v4.push(address)
    else if (V6.test(address) && address.includes(":")) v6.push(address)
    else throw new Error(`Blocked address is not an IPv4/IPv6 address or CIDR: ${address}`)
  }
  return `table inet ${EGRESS_TABLE}
delete table inet ${EGRESS_TABLE}
table inet ${EGRESS_TABLE} {
  chain filter_forward {
    type filter hook forward priority 0; policy accept;
    ct state established,related accept
    ip daddr { ${v4.join(", ")} } drop
    ip6 daddr { ${v6.join(", ")} } drop
  }
}
`
}
