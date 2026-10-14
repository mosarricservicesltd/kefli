# Mobile app specification (Expo)

Owner: mobile engineer. Version 2.1, October 2026. Codes against contract v1.3 (`shared/contract/contract.md`) and follows the sequence in `docs/specs/01-project-plan.md` as amended by its scope revision. Supersedes `archive/03-android-v1.0.md` v1.0 (Kotlin and Compose, contract v1.0). Android comes first; iOS follows from the same codebase, and `04-ios.md` stays parked until then. Section 13.2 records the contract changes this spec asked for, all landed in v1.3, and section 14 the open items Richard decided on 5 October 2026 (FD 79–93).

## 0. Status, sources and precedence

### 0.1 Citation keys

| Key | Source |
|---|---|
| C§n | Contract v1.3, `shared/contract/contract.md`; never `docs/specs/00-contract.md`, a stale v1.1 copy |
| FD n | `docs/design/flow-decisions.md`, decision n |
| FM | Flow map rev. 3, `docs/design/flow-map-rev3.html` |
| `id` | A state of the signed-off prototype `docs/design/mockups/prototype.html`, by `data-jump` id (FD 75) |
| CS, MS | `docs/design/consistency-spec.md` (FD 45–54) and `docs/design/motion-spec.md` (FD 73) |
| TK, CV | `shared/tokens/tokens.json` (1.0.1, FD 92) and `shared/cover/README.md` |
| T§n | `docs/specs/07-android-test-build.md`, test n |
| P§n | `docs/specs/01-project-plan.md`, section n |
| CR n, O-n | Contract change request, landed in v1.3 (13.2), and open item, decided (14) |

### 0.2 Precedence

The contract, then flow decisions (later over earlier), then the prototype, then FM, then CS and MS, then this spec. Where FM and the prototype differ, the prototype's states and copy are built (FD 75). Contract v1.3 took in the places where a later flow decision or the prototype differed from contract wording (Play all in C§7, import in C§4.6, the deletion order in C§4.7, fixed copy; 13.2); a difference found from now on is a contract request, ruled before the feature's week. A state neither the prototype nor FM draws is built only once Richard approves it and it is on the map, as FD 91 did for the states this spec found (14).

### 0.3 Stale files and missing artefacts

MS still says draft although FD 73 signed it off. Files that C§3.1, §4.2, §4.3 and §9 name don't exist yet, so Stage 0's "fixtures exist" gate (P§3) is open:

| File | Writer | By |
|---|---|---|
| `shared/normalise.ts` and its fixtures | Mobile engineer drafts; project engineer owns. Written 6 October 2026; the choices the contract left open were settled in contract v1.4 (C§11.8) and are listed in the fixtures' `rulings` | End of week 0 |
| `shared/turndown-rules.json` (C§4.2) | Project engineer, from `shared/vendor/parser-runner.js`. Written 6 October 2026, its sha256 in `shared/vendor/VERSIONS.md` | End of week 0 |
| `shared/fixtures/` (C§9, covers included) | Project engineer; page fixtures from a pinned headless Chromium run of the vendored bundle, outside every client's CI, its version in `shared/vendor/VERSIONS.md` | Weeks 1–2 |
| `shared/defaults.json` (schema in C§3.1) | Backend engineer, after the week-1 relay and mirror tests (C§3.1, C§5) | Week 1 |

### 0.4 What changed from `archive/03-android-v1.0.md`

| Area | v1.0 | v2.0 |
|---|---|---|
| Stack | Kotlin, Compose, Room, WorkManager, rust-nostr | Expo SDK 57, TypeScript, expo-sqlite, nostr-tools, six local native modules |
| Protocol code | Kotlin modules | `packages/protocol`, shared with the extension and later iOS |
| Kinds | 30979, 979, 978 | 30078 under `kefli/` d tags (C§11.11; the namespace from C§11.7) |
| Listening | SystemVoice and CachedVoice | On-device voice in Kefli's own media session (FD 22, T§3) |
| Screens | Library, Material 3 | Fingerprint and the signed-off prototype (FD 65, FD 75) |

## 1. Goal and scope

The app is the reference client for what the contract leaves to a client: parsing and the canonical Markdown, self-encryption, Blossom upload with mirroring, the outbox, the save inbox, on-device voice and covers. Its code is the code iOS will run, so it must be legible as well as correct.

**In scope:** FM's seven journeys (first launch, returning to a library, saving from the phone and from the browser, reading, listening, You), with Search (FD 51), Speed read (FD 21), typed-code pairing (C§4.4), Keep backup copies (FD 76), moving saves (C§4.8), shared X posts (FD 78), covers (FD 65) and Export (`adv`).

**Out of scope:** server audio and `CachedVoice` (C§6.1, FD 22); "Open in app" and any public deep link (FD 9); Recommend (C§4.5); NIP-05 names (C§6); private relays (C§11.10); notifications (FD 15); seeking (FD 48); tags, folders, highlights, widgets, Wear, discovery; tablets beyond "doesn't break". Pasting an nsec isn't on the flow map and isn't built; v1.3 dropped it from C§2 (FD 90).

**Platform floor:** `minSdkVersion` 26, because word positions come from `onRangeStart` (T§2); compile and target SDK 36; portrait phones; arm64-v8a releases, plus x86_64 for the CI emulator.

**Stage gates** (P§3): stage 1, end of week 2: Richard saves from X and Chrome, reads offline, listens with the system voice, archives, and the events verify with `npm run decrypt` (13.1). Stage 2, end of week 4: a laptop save appears within ten seconds with the app open, a second phone pairs and shows the library, and the Play internal track is live. The plan's "server audio plays with highlighting" becomes an hour locked on battery (FD 87, 11.3).

## 2. Architecture and stack

### 2.1 Layers

```
UI         Expo Router screens; hosts for the player, toasts and sheets
Services   sync, outbox, inbox, jobs, player, connectivity and session stores
Protocol   packages/protocol: platform-free TypeScript
Ports      CryptoPort, KeyStorePort, ParserPort, VoicePort, SignerPort
Native     kefli-voice, kefli-parser, kefli-keystore, kefli-nip55, kefli-share, kefli-system
```

One JavaScript runtime serves MainActivity, the share surface and headless tasks, so services are singletons with no UI dependency. Screens reach native modules only through ports, each with an `.android.ts` implementation and an iOS stub: the seam for the later iOS build.

### 2.2 Repository

npm workspaces at the root: `apps/mobile`, `apps/extension`, `packages/protocol` and the generated `packages/tokens` (6.2). `packages/protocol` holds normalise, the item JSON, event builders, NIP-44 self-encryption, gift-wrap composition through `Signer`, NIP-98, blob crypto, the spoken projection, sentences, merge rules, the X link rule and the pair-code derivation. `shared/cover/cover-v1.js` and `shared/vendor/` are consumed unmodified. Native projects come from prebuild and are never edited (`apps/mobile/AGENTS.md`): native behaviour lives in `apps/mobile/plugins/` and `apps/mobile/modules/`, and `android/` is git-ignored.

### 2.3 Platform choices

- **Expo SDK 57.0.25, React Native 0.86.3, React 19.2.3, Hermes, New Architecture, held through launch.** The spike confirmed it (T Set-up); SDK 58 reworks the router core and moves past Gesture Handler 2.x.
- **No `expo-updates` in v1:** normalise, the item JSON, the spoken projection and `words` are hash- or count-critical JavaScript that an over-the-air update could change without a contract bump (C§4.2).
- **Development builds for UI work; release-profile builds for every locked, battery, background, timing and performance test** (T Set-up).

### 2.4 Libraries

Versions are the SDK 57 pins `npx expo install` resolves, unless stated.

| Area | Packages |
|---|---|
| Core | `expo` ~57.0.25, `react-native` 0.86.3, `react` 19.2.3, `typescript` ~6.0.3, `expo-dev-client` ~57.0.19, `expo-build-properties` ~57.0.22 |
| Navigation | `expo-router` ~57.0.23 (`/js-stack`, `/js-tabs`), `react-native-screens` ~4.26.0, `react-native-safe-area-context` ~5.7.0, `expo-linking`, `expo-constants` |
| Motion, drawing | `react-native-reanimated` 4.5.1, `react-native-worklets` 0.10.1, `react-native-gesture-handler` ~2.32.0, `@shopify/react-native-skia` 2.6.2, `react-native-svg` 15.15.4, `lucide-react-native` (pin at install) |
| Data | `expo-sqlite` ~57.0.3 (SQLite 3.50.3 with FTS5), `expo-file-system` ~57.0.7, `expo-image` ~57.0.5 |
| Platform | `expo-camera` ~57.0.5, `expo-background-task` ~57.0.20, `expo-task-manager`, `expo-haptics`, `expo-font`, `expo-splash-screen`, `expo-system-ui`, `expo-navigation-bar`, `expo-status-bar`, `expo-network`, `expo-keep-awake`, `expo-clipboard`, `react-native-keyboard-controller` 1.21.9, `react-native-webview` 13.16.1 |
| Crypto, protocol | `react-native-quick-crypto` 1.1.7 with `react-native-nitro-modules` 0.33.x and `react-native-quick-base64` 3.0.1; `nostr-tools` 2.25.2 exactly; `@noble/curves` 2.0.1, `@noble/hashes` 2.0.1, `@noble/ciphers` 2.1.1, `@scure/bip39` 2.0.1, `@scure/bip32` 2.0.1, `@scure/base` 2.0.0 (nostr-tools' exact pins, so npm dedupes); `whatwg-url` 17.2.0 with `tr46` 7.0.0 for normalise, which parses and serialises with them on every engine instead of the global `URL` (pinned 6 October 2026; `whatwg-url` brings `@exodus/bytes` 1.16, ESM only). The app entry calls quick-crypto's `install()` before anything imports nostr-tools, since noble's signing and NIP-44 nonces read `globalThis.crypto.getRandomValues`, which Hermes lacks |
| Markdown | `mdast-util-from-markdown` 2.1.0, `micromark` 4.0.3 |
| Vendored | Readability 0.6.0, Turndown 7.2.4, `cover-v1.js`, Nayuki `qrcodegen` (TypeScript, MIT) |
| Test, build | `jest` ~29.7, `jest-expo` ~57.0.5 (its `transformIgnorePatterns` extended to `@noble`, `@scure`, `nostr-tools`, `micromark*`, `mdast-util-*`, `unist-util-*`, `decode-named-character-reference` and `devlop`, which ship ESM only), `@react-native/jest-preset` 0.86.3, `@testing-library/react-native` 14.0.1, Maestro CLI 2.11.0, `eas-cli` 24.10.0 |

Not installed yet (14 October 2026): `expo-background-task` and `expo-task-manager`, since the worker in 4.8 isn't built, and `expo-system-ui`, `expo-navigation-bar` and `react-native-keyboard-controller`; each waits for Richard's approval, as any new dependency does.

Removed from the harness: `expo-speech` and `expo-audio` (two `TextToSpeech` instances would compete, and expo-audio's per-player media session captures headset buttons, expo/expo#50501), `expo-share-intent` (it delivers into MainActivity, so it can't return to the host app, FD 39) and `@noble/hashes` 2.4.0.

### 2.5 Main alternatives rejected

| Option | Reason |
|---|---|
| Native stack or tabs, standalone React Navigation | Android ignores custom curves; native tabs can't draw the active tile; the router forbids external `@react-navigation/*` imports |
| `expo-secure-store`, `expo-nip55`, rust-nostr | SharedPreferences rather than a `noBackupFiles` file (C§2); pinned to SDK 53 and logs plaintext; no React Native bindings |
| markdown-it, commonmark.js, a WebView reader; covers in SVG | No inline source offsets; no native highlight or TalkBack; a native view tree per leaf |

### 2.6 What runs where

Hash-critical steps are pinned to one engine, so the phone matches the extension's V8 and later iOS.

| Step | Engine |
|---|---|
| Charset decoding, DOM parsing, Readability, Turndown, NFC, Markdown normalisation | Blink, in the parser bundle (section 9) |
| `normalise` and so the `d` tag | Hermes; the whole URL is parsed and serialised by `whatwg-url`, whose host goes through UTS-46 and punycode by `tr46`, rather than the global `URL` (Expo's does no IDNA, and its path and query encoding is an older Standard's), so V8 and Hermes run the same code |
| `text_hash`, the spoken projection, `words`, sentences, Reader blocks | Hermes, from the normalised string; Hermes never NFC-normalises hashed text (the one exception is a non-ASCII host in `normalise`, which `tr46` NFC-normalises as UTS-46 requires; the normalise fixtures on Hermes guard it) |
| AES-256-GCM, scrypt, PBKDF2, SHA-256, random bytes | `react-native-quick-crypto` (OpenSSL) behind `CryptoPort`, and as `globalThis.crypto` for noble (2.4) |
| Schnorr, ECDH, NIP-44 | libsecp256k1 through `kefli-secp` (8), behind `packages/protocol`'s `SecpPort`: noble missed the week-0 timing gate on Hermes (`08-week0-gates.md`). NIP-44's ciphers and HKDF stay in noble |
| Speech, media session, key file, Block Store, signer intents, share activity | Kotlin modules (section 8) |

## 3. Identity, keys and signers

### 3.1 When a key exists

C§2 follows FD 2 and FD 6 (CR15): a key is made silently when the person taps New here (origin `new`) or shares before ever opening the app (`early_share`). `welcome.answered` is set by New here and whenever a restore or sign-in stores its identity. The share path reads Block Store first. When the entry holds a mnemonic, the share stores that key with origin `block_store`, sets `welcome.answered`, queues the restore job and saves under it, so the next open lands on Saves with the restore card (FD 79). Only a key the share minted itself is `early_share`, and it is written to Block Store only when the entry was read as empty.

The resolver at launch, in order: a database with no readable key file is wiped (7.1); an `early_share` identity with `welcome.answered` unset opens `welcome-early`, as does Back from a Read-now Reader before it is set (FD 6, FM journey 1); any other identity in the key file opens by the returning-open rule (5.1), with the restore card while a restore job runs; a mnemonic in Block Store is stored as `block_store` as above, and Saves opens with the restore card (FD 79, one branch in the resolver); otherwise Welcome. `POST /register` is queued the moment a key exists (C§6), so an offline first launch still lands on a working Saves.

### 3.2 The key file (`kefli-keystore`)

A Keystore AES-256-GCM key, alias `kefli.identity.v1`, StrongBox-backed where available and regenerated without it on `StrongBoxUnavailableException` (C§2), with no user-authentication or unlocked-device requirement, so signing works in the background and behind the lock screen. It encrypts `{v:1, identities:[{pubkey, provider, sk?, mnemonic?, nip55:{package}?, nip46:{client_sk, bunker_pubkey, relays, secret}?}]}`, stored as IV‖ciphertext‖tag in `noBackupFilesDir/kefli/identity.bin` and written atomically. `read()` returns records without their secrets (`sk`, the NIP-46 client key and the mnemonic): `readSecret(pubkey)` returns one identity's key, called only when its signer is built, and `readMnemonic()` its words; `write()` keeps the secrets of an identity written without them, for the same pubkey and provider. A lost key or an undecryptable file (no file or no Keystore key, a file too short, a bad tag, an invalidated key, unreadable JSON) counts as no identity (3.1). Any other Keystore failure fails the launch: `readKeyFile()` tries three times, half a second and a second apart, then throws, and the launch is tried again at the next need, so a Keystore that isn't ready yet wipes nothing and writes no key; the app opens on the database's identity row meanwhile (F21). Reading never makes a key, and `write()` throws rather than save while the existing file can't be read for now. Wiping the last identity deletes the file and the alias.

### 3.3 Block Store

Seen on the Pixel in week 1: an uninstall and reinstall keeps the entry, so the reinstalled app adopts the library (FD 79), but clearing the app's data removes it, which is Android's behaviour, so a clear-data test starts from Welcome. One entry, `kefli.mnemonic.v1`, holding the active local identity's mnemonic (C§2, with 3.1's early-share exception), written for device-to-device restore always and with `shouldBackupToCloud` only while `isEndToEndEncryptionAvailable()` is true, rechecked at each launch: with an identity, and without holding the launch up, the entry is written again, natively from the key file so the words never reach JavaScript, when it is empty, or when it holds this identity's words but the end-to-end state differs from the last write's, which settings keep as `blockstore.written`. It is never written over another key's entry or after a failed read, and during a move it is checked against the move's source (F22). A restore by code or pairing writes it when it stores the identity, and a nostr-app identity removes it, except during a move (the early-saves move included): there the entry keeps S until C§4.8 step 5, then takes T's mnemonic, or nothing when T is a nostr app (CR15).

