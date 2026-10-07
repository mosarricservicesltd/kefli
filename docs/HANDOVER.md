# Handover: picking Shelf up on another computer

Written on 6 October 2026, when the work moved off the laptop it started on. Everything needed is in this repository; this page says where things are, what is in flight, and how to set a new machine up. `CLAUDE.md` stays the project's standing brief and Claude Code reads it automatically; this page adds the state of play.

## Where things stand

- **Stage 0 design is signed off** (flow decision 75): the phone prototype `docs/design/mockups/prototype.html` (125 states), the extension prototype `extension.html`, the flow map `docs/design/flow-map-rev3.html` and the decision log `docs/design/flow-decisions.md` (decisions 1 to 93, later ones win).
- **Contract v1.4** (`shared/contract/contract.md`) is the source of truth for the protocol. v1.4 (6 October 2026) only settles what normalisation, the spoken projection and the typed-code offer left open (its section 11.1); Richard left those choices to Claude's judgement.
- **The mobile spec is written:** `docs/specs/03-mobile.md`, version 2.1, Expo with Android first. Its section 12 is the build timeline. Of week 0's code, the token generator (`shared/tokens/build-ts.mjs`, emitting `packages/tokens`), the npm workspaces, the protocol skeleton (`packages/protocol`), the normalise draft (`shared/normalise.ts` with `shared/normalise.fixtures.json`, its open choices listed in the fixtures' `draft` notes) and `shared/turndown-rules.json` were done on 6 October 2026. The library gates listed there need the phone build and are still to do.
- **The Android test build passed** on a Pixel 10a (`docs/specs/07-android-test-build.md`). `apps/mobile` holds that test screen only; the app proper starts from the spec.
- **Tokens** are 1.0.1 (`shared/tokens/tokens.json`).
- **The build:** weeks 0 and 1 of the mobile spec's timeline are done against the local stack. Week 2 started on 7 October 2026 with inbound sync (spec 4.5, phases 1, 3 and 5): the identity's lists, saves and deletions paged from every read relay, the merge rules in `packages/protocol/src/merge.ts`, and texts fetched, decrypted and indexed. A reinstalled phone gets its library back from the relays this way. The first screens followed the same day:
  - **Welcome:** Welcome and New here, plus Bring back your shelf, whose three routes are week 4.
  - **Saves:** Unread and Archive, with swipe, the toast with Undo, the row menu, and the empty, offline and sync-line states.
  - **The Reader:** laid out at the saved word, with the Aa sheet, the end card, the ⋯ menu, the loading and offline states, and the original-page view.
  - **Where they live:** the screens are in `apps/mobile/src/screens`, their parts in `src/ui` and the Reader's logic in `src/reader`. The Android test build's gates moved to the `/gates` route (`adb shell am start -d shelf://gates`).
  - **Listening (`shelf-voice`):** rebuilt the same day on file synthesis, as week 0 decided. Sentences are written a few ahead and played through Shelf's own AudioTrack, and the word is read from the playback head. It has the Listen chip, the Reader tier with the spoken word lit and followed, and the mini on other screens. Android now names Shelf's session the media button session, so hardware play, pause and next (+15) reach it, and the lock-screen card works.
  - **Covers draw in** (signature 1): leaf by leaf from cover v1's own SVG, once per surface, recorded in `cover_drawn`. A save that joins while Unread is on screen draws as it lands, and Welcome's three covers draw on first launch. The Saved share sheet (with its drawing cover) is still the week 1 functional card.
  - **Images** (sync phase 6): kept in app storage under `img/<sha256 of the address>`, at most 5 MB each and 200 MB in all, archived articles' first to go. The newest 50 unread articles' images are fetched on Wi-Fi, and an article's own when it opens. The Reader shows them at their published size, a 3:2 placeholder while they come, and keeps the word at the top still as they arrive.
  - **Pending parses** (sync phase 7): a share made offline is saved and waits on the phone. Once online it is fetched and parsed, then re-keyed by its final address if still unpublished (FD 80), joining an existing save if there is one, and then sent. A page that can't be read is sent without text. Shares and pending parses share one page fetch (`services/page.ts`), which tries the mobile user agent after a 403 and enforces the 5 MB cap and 20 s timeout. Shared X posts (5.4) are checked through X's embed service, with `t.co` followed five hops at most: the first link that leaves X is saved, and a post with no article saves nothing. Offline, or with X not answering, the post waits as a pending save and is checked again (retried from 30 s, doubling to an hour, while X fails), then re-keyed to its article (FD 80).
  - **The lock-screen card** carries the article's cover, rendered offscreen by Skia at 512 px, as its artwork, and Shelf's one-colour glyph as its small icon. The `with-shelf-notification` plugin copies the glyph from `shared/brand/out/android` at prebuild, so after a fresh clone run prebuild before building.
  - **Search** (5.6, 4.9): FTS5 prefix queries ranked by bm25 across Unread and Archive, plus a title, site and address match for saves whose text isn't here yet. Results update with every keystroke, and "Nothing matches" waits for a 250 ms pause. Archived results are tagged, and a swipe changes a result in place. Back from a Reader keeps the query; it resets only when Search is entered from Saves.
  - **The locked battery hour** (FD 87, 11.3) ran on 7 October 2026 on `World War II` (25,574 words), from 13:38 to 15:07. It played locked and unplugged with Doze on, and every 30-second tick of `shelf-voice.log` landed. The lock-screen pause, play and ±15 all reached Shelf, and the battery went from 100% to 99%. It found one bug: after a skip, the word stopped following the voice (fixed in `207ed23`, checked on the phone). Richard accepted the run without a rerun.
  - **Still to come in week 2:** the stage 1 gate. Its Chrome part needs the extension, due in week 3.
