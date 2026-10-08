// NIP-46 by a pasted bunker:// link (mobile spec 3.4, contract 2): BunkerSigner on a pool of its own, holding only
// the link's wss:// relays and Shelf's verifier, outside RelayPool's backoff. connect sends the standing perms,
// since nostr-tools 2.25.2's connect() sends none. Every request waits at most two minutes.
import { hexToBytes } from '@noble/hashes/utils.js';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { BunkerSigner } from 'nostr-tools/nip46';
import { NIP46_TIMEOUT_MS, Nip46Signer, nip46Perms, readBunkerLink, verifyEventWith, withTimeout, type BunkerLink } from '@shelf/protocol';
import { nativeSecp } from '../crypto/secp';

const pool = () => new AbstractSimplePool({ verifyEvent: (e) => verifyEventWith(nativeSecp, e as never), maxWaitForConnection: 10_000 });

function bunkerFor(link: BunkerLink, clientHex: string): BunkerSigner {
  return BunkerSigner.fromBunker(hexToBytes(clientHex), { pubkey: link.pubkey, relays: link.relays, secret: link.secret }, { pool: pool() });
}

/** A signed-in bunker's signer, from the key file. */
export function nip46Signer(bunkerUrl: string, clientHex: string, userPubkey: string): Nip46Signer | null {
  const link = readBunkerLink(bunkerUrl);
  return link ? new Nip46Signer(bunkerFor(link, clientHex), userPubkey) : null;
}

/** Sign-in: connect with the perms, then ask whose key it signs with (it may differ from the bunker's own). */
export async function connectBunker(link: BunkerLink, clientHex: string): Promise<{ signer: Nip46Signer; pubkey: string }> {
  const b = bunkerFor(link, clientHex);
  await withTimeout(b.sendRequest('connect', [link.pubkey, link.secret ?? '', nip46Perms()]), NIP46_TIMEOUT_MS);
  const pubkey = await withTimeout(b.getPublicKey(), NIP46_TIMEOUT_MS);
  return { signer: new Nip46Signer(b, pubkey), pubkey };
}
