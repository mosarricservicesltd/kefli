# Android test build: results

Run on 5 October 2026 by Richard and Claude, on a real phone over USB. This is the Android spike, the one-evening test CLAUDE.md sets before the mobile stack is confirmed ("First task"). It adds two tests to CLAUDE.md's three. The first is the phone's own voice reading with the screen locked, since flow decision 22 makes on-device speech the only listening in v1. The second times scrypt for the eight-character code a phone types to connect a browser (contract v1.2, section 4.4).

## Outcome

**Expo is confirmed** for the mobile app. The three tests CLAUDE.md asks for pass on an Expo release build of the harness:

- a shared link is fetched and parsed in about half a second, although a shared X post needs handling of its own (test 1);
- the phone's voice reported the exact position of every word it spoke;
- audio played to the end of a six-minute file behind the lock screen, with the lock-screen controls showing.

Following CLAUDE.md, the Android spec, written for Kotlin and Compose, has since been rewritten as the Expo mobile spec `03-mobile.md`; the old one is archived as `archive/03-android-v1.0.md`.

The locked tests ran with the phone on USB power. Android exempts a charging phone from its battery restrictions (Doze), so a locked run on battery is still to be done before listening is settled (see Next).

Two pieces of native work come out of it. Both fit in an Expo development build:

1. **A media session around the phone's voice.** Android's speech engine reports each word's position, so highlighting needs nothing extra. The media session needs native code: a foreground media service that drives Android's `TextToSpeech` itself. It shows the lock-screen card approved at the Stage 0 sign-off, with the article's cover as its artwork (flow decision 72). It maps play, pause and the ±15 s skips onto the speech, and passes the engine's word positions on to the app from its own listener. This test held a session by playing a media file at zero volume through expo-audio. That kept everything running, but it is a stand-in only (see test 3).
2. **A native scrypt on the phone.** The pairing code's scrypt is correct on Hermes but takes 2.6 s, too long a freeze after someone types a code. A native implementation fixes that, either a small Expo module or an existing library such as `react-native-quick-crypto`, and the contract's settings stay as they are. On desktop V8 the same JavaScript took 79 ms, so the extension should need nothing, though it hasn't yet been timed inside Chrome or Firefox.

## Set-up

