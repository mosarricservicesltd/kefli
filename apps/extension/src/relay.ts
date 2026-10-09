// Publishing one event to one relay (extension spec 4): OK true resolves, a refusal or ten seconds without an answer
// rejects. A connection per publish for now; the spec's reuse for 60 seconds is a later refinement.
import { Relay } from 'nostr-tools/relay';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';

export const PUBLISH_TIMEOUT_MS = 10_000;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('timeout')), ms);
    p.then((v) => (clearTimeout(t), ok(v)), (e) => (clearTimeout(t), fail(e)));
  });
}

export async function publish(url: string, event: NostrEvent): Promise<void> {
  const relay = await within(Relay.connect(url), PUBLISH_TIMEOUT_MS);
  try {
    await within(relay.publish(event), PUBLISH_TIMEOUT_MS);
  } finally {
    relay.close();
  }
}

/**
 * The gift wraps addressed to the device key since a time (contract 4.4): the relay serves them only after NIP-42 AUTH by
 * that key, so a subscription it closes as auth-required authenticates and asks again. Resolves at the end of stored
 * events, or with what has come after ten seconds.
 */
export async function fetchWraps(url: string, device: LocalSigner, since: number): Promise<NostrEvent[]> {
  const relay = await within(Relay.connect(url), PUBLISH_TIMEOUT_MS);
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  relay.onauth = sign;
  const got: NostrEvent[] = [];
  try {
    await within(
      new Promise<void>((done) => {
        const ask = () =>
          relay.subscribe([{ kinds: [1059], '#p': [device.pubkey()], since }], {
            onevent: (e) => void got.push(e as NostrEvent),
            oneose: done,
            onclose: (reason) => (reason.includes('auth-required') ? relay.auth(sign).then(ask, () => done()) : done()),
          });
        ask();
      }),
      PUBLISH_TIMEOUT_MS,
    ).catch(() => undefined);
  } finally {
    relay.close();
  }
  return got;
}
