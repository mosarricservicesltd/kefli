# Fair use: 50 MB of text per library, 20 MB a day (decision 117)

Drafted on 14 October 2026. Richard asked for a fair-use policy and a cap on storage to keep the server's costs down, "a paid feature later", with an estimate of the average article's size. **His three choices, made the same day, are decided**; the low-level choices under them are Claude's, under the standing rule on edge cases, and the copy is drafted for his read. Contract 1.12 carries the protocol; the flow map and the prototype carry the screens.

## How big a save is

Measured on 14 October on the 23 pages of `shared/fixtures/live-urls.json` that parse, through the app's own `fetchPage` with desktop Chrome running the parser bundle (as `apps/mobile/scripts/live-urls.ts` does):

| | Text stored per save |
|---|---|
| Mean | 28.1 KB (22.5 KB leaving out one whole book) |
| Median | 17.5 KB, about 2,300 words |
| Smallest, largest | 1 KB; 153 KB (a Gutenberg book) |
| Bytes per word | 7.0 |

Some of them: BBC 3.7 KB, the Guardian 7.8 KB, Medium 14.7 KB, Ars Technica 16.8 KB, Martin Fowler 36.9 KB, MDN 38.6 KB, Paul Graham 68.8 KB, a Substack essay 76 KB.

What Kefli's server holds for a save is its Markdown, encrypted with AES-GCM (16 bytes more) and not compressed. Pictures aren't stored on the server; the phone fetches them from the page and keeps them in its own cache. Each save's record on the relays is 1 to 2 KB, and the relays aren't part of the cap. The planning figure is **25 KB a save, 40 saves a megabyte**: a year of two saves a day is about 18 MB, five a day about 46 MB.

## Richard's choices

1. **A free library keeps up to 50 MB of saved text on Kefli's server** (it was 200 MB): about 2,000 articles. A paid tier may raise it later.
2. **A library uploads at most 20 MB a day** (about 800 articles), so a script can't fill it in an hour.
3. **Over the cap, or past the day's 20 MB, a new save's text stays on the phone**, is tried again each day, and counts under Advanced as not backed up.

## What that needs, Claude's choices

The code today would turn choice 3 into something harsher, so each of these follows from it.

