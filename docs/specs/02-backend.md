# Backend engineer: operator VPS, relay, blob store, audio service

Role: backend engineer. Owns everything that runs on the operator's machines. Codes against `00-contract.md` version 1.0 and the sequence in `01-project-plan.md`. Version 1.0, September 2026.

> **Revision note (contract v1.1).** This specification was written against contract v1.0. Contract v1.1 (document 00) takes precedence wherever they differ; apply its section 11 changelog, in particular the move to NIP-78 kind 30078, default public mirrors, AUTH only for reading gift wraps, the 16 KB event ceiling, and the extension device key with inbox blobs. References here to kinds 30979, 979, 978 or 10013 should be read in that light.

## 1. Goal and scope

The backend exists so that a phone can publish encrypted saves somewhere durable, store encrypted article bodies, and ask for spoken audio of an article without the operator learning what the article is. Everything the backend holds must be either ciphertext the operator cannot read, or a cache that can be thrown away without the user losing anything except server-generated audio. The project plan's definition of done includes turning the server off for an hour with no loss of app function beyond audio generation; that sentence shapes every decision below.

In scope: one VPS running strfry with a NIP-42 policy and a write-policy plugin, a Blossom-compatible blob store with per-pubkey quotas, the HTTP API from contract section 5, the Kokoro-82M worker with its queue and audio cache, TLS and the reverse proxy, backups, monitoring, log policy, abuse controls, a relay retention script, and a staging environment for the project engineer's contract tests. Out of scope: fetching third-party URLs (the server never fetches anything, so SSRF does not arise), parsing article HTML, plaintext storage beyond the lifetime of a TTS job, and the v2 NIP-05 name registry.

## 2. Architecture

One Debian 12 host, one public IP, three hostnames terminating at one Caddy instance. Behind Caddy sit three processes: strfry, a single Go binary called `keflid` that provides the HTTP API, the Blossom endpoints, the job queue, the audio cache and NIP-05, and a Kokoro-FastAPI container reachable only on localhost. A single SQLite database owned by `keflid` holds accounts, quotas, blob ownership, audio cache metadata and the job table; the strfry write-policy plugin opens the same database read-only to consult the allowlist.

```
                     Internet
                        |
                 +------+------+   :443 TLS, HTTP/2, rate limits per IP
                 |    Caddy    |   relay.<d>  api.<d>  blossom.<d>
                 +--+---+---+--+
                    |   |   |
       ws /  ------+    |   +------ /upload, /<sha256>, /list, /.well-known
       +---------+      |                 |
       | strfry  |      |          +------+------+
       | LMDB    |      +--------> |   keflid    |  Go, one binary
       +----+----+  /register     |  API + Blossom + queue + cache + NIP-05
            |       /audio        +--+-------+---+
            | stdin/stdout          |       |   \
     +------+--------+          SQLite    blobs/   audio/  (local disk)
     | write-policy  | ro         |
     | plugin (Go)   +------------+
     +---------------+              |
                                    | HTTP localhost:8880
                             +------+--------+
                             | Kokoro-FastAPI |  Docker, CPU image
                             | kokoro-82m     |  /dev/captioned_speech
                             +----------------+
```

