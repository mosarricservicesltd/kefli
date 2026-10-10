// Relay connections held between saves (extension spec 4 and 6): a connection stays open for 60 seconds after its last
// use, so consecutive saves reuse it, and while it is held a no-op request every 20 seconds is traffic on the socket,
// which since Chrome 116 keeps the service worker alive. A worker that is stopped anyway takes the pool with it; the next
// save simply connects again.

/** What the pool needs of a relay connection: nostr-tools' Relay has all of it. */
export interface PooledRelay {
  readonly connected: boolean;
  onclose: (() => void) | null;
  close(): void;
  subscribe(filters: object[], params: { oneose?: () => void }): { close(): void };
}

export const HOLD_MS = 60_000;
export const PING_MS = 20_000;
/** A filter no event matches: the relay answers it at once with EOSE. */
const NOTHING = [{ ids: ['0'.repeat(64)], limit: 0 }];

interface Held<R> {
  relay: Promise<R>;
  hold?: ReturnType<typeof setTimeout>;
  ping?: ReturnType<typeof setInterval>;
}

export class RelayPool<R extends PooledRelay> {
  readonly #held = new Map<string, Held<R>>();

  constructor(private readonly connect: (url: string) => Promise<R>, private readonly holdMs = HOLD_MS, private readonly pingMs = PING_MS) {}

  /** The open connection to url, or a new one; a failed connect isn't kept. */
  async get(url: string): Promise<R> {
    const h = this.#held.get(url);
    if (h) {
      const r = await h.relay.catch(() => null);
      if (r?.connected) return this.#keep(url, h, r);
      this.#drop(url);
    }
    const fresh: Held<R> = { relay: this.connect(url) };
    this.#held.set(url, fresh);
    try {
      const r = await fresh.relay;
      r.onclose = () => this.#drop(url);
      return this.#keep(url, fresh, r);
    } catch (e) {
      this.#drop(url);
      throw e;
    }
  }

  #keep(url: string, h: Held<R>, r: R): R {
    clearTimeout(h.hold);
    h.hold = setTimeout(() => this.close(url), this.holdMs);
    h.ping ??= setInterval(() => {
      const sub = r.subscribe(NOTHING, { oneose: () => sub.close() });
    }, this.pingMs);
    return r;
  }

  #drop(url: string): void {
    const h = this.#held.get(url);
    if (!h) return;
    clearTimeout(h.hold);
    clearInterval(h.ping);
    this.#held.delete(url);
  }

  /** Closes the connection to url now, and forgets it. */
  close(url: string): void {
    const h = this.#held.get(url);
    this.#drop(url);
    void h?.relay.then((r) => {
      r.onclose = null;
      r.close();
    }, () => undefined);
  }

  size(): number {
    return this.#held.size;
  }
}
