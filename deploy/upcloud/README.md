# Throwaway test server on UpCloud

One Ubuntu 24.04 VM, one provisioning script, and a Cloudflare Tunnel that
puts the app on a hostname such as `integrator-angola.mwater.co` with no
inbound web ports. Total time is about ten minutes, most of it the build.

Nothing here is production hardening; it's the [Quickstart](../../Quickstart.md)
stack (rootless podman + gVisor sandbox, PostGIS, GDAL) wired up as a systemd
unit behind a Cloudflare Tunnel. gVisor's default systrap platform works on
UpCloud VMs — no nested virtualization needed.

## 1. Create the server

With [upctl](https://github.com/UpCloudLtd/upcloud-cli) (or the same choices in
the Hub UI):

```sh
upctl server create \
  --hostname integrator-test \
  --zone de-fra1 \
  --plan 2xCPU-4GB \
  --os "Ubuntu Server 24.04 LTS (Noble Numbat)" \
  --ssh-keys ~/.ssh/id_rsa.pub
```

4 GB RAM is the working minimum (the pnpm build plus two image builds);
8 GB is comfortable. The 2xCPU-4GB plan's 80 GB disk leaves room for raster
data.

## 2. Get the source onto the box

The repo is private, so the simplest path is to push your local checkout:

```sh
rsync -a --exclude node_modules --exclude .git/hooks ./ root@<ip>:/opt/data-integrator/
```

(Alternatively set `REPO_URL` — including a token for private access — and the
script clones it for you.)

## 3. Provision

