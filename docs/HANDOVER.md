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
  - **Covers draw in** (signature 1): leaf by leaf from cover v1's own SVG, once per surface, recorded in `cover_drawn`. A save that joins while Unread is on screen draws as it lands, and Welcome's three covers draw on first launch. The Saved sheet followed in week 3 (below).
  - **Images** (sync phase 6): kept in app storage under `img/<sha256 of the address>`, at most 5 MB each and 200 MB in all, archived articles' first to go. The newest 50 unread articles' images are fetched on Wi-Fi, and an article's own when it opens. The Reader shows them at their published size, a 3:2 placeholder while they come, and keeps the word at the top still as they arrive.
  - **Pending parses** (sync phase 7): a share made offline is saved and waits on the phone. Once online it is fetched and parsed, then re-keyed by its final address if still unpublished (FD 80), joining an existing save if there is one, and then sent. A page that can't be read is sent without text. Shares and pending parses share one page fetch (`services/page.ts`), which tries the mobile user agent after a 403 and enforces the 5 MB cap and 20 s timeout. Shared X posts (5.4) are checked through X's embed service, with `t.co` followed five hops at most: the first link that leaves X is saved, and a post with no article saves nothing. Offline, or with X not answering, the post waits as a pending save and is checked again (retried from 30 s, doubling to an hour, while X fails), then re-keyed to its article (FD 80).
  - **The lock-screen card** carries the article's cover, rendered offscreen by Skia at 512 px, as its artwork, and Shelf's one-colour glyph as its small icon. The `with-shelf-notification` plugin copies the glyph from `shared/brand/out/android` at prebuild, so after a fresh clone run prebuild before building.
  - **Search** (5.6, 4.9): FTS5 prefix queries ranked by bm25 across Unread and Archive, plus a title, site and address match for saves whose text isn't here yet. Results update with every keystroke, and "Nothing matches" waits for a 250 ms pause. Archived results are tagged, and a swipe changes a result in place. Back from a Reader keeps the query; it resets only when Search is entered from Saves.
  - **The locked battery hour** (FD 87, 11.3) ran on 7 October 2026 on `World War II` (25,574 words), from 13:38 to 15:07. It played locked and unplugged with Doze on, and every 30-second tick of `shelf-voice.log` landed. The lock-screen pause, play and ±15 all reached Shelf, and the battery went from 100% to 99%. It found one bug: after a skip, the word stopped following the voice (fixed in `207ed23`, checked on the phone). Richard accepted the run without a rerun.
  - **The stage 1 gate** was prepared on 7 and 8 October 2026 (`docs/specs/09-stage1-gate.md`): the twenty fixture pages (20/20 on the phone), the live list of thirty (30/30), `npm run verify`, and the device checks Claude could run. Its Chrome part is sharing from Chrome on the phone, not the extension. Richard's own run is the record's last section.
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
  - **The inbox** (4.7, sync phase 4) followed the same day. Browser saves arrive as gift wraps on the operator relay:
    - **When it runs:** drained at every sync, and while Shelf is in front a live subscription (`limit: 0`) drains it within a second of a wrap arriving.
    - **Judging a wrap:** each one is judged once and recorded in `inbox_seen`. Other apps' messages, unknown tokens, other keys and other versions are left alone.
    - **An accepted save:** it joins Saves through `queueSave`, so the repeat-save rule applies. Its row reads "From Chrome" with "Getting the text…" (`text_state` 'fetching', RULED in `data/inbox.ts`) until the browser's HTML is downloaded from the operator Blossom server, checked and parsed. The parse goes through the same `parseHtml` and guard as a fetched page.
    - **When the HTML can't be read:** without HTML, or for an X post, the save waits as a pending parse. A blob that can't be read is retried at each drain, and once it has expired the page is fetched instead.
    - **Deleting the wrap:** only created, merged and un-archived wraps queue `delete_wrap`.
    - **Testing:** `npx tsx server/dev/browser.ts save <url>` sends a save from the paired stand-in browser.
  - **The Saved sheet** (5.4) replaced week 1's share card on 8 October 2026 (`src/share/ShareRoot.tsx`):
    - **States:** every prototype state: saved, already saved, offline, X not answering, X checking, no article, not a link, and "Removed from Shelf" after Undo.
    - **Timing:** it says Saved at once with the cover drawing while the page is fetched behind it. A share of a save already here skips the fetch.
    - **Undo:** removes a new save with its text, or archives again a save the share brought back (`undoSave`).
    - **Countdown:** `getRecommendedTimeoutMillis(4000)` in the article's ink. It pauses on touch and doesn't run with a screen reader on.
    - **Fonts:** embedded at build time through the `expo-font` plugin, so the share surface has Archivo from its first frame.
    - **New copy for Richard to read:** the sheet's error state when a save throws ("That didn't save", "Try sharing it again.") isn't in the prototype.
  - **Not yet built:** the screens behind Add another device, Advanced and Delete my data.
