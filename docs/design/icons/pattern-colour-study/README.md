# Icon pattern and colour study

Made on 6 October 2026, when Richard wanted to revisit the app icon (decision 70: cover C·L·063 on pattern P012, the bands, with the paper mark). `icon-study.html` is the page, published privately at https://claude.ai/artifact/8abd8kauAgihkxQdCopU5E: pick a pattern and a colour and see the pair next to today's icon, at real size in a browser toolbar, on home screens, in Android's mask shapes and as a Play listing. Nothing in `shared/brand` changes until Richard chooses.

## How it was made

1. **Patterns.** `gen-patterns.cjs` takes the first icon round's 32 seeds and `shelf/icon/1` to `/600`, draws each as cover v1 at depth 1 (one big shape or four), and keeps the 566 that differ (`patterns.json`, and `patterns.js` for the sheet page). A pattern is a cover's composition, bytes 4 onward of its hash; its colour comes from bytes 0 to 3, so any pattern can take any colour.
2. **Judging.** Three judges, as separate agents, each looked at contact sheets of all 566 (with and without the mark) and at 16 and 32 px, and shortlisted 15: one for how the mark sits, one for character, one for range. Their plain-English notes are in `notes.json`. The 18 on the page are every pattern two or three judges picked, plus six that cover kinds the rest don't.
3. **Colours.** Fourteen palettes from the generator (today's, seven dark grounds, six light) and the generator's two grey sets.
4. **The mark.** For each of the 288 pairs, `markrule.cjs` renders the cover and samples a ring just outside the bookmark and the bar, then keeps the bookmark's ink outline and the ink bar unless paper alone stands out better there. Pairs where part of the mark still fades are flagged. The results are in `study-data.json` (written by `marks.cjs`).
5. **The page.** `build-study.cjs` inlines cover v1 from `shared/cover`, the data and the notes into `study.tpl.html` and writes `icon-study.html`. Two reviewers checked visuals, accuracy and copy before each publish.

## Rebuilding

```bash
node gen-patterns.cjs
NODE_PATH=<folder with @resvg/resvg-js@2>/node_modules node marks.cjs P012
node build-study.cjs
```

Run `marks.cjs` once per pattern id (as above) to keep memory low; `build-study.cjs` refuses to build if any pattern lacks marks or notes. To look at any patterns, `node shotsheet.mjs <name>.png "ids=P012,P315&big=1&pal=cd210"` writes `sheets/<name>.png` (`mark=0` drops the mark, `pal=cl063` uses today's colours, `small=1` draws 16 and 32 px); `sheets/` is git-ignored.

## Choosing

Tell Claude a pattern and a colour, such as P315 with C·D·210. Their hash is the colour's four bytes followed by the pattern's hash from byte 4 on, and the panel shows it. A new flow decision then replaces decision 70, the artwork is frozen in `shared/brand/src`, `build-icons.cjs` rebuilds the brand files, and the 16, 28, 32 and 48 px cuts are tuned by hand.