- **Week 3 started on 7 October 2026 with the Listen tab** (5.7). It has Now playing with the cover band, the minute ruler, the word meter and the controls; Played, most recent first, kept in `listen_history`; Play all, a snapshot played to its end; and the mini handing over as the card scrolls away (FD 52). The ruler widens its step for long articles, at most nine numbers (RULED in `voice/clock.ts`). You followed the same day:
  - **The screen:** the quilt and counts, the backup card (Later snoozes it for ten more saves), and the rows.
  - **The recovery code sheet:** the words are read from the key file only on "Show the words", and the window is secured while the sheet is open. Copy marks the clipboard as sensitive. `ShelfSystem.setSecure` and `copySensitive` are the new native functions.
  - **Connected browsers** (5.5, contract 4.4 and 4.9) followed on 7 October 2026:
    - **Connect:** scan the browser's QR with `expo-camera`, or type its code. The camera explanation shows only until CAMERA is granted, and refused, expired and Can't connect each have their own state.
    - **Sending:** Connect queues `post_device` then `pair_ack` and runs the outbox while the button is busy. Any failed attempt is Can't connect: the rows are withdrawn and a device the API already took is let go with `delete_device`.
    - **The record:** the connected-browsers record (`d` = `shelf/devices`) goes out with `publish_lists` to the write relays. It comes back in with the saves and merges by token, republished when this phone holds more.
    - **The list:** each browser with Disconnect, which revokes at once, republishes the record and queues `DELETE /devices`.
    - **Schema v2:** `devices` is keyed by token (RULED in `data/schema.ts`), since a browser connected again keeps its key and gets a new token.
    - **Microphone:** the build no longer asks for it. `expo-audio` had added it by default.
    - **Testing without the extension:** `npx tsx server/dev/browser.ts` plays the extension's part. It shows a QR in the terminal and in `server/dev/data/pair.html`, with the typed code under it, then waits for the pair-ack.
  - **Not yet built:** the inbox (4.7), so browser saves arrive, and the screens behind Add another device, Advanced and Delete my data.

## Open with Richard

1. **The app icon is being revisited.** Today's icon is cover C·L·063 on pattern P012 (decision 70). Richard was unsure about its colours, so a pattern-and-colour study was built: `docs/design/icons/pattern-colour-study/` (its README explains how it was made), published privately at https://claude.ai/artifact/8abd8kauAgihkxQdCopU5E. When he picks a pattern and colour, record a decision amending 70, freeze the new artwork in `shared/brand/src`, rebuild the brand files and hand-tune the small cuts.
2. **New copy in the prototype's newest states** (decisions 89 and 91: the re-share sheet, X post failures, sign-in timeouts, switching without a nostr app, the original page's loading and failure, Advanced's not-backed-up count and export failure) was drafted, not yet read by Richard. `docs/design/tour.html` can take them as a chapter.
3. **The licence text:** decided as AGPL-3.0-or-later with a permission for Google Play services and other proprietary system libraries (mobile spec O-10); the LICENSE file is added once Richard confirms the exact text. `apps/mobile/LICENSE` is Expo's template and is deliberately not committed.
4. **The name** (mobile spec O-9): needed, or at least its domain, by the end of build week 3, because the Play app ID is permanent from the first upload.

