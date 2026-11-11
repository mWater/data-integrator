# Designer model evaluation

Runs the standardized design prompts in [library/prompts/](../../../library/prompts/README.md)
against candidate models, end to end. It uses the real designer loop, the
sandbox and the cold-run gate, so a run counts as finished only if it would
have installed in a deployment. The harness only evaluates the designer.
Explore and the dashboard builder are out of scope.

## Running it

Prerequisites are the same as for development (see
[Quickstart](../../../docs/Quickstart.md)): podman, gVisor, the runtime images
built, and `pnpm install && pnpm -r build`. You don't need a database; the
harness starts its own. `OPENROUTER_API_KEY` is read from the repository's
`.env`.

The sandbox caps each job by moving rootless podman into a
`podman-<pid>.scope` of its own. Podman only does that when it starts in a
cgroup the user doesn't own. A deployment's systemd service is such a cgroup.
A desktop terminal or an editor's integrated terminal isn't, and there every
job is killed with `resource limits could not be applied: podman did not move
into podman-<pid>.scope`. Run the evaluation from a system-level scope instead:

```sh
sudo systemd-run --scope --quiet --uid=$(id -u) --gid=$(id -g) -- \
  env HOME=$HOME PATH=$PATH XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR \
  DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS bash
cat /proc/self/cgroup                          # expect 0::/system.slice/run-….scope
(cd packages/runner && pnpm test)              # the sandbox suite should pass here
```

If only the egress tests fail with `wget: bad address`, the sandbox works
but its DNS resolvers are unreachable from your network. Pass `--job-dns`
(below).

```sh
cd apps/server
pnpm eval:designer --model nvidia/nemotron-3.5-super-vl --prompts ghsl_built_up    # smoke test
pnpm eval:designer --model nvidia/nemotron-3.5-super-vl --model openai/gpt-6.1-sol \
  --prompts ghsl_built_up,copernicus_dem_glo30,hydrosheds,spi_gdo --repeats 3
```

Options:

| Option | Default | |
|---|---|---|
| `--model` | (required, repeatable) | OpenRouter model id of a candidate |
| `--prompts` | `all` | comma-separated prompt file names |
| `--repeats` | 1 | sessions per model and prompt; use 3 or more for a decision, results vary |
| `--effort` | as in production | reasoning effort for every candidate. Leave it unset: the server already runs the default model (`openai/gpt-6.1-sol`) at `medium` and other models at their own default, as a deployment would |
| `--country` | `MDG` | ISO3 code of the deployment's area of interest |
| `--secrets` | none | JSON `{"secret_name": "value"}` for prompts that need credentials (`glofas_discharge`: `cds_api_token`; `fpar`: `cdse_s3_credentials`). Keep it at `eval/secrets.json`, which is gitignored. Without it those prompts end `blocked_secret` |
| `--operator-model`, `--judge-model` | `anthropic/claude-sonnet-5.5` | fixed across candidates |
| `--no-judge` | | skip the acceptance-check judge |
| `--max-tokens` | 15M | per-session cap on candidate tokens (input + output) |
| `--max-minutes` | 120 | per-session wall clock, design phase |
| `--max-load-minutes` | 60 | wait for the first production load after finish |
| `--max-operator-turns` | 12 | operator replies before the session is abandoned |
| `--job-dns` | 1.1.1.1, 9.9.9.9 | DNS servers for sandbox jobs, comma-separated. Use this when the network blocks those resolvers over UDP: the runner tests then fail with `wget: bad address`, and `dig @1.1.1.1 example.com` times out on the host |
| `--fresh-first-load` | | let the first production load download everything again. By default it reuses the cold run's `/work` (see below) |
| `--keep-db`, `--keep-data` | | keep the session's database container or its raster/work/file stores for inspection |

Download volume depends on the area of interest and the source. Per full
download for Madagascar: GHSL about 5 MB, SPI about 1 MB a year, and
HydroSHEDS about 150 MB whatever the area, since it comes as continental
zips. Copernicus DEM is about 2.4 GB for Madagascar but about 220 MB for
Rwanda. Every session downloads at least twice, once for testing and once
for the cold run. On a slow link, use a small area (`--country RWA`) or run
the harness on a host with a fast connection. All candidates get the same
area, so the comparison stays fair.

Sessions run one at a time. Models alternate within each prompt, so provider
slowdowns and changes at the data sources hit every candidate alike.

## What each session does

1. Starts a fresh PostGIS container, applies the migrations, and sets the area
   of interest. It turns on English only, so finish doesn't spend candidate
   tokens on translation, and sets the session's token cap.
2. Gives the designer a library that holds only `skills/`. The finished
   entries in `library/integrations/` would hand it the answer through
   `search_library`. The skills stay, because they are part of what a
   deployment ships, so the evaluation measures model plus skills.
3. Sends the prompt verbatim. When the designer pauses, a simulated operator
   answers. It sees the prompt and the prompt file's Scope notes, approves
   plans, picks options and clarifies intent, but never gives technical help.
   Credential requests are filled from `--secrets` without asking the operator.
4. Just before finish, copies the cold run's `/work` to the installed
   integration's `/work`. The first production load then reads the cold
   run's downloads, as a warm run would, instead of fetching everything a
   third time. This only helps code that caches in `/work`, and it changes
   nothing the model is measured on.
5. On finish, waits for the first production load, records the layers and
   tables it produced, and asks the judge model to run the prompt file's
   acceptance checks using read-only SQL.

## Output

`eval/results/<timestamp>/` (or `--out`):

- `summary.md`: per-model totals and one row per session, rewritten after
  every session.
- `results.jsonl`: the full record per session.
- `<model>__<prompt>__r<n>/`:
  - `transcript.md`: a readable transcript.
  - `events.log`: a live log, including sandbox output.
  - `session.json`: the raw messages and state.
  - `definition.json` and `code.py`: the installed definition and code.
  - `result.json`: the session's record.

Outcomes:

- `finished`: passed the cold run and installed.
- `step_limit`: hit the designer's 200-call cap.
- `token_cap`, `time_limit`, `operator_limit`: hit the harness caps.
- `blocked_secret`: requested a credential `--secrets` doesn't supply.
- `crashed`: a provider or model error, shown in `error`.

## Reading the results

- Finishing is the bar the platform enforces. The first production load and
  the judge show whether what was installed is right.
- The judge is an LLM and gives LLM verdicts. Read the evidence it cites, and
  spot-check the transcripts before drawing conclusions.
- "Plan confirmed" records whether the operator got to reply before the
  first `edit_code` or `run_integration`. The system prompt requires a
  confirmed plan before any building, even for a fully specified request,
  because that is the operator's chance to catch a wrong product or scope.
  `no` is an instruction-following failure even when the session finishes.
- Steers count the operator's replies. A model that needs many is harder to
  use, even when it finishes.
- `toolErrors` counts rejected or malformed tool calls. A high count
  alongside few failed runs points to the model's tool calling rather than to
  the integration code it writes.
- Cost uses OpenRouter list prices and ignores prompt-cache discounts, so it
  is an upper bound.
- Sources change. When every model fails the same prompt, check the source
  before blaming the models.
