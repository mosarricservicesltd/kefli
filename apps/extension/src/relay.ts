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
 * NIP-42 AUTH as the device key before a wrap goes out (contract 3.2, F9): the operator relay counts a wrap sent on a
 * connection AUTHed as a device the recipient authorised against that key alone, so a flood from elsewhere can't use up
 * the user's allowance. nostr-tools keeps one AUTH per connection, so a connection held between saves answers at once.
 * A fresh one is asked again every 50 ms until its challenge arrives (strfry sends it on connect), for at most waitMs
 * by the clock.
 * onauth is left alone: nostr-tools rethrows a refused AUTH it started itself, which nothing could catch. True when
 * the relay took the AUTH; false stops nothing, and the wrap goes as an unAUTHed one would.
 */
export async function authAs(relay: AuthRelay, device: LocalSigner, waitMs = AUTH_WAIT_MS): Promise<boolean> {
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  // a deadline by the clock, so a busy machine's late timers don't stretch the wait past waitMs
  const until = Date.now() + (waited.has(relay) ? 0 : waitMs);
  waited.add(relay);
  for (;;) {
    try {
      await within(relay.auth(sign), PUBLISH_TIMEOUT_MS);
      return true;
    } catch (e) {
      if (!String(e).includes('no challenge') || Date.now() >= until) return false;
    }
    await new Promise((later) => setTimeout(later, Math.min(AUTH_POLL_MS, Math.max(0, until - Date.now()))));
  }
}

/**
 * A relay that doesn't answer in time is closed, so the next save connects afresh rather than waiting on it. With
 * the device key, the connection AUTHs as the device first (authAs).
 */
export async function publish(url: string, event: NostrEvent, device?: LocalSigner): Promise<void> {
  const relay = await pool.get(url);
  if (device) await authAs(relay, device);
  try {
    await within(relay.publish(event), PUBLISH_TIMEOUT_MS);
  } catch (e) {
    if (String(e).includes('timeout')) pool.close(url);
    throw e;
  }
}

/**
 * The gift wraps addressed to the device key since a time (contract 4.4): the relay serves them only after NIP-42 AUTH by
 * that key, so a subscription it closes as auth-required authenticates and asks again. Resolves at the end of stored
 * events, or with what has come after ten seconds.
 */
export async function fetchWraps(url: string, device: LocalSigner, since: number): Promise<NostrEvent[]> {
  const relay = await pool.get(url);
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  relay.onauth = sign;
  const got: NostrEvent[] = [];
  let sub: { close(): void } | null = null;
  try {
    await within(
      new Promise<void>((done) => {
        const ask = () => {
          sub = relay.subscribe([{ kinds: [1059], '#p': [device.pubkey()], since }], {
            onevent: (e) => void got.push(e as NostrEvent),
            oneose: done,
            onclose: (reason) => (reason.includes('auth-required') ? relay.auth(sign).then(ask, () => done()) : done()),
          });
        };
        ask();
      }),
      PUBLISH_TIMEOUT_MS,
    ).catch(() => undefined);
  } finally {
    (sub as { close(): void } | null)?.close();
  }
  return got;
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
