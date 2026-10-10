// What Undo can promise (contract 4.4, decision 101). The extension can retract its wrap, but once the phone has collected
// the save it is an item in the library, which only the phone's key can remove. The phone publishes a kind 5 for the wrap
// when it collects one, so after retracting, Undo looks for that deletion, and once more a moment later in case the phone
// was collecting it as Undo was pressed. Retracting first means a phone that collects in between is still caught.

export const SECOND_LOOK_MS = 1500;

export type UndoOutcome = 'undone' | 'onphone';

export async function settleUndo(retract: () => Promise<void>, collected: () => Promise<boolean>, wait: (ms: number) => Promise<void>): Promise<UndoOutcome> {
  await retract();
  if (await collected()) return 'onphone';
  await wait(SECOND_LOOK_MS);
  return (await collected()) ? 'onphone' : 'undone';
}
