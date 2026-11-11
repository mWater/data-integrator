# Handoff: designer model evaluation (Nemotron 3.5 Super VL)

For Claude Code on Clayton's home machine, resuming work started on
2026-11-11. Branch: `designer-model-eval`. Delete this file before merging.

## Goal

Decide whether `nvidia/nemotron-3.5-super-vl` can replace the hosted model as
the integration designer, for project members who want open models. Only
integrations matter. Explore and the dashboard builder are out of scope, since
dashboards were built as a favour. The baseline is the production default,
`openai/gpt-6.1-sol` at medium effort.

There are two questions, and the team has to decide what "open" means for
the second:

1. **Can it build integrations?** The harness in this directory answers this.
   Read [README.md](README.md) first; it is the reference for options, output
   and how to read results.
2. **Is it open source, or only open-weight?** Researched already, not yet
   written up for the team:
   - The weights are under OpenMDW-1.1 (Linux Foundation / PyTorch
     Foundation). It is permissive with no field-of-use limits, and it covers
     model, data and code. It is not on OSI's approved-licence list.
   - Much of the pretraining data is published (Nemotron-CC and others), and
     most post-training sets are published under OpenMDW. The model card also
     lists private third-party and private NVIDIA datasets, plus synthetic
     data from other models. Secondary sources say some of those models are
     proprietary (GPT-5.5, Gemini 3 Flash); NVIDIA's training-content summary
     PDF linked from the HF card would confirm it.
   - Release of the training code was not confirmed.
   - So it fails OSAID 1.0 if read strictly ("OSI-approved terms"). It roughly
     meets OSAID's data-information requirement. It fails the "all training
     data downloadable" bar. The team must pick its bar. OLMo (AllenAI) is the
     usual comparison if they want everything downloadable.

## Setup on a new machine

1. Install the Quickstart prerequisites (`docs/Quickstart.md`): Node 22+,
   pnpm, rootless podman, nftables, gVisor `runsc` at `/usr/local/bin/runsc`,
   and gdal-bin. Then build:
   ```sh
   pnpm install && pnpm -r build
   podman build -t localhost/integrator-runtime-python:dev runtimes/python/
   podman build -t localhost/integrator-runtime-node:dev runtimes/node/
   podman pull docker.io/postgis/postgis:16-3.4
   ```
   You don't need a database or migrations: the harness starts a throwaway
   PostGIS container per session and migrates it.
2. Put `OPENROUTER_API_KEY=...` in the repository-root `.env`.
3. **Run from a system-level cgroup.** The sandbox requires podman to move
   into its own `podman-<pid>.scope`. From VS Code or a desktop terminal it
   doesn't, and every job is killed after ~10 s with "resource limits could
   not be applied: podman did not move into podman-<pid>.scope". The fix needs
   sudo, so Clayton runs it, not Claude:
   ```sh
   tmux new -s eval
   sudo systemd-run --scope --quiet --uid=$(id -u) --gid=$(id -g) -- \
     env HOME=$HOME PATH=$PATH XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR \
     DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS bash
   cat /proc/self/cgroup                  # expect 0::/system.slice/run-….scope
   (cd packages/runner && pnpm test)
   ```
   Claude's own shell is in the user-owned cgroup, so runs started from Claude
   fail this way. Have Clayton launch the runs, and monitor them from the
   result files.
4. **DNS.** Jobs use 1.1.1.1 and 9.9.9.9. The office network blocked UDP DNS
   to both: the runner egress tests failed with `wget: bad address`, and
   `dig @1.1.1.1 example.com` timed out. If that happens, pass
   `--job-dns 8.8.8.8,8.8.4.4`. Check with
   `dig +short @1.1.1.1 example.com`. If it answers, the flag isn't needed.

## Results so far

Results directories are gitignored and stayed on the office machine. Key rows:

