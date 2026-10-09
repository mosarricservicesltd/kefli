// Publishing one event to one relay (extension spec 4): OK true resolves, a refusal or ten seconds without an answer
// rejects. A connection per publish for now; the spec's reuse for 60 seconds is a later refinement.
import { Relay } from 'nostr-tools/relay';
import type { NostrEvent } from '../../../packages/protocol/src/signer';

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
