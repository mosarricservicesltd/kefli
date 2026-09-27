# Shared contract: protocols, events, endpoints

Owner: project engineer. Every team codes against this document. Changes go through the project engineer and bump the version at the top of the file. **Version 1.1, September 2026.** This version folds in every ruling on the engineers' v1.0 objections plus four fixes found in the post-pack review; the changelog in section 11 lists each change and which spec it affects. Working name for the product: **Shelf** (placeholder until Richard names it; the name appears in the protocol only as the `d`-tag namespace `shelf/`, which can be renamed before launch at no cost).

## 1. Principles the contract enforces

Saves are private by default and readable only by the user's key. The phone is the only holder of the user's private key in v1; the browser extension holds its own device key and the user's public key, never the user's private key. The library must survive the operator: by default every save and every text blob exists on at least one server the operator does not run, so a user who restores from their recovery code on a new phone gets their library back even if every operator machine is gone. The only function lost when the operator disappears is server-generated audio. No nostr vocabulary reaches the ordinary user's screen; the single exception is the "Sign in with your nostr app" button.

What the design does not hide, stated plainly so the privacy note can repeat it: relays see the user's public key, the number of saves, when each was made or changed, and a `t` tag showing the saves belong to this app. Nobody but the user can read which URLs they are. The operator's audio service sees the plaintext of an article while generating its audio, and a cached audio file is served to any registered user who saved the same article text.

## 2. Identity and keys

Key generation happens on the phone at first launch using secp256k1 (NIP-01), derived from a BIP-39 twelve-word mnemonic by the NIP-06 path so that the recovery code is standard and portable to other nostr apps.

Storage on iOS is the Keychain with `kSecAttrSynchronizable` set, so the key rides iCloud Keychain and returns on reinstall or on a new iPhone signed into the same Apple account. Storage on Android is a file under `noBackupFiles`, encrypted with AES-256-GCM under an Android Keystore key (StrongBox-backed where available), plus the mnemonic placed in Google Block Store so it restores on a new phone signed into the same Google account. `EncryptedSharedPreferences` is not used; the AndroidX security-crypto library is deprecated. The recovery code is shown only on request from the You tab, labelled "Recovery code", never "seed", "nsec" or "wallet". It is the route back for people who leave Apple or Google, or who never had account sync on.

Existing nostr users sign in through one interface:

```
Signer {
  pubkey()
  capabilities() -> { nip44: bool }
  signEvent(unsigned)
  nip44Encrypt(pubkey, plaintext)
  nip44Decrypt(pubkey, ciphertext)
}
```

Providers are: local key (generated, or a pasted nsec on an advanced path), NIP-55 Android signer intents (Amber and compatible), and NIP-46 remote signers via a `nostrconnect://` URI initiated by the app. The NIP-46 URI requests standing permissions up front so the user is asked once, not on every action: `perms=nip44_encrypt,nip44_decrypt,sign_event:30078,sign_event:5,sign_event:22242,sign_event:27235,sign_event:24242,sign_event:39701`. Every platform runs the same capability probe at sign-in: encrypt the fixed string `shelf-probe` to the signer's own pubkey, decrypt it, compare. A signer that fails is refused with the copy "This signer app can't encrypt your saves yet. Try Amber, nsec.app, or create a new account."

Second-phone pairing transfers the mnemonic inside a NIP-49 `ncryptsec` string in a QR, encrypted with a six-digit code shown on the source phone. The QR alone and the code alone are each useless.

## 3. Relays

### 3.1 The relay set every user writes to

A new user's app publishes a NIP-65 kind 10002 relay list on first save containing three write relays and three read relays: the operator relay `wss://relay.<domain>` and two independent public relays from the default list in `shared/defaults.json`. The same kind 10002 is also published to one indexer relay (`wss://purplepag.es` or its successor, listed in `defaults.json`) so that a restoring client can find it with nothing but the public key.

Every kind 30078 save and every kind 5 deletion goes to all write relays in the user's kind 10002. Users who already have a kind 10002 keep theirs; the app adds the operator relay and one default relay to it only with the user's agreement on the sign-in screen ("Also keep a copy on Shelf's relay and one backup relay?", default on).

