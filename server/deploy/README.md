# Operator VPS

The production host, set up by hand on 10 October 2026. Its configuration now lives in the Ansible playbook in `ansible/` (backend spec section 8): `site.yml` and one role per part (`base`, `firewall`, `caddy`, `strfry`, `kefli`, `backup`), with the settings in `ansible/group_vars/all.yml` and the host in `ansible/inventory/production.yml`. `deploy.sh` builds the Go binaries and runs the playbook through Docker, so this machine needs only Docker and SSH; `deploy.sh --check --diff` shows what a run would change without changing anything, and `--tags deploy` limits it to keflid, the relay's policy and sweep, and the configuration. `ansible/test.sh` runs the playbook twice against a throwaway Debian 13 container and checks the services through Caddy. The live box was set up by hand before the playbook existed; the playbook first ran against it on 10 October 2026 after a `--check --diff` review, and a second run changed nothing. The hand-built strfry was recorded at its commit in `/usr/local/lib/kefli/strfry.commit` first, so the playbook didn't rebuild it.

| | |
|---|---|
| Host | `kefli-1`, Hetzner Cloud, 1 vCPU, 2 GB RAM, 38 GB disk, plus a 2 GB swap file |
| OS | Debian 13 (trixie), UTC |
| Addresses | `2.31.53.13`, `2a01:4f8:1c16:497a::1` |
| DNS | Hetzner DNS: the apex, `relay`, `api` and `blossom` have A and AAAA records for the host, `www` is a CNAME to the apex. CAA allows Let's Encrypt only. The apex's SPF is `-all` and DMARC `p=reject`: the only mail the domain sends is the forwarder's, through Resend, which is DKIM-signed for `kefli.app` and bounces to `send.kefli.app`. Resend's records are under Mail below |
| Login | `richard` by key only (`~/.ssh/id_ed25519_kefli`), with passwordless sudo. Root and password login are off |

The box is smaller than the spec's CCX23 because on-device speech (flow decision 22) takes the Kokoro worker out of v1. Rescale in the Hetzner console when load calls for it.

## Host

- `ansible/roles/base/templates/sshd-10-kefli.conf.j2` goes to `/etc/ssh/sshd_config.d/10-kefli.conf`.
- `ansible/roles/firewall/templates/nftables.conf.j2` goes to `/etc/nftables.conf`. It allows SSH from the addresses in `ssh_allow4` (`kefli_ssh_allow4` in the inventory) only, plus 80 and 443 from anywhere. When the home address changes, log in through the Hetzner console, add the new address to the set, and run `sudo nft -f /etc/nftables.conf`. Change the Hetzner Cloud firewall to match.
- Unattended upgrades are on for Debian security updates.

## Caddy

Caddy 2.11.4 is installed from the `.deb` on its GitHub release page, checked against the release's sha512 checksums. Its Cloudsmith apt repository answered 402 on 10 October 2026, and Debian's package is 2.6.2. Nothing upgrades it automatically, so new releases go on by hand the same way.

`ansible/roles/caddy/templates/Caddyfile.j2` goes to `/etc/caddy/Caddyfile` (the playbook validates it first, as the `caddy` user). Certificates come from Let's Encrypt and renew themselves. `api.kefli.app` and `blossom.kefli.app` go to keflid, with request bodies held to 1 MB and 9 MB; the apex sends `/.well-known/nostr.json` to keflid and otherwise serves the website from `/var/www/kefli`, which `apps/web/deploy.sh` puts there. Release files (the APK and the browser extensions) are in `/var/www/kefli/downloads`, put there by `apps/web/publish-downloads.sh`; Caddy serves `.xpi` as `application/x-xpinstall` so Firefox installs it from a link, and `.apk` as an Android package. Hashed assets, media and fonts are cached for a year; everything else, the pages and the release files, goes out with `Cache-Control: no-cache`, so a browser checks each time and a deploy shows at once. The access log, `/var/log/caddy/access.log`, follows the backend spec's log policy: time, method, the path's first segment, status, bytes and latency, with no address, query or header, kept seven days. The spec's per-address limits in Caddy need a plugin that the packaged Caddy lacks; keflid's own limits per key and per address stand in, counting an IPv6 client by its /64 (a /56 for registrations), along with limits on everyone together: 200 new accounts an hour, 100 phone-offer lookups that find nothing in five minutes, and uploads refused with 507 once they would leave less than `kefli_min_free_mb` (4 GB) free on the disk.

