# Shelf

A read-it-later app that outlives its service. Save anything from your phone or browser, read it clean and offline, listen to it anywhere. Your library is encrypted with a key on your phone and stored on open nostr relays, so it survives even if our servers don't.

Status: design signed off, protocol contract at v1.4, mobile spec written, and the Expo stack confirmed on a real Android phone. The build starts with the Android app and the Chrome and Firefox extension. To pick the work up on a new machine, start with `docs/HANDOVER.md`.

## What's here

- `CLAUDE.md`: decisions and rules, for Claude Code and for humans.
- `docs/HANDOVER.md`: where things stand, what's open, and how to set up a new machine.
- `shared/contract/contract.md`: the protocol contract (v1.4). Everything codes against it.
- `docs/specs/`: the project plan and the backend, extension and mobile specifications (`03-mobile.md` for the Expo app).
- `docs/design/`: the flow map, the decision log, and the signed-off HTML prototypes in `mockups/` (open them in a browser).
- `shared/`: the cover generator, design tokens, brand artwork and the vendored article parser.
- `apps/mobile/`: the Android test build's harness (Expo).
- `tools/design-qa/`: scripts that check the prototypes in headless Chrome.
- `docs/research/`: market research and the adversarial review of the plan.
