// Talking to the operator relay (extension spec 4): publishing an event, where OK true resolves and a refusal or ten
// seconds without an answer rejects, and reading what it holds: the wraps addressed to the device, and the phone's
// deletion of a save's wrap. Both use connections held between saves (relayPool.ts). A read is whole only once the
// relay ends its answer with EOSE.
import type { Filter } from 'nostr-tools/filter';
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

// nostr-tools closes a connection still opening at its own timeout, so one given up on isn't left to open unheld
const pool = new RelayPool((url) => within(Relay.connect(url, { timeout: PUBLISH_TIMEOUT_MS }), PUBLISH_TIMEOUT_MS));

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
 * A REQ's answer: the events that came, each once, whether the relay ended it with EOSE before the read stopped, and
 * whether the read stopped at the most events it keeps (full), past which the relay may hold more.
 */
export interface Answer {
  events: NostrEvent[];
  whole: boolean;
  full: boolean;
  /** Why it ended: EOSE, the relay's CLOSED and its reason, so many events, or the time limit. */
  why: string;
}

/** A read's limits: how long it may take, and how many events it keeps before it stops reading. */
interface Limits {
  ms: number;
  most: number;
}

/**
 * The relay's answer to one REQ, ended by its EOSE, its CLOSED or the connection closing, `most` events, or `ms`; only
 * EOSE ends it whole. nostr-tools' own wait for EOSE, 4.4 s from the REQ, ends a subscription as if the relay had sent
 * EOSE however much was still to come, so it is set past `ms`, and run at once to an answer already settled when the
 * answer ends any other way, so it is never left running. Read as whole, an answer cut at 4.4 s said the phone hadn't
 * collected a save when its deletion was still coming (Undo then said Removed from Kefli of a save on the phone), and let
 * a look for a move count as having read wraps it never had. An event sent again is passed over before it is parsed or
 * its signature checked.
 */
function answer(relay: Relay, filters: Filter[], limits: Limits): Promise<Answer> {
  return new Promise((settle) => {
    const got = new Map<string, NostrEvent>();
    let open = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // closed: nostr-tools has closed the subscription itself, at the relay's CLOSED or the connection's end
    const end = (whole: boolean, why: string, closed = false) => {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      if (!closed) sub.close();
      if (!sub.eosed) sub.receivedEose();
      settle({ events: [...got.values()], whole, full: got.size >= limits.most, why });
    };
    const sub = relay.subscribe(filters, {
      eoseTimeout: limits.ms + 1_000,
      alreadyHaveEvent: (id) => got.has(id),
      onevent: (e) => {
        got.set(e.id, e as NostrEvent);
        if (got.size >= limits.most) end(false, `${limits.most} events`);
      },
      oneose: () => end(true, 'EOSE'),
      // a relay's CLOSED may carry anything as its reason
      onclose: (reason) => end(false, `closed: ${String(reason)}`, true),
    });
    timer = setTimeout(() => end(false, 'timeout'), limits.ms);
  });
}

/** What is left of a deadline, in ms. */
const left = (until: number) => Math.max(0, until - Date.now());

/**
 * A connection that sent nothing at all for a whole read is closed and let go, as one that doesn't answer a publish is,
 * so the next read connects afresh rather than asking a socket the network dropped without a word.
 */
function heard(url: string, got: Answer): Answer {
  if (got.why === 'timeout' && !got.events.length) pool.close(url);
  return got;
}

/**
 * The gift wraps addressed to the device key since a time (contract 4.4), and before one (`before`, for a look reading
 * down past the newest answer, move.ts lookDeeper), newest first, and whether the relay finished its answer. The relay
 * serves them only after NIP-42 AUTH by that key, so a subscription it closes as auth-required authenticates and asks
 * again, all within ten seconds of connecting. An answer stopped at WRAPS_MAX (full), cut short by the relay or the
 * connection, or unfinished after ten seconds keeps what came, but isn't whole, so the look doesn't count as having read
 * its window (move.ts lookForMove). The relay is asked for WRAPS_MAX at most, which is all a read keeps.
 */
export async function fetchWraps(url: string, device: LocalSigner, since: number, before?: number): Promise<Answer> {
  const relay = await pool.get(url);
  const until = Date.now() + PUBLISH_TIMEOUT_MS;
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  relay.onauth = sign;
  const filters: Filter[] = [{ kinds: [1059], '#p': [device.pubkey()], since, limit: WRAPS_MAX, ...(before === undefined ? {} : { until: before }) }];
  const first = heard(url, await answer(relay, filters, { ms: left(until), most: WRAPS_MAX }));
  if (first.whole || !first.why.includes('auth-required')) return first;
  const authed = await within(relay.auth(sign), left(until)).then(() => true, () => false);
  return authed ? heard(url, await answer(relay, filters, { ms: left(until), most: WRAPS_MAX })) : first;
}

/**
 * Whether the phone has collected a save: it publishes a kind 5 for the wrap, signed by the user, once the save is in the
 * library (contract 4.4). Deletions are public, so no AUTH is needed. True once the relay sends one; false when it
 * finishes its answer (EOSE) without one; null for no answer, when it can't be reached or doesn't finish within ten
 * seconds, since the phone may have the save all the same (F40).
 */
export async function collected(url: string, wrapId: string, user: string): Promise<boolean | null> {
  const until = Date.now() + PUBLISH_TIMEOUT_MS;
  const relay = await pool.get(url).catch(() => null);
  if (!relay) return null;
  const got = heard(url, await answer(relay, [{ kinds: [5], authors: [user], '#e': [wrapId], limit: 1 }], { ms: left(until), most: 1 }));
  return got.events.length > 0 || (got.whole ? false : null);
}
