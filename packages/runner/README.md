# @mwater/integration-runner

Payload-opaque job executor over rootless podman + gVisor. Owns sandboxing, resource
limits, mounts (`/in` read-only, `/work`, `/out`, extra read-only host paths), and the
egress policy (public internet allowed; private, link-local, CGNAT and any
deployment-listed addresses denied via nftables in the rootless infra netns). Knows
nothing about integrations, queues, or destinations.

The package also carries the job contract types (`JobPayload`, `RunResult`,
`RasterArtifact`, `TableArtifact`, `CatalogSnapshot`) and the tags of the runtime
images it was released with, so an application depends on one version and gets the
runner, the contract and the images that implement it together.

```ts
import { Runner, RUNTIME_IMAGES, parseJobOutput } from "@mwater/integration-runner"

const runner = new Runner({
  blockedAddresses: ["203.0.113.7", "10.20.0.0/16"] // this deployment's own hosts
})
await runner.ensureReady() // verifies podman+runsc, creates job network, applies egress rules

const result = await runner.run(
  {
    image: RUNTIME_IMAGES.python,
    payload: { definition, secrets, previousState, params, catalog },
    mounts: { inDir, workDir, outDir, tmpDir, readOnly: [{ hostPath: "/mnt/rasters", containerPath: "/mnt/rasters" }] },
    limits: { cpus: 2, memoryMb: 2048, timeoutMs: 900_000, workDiskMb: 20_000, tmpDiskMb: 20_000 },
    labels: { "myapp.run": runId }
  },
  { onStderrLine: line => log(line), onStart: handle => keep(handle) }
)
const output = parseJobOutput(result)
```

`cpus`, `memoryMb` and `pidsMax` are enforced by capping the transient systemd user
scope rootless podman runs each job in (`podman-<pid>.scope`), with swap disabled and
`scopeOverheadMb` (default 256) added to the memory ceiling for the podman client, conmon
and the gVisor sandbox. Jobs run with `--cgroups=split` so conmon and the sandbox stay
inside that scope: without it podman moves conmon to a scope of its own whenever
`INVOCATION_ID` is absent from the environment (any process not started by systemd), and
the cap would then hold nothing. Before the payload is written the runner confirms that
conmon is inside the capped scope, and a job whose limits cannot be applied is removed
without ever receiving its payload. gVisor runs with
`--runtime-flag=ignore-cgroups`, so podman's own `-m`, `--cpus` and `--pids-limit`
flags have no effect. The cap is applied before the payload is written to the job's
stdin, and the harness blocks on stdin, so job code never runs uncapped. After asking
systemd for the limits, the runner reads them back from the scope's cgroup files
(`memory.max`, `memory.swap.max`, `pids.max`, `cpu.max`), since systemd reports success
even where a controller is unavailable; when they are not in effect the job fails with
the values found instead of running. `resourceControl: "podman"` skips the
scope and relies on podman's flags, which only works without gVisor.

Before every networked job the runner restarts the keeper container (or rebuilds it) and
re-applies the egress rules, so a keeper that died while idle cannot leave the next job
on a fresh netns without drop rules.

Under the "public-only" policy every networked job is metered: an nftables verdict map in
the rootless netns routes the job container's address to a per-job counter, reported as
`JobResult.egressBytes` (both directions). With `limits.egressMb`, packets past the quota
are dropped and the job fails with the reason. `ensureReady()` removes meters whose job
container is gone.

Limits and metering are in place before the payload reaches the job's stdin. The runtime
harness reads stdin before running any job code; a custom `command` must do the same
(`cat > /dev/null; ...`) or it may start before it is capped and metered.

Multi-file jobs send `files` (paths relative to the code directory) and an `entry`
instead of `code`, so packages and relative imports work. Snippets can import the files.

`/work` is the integration's persistent cache. `/tmp` is per-job: with `mounts.tmpDir` it
is that host directory, which the caller creates empty and removes after the job, so large
intermediates (downloads, unpacked archives, GDAL temporaries) neither persist in `/work`
nor count against memory; without it `/tmp` is a `tmpfsMb` tmpfs (default 256 MB) held in
the job's memory. `workDiskMb` and `tmpDiskMb` are polled (every `diskMonitorMs`, default
30 s) and the job is aborted when `/work` or a disk-backed `/tmp` exceeds its quota. `labels` let a restarted application find containers its previous
process left running: `runner.killLabelled("myapp.run")` removes them all, since a job
whose owner is gone has no one to commit its result and would only race the job that
replaces it.

## Images

`RUNTIME_IMAGES` names `ghcr.io/mwater/integration-runtime-node:<version>` and
`ghcr.io/mwater/integration-runtime-python:<version>`, where `<version>` equals this
package's version. The harness inside each image defines what `ctx` looks like and how
the result travels, so the three are released together by `scripts/release-runner.sh`
and never mixed across versions.

Requirements: rootless podman with a netavark bridge network (created by
`ensureReady()`), gVisor's `runsc` at `/usr/local/bin/runsc`, `nft` on the host, `du`
for the disk guard, and a systemd user manager for the job's user (`loginctl
enable-linger`, with `XDG_RUNTIME_DIR` set in the calling process's environment) for
resource limits.

## Host networking and limits

Rootless podman with gVisor shapes the setup in four ways:

- **Limits live on the systemd scope.** gVisor under rootless podman needs
  `--runtime-flag=ignore-cgroups`, so the container cgroup is never used and podman's
  `-m`, `--cpus` and `--pids-limit` are not enforced. The runner caps the
  `podman-<pid>.scope` podman runs in with `systemctl --user set-property` instead (see
  above).
- **Jobs run on a netavark bridge network** (`integrator-jobs` by default, created by
  `ensureReady()`), not the rootless default. With slirp4netns the tap lives inside the
  container's netns and gVisor's netstack transmits via AF_PACKET, so there is nowhere
  to filter. A bridge network gives podman a rootless infra netns whose forward hook sees
  all container traffic. A small keeper container holds that netns open between jobs.
- **Egress rules live in the rootless infra netns**, applied atomically from a file with
  `podman unshare --rootless-netns nft -f <file>` (quoted rules passed through `podman
  unshare` get their braces mangled). The forward chain accepts established/related
  traffic before the private-range drop; otherwise NAT-reversed replies (destination =
  the container's private address) are dropped and all egress dies:

  ```
  table inet integrator_egress {
    chain filter_forward {
      type filter hook forward priority 0; policy accept;
      ct state established,related accept
      ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, ... } drop
      ip6 daddr { fc00::/7, fe80::/10, ... } drop
    }
  }
  ```

  aardvark-dns on the bridge gateway still resolves: its upstream queries leave from the
  infra netns's output path, which the forward hook does not see.
- **Explicit DNS resolvers.** A host `resolv.conf` pointing only at systemd-resolved's
  `127.0.0.53` stub (the modern Ubuntu default) leaves aardvark-dns with no reachable
  upstream in the rootless netns, so every lookup fails while connections by IP work. The
  runner passes `--dns` resolvers to every networked job (`dns` option, default
  `1.1.1.1` and `9.9.9.9`).

Job containers also run with a read-only root filesystem, a writable `/tmp` (the
`mounts.tmpDir` directory, or without it a `limits.tmpfsMb` tmpfs), all capabilities
dropped and `no-new-privileges`.

Tests: `pnpm test`. The integration suite skips itself if podman/runsc are absent, skips
network tests under `SKIP_NET_TESTS=1`, and skips the GDAL test unless
`ghcr.io/osgeo/gdal:alpine-small-latest` is already pulled. The egress ruleset and the
version stamp are covered by plain unit tests.
