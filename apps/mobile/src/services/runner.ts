// Drains the outbox with the real network (mobile spec 4.3): after a share's rows are released and at start,
// through the relay pool (4.4).
import { verifyEventWith } from '@shelf/protocol';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import { RelayPool } from '../net/pool';
import { LOCAL_STACK, loadDefaults, type Defaults } from './config';
import { currentSigner } from './identity';
import { drain } from './send';
import { readStaged } from './staging';
import { store } from './store';

let running: Promise<number> | null = null;
let defaults: Defaults | null = null;

// One pool per process (mobile spec 4.4). ws:// only while the defaults point at the local stack.
export const pool = new RelayPool({
  verify: (e) => verifyEventWith(nativeSecp, e),
  signer: currentSigner,
  allowInsecure: LOCAL_STACK,
});

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
        publish: (url, event) => pool.publish(url, event),
        readBlob: readStaged,
      });
    } finally {
      running = null;
    }
  })();
  return running;
}
