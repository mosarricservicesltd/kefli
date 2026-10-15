// What Undo can promise (contract 4.4, decision 101). The extension can retract its wrap, but once the phone has collected
// the save it is an item in the library, which only the phone's key can remove. The phone publishes a kind 5 for the wrap
// when it collects one, so after retracting, Undo looks for that deletion, and once more a moment later in case the phone
// was collecting it as Undo was pressed. Retracting first means a phone that collects in between is still caught.
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Store } from './store';

/**
 * A wrap a save went by before a move put it under another (contract 4.8), which may be on the relay: one tried before,
 * whose answer may have timed out though the relay took it, or one whose send was under way as the move was taken. Undo
 * retracts it with its own key, and looks for the phone's deletion of it under the library it went to, since the phone's
 * last look at that library's inbox may have taken it.
 */
export interface Earlier {
  id: string;
  key: string;
  user: string;
}

/** What Undo keeps of a save for the session: the wrap's own key, which alone can retract it. */
export interface UndoKey {
  key: string;
  sha256: string | null;
  hash: string;
  /** The save's wraps from before a move that may be on the relay, which Undo retracts too. */
  earlier?: Earlier[];
}

/**
 * What Undo keeps in a wrap's place once the save goes by another: its HTML refused (v1.12), its wrap made again, or its
 * library moved to another key (contract 4.8). A toast still naming the old wrap, such as the offline one, then undoes the
 * save under the wrap it has now (F40).
 */
export interface Renamed {
  to: string;
}

/**
 * Undo's key moved to a save's new wrap: the key that alone retracts it, and the inbox blob it deletes, if the operator
 * holds one. The old wrap's id points to the new one, for an Undo pressed on a toast that still names it. A save the
 * session holds no key for, such as one queued in an earlier browser session, is left as it is. With `wentTo`, the
 * library a move took the save from, the old wrap may be on the relay, so it is kept with its key for Undo to retract
 * too (Earlier); those kept before go with the save to each wrap after.
 */
export async function moveUndoKey(session: Store, was: string, to: string, wrapKey: Uint8Array, sha256: string | null, wentTo: string | null = null): Promise<void> {
  const kept = await session.get<UndoKey>(`undo:${was}`);
  if (!kept) return;
  const earlier = [...(kept.earlier ?? []), ...(wentTo ? [{ id: was, key: kept.key, user: wentTo }] : [])];
  await session.set(`undo:${to}`, { key: bytesToHex(wrapKey), sha256, hash: kept.hash, ...(earlier.length ? { earlier } : {}) } satisfies UndoKey);
  await session.set(`undo:${was}`, { to } satisfies Renamed);
}

export const SECOND_LOOK_MS = 1500;

export type UndoOutcome = 'undone' | 'onphone';

/**
 * The relay refuses the retraction once the phone has collected the save and deleted its wrap (contract 3.2: a kind 5
 * from an unregistered key may name only a wrap the relay holds), so a refusal still goes on to look; it is reported only
 * when the save isn't on the phone either.
 */
export async function settleUndo(retract: () => Promise<void>, collected: () => Promise<boolean>, wait: (ms: number) => Promise<void>): Promise<UndoOutcome> {
  let refused: unknown = null;
  await retract().catch((e: unknown) => void (refused = e));
  if (await collected()) return 'onphone';
  await wait(SECOND_LOOK_MS);
  if (await collected()) return 'onphone';
  if (refused) throw refused;
  return 'undone';
}