Caddy's admin API listens on `/run/caddy/admin.sock`, which only root and the `caddy` user can open, never on `localhost:2019`, where any local account could load a new configuration (F49). The Caddyfile's `admin` line puts it there, and `/etc/systemd/system/caddy.service.d/10-kefli.conf` has systemd make `/run/caddy` as Caddy starts. `systemctl reload caddy` reads the same line and reloads through the socket; by hand, `sudo -u caddy curl --unix-socket /run/caddy/admin.sock http://localhost/config/` shows the running configuration.

## keflid

`keflid` (API and Blossom), `keflictl` and `kefli-writepolicy` are built by `make -C server/api build` (Go in Docker, static binaries) and installed by the playbook's `kefli` role. Its files are under `ansible/roles/kefli/`.

| File | Goes to |
|---|---|
| `files/keflid.service` | `/etc/systemd/system/keflid.service` |
| `templates/keflid.env.j2` | `/etc/kefli/keflid.env` |
| `templates/defaults.json.j2` (from `kefli_defaults`) | `/etc/kefli/defaults.json`, served as `https://api.kefli.app/defaults.json` (contract 3.1) |
| `templates/nip05.json.j2` (from `kefli_nip05`) | `/etc/kefli/nip05.json`, served as `https://kefli.app/.well-known/nostr.json`: the operator's own `_` and `kefli` names (contract 6). The Kefli account's key stays in Richard's signer |
| `files/keflictl.sh` | `/usr/local/bin/keflictl` |

keflid runs as the `kefli` system user. Its database and blobs are in `/var/lib/kefli` (`keflid.db`, `blobs/`), readable by the `kefli` group, which `strfry` belongs to so that the write policy can read the allowlist. It listens on `127.0.0.1:8447` (API) and `127.0.0.1:3447` (Blossom). The operator's commands are `sudo keflictl register|disable|enable <pubkey>` and `sudo keflictl gone <days>`. `defaults.json` and `nip05.json` are read at start, so after changing them run `deploy.sh`, which restarts keflid; retiring a relay or mirror that refuses saves happens within a day (contract 3.1, flow decision 93). Since contract 1.11, `POST /devices` takes a browser's key only with the browser's own proof from its pairing offer, or in a move the holding library's release (F44), so a phone or an extension from before 1.11 gets `400 proof: missing` and must be updated; the journal's `device added` line names both keys by their fingerprints only. `KEFLID_MIN_FREE_MB` in `keflid.env`, from `kefli_min_free_mb` (4096), is the free space below which Blossom answers 507.

## strfry

strfry is built on the box from source by the playbook's `strfry` role, at the commit in `strfry_commit` (`4cd3cf6`) on its `master` branch (4 September 2026). The 1.1.3 tag sits on the `release` branch, which lacks the NIP-42 settings (`relay.auth`) that contract section 3.2 relies on; master has them with tests, and it is what the dev stack's `ghcr.io/hoytech/strfry:latest` image runs.

To move to a new commit, change `strfry_commit` and run `deploy.sh`; it builds with `strfry_make_jobs` jobs (one, which fits the 2 GB box) and restarts strfry.

| File | Goes to |
|---|---|
| `ansible/roles/strfry/templates/strfry.conf.j2` | `/etc/strfry.conf` |
| `ansible/roles/strfry/files/strfry.service` | `/etc/systemd/system/strfry.service` |
| `ansible/roles/strfry/templates/relay-write-policy.j2` | `/usr/local/lib/kefli/relay-write-policy` |
| `ansible/roles/strfry/files/relay-sweep`, `.service`, `.timer` | `/usr/local/lib/kefli/relay-sweep`, `/etc/systemd/system/` |

