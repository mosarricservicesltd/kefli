// A relay behind a socket the test drives, for the pool's own AbstractRelay (net/pool), so a query meets the answers
// relays really send. Each REQ is answered from the events the relay holds as strfry answers one: those matching the
// filter, newest first (ties to the lower id, NIP-01), at most the limit or the relay's own cap, then EOSE. A test's
// plan for a REQ answers it otherwise, as a busy, failing or hostile relay does: a pause part way, nothing more after
// some events, a CLOSED, or the connection dropped. Every message goes out on a timer, so fake time can drive it.
import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { NostrEvent } from '@kefli/protocol';

/**
 * One step of an answer: a pause in ms; the next events of the answer, all that are left when send is left out;
 * EOSE; a CLOSED with its reason; or the connection dropped.
 */
export type Step = { wait: number } | { send?: number } | 'eose' | { closed: string } | 'drop';

/** Every event, then EOSE. */
export const WHOLE: Step[] = [{}, 'eose'];

export type RelayOptions = {
  /** The events a relay holds, by its address (without the trailing slash nostr-tools adds). */
  holds: (url: string) => NostrEvent[];
  /** How a REQ is answered, from the relay, the filter and how many REQs that socket had before it; WHOLE by default. */
  plan?: (url: string, filter: Filter, before: number) => Step[];
  /** The most events an answer carries, whatever the limit asked (strfry's maxFilterLimit). */
  cap?: number;
  /** A challenge on connect, as Kefli's strfry sends, and an OK for any AUTH. */
  challenge?: boolean;
};

const newestFirst = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A WebSocket class for RelayPool's WebSocket option, and every socket it has opened, in order. */
export function relaySockets(o: RelayOptions) {
  const sockets: RelaySocket[] = [];

  class RelaySocket {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    onopen: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    readyState = 0;
    /** The REQs this socket has had, each as its filter. */
    readonly reqs: Filter[] = [];
    /** Subscriptions still being answered: a CLOSE from the phone ends one. */
    private answering = new Set<string>();

    constructor(readonly url: string) {
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
        if (o.challenge) this.msg(['AUTH', 'challenge']);
      }, 0);
    }

    private msg(m: unknown[]): void {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(m) });
    }

    send(raw: string): void {
      const m = JSON.parse(raw);
      if (m[0] === 'AUTH') setTimeout(() => this.msg(['OK', m[1].id, true, '']), 0);
      if (m[0] === 'CLOSE') this.answering.delete(m[1]);
      if (m[0] === 'REQ') this.answer(m[1], m[2]);
    }

    private answer(sub: string, filter: Filter): void {
      const address = this.url.replace(/\/$/, '');
      const events = o.holds(address).filter((e) => matchFilter(filter, e)).sort(newestFirst).slice(0, Math.min(filter.limit ?? Infinity, o.cap ?? Infinity));
      const steps = o.plan?.(address, filter, this.reqs.length) ?? WHOLE;
      this.reqs.push(filter);
      this.answering.add(sub);
      let at = 0;
      let from = 0;
      for (const step of steps) {
        if (typeof step === 'object' && 'wait' in step) {
          at += step.wait;
          continue;
        }
        let batch: NostrEvent[] = [];
        if (typeof step === 'object' && !('closed' in step)) {
          const n = Math.min(step.send ?? events.length, events.length - from);
          batch = events.slice(from, from + n);
          from += n;
        }
        setTimeout(() => this.act(sub, step, batch), at);
      }
    }

    private act(sub: string, step: Step, batch: NostrEvent[]): void {
      if (!this.answering.has(sub)) return;
      if (step === 'drop') return this.drop();
      if (step === 'eose') return this.msg(['EOSE', sub]);
      if (typeof step === 'object' && 'closed' in step) {
        this.answering.delete(sub);
        return this.msg(['CLOSED', sub, step.closed]);
      }
      for (const e of batch) this.msg(['EVENT', sub, e]);
    }

    /** The relay's side going: the connection closes under the phone. */
    drop(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.answering.clear();
      this.onclose?.({ code: 1006 });
    }

    /** The phone closing it: nostr-tools has let go of its handlers by then. */
    close(): void {
      this.readyState = 3;
      this.answering.clear();
    }
  }

  return { Socket: RelaySocket as unknown as typeof WebSocket, sockets };
}
