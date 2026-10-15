# Google Play listing

The Kefli app's Play Console entries (mobile spec 10, "Play Console"), field by field as the console asks for them, with the answers the app's own behaviour gives. Written on 15 October 2026 against app 1.0.0 (contract 1.12 on the `hostile-saves-and-fair-use` branch); the first upload is the release built from the merged commit, and the beta tests that same build, which launch promotes. The Chrome, Firefox and Edge listings are beside this file and share its wording where the stores allow.

## Before the console

**The developer account.** Register it as the organisation, Mosarric Services Ltd, not as a person. A personal account made since November 2023 must run a closed test with at least 12 testers for 14 days, and apply for production access afterwards, before anything can go to production; an organisation account has no such wait, though Google verifies the organisation first (a D-U-N-S number, the company's address and a contact it can confirm), which takes days. kefli.app is registered, which the app ID `app.kefli` reads as (flow decision 96). The developer name shown on the listing is the organisation's.

**App signing.** Every channel shares one signing key, `~/keystores/kefli-release.keystore` (alias `kefli`, SHA-256 `94:13:53:66:…:C9:79`), so an APK from Zapstore or kefli.app updates a Play install and the reverse. Play App Signing must therefore use that key, not one Google makes: when the console first asks, choose to export and upload a key from a Java keystore, run its PEPK tool on `kefli-release.keystore`, and upload the result. The same keystore then serves as the upload key. Nothing on the box or in the repository holds the keystore or its passwords (`KEFLI_RELEASE_*` in `~/.gradle/gradle.properties`).

**The bundle.** Play takes an Android App Bundle. From `apps/mobile`, with `KEFLI_DEFAULTS_URL=https://api.kefli.app/defaults.json` set as `build-release.sh` sets it, `npx expo prebuild --platform android --clean` and then `./gradlew bundleRelease` in `android/`; the release signing config (`plugins/with-release-signing.js`) applies to the bundle as to the APK. The bundle is `android/app/build/outputs/bundle/release/app-release.aab`. `versionCode` must rise with every upload (`app.json`, now 9); `version` is what the listing shows.

**Screenshots.** The console takes phone screenshots at 16:9 or 9:16 only, each side 320 to 3,840 px, and the Pixel 10a's are 1080 × 2424. `node apps/mobile/scripts/play-screenshots.mjs` fits each of `apps/mobile/store/screenshots/*.png`, whole, onto a 1080 × 1920 canvas in the screenshot's own ground colour, into `apps/mobile/store/play/`. Retake the Pixel screenshots after every build the listing should show (they are the running app in Android's demo mode), then run the script again; the website's four app images come from the same captures (`apps/web/public/media/SOURCES.md`).

## Main store listing

**App name** (30 characters at most): Kefli

**Short description** (80 characters at most):

```
Save anything, read it clean and offline, listen to it. No signup, no ads.
```

**Full description** (4,000 characters at most):

```
Kefli is a free read-it-later app. Share an article to Kefli from any app, or save it from the browser extension, and Kefli keeps a clean, readable copy on your phone to read offline or listen to with your phone's own voice.

SAVE ANYTHING
• Share a link to Kefli from any app on your phone.
• Save the page you're reading on your computer with the Kefli extension for Chrome and Firefox.
• Saved while offline? Kefli keeps the save and fetches the page when you're back online.

READ IT CLEAN
• Articles are laid out for reading: the text, the pictures, and nothing else.
• Everything you save is kept on your phone, so you can read on the train, on a plane, anywhere.
• Pick up where you left off: Kefli remembers your place in every article.
• Speed read: one word at a time, at the pace you choose.

LISTEN TO IT
• Any article can be read aloud, in your phone's own voice, with the words lit as they're spoken.
• Keep listening with the screen locked, with controls on the lock screen and in your car.
• Choose a voice for each language and your own default speed.

YOURS TO KEEP
• No signup, no account and no password: your phone makes a key that belongs to you alone, and shows it to you as a twelve-word recovery code.
• Every save is encrypted with that key before it leaves your phone. Kefli's servers see encrypted files and nothing more.
• Your library is also copied to independent servers we don't run, so it outlives us: if Kefli's service ever stops, your saves don't.
• Bring your library back on any phone with your recovery code, or pair a second phone by scanning a code.
• Delete everything, from every server, from inside the app.
• No ads, no tracking, no analytics.

Kefli is open source under the AGPL. The browser extension is at https://kefli.app/extension and more about Kefli at https://kefli.app
```

**App icon:** `shared/brand/out/android/play-store-icon.png`, 512 × 512, 32-bit PNG.

**Feature graphic:** `shared/brand/out/android/play-feature-graphic.png`, 1024 × 500, opaque 24-bit PNG.

**Phone screenshots** (2 to 8): `apps/mobile/store/play/`, 1080 × 1920 PNGs, in this order:

1. `1-welcome.png`: Welcome.
2. `3-library.png`: Saves, the library.
3. `4-reader.png`: the Reader.
4. `6-listening.png`: listening, with the spoken word lit.
5. `5-speedread.png`: Speed read.
6. `7-listen.png`: the Listen tab.
7. `2-empty.png`: Saves, empty, with the first-save hint.

Tablet screenshots: none; the listing says the app is for phones. Video: none.

**Category:** Application; Productivity. **Tags:** reading, read it later, offline, text to speech.

**Contact details:** email privacy@kefli.app (the forwarder in `server/deploy/README.md`, "Mail", delivers it to the company inbox); website https://kefli.app; no phone number.

## Store settings and policy declarations

**Privacy policy:** https://kefli.app/privacy/

**App access:** all functionality is available without special access. There is no login: a reviewer taps New here on Welcome and has a library. "Sign in with your nostr app" is an extra way in for people who already hold a key, and nothing in the app needs it.

**Ads:** the app contains no ads.

**Content rating** (the IARC questionnaire): a utility and productivity app. It lets the user save and read any web page they choose, so answer yes where the questionnaire asks whether the app gives access to the open web or to user-chosen web content; the content is whatever the user saves, and Kefli hosts none of it. No violence, sexuality, language, controlled substances, gambling, in-app purchases, user interaction or location sharing of the app's own. The rating this gives is the one for unrestricted web access.

**Target audience and content:** 18 and over. The app is not designed for children and isn't in the Designed for Families programme.

**News app:** no. **Government app:** no. **Financial features:** none. **Health:** none. **COVID-19 contact tracing or status:** no.

**Advertising ID:** the app doesn't use it. The manifest carries no `AD_ID` permission (the security plugin, mobile spec 7.1, removes anything a library adds).

**Foreground service permissions:** the app declares `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, for reading an article aloud while the screen is locked (the `mediaPlayback` type, mobile spec 8.1). The console asks for a description and a video of the feature in use:

```
Kefli reads a saved article aloud with the phone's own text-to-speech. The foreground service keeps playback running while the screen is locked or the user is in another app, with play, pause and skip on the lock screen, in the notification shade and from Bluetooth and car controls. It starts only when the user presses Listen or Play and ends when playback stops.
```

The video: a screen recording of the Pixel pressing Listen, locking the phone, and pausing and resuming from the lock-screen card, uploaded unlisted to YouTube; its link goes in the declaration.

**Permissions:** `CAMERA` is a runtime permission the console needs no declaration for; it is asked for only on Connect a browser and Scan from my other phone, to read the code shown. The manifest's other permissions (`INTERNET`, `VIBRATE`, `FOREGROUND_SERVICE`, `ACCESS_NETWORK_STATE`) are normal.

## Data safety

Play counts data as collected when it leaves the device for the developer's servers, whether or not the developer can read it, and the app's privacy note (https://kefli.app/privacy/, "On our server") already says what does. The spec's instruction (mobile spec 10, flow decision 22) is to declare the public key, the encrypted blobs and the device keys, and that no article text is sent anywhere readable. The answers, for Richard to confirm against the form's wording when he fills it in:

**Does the app collect or share any of the required user data types?** Yes.

**Is all of the user data collected by the app encrypted in transit?** Yes (TLS everywhere; the saves are also encrypted on the phone before they are sent).

**Do you provide a way for users to request that their data is deleted?** Yes: Delete my data in the app (You → Delete my data), and the page at https://kefli.app/delete-account/ says how.

**Data types**, each collected, not shared, required (the app can't work without it), for app functionality, and deletable by the user:

| Type | What it is | Ephemeral? |
|---|---|---|
| Personal info → User IDs | The library's public key, which identifies the library on Kefli's server and relays; for someone who signs in with a key they already use elsewhere, that key. No name, email address or other personal information is ever asked for. | No |
| Device or other IDs | The public keys of browsers the user connects, which Kefli's server holds so their saves reach the right phone | No |
| App activity → Other user-generated content | The user's saves: each page's address, title and text, encrypted on the phone with the user's own key before they are sent, so that Kefli's servers and the backup servers hold them but can't read them | No |

Not collected: name, email, address, phone number, financial information, health, location, contacts, calendar, messages, photos or videos, audio, files, web browsing history (Kefli sends the pages the user saves, declared above, and nothing about pages they don't), app interactions, search history, installed apps, crash logs, diagnostics, or any other data. There are no analytics, no crash reporting (flow decision 88) and no advertising SDK.

**Security practices:** data is encrypted in transit; users can request deletion; no independent security review.

If the reviewer asks about "web browsing history" for the saved pages, the answer is the one above: the user chooses each page to save, and Kefli learns nothing of the others.

## Account deletion

The console's deletion URL is https://kefli.app/delete-account/. The app deletes in place (Delete my data: every save from Kefli's server and the backup servers, then the phone), and the page describes the same steps for the Play policy's sake and gives privacy@kefli.app for anyone who can't use the app.

## Releases

1. **Internal testing** first, with Richard's own account and any tester's Google account on its list: upload the bundle, set the release name to the version (`1.0.0`), and paste the release notes. The internal track needs no review and gives a Play-signed install to compare against the Zapstore and website APKs (the signature must match, or the three can't update one another).
2. **Production** when the checklist's Pixel checks and the beta are done: the same bundle promoted, countries all, and the release reviewed by Google, which takes hours to days for a first submission.

**Release notes** (500 characters at most), for the first release:

```
Kefli's first release on Google Play: save articles from any app or the browser extension, read them clean and offline, and listen with your phone's own voice. Your library is encrypted with a key only you hold and copied beyond our servers.
```

Later versions: bump `version` and `android.versionCode` in `app.json`, build the bundle on the release commit, retake the screenshots if a screen the listing shows has changed, and upload under the track's new release.
