/**
 * nftables ruleset applied inside podman's rootless infra netns. See packages/runner/README.md:
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

/** Table metering each networked job's traffic, separate from the drop rules so re-applying those never resets a meter. */
export const METER_TABLE = "integrator_meter"

/**
 * Base of the meter table: a verdict map from job container address to the
 * job's chain, consulted for both directions of forwarded traffic. Created
 * once per netns; job chains are added and removed around each job.
 */
export function buildMeterTable(): string {
  return `table inet ${METER_TABLE} {
  map jobs4 { type ipv4_addr : verdict; }
  chain filter_forward {
    type filter hook forward priority 10; policy accept;
    ip saddr vmap @jobs4
    ip daddr vmap @jobs4
  }
}
`
}

/**
 * Attaches a job's meter: a counter, an optional over-quota drop, and the map
 * element routing the job's address to them. An element left for the same
 * address by a finished job whose detach has not run yet is replaced.
 */
export function buildMeterAttach(id: string, address: string, quotaMb: number | undefined, replace: boolean): string {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`Invalid meter id: ${id}`)
  if (!V4.test(address) || address.includes("/")) throw new Error(`Job address is not an IPv4 address: ${address}`)
  const lines = [
    `add counter inet ${METER_TABLE} c_${id}`,
    `add chain inet ${METER_TABLE} j_${id}`
  ]
  if (quotaMb !== undefined) {
    lines.push(`add quota inet ${METER_TABLE} q_${id} { over ${Math.max(1, Math.floor(quotaMb))} mbytes }`)
    lines.push(`add rule inet ${METER_TABLE} j_${id} counter name "c_${id}" quota name "q_${id}" drop`)
  } else {
    lines.push(`add rule inet ${METER_TABLE} j_${id} counter name "c_${id}"`)
  }
  if (replace) lines.push(`delete element inet ${METER_TABLE} jobs4 { ${address} }`)
  lines.push(`add element inet ${METER_TABLE} jobs4 { ${address} : jump j_${id} }`)
  return lines.join("\n") + "\n"
}

/** Detaches a job's meter; the map element is removed only while it still routes to this job. */
export function buildMeterDetach(id: string, address: string, ownsElement: boolean, hasQuota: boolean): string {
  const lines: string[] = []
  if (ownsElement) lines.push(`delete element inet ${METER_TABLE} jobs4 { ${address} }`)
  lines.push(`flush chain inet ${METER_TABLE} j_${id}`, `delete chain inet ${METER_TABLE} j_${id}`)
  lines.push(`delete counter inet ${METER_TABLE} c_${id}`)
  if (hasQuota) lines.push(`delete quota inet ${METER_TABLE} q_${id}`)
  return lines.join("\n") + "\n"
}
