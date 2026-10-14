// Add a relay (FD 113, C§3.1): before a typed relay joins the 10002, Kefli checks that it answers and that it takes
// an event from this person. The event is the newest relay list the phone holds, already signed, so the check asks
// nothing of a nostr app, unless the relay asks for AUTH before it takes the list (the pool signs AUTH only when a relay
// refuses with auth-required, F13); an identity with no list yet is checked for an answer only. A relay that answers OK false
// (an account, a payment or proof of work needed, or a refusal) won't take saves either.
import type { NostrEvent } from '@kefli/protocol';
import { KIND } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { addRelay, relayAddress, writeRelays, type DefaultsLike } from '../data/lists';
import type { RelayAnswer } from '../net/pool';

export type Check = 'ok' | 'bad' | 'listed' | 'unreachable' | 'refused';

export type AddRelayPorts = {
  db: SqlDb;
  now: () => number;
  defaults: () => Promise<DefaultsLike>;
  connect: (url: string) => Promise<unknown>;
  publish: (url: string, event: NostrEvent) => Promise<RelayAnswer>;
};

/** Checks the typed address and, when the relay answers and takes the list, adds it. Returns the outcome and the address. */
export async function addTypedRelay(p: AddRelayPorts, owner: string, typed: string): Promise<{ check: Check; url: string | null }> {
  const url = relayAddress(typed);
  if (!url) return { check: 'bad', url };
  if (writeRelays(p.db, owner).includes(url)) return { check: 'listed', url };
  try {
    await p.connect(url);
  } catch {
    return { check: 'unreachable', url };
  }
  const raw = p.db.get<{ raw: string }>("SELECT raw FROM lists WHERE owner = ? AND kind = ? AND d = ''", owner, KIND.relayList)?.raw;
  if (raw) {
    let answer: RelayAnswer;
    try {
      answer = await p.publish(url, JSON.parse(raw) as NostrEvent);
    } catch {
      return { check: 'unreachable', url };
    }
    if (!answer.ok) return { check: 'refused', url };
  }
  return { check: addRelay(p.db, p.now(), owner, url, await p.defaults()) ? 'ok' : 'listed', url };
}