The default list is chosen in week 1 by testing candidates (starting with `relay.damus.io`, `nos.lol`, `relay.primal.net`) against four checks: accepts kind 30078 from unknown authors, keeps addressable events indefinitely, accepts events of at least 16 KB, and has a published operator. `defaults.json` is fetched at app start from the operator with a baked-in fallback, so the list can change without an app release.

### 3.2 The operator relay

strfry. Writes are accepted when the event's author (`pubkey`) is on the registration allowlist; the signature proves authorship, so no NIP-42 AUTH is required to write. The one exception is kind 1059 gift wraps, whose author is a throwaway key: these are accepted from anyone when their `p` tag names a registered pubkey. All other kinds from unregistered authors are rejected. Reads of kind 30078 and other kinds are open, because the content is encrypted and the same events already sit on public relays.

Reads of kind 1059 require NIP-42 AUTH and are served only to the pubkey in the wrap's `p` tag, as NIP-17 recommends. AUTH is per connection: the relay issues a challenge on each connection and verifies that the AUTH event carries that challenge and a `created_at` within ten minutes. Clients keep one long-lived connection per relay while foregrounded and AUTH once per connection. Remote-signer users are not prompted each time because `sign_event:22242` is in the standing NIP-46 permissions in section 2.

Limits: `maxEventSize` 16,384 bytes for kinds 30078 and 1059, 64 KB otherwise; per-pubkey write rate 60 events per minute; a retention rule drops events from de-registered authors after 30 days.

### 3.3 Event size ceiling

No client ever publishes an event larger than 16 KB. strfry's default `maxEventSize` is 65,536 bytes and many public relays use it or less, and gift-wrapping multiplies a payload's size by roughly 1.8 through two layers of NIP-44 and base64. Article text and HTML therefore never travel inside events; they go to Blossom (section 5), and events carry only a hash and a key.

## 4. Event kinds

### 4.1 Save item: kind 30078 (NIP-78 app data)

One addressable event per saved URL per user. Tags, exactly:

```
["d", "shelf/item/<sha256 hex of the normalised URL>"]
["t", "shelf"]
```

