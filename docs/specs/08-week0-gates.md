# Week 0 gates: results

The gates in the mobile spec's section 12 (week 0), run on 6 October 2026 on the Pixel 10a (Android 17), from a release build (`assembleRelease`, arm64-v8a) made on the new desktop. The harness is the "Week 0 gates" tab of `apps/mobile`, whose results go to logcat under `[shelf-gates]`; the code is in `apps/mobile/src/gates/`.

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
| Schnorr timing (spec 11.3: verify median ≤ 10 ms, 1,000-item restore ≤ 20 s) | **Fail** | verify median 29 ms; 1,000 saves verified and decrypted in 30.9 s; signing 42 ms; ECDH 52 ms (noble on Hermes). The spec's fallback applies: `shelf-secp` (section 8) |
| normalise fixtures on Hermes | Pass | all 85 cases match |
| Hermes Unicode | Pass | NFC and `\p{…}` property escapes behave as on V8 |
| text_hash, projection, offsets and sentences against Node | Pass | four samples (accents, Greek, Cyrillic, Japanese, emoji, entities, code, raw HTML) match Node exactly |
| Cover v1 fixtures on Hermes | Pass | all 64 cases match every recorded value (palette, leaves at depths 1 to 3, SVG and its hashes, line ink, highlight, night) in 88 ms |
| Eight Skia covers | Pass, first look | the eight covers draw through Skia's SVG path at 80 px, depth 3, parsed in 39 ms. The spec's Skia paths with the draw-in animation are built in week 2 |
| Font cuts | Pass, first look | the fifteen cuts from `shared/fonts/cut-fonts.py` load through expo-font and draw. Capital centring in filled buttons still has to be measured (CS Components) |
| Share activity | Not run | needs the `shelf-share` native module |
| Detached parser WebView | Not run | needs the `shelf-parser` native module |
| JS stack and predictive back | Not run | needs the router set up |
| `shelf-voice` (media session, ±15 on the lock screen, 30 minutes locked on battery) | Not run | needs the `shelf-voice` native module |

## Found on the way

- **whatwg-url's `URL` class can't load on Hermes.** Its `webidl-conversions` reads `SharedArrayBuffer.prototype` at load, and Hermes has no `SharedArrayBuffer`. `shared/normalise.ts` now works on the URL Standard's record through whatwg-url's own state machine (`basicURLParse`, `serializeURL`), which never loads that code; the output is unchanged (all fixtures pass), and `packages/protocol/test/hermes.test.ts` loads the package with `SharedArrayBuffer` removed so this can't come back unnoticed.
- **Skia needs Reanimated** at runtime; Reanimated 4.5.1 and Worklets 0.10.1 (the spec's pins) are installed.
- **npm 11 blocks install scripts.** Skia's postinstall, which copies its prebuilt libraries from its own npm packages (no download), is allowed in the root `package.json` for 2.6.2 only.
- **Gradle doesn't see JavaScript outside `apps/mobile`.** A change in `shared/` or `packages/` leaves the release bundle stale until `app/build/generated/assets/react` is deleted. To be fixed in the build setup before week 1 (the React Native Gradle plugin's `root` should be the repository).

## Next

1. `shelf-secp`, as the spec's section 8 describes: ACINQ `secp256k1-kmp-jni-android` 0.24.0 for Schnorr signing and verifying, and ECDH through `pubKeyTweakMul` taking the x coordinate. `LocalSigner` and the relay pool's verifier then call it, and this gate runs again.
2. The native gates: share activity, detached parser WebView, predictive back with the JS stack, and the `shelf-voice` spike.
