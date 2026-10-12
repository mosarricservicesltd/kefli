# Microsoft Edge Add-ons listing

The text for the Kefli extension's listing on Microsoft Edge Add-ons (extension spec section 12: Edge takes the Chrome package), page by page as Partner Center asks for it. Written on 12 October 2026 against extension 0.1.1, from Microsoft's guide, learn.microsoft.com/microsoft-edge/extensions/publish/publish-extension. Where Edge asks what the Chrome Web Store asks, the answer is the one in `chrome-web-store.md`, so the two listings stay the same; a change to one is a change to both.

## Packages

Upload `apps/extension/dist/kefli-chrome-store-<version>.zip`, from

```
KEFLI_DEFAULTS_URL=https://api.kefli.app/defaults.json npm run build:store -w @kefli/extension
```

on a clean checkout of the release commit: the same package as the Chrome Web Store's. It carries no `key`, so Edge assigns the ID, which differs from Chrome's, and an Edge user who had the unpacked beta pairs again.

## Availability

**Visibility:** Hidden until launch (only people with the listing's address can find it), then Public. Spec 12 keeps the stores' listings out of the beta.

**Markets:** all markets.

## Properties

**Category:** Productivity

**Website:** https://kefli.app

**Support contact detail:** https://kefli.app/extension

**Mature content:** no.

## Privacy

Every answer is the Chrome Web Store's (`chrome-web-store.md`, Privacy tab), word for word:

- **Single Purpose Description:** the single purpose.
- **Permission justification:** the five justifications, `activeTab`, `scripting`, `storage`, `alarms` and `contextMenus`.
- **Are you using remote code?** No, I am not using remote code.
- **Data usage:** Website content, and nothing else, with all three certifications ticked. A save sends the page's text, title and address, encrypted, to Kefli's server for the user's phone, so Website content is the accurate answer, as on Chrome; Firefox's declaration says the same in its own terms.
- **Privacy Policy URL:** https://kefli.app/extension-privacy

## Store listing (English)

**Extension name** and **Short description** come from the manifest and can't be edited here: "Kefli" and "Save the page you are reading to Kefli on your phone."

**Description** (250 to 10,000 characters): the Chrome Web Store's description, about 1,700 characters. Edge runs the Chrome package, so its wording is right as it stands, "Save link to Kefli" included.

**Extension logo** (required, 1:1, 300 × 300 recommended): `shared/brand/out/extension/edge-logo-300.png`, from the brand build: the mark on its graphite tile with no padding.

**Small promotional tile** (440 × 280): `shared/brand/out/extension/cws-promo-tile.png`, the Chrome Web Store's.

**Large promotional tile** (1400 × 560): `shared/brand/out/extension/edge-large-tile.png`, from the brand build: the icon tile, the name, the tagline "Save anything. Read it clean and offline, or listen to it." and the strip of covers, as on the website's share card.

**Screenshots** (up to six, 1280 × 800): the four in `docs/store/screenshots/edge/`, in order: `1-saved.png`, `2-save-link.png`, `3-connect.png` and `4-connected.png`. They're the Chrome set with Edge's details: the `extension://` address, "Edge on a Windows PC" (`browserLabel`, `src/pair.ts`), and Edge's link menu ("Open link in InPrivate window", "Copy link"); Edge runs the Chrome build, so its item reads "Save link to Kefli". Make them again with `node apps/extension/scripts/store-screenshots.mjs --edge` after a dev build.

**YouTube video URL:** none.

**Search terms** (up to seven, 30 characters each, 21 words in all):

```
read later
reading list
save articles
offline reading
text to speech
read aloud
private
```

## Notes for certification

```
Kefli saves the page the user is reading to the Kefli app on their Android phone, so saving needs the phone: install the Kefli Android app (https://kefli.app), then click the toolbar button, which opens the options page with a QR code to scan in the app (You > Connected browsers > Connect a browser). Without a phone you can see the options page and the pairing QR, and the toolbar button opens the same page until the extension is paired.

There are no accounts or test credentials: pairing with the phone is the only sign-in. The extension works the same in every region.

The extension reads a page only after the user clicks the button, presses Alt+Shift+S or chooses Save link to Kefli on a link. What it captures is encrypted in the browser (NIP-44 and AES-GCM) before it is sent to Kefli's server (api.kefli.app, relay.kefli.app and Kefli's encrypted file store), so only the user's phone can read it. It has no host permissions, runs no remote code, and has no analytics or telemetry. The source is public under the AGPL; the build is apps/extension/build.mjs, never minified.
```

## After the first approval

A new version is the same package as the Chrome Web Store's for that version, uploaded under Packages; certification takes up to seven business days.
