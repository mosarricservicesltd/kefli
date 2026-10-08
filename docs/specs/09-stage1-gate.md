# Stage 1 gate: results

The stage 1 gate (project plan section 3, mobile spec section 2's stage gates and 11.3's device matrix), prepared on 7 and 8 October 2026 on the Pixel 10a (Android 17), from a release build (`assembleRelease`, arm64-v8a) against the local stack in `server/dev`.

The plan's exit gate is Richard's: he saves from X and from Chrome on his phone, reads offline, listens with the system voice, archives, and the events verify on the relay with the fixture decryption tool. The checks Claude could run are below; Richard's part is at the end.

## What the gate needed that didn't exist

- **The twenty fixture pages** (contract section 9) are in `shared/fixtures/pages/`. Eight are written for the awkward cases: encodings, `<base>`, the canonical and image rules, tables and figures, notes and nested lists, a page too short, and a script-only app. Twelve are real pages under open licences (`pages/SOURCES.md`): Wikipedia in English, German, French, Japanese, Arabic, Russian, Greek, Chinese and Simple English, a Wikisource story, an MDN page and a GOV.UK guide.
  - `shared/fixtures/expected.json` holds desktop Chrome's result for each page: the parse's fields, Readability's content HTML, the Markdown, `text_hash`, the spoken projection and `words`.
  - `npx tsx shared/fixtures/build-pages.ts` remakes it, and `--fetch` downloads the real pages again.
  - These replace the week 0 parser gate's five pages (`parse-expected.json` and `scripts/parser-expectations.mjs` are gone).
  - The phone fetches the pages from `server/dev/api.mjs` (`/fixtures/…`), so they stay out of the app bundle.
- **The live list of thirty addresses** is in `shared/fixtures/live-urls.json`, each with the outcome that is right for it, honest failures included.
  - It runs through the share's own path: the X check for X posts, otherwise `fetchPage` with its user agents, caps and guard.
  - The run is in `apps/mobile/src/gates/live.ts`. `npx tsx apps/mobile/scripts/live-urls.ts` runs it on the desktop with Chrome's parse, to see which pages have moved upstream before the phone runs it.
- **`npm run verify -w packages/protocol`** checks every save of an identity across the relays. Each save's newest copy must verify and decrypt, and its text blob must be on every server it names and match `text_hash`. It prints one line a save, then the count. `server/dev/smoke.ts` now ends with it. The secret comes from `SHELF_SECRET` and never reaches a log.
- **`shelfArticle`** in `shared/vendor/parser-runner.js` returns Readability's content HTML, prepared as `shelfParse` prepares it. It is what the extension will send with a save, and what the fixtures record.

## Results

| Check (11.3, stage 1 column) | Result | Evidence |
|---|---|---|
| Fixture hashes on device: 20/20 | Pass | `[shelf-gates] parser`: "20/20 pages match Chrome/150.0.7871.114: every field, the Markdown, text_hash, the spoken text and words; first 153 ms (WebView start), then 549 ms at most" |
| Live list: 20/30 | Pass, 30/30 | `[shelf-gates] live-list`: "30/30 as expected", each page 0.2 to 2.2 s fetched and parsed (`[shelf-live]` lines). The desktop run agreed, 30/30 |
| X post without an outside link | Pass | "no article in that post: nothing saved" |
| X post offline | Pass | Offline, the post waits ("Will fetch when you're online"); back online it showed "Will check the post when X answers" while X refused, then was checked, and with no article in it went out without text, its row opening the post |
| X post with an outside link | Richard | X's syndication service was rate-limiting this network, so a post with a link is left to Richard's share from the X app |
| A sign-in wall | Pass after a fix | LinkedIn's feed redirects to its login page and parses to nothing readable, so the save is kept without text and its row offers Open original. The save was keyed by the login page's address, though, so Open original would have opened the sign-in page. A failed parse now keeps the shared address (RULED in `services/save.ts`) |
| Save offline and reconnect | Pass | In airplane mode a share is "offline: saved, waiting to fetch". Saves showed the offline notice and both waiting rows; an article already saved read in full offline. Back online, the page was fetched and parsed (Readability, 34 min) |
| Kill the app mid-save | Pass after a fix | Killed 0.35 s after the share, before the save was written: the share was lost. The spec's pickup of unprocessed spools at the next start (8.5) had never been built. Built in `src/share/pickup.ts`, it saved the killed share at the next launch |
| Share then lock at once: the save publishes | Measured: it does not | Shared at 09:01:12.055, the screen put to sleep 0.3 s later. The save was written locally 0.8 s after the share, with its three rows held for the sheet. Two and a half minutes later nothing had been sent and the relays didn't hold it: the sheet's countdown, which releases the rows, doesn't run with the screen off. See finding 6 |
| Word highlight on Google's engine | Pass | `shelf-voice` since week 2: the word follows the voice, after a skip too (`207ed23`), and on unlock after the locked hour |
| Media card with no notification permission | Pass | Shelf's manifest doesn't declare `POST_NOTIFICATIONS`, so this is its normal state (`POST_NOTIFICATION: ignore`). The media session is active with ±15 as custom actions; the shade's card shows the cover, title, site, pause and ±15, with the bar for display only. Its controls work through the session: next moved the position forward, pause paused |
| Performance budgets (measured) | Measured | Pair-code scrypt 72 to 75 ms (budget 150); Schnorr verify median 0.26 ms and a 1,000-item restore 0.9 s (10 ms, 20 s); a share reached Saves' list within a second; fetch to parsed article 0.2 to 1.5 s on ordinary pages over Wi-Fi (budget 1 s) |

