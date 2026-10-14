# Design QA

Small scripts that drive headless Chrome over the DevTools protocol, used to check the HTML prototypes in `docs/design/mockups`. They need Node 24 (for its built-in `WebSocket` and `fetch`) and Google Chrome; nothing to install. Output goes to `tools/design-qa/out/`, which git ignores.

| Script | What it does |
|---|---|
| `cdp.mjs` | The driver: launches Chrome headless, connects, and exports `launch`, `sleep`, `saveFrame` and an animation recorder. Set `CHROME` if Chrome isn't in its usual place, and `PURL` to point at another page. |
| `jumps.mjs` | Clicks every `data-jump` state of a prototype in light and dark. Reports script and console errors, and any animation of a property other than transform or opacity (the motion rule). Run it after any prototype change: `node tools/design-qa/jumps.mjs`, or with `PURL` set to `extension.html`'s file URL for the extension prototype. |
| `shots.mjs` | Screenshots named states: `node tools/design-qa/shots.mjs saves reader:dark play`. For the extension prototype, set `SEL=#win` and `PURL` to `extension.html`'s file URL. |
| `sheet.mjs` | Lays screenshots from `out/<OUTD>` out as one contact sheet: `OUTD=shots node tools/design-qa/sheet.mjs 0 12`. |

On the phone prototype `jumps.mjs` also checks that every jump leaves a screen in `#vp`; a prototype without `#phone`, such as the extension's, skips that check.