One binary for the API-side pieces is deliberate: quota, accounts, blob ownership and the audio cache are all touched by `DELETE /account`, and one process with one database makes that a single transaction. The relay stays separate because strfry already implements the two features the contract leans on: NIP-42 with per-kind read restriction, and an external write-policy plugin ([strfry.conf](https://raw.githubusercontent.com/hoytech/strfry/master/strfry.conf), [plugins.md](https://github.com/hoytech/strfry/blob/master/docs/plugins.md)).

## 3. Components

### 3.1 Relay: strfry

strfry is configured with `relay.auth.enabled = true`, `relay.auth.serviceUrl = "wss://relay.<domain>"`, `relay.auth.restrictedReadKinds = "30979,1059"` and `relay.auth.restrictReadToInvolvedPubkey = true`. A REQ that mentions either restricted kind is then refused with `auth-required:` until the client completes NIP-42, and once authenticated the filter must name the authed pubkey in `authors` or `#p`, which strfry enforces itself. Clients must therefore include `"authors": [<own pubkey>]` on kind 30979 subscriptions and `"#p": [<own pubkey>]` on kind 1059 subscriptions.

`relay.maxWebsocketPayloadSize` defaults to 131,072 bytes ([strfry.conf](https://raw.githubusercontent.com/hoytech/strfry/master/strfry.conf)). A kind 1059 save request carries up to 512 KB of HTML inside a base64-encoded NIP-44 payload and can approach 750 KB, so the relay sets the frame limit to 1 MiB and the plugin applies per-kind ceilings below that. Negentropy stays enabled because it makes the retention export and the staging seed cheap.

The write-policy plugin is a small Go program launched via `relay.writePolicy.plugin`. strfry feeds it one JSON line per event with `event`, `receivedAt`, `sourceType`, `sourceInfo` and, when the connection has completed NIP-42, an `authed` field carrying the authenticated pubkey; the plugin answers with `id`, `action` (`accept`, `reject` or `shadowReject`) and an optional `msg` ([plugins.md](https://github.com/hoytech/strfry/blob/master/docs/plugins.md)). The rules: kind 30979 is accepted only when `authed` equals `event.pubkey` and that pubkey is in the `accounts` table, the event is under 64 KB, and the pubkey is under 120 events per hour. Kind 1059 has a throwaway author by construction of NIP-59, so the plugin instead requires `authed` to be present with any key (which forces the extension to AUTH with its ephemeral key and gives the limiter a handle), exactly one `p` tag naming a registered pubkey, size under 1 MiB, and under 60 wraps per recipient and 120 per source IP per hour; section 9 flags this reading of the contract. Kind 5 passes through, since strfry checks authorship itself. Every other kind is accepted under 64 KB at 300 per pubkey or IP per hour, and the restricted kinds are refused when `sourceType` is anything other than IP4 or IP6, so nothing syncs them in from another relay. The plugin opens the SQLite database read-only and refreshes the allowlist every five seconds, so `/register` takes effect on the relay within that window. It logs accept and reject counters per rule and nothing else.

### 3.2 Blob store: Blossom endpoints inside `keflid`

The obvious candidate is hzrd149/blossom-server, MIT licensed, implementing BUD-01, 02, 04, 05, 06, 08, 09 and 11 ([README](https://github.com/hzrd149/blossom-server)). Its configuration offers `upload.maxSize`, `upload.requirePubkeyInRule`, per-pubkey retention rules and a `list.enabled` switch, but no per-pubkey storage quota ([config.example.yml](https://github.com/hzrd149/blossom-server/blob/master/config.example.yml)). The contract makes the 200 MB quota a property of `/register`, and enforcing it from outside blossom-server would mean a preflight in the proxy on every upload and two databases to reconcile on deletion. The surface the app needs is small: `PUT /upload`, `HEAD /upload` (BUD-06 preflight), `GET` and `HEAD /<sha256>`, `DELETE /<sha256>`, and an owner-only `GET /list/<pubkey>`. That is a few hundred lines of Go over a directory of files, so `keflid` implements it directly, with blossom-server behind Caddy as the fallback if the implementation stalls in week 1.

Uploads require a kind 24242 authorisation event with `t = upload`, an `x` tag matching the body's sha256 and a future `expiration`, as BUD-02 specifies, from a registered pubkey. The server checks `bytes_used + content_length <= quota_bytes` and answers 413 `{ "error": "quota", "used", "quota" }` on overflow. Blobs are capped at 8 MB and accepted only as `application/octet-stream`, since the body is ciphertext; the ceiling stops the store being used for anything except article text. Files live at `blobs/<first two hex>/<sha256>` with ownership rows `(sha256, pubkey, size, created_at)`, many-to-one so deletion behaves. `GET /<sha256>` needs no authentication, matching Blossom's model: the address is 256 bits of hash and the content is AES-256-GCM ciphertext whose key lives only inside the user's kind 30979 event. There is no landing page or directory listing, `/list/<pubkey>` answers only to a `t = list` event from that pubkey, and `DELETE` with a `t = delete` event removes the caller's ownership row, unlinks the file when no owner remains, and decrements quota use.

### 3.3 HTTP API

`keflid` serves `api.<domain>`. Every request except NIP-05 carries NIP-98: an `Authorization: Nostr <base64 event>` header holding a kind 27235 event with `u` and `method` tags and, for bodies, a `payload` tag ([NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)). Validation: signature verifies; kind is 27235; `created_at` within 60 seconds of server time; `u` equals the full request URL as Caddy received it, scheme and host included; `method` matches; for POST and DELETE the `payload` tag equals the sha256 of the raw body (the empty body still hashes and the tag is still required); the event id has not been seen in the last 120 seconds. Failures answer 401 `{ "error": "auth", "reason": "<one word>" }`. Per-pubkey limits are 60 requests per minute overall, 6 per minute for `POST /audio` calls carrying `text`, 12 per minute for status polls, with 429 and `Retry-After` above them.

`POST /register` inserts the pubkey into `accounts` with `quota_bytes = 209715200` and returns 200 `{ "v": 1, "quota": 209715200, "used": 0 }` whether or not the row existed. Nothing beyond a valid signature is asked for in v1; abuse is handled by quota and by account disabling (section 5).

`POST /audio` takes `{ "v": 1, "text_hash", "voice", "model", "text"? }`. `voice` must be in the served list and `model` must equal `kokoro-82m-v1.0`, else 400. The lookup key is `(text_hash, voice, model)`. An existing `audio` row with its file present answers `ready` with URL, duration and timestamps URL and touches `last_access`. A job in `queued` or `running` answers `queued` with the current ETA whether or not `text` was sent, so a client racing itself never enqueues twice. Nothing found and no `text` answers `miss`. With `text`, the server hashes the exact bytes; mismatch is 400 `{ "error": "hash_mismatch" }`, and text over 120,000 characters (about 20,000 words, over two hours of audio) is 413 `{ "error": "too_long", "max_chars": 120000 }`, a contract addition flagged in section 9. Otherwise the plaintext goes to tmpfs at `/run/kefli/jobs/<job id>/text.md`, a job row is inserted, and the answer is `{ "status": "queued", "eta_seconds": N }` where N sums the estimated generation time of every job ahead plus this one, using the real-time factor measured over the last twenty jobs.

`GET /audio/status/<text_hash>/<voice>/<model>` answers the same three shapes plus `{ "status": "failed", "reason": "worker" | "lost" }` when generation failed twice or the plaintext was lost to a reboot; a client treats `failed` as `miss` and may resend. `GET /audio/<id>` streams `audio/ogg` with byte-range support so the phone can seek, requires NIP-98 from any registered pubkey, and refreshes `last_access`; `words.json` follows the same rules. Ids are 20 random bytes in unpadded base32, stored on the `audio` row and derivable no other way.

`DELETE /account` runs one transaction: delete every blob ownership row for the pubkey and unlink files with no remaining owner, delete the pubkey's `audio_request` rows and any audio requested only by it, drop its queued jobs and wipe their tmpfs directories, then delete the account row, which the relay plugin notices within five seconds. Events already on the relay are the user's own to remove with kind 5 from the phone, per contract 4.7. The answer is 200 `{ "v": 1, "deleted": { "blobs": n, "audio": m } }` and the call is idempotent. Word timestamps are covered in 3.4 and NIP-05 in 3.7.

### 3.4 TTS worker: Kokoro-FastAPI

The worker is remsky/Kokoro-FastAPI, Apache 2.0, running the CPU Docker image with the Apache 2.0 Kokoro-82M weights; the image includes espeak-ng (GPL-3.0) as a fallback phonemiser, which is fine server-side since nothing is redistributed ([Kokoro-FastAPI README](https://github.com/remsky/Kokoro-FastAPI)). Its `/dev/captioned_speech` endpoint returns audio with word-level start and end times, and it emits Opus directly, so no separate encoder is needed. The container binds to `127.0.0.1:8880` only. `keflid` runs one worker goroutine per allocated CPU worker (section 4); each pulls the oldest `queued` job, marks it `running` with a heartbeat, and drives the container.

Before text reaches Kokoro, `keflid` converts Markdown to speakable text with a deterministic pass that records, for every emitted token, its character offset in the original Markdown: headings lose their hashes, emphasis markers go, link text stays and the URL goes, images are dropped, code blocks become the phrase "code omitted", list markers become pauses, tables are read row by row. The flattened text is sent in paragraphs of at most 2,000 characters, each response's timestamps shifted by the running duration. Kokoro's words are aligned to the token array by a forward-only matcher that normalises case and punctuation and tolerates splits or merges within a window of three; when it loses sync it skips to the next paragraph boundary, where both sides are known to coincide, which is the re-anchoring the project plan calls for. The output is `[{ "w", "s", "e", "o" }, …]` with `o` the Markdown offset; unaligned words carry the last aligned offset so highlights never jump backwards. Chunks are concatenated into one Ogg Opus file at 48 kbps mono, 24 kHz.

Kokoro-FastAPI's README reports 35x to 100x real time on an RTX 4060 Ti and about 3.5 seconds to first token on an older i7; an independent benchmark on four EPYC 7763 cores measured a mean RTF of 0.47 (PyTorch) and 0.51 (ONNX), so one wall second yields about two seconds of audio ([heyneo benchmark](https://heyneo.com/blog/kokoro-tts-vs-supertonic-3-tts), [Kokoro-FastAPI README](https://github.com/remsky/Kokoro-FastAPI)). Section 4 sizes on RTF 0.5 per four dedicated cores and treats a GPU as the scaling step.

On completion `keflid` writes audio and timestamps to `audio/<id>/`, inserts the `audio` row and an `audio_request` row `(audio id, requesting pubkey)`, deletes the job and shreds the tmpfs directory. On failure it retries once after thirty seconds; a second failure marks the job `failed`, wipes tmpfs, and the status endpoint reports it for ten minutes. After a `keflid` restart, `running` jobs with a stale heartbeat return to `queued` when their tmpfs text survives (a process restart) and become `failed: lost` when it does not (a host reboot).

### 3.5 Queue and cache

The queue is the `jobs` table in SQLite, ordered by `created_at`, one row per `(text_hash, voice, model)`. There is no external broker; the largest planned size needs a few jobs per minute, and SQLite in WAL mode with workers polling every second handles that. Order is first come first served with one exception: a pubkey that already has a running job waits behind everyone else's first job, so one user's "Play all" cannot monopolise the workers.

The cache is the `audio` table plus files. An hourly sweeper removes rows whose `last_access` is older than 90 days, the contract's expiry, and also enforces a size ceiling (per tier in section 4) by evicting least-recently-accessed entries; the ceiling is flagged in section 9 because the contract names only the age. Entries are shared across users, which is the point of the fixture-locked Markdown conversion. The privacy consequence is that any registered user who knows a `text_hash` can fetch that audio; since the hash is of the full plaintext, knowing it means already having the text, so the sharing reveals only that someone generated it before.

### 3.6 Reverse proxy and TLS

Caddy 2 (Apache 2.0) terminates TLS for the three hostnames with automatic Let's Encrypt certificates, HTTP/2, TLS 1.2 minimum and one-year HSTS. It proxies `relay.<domain>` to strfry on `127.0.0.1:7777` with websocket upgrade, and `api.<domain>` and `blossom.<domain>` to `keflid` on a Unix socket with a 9 MB body limit on the upload path and 1 MB elsewhere. Per-IP limits in Caddy are coarse (300 API requests, 60 uploads and 200 new websocket connections per minute); the per-pubkey limits in `keflid` and the plugin are the fine ones. nftables allows 22 (key only, from a known IP list), 80 and 443 inbound and nothing else, and Docker runs with `iptables: false` so it cannot punch its own holes.

### 3.7 NIP-05

`GET /.well-known/nostr.json?name=<n>` is served by `keflid` on `api.<domain>` and, through a Caddy rewrite, on the apex. In v1 the only name is `_`, resolving to the operator's pubkey with the operator relay in `relays`, plus any names in a static YAML file, with `Access-Control-Allow-Origin: *` as the NIP requires. The `accounts` table carries a nullable `nip05_name` column so the v2 registry is a migration rather than a redesign; nothing writes it in v1.

### 3.8 Backups

Three things are backed up nightly: the strfry database via `strfry export` to gzipped JSONL, the `keflid` SQLite database via the online backup API, and the blob directory. They go to a Hetzner Storage Box over SFTP using restic (BSD-2-Clause), encrypted client-side with a key held on the VPS and in the operator's password manager, retained as 14 daily and 8 weekly snapshots. The audio cache is excluded because the phones can regenerate it. Each job pings a healthchecks endpoint; a missed ping alerts. Restore is rehearsed in weeks 2 and 5 by rebuilding staging from a production snapshot with the playbook and confirming a fixture pubkey can read its events and fetch its blob.

### 3.9 Monitoring

Prometheus, node_exporter and Alertmanager run on the host; `keflid` exposes `/metrics` on its Unix socket and a tiny exporter reads `strfry info`. Alerts go over ntfy and email for: disk above 80 per cent, cache above ceiling for an hour, queue depth above 50 or oldest job older than 20 minutes, stale worker heartbeat, TLS certificate under 14 days, missed backup ping, 5xx above 1 per cent over five minutes, and host unreachable from an Uptime Kuma instance on a different provider that probes NIP-11, the API health path and a Blossom HEAD every minute. The dashboard is one page: requests, queue, cache size, blob store size, disk.

## 4. VPS requirements and cost

Assumptions, stated so they can be corrected once real numbers arrive: a user saves 30 articles a month and keeps them; an encrypted text blob is 30 KB; a kind 30979 event is 1.5 KB and strfry keeps one per `d`; a save request wrap averages 200 KB and lives at most 30 days; 20 per cent of users listen on a given day, two articles each; an article averages 2,450 words, 16 minutes at 150 words per minute; 48 kbps Opus is 6 KB per second, 0.36 MB per minute, 5.9 MB per article (64 kbps works out at 0.48 MB per minute, and the sizing rounds to 0.5 MB per minute to stay conservative); 15 per cent of audio requests hit the cache, because read-later libraries overlap little; Kokoro on four dedicated cores runs at RTF 0.5, so 16 minutes of audio costs 8 minutes of four-core time.

| Quantity | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| Blob growth per month (30 saves × 30 KB) | 90 MB | 900 MB | 9 GB |
| Blob store after 12 months | 1.1 GB | 10.8 GB | 108 GB |
| Relay: 30979 events after 12 months (3,600 × 1.5 KB per user-year) | 5 MB | 54 MB | 540 MB |
| Relay: live 1059 wraps (30 saves × 200 KB, 30-day window) | 600 MB | 6 GB | 60 GB |
| Audio requests per day (20% × 2) | 40 | 400 | 4,000 |
| Audio generated per day after 15% hits | 34 articles, 9.1 h | 340 articles, 91 h | 3,400 articles, 907 h |
| Four-core CPU hours per day at RTF 0.5 | 4.5 h | 45 h | 453 h |
| Cache growth per day at 0.5 MB/min | 0.27 GB | 2.7 GB | 27 GB |
| Cache at 90 days, uncapped | 25 GB | 245 GB | 2.4 TB |
| Cache ceiling set | 30 GB | 200 GB | 1 TB |

Two conclusions fall out. Live gift wraps dominate relay storage, which is why section 6 deletes them at 30 days and why the extension should keep captured HTML small. And CPU synthesis stops fitting at around a thousand users: 45 four-core hours a day means two four-core boxes running flat out, ten thousand users would need fifty, whereas one mid-range GPU at RTF 0.02 covers 907 audio hours in about 18 GPU hours. The scaling trigger is the queue: when daily generation hours exceed 60 per cent of available four-core hours for a week, the worker moves to a GPU host.

| Tier | Host | Spec | Storage | Monthly estimate |
|---|---|---|---|---|
| 100 users (launch) | Hetzner CCX23 | 4 dedicated vCPU, 16 GB, 160 GB NVMe | included disk; 100 GB volume for cache | about €25 + €6 volume + €4 Storage Box ≈ €35 |
| 1,000 users | Hetzner CCX33 for relay, API and blobs; second CCX33 as worker | 8 dedicated vCPU, 32 GB each | 500 GB volume for cache (€29) | about 2 × €48 + €29 + €4 ≈ €130 |
| 10,000 users | CCX33 for relay/API/blobs; Hetzner GEX44 GPU dedicated server for the worker | RTX 4000 SFF Ada, 20 GB VRAM | 1 TB volume plus a 500 GB box for blobs | about €48 + €185 + €57 + €12 ≈ €300 |

Prices are from September 2026 aggregator listings ([costgoat](https://costgoat.com/pricing/hetzner), [whtop CCX23](https://www.whtop.com/plans/hetzner.com/128291)); Hetzner adjusted prices in April and June 2026, so figures are rechecked at order time. Volumes are €0.0572 per GB per month. OVH's VPS Elite line and Netcup's RS series are the fallbacks if Hetzner declines the account; the playbook is provider-agnostic apart from the volume mount. Dedicated vCPUs are chosen from the start because Kokoro saturates whatever it is given and a shared plan would be throttled exactly when the queue is longest. The launch box runs at a 19 per cent duty cycle for a hundred users, so the first month's numbers come from a machine that is never the bottleneck. Other triggers: blob store above 70 per cent of its disk moves to a mounted volume; relay LMDB above 20 GB is investigated rather than scaled, since it means retention is failing; p95 above 300 ms on status polls, the hot path, splits `keflid` from the relay host.

## 5. Security and abuse

The server holds nothing that reads as an article: event content is NIP-44 ciphertext, blobs are AES-GCM ciphertext, and the only plaintext is the TTS job text, which lives on tmpfs for the duration of the job and is overwritten with zeros before unlinking. Swap is disabled on the host so tmpfs pages cannot land on disk. The Kokoro container has no network route except the loopback and no volume mounts; text goes in over HTTP and audio comes back the same way.

Authentication is NIP-98 everywhere on the API, Blossom kind 24242 auth on the blob store, and NIP-42 on the relay, each validated with a freshness window and replay cache. The three per-pubkey rate limits (relay writes, API calls, uploads) and the two per-IP limits (Caddy, plugin) bound the cost a single key or address can impose. Quota bounds storage per key to 200 MB; the number of keys is unbounded in v1 because registration is free, so the defence against someone registering ten thousand keys to get 2 TB is a per-IP registration limit of 5 per day, a global alert when registrations exceed 200 in an hour, and an operator command `keflictl account disable <pubkey>` that removes a key from the allowlist and freezes its blobs without deleting them. Uploads are ciphertext only, 8 MB maximum, MIME fixed, and never served with a content type a browser would execute. Audio requests are the expensive operation, so a single pubkey may have at most three jobs queued, and text-bearing calls are capped at six per minute; a pubkey that submits text whose hash never matches three times in an hour is rate-limited for an hour.

Log policy: Caddy's access log is configured with a custom format that records timestamp, method, path with the first segment only, status, bytes and latency, and omits query strings, the `Authorization` header, request bodies and the referrer. `keflid` logs a 12-hex-character truncated hash of the pubkey rather than the pubkey, never logs `text_hash` at the level shipped in production, and never logs any request body. strfry's log is left at its default, which prints event ids and kinds and no content. Nothing in any log is a URL, a title, or a piece of text a user saved. Logs rotate at seven days. The SQLite database contains pubkeys, quotas, blob hashes, text hashes and audio ids; it never contains a URL.

Host hardening is the usual: unattended security upgrades, SSH keys only, a non-root service user per process, systemd sandboxing (`ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`) for `keflid` and strfry, Docker rootless for the worker, and nftables as described. The operator's key for NIP-05 and relay NIP-11 metadata is held offline; nothing on the server signs anything.

## 6. Data retention and deletion

Blobs live until their owner deletes them, through Blossom `DELETE` or `DELETE /account`. Relay events of the restricted kinds live until a kind 5 from the author or the retention script removes them. The retention script runs nightly: it deletes kind 1059 events older than 30 days (the phone deletes them within seconds of processing under normal conditions, so anything older is orphaned), deletes kind 30979 events whose author is no longer in `accounts` and has been absent for 30 days, keeps ephemeral and replaceable kinds per their NIP semantics, and trims public kinds (anything other than 30979, 1059, 5, 0, 3, 10002, 10013, 10003, 30003, 30023, 39701) to 90 days so the relay does not become a free archive for unrelated traffic. It is a `strfry delete --filter` invocation wrapped in a script that logs counts only. Audio cache entries expire at 90 days without access or earlier under the size ceiling. Job plaintext is deleted at job completion, at second failure, or by the ten-minute sweep for any tmpfs directory with no job row. Backups follow their 14-daily, 8-weekly retention, which means a deleted account's blobs can persist in encrypted backups for up to eight weeks; the app's deletion dialog already says copies may persist, and the privacy policy the project engineer writes for the stores should say so explicitly.

`DELETE /account` is described in 3.3. The one thing it cannot do is delete the user's events from the relay, because those are the user's signed data and the contract has the phone publish kind 5 for them; the retention rule for de-registered authors closes the gap after 30 days for users whose phone never got the chance.

## 7. Testing at each stage

Unit tests in `keflid` cover NIP-98 validation with the shared fixture request and a set of deliberately wrong ones (stale, wrong method, wrong URL, bad payload hash, replayed id), Blossom auth events, the quota arithmetic, the Markdown-to-speech tokeniser against the twenty fixture articles with recorded offsets, the alignment matcher against synthetic Kokoro outputs with splits and merges, the plugin's rule table with recorded strfry input lines, and the sweeper. The plugin has a golden test that pipes fifty JSON lines through it and diffs the output.

Contract tests are the project engineer's, run against staging before each gate; the backend supplies a `make contract-seed` that registers three fixture pubkeys with known keys and a `make contract-reset` that empties staging.

| Test | Expected | Stage |
|---|---|---|
| Publish kind 30979 from registered, authed pubkey | OK | 1 |
| Publish kind 30979 without AUTH | rejected `auth-required:` | 1 |
| Publish kind 30979 from unregistered pubkey | rejected `blocked:` | 1 |
| REQ kind 30979 without AUTH | `CLOSED auth-required:` | 1 |
| REQ kind 30979 authed, own authors filter | events returned | 1 |
| REQ kind 30979 authed, another pubkey in authors | `CLOSED restricted:` | 1 |
| Blossom upload 30 KB with valid 24242 | 200, descriptor | 1 |
| Blossom upload exceeding quota | 413 quota | 1 |
| Blossom upload from unregistered pubkey | 401 | 1 |
| GET /list/<other pubkey> | 401 | 1 |
| DELETE /account then upload | 401 | 1 |
| Gift wrap 1059 to registered p, authed ephemeral key | OK, phone REQ sees it | 2 |
| Gift wrap 1059 to unregistered p | rejected | 2 |
| Gift wrap over 1 MiB | rejected | 2 |
| POST /audio hash only, unknown | `miss` | 2 |
| POST /audio with text, hash mismatch | 400 | 2 |
| POST /audio with fixture text | `queued`, then `ready` within eta × 2 | 2 |
| words.json offsets fall inside the fixture Markdown, monotonic | pass | 2 |
| Second pubkey requests same hash | `ready` immediately | 2 |
| GET /audio/<id> without NIP-98 | 401 | 2 |
| NIP-05 `_` | operator pubkey | 1 |

Load test in week 5 with k6 against staging scaled to the launch spec: 200 simulated pubkeys publishing, uploading and polling status at ten times the assumed rate for thirty minutes, with twenty concurrent audio jobs of fixture articles; pass criteria are p95 API latency under 300 ms, zero 5xx, queue draining at the predicted RTF within 20 per cent, and memory flat.

Failure drills, each rehearsed on staging and written up as a runbook page. Relay down: stop strfry for ten minutes while a phone is in use; the app must keep reading its local cache and queue publishes, Uptime Kuma must alert within two minutes, and on restart the queued publishes must land. Disk full: fill the cache volume with a fallocate file; uploads must answer 507 rather than corrupt, the sweeper must free space to the ceiling within a minute, the alert must fire, and the relay on the root disk must be unaffected because the cache lives on its own volume. Worker crash: kill the Kokoro container mid-job; the job must return to queued, the heartbeat alert must fire, the container must be restarted by Docker's policy, and the job must complete on the second attempt with the plaintext still present in tmpfs. Host reboot: jobs report `failed: lost`, and a client resends text on the next play. Restore from backup: covered in 3.8.

## 8. Timeline against the master plan

| Week | Deliverables | Gate served |
|---|---|---|
| 0 | Ansible playbook skeleton, domain and DNS, provider account, staging box up with Caddy and TLS, read the contract and file the section 9 objections | Stage 0 exit |
| 1 | strfry with NIP-42 policy and plugin allowlist, `keflid` with `/register`, Blossom endpoints with quota, SQLite schema and migrations, NIP-05, Caddy routing, nftables, unit tests for auth; Android publishes first 30979 against staging | Stage 1 |
| 2 | Retention script, restic backups with rehearsed restore, Prometheus and alerts, Uptime Kuma, `DELETE /account`, contract-seed and reset targets, production box provisioned from the same playbook; project engineer runs stage-1 contract rows | Stage 1 exit |
| 3 | Kokoro-FastAPI container, job queue, tmpfs plaintext handling, Markdown tokeniser with offsets, alignment matcher, `/audio` miss/queue/ready, status endpoint; extension's 1059 wraps accepted on staging | Stage 2 |
| 4 | Cache sweeper with age and ceiling, byte-range serving, per-pubkey job caps, ETA model, `failed` states, worker crash drill, all stage-2 contract rows green on staging; Android CachedVoice integrates | Stage 2 exit |
| 5 | Load test, disk-full and relay-down drills, runbooks, log format audit, production cutover with iOS integrating against production-identical staging | Stage 3 |
| 6–7 | Beta support: daily check of alerts and queue, severity-1 fixes only, second restore rehearsal, cost report with real per-user numbers against section 4 | Stage 4 |
| 7–8 | Freeze, store privacy answers for the project engineer (what the server stores, for how long), on-call for launch | Stage 5 |

## 9. Integration points and what is needed from others

From the project engineer, by the end of week 0: the twenty fixture articles with their Markdown and `text_hash`, the three fixture kind 30979 events with keys, the fixture NIP-98 request, and rulings on the five contract points below. From the Android engineer, by week 1: a REQ for kind 30979 that includes `authors: [own]` and the NIP-42 handshake before the REQ, and confirmation that the app treats `CLOSED auth-required:` as a prompt to authenticate rather than an error; by week 3, tolerance of `queued` responses to text-bearing calls and of the `failed` status. From the extension engineer, by week 3: NIP-42 AUTH with the wrap's ephemeral key before sending kind 1059, and a hard cap on captured HTML, ideally well under the contract's 512 KB, because the relay carries it in a single frame. From the iOS engineer, by week 4: nothing new, since iOS follows Android, but a heads-up if `URLSession` range requests or NIP-98 URL canonicalisation (trailing slashes, percent-encoding) differ from Android, since `u` must match byte for byte.

Contract points raised for the project engineer's ruling: (1) "writes of kind 1059 only from authenticated pubkeys" cannot mean the author's pubkey, because NIP-59 wraps use a throwaway key; the backend reads it as "authenticated connection plus registered recipient", and the extension must AUTH. (2) `eta_seconds: 40` in the example is unreachable on CPU for a typical article, which takes eight minutes on four cores; clients should display the real ETA and the contract example should change. (3) A 413 `too_long` error and a `failed` status are added to the audio API. (4) The cache is capped by size as well as by the 90-day age rule. (5) A REQ for the restricted kinds must name the caller in `authors` or `#p`, which follows from strfry's `restrictReadToInvolvedPubkey` and should be written into contract section 3 so every client does it. Two smaller notes: the 512 KB HTML ceiling on wraps forces the relay frame limit to 1 MiB, and `GET /audio/<id>` is readable by any registered pubkey, which the contract implies but does not state.

## 10. Risks

Kokoro CPU throughput is the largest. If the real RTF on Hetzner's EPYC-based dedicated vCPUs is worse than 0.5, the launch box still copes with a hundred users, but the thousand-user step moves to a GPU earlier and costs more; the mitigation is measuring RTF in week 3 and revising section 4 before beta. Timestamp alignment on articles with heavy Markdown (tables, code, nested lists) may drift; the tokeniser and matcher are unit-tested against all twenty fixtures and paragraph re-anchoring bounds the damage, and the system voice remains the reference implementation as the plan says. Implementing Blossom in-house risks a subtle BUD incompatibility with third-party clients the user may point at the server later; the tests use the reference `blossom-client-sdk` behaviour recorded as fixtures, and blossom-server stays available as a drop-in behind Caddy if a compatibility problem appears. Gift-wrap volume on the relay could surprise if the extension does not cap HTML. SQLite as the single store is a ceiling somewhere above ten thousand users; the schema is plain enough to move to Postgres, and the trigger is write contention showing up as `SQLITE_BUSY` in metrics. A provider rejecting a nostr relay on its terms is possible; the playbook targets any Debian host and the DNS TTL is kept at five minutes. Finally, an operator-side compromise exposes pubkeys, hashes and ciphertext but no readable content, which is the property the whole design is built to preserve.

## 11. Definition of done

Production and staging are built from the same playbook with no manual steps; every contract test row in section 7 passes on staging and the same suite passes on production with fixture keys; the failure drills have been run and their runbooks written; backups restore on staging to a working service; monitoring alerts have each fired at least once in a drill; no log line on the host contains a URL, a title or article text, verified by a grep audit on a week of logs; the load test passes at ten times the launch rate; `DELETE /account` leaves no file, row or allowlist entry for the pubkey; the server can be stopped for an hour during beta with Richard's phone losing nothing but audio generation; and the cost report in week 7 shows the real per-user figures next to the assumptions in section 4.

## Appendix: FOSS components and licences

Debian 12 (DFSG-compliant mix, mostly GPL and BSD family); strfry, GPL-3.0; Go toolchain, BSD-3-Clause; modernc.org/sqlite, BSD-3-Clause; nbd-wtf/go-nostr, MIT; Caddy 2, Apache 2.0; Kokoro-FastAPI, Apache 2.0; Kokoro-82M weights, Apache 2.0; espeak-ng, GPL-3.0 (server-side only); PyTorch, BSD-3-Clause; Docker Engine, Apache 2.0; restic, BSD-2-Clause; Prometheus, node_exporter and Alertmanager, Apache 2.0; Uptime Kuma, MIT; ntfy, Apache 2.0 and GPL-2.0 dual; Ansible, GPL-3.0; nftables, GPL-2.0; k6, AGPL-3.0 (test tooling only, never deployed).

## 12. Build notes (October 2026)

The first build is in `server/api`, against contract v1.5 (sections 3.2, 5 and 6) rather than v1.0, and without server audio, which v1 doesn't have (flow decision 22): no Kokoro worker, queue or audio cache, and no `/audio` routes. It is three Go programs over one SQLite database, built and tested in Docker's `golang:1.26` image (`make -C server/api test build`), so the host needs only Docker; the binaries are static, since strfry's image is Alpine.

- **`keflid`** serves the API (contract 6: `defaults.json`, `/register`, `/devices`, both pairing offers, `DELETE /account`, NIP-05) and the Blossom store (contract 5) on two addresses, one per hostname behind Caddy. NIP-98 is checked as 3.3 says, including a replay cache of event ids. Blossom is in-house as 3.2 planned: uploads by a registered user or an authorised device key, both counted against the user's 200 MB with each blob once, a device's uploads kept as inbox blobs for 14 days, a blob kept until its last owner deletes it, served to anyone by hash with byte ranges, and nothing listed. Every answer carries CORS (extension spec 15). Limits: 60 calls a minute per key, offers 30 an hour per key and per address, new registrations 5 a day per address.
- **`kefli-writepolicy`** is strfry's write-policy plugin, with the rules of contract 3.2: a registered author writes, 60 events a minute; a kind 1059 from any key is taken when its one `p` tag names a registered user or an authorised device; a kind 5 from an unregistered key only when every event it names is a wrap of its own that the relay holds (the extension's Undo); kinds 30078 and 1059 at most 16 KB, strfry holding the rest to 64 KB. Two things strfry doesn't do itself are the plugin's: it keeps its own record of the wraps the relay holds, for the kind 5 rule, and when a user's kind 5 names wraps addressed to that user (the phone deleting what it has collected) it removes them with `strfry delete`, since NIP-09 alone deletes only the author's events. The allowlist is a snapshot refreshed every five seconds, as 3.1 planned, but a key the snapshot lacks is asked of the database before it is refused, so a user's first save straight after `/register` isn't turned away.
- **`keflictl`** registers, disables and re-enables keys (section 5).

A staging stack (`server/staging`, Docker Compose) runs strfry with the plugin and `keflid` on the dev stack's operator ports, so the phone, the extension and `server/dev`'s scripts reach it unchanged. `server/staging/contract.ts` is section 7's contract tests for v1: thirty checks covering registration, devices, allowlisted writes, the 16 KB ceiling, wraps to users and devices, AUTH-gated wrap reads, Undo, the recipient's deletion, Blossom uploads, inbox blobs, deletion and `DELETE /account`. All pass, and `server/dev/smoke.ts` saves end to end against it, mirror included. Go's coverage joins the code gate's report through `tools/go-lcov.mjs` (`npm run coverage`).

Production went live on 10 October 2026 on `kefli-1` (Hetzner Cloud, Debian 13), recorded in `server/deploy/README.md` and installed by `server/deploy/deploy.sh`: keflid as its own user under systemd, the real write policy in place of the stand-in, strfry's ceiling at 64 KB with the policy holding kinds 30078 and 1059 to 16 KB, Caddy in front of the API and the blob store with the log format of section 5, and the relay's nightly sweep (`relay-sweep`, section 6) with `keflictl gone <days>` listing the keys `DELETE /account` removed. The contract tests all pass against `https://api.kefli.app`. The production `defaults.json` comes from testing candidates against contract 3.1's four checks that day: relays primal, nos.lol and damus (damus last, since it refused some connections), indexers purplepag.es and user.kindpag.es, mirrors nostr.download, cdn.hzrd149.com and files.sovbit.host, the only public Blossom servers that took ciphertext uploads, BUD-04 mirroring and deletion. None of the mirrors publishes an operator or a retention policy. Every indexer tested refuses kind 5, so the contract's Delete my data step that sends one to the indexers can't confirm there; an empty, newer kind 10002 replaces the list instead.

Still to build for production: the Ansible playbook, nftables beyond the hand-set rules, restic backups to a Storage Box, monitoring and Uptime Kuma, NIP-11's operator pubkey and NIP-05's `_` name (both wait for the operator's key), Caddy's per-address limits (a plugin the packaged Caddy lacks), the 90-day trim of unrelated public kinds, and the website.