| | |
|---|---|
| Phone | Google Pixel 10a, Android 17 (API 37), arm64-v8a, on USB power throughout |
| Voice | Google's speech engine (`com.google.android.tts`), language `en-GB` |
| Build | Release APK (Hermes bytecode, no Metro), arm64 only, debug-signed, package `space.shelf.app`, minimum SDK 24 and target SDK 36 (Expo's defaults), Shelf's final app icon (flow decision 70) |
| Stack | Expo SDK 57.0.25, React Native 0.86.3, expo-audio 57.0.5, expo-speech 57.0.3, expo-share-intent 8.0.1, react-native-webview 13.16.1, @noble/hashes 2.4.0 |
| Parser | The vendored `@mozilla/readability` 0.6.0 and `turndown` 7.2.4 (`shared/vendor/`), built into one bundle by `build-parser-bundle.mjs`, with Turndown options still provisional |
| Harness | `apps/mobile/App.tsx`: one plain screen with four tests, each logging to logcat under `[shelf-test]` |

CLAUDE.md asks for a development build. This run used a release build, built locally with Gradle, for two reasons. The app then runs without the Metro bundler, so nothing on the laptop keeps it alive while the phone is locked. And JavaScript runs at release speed, which the scrypt timing needs.

Everything was read over USB. The app's own log came from logcat. While the phone was locked, a probe also read Android's own state every 30 seconds:

- the phone's power state (`mWakefulness` in `dumpsys power`);
- Shelf's media session and its position (`dumpsys media_session`);
- which processes were making sound (`dumpsys audio`).

The probe only ever recorded Awake or Dreaming. Dreaming is Android's screen saver state, which a locked phone on charge shows. It never recorded Asleep or Dozing. The probe's times are when it looked, up to 30 seconds after an event; event times below come from the app's log.

The first release build took 21 minutes from a cold Gradle cache. Expo's prebuild produced the share filter for `text/*` and expo-audio's `mediaPlayback` foreground service without hand edits.

## 1. Share, fetch, parse: pass

The harness fetches a shared link with a desktop Chrome user agent and passes the HTML into a hidden WebView holding the vendored bundle. The bundle parses it into a detached document, so no page scripts run.

| | Crypto Briefing article | Wikipedia article |
|---|---|---|
| How it arrived | Shared by Richard; see the note below | A share intent sent over USB with `adb shell am start -a android.intent.action.SEND` |
| `share` log line | Missing | Present: text, `webUrl` and the picked URL |
| Fetch | 402 ms, HTTP 200, 308,240 characters of HTML | 410 ms, HTTP 200, 351,769 characters |
| Readability + Turndown | 46 ms | 149 ms |
| Fetch start to parsed article | 491 ms | 627 ms |
| Result | Title, byline and site name; 554 whitespace-separated Markdown tokens; `isProbablyReaderable` true; 3,590 characters of Markdown | Title, byline and site name; 8,338 tokens; 83,834 characters of Markdown |

Richard shared the Crypto Briefing article and saw it parse. The harness writes a `share` line before every shared fetch, and that line is missing from the captured log, so the log can't tell this share from a URL typed into the Parse box. The share intent sent over USB shows the share path itself works and logs as it should, with expo-share-intent passing the article's own address as `webUrl`. A share made in the X app with the line logged is still to be added (see Next).

The token counts are a raw split of the Markdown on whitespace. They include `##` markers and link addresses, so they aren't the contract's `words`, which counts the spoken text with syntax removed. The Markdown keeps `##` headings and `[text](url)` links, as the contract's canonical text needs; the harness prints it raw, and the Reader will render it. The Turndown options are provisional until `shared/turndown-rules.json` is written with the fixtures.

### Sharing an X post

Sharing a post from X gives Shelf the post's own address, such as `https://x.com/rich_rdctd/status/2106998463674351992?s=20`, never the article the post links to. Two posts Richard picked were sent to the app over USB in that form, the form of the links Richard copied from X. One links to an article; the other has only an attached photo.

| | Post with a link | Post with no link |
|---|---|---|
| Fetch | 1,143 ms, HTTP 200, 60,376 characters | 1,708 ms, HTTP 200, 63,401 characters |
| What came back | X's "Log in or sign up for X" page | the same |
| Readability's verdict | Success: title "Rich (@rich_rdctd) on X", 53 tokens of sign-up text, `isProbablyReaderable` false | Success, with the same kind of sign-up text, 54 tokens, `isProbablyReaderable` false |

So, as built, a shared X post would be saved as X's sign-up page, and Readability's own result doesn't flag it. Two things follow for the build:

- **A post needs its own route.** X's public embed service (`https://publish.x.com/oembed?url=…`) returns a post's author, text and links without signing in. For the post with a link, it gave the text and one `t.co` link, which redirects to `https://situationroom.space/briefing/2026-10-05`. The post with no link has one `t.co` link too, but it points back to the post's own photo. A rule that follows the first link leading outside X, and ignores links back to x.com or twitter.com, separates the two. `t.co` gives its redirect as a plain 301 only to a request without a browser user agent; with one, it serves an HTML page instead. Using the embed service tells X which post was saved, which X can already see from the person's own viewing.
- **A page that isn't an article must not be saved as one.** A sign-up wall parsed "successfully". `isProbablyReaderable` was false for both, so a false result with very short output should lead to the "Couldn't get the text" path, here and on any site with a sign-in wall.

Richard has since decided what a shared post saves (flow decisions 77 and 78): the article it links to, found through the embed service, and nothing else. X's API has no free tier and documents no way to read someone else's X Article, and X's developer policy requires stored X content to be deleted within 24 hours when it changes on X, which a private, mirrored library can't do. So Shelf stores nothing of X's, and a post with no outside link gets "No article in that post", with nothing saved.

Not tried yet: checking `text_hash` against the extension's for the same page, which needs the shared fixtures.

## 2. Word positions from the phone's voice: pass on this phone

On this Pixel, with Google's engine, `expo-speech`'s `onBoundary` reported `charIndex` and `charLength` for each word. The paragraph had 44 words in 217 characters, and it was spoken three times. The first two runs were cut short by pressing Speak again and the third by Stop; the longest reached word 36. All 58 events matched a word's exact start, with a length covering the word alone, not the punctuation after it.

| Word | `charIndex` | `charLength` | ms after `speak()` |
|---|---|---|---|
| A | 0 | 1 | 1,967 |
| saved | 2 | 5 | 2,132 |
| article | 8 | 7 | 2,494 |
| waits | 16 | 5 | 2,887 |
| … | | | |
| them | 173 | 4 | 10,895 |

Events arrived about every 240 ms (the median gap), and the first word came about 2 s after the call on a cold start. That is enough for the spoken-word highlight, the word stream Speed read shares with listening (flow decision 21), and the word meter (flow decision 68). The native module CLAUDE.md held in reserve for missing positions isn't needed on this engine. The positions come from Android's `onRangeStart`, which needs API 26, while Expo's default minimum is 24, so the app has to set its minimum SDK to 26, as `archive/03-android-v1.0.md` already says. Other engines, such as Samsung's, are untested; for engines without word timing the mobile spec marks the sentence being spoken (`play-sentence`, flow decision 91 (h)).

## 3. Five minutes behind the lock screen

### 3a. A file through expo-audio: pass, on USB power

A six-minute WAV of ticks, with a group of beeps each minute, was played with `setAudioModeAsync({ shouldPlayInBackground: true, interruptionMode: 'doNotMix' })` and `setActiveForLockScreen(true, …)`. Then the phone was locked.

- The file started at 13:43:42 and played to its end at about 13:49:42. The probe saw Shelf's media session PLAYING, with Shelf making sound, at every look from 13:44:09. At 13:49:54 it found it stopped at position 360,008 ms, the end of the file.
- The probe read the phone as Dreaming from 13:44:40, with one Awake reading at 13:48:51. It was behind the lock screen for about five minutes, at least 3 min 40 s of it without a break. That is past the roughly three minutes after which Android stops background playback that isn't set up properly.
- The app's own position log kept arriving every 10 s throughout, so the whole app stayed awake as well as the sound.
- The lock-screen card showed, with its controls.

### 3b. The phone's voice, with a media session held: pass, on USB power

Twenty parts of text (7,127 characters, written for the test) were queued with `Speech.speak`. To hold a media session, expo-audio played the six-minute tick file from 3a at zero volume. Then the phone was locked.

- The voice read all twenty parts in 6 min 40 s, 13:51:25 to 13:58:05. The probe saw Google's speech engine making sound at every look, and read the phone as Dreaming from 13:52:31 to the end.
- Every part's `onDone` reached the app on time behind the lock screen, about every 20 s, so the app can follow progress while locked.
- The tick file is six minutes long, so it stopped at about 13:57:25, and the voice read its last 40 seconds or so with the file stopped. Expo's foreground service was still running then (see 3c), so this isn't a reading without a service.

### 3c. The phone's voice with no media session: not cleanly tested

With the harness's "Hold a media session" switch off, Read aloud was pressed twice, three seconds apart, so the twenty parts were queued twice. The voice and the app's callbacks kept going from 14:00:07 until at least 14:11:07, the last callback in the log. The probe read the phone as Dreaming from 14:00:23 to 14:09:16, apart from one Awake reading at 14:03:31.

This run doesn't show what happens with no service at all. Expo's media service, started in 3a and used again in 3b, was still running in the foreground, because nothing had released it. The muted tick file also started playing again at about 14:05:20, until the harness paused it at 14:06:47 (below). Richard chose to skip a clean rerun: v1 holds a media session whenever it speaks, for the lock-screen card, so the answer would only show how speech copes if the session drops.

### What this means for the build

The muted-file stand-in works but isn't fit to ship. Its session ends when the file does. Its lock-screen buttons control the file rather than the speech. Its position and metadata describe the file. The build needs the media-session module described under Outcome.

The run also showed that the session has to be torn down when listening ends. After 3b, Expo's media notification stayed on the lock screen, stopped. During 3c the muted tick file started playing again from the start, most likely from a tap on that leftover card. It played for about 87 seconds until the harness paused it, when the first of the two readings finished. The real module releases the session and its foreground service when the last article finishes or the player is closed.

## 4. The pairing code's scrypt: correct, too slow on Hermes

The typed code `K7QM4XPD` was run through scrypt with the contract's settings (salt `shelf/pair-code/v1`, N = 16384, r = 8, p = 1, 64 bytes).

| Where | Time | Output |
|---|---|---|
| Node 24, native `crypto.scryptSync` (desktop) | 40 ms | `8a0b73e6…` (reference) |
| @noble/hashes in Node on V8 (desktop) | 79 ms | matches |
| @noble/hashes on Hermes, blocking (phone, three runs) | 2,614 / 2,649 / 2,639 ms | matches |
| @noble/hashes on Hermes, `scryptAsync` with a 10 ms tick (phone) | 13,880 ms | matches |

The lookup it derives is `8a0b73e641602ecd6e49f3c64dee51f053f79edfdea90594c8df40de02202d76`, identical on every engine. That belongs in the shared fixtures with the typed-code offer (contract section 9).

A 2.6 s freeze after typing a code, or 14 s without the freeze, is too slow, so the phone will use a native scrypt instead. Lowering N would make it cheaper for an operator to try all 2^40 possible codes against the lookup and read the offer in the five minutes it is held (contract 4.4). So the contract's settings stay as they are.

## Next

1. Rewrite the Android spec as an Expo mobile spec, with these results, the media-session module, the native scrypt and a minimum SDK of 26. Done: `03-mobile.md`.
2. Specify the media-session module (done: `03-mobile.md` section 8.1, `shelf-voice`):
   - a foreground `mediaPlayback` service;
   - Android `TextToSpeech` fed sentence by sentence from the spoken-text version of the normalised Markdown (contract 4.2), with word positions mapped back to the Markdown for highlighting (contract 7);
   - play, pause and the ±15 s skips mapped onto the text, with the exact rule settled in the spec;
   - the cover as artwork, and word positions passed to JavaScript;
   - the session released when listening ends.
3. Add the typed-code vectors to the shared fixtures, with code, lookup, key and offer.
4. Specify flow decisions 77 and 78 (now on the flow map and in the prototype): a shared X post is checked through X's embed service and saves the article it links to; one with no outside link saves nothing ("No article in that post"). A page Readability marks not readable, with very little text, gets "Couldn't get the text". Done: `03-mobile.md` section 5.4, with contract sections 4.2 (the guard) and 4.3 (the X rule).
5. Still to test on a phone:
   - a locked run on battery, off USB, for both the file and the voice;
   - a share made in the X app itself with its `share` line logged (the two posts above were sent over USB);
   - another phone's speech engine, such as Samsung's;
   - the cross-platform `text_hash` check;
   - scrypt inside Chrome and Firefox;
   - a clean run of 3c if the session design changes.

The harness in `apps/mobile` is a test screen only. The app proper starts from the rewritten spec.