- **Week 4 started on 8 October 2026 with Enter my recovery code and the restore** (5.3, 4.10, C§8):
  - **The code screen:** twelve fields with suggestions from the BIP-39 list, Paste, a word not on the list flagged at its field, and a checksum failure at the last field (drafted copy: "These words aren't a recovery code. Check each one against what you wrote down."). The window is secured while it's open.
  - **The first pass:** the key is derived and the relays asked whether any save exists under it (`services/recovery.ts`): the default relays and indexer, then any read relay the key's own 10002 names. Nothing found gives "No saves found for this code" with Try again and Start fresh instead; the key is stored only when a shelf is found.
  - **The restore:** a `jobs` row carried out by the next sync (RULED in `data/restore.ts`: a save counts as back once its text is here or known missing). The card on Saves shows "N of M" with its bar, "Paused…" offline, then "All N saves are back" for 3 s.
  - **After an early share:** the early key stays in the key file and Block Store as the move's source, and a `move` job is queued for week 5; the code's key isn't written to Block Store until the move ends.
  - **Second-phone pairing** (5.3, 5.8, C§2) followed the same day:
    - **Add another device:** a real QR (`toqr`, drawn on a light card in both themes) with six digits under it, fresh each time and good for five minutes, the screen kept awake (`expo-keep-awake`) and secured. Expired, the code fades and Show a new one makes another.
    - **Scan from my other phone:** the explanation, the camera, the six digits (the camera stopped first), wrong code, expired, refused (the way on is the recovery code) and connecting. A key that isn't the QR's is refused; the identity is stored as `phone_pair` and the restore runs.
    - **The exchange:** HKDF-SHA256 over the QR's secret and the six digits (`packages/protocol/src/phonePair.ts`); the dev API's `/phone-offers` holds an offer five minutes and hands it out once.
    - **Testing with one phone:** `npx tsx server/dev/otherphone.ts` plays the other phone: it makes a throwaway shelf and shows its QR and six digits in the terminal and `server/dev/data/pair.html`.
  - **Delete my data** (5.8, 7.2, C§4.7) followed the same day (`services/deleteAccount.ts`):
    - **The screen:** what goes and what can only be asked for, the backup servers counted from the shelf's real lists, and the danger button only once DELETE is typed online. Deleting shows a row per server as it resolves, with no way back; a server that didn't confirm is named.
    - **The order:** the operator first (wrap and save deletions, every blob, then `DELETE /account`; unreachable after a minute, nothing else runs and the key stays), then every other relay and server, then the phone (key file, Block Store, database, files and the artwork cache). Each step's result is kept, so a deletion cut short resumes.
    - **RULED:** the lists' kind 5 names each list event by id as well as by the contract's `a` tags, since strfry honours an `a` tag only for addressable kinds. Checked on the local stack: nothing of a deleted shelf is left on any relay.
    - **Not yet:** the nostr user's path (approve in their app, lists rewritten rather than deleted) comes with nostr sign-in.
  - **Testing:** `npx tsx server/dev/shelf.ts [N]` makes a throwaway shelf on the local stack and prints its test words; the gates screen's "Forget this phone's shelf" wipes the key file, Block Store and the database so the phone starts at Welcome.

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
| Run the local stack (week 1, before the VPS) | `docker compose -f server/dev/compose.yml up -d` (three strfry relays, the operator Blossom server and a mirror), `node server/dev/api.mjs` (the API stand-in: `/defaults.json`, `/register`, `/devices` and `/pair-offers`, devices and offers in memory), `server/dev/phone.sh` (adb reverse, so the phone reaches them on its own localhost), `npx tsx server/dev/smoke.ts` for a full save from the desktop, and `npx tsx server/dev/browser.ts` to pair a stand-in browser (then `… browser.ts save <url>` to send a save from it). Only a `SHELF_VARIANT=local` build allows cleartext, and only to localhost |
| Check a phone's saves on the relays | `read -rs SHELF_SECRET && export SHELF_SECRET && npm run verify -w packages/protocol` (the twelve words at the blank prompt): every save's newest copy verifies, decrypts and has its text on every server it names |
| Run the live list on the desktop | `npx tsx apps/mobile/scripts/live-urls.ts` (`shared/fixtures/live-urls.json` through the share's own path, Chrome parsing); the phone's `/gates` runs the same list |
| Install and test the shared code | `npm install` at the root, then `npm test` (tokens staleness check and the `packages/protocol` suite) and `npm run typecheck` |
| Rebuild the tokens | `npm run tokens` (the CSS for the prototypes and `packages/tokens` for the app) |
| Test the cover generator | `node shared/cover/test.cjs`, and `node shared/cover/build.mjs` to copy it into the mockups |
| Rebuild the brand files | install `@resvg/resvg-js@2` somewhere outside the repo, then `NODE_PATH=<that folder>/node_modules node shared/brand/build-icons.cjs` |
| Rebuild the parser bundle | `node shared/vendor/build-parser-bundle.mjs` (writes the APK asset and its sha256 into `apps/mobile/modules/shelf-parser`; `--check` for CI). After a runner change, `npx tsx shared/fixtures/build-pages.ts` remakes the twenty fixture pages' expected results in desktop Chrome (`--fetch` downloads the real pages again) |
| Build the app for the phone | From the root, `npm install`. In `apps/mobile`: `npm run make-ticks` (the test track, kept out of git), then `SHELF_VARIANT=local npx expo prebuild --platform android` for the local stack (cleartext to localhost only), or `SHELF_DEFAULTS_URL=https://…/defaults.json` for a build against a real operator; then in `apps/mobile/android`, `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` with the same variable set, since Gradle reads the app config again. Install with `adb install -r app/build/outputs/apk/release/app-release.apk`. After changing JavaScript outside `apps/mobile`, delete `app/build/generated/assets/react` first, or Gradle keeps the old bundle |

Commits to `main` go through the code-gate CRAP check (CLAUDE.md, Rules). On this laptop it ran as a git pre-commit hook from Claude's code-gate skill; a new machine needs the hook installed again before the first commit.

## Working with Claude on the new machine

Claude Code loads `CLAUDE.md` by itself. What it learned on the laptop outside the repo, its own memory, doesn't travel, so this page carries it. Ways of working Richard has asked for:

- Commit and push only when Richard asks.
- Write everything in British English, with no inverted-emphasis constructions; plain words over jargon.
- Flow before screens and tokens before components: anything new goes on the flow map (and into a decision) before it is built.
- Say "the Android test build", not "spike".
- Big pieces of work have been run as multi-agent workflows with independent adversarial review before anything is published or committed; the reviews caught real faults each time.
