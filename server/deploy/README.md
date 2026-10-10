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

`ansible/roles/caddy/templates/Caddyfile.j2` goes to `/etc/caddy/Caddyfile` (the playbook validates it first, as the `caddy` user). Certificates come from Let's Encrypt and renew themselves. `api.kefli.app` and `blossom.kefli.app` go to keflid, with request bodies held to 1 MB and 9 MB; the apex sends `/.well-known/nostr.json` to keflid and otherwise serves the website from `/var/www/kefli`, which `apps/web/deploy.sh` puts there. Release files (the APK and the browser extensions) are in `/var/www/kefli/downloads`, put there by `apps/web/publish-downloads.sh`; Caddy serves `.xpi` as `application/x-xpinstall` so Firefox installs it from a link, and `.apk` as an Android package. The access log, `/var/log/caddy/access.log`, follows the backend spec's log policy: time, method, the path's first segment, status, bytes and latency, with no address, query or header, kept seven days. The spec's per-address limits in Caddy need a plugin that the packaged Caddy lacks; keflid's own limits per key and per address stand in.

## keflid

`keflid` (API and Blossom), `keflictl` and `kefli-writepolicy` are built by `make -C server/api build` (Go in Docker, static binaries) and installed by the playbook's `kefli` role. Its files are under `ansible/roles/kefli/`.

| File | Goes to |
|---|---|
| `files/keflid.service` | `/etc/systemd/system/keflid.service` |
| `templates/keflid.env.j2` | `/etc/kefli/keflid.env` |
| `templates/defaults.json.j2` (from `kefli_defaults`) | `/etc/kefli/defaults.json`, served as `https://api.kefli.app/defaults.json` (contract 3.1) |
| `templates/nip05.json.j2` (from `kefli_nip05`) | `/etc/kefli/nip05.json`, served as `https://kefli.app/.well-known/nostr.json`: the operator's own `_` and `kefli` names (contract 6). The Kefli account's key stays in Richard's signer |
| `files/keflictl.sh` | `/usr/local/bin/keflictl` |

keflid runs as the `kefli` system user. Its database and blobs are in `/var/lib/kefli` (`keflid.db`, `blobs/`), readable by the `kefli` group, which `strfry` belongs to so that the write policy can read the allowlist. It listens on `127.0.0.1:8447` (API) and `127.0.0.1:3447` (Blossom). The operator's commands are `sudo keflictl register|disable|enable <pubkey>` and `sudo keflictl gone <days>`. `defaults.json` and `nip05.json` are read at start, so after changing them run `deploy.sh`, which restarts keflid; retiring a relay or mirror that refuses saves happens within a day (contract 3.1, flow decision 93).

## strfry

strfry is built on the box from source by the playbook's `strfry` role, at the commit in `strfry_commit` (`4cd3cf6`) on its `master` branch (4 September 2026). The 1.1.3 tag sits on the `release` branch, which lacks the NIP-42 settings (`relay.auth`) that contract section 3.2 relies on; master has them with tests, and it is what the dev stack's `ghcr.io/hoytech/strfry:latest` image runs.

To move to a new commit, change `strfry_commit` and run `deploy.sh`; it builds with `strfry_make_jobs` jobs (one, which fits the 2 GB box) and restarts strfry.

| File | Goes to |
|---|---|
| `ansible/roles/strfry/templates/strfry.conf.j2` | `/etc/strfry.conf` |
| `ansible/roles/strfry/files/strfry.service` | `/etc/systemd/system/strfry.service` |
| `ansible/roles/strfry/files/relay-write-policy` | `/usr/local/lib/kefli/relay-write-policy` |
| `ansible/roles/strfry/files/relay-sweep`, `.service`, `.timer` | `/usr/local/lib/kefli/relay-sweep`, `/etc/systemd/system/` |

The database lives in `/var/lib/strfry/db`, owned by the `strfry` system user, with the write policy's record of the wraps the relay holds next to it in `/var/lib/strfry/wraps.db`. strfry listens on `127.0.0.1:7777` only, behind Caddy on `relay.kefli.app`. It holds events to 64 KB, and the write policy, `kefli-writepolicy`, applies the rest of contract 3.2 against keflid's database: registered authors, wraps to registered users and authorised devices, the extension's Undo, kinds 30078 and 1059 at 16 KB, and 60 events a minute.

`relay-sweep` runs nightly at 03:30 UTC (backend spec 6): it drops gift wraps older than 30 days, wraps addressed to keys `DELETE /account` removed, and every event by a removed key once it has been gone 30 days. It logs counts only. Run it by hand with `sudo systemctl start relay-sweep` and read `journalctl -u relay-sweep`.

## Mail

Mail to `privacy@kefli.app`, the address on the website's privacy and delete-account pages, goes to the company inbox, `mosarricservicesltd@gmail.com`. Resend receives everything sent to the domain and calls `https://kefli.app/hooks/resend` with an `email.received` webhook. `kefli-mailfwd` checks the signature, fetches the message and its attachments, and sends them on from `privacy@kefli.app` with Reply-To set to the sender, so a reply from the inbox goes to them. Mail for any other address on the domain is dropped. Its journal holds each message's Resend id and whether it went, never an address or a subject.

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

## Not yet on the box

Backups to a Storage Box: the `backup` role installs restic and a nightly timer, which does nothing until `/etc/kefli/restic.env` holds the repository, its password and the healthchecks address. Monitoring and an outside uptime probe, NIP-11's operator pubkey, and the 90-day trim of unrelated public kinds (only registered keys can write, so none arrive yet). NIP-05's `_` name went live by hand on 10 October 2026, the same file the playbook writes.
