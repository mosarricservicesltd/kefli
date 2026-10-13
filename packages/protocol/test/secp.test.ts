import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkSecp, conversationKey, nobleSecp, parseBip340, signEventWith, verifyEventWith } from '../src';
import type { SecpPort } from '../src';
import { nodeCrypto } from '../src/node';

const vectors = parseBip340(readFileSync(join(__dirname, 'vectors/bip340.vectors.csv'), 'utf8'));

describe('secp port', () => {
  test('noble passes BIP-340’s vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
    expect(checkSecp(nobleSecp, vectors)).toEqual([]);
  });

  test('a broken port is caught', () => {
    const broken: SecpPort = { ...nobleSecp, verify: () => true };
    expect(checkSecp(broken, vectors).length).toBeGreaterThan(0);
  });

  test('signEventWith makes events nostr-tools accepts', () => {
    const sk = nodeCrypto.randomBytes(32);
    const ev = signEventWith(nobleSecp, { kind: 1, created_at: 1, tags: [['t', 'x']], content: 'hi' }, sk);
    expect(verifyEvent(JSON.parse(JSON.stringify(ev)))).toBe(true);
  });

  test('verifyEventWith accepts nostr-tools events and refuses tampering', () => {
    const ev = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' }, nodeCrypto.randomBytes(32))));
    expect(verifyEventWith(nobleSecp, ev)).toBe(true);
    expect(verifyEventWith(nobleSecp, { ...ev, content: 'ho' })).toBe(false);
    expect(verifyEventWith(nobleSecp, { ...ev, sig: ev.sig.replace(/^./, ev.sig[0] === 'a' ? 'b' : 'a') })).toBe(false);
    expect(verifyEventWith(nobleSecp, { ...ev, pubkey: 'zz' })).toBe(false);
  });

  test('a verifier that reads hex loosely never sees a sig or id that is not 64 or 128 lower-case hex digits (F52)', () => {
    const ev = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' }, nodeCrypto.randomBytes(32))));
    const seen: string[] = [];
    const loose = { ...nobleSecp, verify: (sig: string) => (seen.push(sig), true) };
    expect(verifyEventWith(loose, ev)).toBe(true);
    expect(verifyEventWith(loose, { ...ev, sig: `+${ev.sig.slice(1)}` })).toBe(false);
    expect(verifyEventWith(loose, { ...ev, sig: ev.sig.toUpperCase() })).toBe(false);
    expect(verifyEventWith(loose, { ...ev, sig: `${ev.sig}00` })).toBe(false);
    expect(verifyEventWith(loose, { ...ev, id: ev.id.toUpperCase() })).toBe(false);
    expect(seen).toEqual([ev.sig]);
  });

  test('conversationKey matches nostr-tools', () => {
    const a = nodeCrypto.randomBytes(32);
    const b = nodeCrypto.randomBytes(32);
    expect(bytesToHex(conversationKey(nobleSecp, a, nobleSecp.publicKey(b)))).toBe(bytesToHex(nip44.utils.getConversationKey(a, nobleSecp.publicKey(b))));
  });
});
