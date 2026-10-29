# Deployment

A production install runs on one dedicated Ubuntu 24.04 host: the server as a
systemd service, Postgres and PostGIS on the same host, jobs in rootless
podman with gVisor, and Caddy in front for HTTPS. The scripts in
[deploy/](../deploy/) do all of it and are safe to re-run. For a development
install on your own machine, use [Quickstart](Quickstart.md) instead.

## Requirements

- A fresh Ubuntu 24.04 host (x86_64 or arm64) with root access. Use a
  dedicated machine or VM: the scripts install system packages, a firewall and
  a swapfile.
- Memory: 8 GB is a workable minimum. Library entries ask for up to 4 GB per
  job, and map tile renders take a few hundred MB each.
- Disk: raster data dominates. A country-sized deployment with the full
  library holds a few tens of GB; global layers need far more. Keep the data
  on a disk that Postgres can read (the database reads raster files directly
  for SQL).
- For HTTPS, a DNS name with an A (and AAAA, if any) record pointing at the
  host, and ports 80 and 443 reachable from the internet.

## Install

```sh
git clone https://github.com/mWater/data-integrator /opt/data-integrator
ADMIN_EMAIL=you@example.org PUBLIC_HOSTNAME=integrator.example.org \
  bash /opt/data-integrator/deploy/setup.sh
```

The first run takes a while, mostly building the two runtime images. At the
end it prints the admin account's one-time password. Sign in at
`https://integrator.example.org` and change it under Settings.

Without `PUBLIC_HOSTNAME` the host stays reachable over SSH only; reach the UI
through a tunnel (`ssh -L 8080:127.0.0.1:8080 root@<host>`, then
`http://localhost:8080`) and re-run `setup.sh` with the name later.

`setup.sh` variables: `ADMIN_EMAIL` (required), `PUBLIC_HOSTNAME`,
`OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` (seeds the AI provider on first
start; it can also be set later in Settings), `REPO_URL` and `REPO_REF` (the
source to clone when `/opt/data-integrator` holds no checkout),
`GVISOR_RELEASE`, `SETUP_FIREWALL` (default 1). The header of the script
documents each.

### What it sets up

| What | Where |
|---|---|
| Source and build | `/opt/data-integrator`, owned by the `integrator` user |
| Configuration | `/etc/data-integrator/env` (mode 640): database URL, data paths, `INTEGRATOR_SECRET_KEY`. Every variable is documented in [.env.example](../.env.example) |
| Raster store, file store, `/work`, tile cache | `/var/lib/data-integrator/{raster-store,file-store,work,tile-cache}` |
| Database | Postgres 16 database `integrator`, owned by the `integrator` role (not a superuser), plus the `sql_engine` read-only role |
| Service | `data-integrator.service`, running `cli.js serve` on port 8080, which the firewall keeps closed |
| HTTPS | Caddy with a Let's Encrypt certificate, proxying to the app |
| Host guards | `deploy/harden.sh`: a 4 GB swapfile, the app user's systemd manager protected from the OOM killer, unattended upgrades kept from restarting the service mid-run |
| Firewall | ufw allowing SSH, plus 80 and 443 with `PUBLIC_HOSTNAME` |

## Configure

Most configuration is in the UI, under Settings: the deployment's default area
of interest, site title, languages, users, and the AI provider, key and model.
The AI features also have daily token limits there (per user and for the
whole deployment; by default 5 million and 25 million tokens per UTC day).

`deploy/configure.sh` applies the same settings from the command line, which
helps when setting up several deployments alike:

```sh
AOI=MDG SITE_TITLE="Data Integrator Madagascar" USERS_FILE=/root/users.txt \
  bash /opt/data-integrator/deploy/configure.sh
```

It creates users from a file of `email password [role]` lines, sets the area
of interest from an ISO3 code, installs the library (all of it, minus
`SKIP_LIBRARY`) and queues a first run of each entry.

Limits for the host's capacity live in `/etc/data-integrator/env`; restart the
service after changing them:

- `SANDBOX_MEMORY_MB`: job memory committed at once across all running jobs
  (default: RAM minus 2 GB).
- `JOB_MAX_CPUS`, `JOB_MAX_MEMORY_MB`, `JOB_MAX_TIMEOUT_MIN`: the most any one
  job may ask for; larger requests in a definition are lowered.