The database lives in `/var/lib/strfry/db`, owned by the `strfry` system user, with the write policy's record of the wraps the relay holds next to it in `/var/lib/strfry/wraps.db`. strfry listens on `127.0.0.1:7777` only, behind Caddy on `relay.kefli.app`. It holds events to 64 KB, and the write policy, `kefli-writepolicy`, applies the rest of contract 3.2 against keflid's database: registered authors, wraps to registered users and authorised devices, the extension's Undo, kinds 30078 and 1059 at 16 KB, and 60 events a minute. Events from unregistered authors are held to 240 an hour from an address (an IPv6 /64), and a gift wrap also to 120 an hour to one recipient from one address and 1,200 an hour to one recipient from everyone, unless it comes on a connection AUTHed as its recipient's side, which counts only against that key's 60 a minute (F9); the extension AUTHs as its device key before it publishes. While the disk under `/var/lib/strfry/db` has less than `kefli_relay_min_free_mb` (2 GB, below the blobs' 4 GB) free, the write policy answers every new event `rate-limited: the relay is nearly full, try again later`, which the phone and the extension both send again later, and says so in strfry's journal; reads go on. Frames are compressed without a window kept for each connection (`relay.compression.slidingWindow = false`), which held about 130 KB a connection.

`relay-sweep` runs nightly at 03:30 UTC (backend spec 6): it drops gift wraps older than 30 days, wraps addressed to keys `DELETE /account` removed, and every event by a removed key once it has been gone 30 days. keflid lists a key as removed only when it had an account, and forgets it after 60 days; the write policy forgets, at start and hourly, the wraps the sweep has dropped: those over 31 days old and those addressed to a removed key (F45). It logs counts only. Run it by hand with `sudo systemctl start relay-sweep` and read `journalctl -u relay-sweep`.

## Mail

Mail to `privacy@kefli.app`, the address on the website's privacy and delete-account pages, goes to the company inbox, `mosarricservicesltd@gmail.com`. Resend receives everything sent to the domain and calls `https://kefli.app/hooks/resend` with an `email.received` webhook. `kefli-mailfwd` checks the signature, fetches the message and its attachments, and sends them on from `privacy@kefli.app` with Reply-To set to the sender, so a reply from the inbox goes to them. Mail for any other address on the domain is dropped. Its journal holds each message's Resend id and whether it went, never an address or a subject. It forwards one message at a time, holding it whole in memory: a webhook that waits ten seconds for the one before it gets 503 and Resend sends it again later, and the service is held to 768 MB, so a huge message fails there rather than taking the box's memory.

| File | Goes to |
|---|---|
| `ansible/roles/kefli/files/kefli-mailfwd.service` | `/etc/systemd/system/kefli-mailfwd.service` |
| `ansible/roles/kefli/templates/kefli-mailfwd.env.j2` | `/etc/kefli/kefli-mailfwd.env`: the address it accepts, the sender and the inbox |
| (by hand) | `/etc/kefli/kefli-mailfwd.secret.env`, root only: `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` |

It listens on `127.0.0.1:8449` and doesn't start until the secret file exists. Setting it up:

