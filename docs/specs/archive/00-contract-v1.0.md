# Shared contract: protocols, events, endpoints

Owner: project engineer. Every team codes against this document. Changes go through the project engineer and bump the version at the top of the file. Version 1.0, September 2026. Working name for the product: **Shelf** (placeholder until Richard names it; the name appears nowhere in the protocol).

## 1. Principles that the contract enforces

Saves are private by default and are readable only by the user's key. The phone is the only holder of the user's private key in v1; the extension and any future web client hold the public key only. The service must be replaceable: every event a user creates is standard nostr and lives on relays the user can list; if the operator's relay and server disappear, the app keeps working against another relay, losing only the audio cache. No nostr vocabulary reaches the ordinary user's screen; the single exception is the "Sign in with your nostr app" button.

## 2. Identity and keys

Key generation happens on the phone at first launch using secp256k1 (NIP-01), derived from a BIP-39 twelve-word mnemonic using the NIP-06 path so that the recovery code is standard. The mnemonic and the derived private key are stored in the platform keychain: iOS Keychain with `kSecAttrSynchronizable` set so it rides iCloud Keychain, and on Android in `EncryptedSharedPreferences` backed by the Android Keystore with `allowBackup` and the key blob included in Auto Backup. The recovery code is shown to the user only on request from the You tab, labelled "Recovery code", never "seed", "nsec" or "wallet".

Existing nostr users sign in by one of three signer providers behind a single interface `Signer { pubkey(); signEvent(unsigned); nip44Encrypt(pubkey, plaintext); nip44Decrypt(pubkey, ciphertext) }`. The providers are: local key (generated or pasted nsec, advanced path), NIP-55 Android signer intents (Amber and compatible), and NIP-46 remote signer over relay using `nostrconnect://` initiated by the app. A signer that cannot do NIP-44 encryption is rejected at sign-in with the message "This signer app can't encrypt your saves yet. Try Amber, nsec.app, or create a new account."

Device pairing (second phone) transfers the mnemonic inside a NIP-49 `ncryptsec` string encoded in a QR, encrypted with a six-digit code displayed on the source device. The QR alone is useless without the code, and the code alone is useless without the QR.

## 3. Relays

The operator relay is strfry, `wss://relay.<domain>`. It requires NIP-42 AUTH for any REQ that includes kinds 30979 or 1059, and accepts writes of those kinds only from authenticated pubkeys. All other kinds are accepted for reading and writing by anyone subject to rate limits, so the relay also works as an ordinary public relay for the user's existing events. The app writes every event to the operator relay and to the user's own write relays from their NIP-65 kind 10002 list if one exists. Private saves are additionally written to any relays in the user's NIP-37 kind 10013 private relay list if present. The app reads from the operator relay plus the user's read relays. New users have only the operator relay configured; an "advanced" section under You lets them add others.

## 4. Event kinds

### 4.1 Save item: kind 30979 (addressable, app-specific)

One event per saved URL per user. Tags: `["d", <sha256 hex of the normalised URL>]` and `["client", "shelf"]`. Nothing else in tags, so the relay learns neither URL nor title. The `content` field is NIP-44 v2 ciphertext, encrypted with the conversation key derived from the user's own key pair (self-encryption), of the JSON:

```
{
  "v": 1,
  "url": "https://example.com/article",
  "canonical": "https://example.com/article",
  "title": "…",
  "site": "example.com",
  "byline": "…",
  "saved_at": 1757000000,
  "state": "unread" | "archived",
  "progress": 0.0,
  "words": 2450,
  "lang": "en",
  "text": { "sha256": "<hex of ciphertext blob>", "key": "<base64 32-byte AES key>", "nonce": "<base64 12-byte>", "servers": ["https://blossom.<domain>"] },
  "text_hash": "<sha256 hex of the plaintext article markdown>",
  "hero": "https://example.com/img.jpg",
  "source_kind": "web" | "nostr-article" | "nostr-note",
  "source_ref": "<naddr or nevent when source_kind is nostr>",
  "audio_pref": null | { "voice": "af_heart", "model": "kokoro-82m-v1.0" }
}
```

State changes (archive, progress) republish the same `d` with a newer `created_at`; relays keep the latest. Deleting a save publishes a NIP-09 kind 5 deletion for the address and the client removes the Blossom blob.

### 4.2 Article text blob

The article body is stored as Markdown produced by Readability output converted with a deterministic HTML-to-Markdown pass (Turndown rules fixed in `shared/turndown-rules.json`). The plaintext is encrypted with AES-256-GCM using the per-item key and nonce from the item JSON, and uploaded to the user's Blossom servers with a kind 24242 Blossom auth event. The blob is addressed by the sha256 of the ciphertext. Images are never uploaded; the Markdown keeps their original URLs and clients cache them locally.

### 4.3 URL normalisation

