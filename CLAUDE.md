# Shelf — project memory for Claude Code

Working name **Shelf** (placeholder; the name appears in the protocol only as the `shelf/` d-tag namespace). A free read-it-later app, phone-first, whose library lives on nostr under the user's own key so it outlives the service. The v1 premise is the original 2011 Pocket: save anything, read it clean and offline, listen to it. No discovery feed, no social layer, no tags, no signup.

## Source of truth

1. `shared/contract/contract.md` — contract v1.2. Protocol, event kinds, API, limits. It wins over every other document. Change it only deliberately, bump its version, and add a changelog entry.
2. `docs/specs/01-project-plan.md` — sequence, gates, testing. Read the scope revision at the top.
3. `docs/specs/` — backend, extension and Android specs. They were written against contract v1.0; apply the contract's section 11 changelog where they differ. The iOS spec is parked.
4. `docs/design/flow-map-rev3.html` — UX flow map rev. 3, weight audit, state matrix, with the decision log `docs/design/flow-decisions.md` (later decisions override the map). Nothing gets built that isn't on the map; additions go on the map first.

## Current decisions

- **First build:** Android app plus the browser extension (Chrome and Firefox). iOS is deferred until there is an iPhone to test on.
- **Mobile stack:** Expo (React Native, TypeScript), confirmed by the Android spike below. Use development builds and EAS, not Expo Go.
- **Extension:** Manifest V3 WebExtension in TypeScript, one codebase, Chrome and Firefox builds. Test in developer mode (unpacked on Chromium, `web-ext run` and signed unlisted `.xpi` on Firefox) until launch; see extension spec section 11.
- **Backend:** one VPS running strfry (relay), a Blossom server, and a Go API. See backend spec.
- **Listening:** on-device text-to-speech only in v1 (flow decision 22). The Kokoro TTS worker and audio API in the backend spec are deferred to a later subscription feature set; don't build them for v1.
- **Protocol essentials:** private saves are NIP-78 kind 30078, `d` = `shelf/item/<sha256 normalised URL>`, `t` = `shelf`, NIP-44 self-encrypted. Article text is an AES-GCM encrypted Blossom blob, mirrored. Saves go to three relays by default (ours plus two public ones). The extension has its own device key and never holds the user's key; it sends NIP-59 gift wraps carrying only a blob hash and key. No event over 16 KB.
- **Parser:** `@mozilla/readability` 0.6.0 plus `turndown` 7.2.4, vendored in `shared/vendor/`. The same JS runs in the extension and in a hidden WebView on the phone, so article hashes match.
- **Visual style:** Fingerprint, chosen by Richard in October 2026 from a five-way design study (`docs/design/study/`, flow decisions 65 to 68). Every save draws its own cover from the sha256 in its d tag, identical on every device and versioned forever (cover v1). The chrome is ink, paper, two greys and hairlines with no brand colour (Terracotta is retired); Archivo and Archivo Expanded for the interface, Literata for reading, Martian Mono for player clocks; Lucide icons at 1.75 stroke. Values are in `shared/tokens/tokens.json` (1.0.0, frozen at the Stage 0 sign-off, flow decision 75), generated out to every platform. Screens are local HTML prototypes in `docs/design/mockups/` (Figma was dropped), signed off on 5 October 2026 as the reference the build is checked against.

## Repo layout (target)

```
apps/mobile      Expo app (Android first)
apps/extension   WebExtension (Chrome + Firefox)
apps/web         website: landing, privacy, extension install guide; later the web reader (React + Untitled UI)
server/          api (Go), tts (Kokoro), deploy (Ansible, strfry.conf, Caddy)
packages/protocol  shared TS: normalise, event builders, encryption, types
packages/ui      Untitled UI wrappers for web + extension
shared/          contract, fixtures, vendor JS, tokens, defaults.json
docs/            specs, design, research
```

## First task: the Android spike (one evening)

Resumes after contract v1.2, now written (flow decision 75). The scaffold in `apps/mobile` and `shared/vendor/` is uncommitted and none of the three tests has run yet.

In a bare Expo development build on a real Android phone:
1. Receive a link shared from X and parse it with Readability in a hidden WebView.
2. Speak a paragraph with `expo-speech` and log what `onBoundary` returns; we need character positions to highlight words.
3. Play an audio file with `expo-audio` for five minutes with the screen locked (lock-screen controls must be on, or Android stops playback after about three minutes).

If all three work, Expo is confirmed and the Android spec is rewritten as an Expo mobile spec. If `onBoundary` lacks positions, plan a small native module; that does not change the decision.

## Rules

- **Writing, everywhere (UI copy, docs, commit messages, website):** never use the inverted-emphasis construction ("it's not X, it's Y", "what it won't do is the point", "that's the bar", or any withheld-payload punchline). British spelling. No nostr jargon on any user-facing screen except the "Sign in with your nostr app" button.
- **UI:** text inside any bordered or filled element (buttons, chips, tags, badges) must be vertically centred. Every screen designs its empty, loading, partial, error and offline states, not only the populated one.
- **Process:** flow before screens, tokens before components. When a change is requested, check it against the flow map and the contract before building; if it doesn't fit, update those first or say why not.
- **Code:** run the code-gate CRAP check before any commit to main. Every platform's CI must pass the shared fixtures before merge. No secrets in the repo.
- **Honesty in claims:** the pitch may say the library outlives the service only because saves and text are mirrored off our servers by default. Don't weaken that mirroring without changing the claim.

## Open items for Richard

- Name, and the licence (open-sourcing the clients supports the "outlives the service" story; AGPL stops a closed fork).
