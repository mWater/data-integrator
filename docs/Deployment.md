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

### Reference profile and scaling

Reference profile for one country (the proof-of-concept scope: the country's
library integrations and a handful of concurrent operators): a single host
with 4 vCPUs, 8 GB of memory (16 GB to run several large jobs at once) and
100 GB of disk. Size disk to the raster layers installed and memory to the
number of jobs that should run at once.

The design scales in these ways:

- **Jobs.** Runs queue in the database and are claimed under a lease, so any
  number of server processes can drain one queue. A server process runs two
  scheduled runs at a time. Capacity grows by adding hosts, each running one
  server process pointed at the same database and the same raster and file
  stores. `SANDBOX_MEMORY_MB` and the `JOB_MAX_*` ceilings bound what one
  host commits.
- **Storage.** The raster store is a directory, so it can be a larger disk, a
  network filesystem or an object-storage mount, provided Postgres can read
  the same path.
- **Database.** Standard Postgres, so vertical scaling and replication apply
  as usual. The one constraint is that the database server reads raster files
  to answer SQL, so it needs the raster store at the same path. A managed
  PostgreSQL service that cannot mount a filesystem does not fit.
- **Requests.** Sign-in sessions live in the database, so several server
  processes can sit behind one load balancer.

Performance targets and sizing criteria for procurement are set in UNICEF's
technical specifications (Deliverable 2), not here.

### Deployment profiles

Three layouts run the same software with the same configuration variables.
The scripts in `deploy/` install the first. It is what the proof of concept
runs and the only one exercised so far; the other two follow from the design,
are assembled by hand from the first, and have not been load-tested.

| Profile | For | Layout |
|---|---|---|
| Single host | One country or organization: the library's integrations and a handful of operators | Everything on one host, as `setup.sh` installs it |
| Separate database | The same, when jobs and the database compete for memory or disk, or the database has to sit on infrastructure of its own | One application host, and Postgres on a second host that mounts the raster store |
| Several application hosts | More scheduled runs at once, or many simultaneous viewers | Two or more application hosts behind a load balancer, one database host, and shared raster and file stores |

What moves a deployment from one profile to the next:

- **Concurrent jobs.** A host runs two scheduled runs at a time, plus runs
  started by hand and the AI designer's test runs, all within
  `SANDBOX_MEMORY_MB`. When runs regularly wait behind others, add memory if
  they are waiting for the memory budget, and add a host if more than two must
  run at once.
- **Raster volume.** Disk grows with the layers installed and the history
  they keep. A larger volume or a network filesystem under `RASTER_STORE_PATH`
  handles this in any profile.
- **Viewers.** Raster map tiles render in GDAL subprocesses,
  `TILE_RENDER_CONCURRENCY` at a time (default 3), and are cached after the
  first render. Table queries and vector tiles run in Postgres. On a single
  host both compete with jobs. A separate database host takes the queries
  away from the jobs, and more application hosts spread the rendering.

