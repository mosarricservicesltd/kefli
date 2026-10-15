# Firefox Add-ons (AMO) listing

The text for the Kefli extension's listed add-on on addons.mozilla.org (extension spec section 12), field by field as the Developer Hub asks for it. Written on 11 October 2026 against extension 0.1.1. Submitted on 15 October 2026 as 1.0.0 by API (web-ext sign, listed channel, with the source archive and the metadata below): the add-on is `kefli`, its version page https://addons.mozilla.org/en-US/developers/addon/kefli/versions/6582416, awaiting review. The icon and the four screenshots went in by hand in the Developer Hub the same evening, and the public page will be https://addons.mozilla.org/firefox/addon/kefli/ once approved, when `VITE_FIREFOX_STORE_URL` in `apps/web/site.env` takes it. The Chrome Web Store's is `chrome-web-store.md` beside it; the two share the description and screenshots where Firefox allows.

## What to upload

**The add-on:** `apps/extension/dist/kefli-firefox-store-<version>.zip`, from

```
KEFLI_DEFAULTS_URL=https://api.kefli.app/defaults.json npm run build:store -w @kefli/extension
```

on a clean checkout of the release commit (Advanced then shows `store · <commit>` with no `-dirty`). It is the beta Firefox build against production, with its own ID, `kefli@extension.kefli.app`, and no `update_url`, since AMO updates a listed add-on itself. The self-hosted beta (`beta@extension.kefli.app`) is a separate add-on, so a tester moving to the listed one installs it fresh and pairs again.

**Platforms:** Firefox for desktop only. Firefox for Android isn't tested.

**Source code:** yes. The bundle is built with esbuild (never minified), so AMO needs the source and the steps that reproduce it. Make the source zip from the same commit:

```
git archive --format=zip -o kefli-source-$(git rev-parse --short HEAD).zip HEAD
```

It is the whole repository, about 12 MB, the same code that's public under the AGPL.

**Data collection** (the manifest's `data_collection_permissions`, shown in Firefox's install prompt): `websiteContent` and `browsingActivity`, both required. Mozilla counts anything handled outside the add-on, encrypted or not, and a save sends the page's text, title and address, encrypted, to Kefli's server for the user's phone. This matches the Chrome listing's Website content.

## Listing

**Name:** Kefli

**Add-on URL:** `kefli` (addons.mozilla.org/firefox/addon/kefli)

**Summary** (250 characters at most):

```
Save the page you're reading with one click, and it's waiting in Kefli on your phone to read clean, offline or aloud. Encrypted in your browser, so only your phone can read what you save.
```

**Description:**

```
Save the page you're reading with one click, and it's waiting in Kefli on your phone.

Kefli is a free read-it-later app. Save articles from anywhere, read them without the clutter, or listen while you do something else. This add-on is the browser half: it sends the article you're reading on your computer to your library on your phone.

HOW TO SAVE
• Click the Kefli button in the toolbar.
• Press Alt+Shift+S.
• Right-click a link and choose Save Link to Kefli, to save a page without opening it.

A small notice confirms the save, with Undo if you didn't mean it. Saved while offline? The add-on keeps the save, encrypted, and sends it when you're back online.

WHAT ARRIVES ON YOUR PHONE
The add-on reads the article on the page as you see it, so pages you're signed in to come through as you read them. On your phone the article is laid out for reading, kept for offline use, and can be read aloud in your phone's own voice.

PRIVATE BY DESIGN
• The add-on reads a page only when you save it. It never reads your history, your other tabs or your cookies.
• What it captures is encrypted in your browser before it leaves, and only your phone can open it. Kefli's servers see encrypted files and nothing more.
• Firefox lists website content and browsing activity under the data this add-on sends. That's the page you choose to save, its text, title and address, sent encrypted to your own phone, and nothing else.
• The add-on never holds your library's key. It gets a key of its own when you pair it with your phone, and you can remove it from your phone at any time.
• No analytics, no adverts, no account and no signup.

GETTING STARTED
You need the Kefli app on an Android phone. Install the add-on, click its button, and it shows a QR code. On your phone, open Kefli, go to You, choose Connect a browser and scan the code.

Kefli is open source under the AGPL. More at https://kefli.app
```

The menu item reads "Save Link to Kefli" in Firefox, in title case as Firefox's own menu items are (`src/bg.ts`); Chrome's says "Save link to Kefli".

**Categories:** Bookmarks, and Feeds, News & Blogging, if the Developer Hub still offers them; otherwise the nearest to "read later".

**Tags:** read later, reading list, offline reading, text to speech, privacy

**Homepage:** https://kefli.app

**Support site:** https://kefli.app/extension/

**Support email:** privacy@kefli.app (the address the extension privacy note gives; a general support address can replace it when there is one)