`normalise(url)`: lowercase scheme and host; drop the fragment; remove `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`, `igshid`, `s` (on twitter/x hosts only) and `t` (on twitter/x hosts only) query parameters; sort the remaining query parameters; strip a trailing slash except on a bare host; map `m.` and `amp.` subdomains and `/amp/` path suffixes to the canonical form when the page supplied a `<link rel="canonical">`, otherwise leave them. The reference implementation is `shared/normalise.ts` with a fixture file `shared/normalise.fixtures.json` that every platform's port must pass.

### 4.4 Save request from a satellite: kind 1059 gift wrap carrying rumor kind 979

The browser extension (and any future satellite that does not hold the private key) sends saves as NIP-59 gift wraps to the user's pubkey. The rumor is kind 979 with content JSON `{ "v":1, "url", "canonical", "title", "site", "byline", "html": "<Readability content HTML, max 512 KB>", "captured_at" }`. The wrap uses a fresh random key per message. The phone subscribes to kind 1059 with `#p` = own pubkey on the operator relay, unwraps with NIP-44, runs the same Markdown conversion and creates the kind 30979 item exactly as if the share sheet had been used. After creating the item the phone publishes a kind 5 deletion for the wrap. If the same normalised URL already exists, the phone updates `saved_at` only if the item is archived (which un-archives it) and otherwise ignores the request.

### 4.5 Public recommendation (v2, defined now so nothing conflicts): kind 39701

A NIP-B0 web bookmark with `d` = URL without scheme, `title`, `published_at`, and `t` tags. Emitted only on an explicit "Recommend" gesture. Never emitted automatically.

### 4.6 Existing bookmarks import

On sign-in of an existing nostr user, read kind 10003 and any kind 30003 sets. Import `r` tag entries as web items (fetch and parse on the phone at import time, queued) and `a` tags pointing at kind 30023 as `nostr-article` items whose text is the article content itself. Ignore `e` tags. Show a one-time note: "Saves you make here stay private and only show in this app. Anything you Recommend later will appear in your other nostr apps."

### 4.7 Deletion of everything

"Delete my data" under You publishes NIP-09 deletions for every kind 30979 and 1059 the app created, calls `DELETE /account` on the operator server (removes Blossom blobs owned by the pubkey and audio cache entries requested by it), and wipes the keychain. The dialog states plainly that copies on relays the user added themselves may persist.

## 5. Operator server HTTP API

Base `https://api.<domain>`. Every request carries NIP-98 HTTP auth (kind 27235 event in the `Authorization: Nostr <base64>` header, with `u` and `method` tags, and a `payload` tag holding the sha256 of the body for POSTs). Rate limits are per pubkey.

`POST /register` — body `{}`. Creates the pubkey's allowlist entry on the relay write policy and the Blossom quota (default 200 MB). Idempotent.

`POST /audio` — body `{ "text_hash", "voice", "model", "text": "<plaintext markdown, only if the server reports a miss>" }`. First call with only `text_hash`, `voice`, `model`. Response `{ "status": "ready", "url": "https://api.<domain>/audio/<id>", "duration": 1234.5, "timestamps": "https://api.<domain>/audio/<id>/words.json" }` when cached, or `{ "status": "miss" }`. On a miss the client sends the same call with `text` included; the server verifies `sha256(text) == text_hash`, queues generation, and responds `{ "status": "queued", "eta_seconds": 40 }`. Clients poll `GET /audio/status/<text_hash>/<voice>/<model>` no more than every five seconds. The server discards the plaintext once audio and timestamps are produced. Access to `GET /audio/<id>` requires NIP-98 auth from a registered pubkey; the URL is unguessable and expires from the cache after 90 days without access.

`GET /audio/<id>/words.json` — `[{ "w": "word", "s": 0.00, "e": 0.32 }, …]` mapped to character offsets in the Markdown plaintext as `"o": <int>` so clients can highlight without re-tokenising.

`DELETE /account` — as described in 4.7.

`GET /.well-known/nostr.json?name=` — NIP-05 for users who choose a name in v2; present in v1 for the operator's own identity only.

## 6. Listening contract

Clients implement a `Voice` interface with two providers: `SystemVoice` (AVSpeechSynthesizer / android.speech.tts) and `CachedVoice` (server audio via section 5). Playback of an article uses whichever provider started it until the article ends. Word highlighting maps to character offsets in the Markdown plaintext for both providers. The Listen tab "Play all" continues through unread items in Library order; the in-article player stops at the end of the article and offers "Next".

## 7. Shared test fixtures

`shared/fixtures/` contains twenty saved HTML pages with expected Markdown output and expected `text_hash`, so all platforms produce the same hash for the same article; the `normalise` fixtures; three sample kind 30979 events with known keys and their decrypted JSON; one kind 1059 save request with its rumor; and a NIP-98 signed request example. A platform is not integrated until its test suite passes all shared fixtures.

## 8. Versioning

`v` in every JSON body. Clients ignore unknown fields and refuse to write a version they do not understand. Kind numbers never change; a breaking change to the JSON increments `v` and the client migrates on read.
