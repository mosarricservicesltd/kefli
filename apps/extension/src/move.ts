// Following the library to another key (contract 4.4 and 4.8). When the phone moves a library from S to T it sends each
// connected browser a pair-ack sealed by S, the key the browser knows, carrying T's pubkey, relays, servers and a new
// token, with moved_from = S. The browser takes it only from its current user, replaces its pairing, and wraps any save
// still waiting again for T, so nothing queued goes to the library that moved away.
import { acceptPairAck, type PairAck } from '../../../packages/protocol/src/pairing';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';
import { unwrap } from '../../../packages/protocol/src/wrap';
import { changeQueue, type Queued } from './queue';
import { wrapAgain } from './save';
import { addresses, KEYS, type Pairing, type Store } from './store';

/**
 * The move to follow, if any: each pair-ack must come from the current user (moved_from and the seal's signer), so a chain
 * S → T → U is followed one step at a time, oldest first. Each ack is taken once at most, so a library that moved away
 * and back (S → T → S) ends where it ended rather than going round for ever (F52). Returns the final ack, or null when
 * nothing applies.
 */
export async function followMoves(device: LocalSigner, wraps: NostrEvent[], current: string): Promise<PairAck | null> {
  let user = current;
  let found: PairAck | null = null;
  const open = await Promise.all(wraps.map(async (w) => unwrap(device, w).catch(() => null)));
  const candidates = open
    .filter((o): o is NonNullable<typeof o> => o !== null)
    .sort((a, b) => a.rumor.created_at - b.rumor.created_at);
  const taken = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < candidates.length; i++) {
      if (taken.has(i)) continue;
      const { rumor, seal } = candidates[i];
      const v = acceptPairAck(rumor, seal, { offerNonce: null, pairedUser: user });
      if (!v.ok || !v.move || v.ack.user_pubkey === user) continue;
      taken.add(i);
      found = v.ack;
      user = v.ack.user_pubkey;
      changed = true;
    }
  }
  return found;
}

/**
 * A queued save wrapped again for the new user, with the new token; its blob and everything else stay. One whose sealed
 * request can't be read (queued before requests were kept) stays as it was.
 */
export async function rewrap(e: Queued, device: LocalSigner, pairing: Pairing, now: number): Promise<Queued> {
  const again = await wrapAgain(e.sealed, device, pairing.user_pubkey, (r) => ({ ...r, token: pairing.token }), now);
  return again ? { ...e, id: again.wrap.id, wrap: again.wrap, sealed: again.sealed, wrapped_at: now } : e;
}

/**
 * Takes the move: the pairing replaced (its label and date kept) and the queue wrapped again for the new user, under the
 * queue's lock, so a save queued meanwhile isn't overwritten (F41).
 */
export async function applyMove(store: Store, device: LocalSigner, ack: PairAck, now: number): Promise<Pairing> {
  const old = await store.get<Pairing>(KEYS.pairing);
  // its lists as the extension keeps them (store.ts addresses)
  const pairing: Pairing = { v: 1, user_pubkey: ack.user_pubkey, write_relays: addresses(ack.write_relays), blossom_servers: addresses(ack.blossom_servers), token: String(ack.token), label: old?.label ?? '', paired_at: old?.paired_at ?? now };
  await changeQueue(store, async (q) => {
    for (let i = 0; i < q.length; i++) q[i] = await rewrap(q[i], device, pairing, now);
  });
  await store.set(KEYS.pairing, pairing);
  return pairing;
}

