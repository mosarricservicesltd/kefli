# Figma brief: Stage 0 mockups

For Richard, drawing in Figma with the free Untitled UI kit. Claude reviews each batch from frame links. Sources: flow map rev. 2 (`pocket-on-nostr-flow.html`, `flow.svg`), project plan section 3 Stage 0 and section 5, extension spec sections 3 and 5, and the existing HTML mockups (`ui-mockups.html`), which are a sketch to improve on, not a spec.

Nothing gets drawn that isn't on the flow map. If a frame needs something new, it goes on the map first.

## 1. File setup

1. In Figma Community, open **Untitled UI – FREE Figma UI kit** and choose **Open in Figma**. That puts a copy in your drafts.
2. Make a separate design file called **Shelf — Stage 0** and enable the duplicated kit as a library for it. Keeping the kit in its own file means our pages stay small, and swapping to Untitled UI Pro later is a library swap.
3. Pages in **Shelf — Stage 0**, in this order:
   - `00 Cover`: name, date, status (Exploring, In review, Frozen).
   - `01 Tokens`: the token table from section 2, drawn as colour styles and text styles.
   - `02 Style round`: the style comparison from section 3.
   - `03 Components`: local components the free kit doesn't have (list in section 5).
   - `10 Saves`, `11 Reader`, `12 Listen`, `13 You`, `14 Share and sheets`, `15 Sign-in and pairing`: phone screens, one page per area.
   - `20 Extension`: toast and options page.
   - `90 Parking`: anything cut or v2.
4. Phone frame: **360 × 800** (Android compact, the most common size), with a 24 px status bar and a 16 px gesture bar area at the bottom. Draw one frame at 412 × 915 for the Library and the Reader only, to check that nothing breaks on a larger phone.
5. Frame naming: `Area / Screen / State`, for example `Saves / Library / Offline`. The state names are the five from the flow map's state matrix: Populated, Empty, Loading, Partial, Error, Offline. Consistent names let me check coverage automatically.

The kit's components are React on the web side only. On the phone they're a visual reference, and the Expo build redraws them in React Native from the same tokens. Draw freely, but avoid anything that only exists as a web interaction (hover-only states, tooltips as the only way to learn something).

## 2. Tokens (fixed by the plan; the style round only picks values)

The token file has exactly these entries. Adding one needs a written reason.

| Group | Tokens |
|---|---|
| Colour | background, surface, line, text, muted, accent, accent-soft, success, error |
| UI type scale | 13, 15, 17, 20, 28, 32. System font: Roboto on Android. In Figma use Inter as the stand-in, since it is close and ships with the kit |
| Spacing | 4, 8, 12, 16, 20, 24, 32 |
| Radius | 10 for containers, 999 for pills |
| Reader type | body 18 at 1.55 line height, serif (Noto Serif on Android). Aa sheet: size, plus Light / Sepia / Dark |
| Icons | one stroke set on every platform (see open question 1) |

Make each colour a variable in a `Light` and a `Dark` mode, so every frame can flip modes without redrawing.

## 3. Style round (do this first; it picks the direction)

Draw two screens: **Saves / Library / Populated** and **Reader / Article / Playing** (mini player docked, one word highlighted). Draw them in three of the Style Lab styles, side by side:

| Style | What changes |
|---|---|
| Soft pills | Pill buttons, soft shadows instead of borders, one gradient on the primary action. The current direction |
| Editorial | Serif headlines, hairline rules, no cards. Accent only on play and the active tab |
| Compact | Text-first and dense, no thumbnails, segmented Unread / Archive, player docked above the tabs |

Use one accent for all three so only the style differs. I'd suggest Sage `#3F7D5A`, the calmest for long reading. Then take the two you like best into dark mode. After the pick, write the chosen values into `01 Tokens`, freeze them, and every later page uses only variables.

The radius rule (10 and 999) fits Soft pills and Compact. Editorial barely uses containers, so it fits too. If you fall for Untitled stock's 8 px corners, tell me and we amend the plan.

## 4. Screen inventory

Every screen gets the states listed. "n/a" states from the flow map are left out. Copy in quotes is final wording from the flow map or specs; use it verbatim so the review can check it.

### 10 Saves (tab 1)

| Frame | Notes |
|---|---|
| Library / Populated | Unread list in save order. Row: source · title · read time · audio marker if audio is cached. Search field at top. Unread / Archive switch. Three tabs: Saves, Listen, You |
| Library / Empty | First launch. One illustration, two buttons: "Connect your browser" and "Already on nostr? Sign in". Body copy teaches the share sheet |
| Library / Loading | Cached list shown immediately, thin refresh line at the top. No full-screen spinner |
| Library / Partial | Three row variants in one list: parsing pending (source + URL + pending dot); extension save waiting on the phone; parse failed, "Couldn't get the text · open original" |
| Library / Offline | Banner "Offline — showing saved copies". A queued save shows ⏳ |
| Library / Swipe | A row mid-swipe left, revealing Archive |
| Library / Undo | Undo toast after archive, five seconds, above the tab bar |
| Archive / Populated and Empty | Same row, reversible (swipe right or a restore action) |
| Search / Results and No results | On-device full-text search |

### 11 Reader

| Frame | Notes |
|---|---|
| Article / Reading | Source, title, byline · read time · saved date, body at reader type. Progress line. Top bar: back, Aa, ▶, Archive |
| Article / Loading | Under a second of skeleton, only when not yet parsed |
| Article / Partial | Text in place, image placeholders still downloading |
| Article / Error | Falls back to the original page in an in-app browser. Show the in-app browser chrome |
| Article / Offline | Identical to Reading. Draw it only to prove nothing changes |
| Article / End card | "Archive · Next unread" |
| Article / Playing | Mini player docked, current word highlighted, skip back/forward, speed |
| Article / Better voice unavailable | "Better voice unavailable for this one"; the phone's voice keeps working |
| Aa sheet | Size, Light / Sepia / Dark. Nothing else |

