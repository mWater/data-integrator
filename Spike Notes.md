# Runner Spike Notes (2026-08-06)

Throwaway spike proving the runner stack on Ubuntu 24.04, rootless, x86_64.
podman 4.9.3, gVisor release-20260727.0, nftables 1.0.9. All four risks cleared.

## Findings

1. gVisor runs under rootless podman with `--runtime-flag=ignore-cgroups`. That flag
   means the container cgroup is never used, so podman's `-m`, `--cpus` and
   `--pids-limit` are not enforced (found 2026-10-07: a 128 MB job allocated 768 MB).
   runsc's own cgroup setup needs the system bus or root, and podman moves itself into
   a `podman-<pid>.scope` whatever the caller's cgroup, so the runner caps that scope
   with `systemctl --user set-property` before writing the payload.
   Verified actually sandboxed via `dmesg` / `/proc/version` (guard against silent
   fallback to crun).
2. GDAL works under gVisor: create -> COG translate (DEFLATE) -> warp to 3857, using
   ghcr.io/osgeo/gdal:alpine-small. No syscall issues.
3. Egress policy works, with two non-obvious requirements:
   - Jobs must run on a netavark bridge network (`podman network create jobnet`), NOT
     the rootless default. With slirp4netns default networking the tap lives inside the
     container netns and there is nowhere to filter (gVisor netstack transmits via
     AF_PACKET, bypassing that netns's netfilter hooks). A bridge network gives podman a
     rootless infra netns whose forward hook sees all container traffic.
   - Rules go in the rootless infra netns via `podman unshare --rootless-netns nft -f`,
     and MUST accept established/related before the RFC1918 drop, or NAT-reversed reply
     packets (daddr = container 10.89.x) are dropped and all egress dies:

     ```
     table inet egress {
       chain egressfilter {
         type filter hook forward priority 0; policy accept;
         ct state established,related accept
         ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
       }
     }
     ```

   Verified: host LAN blocked, 169.254.169.254 blocked, public HTTPS works, DNS works
   (aardvark-dns on the bridge gateway answers; its upstream queries originate in the
   infra netns output path, unaffected by the forward-hook drop).
4. Cold start is a non-issue: ~244ms avg start+exit under runsc (crun measured ~341ms).
   Snippet-tool blocking semantics are safe.

## Gotchas hit

- Host resolv.conf pointing only at systemd-resolved's 127.0.0.53 stub (modern
  Ubuntu default) leaves aardvark-dns with no reachable upstream in the rootless
  netns: every lookup returns NXDOMAIN. The runner therefore passes explicit
  `--dns` public resolvers to job containers (configurable). Symptom to
  remember: by-IP connections work, all DNS fails, no rules involved.

- `fwd` is a reserved nft keyword; do not name a chain that.
- DNS on the *default* slirp network fails under runsc (resolv.conf points at slirp's
  10.0.2.3). Bridge network + aardvark makes this moot.
- Pass nft rules via `nft -f file`, not quoted args through `podman unshare` (quoting
  mangles braces).

## Follow-ups for the real runner

- Add IPv6 to the drop set (fc00::/7, fe80::/10) in the same inet table.
- Apply the ruleset idempotently at every job launch (the infra netns is created lazily
  and torn down when the last bridged container exits).
- Optional hardening: scope the drop to the job network's bridge via iifname.
- Re-verify on podman 5.x (pasta default) on the target deploy OS; bridge networks
  still use the infra netns there but the uplink differs.
- Hostname allowlist (the optional production knob) still requires a proxy; nothing in
  this spike changes that.
