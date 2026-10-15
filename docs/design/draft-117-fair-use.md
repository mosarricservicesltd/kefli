# Fair use: 50 MB of text per library, 20 MB a day (decision 117)

Drafted on 14 October 2026. Richard asked for a fair-use policy and a cap on storage to keep the server's costs down, "a paid feature later", with an estimate of the average article's size. **His three choices, made the same day, are decided**; the low-level choices under them are Claude's, under the standing rule on edge cases, and the copy is drafted for his read. Contract 1.12 carries the protocol; the flow map and the prototype carry the screens. Revised the same day after a review of the documents written from it, so that it matches contract 1.12, which wins wherever the two differ.

## How big a save is

Measured on 14 October on the 23 pages of `shared/fixtures/live-urls.json` that parse, through the app's own `fetchPage` with desktop Chrome running the parser bundle (as `apps/mobile/scripts/live-urls.ts` does):

| | Text stored per save |
|---|---|
| Mean | 28.1 KB (22.5 KB leaving out one whole book) |
| Median | 17.5 KB, about 2,300 words |
| Smallest, largest | 1 KB; 153 KB (a Gutenberg book) |
| Bytes per word | 7.0 |

Some of them: BBC 3.7 KB, the Guardian 7.8 KB, Medium 14.7 KB, Ars Technica 16.8 KB, Martin Fowler 36.9 KB, MDN 38.6 KB, Paul Graham 68.8 KB, a Substack essay 76 KB.

What Kefli's server holds for a save is its Markdown, encrypted with AES-GCM (16 bytes more) and not compressed. Pictures aren't stored on the server; the phone fetches them from the page and keeps them in its own cache. Each save's record on the relays is 1 to 2 KB, and the relays aren't part of the cap. The planning figure is **25 KB a save, 40 saves a megabyte**: a year of two saves a day is about 18 MB, five a day about 45 MB.

## Richard's choices

1. **A free library keeps up to 50 MB of saved text on Kefli's server** (it was 200 MB): about 2,000 articles. A paid tier may raise it later.
2. **A library uploads at most 20 MB a day** (about 800 articles), so a script can't fill it in an hour.
3. **Over the cap, or past the day's 20 MB, a new save's text stays on the phone**, is tried again each day, and counts under Advanced as not backed up.

## What that needs, Claude's choices

The code today would turn choice 3 into something harsher, so each of these follows from it.

