// Add a relay (FD 113, C§3.1): before a typed relay joins the 10002, Kefli checks that it answers and that it takes
// an event from this person. The event is the newest relay list the phone holds, already signed, so the check asks
// nothing of a nostr app, unless the relay asks for AUTH before it takes the list (the pool signs AUTH only when a relay
// refuses with auth-required, F13); an identity with no list yet is checked for an answer only. A relay that answers OK false
// (an account, a payment or proof of work needed, or a refusal) won't take saves either. Its answer is read as the
// outbox reads a relay's (send.ts relayResult): one that holds the list already took it, and one that turns it away
// only as dated past its clock answered, which says nothing of whether it takes this person's events.
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

/**
 * A relay's refusal of an event dated past its clock by more than it allows, in the words send.ts relayResult reads as
 * the clock's (its CLOCK): strfry's "created_at too late", khatru's "event too much in the future" and nostr-rs-relay's
 * "created_at field is out of the acceptable range", which it sends only for a date ahead. The list held is dated by
 * this phone's clock, or after one another device dated so (nextListTime), and a phone running fast found every strfry
 * relay refusing, Kefli's own among them. A refusal of a date too early stays a refusal, as the outbox reads it.
 */
const CLOCK = new RegExp('created_at too late|too (?:much|far) in the future|created_at field is out of the acceptable range', 'i');
const DUPLICATE = new RegExp('^duplicate:');

/**
 * Whether the relay's answer to the list leaves it one that takes this person's events: it took the list, or holds it
 * already (a duplicate, as the outbox reads it), or turned it away only as dated ahead of its clock, an answer that
 * says nothing of the person, as for an identity with no list yet. The list then goes to it with the outbox's backoff.
 */
function takes(answer: RelayAnswer): boolean {
  return answer.ok || DUPLICATE.test(answer.reason) || CLOCK.test(answer.reason);
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