The `t` tag lets clients fetch all of a user's saves with `{"kinds":[30078], "authors":[pk], "#t":["shelf"]}` without pulling other apps' NIP-78 data. The `content` is NIP-44 v2 ciphertext, self-encrypted (conversation key from the user's own key pair), of:

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
  "text": { "sha256": "<hex of ciphertext blob>", "key": "<base64 32 bytes>", "nonce": "<base64 12 bytes>",
            "servers": ["https://blossom.<domain>", "https://<default mirror>"] } | null,
  "text_hash": "<sha256 hex of normalised plaintext Markdown>" | null,
  "hero": "https://example.com/img.jpg",
  "source_kind": "web" | "nostr-article" | "nostr-note",
  "source_ref": "<naddr or nevent when source_kind is nostr>",
  "audio_pref": null | { "voice": "af_heart", "model": "kokoro-82m-v1.0" }
}
```

`text` and `text_hash` are null for a save whose page could not be parsed; the reader then opens the original URL. State changes republish the same `d` with a newer `created_at`. Deleting a save publishes a NIP-09 kind 5 with an `a` tag for the address to every write relay, and deletes the blob from every server listed in `text.servers`. Target size of the event: under 4 KB.

### 4.2 Article text blob

The body is Markdown produced by the canonical pipeline: `@mozilla/readability` 0.6.0 output converted by `turndown` 7.2.4 with the fixed rules in `shared/turndown-rules.json`. Both libraries are vendored under `shared/`; bumping either regenerates the fixture hashes and bumps this contract's version. The plaintext is encrypted with AES-256-GCM using the per-item key and nonce and uploaded to the operator Blossom server with a kind 24242 Blossom auth event, then mirrored with BUD-04 to one default public Blossom server from `defaults.json`. The user's kind 10063 server list (BUD-03) is published with both. Blobs are ciphertext, so public mirrors hold nothing readable. Images are never uploaded; the Markdown keeps original image URLs and clients cache images locally.

`text_hash` is the SHA-256 of a normalised form of the Markdown: Unicode NFC, CRLF to LF, trailing whitespace removed from every line, runs of three or more newlines collapsed to two, and exactly one trailing newline. It is the key for the audio cache.

Where the Readability runs: the extension on the live DOM; Android in a hidden WebView; iOS in Safari via the share extension's preprocessing script for Safari shares, and in a WKWebView on next foreground for URL-only shares (the extension's Swift port may parse first for the offline copy, and the item is re-parsed with Readability.js so its hash converges). A share-sheet save (HTML fetched by the phone) and an extension save (rendered DOM) of the same URL may legitimately produce different `text_hash` values; an audio cache miss in that case is expected.

`words` is the count of whitespace-separated tokens in the spoken-text projection: the Markdown with syntax characters removed and link targets dropped.

### 4.3 URL normalisation

`normalise(url)`: lowercase scheme and host; drop the fragment; remove `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`, `igshid`, and on twitter.com/x.com only `s` and `t`; sort the remaining query parameters; strip a trailing slash except on a bare host; map `m.` and `amp.` subdomains and `/amp/` path suffixes to the canonical form when the page supplied `<link rel="canonical">`, otherwise leave them. Reference implementation `shared/normalise.ts`; every port must pass `shared/normalise.fixtures.json`.

### 4.4 Browser extension: device key, inbox blob and sealed save

The extension generates its own device keypair at install. It never holds the user's private key.

Pairing: the extension shows a QR containing `{v:1, device_pubkey, relay: "wss://relay.<domain>", nonce, expires}` (five-minute expiry). The phone scans it, shows "Connect Chrome on this computer?", and on confirmation calls `POST /devices` (section 6) signed by the user's key, which authorises the device key to upload blobs against the user's quota. The phone then sends a NIP-59 gift wrap to the device pubkey whose rumor is kind 30078 with `["d","shelf/pair-ack"]` and content `{v:1, user_pubkey, write_relays, blossom_servers, token, nonce}`. The extension checks the nonce, stores the result, and shows "Connected". The phone lists the device under You → Connected browsers with Disconnect, which calls `DELETE /devices/<pubkey>` and revokes the token.

Save: the extension runs Readability on the page, encrypts the content HTML (capped at 2 MB) with a fresh AES-256-GCM key, uploads the ciphertext to the operator Blossom server authenticated by the device key (an inbox blob, auto-expiring after 14 days), and sends a gift wrap to the user's pubkey with a fresh random wrap key. The rumor is kind 30078 with `["d","shelf/save-request/<uuid>"]` and content:

```
{ "v": 1, "url", "canonical", "title", "site", "byline", "captured_at", "token",
  "html": { "sha256", "key", "nonce", "server" } | null, "truncated": bool }
```

`html` is null when capture failed; the phone then fetches and parses the URL itself. The wrap is published to the operator relay only and is under 8 KB. The phone subscribes to kind 1059 with `#p` = own pubkey (AUTH required), unwraps, rejects any request whose `token` is unknown or revoked, downloads and decrypts the HTML, runs the canonical Markdown conversion, and creates the kind 30078 item exactly as if the share sheet had been used. It then publishes a kind 5 deletion for the wrap. If the same normalised URL already exists, the phone un-archives it if archived and otherwise ignores the request.

Undo in the extension publishes a kind 5 for the wrap signed by the wrap key, valid because that key is the wrap's author. If the phone has already consumed the wrap, undo shows "Remove it from your phone's Saves" instead.

The phone acts on wraps within seconds while open. Suspended, Android drains the subscription on a periodic WorkManager job and on foreground; iOS drains on launch and on background refresh when granted. When no pair-ack-style receipt arrives within ten seconds, the extension toast says "Saved. It'll be on your phone next time you open the app."

Existing nostr users with a NIP-07 browser extension still pair this way in v1. Signing saves directly from the browser would duplicate the hash-critical Markdown step outside the phone.

