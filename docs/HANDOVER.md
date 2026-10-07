# Handover: picking Shelf up on another computer

Written on 6 October 2026, when the work moved off the laptop it started on. Everything needed is in this repository; this page says where things are, what is in flight, and how to set a new machine up. `CLAUDE.md` stays the project's standing brief and Claude Code reads it automatically; this page adds the state of play.

## Where things stand

- **Stage 0 design is signed off** (flow decision 75): the phone prototype `docs/design/mockups/prototype.html` (125 states), the extension prototype `extension.html`, the flow map `docs/design/flow-map-rev3.html` and the decision log `docs/design/flow-decisions.md` (decisions 1 to 93, later ones win).
- **Contract v1.4** (`shared/contract/contract.md`) is the source of truth for the protocol. v1.4 (6 October 2026) only settles what normalisation, the spoken projection and the typed-code offer left open (its section 11.1); Richard left those choices to Claude's judgement.
- **The mobile spec is written:** `docs/specs/03-mobile.md`, version 2.1, Expo with Android first. Its section 12 is the build timeline. Of week 0's code, the token generator (`shared/tokens/build-ts.mjs`, emitting `packages/tokens`), the npm workspaces, the protocol skeleton (`packages/protocol`), the normalise draft (`shared/normalise.ts` with `shared/normalise.fixtures.json`, its open choices listed in the fixtures' `draft` notes) and `shared/turndown-rules.json` were done on 6 October 2026. The library gates listed there need the phone build and are still to do.
- **The Android test build passed** on a Pixel 10a (`docs/specs/07-android-test-build.md`). `apps/mobile` holds that test screen only; the app proper starts from the spec.
- **Tokens** are 1.0.1 (`shared/tokens/tokens.json`).

## Open with Richard

1. **The app icon is being revisited.** Today's icon is cover C·L·063 on pattern P012 (decision 70). Richard was unsure about its colours, so a pattern-and-colour study was built: `docs/design/icons/pattern-colour-study/` (its README explains how it was made), published privately at https://claude.ai/artifact/8abd8kauAgihkxQdCopU5E. When he picks a pattern and colour, record a decision amending 70, freeze the new artwork in `shared/brand/src`, rebuild the brand files and hand-tune the small cuts.
2. **New copy in the prototype's newest states** (decisions 89 and 91: the re-share sheet, X post failures, sign-in timeouts, switching without a nostr app, the original page's loading and failure, Advanced's not-backed-up count and export failure) was drafted, not yet read by Richard. `docs/design/tour.html` can take them as a chapter.
3. **The licence text:** decided as AGPL-3.0-or-later with a permission for Google Play services and other proprietary system libraries (mobile spec O-10); the LICENSE file is added once Richard confirms the exact text. `apps/mobile/LICENSE` is Expo's template and is deliberately not committed.
4. **The name** (mobile spec O-9): needed, or at least its domain, by the end of build week 3, because the Play app ID is permanent from the first upload.

## Setting up a new machine

Install Git, Node 24, Google Chrome, and for the phone build JDK 17 and the Android SDK (Android Studio installs it; set `ANDROID_HOME`). Then:

```bash
git clone git@github.com:richardminton-glitch/Shelf.git
```

On this laptop the remote is the SSH alias `github-shelf`; on a new machine clone with your own GitHub SSH key as above, or over HTTPS (`https://github.com/richardminton-glitch/Shelf.git`). Some networks block SSH's port 22: if `git push` times out, add this to `~/.ssh/config` and clone from `git@github.com:` as usual.

```
Host github.com
  HostName ssh.github.com
  Port 443
```

| Task | How |
|---|---|
| Look at the prototypes | `npx serve docs/design -l 4321`, then open `http://localhost:4321/mockups/prototype.html` (or open the files directly). `.claude/launch.json` has this as "mockups", plus "tour" (the repo root on 4322, for `docs/design/tour.html`). |
| Check the prototype after a change | `node tools/design-qa/jumps.mjs` (every state, both themes, no script errors, motion rule). See `tools/design-qa/README.md`. |
| Run the local stack (week 1, before the VPS) | `docker compose -f server/dev/compose.yml up -d` (three strfry relays, the operator Blossom server and a mirror), `node server/dev/api.mjs` (the API stand-in: `/defaults.json`, `/register`), `server/dev/phone.sh` (adb reverse, so the phone reaches them on its own localhost), and `npx tsx server/dev/smoke.ts` for a full save from the desktop. The app's cleartext HTTP is for this stack only and must be limited to development builds before release |
| Install and test the shared code | `npm install` at the root, then `npm test` (tokens staleness check and the `packages/protocol` suite) and `npm run typecheck` |
| Rebuild the tokens | `npm run tokens` (the CSS for the prototypes and `packages/tokens` for the app) |
| Test the cover generator | `node shared/cover/test.cjs`, and `node shared/cover/build.mjs` to copy it into the mockups |
| Rebuild the brand files | install `@resvg/resvg-js@2` somewhere outside the repo, then `NODE_PATH=<that folder>/node_modules node shared/brand/build-icons.cjs` |
| Rebuild the parser bundle | `node shared/vendor/build-parser-bundle.mjs` (writes the APK asset and its sha256 into `apps/mobile/modules/shelf-parser`; `--check` for CI). After a runner change, `node apps/mobile/scripts/parser-expectations.mjs` remakes the phone gate's expected parses in desktop Chrome |
| The Android test build | `cd apps/mobile`, `npm install`, `npm run make-ticks` (the six-minute test track, kept out of git), `npx expo prebuild --platform android`, then `cd android` and `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`; install with `adb install -r app/build/outputs/apk/release/app-release.apk`. The first build takes about 20 minutes. |

Commits to `main` go through the code-gate CRAP check (CLAUDE.md, Rules). On this laptop it ran as a git pre-commit hook from Claude's code-gate skill; a new machine needs the hook installed again before the first commit.

## Working with Claude on the new machine

Claude Code loads `CLAUDE.md` by itself. What it learned on the laptop outside the repo, its own memory, doesn't travel, so this page carries it. Ways of working Richard has asked for:

- Commit and push only when Richard asks.
- Write everything in British English, with no inverted-emphasis constructions; plain words over jargon.
- Flow before screens and tokens before components: anything new goes on the flow map (and into a decision) before it is built.
- Say "the Android test build", not "spike".
- Big pieces of work have been run as multi-agent workflows with independent adversarial review before anything is published or committed; the reviews caught real faults each time.