### 12 Listen (tab 2)

| Frame | Notes |
|---|---|
| Queue / Empty | "Tap ▶ on any article to add its audio here." |
| Queue / Populated | Now playing card (title, scrubber, speed, voice name), then Up next with "Play all". Downloaded items marked |
| Queue / Preparing | An item showing "Preparing audio" while the server voice is generated, with playback already running on the phone's voice |
| Queue / Offline | Downloaded items playable, the rest marked as playing in the phone's voice |
| Lock screen | Android media notification and lock-screen controls, drawn roughly as a system reference: title, source, play/pause, skip ±15 s |

### 13 You (tab 3)

| Frame | Notes |
|---|---|
| You / Default | Backup card, Add another device, Connected browsers, Appearance, Voice, Advanced (relays and export), Delete my data |
| You / Backup not done | Recovery code row reads "Not written down" until viewed |
| Recovery code sheet | Twelve numbered words, a copy action, one plain line on what it's for |
| Add device / Show code | QR plus a six-digit code |
| Add device / Expired | "Code expired, show a new one" |
| Connected browsers / List and Disconnect dialog | Dialog copy: "Pages saved from that browser will be ignored. Uninstall the extension there or connect it again." |
| Appearance, Voice | Simple lists; Voice shows the phone voice and the better voice |
| Advanced | Relays (three: ours plus two backups) and export. The only place relays appear |
| Delete my data / Confirm and Done | Must work in the first release (Play policy) |
| You / Offline | Recovery code and Appearance work; Add device and Connect browser say they need a connection |

### 14 Share and sheets

| Frame | Notes |
|---|---|
| Android share sheet with Shelf | System reference, so we know how the icon and label read |
| Saved sheet / Saved | Title, source, "Private. Ready to read offline in a moment." Undo · Read now |
| Saved sheet / Offline | "Saved · will fetch when online" |
| Saved sheet / Not a link | "That wasn't a link." |

### 15 Sign-in and pairing

| Frame | Notes |
|---|---|
| Sign in / Choose | "Sign in with your nostr app" (the only place the word appears), plus the Android signer-app handoff |
| Sign in / Import | Import existing URL and article bookmarks, private by default |
| Connect browser / Scanner | Camera view scanning the extension's QR |
| Connect browser / Confirm | "Connect this browser?" with the browser label, e.g. "Chrome on a Linux laptop"; one tap |
| New device / Restoring | Library filling in from the relays; say it works even if our server is off, in plain words |

### 20 Extension

| Frame | Notes |
|---|---|
| Toast / Saving | 320 px card, bottom right: "Saving…" |
| Toast / Saved | "Saved to Shelf" · Undo · Open in app |
| Toast / No text | "Saved — your phone will fetch the text" |
| Toast / Offline | "Saved — will send when you're online" · Open in app only |
| Toast / Queue full | "8 waiting" |
| Options / Pair | QR with five-minute countdown, "Open Shelf on your phone, go to You, then Connect a browser, and scan this." |
| Options / Connected | "Connected to your phone" and the date, relays read-only, Unpair |
| Options / Expired | "This code expired" + "Show a new one" |
| Options / Can't reach | "Can't reach the relay. Check your connection." (user-facing, so the wording needs changing; see open question 4) |
| Options / Couldn't send | Failed queue entries with Retry |

## 5. Local components to build in `03 Components`

The free kit covers buttons, inputs, badges, toggles, avatars and basic lists. Build these ourselves: library row (with pending, failed, queued, audio variants), mini player, Now playing card, offline banner, undo toast, bottom sheet, tab bar (three tabs), progress line, word highlight, recovery-word grid, QR card with countdown, extension toast.

## 6. Rules the review checks

- Text inside any bordered or filled element (buttons, chips, badges, tags) is vertically centred.
- Every screen has its empty, loading, partial, error and offline frames where the state matrix defines them.
- British spelling. No "it's not X, it's Y" style lines, anywhere.
- No nostr jargon on any screen except "Sign in with your nostr app": no "relay", "key", "npub" or "event" in the main path. "Relays" is allowed only under Advanced.
- Only token variables for colour, type and spacing once the tokens are frozen.
- Touch targets at least 48 × 48 dp.

## 7. Open questions to settle while drawing

1. **Icons.** The plan says Lucide on every platform. The Untitled UI kit ships its own icon set. Pick one: Lucide keeps the plan and runs natively in React Native; Untitled icons match the kit.
2. **The "Audio" filter chip** in the old mockups isn't on the flow map, which has Unread and Archive only. Keep it off, or add it to the map first.
3. **"Richard · 47 saves"** at the top of the You tab in the old mockups. There's no signup, so there's no name to show unless it comes from a nostr profile. Suggest dropping the name and keeping the counts.
4. **Extension "Can't reach the relay"** uses a jargon word on a user-facing screen. Suggest "Can't connect right now. Check your connection."
5. **Queue model**: CLAUDE.md lists "flat Unread list plus Archive" as awaiting your confirmation. Drawing it is a good moment to decide.

## 8. Review loop

Batch 1 is the style round (section 3). Batch 2 is Saves and the Saved sheet. Batch 3 is the Reader and Listen. Batch 4 is You, Sign-in and pairing. Batch 5 is the extension. For each batch, send me the page link (right-click the page or frame, then **Copy link**). I'll screenshot every frame, check it against the flow map, the state matrix, the copy above and the rules in section 6, and send back a list of issues with frame names. When a batch has no open issues, mark it Frozen on the cover.