### 3.4 Signers

```ts
// packages/protocol/src/signer.ts — the contract interface (C§2)
export interface Signer {
  pubkey(): string;                                   // hex, x-only
  capabilities(): Promise<{ nip44: boolean }>;
  signEvent(e: UnsignedEvent): Promise<NostrEvent>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
}
export interface SignerProvider extends Signer {       // Kefli's own, outside the contract
  kind: 'local' | 'nip55' | 'nip46';
  canActInBackground(): Promise<boolean>;             // gates inbox drains (4.7)
}
```

`LocalSigner` uses nostr-tools `finalizeEvent` and `nip44` v2 (random bytes from `globalThis.crypto`, 2.4), caches the self-encryption conversation key, and zeroes its secret after five minutes in the background, checked again on return in case the timer was held up; `SignerSlot` also zeroes a local key when it is replaced or dropped, at Sign out, Delete my data and the end of a move (F47). The native secp module still takes the key as a hex string for each signature and ECDH, which Hermes can't zero; keeping it out of JavaScript would need native signing that holds the key. `Nip55Signer` wraps `kefli-nip55` (8.4) and asks for the permissions C§2 lists for NIP-55, the NIP-46 kinds. `Nip46Signer` implements `SignerProvider` by composition, since `BunkerSigner`'s constructor is private: `BunkerSigner.fromBunker(clientSk, bp, { pool })`, then the public `sendRequest('connect', [bp.pubkey, bp.secret ?? '', perms])`, because 2.25.2's `connect` sends no permissions. Its pool is a dedicated `AbstractSimplePool` with Kefli's verifier and only the link's `wss://` relays, outside `RelayPool`'s backoff; its client key lives in the key file and it waits two minutes. Every event a NIP-55 or NIP-46 signer returns is checked against the template asked for (kind, time, tags, content and pubkey, then the id's hash and the signature, both strict lowercase hex) and refused otherwise (`signedAsAsked`, F46), and a bunker's own refusal counts as a signer failure, so what it was for waits (F14). Every provider passes the capability probe at sign-in and at move step 1 (C§2); a refusal is `nostr-probe` at sign-in and `sw-probe` in a switch (FD 91 (c), (d)). Every seal, self-encryption, unwrap and NIP-42 AUTH goes through `Signer`; the wrap layer uses a fresh key generated in `packages/protocol`, where seals and wraps are composed, since the nostr-tools helpers take raw keys.

NIP-46 is reached only by a pasted `bunker://` link, as the signed-off state draws (`nostr-none`); a link without a 64-hex pubkey and a `wss://` relay is a field error (`nostr-badlink`, FD 91 (b)). v1.3 dropped C§2's app-initiated `nostrconnect://` URI, whose QR no signed-off screen draws (CR2).

### 3.5 Recovery code

128 random bits, the BIP-39 English list, the seed by PBKDF2-SHA512 (2,048 rounds, empty passphrase) in `react-native-quick-crypto`, NIP-06 derivation at `m/44'/1237'/0'/0/0` with `@scure/bip32`, all pinned by fixtures (CR8). The mnemonic is in JavaScript only while deriving and while shown. `backup.state` stays `not_done` until "Show the words" is tapped (FD 27). The sheet keeps the words out of the accessibility tree until shown (MS Waiting); screen and clipboard rules are in 7.1.

### 3.6 Second-phone pairing

The interaction is fixed (C§2, FD 53, FD 25): the source shows a QR with six digits under it, fresh each time and expiring after five minutes, with the screen kept awake and `FLAG_SECURE` on; the target scans, stops the camera, takes the digits, checks the derived pubkey against the one carried in clear, stores the identity as `phone_pair` (Block Store per 3.3) and root-swaps to Saves with the restore card. The payload travels by C§2's online exchange (FD 85): HKDF-SHA256 over the QR's secret and the six digits gives a lookup and an AES-256-GCM key; the source posts `{v:1, mnemonic}` under that key with `POST /phone-offers`, and the target fetches it under `scan-connecting` with `GET /phone-offers/<lookup>`, signed by a throwaway key. A code that finds no offer is `scan-wrong`. The backend's endpoints are due in week 3 (13.1).

## 4. Data layer and sync

SQLite is the screen's source of truth and the relays are the account's: every gesture writes SQLite first and the network through the outbox, so no gesture waits on the network. Screens read through a typed repository with live queries (`addDatabaseChangeListener`); the player, toasts, sheets and connectivity are small `useSyncExternalStore` stores; one Reanimated shared value per article carries progress, so lists never re-render for it (MS Signature 2).

### 4.1 Schema v1

WAL, foreign keys on, hand-written migrations on `PRAGMA user_version`, each tested from every earlier version.

```sql
CREATE TABLE identities (pubkey TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('local','nip55','nip46')),
  role TEXT NOT NULL CHECK (role IN ('active','move_source','move_target')),
  origin TEXT NOT NULL,  -- new|early_share|block_store|recovery_code|phone_pair|nostr_signin
  has_recovery INTEGER NOT NULL, signer_package TEXT, registered_at INTEGER, created_at INTEGER NOT NULL);

CREATE TABLE items (id INTEGER PRIMARY KEY,  -- stable rowid for FTS (4.9)
  owner TEXT NOT NULL REFERENCES identities(pubkey),
  hash TEXT NOT NULL,                        -- sha256 of the normalised URL; d = 'kefli/item/'||hash
  v INTEGER NOT NULL DEFAULT 1, url TEXT NOT NULL, canonical TEXT, title TEXT, site TEXT, byline TEXT,
  saved_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('unread','archived')),
  progress REAL NOT NULL DEFAULT 0, words INTEGER, lang TEXT,
  text_sha256 TEXT, text_key TEXT, text_nonce TEXT, text_servers TEXT, text_hash TEXT, hero TEXT,
  source_kind TEXT NOT NULL DEFAULT 'web', source_ref TEXT, audio_pref TEXT,
  extra TEXT,                                -- unknown fields, re-emitted on rewrite
  event_id TEXT, event_created_at INTEGER, modified_at INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
  position_word INTEGER NOT NULL DEFAULT 0,
  text_state TEXT NOT NULL CHECK (text_state IN ('queued','fetching','cached','failed','remote','downloading')),
  fail_reason TEXT,  -- offline|http|not_html|not_readable|too_large|no_webview|x_no_article|blob_missing
  shared_url TEXT, x_state TEXT, origin TEXT NOT NULL, origin_device TEXT,
  blocks_ver INTEGER, last_opened_at INTEGER, pending_delete_at INTEGER, UNIQUE (owner, hash));
CREATE INDEX items_list ON items(owner, state, saved_at DESC) WHERE pending_delete_at IS NULL;
CREATE TABLE items_future (owner TEXT, d TEXT, event_json TEXT, created_at INTEGER, PRIMARY KEY (owner, d));
CREATE VIRTUAL TABLE items_fts USING fts5(title, site, url, body, content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2', prefix='2 3');

CREATE TABLE listen_history (item INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  last_played_at INTEGER NOT NULL);
CREATE TABLE cover_drawn (hash TEXT, surface TEXT CHECK (surface IN ('list','sheet','welcome')),
  drawn_at INTEGER, PRIMARY KEY (hash, surface));
CREATE TABLE images (url TEXT PRIMARY KEY, hash TEXT,
  path TEXT, bytes INTEGER, w INTEGER, h INTEGER, fetched_at INTEGER, last_used_at INTEGER);
CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, hash TEXT, kind TEXT CHECK (kind IN ('text','inbox')),
  staged_path TEXT, size INTEGER, owner TEXT, operator_at INTEGER, mirror_at INTEGER,
  mirror_url TEXT, last_error TEXT);

CREATE TABLE outbox (id INTEGER PRIMARY KEY, op TEXT NOT NULL, signer TEXT NOT NULL,
  subject TEXT NOT NULL, payload TEXT, depends_on INTEGER REFERENCES outbox(id) ON DELETE SET NULL,
  lane TEXT CHECK (lane IN ('interactive','bulk')), not_before INTEGER, created_at INTEGER NOT NULL,
  state TEXT CHECK (state IN ('held','queued','sending','dead')), was_queued INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX outbox_pending ON outbox(op, signer, subject) WHERE state IN ('held','queued');
CREATE TABLE outbox_targets (outbox_id INTEGER REFERENCES outbox(id) ON DELETE CASCADE, target TEXT,
  state TEXT CHECK (state IN ('pending','ok','rejected','gave_up')), attempts INTEGER,
  next_at INTEGER, last_error TEXT, event_id TEXT, PRIMARY KEY (outbox_id, target));

CREATE TABLE relays (url TEXT, owner TEXT, read INTEGER, write INTEGER,
  source TEXT CHECK (source IN ('operator','default','user','indexer')), added_by_app INTEGER,
  status TEXT, last_ok_at INTEGER, PRIMARY KEY (url, owner));
CREATE TABLE servers (url TEXT, owner TEXT, role TEXT CHECK (role IN ('operator','mirror','user')),
  in_10063 INTEGER, added_by_app INTEGER, status TEXT, PRIMARY KEY (url, owner));
CREATE TABLE lists (owner TEXT, kind INTEGER, d TEXT NOT NULL DEFAULT '', event_id TEXT, created_at INTEGER,
  raw TEXT, PRIMARY KEY (owner, kind, d));   -- latest 10002, 10063, 0, 10003; every 30003 set and 39701
CREATE TABLE sync_cursors (relay TEXT, stream TEXT CHECK (stream IN ('items','deletions','inbox','lists')),
  owner TEXT, since INTEGER, backfilled INTEGER, last_eose_at INTEGER, PRIMARY KEY (relay, stream, owner));
CREATE TABLE inbox_seen (wrap_id TEXT PRIMARY KEY, owner TEXT, seen_at INTEGER, request_d TEXT,
  device TEXT, hash TEXT, kind5 TEXT, wrap_json TEXT,  -- the rumor, kept only while failed_blob
  outcome TEXT);  -- created|merged|unarchived|ignored_token|ignored_foreign|ignored_version|failed_blob|failed_parse
CREATE TABLE devices (device_pubkey TEXT, owner TEXT, label TEXT, token TEXT, relay TEXT,
  connected_at INTEGER, revoked_at INTEGER, last_save_at INTEGER, PRIMARY KEY (device_pubkey, owner));
CREATE TABLE jobs (id TEXT PRIMARY KEY,
  kind TEXT CHECK (kind IN ('restore','move','import','delete_account')),
  state TEXT, step INTEGER, data TEXT, started_at INTEGER, updated_at INTEGER);
CREATE TABLE job_items (job_id TEXT, subject TEXT, state TEXT, PRIMARY KEY (job_id, subject));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Rows are keyed by owner and hash, so a move's S and T copies of one save sit side by side (C§4.8) while screens show only the active identity's rows; text, block and image files are per hash and go when no row holds the hash.

Settings keys: `welcome.answered` (3.1), `reader.size` (15–24, default 18, TK), `reader.palette`, `voice.id`, `voice.speed` (O-13), `voice.wps.<voice>` and `voice.wps.<voice>@<rate>` (FD 107), `speedread.wpm` (200–700, default 300, FD 21), `keep_backup_copies` (default on, FD 76), `backup.state`, `backup.snooze_until` (a save count, FD 17), `saves.added_count`, `nav.last_screen`, `nav.last_at` and `nav.tab_scroll` (FD 4, FD 74), the cached `defaults.json`, and `clock.offset.<host>`.

Files under `Paths.document/kefli/`: `text/<hash>.md`, `text/<hash>.blocks.json`, `img/<sha256 of image URL>` (app storage, because expo-image's cache can evict and C§4.2 needs images offline) and `staging/<sha256>.bin` (ciphertext until upload and mirror both succeed). The share spool is `filesDir/share-spool/`.

### 4.2 Item JSON and columns

| C§4.1 field | Rule |
|---|---|
| `v` | Written as 1 only. An event with `v` > 1 goes to `items_future`, hidden and never rewritten (C§10), but still deleted by 7.2 and checked by the move (4.10) |
| `url`, `canonical` | Final URL after redirects, replaced by its normalised form above 2,048 bytes, and refused as not a link if still above; canonical from the runner (section 9), dropped above 2,048 bytes |
| `title`, `site`, `byline`, `lang`, `hero` | From the parser; null when absent, never `""`; title cut at 512 bytes, byline at 256 and site at 128 on a character boundary; hero dropped above 2,048 bytes |
| `saved_at` | Unix seconds: the save's own time, the share time for a phone share and the request's `captured_at` (never later than now) for an extension save; a repeat save that un-archives an item sets it the same way (G2, CR10) |
| `progress` | Published as 0 when `words` is null or 0, otherwise `min(1, position_word / words)`; received as `position_word = round(progress × words)`, a missing or non-numeric value counting as 0 (FD 36, CR8) |
| `words` | Whitespace tokens of the spoken projection (C§4.2) |
| `text` | `servers` = `[operator, mirror]`, the mirror being the first entry of `defaults.mirrors[]` that accepts the BUD-04 mirror; on a permanent refusal the next is tried and the item republished naming it, so `servers` never lists the operator alone. A blob no mirror holds retries daily and counts as not backed up (FD 93) |
| `source_kind` | `web` only in v1, the other values reserved (C§4.1, FD 82) |
| `audio_pref`, unknown fields | Carried through unchanged; unknown fields live in `extra` (C§10) |
| Every event | `packages/protocol` refuses to sign anything over 16,384 bytes serialised (C§3.3) and warns above 4 KB for an item (C§4.1); the row goes `dead` (4.3). It covers items, kind 5 batches, pair-acks, 10002 and 10063. Unit tests push an item past the limit with a large `extra` and a 10002 with many relays, each expecting a refusal and a dead row; the URL cap is tested apart, with a 12 KB URL |

### 4.3 Outbox

| Operation | Event or call | Depends on |
|---|---|---|
| `register` | NIP-98 `POST /register` | — |
| `upload_blob` | Kind 24242 (`t=upload`, `x`, one-hour expiry), `PUT /upload` on the operator | `register` |
| `mirror_blob` | Its own 24242, `PUT /mirror` on the mirror (BUD-04) | `upload_blob` |
| `publish_item` | Kind 30078 to every write relay, built at send time with `created_at = max(now, event_created_at + 1)` | `upload_blob` if text |
| `publish_lists` | 10002 to the write relays and the indexer; 10063 and the connected-browsers record (C§4.9) to the write relays | `register` |
| `delete_item` | Kind 5, up to 50 `a` tags and `["k","30078"]` (plus `k` 10002 and 10063 where 7.2 deletes lists, NIP-09), to every write relay | — |
| `delete_blob` | 24242 `t=delete` on each server in `text.servers` and the mirror this phone's upload reached, whoever uploaded the blob; none while another save of the same owner names it (F33) | `delete_item` |
| `post_device`, `pair_ack` | NIP-98 `POST /devices` carrying the offer's proof, or in a move S's release, signed as the row is sent (C§6, v1.11); then a gift wrap to the device on the operator relay. A `post_device` queued by an older build without a proof is refused on the phone, and its `pair_ack` dies with it | `register`; `post_device` |
| `delete_device` | NIP-98 `DELETE /devices/<pk>` | — |
| `delete_wrap` | Kind 5 (`e`, `k` 1059) to the operator relay, best effort (CR4) | — |

One pending row exists per `(op, signer, subject)`: a new change merges into a `held` or `queued` row. A row is `sending` only while an attempt is in flight and `queued` between retries, so a change made during an attempt merges into it once that attempt ends, resetting its targets to pending (`publish_item` is rebuilt at send time). Rows from an Undo-able action (archive, Back to Unread, delete, and a share's upload, mirror and publish) are `held` until their toast or Saved sheet closes without Undo, then queued; such a change merging into a `queued` row turns it `held` with `was_queued` set, and any other change merging into a `held` row sets `was_queued` too, so Undo keeps it. Undo reverts the local row and deletes its held rows, except that a row with `was_queued` goes back to `queued` and, since `publish_item` is built at send time, sends the reverted state. Nothing has left the phone, so no compensating event is needed (FD 7, FD 38). Held rows left by a process death are queued at the next start, and a delete cut short (its Undo window never closed) is carried out then too, the files no row holds being removed (`commitOrphans`, F38). A save waiting on its delete's Undo isn't published: its `publish_item` waits 15 s at a time, longer than the toast's window, so a publish queued before the delete can't go out after its kind 5. `enqueue` refuses a row with no target, which would never send, back off or die.

Each target retries on its own from 30 s, doubling to an hour. While Kefli is in front, a timer wakes the outbox at the next due time (`outboxWaker`, set again after each drain, at least 1 s and at most an hour, so a longer wait is reached in steps); nothing is set in the background, and until 4.8's worker exists a closed Kefli retries nothing (F11). `invalid:` and `blocked:` reject the target and mark its relay in Advanced (except `blocked:` within 10 s of registering, since the allowlist refreshes every five seconds); `rate-limited:` and HTTP 429 wait 60 s; `auth-required:` AUTHs and retries; `duplicate:`, and a 404 to a delete, count as OK; a 413 to the operator's `upload_blob` is a full quota (G5), so the text stays on the phone and the upload retries daily; any other HTTP 4xx but 401 (4.6) rejects, except that a mirror answering any 4xx but 401 and 429, a 413 included, is refusing (C§4.2): `mirror_blob` moves to the next entry, and once every entry of `defaults.mirrors[]` has refused it waits a day and starts the list again, never going `dead` (4.2, FD 93). Only `delete_wrap` (best effort, after 24 hours) and Delete my data's first and second steps (7.2, a minute of retries each) give up (`gave_up`); every other target retries without limit. A row succeeds as soon as its target is `ok` or, for a relay publish or deletion, as soon as any relay's is: its dependents are released then while its other targets keep retrying, and the row is deleted once every target is `ok`, `rejected` or `gave_up`. A row whose targets have all finished without success goes `dead`, and so do the rows depending on it in the table above. Dead rows, the size check's included (4.2), stay for Advanced.

A save counts as saved once any write relay accepts it, and as backed up only once a relay the operator doesn't run has accepted its newest event and, for an item with text, a mirror that this event names in `text.servers` holds its blob (F18), so a change still queued, retrying or `dead` leaves it not backed up, and a retired default no longer counts (C§3.1); Advanced's not-backed-up count uses this one definition (C§1, FD 93). A token bucket keeps each pubkey under 50 events a minute per relay (C§3.2 allows 60), with the bulk lane (import, move, delete) yielding to the interactive one. A share's `publish_item` is created only once its parse succeeds or definitely fails, so the item stays local and can still be re-keyed (5.4). `publish_item` records in `text_servers` the servers it named, and a successful upload records the operator there while it is empty; when a mirror takes a blob, every published save whose `text_servers` doesn't name that mirror is republished naming it (F18). A save published before this rule, with `text_servers` empty, counts as it did.

### 4.4 Relay pool

Kefli's own `RelayPool` on nostr-tools `AbstractRelay`, for per-target retry state and AUTH through `Signer`, with an injected verifier. AUTH is per connection, and only when a relay refuses with `auth-required:`, a REQ's `CLOSED` or an event's `OK`; a challenge on connect asks nothing of the signer (C§3.2, F13). Each connection makes one AUTH, shared by every caller waiting on it, which ends on the relay's OK, the signer's failure, the socket closing or a 130 s backstop (the signer's two minutes and ten seconds); any failure closes and forgets the connection, so the next call starts afresh. Callers that arrive together share one connect. Reconnects back off from 1 s to 60 s; only `wss://` is accepted. Sockets are held in the foreground, during a voice session and during a background run.

### 4.5 Sync

Triggers: start, foreground, reconnection, a finished share, the end of a voice session and the background task. Each phase is restartable and idempotent.

1. **Prerequisites:** `defaults.json` (baked-in fallback, C§3.1); `register` if needed; the owner's 10002 and 10063 from the indexer and write relays (a newer 10063 adds the servers it names as `'user'`, removes a `'user'` server it no longer names and keeps Kefli's operator and mirror rows; from a newer list of either kind only what the held list didn't name joins, so one removed here stays removed, F37); then the library key (C§4.3, v1.10): the newest `kefli/library-key` record on the write relays is taken, a key not yet published giving way to it and the saves it addressed moving to their new addresses; with none on any relay once all have answered, a key is made. An identity made on this phone makes its key at its first publish, which sends the record first. A save's hash comes from its decrypted item, falling back to its unkeyed `d`, and `items.remote_d` keeps the address each save was last at, for deletions and for retiring an old address.
2. **Outbound:** the outbox.
3. **Items and deletions** from every read relay: `{"kinds":[30078],"authors":[pk],"#t":["kefli"],"since":cursor−86400,"limit":500}` and `{"kinds":[5],"authors":[pk],"#k":["30078"],"since":cursor−86400,"limit":500}`, each `a` checked to name `kefli/item/`. Each next page's `until` is the oldest `created_at` seen, inclusive and deduplicated by id, until a page brings nothing new, since relays may return fewer than the limit (NIP-01); completion is recorded per relay and stream in `sync_cursors.backfilled`, then the subscription stays live. Restore counts M the same way. A relay's cursors move only after every event collected in the run has been applied; a signer that doesn't answer (a timeout, a refusal out of sight, a decline) leaves every cursor where it was, and the events wait for the next sync, the signer asked once per run (F14). The day of overlap covers clocks up to a day apart (F36): an event whose id a row already holds isn't decrypted again, and a save whose deletion is still waiting in the outbox isn't inserted again.
4. **Inbox** (4.7).
5. **Text:** the item being opened first, then unread newest first, then archived; each server in `text.servers`, then the servers of the newest 10063 held, 60 s for the whole body, read as it streams with a 20 MB cap (a timeout counts as offline, an oversized body as that server not having the text, F12); check the sha256, decrypt, write `.md`, derive blocks, index FTS. Failure everywhere sets `blob_missing`, which shows "Couldn't get the text".
6. **Images:** an article's images are fetched when it opens, public web addresses only; on unmetered networks the sync also fetches again any missing for the newest 50 unread articles already opened (20 s and 5 MB each over the whole answer, a failure tried again a day later; 200 MB in all, evicting archived first, then the longest unused, the Reader marking an open article's images used), so an image site hears of an article only when it is read (7.3, F26).
7. **Pending parses**, one at a time; a page that times out waits for the next sync while the rest carry on, and three in a row wait as the network (F12).

