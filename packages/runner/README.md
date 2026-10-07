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
    mounts: { inDir, workDir, outDir, readOnly: [{ hostPath: "/mnt/rasters", containerPath: "/mnt/rasters" }] },
    limits: { cpus: 2, memoryMb: 2048, timeoutMs: 900_000, workDiskMb: 20_000 },
    labels: { "myapp.run": runId }
  },
  { onStderrLine: line => log(line), onStart: handle => keep(handle) }
)
const output = parseJobOutput(result)
```

`cpus`, `memoryMb` and `pidsMax` are enforced by capping the transient systemd user
scope rootless podman runs each job in (`podman-<pid>.scope`, holding the podman client,
conmon and the gVisor sandbox), with swap disabled and `scopeOverheadMb` (default 256)
added to the memory ceiling for those processes. gVisor runs with
`--runtime-flag=ignore-cgroups`, so podman's own `-m`, `--cpus` and `--pids-limit`
flags have no effect. The cap is applied before the payload is written to the job's
stdin, and the harness blocks on stdin, so job code never runs uncapped; when the cap
cannot be applied the job fails instead of running. `resourceControl: "podman"` skips the
scope and relies on podman's flags, which only works without gVisor.

Before every networked job the runner restarts the keeper container (or rebuilds it) and
re-applies the egress rules, so a keeper that died while idle cannot leave the next job
on a fresh netns without drop rules.

Multi-file jobs send `files` (paths relative to the code directory) and an `entry`
instead of `code`, so packages and relative imports work. Snippets can import the files.

`workDiskMb` is polled (every `diskMonitorMs`, default 30 s) and the job is aborted when
`/work` exceeds it. `labels` let a restarted application find containers its previous
process left running: `runner.killLabelled("myapp.run")` removes them all, since a job
whose owner is gone can only ever commit twice.

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
resource limits. See `Spike Notes.md` in the repo root for why the network setup
is shaped this way.

Tests: `pnpm test`. The integration suite skips itself if podman/runsc are absent, skips
network tests under `SKIP_NET_TESTS=1`, and skips the GDAL test unless
`ghcr.io/osgeo/gdal:alpine-small-latest` is already pulled. The egress ruleset and the
version stamp are covered by plain unit tests.
