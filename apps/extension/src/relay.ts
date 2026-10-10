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

/** A relay that doesn't answer in time is closed, so the next save connects afresh rather than waiting on it. */
export async function publish(url: string, event: NostrEvent): Promise<void> {
  const relay = await pool.get(url);
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
