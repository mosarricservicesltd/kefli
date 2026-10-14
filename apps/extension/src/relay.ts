// Talking to the operator relay (extension spec 4): publishing an event, where OK true resolves and a refusal or ten
// seconds without an answer rejects, and fetching the wraps addressed to the device. Both use connections held between
// saves (relayPool.ts).
import { Relay } from 'nostr-tools/relay';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';
import { RelayPool } from './relayPool';

export const PUBLISH_TIMEOUT_MS = 10_000;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('timeout')), ms);
    p.then((v) => (clearTimeout(t), ok(v)), (e) => (clearTimeout(t), fail(e)));
  });
}

const pool = new RelayPool((url) => within(Relay.connect(url), PUBLISH_TIMEOUT_MS));

/** How long a fresh connection is given to send its AUTH challenge before a save goes without it. */
export const AUTH_WAIT_MS = 1_000;
const AUTH_POLL_MS = 50;

/** What AUTH needs of a connection: nostr-tools' Relay has it. */
export type AuthRelay = Pick<Relay, 'auth'>;

/** Connections already given their wait for a challenge, so one that never sends one costs a single wait. */
const waited = new WeakSet<AuthRelay>();
/**
 * Connections whose AUTH never settled. nostr-tools keeps a connection's first AUTH and hands every later ask the same
 * promise, and one it couldn't sign (a challenge that isn't a string) never settles, so each save on it would wait its
 * full limit; once is enough.
 */
const unsettled = new WeakSet<AuthRelay>();
/** How long an AUTH may take: nostr-tools gives up on an unanswered one at 4.4 s, so this only catches one that never ends. */
export const AUTH_SETTLE_MS = 5_000;

/**
 * NIP-42 AUTH as the device key before a wrap goes out (contract 3.2, F9): the operator relay counts a wrap sent on a
 * connection AUTHed as a device the recipient authorised against that key alone, so a flood from elsewhere can't use up
 * the user's allowance. nostr-tools keeps one AUTH per connection, so a connection held between saves answers at once.
 * A fresh one is asked again every 50 ms until its challenge arrives (strfry sends it on connect), for at most waitMs
 * by the clock.
 * onauth is left alone: nostr-tools rethrows a refused AUTH it started itself, which nothing could catch. True when
 * the relay took the AUTH; false stops nothing, and the wrap goes as an unAUTHed one would.
 */
export async function authAs(relay: AuthRelay, device: LocalSigner, waitMs = AUTH_WAIT_MS, settleMs = AUTH_SETTLE_MS): Promise<boolean> {
  if (unsettled.has(relay)) return false;
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  // a deadline by the clock, so a busy machine's late timers don't stretch the wait past waitMs
  const until = Date.now() + (waited.has(relay) ? 0 : waitMs);
  waited.add(relay);
  for (;;) {
    try {
      await within(relay.auth(sign), settleMs);
      return true;
    } catch (e) {
      // within's own limit: the AUTH never settled
      if (e instanceof Error && e.message === 'timeout') unsettled.add(relay);
      if (!String(e).includes('no challenge') || Date.now() >= until) return false;
    }
    await new Promise((later) => setTimeout(later, Math.min(AUTH_POLL_MS, Math.max(0, until - Date.now()))));
  }
}

/** A publish that went unanswered: within's own limit says timeout, nostr-tools' (4.4 s) says "publish timed out". */
const unanswered = (e: unknown) => /\btime(out|d out)\b/.test(String(e));

/**
 * A relay that doesn't answer in time is closed, so the next save connects afresh rather than waiting on it: a socket
 * left open by a network that changed under it can look connected for many minutes while nothing reaches the relay.
 * With the device key, the connection AUTHs as the device first (authAs).
 */
export async function publish(url: string, event: NostrEvent, device?: LocalSigner): Promise<void> {
  const relay = await pool.get(url);
  if (device) await authAs(relay, device);
  try {
    await within(relay.publish(event), PUBLISH_TIMEOUT_MS);
  } catch (e) {
    if (unanswered(e)) pool.close(url);
    throw e;
  }
}

/**
 * The most wraps a look for a move keeps. Only pair-acks are addressed to the device, one for each move, so more is a
 * flood from strangers, which would cost a decryption each when the look opens them (move.ts followMoves).
 */
export const WRAPS_MAX = 100;

/**
 * The gift wraps addressed to the device key since a time (contract 4.4): the relay serves them only after NIP-42 AUTH by
 * that key, so a subscription it closes as auth-required authenticates and asks again. Resolves at the end of stored
 * events, with WRAPS_MAX of them, or with what has come after ten seconds. A wrap sent again is passed over before it is
 * parsed or its signature checked.
 */
export async function fetchWraps(url: string, device: LocalSigner, since: number): Promise<NostrEvent[]> {
  const relay = await pool.get(url);
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  relay.onauth = sign;
  const got = new Map<string, NostrEvent>();
  let sub: { close(): void } | null = null;
  try {
    await within(
      new Promise<void>((done) => {
        const ask = () => {
          sub = relay.subscribe([{ kinds: [1059], '#p': [device.pubkey()], since }], {
            alreadyHaveEvent: (id) => got.has(id),
            onevent: (e) => {
              got.set(e.id, e as NostrEvent);
              if (got.size >= WRAPS_MAX) done();
            },
            oneose: done,
            // a relay's CLOSED may carry anything as its reason
            onclose: (reason) => (String(reason).includes('auth-required') ? relay.auth(sign).then(ask, () => done()) : done()),
          });
        };
        ask();
      }),
      PUBLISH_TIMEOUT_MS,
    ).catch(() => undefined);
  } finally {
    (sub as { close(): void } | null)?.close();
  }
  return [...got.values()];
}

/**
 * Whether the phone has collected a save: it publishes a kind 5 for the wrap, signed by the user, once the save is in the
 * library (contract 4.4). Deletions are public, so no AUTH is needed. False when the relay can't be reached or doesn't
 * answer in time (F40).
 */
export async function collected(url: string, wrapId: string, user: string): Promise<boolean> {
  return within(
    pool.get(url).then((relay) => new Promise<boolean>((done) => {
      let seen = false;
      const sub = relay.subscribe([{ kinds: [5], authors: [user], '#e': [wrapId], limit: 1 }], {
        onevent: () => void (seen = true),
        oneose: () => (sub.close(), done(seen)),
      });
    })),
    PUBLISH_TIMEOUT_MS,
  ).catch(() => false);
}