## Known issues

- **A share can hang its card on a cold start (seen twice on 7 October 2026, not reproduced since).** When a share starts Shelf's process while an old MainActivity is still listed in the background, the "main" surface starts alongside the "share" surface, and the share card stops drawing after its save. The save itself is recorded and its rows are released at the next start, so nothing is lost; the card stays grey until Back. To look at in week 2 with the real share sheet.

## Setting up a new machine

Install Git, Node 24, Google Chrome, and for the phone build JDK 17 and the Android SDK (Android Studio installs it; set `ANDROID_HOME`). Then:

```bash
git clone git@github.com:richardminton-glitch/Shelf.git
```

On this laptop the remote is the SSH alias `github-shelf`; on a new machine clone with your own GitHub SSH key as above, or over HTTPS (`https://github.com/richardminton-glitch/Shelf.git`). Some networks block SSH's port 22: if `git push` times out, add this to `~/.ssh/config` and clone from `git@github.com:` as usual.

```
Host github.com
  HostName ssh.github.com
  Port 443
```

| Task | How |
|---|---|
| Look at the prototypes | `npx serve docs/design -l 4321`, then open `http://localhost:4321/mockups/prototype.html` (or open the files directly). `.claude/launch.json` has this as "mockups", plus "tour" (the repo root on 4322, for `docs/design/tour.html`). |
| Check the prototype after a change | `node tools/design-qa/jumps.mjs` (every state, both themes, no script errors, motion rule). See `tools/design-qa/README.md`. |
| Run the local stack (week 1, before the VPS) | `docker compose -f server/dev/compose.yml up -d` (three strfry relays, the operator Blossom server and a mirror), `node server/dev/api.mjs` (the API stand-in: `/defaults.json`, `/register`, `/devices` and `/pair-offers`, devices and offers in memory), `server/dev/phone.sh` (adb reverse, so the phone reaches them on its own localhost), `npx tsx server/dev/smoke.ts` for a full save from the desktop, and `npx tsx server/dev/browser.ts` to pair a stand-in browser. Only a `SHELF_VARIANT=local` build allows cleartext, and only to localhost |
| Install and test the shared code | `npm install` at the root, then `npm test` (tokens staleness check and the `packages/protocol` suite) and `npm run typecheck` |
| Rebuild the tokens | `npm run tokens` (the CSS for the prototypes and `packages/tokens` for the app) |
| Test the cover generator | `node shared/cover/test.cjs`, and `node shared/cover/build.mjs` to copy it into the mockups |
| Rebuild the brand files | install `@resvg/resvg-js@2` somewhere outside the repo, then `NODE_PATH=<that folder>/node_modules node shared/brand/build-icons.cjs` |
| Rebuild the parser bundle | `node shared/vendor/build-parser-bundle.mjs` (writes the APK asset and its sha256 into `apps/mobile/modules/shelf-parser`; `--check` for CI). After a runner change, `node apps/mobile/scripts/parser-expectations.mjs` remakes the phone gate's expected parses in desktop Chrome |
| Build the app for the phone | From the root, `npm install`. In `apps/mobile`: `npm run make-ticks` (the test track, kept out of git), then `SHELF_VARIANT=local npx expo prebuild --platform android` for the local stack (cleartext to localhost only), or `SHELF_DEFAULTS_URL=https://…/defaults.json` for a build against a real operator; then in `apps/mobile/android`, `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` with the same variable set, since Gradle reads the app config again. Install with `adb install -r app/build/outputs/apk/release/app-release.apk`. After changing JavaScript outside `apps/mobile`, delete `app/build/generated/assets/react` first, or Gradle keeps the old bundle |

Commits to `main` go through the code-gate CRAP check (CLAUDE.md, Rules). On this laptop it ran as a git pre-commit hook from Claude's code-gate skill; a new machine needs the hook installed again before the first commit.

## Working with Claude on the new machine

Claude Code loads `CLAUDE.md` by itself. What it learned on the laptop outside the repo, its own memory, doesn't travel, so this page carries it. Ways of working Richard has asked for:

- Commit and push only when Richard asks.
- Write everything in British English, with no inverted-emphasis constructions; plain words over jargon.
- Flow before screens and tokens before components: anything new goes on the flow map (and into a decision) before it is built.
- Say "the Android test build", not "spike".
- Big pieces of work have been run as multi-agent workflows with independent adversarial review before anything is published or committed; the reviews caught real faults each time.
