// Drains the outbox with the real network (mobile spec 4.3): after a share's rows are released and at start.
// Relays are reached one connection per publish for now; the relay pool (4.4) replaces this.
import { Relay } from 'nostr-tools/relay';
import type { NostrEvent } from '@shelf/protocol';
import { phoneCrypto } from '../crypto/port';
import { loadDefaults, type Defaults } from './config';
import { currentSigner } from './identity';
import { drain, type RelayAnswer } from './send';
import { readStaged } from './staging';
import { store } from './store';

let running: Promise<number> | null = null;
let defaults: Defaults | null = null;

async function publish(url: string, event: NostrEvent): Promise<RelayAnswer> {
  const relay = await Relay.connect(url);
  try {
    await relay.publish(event);
    return { ok: true };
  } catch (e) {
    const reason = String((e as Error)?.message ?? e);
    // An OK false carries a prefixed reason; anything else is the network, which the outbox retries.
    if (/^[a-z-]+:/.test(reason)) return { ok: false, reason };
    throw e;
  } finally {
    relay.close();
  }
}

/** Sends whatever is due; concurrent calls share one run. Returns how many rows were sent. */
export function runOutbox(): Promise<number> {
  running ??= (async () => {
    try {
      defaults = await loadDefaults();
      const d = defaults;
      return await drain({
        db: store(),
        now: () => Math.floor(Date.now() / 1000),
        signer: async (pubkey) => {
          const s = await currentSigner();
          return s?.pubkey() === pubkey ? s : null;
        },
        fetch,
        crypto: phoneCrypto,
        defaults: () => d,
        publish,
        readBlob: readStaged,
      });
    } finally {
      running = null;
    }
  })();
  return running;
}