### 4.5 Public recommendation (v2, reserved now): kind 39701

A NIP-B0 web bookmark with `d` = URL without scheme, `title`, `published_at` and `t` tags, emitted only on an explicit "Recommend" gesture and never automatically. Public recommendations are the only events any other nostr client will display.

### 4.6 Existing bookmarks import

On sign-in of an existing nostr user, read kind 10003 and kind 30003 sets. Import `r` tag entries as web items (fetched and parsed on the phone, two at a time) and `a` tags pointing at kind 30023 as `nostr-article` items whose text is the article content. Ignore `e` tags; most bookmark lists are mostly these. Show once: "Saves you make here stay private and only show in this app. Anything you Recommend later will appear in your other nostr apps."

### 4.7 Delete my data

"Delete my data" under You publishes NIP-09 deletions for every kind 30078 with `#t` = `shelf` and every consumed or pending wrap to every write relay, deletes every blob in `text.servers` on every listed server, calls `DELETE /account`, and then wipes the key from local storage and from iCloud Keychain or Block Store. The dialog says: "This removes your library from all your devices and from Shelf's servers. Copies on relays you added yourself may stay there, but only you could ever read them." Public relays may not honour kind 5; the ciphertext they keep is unreadable without the key the app has just destroyed.

## 5. Blossom servers

The operator Blossom server accepts uploads authenticated by a registered user pubkey or an authorised device pubkey (section 6), counts both against the user's quota (default 200 MB), lists nothing publicly, and supports BUD-04 mirroring out. Inbox blobs uploaded by device keys expire after 14 days. The default public mirror is chosen in week 1 against the same four checks as the default relays plus an upload-size limit of at least 5 MB. If no free public mirror proves reliable, the fallback is a second small Blossom instance on a different provider and domain, run by the operator; that is weaker than an independent mirror and the privacy note must say so.

## 6. Operator HTTP API

Base `https://api.<domain>`. Every request carries NIP-98 HTTP auth (kind 27235 in `Authorization: Nostr <base64>`, with `u` and `method` tags and a `payload` tag holding the SHA-256 of the body for requests with a body). Rate limits are per pubkey.

`POST /register` — body `{}`. Adds the pubkey to the relay allowlist and creates the Blossom quota. Idempotent.

`POST /devices` — body `{ "device_pubkey", "label" }`, signed by the user. Authorises a device key to upload blobs against the user's quota. `DELETE /devices/<device_pubkey>` revokes it and deletes its unexpired inbox blobs.

`POST /audio` — body `{ "v": 1, "text_hash", "voice", "model", "text"? }`. The first call omits `text`. Responses: `{"status":"ready","url","duration","timestamps"}` when cached; `{"status":"miss"}`; after a second call including `text` (the server verifies `sha256(normalise(text)) == text_hash`), `{"status":"queued","eta_seconds":<measured estimate>}`. Errors: 400 for an unknown voice or model, 413 `too_long` above 60,000 words, and a `{"status":"failed","reason"}` state when polling. Clients poll `GET /audio/status/<text_hash>/<voice>/<model>` no more than every five seconds. Plaintext sent for generation is held only on tmpfs and deleted within one hour of the job finishing or failing; it is never written to persistent storage.

`GET /audio/<id>` — readable by any registered pubkey with NIP-98 auth; byte-range capable. Cache entries expire after 90 days without access and are also evicted least-recently-used above a per-tier size ceiling.

`GET /audio/<id>/words.json` — `[{ "w": "word", "s": 0.00, "e": 0.32, "o": <character offset in the normalised Markdown> }, …]`.

`DELETE /account` — deletes the user's blobs on the operator server (and those of their devices), their audio requests, any cached audio requested only by them, their device authorisations and their allowlist entry. It cannot delete relay events; section 4.7 covers those.

`GET /.well-known/nostr.json?name=` — NIP-05 for the operator's own identity in v1; user names are v2.

`GET /defaults.json` — the default relays, indexer relay, and Blossom mirror list.

