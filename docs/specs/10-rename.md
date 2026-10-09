# The rename: Shelf to Kefli

Approved by Richard on 9 October 2026, with every recommendation in section 1 as written, and recorded as flow decision 96. Flow decision 95 named the product Kefli and left the rename as its own piece of work; this plans it.

The rename has to land **before the first Play upload**, because the app ID is permanent from then and owns the Block Store data. Before launch, every other identifier can also change at no cost to anyone but the test libraries; after launch, the protocol's namespace and the app ID can't change at all. So the plan is one clean sweep, done once, in five phases.

## 1. Decisions first

| | Question | Recommendation |
|---|---|---|
| **R1** | The Play app ID | **`app.kefli`**. It is free on Play (`docs/research/naming.md`) and reads as kefli.app reversed, so register kefli.app first. It replaces `space.shelf.app`. |
| **R2** | The protocol's namespace: `d` = `shelf/item/<hash>` and `shelf/devices`, `t` = `shelf` (contract 4.1, 4.3 and 4.9) | **Change to `kefli/item/`, `kefli/devices` and `kefli`** in contract v1.5. Free now; after launch it would mean reading two namespaces forever. No dual reading: the test libraries saved under `shelf/` stay on the relays and the renamed app doesn't see them (see section 5). |
| **R3** | The deep-link scheme `shelf://` | **`kefli://`**, with the reader links (`shelf://reader`) following. |
| **R4** | "Shelf" as a noun in copy: "Already on your shelf", "Start a new shelf", "Back up your shelf", "Bring back your shelf" and about ten more | **"library"**: "Already in your library", "Start a new library", "Back up your library". The delete flow and the pitch already say library, and keeping "shelf" as the noun would leave the old name in every sentence. The prototypes change first, as the signed-off reference. |
| **R5** | Internal names: the npm scope `@shelf/*`, the seven native modules `shelf-*` and their Kotlin packages `space.shelf.*`, the `SHELF_*` environment variables, and the stored identifiers (`shelf.db`, the keystore alias `shelf.identity.v1`, the Block Store key `shelf.mnemonic.v1`, `shelf.spoolId`, the `shelf` documents folder) | **Rename them all** to `kefli`. A new app ID makes Kefli a new app on the phone with empty storage, so nothing needs migrating, and one sweep means no code keeps two names. |
| **R6** | What keeps the old name on purpose | **Cover v1** (`shared/cover/cover-v1.js`, its `ShelfCover` API and its golden fixtures, including the `https://shelf.app/` sample and the `shelf/icon/` seeds): frozen, never edited once shipped, and the API name is never seen by users. **History**: the flow decision log's past entries, the archived specs and the design studies in `docs/design/icons/` and `docs/design/study/`. **The brand's frozen artwork** (`shared/brand/src`), as written, its one comment naming Shelf included. |
| **R7** | The GitHub repository and the local folder | Rename both to Kefli **last**, after phase 5; GitHub redirects the old URL. Optional. |

The domains, handles and the UK trade mark filing are the naming doc's follow-ups and run alongside; only kefli.app blocks the work (R1).

## 2. What changes, by area

Counts are tracked files, from `git grep -il shelf` on 9 October 2026: 388 files in all.