Create the tunnel first (see [Hostname via Cloudflare Tunnel](#hostname-via-cloudflare-tunnel))
and pass its token, so the server comes up on its hostname:

```sh
ssh root@<ip>
ADMIN_EMAIL=you@example.org \
OPENROUTER_API_KEY=sk-or-... \
CLOUDFLARE_TUNNEL_TOKEN=eyJ... \
  bash /opt/data-integrator/deploy/upcloud/setup.sh
```

The API key is optional; without it everything except the AI features
works. The first start copies it into Settings, AI features, where an admin
can change the provider later. Without the tunnel token the server is reachable only over SSH
(`ssh -L 8080:127.0.0.1:8080 root@<ip>`, then http://localhost:8080) until
`cloudflare-tunnel.sh` runs. The script finishes by printing the generated
admin password.

What the script sets up:

- Node 22, pnpm, GDAL, rootless podman + nftables, gVisor `runsc`
- PostgreSQL 16 + PostGIS with an `integrator` database
- Builds the workspace and both runtime images as a dedicated `integrator` user
- Config in `/etc/data-integrator/env` (every variable documented in the
  repo's `.env.example`), data under `/var/lib/data-integrator`
- `data-integrator.service` systemd unit (restarts on failure and on reboot)
- `cloudflared` publishing the app on 127.0.0.1:8080, when given a tunnel token
- Host guards from `harden.sh` (re-applied by every day-2 update): a 4 GB
  swapfile, the app user's systemd manager exempt from the OOM killer, the
  service pulling that manager in on restart, and needrestart told to leave
  both alone during unattended upgrades
- ufw allowing only SSH (the app listens on all interfaces, so this keeps
  plain-HTTP :8080 off the internet); skip with `SETUP_FIREWALL=0`

## Configure a demo instance

`configure-demo.sh` does the post-provisioning setup that would otherwise be
clicked through the UI: users with chosen passwords, the default area of
interest, an optional site title, and the whole library installed. Run it as
root on the box after `setup.sh`; it is safe to re-run.

```sh
scp users.txt root@<ip>:/root/users.txt   # "email password [role]" per line
ssh root@<ip> AOI=KEN SITE_TITLE="Data Integrator Kenya" USERS_FILE=/root/users.txt \
  bash /opt/data-integrator/deploy/upcloud/configure-demo.sh
```

`AOI` is an ISO3 code from the built-in country list, or `global` to clear
the default so integrations use their full source extent. `SKIP_LIBRARY`
(default `mwater_admin_regions`, kept back as the live install example)
lists entries to leave uninstalled; `INSTALL_LIBRARY=0` installs nothing.
A first run of every installed entry is queued at the end (`RUN=0` skips
that) and the service's two scheduler workers drain the queue in the
background, so a full library takes a while: watch the Runs page or
`journalctl -u data-integrator -f`.

## Several servers at once

`fleet.sh` runs the steps above across a hosts file ("name ip aoi [nolib]"
per line), in parallel with a log per host under `.dev/fleet-logs/`:

```sh
./deploy/upcloud/fleet.sh setup      hosts.txt      # rsync + setup.sh everywhere
./deploy/upcloud/fleet.sh tunnel     hosts.txt kenya <token>   # one host's Cloudflare tunnel
./deploy/upcloud/fleet.sh configure  hosts.txt      # users, AOI, title, library, first runs
./deploy/upcloud/fleet.sh users      hosts.txt      # users file only (add users, reset passwords)
./deploy/upcloud/fleet.sh status     hosts.txt      # service, run counts, disk
./deploy/upcloud/fleet.sh push       hosts.txt      # day-2 update everywhere
./deploy/upcloud/fleet.sh secrets    hosts.txt madagascar   # copy one host's secrets to the rest
./deploy/upcloud/fleet.sh rerun      hosts.txt      # queue a run wherever the last one failed
./deploy/upcloud/fleet.sh install    hosts.txt <id>  # install or update library entries: push first, then this
./deploy/upcloud/fleet.sh cli        hosts.txt backfill-cell-sizes   # any server CLI command on every host
```

Secrets are set once on one host (integration page, or on the box
`echo '<value>' | cli.js secret set <integration> <name>`) and copied with
`secrets`, which runs `cli.js secret export` there and `secret import` on
every other host; the plaintext passes through your machine over ssh and is
never written down.

`ADMIN_EMAIL`, `OPENROUTER_API_KEY`, and `USERS_FILE` come from the
environment; the header of the script lists the defaults.

## Day-2

Deploy an update — pushes the working tree, rebuilds, migrates, restarts:

```sh
./deploy/upcloud/push.sh root@<ip>
```

Add `IMAGES=1` when `runtimes/` changed, to rebuild the sandbox images too.
Two steps in there are easy to miss by hand: the rsync runs as root, so the
tree has to be handed back to the `integrator` user before the build, and
`serve` does not migrate at boot, so a schema change needs the explicit
`migrate`. Files deleted locally are not removed on the server.

```sh
# logs
ssh root@<ip> journalctl -u data-integrator -f
```

`setup.sh` is also safe to re-run; it keeps the existing env file (and secret
key) and skips work already done.

## Reset to a clean install

To wipe a box back to empty (fresh database, no data) without reprovisioning:

```sh
systemctl stop data-integrator
sudo -u postgres dropdb integrator
sudo -u postgres createdb -O integrator integrator
sudo -u postgres psql -d integrator -c "CREATE EXTENSION postgis"
sudo -u postgres psql -d integrator -c "CREATE EXTENSION postgis_raster"
sudo -u postgres psql -c "ALTER DATABASE integrator SET postgis.enable_outdb_rasters = on"
sudo -u postgres psql -c "ALTER DATABASE integrator SET postgis.gdal_enabled_drivers = 'ENABLE_ALL'"
rm -rf /var/lib/data-integrator/{raster-store,work,tile-cache}
```

then migrate, recreate the admin, and restart (the `run_cli` shape from
setup.sh). The two ALTER DATABASE lines are easy to forget and fail loudly
only later: raster registration errors with "Cannot open out-db file with
GDAL". They are superuser-set, so migration 0008 can only warn when they
are missing. Re-running `setup.sh` does all of this too, and is the safer
path when in doubt.

## Hostname via Cloudflare Tunnel

Every server is published on the Cloudflare-managed `mwater.co` zone as
`integrator-<name>.mwater.co`: TLS terminates at Cloudflare, `cloudflared`
dials out and proxies to the app on 127.0.0.1:8080, and the server keeps no
inbound ports open besides SSH.

1. In the Cloudflare Zero Trust dashboard (Networks -> Tunnels), create a
   tunnel with the Cloudflared connector and copy its token.
2. On the tunnel's Public Hostname tab, add the hostname pointing to
   `HTTP://127.0.0.1:8080`. This also creates the DNS record.
3. Pass the token to `setup.sh` as above, or for a server already
   provisioned, from your checkout:

   ```sh
   ./deploy/upcloud/fleet.sh tunnel hosts.txt <name> <token>
   ```

   which runs `cloudflare-tunnel.sh` on the box.

The script installs `cloudflared` as a systemd service. Skip any Zero Trust
Access policy on the hostname if the site should be reachable by the world;
the app's own logins are the gate. Session cookies stay `Secure` because
Cloudflare sets `X-Forwarded-Proto`, and the SSE heartbeat keeps idle
designer streams alive through the Cloudflare proxy. A new record can take
a minute to resolve if anything looked the name up before it existed (the
`*.mwater.co` wildcard answer is cached briefly).

## Tear down

```sh
upctl server stop --type hard integrator-test
upctl server delete --delete-storages integrator-test
```

## Notes

- On small plans, two concurrent download-heavy runs can starve the rootless
  sandbox's DNS (slirp4netns forwards lookups over UDP): jobs then fail with
  curl "Could not resolve host" for hosts that resolve fine on the box. It
  clears when the box is less loaded; re-run the failed integration.