- **The save still goes out.** A save's publish waits for its text's upload (`data/saves.ts`, `queueSends`), so a refused upload today holds back the whole save, link and title included, and a refusal for good kills it. From 1.12 a save whose text Kefli's server refuses, whatever the reason, or can't take while its disk is full (507), is published at once **without its text** (`text: null`), to every write relay, so its link, title, state and place are backed up and synced like any other save; only the text waits on the phone. On another phone, or after a restore, a save that arrives without text is fetched and parsed again from its page, as one already is (`data/sync.ts`).
- **Two phones on a full library.** Today a phone whose row has a text takes a newer copy without one by dropping its text and parsing the page again (`takeRemote` in `data/sync.ts`), and a phone that parsed a page sends the save again with its own text (`queueSends`). On a full library each would then send the save without text in turn, for ever, and each dropped text's waiting upload would be left behind, since `retireBlob` deletes only a blob that reached the server, to be uploaded later with no save naming it. So from 1.12 a phone that holds the text, on the phone or waiting to upload, keeps it when a copy without text arrives, and sends the save naming it once the text is backed up, at once if it already is; a save whose only change is a text this phone parsed isn't sent again until that text is taken; and taking a copy that names another text cancels this phone's own waiting upload.
- **What waits.** The server answers 413 with a reason: `quota` (over the cap) and `daily` (past the day's 20 MB) are tried again a day later, as G5 is today. Only `too_large` (a text over 8 MB) is refused for good: it is never tried again, and its text stays on the phone. Any other 4xx but 401 and 429 is tried again a day later too, so a fault on the server can't strand a text, and a 507 is tried again as any 5xx. The mirror copies from Kefli's server (BUD-04), so it waits for that copy, as now.
- **When the text gets through later** (room was made, or the next day came), the upload goes, then the mirror, and the save is published again naming both, through the republish that already follows a mirror's success. It counts as not backed up until then.
- **The day's 20 MB counts bytes new to the server's disk**, over any 24 hours. An upload of a blob the server already stores, for anyone, costs nothing: a move's re-uploads and a repeat upload don't count. A browser's uploads count with its library's. It is counted from a log of uploads, so deleting doesn't give the day back.
- **The 50 MB counts each blob once per library**, the person's own uploads and their browsers' together, as now. A browser's capture counts until the phone has taken it: **the phone now deletes the capture from Kefli's server** once the request has made or matched a save, so captures no longer sit there for 14 days. That needs one new rule on the server: the library a blob counts against may delete it.
- **Deleting makes room.** Deleting a save whose text is still waiting to upload now cancels that upload (today it would go later, and nothing would ever delete it). Once Kefli's server confirms a deletion, the texts waiting for space (`quota`) that fit the room it leaves are tried at once instead of the next day, oldest first, stopping at the first refused, so a deletion asks for no signing for texts that can't fit; those waiting for the day's 20 MB (`daily`) wait a day, since deleting gives none of the day back.
- **Imports count like any save** (contract 4.6 has no cap). Bringing in 2,000 bookmarks adds about 49 MB: about 800 texts go each day while Kefli is open, and an import past the space leaves the rest of its texts on the phone. The fair use page says so; the import sheet is unchanged.
- **A move doesn't stall.** A move (contract 4.8) waits for its uploads under the new identity; an upload refused for room or for good now counts as done for the move, and a move's re-uploads cost nothing against the day's 20 MB (above). The new identity's copy of such a save names the mirror that holds the old identity's blob, if one does, so a text backed up before the move stays backed up; otherwise it goes without its text. Either way the text waits on the phone under the new identity.
- **A browser save over the cap** today names a blob the server never took, and the phone waits up to 14 days before fetching the page itself. From 1.12 the extension sends the request with `html: null` when its upload is refused with any 4xx but 401 and 429, `quota` and `daily` included, since it doesn't wait for room, and shows its existing toast "… · your phone will fetch the text"; and the phone treats a capture its server answers 404 for as gone, fetching the page at once. A capture counts like any upload, which keeps the server's disk bounded, so past either limit the phone reads the page from its own fetch, and a page that needs the person signed in may then bring no text. The fair use page says so.
- **Existing libraries**, created at the old default of 200 MB, are lowered to 50 MB once, by a schema version, and any library set to another figure keeps it (for a paid tier). One already past 50 MB keeps everything it holds, and its new texts wait until deleting brings it back within the quota. `POST /register` reports the library's own quota, and `keflictl quota <pubkey> <MB>` sets one.
- **Seeing it.** A new `GET /account` answers `{v, quota, used, daily, today}`. The phone asks when Advanced opens, takes the same figures from any 413 `quota` or `daily`, and keeps the last it has.
- **The claim.** Every save is still backed up away from Kefli's servers, and so is its text while the library is within its 50 MB. Past that, past the day's 20 MB until a later day's uploads take it, and for good over 8 MB, a save's text has only the phone's copy, and a new phone gets it again from the page, which may have changed or gone. Contract section 1, the honesty rule in `CLAUDE.md`, decision 93 and the website say so. Advanced's count of saves not backed up includes those saves, and its notice says why.

## Advanced: Backup space

A new group under the relays' note, before Export my saves:

**Backup space** (group label)

| State | Row "Kefli's server" (icon: hard drive), its sub |
|---|---|
| Populated | 12.4 MB of 50 MB |
| Nearly full (90 % or more) | 46.1 MB of 50 MB · nearly full |
| Full (a text waits on a 413 `quota`, or less than a block, 4,096 bytes, of the quota is left, decision 118) | Full · 49.9 MB of 50 MB |
| Empty (nothing uploaded yet, or not registered) | 0 MB of 50 MB |
| Loading (first check, nothing known) | Checking… |
| Offline, nothing known | Checks when you're online |
| Offline or couldn't check, with an earlier answer | the earlier answer, as above |
| Couldn't check, nothing known | Couldn't check |

Fine print under the group: "Kefli's server keeps up to 50 MB of your saves' text, about 2,000 articles, and takes up to 20 MB a day. Past that, a save's text stays on this phone. Every save's link is backed up whatever the space." Its figures are the library's own, from the last answer (the articles at 25 KB each, rounded to the hundred), so a library given more space reads its own; 50 MB and 20 MB are the defaults.

Figures have one decimal, rounded down, so a library short of its quota never reads as 50 MB: 0 MB, 3.2 MB, 12.4 MB, 49.9 MB. Megabytes are 1,048,576 bytes, as the server counts them. The server refuses a text that would take the library past its quota, so Full comes once a text didn't fit, usually just short of the quota: "Full · 49.9 MB of 50 MB". A library still above a lowered quota reads its real use, such as "Full · 120.3 MB of 50 MB".

**The notice slot**, which today holds the export failure line and the count of saves not backed up (`adv-notbacked`). One notice about saves not backed up shows, the first that applies: room, then the existing count of saves Kefli is still trying to back up, then texts too long to back up.

- **Full** (`adv-full`), while any text waits on a 413 `quota`: "Your backup space is full, so the text of three saves is only on this phone. Kefli tries again each day, and deleting saves makes room."
- **The day's 20 MB used** (`adv-daily`), while none waits on `quota` and one waits on a 413 `daily` from the last 24 hours: "You've saved a lot today, so the text of three saves is only on this phone for now. Kefli tries again tomorrow."
- One save: "…the text of one save is only on this phone…" in both.
- **Too long** (`adv-toolarge`), for texts over 8 MB, which are never sent again: "The text of one save is too long to back up, so it's only on this phone. Its link is backed up." For more: "The text of two saves is too long to back up, so it's only on this phone. Their links are backed up."

The note under the relays, "Your other saves are copied to all three.", says "other" only while some save isn't on the relays yet. A save whose text alone stays on the phone, waiting for room or too long, is on every relay without it, so it doesn't count there.

## The Saved sheet

While Backup space would read Full, the sheet's line "Private. Ready to read offline in a moment." (`share`) reads **"Private. Your backup space is full, so its text stays on this phone."** (`share-full`). While a text waits on a 413 `daily` from the last 24 hours it reads **"Private. You've saved a lot today, so its text stays on this phone for now."** (`share-daily`). The save itself is made as always, Undo included. A share's upload waits for the sheet to close, so the first save past a limit has the usual line.

## The website

- **A Fair use page** (`/fair-use/`), linked from the footer: what's free (50 MB of saved text per library, about 2,000 typical articles, and 20 MB a day); what counts (each save's encrypted text, and a browser's capture until the phone takes it; pictures, links and reading places don't); what happens past it (the save is made and its link backed up, its text stays on the phone and Kefli tries again a day later while the app is open, and Advanced shows it; a page saved from the browser is read by the phone's own fetch, so one that needs signing in may come without its text; bookmarks brought in count like any save; a single text over 8 MB is never backed up, which the privacy page says too); how to make room (delete saves you don't need; archiving doesn't free space); where to see it (Advanced → Backup space). Drafted for Richard's read, and it promises nothing about paid plans.
- **Privacy**: "how much of your 200 MB of storage they use" becomes "how much of your 50 MB of backup space they use, and how much you've uploaded in the last day"; the section on copies says that a save's text is copied while the library is within its 50 MB, with a link to Fair use.
- **The landing page**: "By default your library is also copied to servers we don't run" gains "every save, and its text up to your free 50 MB", linking to Fair use. The headline "Your library outlives us" stays: every save outlives the service, and past the cap its text comes back from the page, if the page is still there.
- **Extension privacy**: a capture counts towards the library's backup space until the phone takes it, and is deleted from Kefli's server then, or after 14 days at the latest.

## Copy to read

Everything in quotation marks above is drafted, for Richard's read: the Backup space group, its row's subs and fine print, the three notices, the Saved sheet's two lines, and the website's new page and changed sentences.