- **The save still goes out.** A save's publish waits for its text's upload (`data/saves.ts`, `queueSends`), so a refused upload today holds back the whole save, link and title included, and a refusal for good kills it. From 1.12 a save whose text Kefli's server refuses is published at once **without its text** (`text: null`), to every write relay, so its link, title, state and place are backed up and synced like any other save; only the text waits on the phone. The same holds for an upload refused for good (any 4xx but 401 and 429): the save goes without its text instead of going nowhere. On another phone, or after a restore, a save that arrives without text is fetched and parsed again from its page, as one already is (`data/sync.ts`).
- **What waits.** The server answers 413 with a reason: `quota` (over the cap) and `daily` (past the day's 20 MB) are tried again a day later, as G5 is today; `too_large` (a text over 8 MB) is never tried again, and its text stays on the phone. The mirror copies from Kefli's server (BUD-04), so it waits for that copy, as now.
- **When the text gets through later** (room was made, or the next day came), the upload goes, then the mirror, and the save is published again naming both, through the republish that already follows a mirror's success. It counts as not backed up until then.
- **The day's 20 MB counts bytes new to the server's disk**, over any 24 hours. An upload of a blob the server already stores, for anyone, costs nothing: a move's re-uploads and a repeat upload don't count. A browser's uploads count with its library's. It is counted from a log of uploads, so deleting doesn't give the day back.
- **The 50 MB counts each blob once per library**, the person's own uploads and their browsers' together, as now. A browser's capture counts until the phone has taken it: **the phone now deletes the capture from Kefli's server** once its save has its own text, so captures no longer sit there for 14 days. That needs one new rule on the server: the library a blob counts against may delete it.
- **Deleting makes room.** Deleting a save whose text is still waiting to upload now cancels that upload (today it would go later, and nothing would ever delete it). Once Kefli's server confirms a deletion, the uploads waiting for room are tried at once instead of the next day.
- **A move doesn't stall.** A move (contract 4.8) waits for its uploads under the new identity; an upload refused for room now counts as done for the move, its text staying on the phone as it was, and a move's re-uploads cost nothing against the day's 20 MB (above).
- **A browser save over the cap** today names a blob the server never took, and the phone waits up to 14 days before fetching the page itself. From 1.12 the extension sends the request with `html: null` when its upload is refused for good, 413 included, and shows its existing toast "… · your phone will fetch the text"; and the phone treats a capture its server answers 404 for as gone, fetching the page at once.
- **Existing libraries**, created at the old default of 200 MB, are lowered to 50 MB once, by a schema version, and any library set to another figure keeps it (for a paid tier). `POST /register` reports the library's own quota, and `keflictl quota <pubkey> <MB>` sets one.
- **Seeing it.** A new `GET /account` answers `{v, quota, used, daily, today}`. The phone asks when Advanced opens and after a 413, and keeps the last answer.
- **The claim.** Every save is still backed up away from Kefli's servers, and so is its text while the library is within its 50 MB. Past that, a save's text has only the phone's copy, and a new phone gets it again from the page, which may have changed or gone. Contract section 1, the honesty rule in `CLAUDE.md`, decision 93 and the website say so. Advanced's count of saves not backed up includes those saves, and its notice says why.

## Advanced: Backup space

A new group under the relays' note, before Export my saves:

**Backup space** (group label)

| State | Row "Kefli's server" (icon: hard drive), its sub |
|---|---|
| Populated | 12.4 MB of 50 MB |
| Nearly full (90 % or more) | 46.1 MB of 50 MB · nearly full |
| Full | Full · 50 MB of 50 MB |
| Empty (nothing uploaded yet, or not registered) | 0 MB of 50 MB |
| Loading (first check, nothing known) | Checking… |
| Offline, nothing known | Checks when you're online |
| Offline or couldn't check, with an earlier answer | the earlier answer, as above |
| Couldn't check, nothing known | Couldn't check |

Fine print under the group: "Kefli's server keeps up to 50 MB of your saves' text, about 2,000 articles, and takes up to 20 MB a day. Past that, a save's text stays on this phone. Every save's link is backed up whatever the space."

Figures have one decimal, rounded down, so a library short of full never reads as 50 MB: 0 MB, 3.2 MB, 12.4 MB, 49.9 MB, then Full. Megabytes are 1,048,576 bytes, as the server counts them.

**The notice slot**, which today holds the export failure line and the count of saves not backed up (`adv-notbacked`). When any save is waiting for room, the notice is about room; otherwise it is the existing one.

- **Full** (`adv-full`): "Your backup space is full, so the text of 3 saves is only on this phone. Kefli tries again each day, and deleting saves makes room."
- **The day's 20 MB used** (`adv-daily`): "You've saved a lot today, so the text of 3 saves will be backed up tomorrow."
- One save: "…the text of 1 save is only on this phone…", "…the text of 1 save will be backed up tomorrow."

## The Saved sheet

While the phone's last answer says the library is full, the sheet's line "Private. Ready to read offline in a moment." (`share-saved`) reads **"Private. Your backup space is full, so its text stays on this phone."** (`share-full`). Past the day's 20 MB it reads **"Private. You've saved a lot today, so its text will be backed up tomorrow."** (`share-daily`). The save itself is made as always, Undo included.

## The website

- **A Fair use page** (`/fair-use/`), linked from the footer: what's free (50 MB of saved text per library, about 2,000 typical articles, and 20 MB a day); what counts (each save's encrypted text, and a browser's capture until the phone takes it; pictures, links and reading places don't); what happens past it (the save is made and its link backed up, its text stays on the phone, and Advanced shows it); how to make room (delete saves you don't need; archiving doesn't free space); where to see it (Advanced → Backup space). Drafted for Richard's read, and it promises nothing about paid plans.
- **Privacy**: "how much of your 200 MB of storage they use" becomes "how much of your 50 MB of backup space they use, and how much you've uploaded in the last day"; the section on copies says that a save's text is copied while the library is within its 50 MB, with a link to Fair use.
- **The landing page**: "By default your library is also copied to servers we don't run" gains "every save, and its text up to your free 50 MB", linking to Fair use. The headline "Your library outlives us" stays: every save outlives the service, and past the cap its text comes back from the page.
- **Extension privacy**: a capture counts toward the library's backup space until the phone takes it, and is deleted from Kefli's server then, or after 14 days at the latest.

## Copy to read

Everything in quotation marks above is drafted, for Richard's read: the Backup space group, its row's subs and fine print, the two notices, the Saved sheet's two lines, and the website's new page and changed sentences.
