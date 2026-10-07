# Week 0 gates: results

The gates in the mobile spec's section 12 (week 0), run on 6 and 7 October 2026 on the Pixel 10a (Android 17), from a release build (`assembleRelease`, arm64-v8a) made on the new desktop. The harness is the "Week 0 gates" tab of `apps/mobile`, whose results go to logcat under `[shelf-gates]`; the code is in `apps/mobile/src/gates/`.

## Results

| Gate | Result | Evidence |
|---|---|---|
| quick-crypto installed as `globalThis.crypto` before nostr-tools loads | Pass | `getRandomValues` works on Hermes |
| quick-crypto: AES-256-GCM | Pass | NIST GCM test case 14 matches; an 84 KB round trip takes about 1.5 ms; a tampered blob is refused |
| quick-crypto: scrypt time (typed code) | Pass | `K7QM4XPD` gives the reference lookup in 52 ms (2,600 ms in JavaScript, `07-android-test-build.md` section 4) |
| quick-crypto: PBKDF2 (recovery code) | Pass | NIP-06's example mnemonic gives its key in 342 ms |
| quick-crypto: `finalizeEvent` and `nip44.v2.encrypt` on a release build once `install()` runs | Pass | signs and verifies; all ten NIP-44 v2 encrypt/decrypt vectors pass; self-encryption round trips |
| quick-crypto: 16 KB pages | Pass | `zipalign -c -P 16` passes, and every one of the APK's 17 native libraries, `libQuickCrypto.so`, `libNitroModules.so` and `librnskia.so` among them, has 16 KB LOAD segments (`llvm-readelf`) |
| quick-crypto: arm64 release | Pass | the rows above ran on an arm64 release build |
| quick-crypto: LICENSE file | Finding | the npm package of 1.1.7 ships no LICENSE file; its `package.json` declares MIT. The app's licence notices take the text from the upstream repository |
| quick-crypto: x86_64 issue #1077 | Not run | needs an x86_64 emulator (the CI device harness, spec 11.2) |
| Schnorr timing (spec 11.3: verify median ≤ 10 ms, 1,000-item restore ≤ 20 s), noble on Hermes | Fail | verify median 29 ms; 1,000 saves verified and decrypted in 29.5 to 30.9 s; signing 42 ms; ECDH 49 to 52 ms. The spec's fallback, `shelf-secp`, was built |
| `shelf-secp` (section 8): libsecp256k1 through ACINQ `secp256k1-kmp-jni-android` 0.22.0 | Pass | all 15 BIP-340 vectors with 32-byte messages (`packages/protocol/test/vectors/bip340.vectors.csv`); NIP-44 conversation keys match noble; its signatures verify in noble; `libsecp256k1-jni.so` has 16 KB LOAD segments |
| Schnorr timing with `shelf-secp` | Pass | verify median 0.25 ms; 1,000-item restore 0.9 s; signing 1.0 ms; ECDH 0.28 ms |
| normalise fixtures on Hermes | Pass | all 85 cases match |
| Hermes Unicode | Pass | NFC and `\p{…}` property escapes behave as on V8 |
| text_hash, projection, offsets and sentences against Node | Pass | four samples (accents, Greek, Cyrillic, Japanese, emoji, entities, code, raw HTML) match Node exactly |
| Cover v1 fixtures on Hermes | Pass | all 64 cases match every recorded value (palette, leaves at depths 1 to 3, SVG and its hashes, line ink, highlight, night) in 88 ms |
| Eight Skia covers | Pass, first look | the eight covers draw through Skia's SVG path at 80 px, depth 3, parsed in 39 ms. The spec's Skia paths with the draw-in animation are built in week 2 |
| Font cuts | Pass, first look | the fifteen cuts from `shared/fonts/cut-fonts.py` load through expo-font and draw. Capital centring in filled buttons still has to be measured (CS Components) |
| Share activity (`shelf-share`, spec 8.5) | Pass | Shared from Chrome and from X through the system share sheet: the translucent card shows over the sender, closes on its 4 s countdown or Done, and the sender is back on top (Chrome, X). The share is spooled to `filesDir/share-spool` before JavaScript runs; spool to first render 166 to 259 ms with the app cold, 8 to 9 ms warm; the window is up 34 ms after the tap. Read now opens MainActivity on `shelf://reader/<hash>` |
| Detached parser WebView (`shelf-parser`, spec 8.2) | Pass | A WebView on the main looper from the application context, attached to no window, with network loads blocked; the bundle loads from the APK asset only after its sha256 matches `ParserBundle.SHA256`, and jobs pass through the `ShelfHost` interface. Five sample pages (UTF-8 with a relative canonical and `og:image`, windows-1252 labelled by `<meta>` only, a header charset overriding `<meta>`, a page with its own relative `<base>`, a short page that isn't readerable) give exactly desktop Chrome 150's result, every field and every byte of Markdown (`apps/mobile/scripts/parser-expectations.mjs`). First parse 223 ms with the WebView starting, then under 8 ms a page; after 30 s idle the WebView is torn down and the next parse takes 90 ms. A live page (Wikipedia, 117 KB, fetched as bytes) parses in 207 ms to a titled article of 1,235 words with its canonical |
| JS stack and predictive back | Pass | `expo-router` 57.0.25's `js-stack` with the motion spec's push and pop (fade with 24 px of travel, `motion.enter` in, `motion.exit` out). React Native 0.86 forwards only the committed back to JavaScript, never the gesture's progress, and the JS stack has no predictive-back handling, so in-app the pop plays on release, as the spec's fallback says; on the Pixel the pushed screen stays put during the swipe and leaves on release, and a cancelled swipe leaves it. On the root screen Android's back-to-home preview follows the finger, once `shelf-system`'s `setRootBack` switches off React Native's back callback (below). Checked by Richard's swipes |
| `shelf-voice` (media session, ±15 on the lock screen, 30 minutes locked on battery) | Not run | needs the `shelf-voice` native module |

## Found on the way

- **whatwg-url's `URL` class can't load on Hermes.** Its `webidl-conversions` reads `SharedArrayBuffer.prototype` at load, and Hermes has no `SharedArrayBuffer`. `shared/normalise.ts` now works on the URL Standard's record through whatwg-url's own state machine (`basicURLParse`, `serializeURL`), which never loads that code; the output is unchanged (all fixtures pass), and `packages/protocol/test/hermes.test.ts` loads the package with `SharedArrayBuffer` removed so this can't come back unnoticed.
- **Skia needs Reanimated** at runtime; Reanimated 4.5.1 and Worklets 0.10.1 (the spec's pins) are installed.
- **npm 11 blocks install scripts.** Skia's postinstall, which copies its prebuilt libraries from its own npm packages (no download), is allowed in the root `package.json` for 2.6.2 only.
- **Gradle doesn't see JavaScript outside `apps/mobile`.** A change in `shared/` or `packages/` leaves the release bundle stale until `app/build/generated/assets/react` is deleted. To be fixed in the build setup before week 1 (the React Native Gradle plugin's `root` should be the repository).

- **ACINQ 0.24.0 can't be used yet.** 0.23 and later are built with Kotlin 2.3, whose metadata React Native 0.86's Kotlin 2.1 compiler can't read; suppressing the check would also put a Kotlin 2.3 standard library under every other module. `shelf-secp` pins 0.22.0 (Kotlin 2.2.21), which has the same Schnorr and ECDH calls; the spec's section 8 says so.
- **The secp work sits behind a port.** `packages/protocol`'s `SecpPort` carries public keys, BIP-340 signing and verifying, and the ECDH x coordinate; `LocalSigner`, gift wraps and `verifyEventWith` take it, defaulting to noble (the extension, Node), and the phone passes `nativeSecp` (`apps/mobile/src/crypto/secp.ts`). `verifyEventWith` never trusts nostr-tools' cached verified flag.

- **The share sheet gives Shelf its own task.** Android's share sheet launches its target with `NEW_DOCUMENT` and `MULTIPLE_TASK`, so `ShareActivity` runs in a new task, not the sender's as spec 8.5 expects; finishing it still returns to the sender, which is what flow decision 39 asks. Spec 8.5 should say so.
- **The referrer is null through the share sheet.** `Activity.referrer` names the sender only when an app starts the activity directly. Nothing in v1 depends on it; the spool keeps the field.
- **`expo-share-intent` is gone** from the test build (spec 2.4), so MainActivity no longer registers as a share target.

- **The runner now matches spec 9.** `shelfParse(bodyBase64, contentType, url)` decodes as a browser does (byte order mark, then the Content-Type charset, then `<meta>` in the first 1,024 bytes, then UTF-8), reads `canonical` and `hero` before Readability (contract 4.3, http(s) only, against the page's address), keeps a page's own `<base>`, and returns normalised Markdown; `shelfMarkdown` takes an extension's content HTML. The rules come from `shared/turndown-rules.json`, embedded in the bundle so its sha256 pins them. `packages/protocol/test/runner.test.ts` holds the runner's Markdown normalisation to the protocol's.
- **The bundle is one artefact.** `shared/vendor/build-parser-bundle.mjs` writes the APK asset and its sha256 constant into `apps/mobile/modules/shelf-parser`, and `--check` also compares the vendored files with `VERSIONS.md`. The test screen parses through `shelf-parser` too, so the old inline bundle is gone.

- **React Native hides Android's back-to-home preview.** On target SDK 36 `ReactActivity` keeps an `OnBackPressedCallback` enabled at all times, so the system never shows its preview. `shelf-system`'s `setRootBack(atRoot)` finds that private callback by its type and disables it while the JS stack is at its root with nothing open; the root layout calls it on every route change, and anything that opens over the root (a sheet, a dialog) must call it with false.

## Next

The one native gate left: the `shelf-voice` spike.
