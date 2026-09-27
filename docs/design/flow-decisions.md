# Flow decisions (towards flow map rev. 3)

Decisions taken with Richard while testing flow map rev. 2 against full coverage (entry points, unhappy branches, exits, state matrix). Each one changes rev. 2; rev. 3 is written from this log. Figma was dropped on 2026-09-27: screens will be built locally as HTML prototypes from `shared/tokens/tokens.json` once the flow is settled.

## Round 1 (2026-09-27)

1. **Core loop:** "The user opens the app to read what they saved earlier." Listening is a way of reading, not a second job. Every screen is measured against this sentence.
2. **Restore on a new phone:** first launch asks one question, "New here" or "I already have a shelf". This adds one screen, one decision and one tap to the critical path (rev. 2: 4 taps, 0 decisions, 3 screens; now 5, 1, 4). Accepted because a restoring user otherwise has no obvious way in, and a silently made key would have to be thrown away.
3. **Listen tab:** holds only articles the user has played, in order, with Play all continuing through them.
4. **Returning open:** reopens where the user was. Mid-article → the Reader at their position; otherwise Saves. After 12 hours away it opens Saves. Back from the Reader always goes to Saves.

## Round 2 (2026-09-27)

5. **"I already have a shelf"** leads to one screen with all three ways in: Scan from my other phone, Enter my recovery code, Sign in with your nostr app. The sign-in link leaves the empty Saves state, whose job is now only to teach sharing and offer Connect your browser.
6. **Share before first open:** the save happens at once under a new key. On first open the question appears; choosing "I already have a shelf" moves those early saves into the restored shelf.
7. **Deleting a save:** Archive stays the everyday swipe. Delete sits in the Reader's ⋯ menu and on archived rows, with a five-second undo and no confirmation dialog.
8. **Queue model confirmed:** Saves shows Unread and Archive only. The old mockups' Audio chip is dropped; the Listen tab covers audio. Closes the CLAUDE.md open item.

## Round 3 (2026-09-27)

9. **Extension toast:** "Open in app" is dropped for v1. The toast is "Saved to Shelf · Undo". There is nothing useful to open on a laptop until the web reader exists. The `/open` page leaves the v1 website scope.
10. **Lock-screen player / media notification tap:** opens the Reader scrolled to the word being spoken, highlight running.
11. **Scan fails when connecting a browser:** the extension shows a short typed code alongside the QR, which can be entered on the phone instead of scanning. Camera permission is still asked only when "Connect a browser" is tapped. **Pending contract change (v1.2):** the pairing handshake needs a typed-code variant; extension spec section 3 and the Android pairing section follow.
12. **You tab header:** the nostr profile name and picture when the user signed in with their nostr app; otherwise a quiet line of counts ("47 saves · 12 listened"). No invented name.

## Round 4 (2026-09-27)

13. **Switching to a nostr app later:** You → Advanced → "Use my nostr app instead" moves every save across to the nostr identity. Out of the main path; nobody is locked in.
14. **Delete my data:** one screen explaining what goes (phone, our server) and what can only be asked for (deletion from independent relays), then type DELETE to confirm. The only confirmation-style gate in the app, because it is the only truly irreversible action.
15. **Notifications:** none in v1, so no notification permission is ever requested. Android's media controls during playback need no permission.

## Round 5 (2026-09-27), from the usability pass

16. **Appearance row cut:** the app follows the phone's light/dark setting. The Reader's Light · Sepia · Dark lives only in the Aa sheet.
17. **Backup card:** "Later" hides it until ten more saves. The "Not written down" row under You stays visible regardless.

## Round 6 (2026-09-27), from the batch 2 review

18. **Reader player:** Listen sits in the Reader's top bar. Pressing it opens a player strip under the top bar (play/pause, time, ±15 s, speed, progress), which replaces the reading-progress line while it plays. The text highlights the spoken word and scrolls to keep it in view. Archive floats at the bottom right.
19. **Listening starts where you're reading:** Listen begins at the paragraph in view, not the top of the article.
20. **Mini player:** shows a ✕ only when paused; it slides up when it appears and slides down and fades when closed. Hidden on the Listen tab, where the Now playing card does its job.

## Round 7 (2026-09-27)