| Area | What changes | Size |
|---|---|---|
| **Contract and protocol** | `shared/contract/contract.md` to v1.5 with a changelog entry (R2); `packages/protocol` (event builders, filters, types); the shared fixtures in `shared/fixtures`, regenerated; the mobile gates that sign `shelf/item/` events | contract 1 file, protocol 27, fixtures 10 |
| **Mobile identity** | `app.json`: the name ("Shelf test" becomes Kefli), slug, scheme (R3), package (R1) and the camera permission's copy; `SwitchNostr.tsx`'s Play link; `nav/links.ts`'s scheme; the plugins' resource names (`shelf_notification`, `shelf_network_security`, `shelf_data_extraction`, `shelf_backup`) | about 10 files |
| **Native modules** | `shelf-keystore`, `shelf-nip55`, `shelf-parser`, `shelf-secp`, `shelf-share`, `shelf-system`, `shelf-voice`: folders, package names, Kotlin packages `space.shelf.*` and the stored identifiers (R5) | 7 modules, 39 files with `space.shelf` |
| **Mobile copy** | About 40 strings naming the product ("Saved to Shelf", "Removed from Shelf", "Update Shelf", "Shelf's server", "Keep Shelf open…") and about 13 using the noun (R4); Export my saves' file, `shelf-export.html` in Downloads, and its title | `apps/mobile/src` |
| **Packages and tooling** | The root package `shelf` and the scopes `@shelf/mobile`, `@shelf/protocol` and `@shelf/tokens`, with every import; the `SHELF_VARIANT` and `SHELF_DEFAULTS_URL` variables in `app.config.js` and its docs; the local stack in `server/dev` (comments, `shelf.ts`, the parser bundle's `shelfParse` names) | 68 `SHELF_` uses in 21 files; `server/dev` 12 files |
| **Brand and stores** | `build-icons.cjs` sets "Shelf" on the Play feature graphic, the social card and `site.webmanifest`: Kefli, then rebuild; the Play listing ("Kefli: read it later" where search needs it, FD 95). The icon itself doesn't change | 1 script, its outputs |
| **Extension and website** | Not built yet: the extension spec (`docs/specs/05-extension.md`) and its prototype change, so both are built with the new name from the start | 2 files |
| **Living docs** | `CLAUDE.md`, `README.md`, `docs/HANDOVER.md`, the specs that describe the build (00 to 09), the flow map, the phone and extension prototypes, the tour, the consistency spec, the UI brief, the motion spec | about 30 files |

## 3. Order of work

Each phase ends with the tests, the shared fixtures, `npm run tokens:check`, the typecheck and the code gate passing, and is one commit or a few.

1. **Phase 0: decisions and the domain.** Richard settles R1 to R7; kefli.app is registered.
2. **Phase 1: contract v1.5 and the protocol.** The namespace changes in the contract, `packages/protocol`, the fixtures (regenerated and checked under Node and in the device harness, as every fixture change is), the local stack and the gates.
3. **Phase 2: the app's identity and internals.** App ID, scheme, the seven modules, the plugins' resources, the stored identifiers, the npm scopes and the environment variables. A clean prebuild and a new development build, then on the Pixel: a fresh install, New here, a save shared from X, listening with the screen locked, the lock-screen card, Block Store backup and a restore from the recovery code.
4. **Phase 3: the copy.** The prototypes first (the reference the build is checked against), with `tools/design-qa/jumps.mjs` clean; then the app's strings, the export file, the permission text, and the tour.
5. **Phase 4: brand, stores and the unbuilt clients.** Rebuild the cards and the web manifest with Kefli; the Play listing text; the extension spec and prototype.
6. **Phase 5: the docs.** The living docs in the table above, with history left as it was. Then, optionally, the repository and folder names (R7).

## 4. How we know it's done

- Every line `git grep -n -i shelf` finds is a deliberate keep of R6. The keeps are patterns in `docs/specs/rename-keeps.txt`, each with its reason, so the check is repeatable: `git grep -n -i shelf | grep -v -E -f <(grep -v -E '^(#|$)' docs/specs/rename-keeps.txt)` prints any miss, and nothing once the rename is whole.
- Every test, fixture and gate passes, and `jumps.mjs` runs clean on the phone prototype.
- On the Pixel, the renamed build passes the phase 2 checks, and the app, the launcher, the share sheet, the lock screen, the notification and the Downloads export all say Kefli.

## 5. Risks

- **Test libraries.** Saves made under `shelf/` stay on the relays but the renamed app won't list them. Anything worth keeping should be exported with Export my saves before phase 1, and saved again afterwards.
- **The old app on test phones.** `space.shelf.app` and `app.kefli` are different apps, so the old one stays installed until removed, and its Block Store backup and keys stay with it.
- **Signers.** Amber and other NIP-55 signers remember permissions by package name, so they ask again once after the rename.
- **Module renames.** Expo autolinking and Gradle cache module names and namespaces: rename folders, package names and Kotlin packages together, then prebuild clean and clear the Gradle caches.
- **Two names for a while.** Until phase 3 lands, the app still says Shelf (FD 95); the phases should run back to back.
- **The name's baggage** (`docs/research/naming.md`): never link or print kefli.net, and check every printed spelling of Kefli.

## 6. Effort

Roughly three days of work: phase 1 half a day, phase 2 a day including the device checks, phase 3 half a day, phases 4 and 5 half a day together, plus slack for the native module renames.

## 7. Status

Phases 1 to 5 were done on 9 October 2026, the day the plan was approved: contract v1.5 and the namespace (bc320a2), the app's identity and internals (074e688), the prototypes and the tour (cf9dbc3), the app's copy (2b7b39e), the brand cards and the extension spec (0a03c22), the cut fonts' unique ID, and the living docs. The check in section 4 prints nothing. Still to do:

- **Phase 0:** register kefli.app before the first Play upload.
- **The device checks** of phase 2 and section 4, on a new development build: a fresh install, New here, a save shared from X, listening with the screen locked, the lock-screen card, Block Store backup and a restore from the recovery code, with Kefli on the launcher, the share sheet, the lock screen, the notification and the Downloads export.

R7 was done on 9 October 2026: the GitHub repository is `richardminton-glitch/Kefli` (GitHub redirects the old address), the local folder is `Kefli`, and their two patterns are gone from `rename-keeps.txt`.
