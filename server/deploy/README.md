# Operator VPS

The production host, set up by hand on 10 October 2026 and recorded here until the Ansible playbook (backend spec section 8, week 0) replaces these notes. Every file in this directory is the copy that is live on the box. `deploy.sh` builds the Go binaries and installs keflid, the relay's write policy and sweep, and the strfry and Caddy configuration, and restarts them; the host setup below (SSH, nftables, Caddy and strfry themselves) stays by hand.

| | |
|---|---|
| Host | `kefli-1`, Hetzner Cloud, 1 vCPU, 2 GB RAM, 38 GB disk, plus a 2 GB swap file |
| OS | Debian 13 (trixie), UTC |
| Addresses | `2.31.53.13`, `2a01:4f8:1c16:497a::1` |
| DNS | Hetzner DNS: the apex, `relay`, `api` and `blossom` have A and AAAA records for the host, `www` is a CNAME to the apex. CAA allows Let's Encrypt only. SPF `-all` and DMARC `p=reject`, because the domain sends no mail |
| Login | `richard` by key only (`~/.ssh/id_ed25519_kefli`), with passwordless sudo. Root and password login are off |

The box is smaller than the spec's CCX23 because on-device speech (flow decision 22) takes the Kokoro worker out of v1. Rescale in the Hetzner console when load calls for it.

## Host

- `host/sshd-10-kefli.conf` goes to `/etc/ssh/sshd_config.d/10-kefli.conf`.
- `host/nftables.conf` goes to `/etc/nftables.conf`. It allows SSH from the addresses in `ssh_allow4` only, plus 80 and 443 from anywhere. When the home address changes, log in through the Hetzner console, add the new address to the set, and run `sudo nft -f /etc/nftables.conf`. Change the Hetzner Cloud firewall to match.
- Unattended upgrades are on for Debian security updates.

## Caddy

Caddy 2.11.4 is installed from the `.deb` on its GitHub release page, checked against the release's sha512 checksums. Its Cloudsmith apt repository answered 402 on 10 October 2026, and Debian's package is 2.6.2. Nothing upgrades it automatically, so new releases go on by hand the same way.

`caddy/Caddyfile` goes to `/etc/caddy/Caddyfile` (`deploy.sh` validates it first). Certificates come from Let's Encrypt and renew themselves. `api.kefli.app` and `blossom.kefli.app` go to keflid, with request bodies held to 1 MB and 9 MB; the apex sends `/.well-known/nostr.json` to keflid and otherwise serves a holding page until apps/web is deployed. The access log, `/var/log/caddy/access.log`, follows the backend spec's log policy: time, method, the path's first segment, status, bytes and latency, with no address, query or header, kept seven days. The spec's per-address limits in Caddy need a plugin that the packaged Caddy lacks; keflid's own limits per key and per address stand in.

## keflid

`keflid` (API and Blossom), `keflictl` and `kefli-writepolicy` are built by `make -C server/api build` (Go in Docker, static binaries) and installed by `deploy.sh`.

| File | Goes to |
|---|---|
| `kefli/keflid.service` | `/etc/systemd/system/keflid.service` |
| `kefli/keflid.env` | `/etc/kefli/keflid.env` |
| `kefli/defaults.json` | `/etc/kefli/defaults.json`, served as `https://api.kefli.app/defaults.json` (contract 3.1) |
| `kefli/keflictl.sh` | `/usr/local/bin/keflictl` |

keflid runs as the `kefli` system user. Its database and blobs are in `/var/lib/kefli` (`keflid.db`, `blobs/`), readable by the `kefli` group, which `strfry` belongs to so that the write policy can read the allowlist. It listens on `127.0.0.1:8447` (API) and `127.0.0.1:3447` (Blossom). The operator's commands are `sudo keflictl register|disable|enable <pubkey>` and `sudo keflictl gone <days>`. `defaults.json` is read at start, so after changing it run `deploy.sh` or `sudo systemctl restart keflid`; retiring a relay or mirror that refuses saves happens within a day (contract 3.1, flow decision 93).

## strfry

strfry is built on the box from source at commit `4cd3cf6` on its `master` branch (4 September 2026). The 1.1.3 tag sits on the `release` branch, which lacks the NIP-42 settings (`relay.auth`) that contract section 3.2 relies on; master has them with tests, and it is what the dev stack's `ghcr.io/hoytech/strfry:latest` image runs.

```
cd ~/src/strfry && git fetch && git checkout <commit> && git submodule update --init
make setup-golpe && make -j1
sudo install -m 755 -s strfry /usr/local/bin/strfry && sudo systemctl restart strfry
```

| File | Goes to |
|---|---|
| `strfry/strfry.conf` | `/etc/strfry.conf` |
| `strfry/strfry.service` | `/etc/systemd/system/strfry.service` |
| `strfry/relay-write-policy` | `/usr/local/lib/kefli/relay-write-policy` |
| `strfry/relay-sweep`, `.service`, `.timer` | `/usr/local/lib/kefli/relay-sweep`, `/etc/systemd/system/` |

The database lives in `/var/lib/strfry/db`, owned by the `strfry` system user, with the write policy's record of the wraps the relay holds next to it in `/var/lib/strfry/wraps.db`. strfry listens on `127.0.0.1:7777` only, behind Caddy on `relay.kefli.app`. It holds events to 64 KB, and the write policy, `kefli-writepolicy`, applies the rest of contract 3.2 against keflid's database: registered authors, wraps to registered users and authorised devices, the extension's Undo, kinds 30078 and 1059 at 16 KB, and 60 events a minute.

`relay-sweep` runs nightly at 03:30 UTC (backend spec 6): it drops gift wraps older than 30 days, wraps addressed to keys `DELETE /account` removed, and every event by a removed key once it has been gone 30 days. It logs counts only. Run it by hand with `sudo systemctl start relay-sweep` and read `journalctl -u relay-sweep`.

## Not yet on the box

The website, backups to a Storage Box (which needs the box and its credentials), monitoring and an outside uptime probe, NIP-11's operator pubkey and NIP-05's `_` name (both wait for the operator's key), the 90-day trim of unrelated public kinds (only registered keys can write, so none arrive yet), and the Ansible playbook.