1. In Resend, add the domain `kefli.app` in the EU region and put the records it lists into Hetzner DNS: the DKIM TXT at `resend._domainkey`, and the MX and SPF TXT at `send` for bounces. Leave the apex's own SPF as it is.
2. Turn on receiving for the domain and add the MX record it gives at the apex. The apex has no other MX, so Resend's takes all mail for `kefli.app`.
3. Create an API key with full access (a sending-only key can't read received mail).
4. Add a webhook for `email.received` at `https://kefli.app/hooks/resend` and copy its signing secret.
5. On the box, write the secrets and start it:

```
sudo install -m 600 /dev/stdin /etc/kefli/kefli-mailfwd.secret.env <<'EOF'
RESEND_API_KEY=re_…
RESEND_WEBHOOK_SECRET=whsec_…
EOF
sudo systemctl restart kefli-mailfwd && journalctl -u kefli-mailfwd -f
```

Then send a test message to `privacy@kefli.app` from another account.

## Backups

Nightly at about 04:15 UTC (backend spec 3.8), `kefli-backup` exports the relay's events, copies keflid's database through SQLite's backup, and sends them with the blobs to a Hetzner Storage Box with restic, leaving out the gift wraps, the write policy's record of them and the inbox blobs, which the extension's privacy note promises are gone within 14 days (F31; not in backups from 13 October 2026, and a restore starts without them), keeping 14 daily and 8 weekly snapshots. restic encrypts everything on the box before it leaves, under a password kept in `/etc/kefli/restic.env` (root only) and in the operator's password manager; without it the backups can't be read.

| | |
|---|---|
| Storage Box | `u688582`, `u688582.your-storagebox.de`, reached over SFTP on port 23 as `kefli-backup-box` (root's `~/.ssh/config`, written by the playbook from `kefli_backup_box` in the inventory) with a key used for nothing else, `/root/.ssh/kefli-backup`. Its host key is pinned to the fingerprint Hetzner publishes |
| Repository | `sftp:kefli-backup-box:kefli` |
| Alerts | healthchecks.io's "Kefli backup" check (cron `15 4 * * *` UTC, an hour's grace) hears each run's start, end and any failure, and emails the company inbox when a night is missed or fails. Its ping URL is `HEALTHCHECK_URL` in `restic.env` |
| Commands | `sudo kefli-restic snapshots`, `sudo kefli-restic restore latest --target /tmp/restore`, and any other restic command; `sudo systemctl start kefli-backup` runs one now |

Setting it up on a new box, once the playbook has run:

1. In the Hetzner Console, turn on SSH support for the Storage Box.
2. Add the backup key, with the Storage Box's password: `ssh -t kefli 'sudo sh -c "ssh -p 23 -o PubkeyAuthentication=no <user>@<host> install-ssh-key < /root/.ssh/kefli-backup.pub"'`.
3. `ssh -t kefli sudo kefli-backup-setup`: it writes `restic.env` with a new random password, shows the password once for the password manager, and creates the repository.
4. In the Hetzner Console, open the Storage Box, then Snapshots, choose Enable automatic snapshots, set it to daily at 06:00 UTC (after the backup and its prune), with as many snapshot slots as the plan allows (10 on a BX11), and save.
5. Check that the backup key can't delete a snapshot: once one exists, `ssh -t kefli 'sudo sftp kefli-backup-box'`, then `ls .zfs/snapshot` and `rmdir` (or `rm`) on one of them, which must be refused. Note the result in `docs/HANDOVER.md`.

The backup key can delete the repository (F48). restic needs write and delete rights over SFTP even to back up, since it removes its own lock files, so it has no append-only mode there, and the nightly `forget --prune` deletes snapshots with the same key. Anyone with root on the VPS, one passwordless sudo away from the admin account, could therefore delete every restic snapshot. The Storage Box's own snapshots, from step 4, are meant to be what that can't reach: Hetzner shows them read-only over SFTP and manages them from the Console or its API, which use credentials of their own, but its documentation doesn't say outright that the SSH key can't delete them. Until that is confirmed in the Console (step 5), treat it as unchecked. With ten daily slots, a deleted repository can be brought back for ten days. When healthchecks reports a failed or missed backup, look before the next 06:00: if the repository is damaged, turn off automatic snapshots at once so new snapshots don't push out the good ones, then roll the Storage Box back to the newest good snapshot in the Console, or copy the repository out of it, before anything else.

The first backup on 10 October 2026 was restored to a scratch directory and matched the live data: keflid's database and the wraps record passed SQLite's integrity check with the same accounts, the relay export had every event, and every blob was byte for byte the same. Rehearse a restore like that after any change to the backup.

## Not yet on the box

Monitoring and an outside uptime probe, NIP-11's operator pubkey, and the 90-day trim of unrelated public kinds (only registered keys can write, so none arrive yet). NIP-05's `_` name went live by hand on 10 October 2026, the same file the playbook writes.
