# Chrome Web Store listing

The text for the Kefli extension's Chrome Web Store listing (extension spec section 12), field by field as the developer dashboard asks for it. The upload is `npm run build:store -w @kefli/extension` (spec 12). Written on 11 October 2026 against extension 0.1.0.

## Store listing tab

**Name** (from the manifest): Kefli

**Summary** (from the manifest, 132 characters at most): Save the page you are reading to Kefli on your phone.

**Category:** Productivity, Tools

**Language:** English (United Kingdom)

**Description:**

```
Save the page you're reading with one click, and it's waiting in Kefli on your phone.

Kefli is a free read-it-later app. Save articles from anywhere, read them without the clutter, or listen while you do something else. This extension is the browser half: it sends the article you're reading on your computer to your library on your phone.

HOW TO SAVE
• Click the Kefli button in the toolbar.
• Press Alt+Shift+S.
• Right-click a link and choose Save link to Kefli, to save a page without opening it.

A small notice confirms the save, with Undo if you didn't mean it. Saved while offline? The extension keeps the save, encrypted, and sends it when you're back online.

WHAT ARRIVES ON YOUR PHONE
The extension reads the article on the page as you see it, so pages you're signed in to come through as you read them. On your phone the article is laid out for reading, kept for offline use, and can be read aloud in your phone's own voice.

PRIVATE BY DESIGN
• The extension reads a page only when you save it. It never reads your history, your other tabs or your cookies.
• What it captures is encrypted in your browser before it leaves, and only your phone can open it. Kefli's servers see encrypted files and nothing more.
• The extension never holds your library's key. It gets a key of its own when you pair it with your phone, and you can remove it from your phone at any time.
• No analytics, no adverts, no account and no signup.

GETTING STARTED
You need the Kefli app on an Android phone. Install the extension, click its button, and it shows a QR code. On your phone, open Kefli, go to You, choose Connect a browser and scan the code.

Kefli is open source under the AGPL. More at https://kefli.app
```

**Graphics:** the 128-pixel icon is in the package (`icons/icon-128.png`). At least one 1280×800 screenshot is required; the useful three are the toolbar button with the Saved popup over an article, the pairing QR code on the options page, and the same article in the phone's reader. A 440×280 small promo tile is optional.

**Official URL:** none (kefli.app needs verifying in Search Console first; optional).

**Homepage URL:** https://kefli.app

**Support URL:** https://kefli.app/extension

## Privacy tab

**Single purpose:**

```
Kefli saves the web page or link the user chooses to the user's own Kefli reading library on their phone, so they can read or listen to it there later.
```

**Permission justifications:**

`activeTab`
```
When the user clicks the Kefli toolbar button, presses the extension's keyboard shortcut (Alt+Shift+S) or chooses "Save link to Kefli", activeTab gives the extension temporary access to that one tab, so it can read the article's text, title, author and address to save it. The extension requests no host permissions and has no access to any tab the user hasn't acted on.
```

`scripting`
```
Used with activeTab, only in the tab the user is saving and only after their click, shortcut or menu choice. It runs two scripts bundled in the package: the article parser (Mozilla Readability and Turndown), which extracts the article text from the page, and a small notice that confirms the save and offers Undo. No remote code is injected.
```

`storage`
```
chrome.storage.local holds the pairing with the user's phone (the phone's public identifier, the server addresses to send to and the date of pairing), the extension's own device key, the server settings it fetched, and any saves waiting to be sent while the browser is offline, which are stored already encrypted. chrome.storage.session holds the state of the confirmation popup for the current session. Unpairing or removing the extension deletes all of it.
```

`alarms`
```
A Manifest V3 service worker can't stay running, so the extension uses two alarms. One retries saves waiting in the offline queue every minute until they are sent, and is cleared when the queue is empty. The other runs every 30 minutes to check whether the user's phone has sent a message moving the pairing to a new key, so saves keep reaching the right phone.
```

`contextMenus`
```
Adds one item, "Save link to Kefli", to the right-click menu on http and https links, so the user can save a linked page without opening it. Only the link's address is sent, and the phone fetches the page itself.
```

**Remote code:** No, I am not using remote code.

```
All JavaScript is in the package. The extension fetches a JSON settings file (the server addresses) and sends encrypted saves over HTTPS and WebSocket, but never loads or runs code from outside the package.
```

**Data usage:** tick **Website content**, and nothing else.

Section 12 of the extension spec says "does not collect or use any user data". The store counts any user data that leaves the browser as collected, encrypted or not, and the article text, title and address of a saved page do leave it, encrypted, on their way to the user's phone. Ticking Website content is the accurate answer, and the privacy note at kefli.app/extension-privacy already describes exactly that. None of the other categories apply: the extension sends no identity, no browsing history beyond the page saved, no location and no activity data. Then tick all three certifications: data isn't sold to third parties, isn't used or transferred for purposes unrelated to the single purpose, and isn't used to determine creditworthiness or for lending.

**Privacy policy URL:** https://kefli.app/extension-privacy

## Distribution tab

**Visibility:** Private or Unlisted until launch (spec 12 keeps it unpublished until Stage 5 and out of the beta); Public at launch.

**Regions:** all regions.

**Pricing:** free, no in-app purchases.
