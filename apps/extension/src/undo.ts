// What Undo can promise (contract 4.4, decision 101). The extension can retract its wrap, but once the phone has collected
// the save it is an item in the library, which only the phone's key can remove. The phone publishes a kind 5 for the wrap
// when it collects one, so after retracting, Undo looks for that deletion, and once more a moment later in case the phone
// was collecting it as Undo was pressed. Retracting first means a phone that collects in between is still caught.

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