[Performance tests](Architecture.md#performance-tests) gives timings for each
of these operations on a machine close to the reference profile.

**Separate database.** Install the application host with `setup.sh`, then
point `DATABASE_URL` in `/etc/data-integrator/env` at the database host; the
Postgres that `setup.sh` installed locally is then unused and can be stopped.
The database host needs:

- Postgres 16 with the PostGIS and PostGIS raster extensions, the
  `integrator` and `sql_engine` roles, and the two PostGIS settings
  (`postgis.enable_outdb_rasters`, `postgis.gdal_enabled_drivers`), created
  as the database steps of `setup.sh` create them. `update.sh` applies
  superuser settings through the local `postgres` account, so when a
  release's notes name one, apply it on the database host by hand.
- The raster store mounted at the same absolute path as on the application
  host, readable by the `postgres` user. A run that writes a raster layer
  fails when the database cannot read the new files.
- Connections accepted only from the application hosts.

**Several application hosts.** Each host is installed like the single host and
runs one server process, which both serves requests and claims queued runs. A
host that fails loses only the runs it was executing: they are marked failed
after five minutes without a heartbeat and run again at their next scheduled
time.

- Shared by every host: the database, `INTEGRATOR_SECRET_KEY`, the same
  release and library, and the raster and file stores on a network filesystem
  mounted at the same paths (the raster store on the database host as well).
- Local to each host: `WORK_ROOT` and `TILE_CACHE_PATH`. `/work` is a cache
  that jobs must not depend on, so an integration whose next run lands on
  another host starts there with an empty one. The capacity limits
  (`SANDBOX_MEMORY_MB`, `JOB_MAX_*`) apply per host.
- One server process per host. At start a process removes the job containers
  left on its host, which would include those of a second process.
- The load balancer is configured as in
  [Another reverse proxy](#another-reverse-proxy), with session affinity so
  that a user's requests reach one host: the AI designer and Explore stream a
  session's progress from the process that runs it. A host left out of the
  load balancer still drains the queue.
- Update every host to the same release together: stop the service on each,
  run `update.sh` on one, which applies the migrations, then on the others.

With several application hosts the service keeps running when one of them
fails. It still stops when the database host or the shared filesystem fails,
because there is one of each. Protecting those, with a standby database and
storage that survives a failure, is the deploying organization's work and is
not something the platform sets up.

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
- `JOB_BLOCKED_ADDRESSES`: addresses or CIDRs jobs may not reach, on top of the
  private and link-local ranges that are always blocked. List the host's own
  public IPs, so job code cannot reach its SSH or HTTPS ports from outside, and
  any other services of yours that are on the internet.
- `WORK_QUOTA_MB`, `TMP_QUOTA_MB`, `MIN_FREE_DISK_MB`: the per-integration `/work`
  ceiling, the per-run `/tmp` ceiling (temporary disk under the work root, removed
  after each run), and the free-space floor below which runs refuse to start.
- `FILE_UPLOAD_MAX_MB`: the largest upload. `setup.sh` sizes Caddy's request
  limit from it, so re-run `setup.sh` after changing it.

### Using another integration library

The Library page and the AI designer's skills are read from one directory,
`LIBRARY_PATH`. When it is not set, that is `library/` in the application
checkout (`/opt/data-integrator/library`), which `update.sh` updates with
each release.

Any party can publish a library in the same format
([Integration Library Specification](spec/Integration%20Library%20Specification.md)).
To use one, check it out on the host, point `LIBRARY_PATH` at it in
`/etc/data-integrator/env`, and restart the service:

```sh
git clone --branch v1.0.0 https://example.org/their-library.git /srv/integration-library
git -C /srv/integration-library tag -v v1.0.0   # when the publisher signs its tags
echo 'LIBRARY_PATH=/srv/integration-library' >> /etc/data-integrator/env
systemctl restart data-integrator
```

- The path is absolute, holds `integrations/` and `skills/` directly, and is
  readable by the `integrator` user. A path without an `integrations/`
  directory gives an empty Library page, not an error.
- Integrations already installed keep running with their data; changing the
  library changes only what the Library page offers. An installed
  integration whose id is also in the new library is offered that entry as
  an update when the two differ.
- The AI designer reads its skills from `skills/` in the same directory. A
  library without the skills of the bundled one leaves the designer without
  that know-how, so copy across the ones you want to keep.
- `update.sh` does not touch a library outside the application checkout.
  Update it with git as its publisher releases, checking out a tag.
- One directory is read. To offer entries from several libraries, combine
  them in a directory of your own by copying each `integrations/<id>` and
  `skills/<id>` directory into it; ids must not collide.

A single integration from another deployment needs no library: export it
there and use Import on the Integrations page. It arrives paused, so its
code can be read and run by hand before it is scheduled.

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

### Single sign-on and multi-factor authentication

The application signs users in with local accounts. To meet enterprise
sign-on and multi-factor requirements, place it behind an identity-aware
proxy (for example oauth2-proxy, Pomerium, or a cloud identity gateway) that
authenticates users against the organization's identity provider over OIDC
or OAuth 2.0, with MFA enforced there. Users then pass the proxy, then sign
in to their local account. No application change is needed, but the proxy
must:

- serve the application at the root of its hostname (the interface uses
  absolute paths such as `/api` and `/tiles`);
- let `/hooks/*` through without sign-in: webhook senders cannot complete
  an interactive login, and the token they present is their credential
  (see [Controls for webhook senders](#controls-for-webhook-senders));
- let `/kit/*` through without sign-in: dashboards run in a sandboxed frame
  that loads these public runtime files without cookies;
- let API requests carrying `Authorization: Bearer dit_...` through, or route
  them separately: external systems use personal access tokens and cannot
  sign in interactively. Where policy requires MFA for access from outside the
  trusted network, accept bearer requests only from inside it.

Public dashboards reach only people who pass the proxy. The session cookie
(`di_session`, host-only, `HttpOnly`, `SameSite=Lax`) does not clash with the
proxy's own cookie.

### Controls for webhook senders

A webhook sender presents its integration's token, in a header
(`POST /hooks/<integration id>`) or in the URL (`POST /hooks/<token>`); see
[API](API.md#webhooks). Prefer the header where the sender supports it, since
it keeps the token out of URLs and proxy logs. The application checks the
token and nothing else about the sender, so controls on who may send belong
in the reverse proxy, for the senders that support them. The examples are for
Caddy, as `setup.sh` installs it.

**Source addresses.** For senders with fixed addresses, refuse `/hooks/*`
from anywhere else by adding a matcher to the site block. The rule sees the
address that connects to Caddy, so behind another load balancer apply it
there instead:

```
integrator.example.org {
	@hooks_elsewhere {
		path /hooks/*
		not remote_ip 203.0.113.0/24 198.51.100.7
	}
	respond @hooks_elsewhere 403
	...
}
```

**Client certificates (mutual TLS).** Give senders a hostname of their own
that requires a certificate issued by your certificate authority and forwards
only `/hooks/*`, and refuse `/hooks/*` on the main hostname:

```
hooks.example.org {
	tls {
		client_auth {
			mode require_and_verify
			trusted_ca_cert_file /etc/caddy/webhook-senders-ca.pem
		}
	}
	@hooks path /hooks/*
	handle @hooks {
		reverse_proxy 127.0.0.1:8080 {
			header_up X-Forwarded-Proto {scheme}
		}
	}
	respond 404
}

integrator.example.org {
	respond /hooks/* 404
	...
}
```

The proxy decides whether the certificate is acceptable; the application
does not see it, and the token still selects the integration. Caddy 2.8 and
later name the certificate authority with `trust_pool file` instead of
`trusted_ca_cert_file`, which they still accept.

**Rate limits.** Caddy as packaged has no rate limiter. Where one is
required, use a proxy or gateway that has one, such as nginx (`limit_req`)
or a cloud load balancer. The application itself caps each request at 1 MB.

`setup.sh` writes `/etc/caddy/Caddyfile` and overwrites it when re-run, so
keep a copy of what you add and put it back after re-running `setup.sh`.
Reload with `systemctl reload caddy`.

## Updates

Each release is a semantic-version tag with release notes on the repository's
Releases page; the notes say when a release changes the database or
`runtimes/`. Back up first (see [Backups](#backups)), then:

```sh
REF=v1.1.0 bash /opt/data-integrator/deploy/update.sh
```

`update.sh` checks out the given tag, branch or commit, rebuilds, applies
migrations, re-applies the host guards and restarts the service. Without
`REF` it builds the checkout as it stands. Add `IMAGES=1` when a release
changes `runtimes/` (its release notes say so); rebuilding the images is
slow. Runs in progress when the service restarts are failed by the reaper and
retried on their next schedule.

Migrations are forward-only. To roll back a release, restore the backup taken
before the update (below) and run `update.sh` with the previous release's tag.
`update.sh` stops at the first failing step; until its migrate step has run
the database is unchanged, so fixing the cause and re-running it, or running
it with the previous tag, recovers.

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
