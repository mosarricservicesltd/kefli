// Following the library to another key (contract 4.4 and 4.8). When the phone moves a library from S to T it sends each
// connected browser a pair-ack sealed by S, the key the browser knows, carrying T's pubkey, relays, servers and a new
// token, with moved_from = S. The browser takes it only from its current user, replaces its pairing, and wraps any save
// still waiting again for T, so nothing queued goes to the library that moved away. Undo's key for each goes with it,
// so a toast from before the move still undoes its save (F40).
import { acceptPairAck, type PairAck } from '../../../packages/protocol/src/pairing';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';
import { unwrap } from '../../../packages/protocol/src/wrap';
import { exclusive } from './lock';
import { changeQueue, type Queued } from './queue';
import { wrapAgain } from './save';
import { addresses, KEYS, type Pairing, type Store } from './store';
import { moveUndoKey } from './undo';

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

/** A queued save wrapped again, and the key that alone retracts its new wrap. */
export interface Rewrapped {
  entry: Queued;
  /** Null for a save left as it was. */
  wrapKey: Uint8Array | null;
}

/**
 * A queued save wrapped again for the new user, with the new token; its blob and everything else stay. One whose sealed
 * request can't be read (queued before requests were kept) stays as it was.
 */
export async function rewrap(e: Queued, device: LocalSigner, pairing: Pairing, now: number): Promise<Rewrapped> {
  const again = await wrapAgain(e.sealed, device, pairing.user_pubkey, (r) => ({ ...r, token: pairing.token }), now);
  if (!again) return { entry: e, wrapKey: null };
  return { entry: { ...e, id: again.wrap.id, wrap: again.wrap, sealed: again.sealed, wrapped_at: now }, wrapKey: again.wrapKey };
}

/** A save the move put under a new wrap: the wrap it went by, the one it goes by now and that wrap's key. */
interface Renaming {
  was: string;
  to: string;
  wrapKey: Uint8Array;
  sha256: string | null;
  /** The library the old wrap went to, when that wrap may be on the relay already, so Undo retracts it too (undo.ts). */
  wentTo: string | null;
}

/**
 * Told of each save the move puts under a new wrap, before the queue naming it is written (worker.ts follow); true while
 * a send of its old wrap is under way.
 */
export type Follow = (was: string, to: string) => boolean;

/**
 * Whether a waiting save's wrap may be on the relay already, as Undo reads a waiting save (worker.ts unqueue): one tried
 * before, whose answer may have timed out though the relay took it, or one whose send is under way as the move is taken.
 */
const mayHaveGone = (e: Queued, underWay: boolean) => underWay || e.why !== 'offline' || e.attempts > 0;

/** The library a queued save's wrap was made for: its p tag. */
const recipient = (e: Queued): string | null => e.wrap?.tags?.find((t) => t[0] === 'p')?.[1] ?? null;

/** The queue wrapped again for the new user, in place, and the saves that went under a new wrap. */
async function rewrapQueue(q: Queued[], device: LocalSigner, pairing: Pairing, now: number, follow: Follow): Promise<Renaming[]> {
  const renamed: Renaming[] = [];
  for (let i = 0; i < q.length; i++) {
    const { entry, wrapKey } = await rewrap(q[i], device, pairing, now);
    if (wrapKey) {
      const underWay = follow(q[i].id, entry.id);
      renamed.push({ was: q[i].id, to: entry.id, wrapKey, sha256: entry.sha256, wentTo: mayHaveGone(q[i], underWay) ? recipient(q[i]) : null });
    }
    q[i] = entry;
  }
  return renamed;
}

/** Whether the pairing is already the one this move leaves: its user and its token, new at every move. */
const holds = (p: Pairing, ack: PairAck): boolean => p.user_pubkey === ack.user_pubkey && p.token === String(ack.token);

/**
 * Takes the move: the pairing replaced (its label and date kept) and the queue wrapped again for the new user, under the
 * queue's lock, so a save queued meanwhile isn't overwritten (F41). A save whose send is under way is wrapped again too,
 * and `follow` is told, so its new wrap waits for that send (worker.ts). Undo's key for each save then moves to its new
 * wrap in the session (undo.ts), so Undo on a toast still naming the old one, such as the offline one, takes the save off
 * the queue rather than retracting a wrap that never went and saying it couldn't undo. An old wrap that may be on the
 * relay, tried before or sending now, keeps its key beside the new one, so Undo retracts it as well: the phone's last look
 * at the old library's inbox would otherwise bring the save into the new one. A session that won't take a key doesn't
 * stop the move; that save's Undo then says it couldn't. One move at a time, and a move the pairing already holds, its
 * user and token, isn't taken again: two looks for a move run together when two saves are made at once, or a save as the
 * half-hourly look runs (bg.ts checkMoves), and each found the same pair-ack and wrapped the queue again.
 */
export function applyMove(store: Store, device: LocalSigner, ack: PairAck, now: number, session: Store, follow: Follow = () => false): Promise<Pairing> {
  return exclusive('move', async () => {
    const old = await store.get<Pairing>(KEYS.pairing);
    if (old && holds(old, ack)) return old;
    // its lists as the extension keeps them (store.ts addresses)
    const pairing: Pairing = { v: 1, user_pubkey: ack.user_pubkey, write_relays: addresses(ack.write_relays), blossom_servers: addresses(ack.blossom_servers), token: String(ack.token), label: old?.label ?? '', paired_at: old?.paired_at ?? now };
    const renamed = await changeQueue(store, (q) => rewrapQueue(q, device, pairing, now, follow));
    for (const r of renamed) await moveUndoKey(session, r.was, r.to, r.wrapKey, r.sha256, r.wentTo).catch(() => undefined);
    await store.set(KEYS.pairing, pairing);
    return pairing;
  });
}

