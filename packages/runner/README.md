# @data-integrator/runner

Payload-opaque job executor over rootless podman + gVisor. Owns sandboxing, resource
limits, mounts (`/in` read-only, `/work`, `/out`), and the egress policy (public
internet allowed, private/link-local/CGNAT denied via nftables in the rootless infra
netns). Knows nothing about integrations, queues, or destinations.

```ts
import { Runner, parseJobOutput } from "@data-integrator/runner"

const runner = new Runner()
await runner.ensureReady() // verifies podman+runsc, creates job network, applies egress rules

const result = await runner.run(
  {
    image: "ghcr.io/data-integrator/runtime-python:latest",
    payload: { definition, secrets, previousState, params },
    mounts: { inDir, workDir, outDir },
    limits: { cpus: 2, memoryMb: 2048, timeoutMs: 900_000 }
  },
  { onStderrLine: line => log(line) }
)
const output = parseJobOutput(result)
```

Requirements: rootless podman with a netavark bridge network (created by
`ensureReady()`), gVisor's `runsc` at `/usr/local/bin/runsc`, `nft` on the host.
See `Spike Notes.md` in the repo root for why the network setup is shaped this way.

Tests: `pnpm test`. The suite skips itself if podman/runsc are absent, skips network
tests under `SKIP_NET_TESTS=1`, and skips the GDAL test unless
`ghcr.io/osgeo/gdal:alpine-small-latest` is already pulled.

Follow-ups tracked: /work disk quota enforcement, warm-container pool, hostname
allowlist proxy (optional production knob).
