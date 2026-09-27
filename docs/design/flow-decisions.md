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