All sixteen week 0 gates still pass on the same build.

## Findings

1. **Spools left by a killed share were never picked up** (fixed). Spec 8.5 says unprocessed spools are picked up at the next start, and nothing did it. The pickup now runs before the start's sync, single-flight, and skips a spool whose sheet is still open in this process.
2. **The share card is still week 1's functional card.** It shows debug lines (the `d` tag, the steps) and offers Read now even when nothing was saved. The designed Saved sheet (5.4: saved, re-share, no article, offline and the rest) hasn't been built. Richard will see this card when he shares from Chrome and X.
3. **An unknown deep link shows Expo's "Unmatched Route" page** (polish, severity 3). Only a hand-typed `shelf://` address reaches it.
4. **A waiting X post that turns out to have no article** shows "x.com" as both its source and its title (polish).
5. **The inbox now runs the contract's Markdown-only conversion** (`shelfMarkdown`) on a browser save's HTML, with the title and the rest as the extension read them. Before, it ran the whole parse again. Found while building `shelfArticle`.
6. **A share made just before locking isn't published until the phone is used again** (measured, not fixed). The sheet holds the save's rows for its Undo countdown, and the countdown doesn't run with the screen off, so nothing is released or sent. Spec 4.8 makes this measurement the trigger for a one-off expedited WorkManager job (API 31 and later). That job only helps once the rows are released, so two things need building: releasing the sheet's rows when it leaves the screen, since Undo can't be pressed on a locked phone, and the expedited job. The periodic `expo-background-task` worker in 4.8 isn't built yet either.
7. **A failed parse was keyed by where its redirects ended** (fixed). A sign-in wall's login page took the save's address. Now a failed parse keeps the shared address; a parsed page still takes its final address and canonical (FD 80).

## Richard's part

With the local stack running (`docker compose -f server/dev/compose.yml up -d`, `node server/dev/api.mjs`, `server/dev/phone.sh`):

1. In Chrome on the phone, open an article and share it to Shelf. Then do the same from the X app with a post that links to an article. Both should land at the top of Saves with their text.
2. Turn on airplane mode, open one of them, read a little, and leave.
3. Turn airplane mode off. Press Listen on one and check the word follows the voice.
4. Archive one with a swipe; Undo once, then archive it again.
5. On the laptop, with the twelve words from You → Recovery code, run `read -rs SHELF_SECRET && export SHELF_SECRET && npm run verify -w packages/protocol`, type or paste the words at the blank prompt and press Enter. Every save should read `ok`, the archived one tagged `[archived]`, ending "N of N saves verify, decrypt and match their text". `read -s` keeps the words off the screen and out of the shell's history, and nothing logs them; close the terminal afterwards.
