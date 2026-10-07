// Shelf's relay pool (mobile spec 4.4): one connection per relay on nostr-tools' AbstractRelay, with the
// verifier injected and AUTH through Signer. Reconnects back off from 1 s to 60 s; only wss:// is accepted,
// unless allowInsecure (the local stack in server/dev). AUTH is per connection: a publish answered
// auth-required, or a query closed with it, authenticates and tries once more (contract 3.2).
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import type { Filter } from 'nostr-tools/filter';
import type { EventTemplate, NostrEvent, Signer } from '@shelf/protocol';

export type RelayAnswer = { ok: true } | { ok: false; reason: string };

export type PoolOptions = {
  verify: (event: NostrEvent) => boolean;
  /** The signer that answers AUTH for this pool's identity. */
  signer: () => Promise<Signer | null>;
  allowInsecure?: boolean;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  connectTimeoutMs?: number;
};

/** 1 s doubling to 60 s. */
export function reconnectDelay(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
}

export function acceptsUrl(url: string, allowInsecure = false): boolean {
  return /^wss:\/\//.test(url) || (allowInsecure && /^ws:\/\//.test(url));
}

const PREFIXED = /^[a-z-]+:/;
// strfry closes a REQ with "ERROR: auth-required: …", so the prefix is looked for anywhere in the reason.
const AUTH_REQUIRED = /(^|\s)auth-required:/;

/** A failed publish as the relay's answer: a prefixed reason is an OK false; anything else is the network, rethrown. */
export function publishAnswer(error: unknown): RelayAnswer {
  const reason = String((error as Error)?.message ?? error);
  if (PREFIXED.test(reason)) return { ok: false, reason };
  throw error;
}

export class RelayPool {
  private relays = new Map<string, AbstractRelay>();
  private failures = new Map<string, { count: number; until: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: PoolOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** A connected relay, or a throw while it is backing off or failing to connect. */
  async relay(url: string): Promise<AbstractRelay> {
    if (!acceptsUrl(url, this.opts.allowInsecure)) throw new Error(`not a wss:// relay: ${url}`);
    const existing = this.relays.get(url);
    if (existing?.connected) return existing;
    const f = this.failures.get(url);
    if (f && this.now() < f.until) throw new Error(`backing off from ${url} for ${f.until - this.now()} ms`);
    const relay = new AbstractRelay(url, {
      verifyEvent: (e) => this.opts.verify(e as NostrEvent),
      websocketImplementation: this.opts.WebSocket,
      enableReconnect: false,
    });
    relay.onauth = async (template: EventTemplate) => {
      const s = await this.opts.signer();
      if (!s) throw new Error('no signer for AUTH');
      return (await s.signEvent(template)) as never;
    };
    try {
      await relay.connect({ timeout: this.opts.connectTimeoutMs ?? 5000 });
    } catch (e) {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(url, { count, until: this.now() + reconnectDelay(count) });
      throw e;
    }
    this.failures.delete(url);
    this.relays.set(url, relay);
    return relay;
  }

  private async authenticate(relay: AbstractRelay): Promise<void> {
    await relay.auth(relay.onauth!);
  }

  /** Publishes and returns the relay's OK; throws on a network failure, which the outbox retries. */
  async publish(url: string, event: NostrEvent): Promise<RelayAnswer> {
    const relay = await this.relay(url);
    const attempt = (): Promise<RelayAnswer> => relay.publish(event).then(() => ({ ok: true }) as RelayAnswer, publishAnswer);
    const first = await attempt();
    if (first.ok || !AUTH_REQUIRED.test(first.reason)) return first;
    await this.authenticate(relay);
    return attempt();
  }

  /** The events matching filters, until EOSE (or the timeout). A CLOSED auth-required authenticates once and asks again. */
  async query(url: string, filters: Filter[], timeoutMs = 10_000): Promise<NostrEvent[]> {
    const relay = await this.relay(url);
    const ask = () =>
      new Promise<{ events: NostrEvent[]; closed?: string }>((ok) => {
        const events: NostrEvent[] = [];
        const timer = setTimeout(() => {
          sub.close();
          ok({ events });
        }, timeoutMs);
        const sub = relay.subscribe(filters, {
          onevent: (e) => events.push(e as NostrEvent),
          oneose: () => {
            clearTimeout(timer);
            sub.close();
            ok({ events });
          },
          onclose: (reason) => {
            clearTimeout(timer);
            ok({ events, closed: reason });
          },
        });
      });
    const first = await ask();
    if (!first.closed || !AUTH_REQUIRED.test(first.closed)) return first.events;
    await this.authenticate(relay);
    return (await ask()).events;
  }

  close(): void {
    for (const r of this.relays.values()) r.close();
    this.relays.clear();
  }
}