## 7. Listening contract

Clients implement `Voice` with two providers: `SystemVoice` (AVSpeechSynthesizer / `android.speech.tts`) and `CachedVoice` (section 6). An article's playback uses whichever provider started it until the article ends; a better file that arrives mid-article is used from the next play. Word highlighting maps to character offsets in the normalised Markdown for both providers, re-anchored at paragraph boundaries to limit drift. "Play all" in the Listen tab continues through unread items in Library order; the in-article player stops at the article's end and offers "Next".

## 8. Restore without the operator

A restoring client with only the recovery code must: derive the key; fetch kind 10002 from the indexer relay and the default relays; fetch kind 10063; request `{"kinds":[30078],"authors":[pk],"#t":["shelf"]}` from all read relays; take the newest event per `d`; and fetch text blobs from any server in each item's `text.servers` or the user's 10063 list. This path is a contract test run with the operator relay and Blossom server switched off.

## 9. Shared test fixtures

`shared/fixtures/` contains: twenty saved HTML pages, each with its Readability output HTML, expected Markdown, expected normalised `text_hash` and expected `words`; the normalise fixtures; three sample kind 30078 items with known keys and their decrypted JSON; one kind 1059 save request with its rumor, recipient secret and inbox blob; one pair-ack; a NIP-98 signed request; and a restore scenario with the operator absent. A platform is not integrated until its CI passes all of them.

## 10. Versioning

`v` in every JSON body. Clients ignore unknown fields and refuse to write a version they do not understand. Kind numbers and `d` namespaces never change after launch; a breaking change to a JSON body increments `v` and clients migrate on read.

## 11. Changelog: v1.0 → v1.1

Each engineer applies these to their spec. The four specs were written against v1.0 and are not otherwise rewritten.

1. **Private saves move from app-invented kind 30979 to NIP-78 kind 30078** with `d` = `shelf/item/<hash>` and a `t` tag `shelf`. Satellite rumors (kinds 979, 978) become kind 30078 rumors under `shelf/save-request/…` and `shelf/pair-ack`. *All specs.*
2. **Default mirrors so the library survives the operator.** New users publish kind 10002 with the operator relay plus two default public relays, to an indexer too; text blobs mirror to a default public Blossom server; kind 10063 is published; a no-operator restore test is added (section 8). *All specs; backend adds `/defaults.json`.*
3. **NIP-42 corrected.** The v1.0 ruling that let a relay accept an AUTH event up to an hour old was wrong: AUTH carries the relay's per-connection challenge and cannot be reused. Writes now need no AUTH at all (signatures prove authorship); only kind 1059 reads need it; bunker users grant `sign_event:22242` once. The private-relay list (kind 10013) and read restriction on saves are dropped because saves are ciphertext on public relays anyway. *Backend, Android, iOS.*
4. **Event size ceiling of 16 KB.** Extension HTML no longer rides inside gift wraps (up to 512 KB in v1.0, which most relays would reject); it goes to Blossom as an inbox blob uploaded with an authorised device key, and the wrap carries a hash and key. *Extension, backend (new `/devices` endpoints, device uploads, inbox expiry), Android, iOS.*
5. **Extension identity.** The extension has its own device keypair, authorised by the phone through `POST /devices`, replacing the v1.0 per-browser token-only design. The token stays inside the pair-ack and save request. *Extension, backend, Android, iOS.*
6. **Rulings on v1.0 objections, folded in:** Readability.js 0.6.0 and Turndown 7.2.4 vendored and canonical; `text_hash` over normalised Markdown; Android key storage via Keystore file plus Block Store; `Signer.capabilities()` and a fixed probe; audio API `eta_seconds` measured, 413 `too_long`, `failed` status, size-capped cache, registered-reader access, one-hour plaintext bound; `words` defined; deletion copy covers iCloud/Block Store propagation; the suspended-phone behaviour for extension saves and the toast copy; the image-URL privacy line.
7. **Honest privacy statements** added to section 1: metadata visible to relays, plaintext seen by the audio service, cached audio shared among users who saved the same text.
