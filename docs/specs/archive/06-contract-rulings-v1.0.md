# Project engineer: rulings on the engineers' objections (contract v1.1)

Each engineer read contract v1.0 and raised objections in their own document. This is the project engineer's ruling on every one of them. Where a ruling changes the contract, the change is stated in the words that go into v1.1. Nothing else in the contract moves.

## 1. Which Readability is canonical (raised by iOS, Android, extension)

All three client engineers found the same hole: the contract fixes the HTML-to-Markdown rules but never says which Readability produces the HTML, and three different ports would produce three different `text_hash` values for one article, so the audio cache would miss silently across platforms.

Ruling. `@mozilla/readability` 0.6.0 is canonical and is vendored under `shared/` together with `turndown` 7.2.4; a bump of either regenerates the twenty fixture hashes and is a contract version change. The extension runs it on the live DOM. Android runs it in a hidden WebView, as the Android engineer proposes, so the JVM port is out. On iOS, the Safari share path runs it inside Safari through the preprocessing script, which is the canonical implementation; the URL-only path uses the Swift port and is expected to miss the cache sometimes, and the app should re-parse such items with Readability.js in a WKWebView on next foreground so the hash converges. In addition, `text_hash` is computed over a normalised Markdown form: Unicode NFC, CRLF to LF, trailing whitespace stripped from every line, runs of three or more newlines collapsed to two, and a single trailing newline. The fixtures gain the Readability output HTML as an intermediate file so the Markdown step can be tested on its own. The contract also states plainly, as the Android engineer asks, that a share-sheet save (fetched HTML) and an extension save (rendered DOM) of the same URL may legitimately produce different hashes, and an audio miss in that case is expected behaviour.

## 2. Android key storage (raised by Android)

The contract named `EncryptedSharedPreferences` with Auto Backup. The Android engineer points out that the library is deprecated and the combination cannot work as written.

Ruling. Section 2 is replaced for Android with the engineer's design: the mnemonic and derived key are stored in a file under `noBackupFiles`, encrypted with AES-256-GCM under a Keystore key, StrongBox-backed where available, plus the mnemonic placed in Google's Block Store so that it restores on a new device signed into the same Google account. The device test is reworded to "reinstall on the same Google account, and restore to a new phone signed into the same Google account". iOS keeps the Keychain with `kSecAttrSynchronizable`.

## 3. `Signer.capabilities()` and the NIP-44 probe (raised by Android and iOS)

Ruling. The `Signer` interface gains `capabilities()` returning at least `{ nip44: boolean }`. Every platform performs the same probe at sign-in: encrypt the fixed string `shelf-probe` to the signer's own pubkey, decrypt it, compare. A signer that fails is refused with the copy already in the contract.

## 4. NIP-42 and remote signers (raised by iOS and backend)

Ruling. The relay accepts an AUTH event whose `created_at` is up to 3,600 seconds old, so a client reuses one signature per hour across reconnects and a bunker user is asked once an hour at most. Any REQ for kinds 30979 or 1059 must name the authenticated pubkey in `authors` or `#p`, following strfry's `restrictReadToInvolvedPubkey`; this is written into section 3 so every client does it.

## 5. Write policy for kind 1059 (raised by backend and extension)

The contract said writes of kind 1059 are accepted only from authenticated pubkeys, and the allowlist from `/register` would then refuse both the extension's throwaway wrap key and the phone's pairing acknowledgement to an unregistered key.

Ruling. Section 3 is reworded: the relay accepts a kind 1059 from any authenticated connection provided the wrap's `p` tag names a registered pubkey, and from a registered authenticated pubkey addressed to any `p`. The relay serves a REQ for kind 1059 with `#p` equal to the authenticated pubkey for any pubkey that can AUTH, registered or not, so the extension can receive its acknowledgement. The relay frame limit is 1 MiB to carry the 512 KB HTML ceiling.

## 6. Pairing acknowledgement and wrap fields (raised by extension)

Ruling. The extension engineer's pairing protocol is adopted as written in their section 3: the extension shows the QR, the phone scans, and the phone replies with a kind 1059 wrapping a rumor of kind 978 that carries the user's pubkey, relay list and a per-browser token. Kind 978 is added to section 4. The kind 979 rumor gains `token` (the per-browser token, checked by the phone and revoked from "Connected browsers") and `truncated` (true when the HTML hit the 512 KB ceiling). When `html` is empty the phone fetches and parses the URL itself. The fixture kind 1059 is supplied with the recipient's secret so the round trip test is real.

## 7. Audio API details (raised by backend and Android)

Ruling. `eta_seconds` is the server's measured estimate from queue depth and article length, and the example value is removed. `POST /audio` gains a 413 `too_long` error for text above 60,000 words and a `failed` status with a reason. The cache is bounded by size per tier as well as the 90-day age rule. `GET /audio/<id>` is readable by any registered pubkey, stated explicitly. Plaintext sent for generation is held only on tmpfs and deleted within one hour of the job finishing or failing, never written to persistent storage; this is the sentence the Android data safety form quotes.

## 8. Definition of `words` (raised by Android)

Ruling. `words` is the count of whitespace-separated tokens of the spoken-text projection, which is the Markdown with syntax characters removed and link targets dropped. The fixtures carry the expected count for each of the twenty articles.

## 9. Deletion semantics (raised by iOS and backend)

Ruling. "Delete my data" wipes the synchronised keychain item, which on iOS removes the key from every device on the same iCloud account; the dialog copy on both platforms says "This removes your library from all your devices." The backend cannot delete relay events itself; the phone publishes the kind 5 deletions first, and the relay's retention rule drops events from de-registered authors after 30 days as a backstop.

## 10. The kind 1059 listener while suspended (raised by iOS)

Ruling. The contract's "within ten seconds" holds while the app is open. Suspended, Android drains the subscription on a periodic WorkManager job and on any foreground; iOS drains on launch and on background refresh when granted. The extension toast therefore says "Saved. It'll be on your phone next time you open the app" when the acknowledgement does not arrive within ten seconds, rather than implying failure.

## 11. Privacy note on images (raised by Android)

Ruling. Images are fetched from their origin at read time, which reveals the article URL to that site; this goes in the privacy note as one line and is acceptable for v1.

## 12. Timeline cross-check

Backend weeks 0–4, Android weeks 0–4, extension weeks 3–4, iOS weeks 4–8 with TestFlight in week 6: the four documents agree with the master plan and with each other. The one shared evening every engineer asks for is the week 1 relay auth session between backend and Android; the project engineer books it. Stage gates stand as written.