Merge rules are a pure function in `packages/protocol` with property tests. Only a verified kind 30078 by an identity on the phone, with `d` = `kefli/item/<64 hex>` and `t` = `kefli`, is accepted, into that owner's rows, and a NIP-44 failure drops it; a signer failure leaves it, and every later event of the run, waiting (above). The connected-browsers record (`d` = `kefli/devices`) merges into `devices` by token, keeping every entry and the earlier `revoked_at` (C§4.9). With no local row it is inserted as `remote`; a clean row takes it if it is newer than `event_created_at` (ties to the lower id); a dirty row yields only if it is newer than `modified_at`, and otherwise republishes above it. A remote `progress` for the article open in the Reader waits until the Reader closes. A different `text.sha256` fetches the new text and, when the losing blob was this phone's upload and nothing references it, queues `delete_blob`. A kind 5 naming this `d` at or after the row's `created_at` removes the row, files, FTS entry, Listen history and images, unless the row was edited after it. `progress` is republished on leaving the Reader or Speed read, at the end of a voice session, and at most once a minute while reading.

### 4.6 Relay and server lists

- **Generated identity, first save:** 10002 = operator plus `defaults.relays[0..1]`, read and write, also to the indexer; 10063 = operator plus the default mirror (C§3.1, C§4.2).
- **Existing list, Keep backup copies on:** read their latest 10002, add the operator relay and `defaults.relays[0]` where not already listed, with `added_by_app = 1`, keep every other entry and marker, republish; the same for 10063 (CR12).
- **Switch off:** write only to their relays; blobs still go to the operator and mirror (C§4.2) and the inbox still uses the operator relay (C§4.4).
- **No list, or no answer:** a nostr user's 10002 or 10063 is absent only once every indexer relay in `defaults.indexer[]` and at least two of `defaults.relays` have sent EOSE without one (C§3.1); a copy on any relay wins, and an edit always starts from the newest copy seen, so a failed read never replaces the list their other apps share (FD 76). A confirmed absence gets the default set, whatever the switch says (C§3.1). Until the list or its absence is confirmed nothing is published and the read retries on the outbox's backoff, with relays still silent after a minute shown as not responding in Advanced (`adv-down`); meanwhile saves go to the operator relay and `defaults.relays[0]` with the switch on, and wait in the outbox with it off.
- **Retired defaults** (C§3.1, FD 93): an entry Kefli added (`added_by_app`, or any default of a generated identity) that `defaults.json` drops is replaced by the first entry of the same list that the user's lacks; the list is republished and the library copied over, every item to a new relay, or every blob to a new mirror with its item republished naming it.
- **Before publishing:** `publish_lists` reads the newest 10002 and 10063 first and takes them in as sync does (`takeNewerLists`), so a list another app published since the last sync isn't overwritten (F37).
- **Clock:** a 401 about `created_at`, or a failed AUTH, sets a per-host offset from the HTTP `Date` header and retries once.

### 4.7 Inbox

Subscribed on the operator relay only, after AUTH: `{"kinds":[1059],"#p":[pk],"since":cursor−172800−300}`, allowing for NIP-59's two-day timestamp tweak; `inbox_seen` dedupes every outcome but `failed_blob` (CR16).

