# Throwaway test server on UpCloud

The quickest way to get a shareable HTTPS instance for testing: one Ubuntu
24.04 VM, one provisioning script, and Caddy terminating TLS on a
`<public-ip>.sslip.io` hostname — a real Let's Encrypt certificate with no
domain or DNS setup. Total time is about ten minutes, most of it the build.

Nothing here is production hardening; it's the [Quickstart](../../Quickstart.md)
stack (rootless podman + gVisor sandbox, PostGIS, GDAL) wired up behind a
reverse proxy and a systemd unit. gVisor's default systrap platform works on
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
  --ssh-keys ~/.ssh/id_ed25519.pub
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

```sh
ssh root@<ip>
ADMIN_EMAIL=you@example.org \
OPENROUTER_API_KEY=sk-or-... \
  bash /opt/data-integrator/deploy/upcloud/setup.sh
```

The API key is optional — without it everything except the designer agent
works. The script finishes by printing the URL
(`https://<ip>.sslip.io`) and the generated admin password. Give the first
HTTPS request ~30 seconds while Caddy obtains the certificate.

What the script sets up:

- Node 22, pnpm, GDAL, rootless podman + nftables, gVisor `runsc`
- PostgreSQL 16 + PostGIS with an `integrator` database
- Builds the workspace and both runtime images as a dedicated `integrator` user
- Config in `/etc/data-integrator/env` (every variable documented in the
  repo's `.env.example`), data under `/var/lib/data-integrator`
- `data-integrator.service` systemd unit (restarts on failure and on reboot)
- Caddy on 80/443 proxying to the app on 127.0.0.1:8080
- ufw allowing only 22/80/443 (the app listens on all interfaces, so this
  keeps plain-HTTP :8080 off the internet); skip with `SETUP_FIREWALL=0`

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

## Tear down

```sh
upctl server stop --type hard integrator-test
upctl server delete --delete-storages integrator-test
```

## Notes

- sslip.io shares Let's Encrypt rate limits across all its users. If issuance
  fails, swap the hostname in `/etc/caddy/Caddyfile` to the `nip.io`
  equivalent and `systemctl reload caddy`.
- Session cookies work correctly behind the proxy — the server marks them
  `Secure` based on `X-Forwarded-Proto`, which Caddy sets.
- When a real (sub)domain becomes available, point an A record at the server,
  replace the hostname in `/etc/caddy/Caddyfile`, and reload — nothing else
  changes.