- `WORK_QUOTA_MB`, `TMP_QUOTA_MB`, `MIN_FREE_DISK_MB`: the per-integration `/work`
  ceiling, the per-run `/tmp` ceiling (temporary disk under the work root, removed
  after each run), and the free-space floor below which runs refuse to start.
- `FILE_UPLOAD_MAX_MB`: the largest upload. `setup.sh` sizes Caddy's request
  limit from it, so re-run `setup.sh` after changing it.

## Another reverse proxy

To put the app behind a proxy or load balancer of your own instead of Caddy,
leave `PUBLIC_HOSTNAME` unset, open the proxy's port in ufw, and configure the
proxy to:

- forward to `127.0.0.1:8080` and set `X-Forwarded-Proto` (the session cookie
  is marked `Secure` only when it says `https`);
- allow request bodies of at least `FILE_UPLOAD_MAX_MB`, and uploads that take
  up to an hour on slow links;
- not buffer responses on `/api/sessions/*/events`, which are server-sent
  event streams.

## Updates

```sh
REF=v1.1.0 bash /opt/data-integrator/deploy/update.sh
```

`update.sh` checks out the given tag, branch or commit, rebuilds, applies
migrations, re-applies the host guards and restarts the service. Without
`REF` it builds the checkout as it stands. Add `IMAGES=1` when a release
changes `runtimes/` (its release notes say so); rebuilding the images is
slow. Runs in progress when the service restarts are failed by the reaper and
retried on their next schedule.

## Backups

Back up these, together:

| What | How | Notes |
|---|---|---|
| Database | `sudo -u postgres pg_dump -Fc integrator` | Everything except file contents |
| `/etc/data-integrator/env` | copy | `INTEGRATOR_SECRET_KEY` encrypts integration secrets and the AI key; without it they cannot be recovered |
| Raster store | file-level copy or snapshot | Immutable files, so incremental backups are cheap |
| File store | file-level copy or snapshot | Every uploaded file version |

`/work` holds integrations' caches and can be rebuilt by cold runs; the tile
cache rebuilds itself. To restore, install with `setup.sh`, stop the service,
restore the env file, the database and both stores to the same paths, and run
`node apps/server/dist/cli.js register-rasters --all` (as the `integrator`
user, with the env file loaded) if the raster store moved.

## Monitoring

`deploy/health.sh` prints the state of the service, database, scheduler, disk,
memory and runs, and exits 1 when anything needs attention, so it can run from
cron and mail its output. Within the app, the home page lists failing
integrations, overdue ones, runs whose data was flagged by validation rules,
and integrations waiting for credentials. Service logs are in
`journalctl -u data-integrator`.

## Security event log

The service writes security events to the same log, one JSON object per line
with `"type": "security"`, so a log forwarder or SIEM can pick them out:

```sh
journalctl -u data-integrator -o cat | grep '"type":"security"' | jq .
```

| event | when | fields |
|---|---|---|
| `auth.login` | every sign-in attempt | `outcome` (success, bad-credentials, locked, disabled, password-expired), `email`, `userId` on success |
| `auth.password_renewed` | an expired password replaced at sign-in | `email` |
| `api.write` | every POST, PUT, PATCH or DELETE to the API, refused ones included | `method`, `path`, `status`, `userId`, `email`, `role` (`userId` null when unauthenticated) |
| `account.disabled_inactive` | the account policy disabled an idle account | `userId`, `email`, `role`, `inactiveDisableDays` |
| `run.finished` | an integration run ends | `runId`, `integrationId`, `status`, `error` |

Every event carries `time`; request events also carry `ip` (the socket peer)
and `forwardedFor` (the proxy's `X-Forwarded-For`). `api.write` paths name the
action and its target, e.g. `PUT /api/users/:id/role` for a role change,
`POST /api/tokens` for a new API token, `PUT /api/integrations/:id/secrets/:name`
for a credential. Request bodies are never logged, query strings are dropped,
and webhook paths are logged as `/hooks/[redacted]`. Retention, forwarding,
integrity protection and alerting are configured in the deployer's log
pipeline (journald settings or a forwarder). Commands run with `cli.js` on the
host are not in this log; they are covered by the host's own shell and sudo
logging.