1. **Unwrap:** `nip44Decrypt(wrap.pubkey)` gives the seal; verify it; `nip44Decrypt(seal.pubkey)` gives the rumor, whose pubkey must equal the seal's. Anything but kind 30078 with `d` = `kefli/save-request/…` is recorded `ignored_foreign`, since other apps' direct messages share the `p`; a request with `v` ≠ 1 is `ignored_version` (C§10), and one whose JSON can't be read is `failed_parse`, which is final.
2. **Accept** only a token from a connected entry of the connected-browsers record (C§4.9), held in `devices`, with a seal signed by that entry's `device_pubkey` (C§4.4); otherwise `ignored_token`. Ignored wraps are kept and never deleted, so a phone that hasn't yet received the record can't remove a save another phone still needs.
3. **Process:** an X URL takes the X rule (5.4) and its HTML is discarded. With `html`: fetch only from the known operator Blossom origin, check the sha256 with the download capped at 2 × 1,048,576 + 16 bytes (the extension's 2 MB plus the GCM tag) as it streams, with 60 s for the whole body, decrypt, check the HTML is within 2 MB, run `kefliMarkdown` and build the item as for a share, with a fresh text key and a new blob (C§4.4). A download or check that fails is `failed_blob`: the rumor stays in `wrap_json` and is retried from there at each drain, since the subscription no longer reaches it. With `html` null, or 14 days after `captured_at` when the inbox blob has expired: fetch and parse the URL (address rules in 7.1). An existing item is un-archived if archived, with `saved_at` set as in 4.2 (G2, CR10), else recorded `merged`.
4. **Close:** record `inbox_seen`; only `created`, `merged` and `unarchived` queue `delete_wrap`.

Background drains need `canActInBackground()`: always true for `LocalSigner`, true for NIP-55 when the resolver answers without the signer's interface, for decryption as well as encryption (the probe encrypts, then decrypts; approving `'nip44'` asks for both), and for NIP-46 with a live bunker.

### 4.8 Background execution

**Not built yet** (14 October 2026): `expo-background-task` and `expo-task-manager` aren't installed (2.4), so with Kefli closed nothing syncs, drains the inbox or retries a send, and Advanced's "Kefli keeps trying until a backup server accepts it" holds only while Kefli is open; while it is in front, a timer wakes the outbox when a row is due (4.3, F11). Richard is to approve the libraries or the line's rewording (FD 116). The design: no foreground service runs except playback, and the battery-optimisation exemption is never requested (FD 15; `archive/03-android-v1.0.md` §4.5). One `expo-background-task` worker runs at the 15-minute minimum with a nine-minute budget and calls the foreground's `syncOnce()`. If the share-then-lock test (11.3) loses publishes, `kefli-system` adds a one-off expedited WorkManager job firing the same task, on API 31 and later only, with `RUN_AS_NON_EXPEDITED_WORK_REQUEST`: below 31 expedited work runs as a foreground service with a notification (FD 15), so on API 26–30 the share waits for the periodic task or the next open. A laptop save made while the phone is closed arrives at the next of these runs or the next open (FD 84, C§4.4).

### 4.9 Search index

FTS5 over title, site, URL and the spoken projection, rowid = `items.id` (an explicit `INTEGER PRIMARY KEY`, so VACUUM can't renumber it), written when text is cached and removed with the item; prefix queries ranked by `bm25` across Unread and Archive (FD 51), run on every keystroke with stale results dropped by sequence number (MS Lists).

### 4.10 Long-running jobs

Each job is a `jobs` row checkpointed per item in `job_items` and resumed at start-up.

- **Restore** (C§8, its kind 5s included): the contract's steps, with deletions applied. "N of M" counts M as distinct live items after EOSE from every reachable relay (it can grow) and N as rows placed; it pauses offline (FD 40), and it isn't done while sync reports events waiting for the signer, so a restore whose saves wait for a nostr app doesn't finish at 0 of 0 (F14). Nothing found gives `code-notfound` for a recovery code, and otherwise first-run Saves without the card (`restore-nothing`, FD 91 (a)).
- **Move** (C§4.8's five steps): T's library is collected too, into T's own rows beside S's (4.1); phone-only items go straight to T, Listen history follows each item, read-back uses min(2, n) of T's write relays, and the Block Store entry switches at the end (3.3). Collecting either library waits while any of its events waits for a signer (F14). Each browser is paired once in a move (`MoveJob.since` tells which this move already paired), its `post_device` carrying S's release and its pair-ack sent on the operator relay (C§4.8 step 4, F19, F44). Each copied save keeps a mark of the S row it came from (`modified_at:event_id`); retiring S first carries to T's copy any change made under S since (state, `saved_at`, progress, `position_word`, `words`, `last_opened_at`, Listen history), queued as a publish under T, deletes under T a save S no longer holds or holds only for a delete's Undo, and names in S's kind 5s every delete S still owed, dated past it (F20). A save from a newer Kefli stops it (C§10, `sw-newer`, FD 91 (i)): S's local `items_future` rows are checked before step 1, and one met in step 2's collection, S's or T's, stops the move before step 3, leaving S and every save unchanged while T's registration and relay lists stay.
- **Import** (FD 82, C§4.6): the user's kind 39701 web bookmarks (`d` = the URL without scheme, imported as `https://<d>`) and any legacy `r` tags in their 10003 and every 30003 set become queued items, skipping saves already in the library, fetched two at a time on the bulk lane. Private entries in a list's `content`, and `e` and `a` tags, aren't imported.
- **Delete account:** 7.2, each step's result persisted, the key wiped only after the server steps succeed.

## 5. Features by journey

Every state is built from the prototype state named beside it, with its copy taken verbatim into the strings module (6.11); the prototype is also the reference for layout. The tables give what the build must do beyond the drawing. A state that FM lists but the prototype doesn't draw is marked FM; the states FD 91 added carry its jump names (0.2).

### 5.1 Navigation, entry points and Back

Entry points (FM navigation): a cold open, the share sheet (before the first open too), a returning open, the lock-screen card, and saves arriving from a browser.

- **Returning open** (FD 4): a cold start within 12 hours of leaving a Reader opens that Reader at the saved position; anything else opens Saves. A warm resume keeps what was on screen (G7).
- **Back pops one step to the opener** (FD 50, CS Scaffolding): Search → Reader → Back returns to Search with query, results and scroll. A cold start straight into a Reader, a lock-screen tap included, goes to Saves on Back (or to `welcome-early` while Welcome is unanswered, 3.1), as does Back on the Listen or You root (G7). The lit tab always matches the screen (FD 33).
- **States that can't be left** hide ← and swallow Back: `sw-moving`, `del-running`, and as drawn, `conn-busy` and `del-partial`.
- **Waits on another app:** ← does what Cancel does (CS Interaction).
- **Undo of a Reader action that navigated away** reopens the Reader at its position, or at Speed read's word. Archive and next replaces the Reader, so Back still reaches the opener (FD 54).
- **Internal links only:** `kefli://reader/<hash>?word=<n>` from the media session and Read now (FD 10); a hash not on the phone opens Saves.
- **Predictive back:** the system preview on root screens (the flag in 10), which needs React Native's always-enabled back callback switched off there: `KefliSystem.setRootBack(true)` at a root route with nothing open over it, false otherwise (8.6). In-app the pop plays on release, since the week-0 check found that neither React Native 0.86 nor the JS stack passes the gesture's progress to JavaScript (MS Navigation, `08-week0-gates.md`).

### 5.2 Journey 1: first launch

| State | Build notes |
|---|---|
| Welcome (`welcome`, FD 2, FD 23) | Three fanned covers draw in; no mini player |
| After an early share (`welcome-early`, FD 6) | The newest early save's cover in the note card; several use `welcome-early-many` (FD 91 (f)) |
| After Delete my data (FD 74) | Root swap; covers draw again; toast |
| Offline (FM) | Identical |
| New here (FD 2) | Makes the key unless an early share did (3.1); root swap to Saves, first-run when empty |
| First-run Saves (`saves-empty`, FD 5, FD 42, FD 69) | Scaffold loop; Connect your browser as primary, hidden once a browser is connected; offline `saves-empty-offline` (FD 91 (g)) |
| First save lands (`saves-first-arrive`) | Crossfade to the list; the row's cover draws |

The critical path is five taps, no inputs, one decision and no permissions (FM weight audit). A share before the first open makes the key at once; on first open New here keeps that key, and I already have a library runs the early-saves move (5.3).

### 5.3 Journey 2: returning to a library

**Bring back your library** (FD 5): three rows (`return`); offline, the notice and disabled rows (`return-offline`). The flows below can therefore only lose their connection part way, which shows the notice and keeps the entered value (G6).

| Scan from my other phone (FD 23, FD 40, FD 53) | Build notes |
|---|---|
| Before the camera (`scan-prime`); permission (`scan-prompt`) | The system dialog is requested only after the explanation (FD 11) |
| Camera starting (FM) | Dark frame, no spinner |
| Scanning (`scan-view`) | `CameraView`, QR only, one-shot guard, success haptic |
| QR read, type the code (`scan-code`) | Camera stopped before the keyboard rises |
| Wrong code (`scan-wrong`) | Field error, value kept and selected, reject haptic |
| Camera refused (`scan-refused`) | Primary goes to the recovery code; secondary opens Android settings |
| Expired (`scan-expired`); connecting (`scan-connecting`) | Notice-slot error; waiting block |

| Enter my recovery code (FD 23, FD 40) | Build notes |
|---|---|
| Empty, typing (`code-empty`) | Paste fills all twelve; up to three suggestions from the BIP-39 list in `packages/protocol` |
| Word not on the list (`code-wrong`) | Flagged at its field as typed |
| All twelve (`code-ready`) | Primary enabled; a checksum failure shows at the last field |
| Checking (`code-checking`) | Busy button; derives the key and runs the restore's first pass; the key is stored only once items are found, with Block Store per 3.3 (after an early share it keeps S until move step 5) |
| Nothing found (`code-notfound`) | No Kefli items after EOSE from every reachable relay; the derived key is discarded. Try again clears all twelve fields; Start fresh instead does what New here does, keeping an early-share key |

| Sign in with your nostr app (FD 5, FD 41, FD 76) | Build notes |
|---|---|
| Start (`nostr`) | Always the first step; Keep backup copies switch (4.6); primary opens the NIP-55 signer through Android's chooser; quiet link to the `bunker://` field |
| No signer installed (`nostr-none`) | Reached from the primary when `listSigners()` is empty, or from the quiet link; carries the switch's value; a malformed or unreachable link is a field error (`nostr-badlink`, FD 91 (b)) |
| Waiting (`nostr-waiting`) | Cancel, ← = Cancel; NIP-46 waits two minutes; its expiry or a `timeout` returns to the start (`nostr-timeout`, FD 91 (b)) |
| Declined (`nostr-declined`); probe refused (`nostr-probe`) | Error line; the refusal in FD 91 (d)'s words, and for the probe a secondary Start a new library under the primary, doing what New here does |
| Import sheet (`nostr-import`, FD 82, C§4.6) | Once after the first sign-in, over the waiting step as drawn, when the lists hold web links; the count is the links found, saved ones being skipped, worded for one or several (FD 91 (f)); scrim and Back don't dismiss it, as drawn; either answer starts the restore, and imported links join after its first EOSE as pending rows saved at the import time |
| Success (FD 41, FD 12) | Root swap to Saves with the restore card, or to first-run Saves with nothing to restore (`restore-nothing`, FD 91 (a)); marked a nostr user everywhere; kind 0 read for You |

**Restoring on Saves** (FD 23, FD 40): the card in Saves' notice slot with "N of M" and a determinate bar (`restoring`, `restoring-mid`); paused offline (`restoring-offline`); done held 3 s, then row out; a silent relay is skipped. Restored rows draw their covers as they land on screen.

**Moving early saves** (FD 6, C§4.8): when I already have a library succeeds after an early share, the move runs from the early key under the restore card, which adds the prototype's line about the earlier save. It pauses offline and resumes at start-up; S stays intact until step 5 (CR12).

### 5.4 Journey 3: saving from the phone

| Saved sheet | Build notes |
|---|---|
| Saved (`share`, FD 38, FD 39) | Row written before anything draws; cover draws; confirm haptic; countdown `getRecommendedTimeoutMillis(4000)`, then back to the host app |
| After Undo (`share-undone`) | Row, spool and held outbox rows deleted (4.3) |
| Offline (`share-offline`, FD 78) | No countdown; the item waits queued |
| Not a link (`share-nolink`) | No URL in the text; nothing saved |
| X post: checking; no article (`share-checking`, `share-noarticle`, FD 78) | Nothing written while checking; Cancel or OK saves nothing |
| Already saved, unread (`share-again`) | G2 (FD 89): nothing changes; Done and Read now, no Undo (FD 38); the cover is already drawn and doesn't draw again; the countdown runs as for a new save. An archived save shared again gets the Saved sheet and un-archives (Repeat saves below) |
| X service failing (`share-embedfail`; its row `saves-embedfail`) | G3 (FD 89): saved as pending, retried from 30 s doubling to an hour; no countdown, Undo and Done |
| Read now (MS Sheets) | MainActivity opens `kefli://reader/<hash>` through Android's app transition |
| Screen reader on (FD 38) | No auto-dismiss or countdown (5.9) |

**Picking the URL:** the first `http(s)` URL in `EXTRA_TEXT` (64 KB cap). A URL on `x.com`, `twitter.com` or `mobile.twitter.com` shaped `/<user>/status/<id>` takes the X route.

**X posts** (FD 78, T§1). Online: `GET https://publish.x.com/oembed?url=<post>` with 5 s over the embed's whole answer, capped at 512 KB, a timeout counting as X failing (F12); resolve the anchors in its `html` in order, `t.co` without a browser user agent (`redirect: 'manual'`, five hops at most), and take the first whose host is outside `x.com`, `twitter.com`, `pic.x.com`, `pic.twitter.com` and `t.co`. None, or an X Article (`x.com/i/article/…`), gives the no-article state; otherwise the article is saved as an ordinary share and the embed response discarded. Offline: the post URL is saved with `x_state = pending` and checked when online; an article re-keys the save (FD 80), and no article leaves it failed (`x_no_article`), its row opening the post.

**Fetch and parse** (section 9): `expo/fetch` with a desktop Chrome user agent and a mobile one on 403, following redirects itself (`redirect: 'manual'`, ten hops at most, the user agent re-applied each hop, the final URL kept for the `d` tag), one 20 s deadline over the headers and the whole body, a streamed cap of 5 MB for a page or 20 MB for a body not served as a page (it may be a PDF known only by its first bytes), and no cookies (`net/http.ts`, F12, F27); a timeout is offline, marked as one; only `text/html` and `application/xhtml+xml` parse as pages. The guard: `isProbablyReaderable` false with fewer than 120 projected words fails as `not_readable` (FD 77, FD 78; threshold from the 53–54-token walls in T§1, CR8).

**The d tag and re-keying** (FD 80, C§4.3): the row is first keyed by `normalise(sharedUrl)`. After the fetch, `d` comes from `normalise(finalUrl, canonical)`. If it differs, the unpublished row, its files and FTS entry move to the new hash and the cover crossfades once without drawing again (MS); if the new hash already exists, the repeat-save rule applies and the provisional row goes. Once published, a save's `d` and cover never change.

**Encrypt, upload, mirror, publish** (C§4.1, C§4.2): the bundle returns normalised Markdown; Hermes computes `text_hash`, the projection, `words` and blocks; a fresh 32-byte key and 12-byte nonce encrypt it with AES-256-GCM (ciphertext‖tag, no AAD, CR8); the outbox uploads, mirrors and publishes, upload first so no device sees an item without its blob. A failed parse publishes with `text` and `text_hash` null.

**Repeat saves:** an archived save is un-archived (C§4.1) with `saved_at` set to the share time (4.2), and Undo re-archives it (4.3); an unread one follows G2.

### 5.5 Journey 4: saving from the browser

| Connect a browser (FD 11, FD 29, FD 42, FD 64) | Build notes |
|---|---|
| From first-run Saves (`conn-first`) | Saves stays lit; ← and success return there |
| Camera explanation; scanning (`conn-ask`, `conn-scan`) | The explanation only while CAMERA isn't granted, otherwise straight to scanning (FM journey 4); Use the camera, or Type the code instead |
| Type the code (`conn-type`) | XXXX-XXXX, upper case, hyphen inserted, advances at eight |
| Wrong typed code (`conn-typewrong`, FD 40) | No offer, failed decrypt, or not eight characters after the lenient read; reject haptic |
| Connect this browser? (`conn-confirm`) | Confirm card from the validated `label` |
| Connecting (`conn-busy`) | Cancel disabled; no ← |
| Camera refused; expired (`conn-refused`, `conn-expired`) | Refused offers Type the code instead and Android settings; expired when `expires` has passed, allowing 60 s of clock skew |
| Can't connect (`conn-failed`) | `POST /devices` or the pair-ack failed |
| Success (prototype `connectScreen()`) | Pops to the launcher, then the toast |

**Typed code** (C§4.4): read leniently (upper case, hyphens and spaces dropped, O as 0, I and L as 1); scrypt through `CryptoPort` (N 16384, r 8, p 1, 64 bytes, salt `kefli/pair-code/v1`); `GET /pair-offers/<lookup>`; decrypt; validate as a QR. A still-queued `register` runs first, inside the busy state.

**Validation and pair-ack:** a QR or offer needs `v` 1, an unexpired `expires`, a valid x-only `device_pubkey`, a plain-text `label` under 64 characters, `relay` equal to the operator relay in `defaults.json` (CR10), and a `proof` that verifies for `device_pubkey` and this nonce against `operator.api`, made no later than `expires`, checked with `kefli-secp` (C§4.4, v1.11). An offer from an extension older than v1.11, with no proof, is passed over when scanned and reads as `conn-typewrong` when typed (FD 116). Connect queues `post_device`, carrying the proof, then `pair_ack`: a wrap to the device on that relay, rumor kind 30078, `d` = `kefli/pair-ack`, content `{v:1, user_pubkey, write_relays, blossom_servers, token, nonce}`, `token` 32 random bytes in hex, seal signed by the user (C§4.4). On success the `devices` row is written and the connected-browsers record republished (C§4.9).

**Connected browsers** (FD 11, FD 32): the list (`br`); none yet (`br-empty`); the Disconnect sheet then a toast (`br-disconnect`), setting `revoked_at` at once, republishing the record and queueing `delete_device`; offline, the notice with Connect disabled. FM's "pairing failed" is Can't connect.

**Arriving saves** (FD 30): an accepted request joins the top of Saves as "From Chrome" with "Getting the text…"; its cover draws only if Saves is on screen (`saves-arrive`, MS Signature 1).

### 5.6 Journey 5: reading

| Saves, Unread (FD 1, FD 8) | Build notes |
|---|---|
| Populated (`saves`) | Newest first; "N min" or "N min left" at 230 words a minute; line only when part-read |
| Partial (`saves-arrive`, `restoring`, `saves-embedfail`, FD 69) | Fetching, arriving from a browser, restored, an X post waiting for X (G3): waiting square, never a loop |
| Row error (`saves`, FD 68, FD 69) | Grey cover and stamp; the row opens the original view |
| Loading (`saves-loading`) | Cached list at once; sync line after 150 ms; no pull to refresh (MS Lists) |
| Empty (`saves-empty`, `saves-cleared`) | First run (5.2); all read, its check only when just emptied |
| Offline (`saves-offline`) | Notice after a 1 s hold; pending rows show the hourglass |
| Error (FM) | Row-level only |

**Archive** (FD 7, FD 37, FD 63, FD 112): "N archived" as drawn; a visible ⋯ on each row; swipe right for Back to Unread and left for Delete, on the error fill with its content in on-fill, the same 96 px arm and 800 px/s flick, committing at once with Undo (`archive`, `archive-delete`); the row menu sheet raises its toast after its exit (`archive-menu`); empty (`archive-empty`); offline shows Unread's notice (the prototype, over FM's "Identical").

**Search** (FD 50, FD 51): full screen, no tab bar, field focused on arrival. Before typing, the caption (`search`); results per keystroke with archived rows tagged; no results only after 250 ms idle (`search-none`); swiping a result archives or restores it in place, and swiping an archived result left deletes it, when it leaves the results (FD 112); Back from a Reader opened here keeps everything and plays Catch-up (`search-reader`). The query resets only when entered from Saves; offline is identical.

| Reader | Build notes |
|---|---|
| Reading (`reader`, FD 4) | Laid out at the saved word before it shows; no animated scroll |
| Loading (`reader-loading`) | Skeleton after 150 ms; no Listen chip or Archive |
| Images arriving (`reader-images`) | Placeholder at the stored size (`images.w`, `h`), 3:2 on first load, the anchored word kept still |
| Couldn't get the text (`reader-error`, FD 69) | The original view |
| Not fetched, offline (`reader-offline`, FD 40) | The fetch runs when online |
| Bar (`reader`, FD 110) | Back, the source, the Listen chip, Speed read (Kefli's speed-read icon, "Speed read"), Aa, ⋯; Speed read only while the text is shown, as the chip |
| ⋯ menu (`reader-menu`, FD 62, FD 110) | Back to Unread (archived only), Open original, Copy link, Delete |
| End card (`reader-end`, FD 54, FD 37, FD 42) | Archive and next only with a next unread: the first Unread row in list order whose text is cached, other than this one; archived: Back to Unread |
| Playing; paused (`play`, `play-paused`, FD 45, FD 20) | The mini expands into the Reader tier; reading line hidden; chip faded in its slot; highlight and follow-scroll; paused shows ✕ |
| Another article playing (`mini-reader`) | Mini at the bottom; Archive above it |
| Offline, text cached (FM) | Identical |

**Aa sheet** (`reader-aa`, FD 16): 15–24 px in 1 px steps from 18; Light, Sepia and Dark. A size change keeps the word a third of the way down still (MS Reader). One size and palette for every article, the palette following the phone until one is picked (FD 89).

**Original page view** (FD 81): `react-native-webview` inside Kefli's bar, notice and floating Archive (`reader-error`, `reader-original`), its ⋯ holding Open in browser, Copy link and Delete (`reader-error-menu`); loading shows the Reader's skeleton under the bar (`reader-original-loading`), a load failure points to Open in browser (`reader-original-failed`), and offline it says it needs a connection (`reader-original-offline`, G4); hardening in 7.1.

**From the Reader,** Archive pops to the opener and plays Finish on its row; Delete stops playback if the article is playing and removes it from Listen (FD 34); each raises its Undo toast. Undo of deleting the playing article starts a paused `kefli-voice` session at its stored word and puts back its Listen row and any Play-all queue (FD 34). Copy link's toast follows G11.

### 5.7 Journey 6: listening

**The session** (`kefli-voice`, 8.1): starting builds the article's sentences from the spoken projection, each with its word starts, and hands them over with the start word, rate, voice and the 512 px cover. The engine is warmed when a Reader mounts, since the first word took about 2 s cold (T§2). Word events set the position directly (MS Signature 2). Engines without word timing report sentence starts only; the highlight then marks the sentence (`play-sentence`, FD 91 (h); `archive/03-android-v1.0.md` fell back to paragraphs, but utterances are now sentences), the line glides across each sentence's estimated duration (MS Signature 2), the word meter stays unlit (FD 68, FD 69), and Speed read is unaffected.

**Where it starts** (FD 19, FD 36, FD 107): at the saved word if on screen, otherwise the first paragraph in view, with no scroll; a double-tapped word in the Reader, moving a session of that article there and playing it, or starting one there; a Listen row's play button, and Play on Listen's ready card, start from the stored position, or from 0 if finished. Each article has one position, a word index, written by reading, listening and Speed read; reading writes it only while the article isn't playing.

**Clock.** On-device speech has no duration, so time is estimated. Words per second are measured per voice and per speed (FD 107: a voice's speed doesn't scale with the rate; `voice.wps.<voice>` for 1×, `voice.wps.<voice>@<rate>` for the others, a speed not yet heard starting from 1×'s figure, times 1.3 at 0.5×; the engine asks Google's voice for 2.1 at 2×, heard as a true 2×, while 0.5× is heard at about 0.65× since the voice goes no slower) from `onRangeStart` as a moving average, seeded at 3.9 at rate 1 (T§2: about 255 ms a word on Google's en-GB voice), or learned from sentence starts on an engine without word events; elapsed = word ÷ (wps × rate). ±15 s moves round(15 × wps × rate) words and restarts speech at that word, re-queuing the rest of its sentence from the word's offset, so the highlight moves to it at once (MS Player); taps accumulate and clamp at both ends (FD 48). On Listen's card the ruler also seeks, to the word (FD 115); everywhere else progress stays display-only.

**Tiers** (FD 45, FD 46, FD 20, CS Player): the mini (`mini`) on every screen with a session except Listen while its card is in view, Speed read, first-launch screens and the playing article's Reader, its title opening the Reader at the spoken word; the Reader tier there; the full tier on Now playing and as Speed read's transport, drawn inside its host (6.1). ✕ shows only while paused and ends the session everywhere. The speed pill steps 1, 1.5, 2, 0.5 and back to 1 (FD 107); the engine's rate is snapped to its step wherever it enters, since it comes back as a widened 32-bit float.

| Listen (FD 111, FD 115) | Build notes |
|---|---|
| Empty (`listen-empty`) | Only with no session and nothing in Unread to play: medal, "Nothing to listen to" and a way to Saves |
| Populated (`listen`, FD 68) | Now playing with the word meter; Unread, newest first, the rows with text; a row's cover plays, its body puts it in the card (FD 115); the card's title opens the Reader |
| Switched (`listen-cued`, FD 115) | A row's body tapped: any session stops where it is, its place kept and published as ✕ does, Play all ends, and the card holds the tapped article ready ("Up next") at its stored position, kept in `settings` as `listen.cued` until anything plays; the list scrolls back to the card when it is under 60 % in view; the article already in the card changes nothing, and so does one whose text can't be read |
| Seeking (`listen-scrub`, FD 115) | The ruler (48 pt touch area) takes a tap, or a drag that starts sideways (8 pt across before 12 pt down): a knob on the line and the time at it in the left clock while dragging; the point is the share of the article's words across the ruler, to the word; a session moves there (`jumpToWord`: playing goes on, paused stays paused), the ready card moves the stored position, stopping one word short of the end (which would read as heard through); a still press seeks however long it is held. TalkBack: adjustable "Position", value "4:12 of 14:05", steps of a twentieth, the value moving on only by whole steps while speech plays; with a screen reader on, the ruler takes steps and drags, no tap |
| Ready (`listen-ready`, FD 111) | No session: the card holds the article a row's body put there (`listen.cued`, FD 115), else the most recently played article still in Unread ("Last played"), else the top of Unread ("Up next"), at its stored position; Play starts there, ±15 move the stored position without a session, the speed pill sets the one speed; no ✕. Closing a session returns the card to this state. An article whose text can't be read isn't held (its choice is cleared and lost text is fetched again), and with none to hold the list shows without the card |
| Card scrolled away (`listen-scrolled`, FD 52) | Mini appears below 40 % in view, leaves above 60 % |
| Reader from Listen (`listen-reader`, FD 50) | Back returns to Listen |
| Loading, partial, error, offline | FM's rows are obsolete under FD 22; offline is identical |

Play all plays a snapshot of the Listen list (Unread with text, FD 111) from the top to the end, then stops; a finished article rewinds to its start, paused; reading another article doesn't pull you along; only starting a different article ends it (FD 35, C§7). When Play all moves on, the playing article's open Reader moves with it to the next article at its word, with no glide, as the prototype does (FD 75; MS Signature 2).

**Lock screen** (`lock`, FD 10, FD 15, FD 72): Android's media layout with play, pause, ±15 and a display-only bar (FD 48); the cover as artwork, the one-colour glyph as the small icon; a tap opens the playing article's Reader at the spoken word with the tier in place. Headset and car controls use the same session (8.1); no notification permission is requested.

| Speed read (FD 21, FD 36, FD 71) | Build notes |
|---|---|
| Just opened (`rsvp-start`) | Paused on the playing word, else the saved word if on screen, else the paragraph in view; pauses audio |
| Running (`rsvp`) | 60,000 ÷ wpm per word; ×1.4 for nine or more letters and digits once punctuation is stripped, or any digit; ×1.8 after `,` `;` `:` `—` or `–`; ×2.5 after `.` `!` or `?`, with an optional closing quote or bracket; ×3.5 at a paragraph end; ease-in from 60 % over ten words after each start, sentence move or wpm change; focus letter at the `orpSplit` index, on the spoken-word wash (FD 71, 6.2) |
| Paused (`rsvp-paused`) | Previous goes to this sentence's start from its fourth word on, otherwise to the previous sentence; next to the next. Swipe and both buttons work in every state but done |
| Finished (`rsvp-done`, `rsvp-done-archived`) | Back to article and Archive, or Back to Unread when archived; either leaves Speed read and the Reader together (MS Reader) |

Leaving moves the audio to the same word, and the Reader lights it for 1.6 s; wpm steps by 50 between 200 and 700.

### 5.8 Journey 7: You

| You | Build notes |
|---|---|
| Backup not done (`you`, FD 17, FD 25, FD 68) | Big counts beside the quilt; Later hides the card for ten more saves |
| Backed up (`you-done`, FD 27) | No card; the row reads "Written down" |
| Nostr user (`you-nostr`, FD 12, FD 26) | Picture and name from kind 0 (G12 without either); no recovery rows, and no Add another device (FD 90) |
| Several voices (`you-voices`, FD 24, FD 109) | Voice row naming the phone language's voice, shown when any language among the phone's own and the saves' has two or more; rechecked each time You opens |
| Offline (`you-offline`, FD 25) | No banner; Add another device disabled |
| Recovery code sheet (`rec-hidden`, `rec-shown`, `rec-copied`, FD 27, FD 74) | Copy confirms inside the sheet; after Done, focus on the Recovery code row |
| Add another device (`dev`, `dev-expired`) | 3.6; expired fades the QR to 12 %; offline notice; generating shows a skeleton QR (FM) |
| Voice (`voice`, `voice-langs`, FD 24, FD 36, FD 109) | Chips for the phone's language and each language among the saves (by count of saves), not drawn with one; the chosen chip's offline voices, samples played outside the session, Default speed; one choice per language, `voice.id.<lang>`, the old `voice.id` counting for its own voice's language until a choice is made there, so it moves without a write; a session uses its article's language's choice, else its first voice; loading is a momentary read; no engine, no row; offline identical |
| Advanced (`adv`, `adv-down`, `adv-offline`) | The relay group with each relay's status (FD 76); the count of saves not backed up (`adv-notbacked`, 4.3, FD 93), and while there are any, the note under the relays speaks of "your other saves"; offline disables the row for switching to a nostr app. Add a relay, last in the relay group, opens its own screen (`adv-add`, `adv-add-bad`, `adv-add-checking`, `adv-add-unreachable`, `adv-add-refused`, `adv-add-offline`; FD 113, C§3.1): the address is checked, then the relay must answer and take the newest signed 10002, after which it joins the 10002, the lists go out, and a bulk `copy_relay` row copies the newest signed event of each save and every kind 5 from the other write relays to it unchanged; waiting and sending changes gain it as a target. A relay added there is "Your relay" and its row asks whether to remove it (`adv-mine`, `adv-remove`); Kefli's and the backups' rows don't |
| Export my saves (`adv`) | Works offline; one HTML bookmark file with each save's text, `kefli-export.html` to Downloads, then the toast (FD 89); failure `adv-exportfail` (G9) |

**Switching to a nostr app** (FD 13, FD 26, FD 76; move job 4.10): explain with the switch (`sw`); waiting (`sw-waiting`); declined (`sw-declined`); offline, primary disabled (`sw-offline`); moving with "N of M", Back swallowed (`sw-moving`); done root-swaps to You with its toast. No signer installed is `sw-none`, a probe refusal `sw-probe` and a save from a newer Kefli `sw-newer` (FD 91 (c), (i)); a bad sign-in link is a field error, as at sign-in. Hidden for nostr users.

| Delete my data (FD 14, FD 28, FD 41) | Build notes |
|---|---|
| Explain (`del`, `del-typed`) | The danger button enables only with DELETE typed and online; backup-server count from the real lists (G8), the mirror and a nostr user's own relays included, and the all-devices line (FD 91 (e)) |
| Waiting; declined (`del-nostr`, `del-declined`) | Nostr users approve first; declined deletes nothing |
| Deleting (`del-running`) | Steps from the real targets (7.2); Back swallowed; for a generated identity shown from the press, while the relays are read for every save (FD 116) |
| Partial (`del-partial`) | Names each server that didn't confirm; nostr wording omits the recovery code |
| Failed (`del-failed`); offline | Operator unreachable, or the signing failed, nothing deleted; offline notice, controls disabled |
| Done (FD 74) | Holds 400 ms, root-swaps to Welcome, toast, covers draw |

### 5.9 Cross-cutting behaviour

Toasts (FD 38) offer Undo only when something can be undone ("Archived", "Moved back to Unread", "Deleted"), last `getRecommendedTimeoutMillis(5000)`, are announced, pause while touched or focused and never rise over a sheet. With TalkBack on, no countdown runs and nothing auto-dismisses (CS Interaction, MS Sheets): a toast stays until it is replaced, its screen is left, or focus has visited and left it, and the Saved sheet waits for an answer or Back. Gates follow FD 14: Undo for reversible actions, a sheet for Disconnect, a typed DELETE only for Delete my data. Offline, waits and errors follow CS Interaction and MS Waiting: one notice per screen after a 1 s hold, busy buttons never disabled, no bare spinners, input errors at the field and outcome errors in the notice slot.

## 6. UI implementation

### 6.1 Routes and navigators

```
src/app/_layout.tsx         root JSStack (expo-router/js-stack); Stack.Protected: tabs and You routes on
                            "identity and welcome.answered", the Reader on "identity"; PlayerHost,
                            ToastHost and SheetHost above the navigator, then SpeedReadHost (no route)
src/app/welcome.tsx, restore/{index,scan,code,nostr}.tsx
src/app/(tabs)/_layout.tsx  expo-router/js-tabs: custom tab bar, animation 'fade', 150 ms, sceneStyleInterpolator
src/app/(tabs)/{index,listen,you}.tsx
src/app/search.tsx, reader/[hash].tsx, reader/[hash]/original.tsx
src/app/you/{add-device,browsers,connect,voice,advanced,switch,delete}.tsx
src/share/ShareRoot.tsx     second React surface, registered as "share" (8.5)
```

Pushed screens, Search and the Reader included, sit in the root stack over the tabs, as CS and MS require (no tab bar on them, one player and toast host), in place of FM's "stack inside each tab". Custom `cardStyleInterpolator`s read the reduced-motion flag themselves; `detachPreviousScreen`, `cardOverlayEnabled` and `gestureEnabled` are false; `transitionStart` starts Catch-up (MS Navigation). Both full-screen modes fade over the Reader without travel, 250 ms in and 200 out (MS Reader): `reader/[hash]/original` through a fade-only interpolator, and Speed read as a host opened from its store instead of MS's modal route, since CS's z-order puts it above toasts and sheets (45 over 40), where no route can reach. The host draws its own transport (5.7), hides everything beneath it from accessibility and takes Android Back as ✕, back to the Reader at the current word.

### 6.2 Tokens and theme

A new `shared/tokens/build-ts.mjs` generates `packages/tokens` from TK 1.0.1 (FD 92: colours for both themes, type roles naming font families rather than weights, space, radii, cover greys, motion as Reanimated configs), committed and checked for staleness in CI; no component is built until it emits 1.0.1. This completes MS's first Before build item. The app follows the phone's theme (`userInterfaceStyle: "automatic"`, FD 16); Reader palettes live only in the Aa sheet, Night tinted per article by `ShelfCover.night()` (CV). Each article's lines, link underlines, countdowns, Speed read's ticks, the word meter and the waiting dot take `ShelfCover.lineInk(hash, surface, text)` (3:1 on the toast), and the spoken-word wash, Speed read's focus letter included, takes `highlight(hash, {bg, text})`; both are recomputed when the theme, the reading palette or the surface changes (CS Covers, FD 71).

### 6.3 Fonts and icons

SDK 57 takes only static fonts, so TK's variable faces are cut with fontTools `varLib.instancer` at the weights the prototype uses: Archivo 400, 500, 550, 600 (group and field labels), 620, 650, 680 and 750 (Reader article titles) at normal width; Archivo width 125 weight 750 for display; Literata regular, italic and bold at an 18 px optical size for body, and regular and 600 at a 32 px optical size for Speed read's word; Martian Mono 500. TK 1.0.1 carries the 600 role, mono 500 and the fixed optical sizes (FD 92). Each is its own `expo-font` family, named after checking the OFL Reserved Font Names, and capital centring is re-measured on them before components rely on it (CS Components). Icons are `lucide-react-native` at stroke 1.75 (FD 65), plus the ±15 pair and speed-read icon generated from `docs/design/icons/app/`, the ±15 arc and numerals split so the arrow turns alone (MS Player, FD 62).

### 6.4 Covers

`ShelfCover.leaves` from the unmodified `cover-v1.js` becomes Skia paths at depth 3 (CV). While covers draw, one `Picture` per cover is recorded per frame on one `useFrameCallback` clock; finished pictures are cached by hash, size, columns and grey. `cover_drawn` records each draw per surface, and an interrupted draw resumes from its stored start (MS Signature 1). A 512 px PNG is rendered offscreen for the lock screen; failed saves crossfade to the greys; covers are hidden from accessibility. The cover fixtures, `lineInk` and `highlight` included, must pass on Hermes before a build that draws covers ships (CV).

### 6.5 Motion

Durations and curves come only from the token module; the two signatures and every row of MS's Interactions tables are built as written, each row's Build column being its implementation note, except where this spec names a substitute: `kefli-voice` for expo-speech, `onRangeStart` word events for `onBoundary`, Kefli's own sheet (6.8) for @gorhom/bottom-sheet, and Speed read's host for its modal route (6.1). Gestures use `Gesture.Pan` and commit through `scheduleOnRN` before animating, never in a completion callback. Reduced motion is read at launch and on change, with `ReduceMotion.Never` on the fallback fades (MS Principle 7). MS's Don'ts are review criteria.

### 6.6 Lists and swipe

Reanimated `Animated.FlatList` with `itemLayoutAnimation={LinearTransition.duration(200)}` (not on Search), `maintainVisibleContentPosition` and `onViewableItemsChanged` for Catch-up (MS Lists). If 2,000 rows miss 60 fps, FlashList 2.0.2 without layout transitions replaces it. Swipe follows MS Lists: vertical scroll keeps priority until 10 px sideways; it arms at 96 px with a selection haptic and commits there or on a flick over 800 px/s after 32 px, flying off on the release spring. Each tab and segment keeps its scroll (FD 74).

### 6.7 Reader rendering

Blocks are derived once with `mdast-util-from-markdown`, whose nodes carry exact source offsets; a per-character map resolves the escapes and references Turndown emits, so a spoken word maps to its Markdown offset (C§7). The Reader is an `Animated.ScrollView` with one memoised `<Text>` per paragraph; only the playing paragraph splits into memoised word spans, so a word change re-renders two spans, and word rectangles come from `onTextLayout`. A double tap on a block's text (FD 107: two taps on one block within 300 ms and 24 points, none while a screen reader runs) asks `KefliSystem.textOffsetAt` for the character under the second tap, in the text view there; the word is that character's place among the block's whitespace-separated words, as the highlight counts them, and the block's first word where the phone can't say. Follow-scroll is Reanimated `scrollTo` on the enter curve, putting the word a third of the way down when it leaves the reading band (top 40 px under the bar, bottom about 80 px above the player or the floating Archive), never while a finger is down or a fling runs (FD 18, FD 43, MS Reader). A drag or fling that takes the spoken word off screen sets an `away` flag, and following stays suspended until the word is visible again (MS Before build 3); opening onto the playing article sets the offset with no glide. If an 84 KB article (T§1) misses 300 ms to its position, an `Animated.FlatList` of blocks with `initialScrollIndex` replaces the ScrollView. Images use `expo-image`, fading only on cache misses.

### 6.8 Sheets, toasts, bottom stack

Sheets are Kefli's own component on Reanimated and Gesture Handler, to MS Sheets: scrim opacity derived from translateY, closing past 30 % of the height or 1,000 px/s, no travel above rest, toasts paused under the scrim. One bottom-stack model computes the offsets of the tab bar, mini or tier, the screen's bottom layer and the toast, moved by translateY on the enter curve (CS Scaffolding). z-order (CS): content, Archive, mini, toast, scrim and sheet, Speed read (its own host, 6.1).

### 6.9 System surfaces

`expo-splash-screen` with `splash-icon.png` on #F3F2EE and the dark image on #111112, `imageWidth` 200, hidden after the first frame (FD 72 and 94, `shared/brand/README.md`; wired in `app.json`). The app's launch screen (`ui/Launch.tsx`, FD 97, `motion.launch`) takes over with the same image in the same place, adds the name and the Hávamál line, holds for five seconds or until a tap, and fades over the first screen; it shows once per process and never on the share surface. Edge-to-edge is React Native 0.86's default, so the Reader and Speed read draw the reading paper under transparent system bars, and `expo-navigation-bar` and `expo-status-bar` set the icon style to match the palette. `react-native-keyboard-controller` keeps action bars above the keyboard. Haptics follow MS: a tick when a swipe arms, reject on a code mismatch, success on a QR read, confirm with the share sheet's check.

### 6.10 Accessibility

FD 43's floor: 48 × 48 targets, selected states exposed, named icon buttons ("Back 15 seconds", "Forward 15 seconds", "Speed 1.5×"), sheets as dialogs that take and return focus. Focus returns to the row on Back from the Reader, moves to the next row's ⋯ after a row-menu action, and lands on the Recovery code row after Done (FD 74). Leaving layers drop out of the accessibility tree at once (MS Player); toasts and field errors are polite live regions; progress reads as a percentage; system font scale applies on top of the Aa size.

### 6.11 Strings

One `strings.ts` module in British English, every user-facing string copied verbatim from its prototype state, with a CI check that each cited state id still exists. The copy the contract fixes (C§2, §4.4, §4.6, §4.7) is the prototype's since v1.3 (CR7, CR18); plurals and the FD 91 states take their drawn copy. "nostr" appears only on the sign-in, switching, You and deletion routes as drawn (FD 86, C§1); "relay" only in Advanced (FD 76).

## 7. Security and privacy

### 7.1 Controls

- **Memory and logs.** Secrets live in the key file, in `LocalSigner` as a zeroable byte array, and in JavaScript strings only while deriving or showing the words. Logs never hold keys, content, URLs, titles or payloads; release builds strip `console` below `warn`, and `console.warn` in `node_modules` too (Kefli's own code has none).
- **Network.** No cleartext; `wss://` only. NIP-98 events are fresh per request, with `u` equal to the exact URL, `method`, and `payload` on every POST, PUT and DELETE (the empty-string hash without a body, C§6). The inbox fetches HTML only from the operator Blossom origin; inbox-driven URL fetches refuse private, loopback and link-local addresses. Every page, image, X embed and `t.co` fetch omits cookies, and each has one deadline over the whole body with a streamed cap (5.4, 4.5).
- **WebViews.** The parser WebView (8.2) is detached, with `blockNetworkLoads` and file, content and cookie access off, and never navigates; HTML enters as data, never as script. The original-page view has no bridge, no `onMessage`, no injected script, no file access and no new windows; it loads only http(s), `about:blank` and `about:srcdoc` and hands no link to another app (`net/navigation.ts`), runs incognito, and empties the cookie jar when it closes (F25, F27). The render WebView (8.2) has no bridge either, reads the page back only with `evaluateJavascript`, follows only http(s) navigation, and loses its cookies and storage when each render ends.
- **Input.** Shares: a string under 64 KB, URLs parsed by the WHATWG algorithm. Inbox: 4.7. QR codes and offers: 5.5. Internal links: a 64-hex hash present on the phone and a non-negative word index.
- **Screen and clipboard.** `FLAG_SECURE` on the recovery sheet and Add another device. The recovery code is copied with `ClipDescription.EXTRA_IS_SENSITIVE` (its string key below API 33), and the in-sheet "Copied" note shows on every API level (FD 27).
- **At rest.** `allowBackup="false"` and `android:dataExtractionRules` excluding every domain under both `<cloud-backup>` and `<device-transfer>`, since on some makers' phones `allowBackup` alone still lets a device-to-device transfer copy the plaintext library and index. A database found without a readable key file is wiped before the identity resolver runs (3.1). No SQLCipher: its key would have to work in the background, so it would add little over file-based encryption and the sandbox.
- **Permissions.** Allowed: `INTERNET`, `ACCESS_NETWORK_STATE`, `CAMERA` (asked only when scanning, FD 11), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK`. Blocked by config plugin: `POST_NOTIFICATIONS` (FD 15), `RECORD_AUDIO`, storage, `SYSTEM_ALERT_WINDOW`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. FD 15 relies on the `mediaPlayback` notification needing no permission on Android 13 and later; 11.3 checks it.

### 7.2 Delete my data

C§4.7 (CR3) puts the operator's kind 5s before `DELETE /account`, since C§3.2 then rejects the account's kind 5s, and FD 91 (e) gives each server its step. The build runs: (1) the operator: kind 5s for every known wrap, and for every item when the operator relay is in the user's 10002, to the operator relay, then blob deletes on the operator server and `DELETE /account`, which run in every case, with at most a minute of the outbox's retries; an OK to a kind 5 counts as confirmed; (2) every other write relay in the user's 10002 (Kefli's backups and, for a nostr user, their own) and the mirror, each reported as deleted, asked or not confirmed after at most a minute of the outbox's retries, since step 3 wipes the outbox; (3) the phone, in this order: the signer dropped and zeroed, the key file deleted without being opened, the Block Store entry emptied, the WebViews' cookies, storage and cache cleared (`KefliSystem.clearWebData`), the database wiped with `secure_delete` on, then VACUUM and the log truncated, `files/kefli` and `files/share-spool` deleted, and every cache entry but the WebView's own folders (F28). The key file goes first, so a later step that fails leaves a database the next launch wipes. The kind 5s cover `items`, `items_future`, the connected-browsers record, every kind 30078 with `#t` kefli found on the user's relays and the operator relay before signing, and deletes still queued or given up on, each dated past the newest event it names (C§4.7, F32); a save found only on the relays is decrypted for its blob, which is deleted with the rest. The counted servers are those a save's `text.servers` names. A generated identity's 10002 and 10063 are deleted, on the indexer too; a nostr user's are rewritten without the operator's entries and the defaults this phone added. If step 1 fails, or its minute runs out with the operator unreachable, nothing else runs (`del-failed`). For a nostr user, wiping the key means the NIP-46 client key or the NIP-55 package record.

### 7.3 Privacy note lines

The X embed lookup tells X which post was saved (T§1); fetching images at read time tells the image's site which article is open (C§4.2); new saves wait on the phone until the operator is reachable (C§1); a new save can briefly have only Kefli's copy until a backup server accepts it (C§1, FD 93); the phone keeps a plaintext copy of the library in private storage; a page that turns Kefli's fetch away is loaded once in a browser engine, which runs the page's own scripts as a browser would (8.2); Kefli's own fetches of pages, pictures and X's embed carry no cookies, and the original page view keeps none once it closes (7.1, F27). The privacy page doesn't say the last yet; adding it is Richard's call.

## 8. Native modules

Local Expo modules under `apps/mobile/modules/`, each with an `.android` implementation, an iOS stub, Kotlin unit tests and a device test in the harness (11.2).

### 8.1 `kefli-voice`

```ts
type Sentence = { text: string; wordStarts: number[]; firstWord: number };
interface KefliVoice {
  listVoices(): Promise<{ id: string; locale: string; offline: boolean }[]>;
  warmUp(voiceId?: string): Promise<void>;
  start(s: { hash: string; title: string; site: string; artworkPath: string; sentences: Sentence[];
             startWord: number; totalWords: number; rate: number; voiceId?: string; wps: number }): Promise<void>;
  play(): void; pause(): void; skip(seconds: 15 | -15): void; jumpToWord(word: number): void;
  setRate(rate: number): void; close(): void; sample(voiceId: string, text: string): Promise<void>;
  // events: word {hash, word}, sentence {hash, index}, state {hash, playing, word, rate}, ended {hash}, error {hash, code}
}
```

A media3 1.11.1 `MediaSessionService` (`foregroundServiceType="mediaPlayback"`) whose session is registered with `addSession`, playing audio Kefli writes itself: the week-0 gate found that speech through `TextToSpeech.speak` plays from the engine's process, so Android never routes media buttons (headphones, car, keyboard) to Kefli's session (`08-week0-gates.md`). The module owns one process-wide `TextToSpeech`, created by `warmUp`, shared by the service and `sample()`, and released on `close()` and after a minute idle, so no second instance competes. Sentences are written a few ahead with `synthesizeToFile`, each under `getMaxSpeechInputLength`, ids `<hash>:<index>`, and played in order by Kefli's own player; each word's time is its `onRangeStart` frame (Google's engine passes the frame first and the characters after it when writing a file, so they are read by value), mapped to a word by binary search over the sentence's word starts. On an engine that reports no ranges, the sentence is the unit (FD 91 (h)). Pause stops the engine and resumes from the last word's start, and a skip or jump re-queues the target sentence from the target word's offset. Commands are play, pause and seek back and forward, mapped by the clock rule (5.7). Android 13 and later fill the card's side slots only from media button preferences, so the session sets two `CommandButton`s, `ICON_SKIP_BACK_15` in `SLOT_BACK` and `ICON_SKIP_FORWARD_15` in `SLOT_FORWARD`; `KEYCODE_MEDIA_PREVIOUS` and `KEYCODE_MEDIA_NEXT` map to −15 and +15. The media item's duration and the state's position are the app's clock (5.7), `totalWords ÷ (wps × rate)` and `word ÷ (wps × rate)`, sent with `playbackSpeed` 1, so Android's extrapolation doesn't count the rate twice and the card's times match the mini's; they're resent only on play, pause, skip, jump and a rate change (MS Player). There is no seek-in-item command, so the system bar moves by itself but can't be dragged (FD 48). Audio focus is manual (`USAGE_MEDIA`, `CONTENT_TYPE_SPEECH`): a loss or becoming noisy pauses, and a transient loss resumes on regain. The small icon is `kefli_notification`; the session activity opens `kefli://reader/<hash>` and the app reads the live word (FD 10). The session accepts only the media notification, Kefli itself and controllers Android marks trusted, and its media item id is `kefli-<n>`, counted per load, never the hash (F29); that Bluetooth and System UI controllers still connect is to be checked on the Pixel. Session and service are released on ✕, when an article finishes (alone, or the last of Play all) and in `onTaskRemoved`, since a leftover card restarted playback in T§3c; the app's mini then shows the finished article rewound and paused with ✕ (FD 20, FD 35), and play builds a new session. Within Play all the session moves to the next article without a release.

### 8.2 `kefli-parser`

```ts
type Parsed = { ok: true; title: string | null; byline: string | null; site: string | null; lang: string | null;
                hero: string | null; canonical: string | null; readerable: boolean; markdown: string }
            | { ok: false; reason: 'no_webview' | 'not_readable' | 'error' };
interface KefliParser {
  parse(bodyBase64: string, contentType: string, url: string): Promise<Parsed>;  // kefliParse
  markdown(contentHtml: string, url: string): Promise<Parsed>;                  // kefliMarkdown, inbox
  render(url: string): Promise<{ ok: true; url: string; html: string } | { ok: false; reason: 'no_webview' | 'timeout' }>;
}
```

`render` (added in week 5): a page whose fetch still gets 403 after the mobile user agent, or whose answer arrives as a bare 1xx (Android's HTTP client hands back a 103 Early Hints on some HTTP/2 sites), is loaded once in a second WebView, as a browser would load it, since bot checks such as Cloudflare's tell Android's HTTP client from a browser. Attached to no window, with JavaScript on, no bridge, no file or content access, no new windows, no images, only http(s) navigation and no third-party cookies, its cookies and storage cleared when each render ends (F27); a challenge page is waited out for up to 20 s; one page at a time, the rest queued. The HTML it returns has no scripts, styles, SVG, frames or embeds and no style, data-, aria-, event, srcset or sizes attributes; it is parsed as fetched HTML, under a 16 MB cap in place of the fetch's 5 MB. A live-list gate and the gates screen's render gate check it.

A WebView on the main looper, built with the application context and attached to no window, so it works the same from MainActivity, the share activity and a headless task. The bundle loads from an APK asset, its sha256 checked against the constant baked at build. Input and output cross a `@JavascriptInterface` host object, keeping megabyte strings out of `evaluateJavascript`. One job at a time; torn down after 30 s idle; no WebView provider gives `no_webview`.

### 8.3 `kefli-keystore`

```ts
interface KefliKeystore {
  read(): Promise<KeyRecord | null>;   // no secrets; rejects when the Keystore fails, never null for that (3.2)
  readSecret(pubkey: string): Promise<string | null>; readMnemonic(pubkey: string): Promise<string | null>;
  write(r: KeyRecord): Promise<void>; wipe(pubkey: string): Promise<void>; wipeAll(): Promise<void>;
  strongBox(): Promise<boolean>; isE2EEAvailable(): Promise<boolean>;
  blockStoreGet(): Promise<string | null>; blockStoreSet(mnemonic: string): Promise<{ cloud: boolean }>;
  blockStoreCheck(pubkey: string): Promise<{ entry: 'empty' | 'same' | 'other' | null; e2ee: boolean | null } | null>;
  blockStoreSetFrom(pubkey: string): Promise<{ cloud: boolean }>;   // from the key file, so the words stay native
  blockStoreRemove(): Promise<void>;
}
```

Behaviour in 3.2 and 3.3, on `play-services-auth-blockstore` 16.4.0 with about 120 lines adapted from `expo-block-store` 1.0.0 (MIT).

### 8.4 `kefli-nip55`

```ts
interface KefliNip55 {
  listSigners(): Promise<{ package: string; label: string }[]>;
  getPublicKey(perms: { type: string; kind?: number }[]): Promise<{ pubkey: string; package: string }>;
  signEvent(pkg: string, eventJson: string, pubkey: string): Promise<string>;
  nip44Encrypt(pkg: string, plaintext: string, peer: string, pubkey: string): Promise<string>;
  nip44Decrypt(pkg: string, ciphertext: string, peer: string, pubkey: string): Promise<string>;
  canActInBackground(pkg: string, pubkey: string): Promise<boolean>;
}
```

About 200 lines of Kotlin. Each call tries the `content://<pkg>.<TYPE>` resolver first, only when `resolveContentProvider` names the signer's own package as the provider's owner (any other provider counts as absent, F46), and falls back to the `nostrsigner:` intent through Expo's activity-result listener with `FLAG_ACTIVITY_SINGLE_TOP`. Errors are `rejected` (the declined state), `not_installed` and `timeout`. Payloads are never logged. The port, and `Nip55Signer` itself with the phone's native verifier, refuse a signed event that isn't the one asked for (`signedAsAsked`, 3.4); `kefli-secp` reads hex digit by digit and refuses anything but 0–9, a–f and A–F (F52). A config plugin adds the `<queries>` entry for the scheme.

### 8.5 `kefli-share`

`ShareActivity`: translucent, `excludeFromRecents`, standard launch mode, filtering `ACTION_SEND` for `text/plain`. Android's share sheet starts it in a task of its own (`NEW_DOCUMENT`, `MULTIPLE_TASK`), and finishing it returns to the sender (week-0 gate, `08-week0-gates.md`). `onCreate` spools the text, subject and referrer to `filesDir/share-spool/<uuid>.json` before JavaScript runs, so process death never loses a share; unprocessed spools are picked up at the next start. It renders the `share` surface on the shared ReactHost with `{spoolId}`. `finish('host')` ends with no transition (`overrideActivityTransition` on API 34 and later, `overridePendingTransition(0, 0)` below); `finish('read', hash)` also starts MainActivity on `kefli://reader/<hash>`. Passed its week-0 gate from Chrome and X.

### 8.6 `kefli-system`

```ts
interface KefliSystem {
  setSecure(on: boolean): void;
  copySensitive(text: string): Promise<void>;
  exportToDownloads(fileName: string, contents: string): Promise<{ uri: string }>;  // MediaStore on 29+, SAF on 26–28
  scheduleExpeditedSync(): void;                                                    // fallback only (4.8)
  setRootBack(atRoot: boolean): boolean;   // off: React Native's back callback, so the system preview plays (5)
  textOffsetAt(pageX: number, pageY: number): Promise<{ offset: number; text: string } | null>;  // the Reader's double tap (6.7, FD 107)
  clearWebData(): Promise<void>;           // Delete my data and Sign out: WebView storage, cache, HTTP auth and cookies (7.2)
}
```

### 8.7 Config plugins and conditional modules

`expo-build-properties` for `minSdkVersion` 26 and SDK 36; a manifest plugin for `allowBackup="false"` and the data extraction rules (7.1), the blocked permissions, `<queries>`, the share activity and the voice service; the notification drawable from `shared/brand/out/android/kefli_notification.xml`; the parser bundle copied into assets at prebuild with its sha256 constant; the font families. Because the Schnorr gate failed on noble: `kefli-secp` on ACINQ `secp256k1-kmp-jni-android` 0.22.0 (Schnorr, and ECDH through `pubKeyTweakMul` taking the x coordinate, since libsecp256k1's `ecdh` hashes the point; 0.22.0 rather than 0.24.0, since 0.23 on are built with Kotlin 2.3, which React Native 0.86's Kotlin 2.1 compiler can't read), or a Kotlin crypto module (javax.crypto AES-GCM and PBKDF2, Bouncy Castle SCrypt) behind `CryptoPort`.

## 9. The parser bundle and canonical text

- **Build.** `shared/vendor/build-parser-bundle.mjs` bundles the vendored libraries with `parser-runner.js`, exposing `kefliParse(bodyBase64, contentType, url, rules)` and `kefliMarkdown(contentHtml, url, rules)`. The runner gains normalisation, the Markdown-only entry, decoding and the guard's inputs, and loses its raw token count (T§1). Before Readability runs, since `parse()` mutates the document and returns neither, it reads `canonical` (the first `<link rel="canonical">`, resolved against the page URL, `http(s)` only) and `hero` (`og:image`, else `twitter:image`); C§4.3 pins the canonical rule, checked by the normalise fixtures, and the extension uses the same code.
- **Rules.** Turndown options from `shared/turndown-rules.json`, whose first version holds the runner's options and no added rules; Readability and `isProbablyReaderable` with their defaults, the extension's `charThreshold: 250` dropped (C§4.2).
- **Decoding.** Bytes arrive with their Content-Type and Blink's `TextDecoder` decodes them, sniffing `<meta charset>` when the header names none, as the extension's browser would.
- **Normalisation** in the bundle: NFC, CRLF to LF, trailing whitespace stripped per line, three or more newlines collapsed to two, one final newline (C§4.2). The blob's plaintext is this string as UTF-8 (C§4.2).
- **Spoken projection** in `packages/protocol`: syntax removed, link text kept and targets dropped, images dropped, headings and list items given a full stop when they lack terminal punctuation, escapes and references resolved, each spoken character mapped to its Markdown offset. `words` counts its whitespace tokens (C§4.2); the rules and expected counts go into the fixtures, which win (C§4.2, C§9). Sentences come from a deterministic rule-based splitter inside paragraphs, shared with iOS later.
- **Versioning.** Changing a library, the rules or the runner regenerates the fixtures and bumps the contract (C§4.2). The build script emits one artefact, the APK asset, with its sha256 as a constant (8.2); CI recomputes the vendored files' hashes against `shared/vendor/VERSIONS.md` and the asset's hash against the constant.

## 10. Build, release and distribution

- **Profiles** (`eas.json`): `development` (dev client APK), `preview` (release APK, arm64), `production` (AAB, Play App Signing). Local builds use `npx expo run:android --variant release` or Gradle, since EAS local builds aren't supported on Windows. `versionCode` is incremented remotely by EAS.
- **Windows long paths.** `LongPathsEnabled` is 0 on the build laptop, and the deepest `.cxx` path already reaches 247 of 260 characters before Reanimated, Skia and Nitro codegen. Fixes: Richard enables `LongPathsEnabled` (needs admin), the build points at CMake 3.31.4 (ninja 1.12 or later), or builds run from a short `subst` drive.
- **Play Console.** App ID `app.kefli` (FD 96), with sideloaded preview APKs before the internal track at the stage 2 gate; data safety declaring a public key, encrypted blobs and device keys on the operator's servers and no article text sent anywhere (FD 22); the `mediaPlayback` declaration; the deletion page (13.1); target 36.
- **Brand** (`shared/brand/README.md`): icons from `out/android`, the splash in 6.9, the notification glyph, the Play icon and feature graphic. The Expo template icons in `apps/mobile/assets/` go; `app.json` gets the real name and slug, `userInterfaceStyle: "automatic"`, the splash block, and `android.predictiveBackGestureEnabled: true`, which the root screens' system preview needs (5.1; the harness has it off). The week-0 gate checks that Back, swallowed Back included, still works with it on, and decides only whether in-app pops are predictive.
- **Licences.** The app is AGPL-3.0-or-later with an added permission for Play services and other proprietary system libraries (O-10); `apps/mobile/LICENSE` is Expo's template and is not committed, and the text is `LICENSE` at the repository root (copyright Mosarric Services Ltd), confirmed on 10 October 2026. Dependencies are MIT, Apache-2.0 (Readability, media3), ISC (Lucide), Unlicense (nostr-tools) and OFL 1.1 (the fonts), plus proprietary Play services for Block Store; react-native-quick-crypto's tarball has no LICENSE file, so its repository's is checked in week 0.

## 11. Testing at each stage

### 11.1 Unit, component and end-to-end

- **Jest on Node** for `packages/protocol` (ESM config in 2.4): normalise fixtures, IDN and mixed-script hosts included; item JSON round trips with unknown fields and refusal to write `v` above 1 (C§10); the 16 KB check and the URL cap, apart (4.2); the three item fixtures and one with `text` null, the connected-browsers record, the save-request wrap, the pair-ack and move pair-ack; the move and restore scenarios as decrypt-and-compare tests (C§9); the typed-code offer (`K7QM4XPD` gives lookup `8a0b73e6…2d76`, T§4) and the phone-pair offer; NIP-98 and wraps as verify and round-trip tests, since their signatures aren't deterministic (C§9); merge rules and the outbox as property tests, Undo over a queued row, a change merged into a held row, a refused prerequisite, dependents released while one relay never answers, and every mirror refusing included (4.3); Delete my data with the operator unreachable reaching `del-failed` (7.2); the inbox dedupe and `failed_blob` retry (4.7); the projection's offset map; the sentence splitter; the X link rule; Speed read timing and focus letter; the clock and ±15 rule; `node shared/cover/test.cjs`. `CryptoPort` uses `node:crypto` here.
- **React Native Testing Library** for every state table in section 5: strings, roles, focus and disabled controls.
- **Maestro** on a release APK: first launch to first share; offline share then reconnect; swipe and Undo; Reader position; Search; typed-code Connect; recovery-code restore; Delete my data against staging.

### 11.2 The on-device fixture harness

A `fixtures` route, built only into development and CI profiles, runs the twenty pages through `kefli-parser` with Hermes hashing, the normalise fixtures on Hermes, the cover fixtures on Skia, the crypto vectors (a signature and a NIP-44 encryption included) and a Keystore round trip, and writes a JSON report read over adb, on an x86_64 emulator in CI and on the Pixel before each gate (C§9). Contract tests against staging add publishing, a refused unauthorised 1059 read, a pair-ack to an authorised device accepted and one to an unknown key refused, a recipient's kind 5 removing a wrap, Blossom quota and 413, a mirror that refuses, the inbox round trip with the extension, sign-in with the indexer blocked (4.6), the move scenario, and restore with the operator off (C§8).

### 11.3 Device matrix

| Check | Stage 1 | Stage 2 | Beta |
|---|---|---|---|
| Share from Chrome, the X app, Gmail, a newsletter app, a PDF viewer's link | Chrome, X | all five | all five |
| X post with and without an outside link, and offline; a sign-in wall | required | required | required |
| Save offline and reconnect; kill the app mid-save | required | required | required |
| Share then lock at once: the save publishes (decides 4.8's fallback) | measured | required | required |
| Fixture hashes on device; live list of 30 URLs | 20/20; 20/30 | 20/20; measured | 20/20; 30/30 |
| Word highlight on Google's engine; sentence fallback on Samsung's | Google | both | both |
| An hour locked on battery: controls work, highlight right on unlock; no card left after ✕ or an article's end (T§3c rerun) | — | required | required |
| Battery Saver on: saves queue, background task, playback and lock-screen controls (P§6) | — | required | required |
| Bluetooth and car controls; a call taking audio focus | — | required | required |
| Media card with no notification permission (Android 13+): ±15 shown and working, bar display-only | required | required | required |
| Laptop save within 10 s, app open; phone idle 2 h | — | required; measured | same |
| Block Store: reinstall with Google Backup on and once with it off (Welcome), a share before the first open after reinstall (3.1), a new phone on the same Google account; a device-to-device transfer carries no library | — | required | required |
| Recovery-code restore; second-phone pairing, a laptop save then reaching both phones | — | required | by a tester |
| Amber, a `bunker://` signer, the probe refusal | — | required | required |
| Import; Delete my data verified on relay and server | — | required | required |
| Keep backup copies on and off; switching to a nostr app; restore with the operator off | — | — | required |
| Performance budgets (11.4); TalkBack over every state table | measured | budgets | both |

Devices: the Pixel 10a (Android 17), a Samsung with its own speech engine and battery manager, and an API 26 emulator. Locked, battery, timing and hash runs use release-profile builds (T Set-up).

### 11.4 Performance budgets (Pixel 10a, release build)

| Measure | Budget |
|---|---|
| Share tap to Saved sheet | 300 ms |
| Fetch to parsed article, ordinary page | 1 s (T§1: 0.5–0.6 s) |
| Pair-code scrypt | 150 ms |
| Schnorr verify, median; 1,000-item restore | 10 ms; 20 s |
| Reader at the saved word, 84 KB article | 300 ms |
| Search query at 2,000 saves | 30 ms |
| Saves list at 2,000 rows; eight covers drawing | 60 fps |

## 12. Timeline

| Week | Deliverables | Evidence |
|---|---|---|
| 0 | Done: the CR list sent and every request ruled, contract v1.3 signed (13.2); tokens 1.0.1 (FD 92); O-15 (f)–(h), G2's sheet, G3's lines and O-3's states approved and drawn under FD 91's jump names. To do: the token generator emitting 1.0.1; workspaces; protocol skeleton; normalise draft. Gates: react-native-quick-crypto (LICENSE file, 16 KB pages, arm64 release, scrypt time, x86_64 issue #1077, and `finalizeEvent` plus `nip44.v2.encrypt` succeeding on a release build once `install()` runs), Schnorr timing, share activity, detached parser WebView, JS stack and predictive back, eight Skia covers, font cuts; a `kefli-voice` spike (a `MediaSessionService` with `SimpleBasePlayer` driving the voice, the lock-screen ±15 buttons, 30 minutes locked on battery) | Gate results recorded |
| 1 | Key file, Block Store and the identity resolver, `LocalSigner`, register, schema, outbox, relay pool, share sheet and parser, encrypt, upload, mirror, publish, lists, `npm run decrypt` | An event decrypts with `npm run decrypt` |
| 2 | Welcome, New here, `welcome-early` and first-run Saves; Saves, Archive, swipe and Undo, offline, Reader, Aa, end card, inbound sync; `kefli-voice` with highlighting, the Reader tier and the media card (±15 buttons, artwork, estimated duration). Already done: O-15 (a)–(e) and (i) and O-17's count approved and drawn under FD 91's jump names, and contract v1.3 signed | Stage 1 gate |
| 3 | Inbox, Connect a browser, Connected browsers, Listen, the mini and Now playing, the lock-screen tap to the Reader, recovery code and backup card, Search | A laptop save appears |
| 4 | Bring back your library (scan, code, NIP-55, `bunker://`), restore, import, Add another device, Delete my data, Advanced, Play internal track | Stage 2 gate |
| 5 | Switching to a nostr app and the early-saves move, Speed read, Voice, Export, hardening, live list to 30/30 (FD 87) | Matrix complete |
| 6–7 | Beta: severity-1 fixes only, TalkBack pass, listing assets | No open severity 1 |
| 7–8 | Play production | Live on Play |

## 13. Integration points

### 13.1 Backend, extension and website

- **Backend:** by week 1, staging strfry with the allowlist, `POST /register`, an unauthenticated `/defaults.json`, Blossom quotas and 413; by week 3, `/devices` and `/pair-offers`, the relay accepting a kind 1059 whose `p` is an authorised device pubkey and serving it to that device after AUTH (C§3.2; `02-backend.md` §3.1 still requires a registered pubkey), NIP-59's recipient deletion of a 1059 and a wrap author's kind 5 (C§3.2, CR4), and `POST /phone-offers` and `GET /phone-offers/<lookup>` (C§6, FD 85); kind 10063 on the retention keep-list (`02-backend.md` §6 keeps only 10002).
- **Extension:** by week 3, wraps in the C§4.4 format against staging, seals signed by the device key (CR10), the canonical and hero rule (section 9), and the typed-code vectors. The phone ships, by week 1, `npm run unwrap -w packages/protocol`, which prints a wrap's rumor from a test secret, and `npm run decrypt -w packages/protocol`, which prints an item event's JSON from a test secret and checks its blob, so the extension and the stage gates can check output without a phone.
- **Website:** by week 6, the `delete-account` page Play requires, and the privacy note lines in 7.3.

### 13.2 Contract v1.3: the requests as landed

Contract v1.3 took in all eighteen requests, approved with section 14 on 5 October 2026 (C§11.9, whose item 19 also puts FD 86's rule for "nostr" into C§1). Each row records what landed.

| CR | Request, as settled | Status |
|---|---|---|
| 1 | The connected-browsers record, a self-encrypted kind 30078 at `d` = `kefli/devices`, merged by token with revocations kept; save requests accepted only from its connected entries | Landed, C§4.9, §4.4 |
| 2 | NIP-46 only by a pasted `bunker://` link, on its relays, with `perms` in `connect` (3.4) and a two-minute wait; a malformed link is a field error; NIP-55 asked for the same kinds; `nostrconnect://` and nsec pasting dropped | Landed, C§2 |
| 3 | Delete my data runs the operator, then every other server, then the phone (7.2); "confirmed" is an OK to every kind 5; a generated key's 10002 and 10063 are deleted, a nostr user's only rewritten | Landed, C§4.7 |
| 4 | The operator relay deletes a 1059 on its `p`-tagged recipient's kind 5 (NIP-59), accepts a wrap author's kind 5 for the extension's Undo, and drops wraps addressed to a deleted account | Landed, C§3.2 |
| 5 | Item deletions carry `["k","30078"]`, up to 50 addresses each, matching inbound sync's `#k` filter (4.5); restore fetches them and drops what they address | Landed, C§4.1, §8 |
| 6 | Play all and the end of an article follow FD 3, FD 35 and FD 54; Listen history stays on the phone (FD 83) | Landed, C§7 |
| 7 | Import takes web links only, from kind 39701 and legacy `r` tags in 10003 and 30003 sets, behind the prototype's sheet with no cap; `source_kind` is `web` only (FD 82) | Landed, C§4.6, §4.1 |
| 8 | Pins: Readability and `isProbablyReaderable` with their defaults, the extension's `charThreshold: 250` dropped; the first `turndown-rules.json`; the blob (normalised Markdown as UTF-8, ciphertext‖16-byte tag, no AAD); the guard; the projection behind `words`; `progress`; NIP-06 account 0 and empty passphrase | Landed, C§2, §4.1, §4.2 |
| 9 | `normalise(url, canonical?)`, its host through UTS-46 by `tr46`; `d` from the final URL with the canonical rule (section 9) for every kind of save; re-keying only before the first publish (FD 80); the X post rule; IDN cases in the fixtures | Landed, C§4.3 |
| 10 | Save requests: seal signed by the device key; `lang` and `hero` added; `truncated` dropped, HTML over 2 MB sent as `html` null; the guard in the extension; `saved_at` = `captured_at` (never later than now), repeat saves as G2 (4.2); X URLs follow FD 78; the QR's `relay` must be the operator relay | Landed, C§4.1, §4.4 |
| 11 | Second-phone pairing by an online exchange (FD 85, 3.6): `POST /phone-offers` signed by the user, `GET /phone-offers/<lookup>` with a throwaway key; NIP-49 dropped; Add another device hidden for nostr users | Landed, C§2, §6 |
| 12 | The switch also governs 10063 and keeps the user's entries and markers; "one default relay" = `defaults.relays[0]`; absence needs every indexer relay and two default relays; the move collects T's library, reads back from min(2, n) of T's relays and stops at a save from a newer Kefli; the early-saves move runs under the restore card | Landed, C§3.1, §4.8 |
| 13 | NIP-98 `payload` on every POST, PUT and DELETE; `created_at` within 60 s; `/defaults.json` and NIP-05 unauthenticated; `v` in every request body | Landed, C§6 |
| 14 | `defaults.json` schema `{v, operator:{relay, blossom, api}, relays[], indexer[], mirrors[]}`, `mirrors[]` tried in order (4.2); a refusing default retired within a day, and replaced where Kefli added it (4.6); "backed up" defined and counted (FD 93) | Landed, C§1, §3.1, §4.2, §5 |
| 15 | C§2's "at first launch" becomes "at New here, or at the first share"; the Block Store entry rules in 3.1 and 3.3 (FD 79) | Landed, C§2 |
| 16 | Inbox `since` allows for NIP-59's two-day tweak; only wraps that created, un-archived or matched a save are deleted | Landed, C§4.4 |
| 17 | Fixtures add the covers on Hermes, an item with `text` null, a move with one `d` T holds, a restore with a deletion, pinned-Chromium page fixtures, and vectors for the projection, NIP-06, the blob, the connected-browsers record and the phone-pair offer; signed fixtures are round-trip tests | Landed, C§9 |
| 18 | Copy the contract fixes follows the signed-off screens: the typed-code mismatch and "Connect this browser?" (§4.4), the probe refusal in FD 91 (d)'s words (§2), and the deletion explain screen with its all-devices line and a step per server (§4.7, FD 91 (e)) | Landed, C§2, §4.4, §4.7 |

## 14. Decided

Richard approved every recommendation in this section as a set on 5 October 2026, with no exceptions. Each item points to the flow decision that records it (FD 79–93). O-9's name is settled as Kefli by FD 95, and its app ID as `app.kefli` by FD 96; O-10 is recorded there.

| O | Question | Decision |
|---|---|---|
| 1 | Reinstalling where Block Store holds a key | FD 79: skip Welcome for Saves with the restore card; an early share stores that key and saves under it (3.1) |
| 2 | A link or offline X post resolving to another address, and so another `d` and cover | FD 80: re-key only before the first publish; the cover crossfades once; a published save's `d` and cover never change |
| 3 | The original page: drawn as Kefli's view, its build note saying Custom Tab | FD 81: the drawn view, Open in browser covering signed-in sites; loading, failure and offline drawn (`reader-original-loading`, `-failed`, `-offline`) |
| 4 | Importing `nostr-article` items, whose `d`, `url` and Open original were undefined | FD 82: web links only, from kind 39701 plus legacy `r` tags; the sheet will seldom show, which is accepted for a one-off |
| 5 | Listen history and "N listened" have no contract field | FD 83: they stay on the phone; a restored or second phone starts with an empty Listen tab |
| 6 | Laptop saves made while the phone is closed wait for a background window | FD 84: accepted; the 10 s gate is measured with the app open |
| 7 | A photographed pairing QR could be broken offline, and NIP-49 can't carry twelve words | FD 85: an online exchange through the operator (3.6), its endpoints due in week 3 (13.1) |
| 8 | The prototype uses "nostr" on four routes; `CLAUDE.md` allowed one button | FD 86: the prototype's wording stands, and `CLAUDE.md` now allows those routes |
| 9 | The app ID is permanent from the first Play upload and owns the Block Store data | Still open (`CLAUDE.md`): the name, or at least its domain, by the end of week 3 |
| 10 | `apps/mobile/LICENSE` is Expo's template | Decided in `CLAUDE.md`: not committed; AGPL-3.0-or-later with an added permission for Play services and other proprietary system libraries; the text is `LICENSE` at the root, confirmed on 10 October 2026 |
| 11 | Week 5 is free with iOS parked; the stage 2 gate named server audio | FD 87: week 5 as in section 12; the gate becomes an hour locked on battery with working controls and the highlight right on unlock |
| 12 | Crash reporting | FD 88: none in v1; Play vitals and the beta form |
| 13 | Small defaults | FD 89, by G number. G2: re-sharing an unread save changes nothing, offering Done and Read now with no Undo (`share-again`, FD 38); re-saving an archived one un-archives it at its new save time (4.2). G3: the embed service failing online saves the post address as pending, retried from 30 s doubling to an hour, with its own line on the Saved sheet and row (`share-embedfail`, `saves-embedfail`). G4: the original view offline says it needs a connection. G5: a full Blossom quota keeps the text on the phone and retries daily. G6: a connection lost mid-flow uses the notice slot and keeps the value. G7: Back on Listen or You goes to Saves; a warm resume keeps the screen; a lock-screen tap counts as opening straight into an article. G8: deletion copy counts the real backup servers. G9: an export failure line with Try again (`adv-exportfail`). G11: no own "Link copied" toast on Android 13+. G12: without a picture, the kind 0 name's first letter in a circle; with no name, or before kind 0 arrives, FD 12's counts line. Also: one speed value for the pill and Default speed; one Reader size and palette, following the phone until a palette is picked; voices for the last played article's language; Export as one HTML bookmark file with each save's text |
| 14 | Add another device for nostr users, who have no mnemonic; pasting an nsec | FD 90: the row is hidden for nostr users; nsec pasting stays out of v1 and out of C§2 |
| 15 | States neither the prototype nor FM drew | FD 91, each drawn under its jump name and put on the map before its week: (a) `restore-nothing`: nothing to restore after a sign-in, Block Store restore or pairing lands on first-run Saves with no card; (b) `nostr-timeout`: a NIP-46 expiry or `timeout` returns to the start with "Your nostr app didn't answer. Nothing has changed."; `nostr-badlink`: a bad sign-in link is a field error; (c) `sw-none` and `sw-probe` when switching; (d) `nostr-probe`: "Your nostr app can't keep your saves private yet. Try another app, or start a new library on this phone."; (e) Delete my data with a step per server, the explain line counting them and saying the library goes from all devices, `del` to `del-failed` amended; (f) `welcome-early-many` and the import count's plural; (g) `saves-empty-offline`: "Connecting a browser needs a connection", the button disabled; (h) `play-sentence`: the sentence highlight without word timing (5.7); (i) `sw-newer`: a move meeting a save from a newer Kefli in step 2 stops before copying and asks for an update (4.10) |
| 16 | TK 1.0.0's type values differed from CS and the prototype | FD 92: tokens 1.0.1 with the prototype's values and the fixed optical sizes of 6.3, before any component |
| 17 | A save refused by its default mirror or relays has no copy off the operator, which weakens "outlives the service" | FD 93: the next mirror is tried (4.2); saves not backed up are counted in Advanced (`adv-notbacked`); a refusing default is retired within a day; the claim stands while that count stays near zero, and the privacy note says a new save can briefly have only Kefli's copy (7.3) |

## 15. Risks

| Risk | Mitigation |
|---|---|
| `kefli-voice` overruns: a bespoke session with no time base | Spiked in week 0 (12), built in week 2; the clock rule is fixed here; the locked battery hour is a gate |
| secp256k1 or `react-native-quick-crypto` fails a week-0 gate | `kefli-secp` or the Kotlin crypto module behind the same ports |
| Parser WebView memory, main thread, missing provider | Detached, one job at a time, torn down after 30 s; `no_webview` is an honest failure |
| Process frozen after the share sheet closes | The spool and queued rows survive; the expedited fallback (4.8) |
| Hash drift between Blink, Hermes and V8 | Engines pinned per step (2.6), normalise's host step included; normalise and page fixtures on device; no over-the-air updates |
| Doze delays inbox drains | Accepted (FD 84) |
| Engines without word timing | Sentence fallback (`play-sentence`, FD 91 (h)), tested on Samsung |
| X withdraws or changes its embed service | The pending path covers it (G3) |
| Block Store prerequisites (Play services, screen lock, Android 12 off Pixel, Google Backup on for a reinstall) | The recovery code works everywhere |

## 16. Definition of done

C§9's fixtures and the cover fixtures pass in CI on every commit, under Node and in the device harness; every row of 11.3 is ticked; every state in section 5 matches its prototype state on the Pixel, checked by Richard; Richard has used the app daily for a month and a save from each of the five apps reads offline on the train; someone else has backed up, restored by recovery code and paired a second phone; the library survives a reinstall through Block Store with Google Backup on and returns anywhere through the recovery code; restore works with the operator off; a NIP-55 user and a `bunker://` user have saved; Delete my data is verified on relay and server; the Play listing carries the data safety form, the deletion page and a production release targeting API 36; O-9, the one item in section 14 left open, has its answer (FD 95 and 96); and the confirmed LICENSE file is committed.

## Appendix. Flow-map coverage

| FM state-matrix row | Section |
|---|---|
| Welcome, Bring back your library, Scan, Recovery code entry, Nostr sign-in, Restoring | 5.2, 5.3 |
| Saved sheet | 5.4 |
| Saves Unread and Archive, Search, Reader, Aa sheet | 5.6 |
| Mini player, Listen (FM's partial, error and offline rows are obsolete under FD 22) | 5.7 |
| Connected browsers, Connect this browser? | 5.5 |
| You, Recovery code sheet, Add another device, Voice, Advanced, Delete my data | 5.8 |
| Extension toast and options | `05-extension.md`; the phone's side is 5.5 and 13.1 |
| Prototype only: Speed read, switching to a nostr app, the import sheet, Connect's camera, type, refused and expired states, the original view, the lock screen | 5.3, 5.5–5.8 |
| Added by FD 91: the states in O-15, the original view's loading, failure and offline (O-3, G4), G2's repeat-save sheet, G3's lines, Advanced's not-backed-up count (O-17), the export failure (G9) | 5.2–5.8, 14 |
| Launch screens (system screens, FD 72) | 6.9, 10 |
