// Add a relay (FD 113, C§3.1): before a typed relay joins the 10002, Kefli checks that it answers and that it takes
// an event from this person. The event is the newest relay list the phone holds, already signed, so the check asks
// nothing of a nostr app, unless the relay asks for AUTH before it takes the list (the pool signs AUTH only when a relay
// refuses with auth-required, F13); an identity with no list yet is checked for an answer only. A relay that answers OK false
// (an account, a payment or proof of work needed, or a refusal) won't take saves either. One that holds the list, or a
// newer one of theirs, already took this person's events, and one that turns it away only for its date, dated past the
// relay's clock or older than the relay keeps, answered, which says nothing of whether it takes them.
import type { NostrEvent } from '@kefli/protocol';
import { KIND } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { addRelay, relayAddress, writeRelays, type DefaultsLike } from '../data/lists';
import type { RelayAnswer } from '../net/pool';
import { holdsAlready, pastItsClock } from './send';

export type Check = 'ok' | 'bad' | 'listed' | 'unreachable' | 'refused';

export type AddRelayPorts = {
  db: SqlDb;
  now: () => number;
  defaults: () => Promise<DefaultsLike>;
  connect: (url: string) => Promise<unknown>;
  publish: (url: string, event: NostrEvent) => Promise<RelayAnswer>;
};

/**
 * A relay's refusal of an event older than it keeps: strfry's "created_at too early" (by default anything over three
 * years old) and khatru's "event too old". The list held is a nostr user's own as their other apps last wrote it,
 * which Kefli never republishes with Keep backup copies off, and every strfry relay refuses one over three years old
 * that way, so such a person could add none. The refusal is of that list's date: the lists and saves sent to the relay
 * from here are dated now. The outbox still reads it as final for the list itself (send.ts relayResult).
 */
const TOO_OLD = new RegExp('created_at too early|event too old', 'i');

/**
 * Whether the relay's answer to the list leaves it one that takes this person's events: it took the list, or holds it,
 * a newer one or their deletion of it already, as strfry says with "replaced: have newer event" when another app sent
 * it a list since this phone last read theirs (send.ts holdsAlready), or turned it away only for its date, an answer
 * that says nothing of the person, as for an identity with no list yet: ahead of the relay's clock (send.ts
 * pastItsClock: the list held is dated by this phone's clock, or after one another device dated so, nextListTime, and
 * a phone running fast found every strfry relay refusing, Kefli's own among them), or older than it keeps (TOO_OLD).
 * The words are read by the outbox's own tests, so the check and the sends to the relay read them alike. The lists
 * then go to it as for any relay added, dated now, with the outbox's backoff.
 */
function takes(answer: RelayAnswer): boolean {
  return answer.ok || holdsAlready(answer.reason) || pastItsClock(answer.reason) || TOO_OLD.test(answer.reason);
}

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
    if (!takes(answer)) return { check: 'refused', url };
  }
  return { check: addRelay(p.db, p.now(), owner, url, await p.defaults()) ? 'ok' : 'listed', url };
}
