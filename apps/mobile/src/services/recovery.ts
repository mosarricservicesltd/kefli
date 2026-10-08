// The recovery code's first pass (mobile spec 5.3, contract 2 and 8): before a key typed in is stored, ask whether
// anything was ever saved with it. The relays asked are the baked-in defaults (the operator relay, the default
// relays and the indexer), then any read relay the key's own 10002 names, so a shelf that moved its relays is
// found too. found: a Shelf save on any of them; none: every relay answered and none holds one; offline: none
// could be reached, so the value is kept and the notice shows (G6).
import { KIND, T_TAG, readRelayList, type NostrEvent } from '@shelf/protocol';
import type { Filter } from './sync';

export type FindPorts = {
  query: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
  defaults: { operator: { relay: string }; relays: string[]; indexer: string[] };
};

export type Found = 'found' | 'none' | 'offline';

async function ask(p: FindPorts, relays: string[], filter: Filter): Promise<{ events: NostrEvent[]; answered: number }> {
  const got = await Promise.all(relays.map((r) => p.query(r, [filter]).then((e) => e, () => null)));
  return { events: got.flatMap((e) => e ?? []), answered: got.filter((e) => e !== null).length };
}

export async function findShelf(p: FindPorts, pubkey: string): Promise<Found> {
  const base = [...new Set([p.defaults.operator.relay, ...p.defaults.relays, ...p.defaults.indexer])];
  const lists = await ask(p, base, { kinds: [KIND.relayList], authors: [pubkey] });
  const theirs = lists.events.filter((e) => e.pubkey === pubkey).flatMap((e) => readRelayList(e).filter((r) => r.read).map((r) => r.url));
  const relays = [...new Set([...base, ...theirs])];
  const saves = await ask(p, relays, { kinds: [KIND.appData], authors: [pubkey], '#t': [T_TAG], limit: 1 });
  if (saves.events.some((e) => e.pubkey === pubkey && e.tags.some((t) => t[0] === 'd' && t[1]?.startsWith('shelf/item/')))) return 'found';
  return saves.answered === 0 ? 'offline' : 'none';
}
