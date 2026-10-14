// Kefli's relay pool (mobile spec 4.4): one connection per relay on nostr-tools' AbstractRelay, with the
// verifier injected and AUTH through Signer. Reconnects back off from 1 s to 60 s; only wss:// is accepted,
// unless allowInsecure (the local stack in server/dev). AUTH is per connection and only when asked for: a publish
// answered auth-required, or a query closed with it, authenticates and tries once more (contract 3.2); a challenge
// sent on connect asks nothing of the signer. An AUTH that fails, whether the signer refused, never answered or the
// socket went, closes that connection so the next call starts afresh (F13): nostr-tools keeps one AUTH promise per
// connection and leaves it pending for good when the signer throws.
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import type { Filter } from 'nostr-tools/filter';
import { NIP46_TIMEOUT_MS, withTimeout, type EventTemplate, type NostrEvent, type Signer } from '@kefli/protocol';

export type RelayAnswer = { ok: true } | { ok: false; reason: string };

export type PoolOptions = {
  verify: (event: NostrEvent) => boolean;
  /** The signer that answers AUTH for this pool's identity. */
  signer: () => Promise<Signer | null>;
  allowInsecure?: boolean;
  WebSocket?: typeof WebSocket;
  now?: () => number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
};

/** The longest an AUTH may take: the signer's own two minutes (NIP-46 and NIP-55 alike), then the relay's OK. */
export const AUTH_TIMEOUT_MS = NIP46_TIMEOUT_MS + 10_000;

/** 1 s doubling to 60 s. */
export function reconnectDelay(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
}

export function acceptsUrl(url: string, allowInsecure = false): boolean {
  // string tests, since the code gate's parser misreads these regex literals and loses its place in the file
  return url.startsWith('wss://') || (allowInsecure && url.startsWith('ws://'));
}

const PREFIXED = new RegExp('^[a-z-]+:');
// strfry closes a REQ with "ERROR: auth-required: …", so the prefix is looked for anywhere in the reason.
const AUTH_REQUIRED = new RegExp('(^|\\s)auth-required:');

/** A failed publish as the relay's answer: a prefixed reason is an OK false; anything else is the network, rethrown. */
export function publishAnswer(error: unknown): RelayAnswer {
  const reason = String((error as Error)?.message ?? error);
  if (PREFIXED.test(reason)) return { ok: false, reason };
  throw error;
}

/** What the pool keeps beside each connection: a promise that fails when it closes, and its AUTH once begun. */
type Conn = { closed: Promise<never>; shut: () => void; auth?: Promise<void> };

const noop = () => undefined;

function conn(): Conn {
  let shut: () => void = noop;
  const closed = new Promise<never>((_, fail) => (shut = () => fail(new Error('relay connection closed'))));
  closed.catch(noop);
  return { closed, shut };
}

export class RelayPool {
  private relays = new Map<string, AbstractRelay>();
  private failures = new Map<string, { count: number; until: number }>();
  private connecting = new Map<string, Promise<AbstractRelay>>();
  private conns = new WeakMap<AbstractRelay, Conn>();
  private readonly now: () => number;

  constructor(private readonly opts: PoolOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** A connected relay, or a throw while it is backing off or failing to connect; callers at once share one connect. */
  async relay(url: string): Promise<AbstractRelay> {
    if (!acceptsUrl(url, this.opts.allowInsecure)) throw new Error(`not a wss:// relay: ${url}`);
    const existing = this.relays.get(url);
    if (existing?.connected) return existing;
    let pending = this.connecting.get(url);
    if (!pending) {
      pending = this.connect(url).finally(() => this.connecting.delete(url));
      this.connecting.set(url, pending);
    }
    return pending;
  }

  private async connect(url: string): Promise<AbstractRelay> {
    const f = this.failures.get(url);
    if (f && this.now() < f.until) throw new Error(`backing off from ${url} for ${f.until - this.now()} ms`);
    const relay = new AbstractRelay(url, {
      verifyEvent: (e) => this.opts.verify(e as NostrEvent),
      websocketImplementation: this.opts.WebSocket,
      enableReconnect: false,
    });
    const c = conn();
    this.conns.set(relay, c);
    relay.onclose = () => {
      this.forget(url, relay);
      c.shut();
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

  private forget(url: string, relay: AbstractRelay): void {
    if (this.relays.get(url) === relay) this.relays.delete(url);
  }

  /** This connection's AUTH, begun once and shared; on any failure the connection is closed and forgotten. */
  private authenticate(url: string, relay: AbstractRelay): Promise<void> {
    let c = this.conns.get(relay);
    if (!c) this.conns.set(relay, (c = conn()));
    c.auth ??= this.signIn(relay, c).catch((e) => {
      this.forget(url, relay);
      relay.close();
      throw e;
    });
    return c.auth;
  }

  /** AUTH, settled by the relay's OK, the signer's failure (which nostr-tools only logs), the socket closing or the timeout. */
  private async signIn(relay: AbstractRelay, c: Conn): Promise<void> {
    let refused: (e: unknown) => void = noop;
    const failed = new Promise<never>((_, fail) => (refused = fail));
    const sign = async (template: EventTemplate) => {
      try {
        const s = await this.opts.signer();
        if (!s) throw new Error('no signer for AUTH');
        return (await s.signEvent(template)) as never;
      } catch (e) {
        refused(e);
        throw e;
      }
    };
    await withTimeout(Promise.race([relay.auth(sign), failed, c.closed]), this.opts.authTimeoutMs ?? AUTH_TIMEOUT_MS);
  }

  /** Publishes and returns the relay's OK; throws on a network failure, which the outbox retries. */
  async publish(url: string, event: NostrEvent): Promise<RelayAnswer> {
    const relay = await this.relay(url);
    const attempt = (): Promise<RelayAnswer> => relay.publish(event).then(() => ({ ok: true }) as RelayAnswer, publishAnswer);
    const first = await attempt();
    if (first.ok || !AUTH_REQUIRED.test(first.reason)) return first;
    await this.authenticate(url, relay);
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
    await this.authenticate(url, relay);
    return (await ask()).events;
  }

  /**
   * A live subscription (the inbox, 4.7): AUTH as query does, once. onDrop when the relay closes it or the
   * connection goes; the caller decides when to watch again. Returns the stop.
   */
  async watch(url: string, filters: Filter[], onEvent: (e: NostrEvent) => void, onDrop: () => void): Promise<() => void> {
    const relay = await this.relay(url);
    let stopped = false;
    let sub: { close: () => void } | null = null;
    const open = (authed: boolean) => {
      sub = relay.subscribe(filters, {
        onevent: (e) => onEvent(e as NostrEvent),
        onclose: (reason) => {
          if (stopped) return;
          if (!authed && AUTH_REQUIRED.test(reason)) this.authenticate(url, relay).then(() => !stopped && open(true), onDrop);
          else onDrop();
        },
      });
    };
    open(false);
    return () => {
      stopped = true;
      sub?.close();
    };
  }

  close(): void {
    for (const r of this.relays.values()) r.close();
    this.relays.clear();
  }
}