**Licence:** GNU Affero General Public License v3.0 or later, with the added permission in `LICENSE`. AMO has no AGPL slug (`License with slug=AGPL-3.0-or-later does not exist`, 15 October 2026), so it goes in as a custom licence whose text is `LICENSE`; by API that is `version.custom_license` with `name` and `text`.

**Privacy policy:** AMO wants the text itself. Paste the extension privacy note, kefli.app/extension-privacy, from "What it reads" to the end, with the contact line as "Write to privacy@kefli.app."

**Screenshots** (AMO shows them at 1280×800): the four in `docs/store/screenshots/firefox/`, in order: `1-saved.png` (the Saved notice with Undo), `2-save-link.png` (Save Link to Kefli in the right-click menu), `3-connect.png` (the QR code for connecting the phone) and `4-connected.png` (Connected, with the ways to save). They're the Chrome set with Firefox's details: the `moz-extension://` address, "Firefox on a Windows PC", and Firefox's wording in the link menu, as the Firefox build uses. Make them again with `node apps/extension/scripts/store-screenshots.mjs --firefox` after a dev build.

**Icon:** upload `shared/brand/out/extension/amo-icon-64.png` (64×64, from the brand build) in the Developer Hub's icon field. Without it AMO takes the manifest's `icons/icon-128.png`, whose 16 px of transparent padding is the Chrome Web Store's and makes the mark look small at AMO's 64 and 32.

## Notes to reviewer

AMO holds these to 3,000 characters (15 October 2026: 3,264 was refused). They are sent by API as `version.approval_notes` from `apps/extension/dist/amo-metadata.json`, which the upload command below builds them into.

```
Kefli saves the page the user is reading to the Kefli app on their Android phone. Saving needs the phone: install the Kefli Android app (https://kefli.app), then click the toolbar button, which opens the options page with a QR code to scan in the app (You > Connected browsers > Connect a browser). Without a phone you can see the options page and the pairing QR; the toolbar button opens that page until the add-on is paired.

BUILD (reproduces the uploaded package exactly)
Node 24 (tested with 24.18.0) and npm 12 (12.0.2), on Linux or macOS with the zip command.
  1. Unzip the source archive and cd into it.
  2. npm ci -w @kefli/extension
     (npm may list packages whose install scripts it didn't run; none are needed.)
  3. KEFLI_COMMIT=<commit> KEFLI_DEFAULTS_URL=https://api.kefli.app/defaults.json node apps/extension/build.mjs store
     where <commit> is the short commit in the archive's name.
  4. apps/extension/dist/store-firefox/ is the package; apps/extension/dist/kefli-firefox-store-<version>.zip is it zipped.
The build is apps/extension/build.mjs: esbuild bundles src/*.ts with packages/protocol and their npm dependencies (pinned by package-lock.json), never minified. KEFLI_COMMIT only fills in the commit shown under Advanced on the options page.

THIRD-PARTY CODE
parser.js is the article parser: @mozilla/readability 0.6.0 and turndown 7.2.4, copied byte for byte from the npm tarballs into shared/vendor (sha256 in shared/vendor/VERSIONS.md), plus our wrapper shared/vendor/parser-runner.js. Everything else comes from npm via package-lock.json (nostr-tools, @noble/hashes, @noble/ciphers, @noble/curves, @scure/base, toqr, mdast-util-from-markdown with micromark). cover-v1.js (shared/cover) draws each save's cover from its hash.

WHAT IT DOES AND DOESN'T DO
- Permissions: activeTab and scripting read the tab the user saves, only after their click, shortcut or menu choice; storage; alarms (retrying offline saves, and a half-hourly check for a message from the phone); contextMenus (Save Link to Kefli). No host permissions.
- Network: api.kefli.app (the settings file and the pairing offer), the WebSocket server at relay.kefli.app (a nostr relay) and Kefli's encrypted file store. Every save is encrypted in the browser before it is sent (NIP-44 and AES-GCM), so only the user's phone can read it.
- Data collection: websiteContent and browsingActivity, declared as required, are the saved page's text, title and address, sent encrypted for the user's own phone. Nothing is sent for a page the user doesn't save; no analytics or telemetry.
- No remote code: nothing is loaded or run from outside the package.
- The linter's innerHTML warnings are our own pages (options, popup, toast), where every value is escaped or is the cover's SVG drawn by our own code, plus the vendored Readability and Turndown. The action.onUserSettingsChanged warning is a feature check used only where Firefox has it.
```

## After the first approval

A new version is the same steps: bump `version` in `apps/extension/package.json`, build the store zip on the release commit, make the source zip from it, and upload both under the add-on's Versions page with the same reviewer notes.
