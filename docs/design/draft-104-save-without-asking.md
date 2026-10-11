# Draft: save without asking (flow decision 104, for sign-off)

Drafted on 11 October 2026 at Richard's request, after the first test of Kefli 0.0.2 on the Pixel. Nothing here is built. The prototype carries the screens as a draft (`docs/design/mockups/prototype.html`, the group "Saving without asking (draft, decision 104)"); the flow map and the decision log change only when this is signed off.

## What happened

A link shared to Kefli from another app saved at once, but its text was never backed up. The log shows why: Amber signed the save (kind 30078) and the encryption silently, and declined to sign the backup uploads (kind 24242) in the background. Kefli then tried Amber's own screen, which needs a Kefli window to open from, and the share window had already closed. The upload waits in the outbox and retries, and each retry needs Amber's screen: a confirmation per save, which is what Richard wants gone.

## Why Amber asked

Kefli asks Amber for every permission it uses when it signs in (`nip55Permissions()` in `packages/protocol/src/remoteSigners.ts`, since the sign-in route was built). When Amber connects an app, it offers three policies:

| Amber's choice | What it grants |
|---|---|
| Approve basic actions | Amber's own fixed list, whatever the app asked for |
| Manually approve each permission | the permissions the app asked for, as ticked |
| I fully trust this application | everything |

Amber's basic list (`BasicPermissions.kt`) includes saves (30078), deletions (5), the relay list (10002), relay sign-in (22242) and Kefli's API sign-in (27235). It leaves out three kinds Kefli signs without the person in front of it:

- 24242, the authorisation for each upload of a save's encrypted text, to Kefli's server and to the backup mirror;
- 10063, the list of servers that hold that text;
- 13, the seal around the message that connects a browser.

So on "Approve basic actions", every one of those asks. Any NIP-55 signer can behave the same way, so the fix doesn't depend on Amber.

## The change

Kefli checks, right after sign-in, that the nostr app will sign everything saving needs without asking. If it won't, one screen says so and asks for approval once. The person can decline; saving still works, and backups wait for approval as they do today.

### Where it goes on the flow

**Journey C (sign in with your nostr app).** After the app approves the sign-in and passes the privacy check, and before "Bring in your bookmarks?" and the restore. The check runs during the existing "Waiting for your nostr app" step, so when the app allows everything there is no new screen at all.

**You, for a nostr sign-in.** The row "Your nostr app · Signed in" becomes "Your nostr app" with the stamp "Asks before each save" while the check fails, and opens the same screen; it returns to You.

**Sign-ins made before this change** (Richard's phone). The check runs in the background when Kefli comes to the front, at most once a day, and only ever sets the You row. It never interrupts. Advanced's count of saves not backed up already shows the effect.

### States

| State | What shows |
|---|---|
| Checking | Nothing new: it runs inside "Waiting for your nostr app" (sign-in) or out of sight (You) |
| Everything allowed | No screen; sign-in goes on to the bookmarks question; the You row reads "Signed in" |
| Asks before some saves | **Save without asking**, with Open my nostr app and Ask me each time |
| Approving | "Waiting for your nostr app", with "Request 1 of 3" counting the kinds still missing; Cancel returns to the screen |
| Still asks after approving | The screen again, with the notice line and Try again |
| Declined in the app | The screen again, with the notice line; Ask me each time goes on |
| Ask me each time, or Back | Sign-in goes on; the You row keeps its stamp |
| No signer app, or it doesn't answer | Not reachable: the sign-in has just used the app |
| Offline | Unaffected: the check is between Kefli and the app on the phone |
| A remote signer (sign-in link) | Not checked: its requests would prompt on another device |

### Copy

All on the sign-in route and You for nostr users, where "nostr" may appear (decision 86).

- Title: **Save without asking**
- Lead: Your nostr app asks you to approve each save before Kefli can back it up. Approve once now and choose to remember it, and saving from any app needs nothing more from you.
- Buttons: **Open my nostr app** (Try again after a failed attempt), **Ask me each time**
- Waiting: **Waiting for your nostr app** · Approve the request there and choose to remember it, then come back to Kefli. Request 1 of 3.
- Still asks: Your nostr app still asks before some saves. In your nostr app, let Kefli sign without asking, then try again.
- Declined: The request was declined in your nostr app. Kefli will ask each time you save.
- You row stamp: **Asks before each save**
- Toast, approved from You: Saving no longer asks your nostr app

### How the check works

Amber has no way to ask what an app is allowed to do, so Kefli asks it to sign, through its background service only, one throwaway event of each kind that saving signs out of sight: 30078, 5, 13, 10002, 10063, 22242, 27235 and 24242, plus a NIP-44 encryption (what `canActInBackground` already does). A kind it signs is allowed; a kind it won't answer is missing. The throwaway events are never sent anywhere. Each has `created_at` 1 and empty content, so even if one leaked, a replaceable list signed that way could never replace a real one. Amber records them in its activity log, which is the one visible trace.

Open my nostr app then sends one request per missing kind through Amber's screen, in turn, each a throwaway event of that kind; approving with "remember my choice" grants it for good. Kefli checks again afterwards, and goes on only on its result.

In code: a `canSign(pkg, kinds, hex)` on the kefli-nip55 module, resolver only; `BACKGROUND_KINDS` and the probe template in `packages/protocol`; a check after sign-in in `services/nostrAsk.ts`; the state on the nostr screen and the You row. No change to the contract or the protocol, only to the mobile spec's sections 3.4 and 8.4.

## Questions for Richard

1. **The copy above**, and whether "Save without asking" is the right title.
2. **Amber's shortcut.** "I fully trust this application" fixes it in one tap, but naming one app's setting breaks the rule that the copy works for any nostr app. I'd leave it out of the screens and put it in the help.
3. **Sign-ins made before this change.** The draft only marks the You row. A one-off notice on Saves would reach Richard sooner, at the cost of the only interruption in the app.
4. **The probe's trace in Amber's log** (eight throwaway signatures per check). Acceptable, or should the check run only at sign-in and when the You row is opened?

## Decision text, ready for the log

104. **Kefli checks that saving won't ask** (Richard, date of sign-off; follows 91 (d)). After a sign-in with a nostr app on the phone, Kefli checks in the background that the app will sign, without asking, everything saving does out of sight: the save, deletions, the relay and server lists, relay and API sign-in, the backup uploads and a browser's seal. Some signers grant less than Kefli asks for (Amber's "Approve basic actions" leaves out the backup uploads, the server list and the seal). If anything is missing, **Save without asking** asks the person to approve it once in their nostr app and remember it; Ask me each time goes on, and saving still works, with backups waiting for approval. You marks a sign-in that still asks ("Asks before each save"). Sign-ins made earlier are checked in the background at most once a day and never interrupted. Remote signers aren't checked.