| Run | Model | Prompt | Outcome | Judge | Plan confirmed | Steps | $ | Min |
|---|---|---|---|---|---|---|---|---|
| smoke, MDG | Nemotron | ghsl_built_up | finished, load ok | 5/6 (fail) | no | 20 | 0.11 | 5.4 |
| stage1, MDG | Nemotron | ghsl_built_up | finished, load ok | 3/4 + 1 unverified | no | 34 | 0.26 | 6.3 |
| stage1-rwa | Nemotron | ghsl_built_up | finished, load ok | 4/4 pass | yes | 21 | 0.10 | 6.6 |
| stage1-rwa | GPT-6.1 | ghsl_built_up | finished, load ok | 4/4 pass | yes | 18 | 0.62 | 3.7 |

Observations so far, all on a single cheap prompt:

- **Smoke run CRS bug.** Nemotron hard-coded `"crs": "EPSG:4326"` for a
  raster it had warped to World Mollweide (ESRI:54009), so every tile was
  stored with the wrong georeferencing. The judge caught it. The library
  entry reads the CRS from the output file instead. **Platform gap:** the
  executor accepted a declared CRS that doesn't match the COG. Validating it
  at snapshot time would catch this for any model.
- **Plan confirmation.** Nemotron skipped it twice: once it went straight to
  building, and once it called `edit_code` before asking. The system prompt
  requires confirmation before any building. It confirmed correctly in the
  Rwanda run. The "Plan confirmed" column tracks this.
- **Feedback loops.** In one session Nemotron needed 8 `write_definition`
  attempts to act on "contract must be 2"; in another it fixed the same error
  in one try. Elsewhere it diagnosed run failures well (CRS names, URL
  layout, cutline units).
- **Cost.** Nemotron ran $0.10–0.26 a session against $0.62 for GPT-6.1 on
  the same prompt. GPT-6.1 used far fewer output tokens (5k vs 38k).
- **The office network is too slow.** Nemotron's `copernicus_dem_glo30` run
  (Rwanda) was hitting tile download timeouts when this was written. Treat it
  as void, and rerun it at home.

## Next steps

1. Check the sandbox at home (setup step 3), then run a smoke test:
   `pnpm run eval:designer --model nvidia/nemotron-3.5-super-vl --prompts ghsl_built_up --out eval/results/smoke`
   (from `apps/server`, inside the system-scope shell).
2. Stage 1: four core prompts, both models, one repeat. Use `--country MDG`,
   the real deployment area, if the home connection is fast. Copernicus DEM is
   about 2.4 GB per download pass for Madagascar and about 220 MB for Rwanda.
   ```sh
   pnpm run eval:designer \
     --model nvidia/nemotron-3.5-super-vl --model openai/gpt-6.1-sol \
     --prompts ghsl_built_up,copernicus_dem_glo30,hydrosheds,spi_gdo \
     --out eval/results/stage1
   ```
3. Stage 2: every prompt without credentials, `--repeats 3`; the list is in
   the README. That's 54 sessions, probably one to two days run one at a
   time.
4. Credential prompts: `glofas_discharge` needs an EWDS token, and `fpar`
   needs CDSE S3 keys as JSON `{access_key, secret_key, endpoint}`. Put them
   in `eval/secrets.json` (gitignored) and pass `--secrets eval/secrets.json`.
   Clayton hasn't obtained them yet.
5. Read the transcripts behind the judge verdicts before concluding; the
   judge is an LLM. Then write the result up for the team, covering both
   capability and licence. A shareable page or doc suits that audience, since
   some readers care most about the licence question.

## Changes made in this branch

- New: `apps/server/eval/`: `designerEval.ts` (runner), `operator.ts`
  (simulated operator), `judge.ts` (acceptance-check judge), `prompts.ts`,
  `README.md`, `tsconfig.json`, and this file.
- `apps/server/package.json`: the `eval:designer` and `typecheck:eval`
  scripts.
- `.gitignore`: `apps/server/eval/results/` and `apps/server/eval/secrets.json`.
- No production code changed. These changes were suggested but not made:
  a `JOB_DNS` server setting (the runner already takes a `dns` option), and
  CRS validation of snapshots.

Judge change made after the results above: checks are now numbered from the
prompt file's bullets, and the judge must return one verdict per check. Pass
counts from earlier runs (6 checks vs 4 for the same prompt) aren't
comparable with later ones.