21. **Speed read (RSVP) is in v1.** Reader ⋯ → Speed read opens a full-screen view showing one word at a time, its focus letter in Terracotta at a fixed point. It is driven by the same word stream as listening, so reading, listening and speed reading share one position. Timing: 60 000 ÷ wpm per word, held longer for long words and numbers (×1.4), commas (×1.8), sentence ends (×2.5) and paragraph ends (×3.5), easing in from 60 % speed after each start. It opens paused, showing the first word and its sentence, and starts on a tap (changed at Richard's request). Tap pauses and shows the whole sentence; swipe moves by sentence; − / + sets 200–700 wpm (default 300, remembered). Exit returns to the Reader at that word. Starting it pauses audio. Weight: one menu item, one view, one remembered setting; no permissions, no server work, no contract change.

## Round 8 (2026-09-27)

22. **Listening is on-device only in v1.** The phone's own text-to-speech reads every article: instant, offline, one voice. There is no "better voice", no per-article server audio, no "preparing" or "unavailable" states, no Audio or Downloaded marks, and no voice label in the player (there is nothing to choose between). Server-generated voices (Kokoro) move to a later, subscription-based feature set. Knock-on effects, to be applied when the specs are next revised: the backend drops the TTS worker and audio API from v1; article text is never sent to our server, which simplifies the Play Data safety form; the audio-cache role of `text_hash` is dormant until the paid voices arrive; contract v1.2 marks the audio endpoints as out of v1 scope. You → Voice becomes a choice of the phone's installed voices and a default speed, or is cut (decide in batch 4).
23. **Batch 3 copy and details:** Welcome reads "Save anything from your phone or browser. Read it clean and offline, or listen to it." with "No account, no email. Private to you." Camera permission is asked only after a screen explaining what will be scanned. The recovery code screen accepts a pasted phrase into all twelve fields, suggests words as you type, and flags a word that isn't on the list at that field. Restoring shows progress on the Saves screen itself, so the list is usable while it fills.

## Round 9 (2026-09-27)

24. **Voice setting appears only when there is a choice.** You → Voice is shown only if the phone's text-to-speech reports more than one installed voice for the article's language (Android `TextToSpeech.getVoices()`, filtered to voices that work offline). It lists those voices, each with a short sample to play, and holds the default speed. With one voice, the row is hidden and speed lives only in the player, remembered from the last change. Checked each time You opens, so a voice installed later makes the row appear. It stays out of first launch, keeping zero decisions before first value.

## Round 10 (2026-09-27), batch 4 details

25. **You tab as built:** header is the nostr name and picture for nostr users, otherwise "N saves · N listened". Rows: Recovery code (status under the label), Add another device, Connected browsers, Voice (only with several voices, decision 24), then Advanced, then Delete my data on its own. Offline, Add another device is disabled with "Needs a connection".
26. **Nostr users have no recovery code:** their nostr app holds their identity, so the backup card and Recovery code row are replaced by "Your nostr app · Signed in", and Advanced hides "Use my nostr app instead".
27. **Recovery code sheet:** the words are blurred until "Show the words" (with "Make sure nobody can see your screen"); showing them clears "Not written down". Copy warns to clear the clipboard afterwards.
28. **Delete order:** our server first, then the two backup relays are asked, then this phone last, because the requests must be signed with the key that lives on the phone. If a backup relay doesn't confirm, the screen names it and explains that what's left is encrypted and only the recovery code could open it.
29. **Connecting a browser:** the typed code is eight characters shown as XXXX-XXXX, entered as an alternative to scanning (decision 11). Confirming shows the browser's name before connecting.

## Round 11 (2026-09-27), batch 5: the browser extension

30. **Toast states:** "Saving…" then "Saved to Shelf" with the page title and Undo (eight seconds, Escape or ✕ to dismiss); after Undo, "Removed from Shelf" with "If your phone already has it, remove it there."; "Your phone will fetch the text" when no text was captured (and for right-click link saves); "Saved — will send when you're online" with no Undo; "Couldn't send this save" linking to the options page. Browser pages that block extensions get a tick on the toolbar icon for four seconds instead of a toast. The toolbar icon shows the number waiting to send while offline.
31. **A full offline queue refuses the next save** (confirmed by Richard, 2026-09-27): a ninth save while eight are already queued offline is refused with "Not saved: 8 are already waiting", instead of silently dropping the oldest queued save as spec 05 section 4 said. Spec 05 is updated.
32. **Options page:** the connect path now matches the phone ("You, then Connected browsers, then Connect a browser"), with the QR, the typed code K7QM-4XPD-style, a countdown and "Waiting for your phone". Connected shows the date and the name the phone sees, three ways to save (toolbar, Alt+Shift+S, right-click a link), any "Couldn't send" saves with Retry, relays tucked under an Advanced disclosure (the one place the word appears here), and "Disconnect this browser" with the spec's caveats.

## Round 12 (2026-09-27), from the five-lens prototype review

A review of both prototypes (flow, copy, accessibility, visual, logic), with every finding checked by a separate skeptic, confirmed 73 findings (about 45 distinct). All are fixed in the prototypes. The ones that change behaviour:

33. **Back from the Reader always lands on Saves** (decision 4 applied literally), including when the Reader was opened from the Listen tab or the mini player; Archive, Delete and Next unread do the same, and the lit tab always matches the screen.
34. **Deleting the article that's playing** stops playback and removes it from Listen; Undo restores the article and its place in Listen, paused.
35. **Play all** plays a snapshot of the Listen list from the top to the end, then stops. Reading another article while it plays doesn't pull you along. A finished article rewinds to the start, paused.
36. **One position per article, really:** Listen and Speed read both start at the saved word if it's on screen, otherwise at the paragraph in view; Speed read picks up the word being spoken, and leaving Speed read moves the audio to the same word. Playback speed is remembered across articles and follows You → Voice → Default speed.
37. **Archived rows have a visible ⋯ menu** with Back to Unread and Delete (decision 7 was missing from the prototype). An archived article in the Reader offers Back to Unread instead of Archive.
38. **Toasts only offer Undo when there is something to undo.** Toasts are announced to screen readers and pause while touched or focused. Build note: take the time from `AccessibilityInfo.getRecommendedTimeoutMillis(5000)`, and don't auto-dismiss the share sheet while a screen reader is on.
39. **The share sheet returns you to the app you shared from**, not into Shelf, unless you tap Read now.
40. **New error states:** a six-digit code that doesn't match, a typed browser code that doesn't match, restoring paused while offline, and opening a save offline before its text was fetched ("This page will be fetched when you're online").
41. **Nostr users approve a data deletion in their nostr app** before the deletion requests go out (they're signed there), and the "didn't confirm" message doesn't mention a recovery code they don't have. Signing in with a nostr app now marks the person as a nostr user everywhere.
42. **Dead ends fixed:** "Connect your browser" on the first-run empty state opens Connect a browser (camera explanation first); ⋯ → Open original shows the page; Copy link confirms; Next unread only appears when there is one.
43. **Accessibility floor:** every tap target is at least 48 × 48 (pills keep their look with an invisible hit area); cards open by keyboard and screen reader as well as by tap; sheets are dialogs that take and return focus and close on Escape; selected tabs, segments, voices and reader colours are exposed as selected; icon buttons and the speed button are named; the reader's progress lines and speed-read focus letter use a per-theme reader accent so they stay legible on Sepia; follow-scroll respects reduced motion. The ±15 s buttons drop the tiny "15" numerals (below the type scale) and keep "Back 15 seconds" / "Forward 15 seconds" as their names.
44. **Extension:** relay names only inside Advanced; "Couldn't send" rows give a plain reason and Retry shows progress; "Disconnect this browser" asks first, like the phone; the toast pauses on hover or focus and keeps focus sensible; the toolbar button's name carries the waiting count.

## Round 13 (2026-09-27), from the UI/UX consistency review

A four-lens consistency review of the phone prototype (player system, screen scaffolding, components, interaction patterns), measured across all 85 states and verified, confirmed 45 findings and produced the rules in `consistency-spec.md`. Richard's answers to the ten trade-offs (all the recommended options):

45. **One player, at the bottom.** The mini player sits at the bottom on every screen; in the playing article's Reader it expands in place (play, time, −15, +15, speed, ✕ when paused) and its line replaces the reading line. Archive floats above it. Supersedes decision 18's top strip. Pause never moves and stays in thumb reach.
46. **The dark pill is for toasts only.** The mini player is a light floating card (reader colours inside the Reader); the offline banner is a quiet neutral notice.
47. **The Reader's Listen button is soft** (tinted, not gradient). The gradient marks only the live play/pause and a screen's one primary button.
48. **No seeking in v1.** Progress bars are display-only; ±15 s and "Listen starts where you're reading" cover moving around.
49. **Listen rows open the article**, like every other card, with a separate round play button.
50. **Back returns to where you came from**: from Listen to Listen, from the mini player to the screen it was tapped on, from Search to Search with the results kept; opening straight into an article still goes to Saves. Supersedes decision 33 for those routes.
51. **Search is a full screen** without the tab bar, like Android's own search.
52. **The mini player on Listen** appears once the Now playing card scrolls away, and slides in only when a session starts or the card leaves, not on every tab switch. Refines decision 20.
53. **Phone-to-phone restore follows the contract**: scan the QR, then type the six digits shown on the other phone (a second factor, never an alternative to scanning). If the camera is refused, the way on is the recovery code. Corrects the flow map, which said the code could be typed instead of scanning.
54. **"Next unread" becomes "Archive and next"**, saying what it does. The end card's pair is [Archive and next] [Archive], primary on the right.

## Round 14 (2026-09-27), icons

55. **App icon: "Bookmark on Terracotta".** A cream, square-shouldered bookmark with a notched tail standing on a two-tone reading-progress bar, on the brand gradient. Chosen over the Ledge (books on a shelf) after a concept round of five and a refinement round, compared at real sizes on home screens, themed icons and a 16 px toolbar. Sources and the asset build live in `shared/brand/`.
56. **In-app icons are Lucide**, plus one custom pair: skip back and forward 15, in Lucide's exact rotate geometry with a lighter, centred "15" (variant C). Whether the custom speed, speed-read and shelf icons replace Lucide's `gauge`, `zap`/`scan-text` and `library-big` was settled by decision 62.

## Round 15 (2026-09-27), from the extension consistency review

The extension review (internal, cross-surface with the phone, browser conventions; 34 findings confirmed) produced 21 fixes and 13 rules that hold on both surfaces. Richard's answers (all the recommended options):

57. **The extension's save toast matches the phone's toast**: the house inverted toast, kept as a small card because it has two lines. One look for "saved" across both products.
58. **Keyboard reach to Undo: press the shortcut again.** The toast never takes focus on its own (a stray Space or Enter would otherwise undo the save). Pressing Alt+Shift+S again while "Saved" shows moves focus to Undo; Escape or ✕ returns focus to the page.
59. **Pages where no toast can run** (PDFs, reader view, browser pages, the Web Store) show a small "Saved to Shelf" popup with Undo under the toolbar button, like Chrome's bookmark bubble, as well as the icon tick. Needs Chrome 127+; older versions keep the tick only.
60. **Offline saves offer Undo**: the save is still in this browser's queue, so Undo just removes it and lowers the waiting count. Changes decision 30. Also: disconnecting a browser now names any unsent saves it would delete, so nothing saved is lost silently (decision 31's spirit).

## Round 16 (2026-09-27), from Richard

61. **Content on Terracotta is white, in every theme and reading palette.** Richard found the Speed read play button's icon black in the light Reader: a rule meant for the plain controls beside it had recoloured it. The same check found the active Unread/Archive segment and the swipe reveal carrying near-black content in dark mode, where they filled with the lighter #CA8469. Solid Terracotta fills now use #B5542E in both themes (white on it is 4.9:1), and the lighter dark-mode Terracotta stays for lines, dots, text and focus rings. Tokens 0.1.5.

## Round 17 (2026-09-27), from Richard: the last open choices

62. **In-app icons are settled.** Speed read's row in the Reader's ⋯ menu uses Shelf's own speed-read icon (the Speed read frame: two rules and the focus ticks around the word) in place of Lucide's zap. The speed pill stays text only ("1.2×"): an icon would leave the Reader player 29 px for the time, which cuts it off from ten minutes in. No shelf icon: no screen needs one. Custom icons in total: the skip ±15 pair and speed read; everything else is Lucide. This closes decision 56's open part; the unused speed and shelf drawings sit in `docs/design/icons/app/unused/`.
63. **Archive's row menu is a bottom sheet**, headed with the article's title, like the Reader's ⋯ menu, so every menu in the app is the same kind. The Saves card mockup's small anchored menu is replaced to match the phone prototype. Options were compared in `docs/design/mockups/choices.html`.

## Round 18 (2026-09-27), what the extension consistency fixes changed in earlier decisions

64. **Decisions 30 and 44 as amended by the extension pass.** The toolbar badge still counts offline saves only, as decision 30 says (Richard kept this after the pass had widened it to include saves that couldn't send); it is now a neutral grey. A save is listed under "Couldn't send" from its first failure, and the failed toast says Shelf will keep trying. Every extension toast runs eight seconds, and link saves name the host ("arstechnica.com · your phone will fetch the text"). Decision 44's "keeps focus sensible" now means decision 58: the toast never takes focus, Escape stays inside the toast, and Tab past its last button returns focus to the page. The options page and "Ways to save" tell people to pin Shelf while it isn't pinned, and the phone's Connect a browser lead says the icon may be under the puzzle piece. Spec 05 sections 2 and 4 are updated to match.

