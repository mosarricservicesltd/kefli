# Operator VPS

The production host, set up by hand on 10 October 2026 and recorded here until the Ansible playbook (backend spec section 8, week 0) replaces these notes. Every file in this directory is the copy that is live on the box.

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

`caddy/Caddyfile` goes to `/etc/caddy/Caddyfile`; run `sudo caddy validate --config /etc/caddy/Caddyfile` and then `sudo systemctl reload caddy`. Certificates come from Let's Encrypt and renew themselves.

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

The database lives in `/var/lib/strfry/db`, owned by the `strfry` system user. strfry listens on `127.0.0.1:7777` only, behind Caddy on `relay.kefli.app`.

`relay-write-policy` is a stand-in until `keflid` ships the real plugin. It accepts an event when its author is listed in `/etc/kefli/relay-allowlist` (one lowercase hex pubkey per line, read on every event), or when it is a kind 1059 whose one `p` tag names a listed key. Everything else is refused, so with the file empty the relay takes no writes. The contract's kind 5 exception for a wrap's own author (Undo in the extension) and the rate limits arrive with `keflid`.

## Not yet on the box

`keflid` (API and Blossom), the website, backups to a Storage Box, monitoring, and Caddy's trimmed access log.
