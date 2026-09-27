# Shelf

A read-it-later app that outlives its service. Save anything from your phone or browser, read it clean and offline, listen to it anywhere. Your library is encrypted with a key on your phone and stored on open nostr relays, so it survives even if our servers don't.

Status: planning complete, build starting. First targets are the Android app and the Chrome/Firefox extension.

## What's here

- `CLAUDE.md` — decisions, rules and first tasks, for Claude Code and for humans.
- `shared/contract/contract.md` — the protocol contract (v1.1). Everything codes against this.
- `docs/specs/` — master plan and per-component specifications.
- `docs/design/` — UX flow map, UI mockups, and the Style Lab (open the `.html` files in a browser).
- `docs/research/` — market research and the adversarial review of the plan.

## Getting started (Windows or Mac)

Install Node LTS, Git, and Android Studio (for the Android SDK, `adb` and an emulator). Create an Expo account for EAS builds. Enable USB debugging on your Android phone. Then open this folder in Claude Code and start with the Android spike described in `CLAUDE.md`.
