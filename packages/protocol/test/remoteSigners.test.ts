import {
  LocalSigner, Nip46Signer, Nip55Signer, TimeoutError, bookmarkLinks, nip46Perms, nip55Permissions, probeSigner, readBunkerLink,
  type BunkerLike, type Nip55Port, type NostrEvent,
} from '../src';
import { nodeCrypto } from '../src/node';

const PK = new LocalSigner(nodeCrypto.randomBytes(32)).pubkey();

describe('the user’s own nostr app (contract 2)', () => {
  test('the permissions asked for up front', () => {
    expect(nip46Perms()).toBe('nip44_encrypt,nip44_decrypt,sign_event:30078,sign_event:5,sign_event:13,sign_event:10002,sign_event:10063,sign_event:22242,sign_event:27235,sign_event:24242,sign_event:39701');
    expect(nip55Permissions().slice(0, 3)).toEqual([{ type: 'nip44_encrypt' }, { type: 'nip44_decrypt' }, { type: 'sign_event', kind: 30078 }]);
    expect(nip55Permissions()).toHaveLength(11);
  });

  test('a bunker link needs a 64-hex pubkey and a wss:// relay; a secret is optional', () => {
    expect(readBunkerLink(`bunker://${PK}?relay=wss://relay.example.com&relay=ws://insecure&secret=abc`)).toEqual({ pubkey: PK, relays: ['wss://relay.example.com'], secret: 'abc' });
    expect(readBunkerLink(` bunker://${PK}?relay=wss%3A%2F%2Fr.example `)).toEqual({ pubkey: PK, relays: ['wss://r.example'], secret: null });
    expect(readBunkerLink(`bunker://${PK}?relay=ws://only.insecure`)).toBeNull();
    expect(readBunkerLink(`bunker://${PK}`)).toBeNull();
    expect(readBunkerLink('bunker://npub1abc?relay=wss://r.example')).toBeNull();
    expect(readBunkerLink(`nostrconnect://${PK}?relay=wss://r.example`)).toBeNull();
    expect(readBunkerLink('not a link')).toBeNull();
  });

  test('the probe: a signer that round trips passes; one that garbles or throws is refused', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    expect(await probeSigner(s)).toBe(true);
    const garbles = { pubkey: () => PK, nip44Encrypt: async () => 'x', nip44Decrypt: async () => 'not it' } as never;
    expect(await probeSigner(garbles)).toBe(false);
    const throws = { pubkey: () => PK, nip44Encrypt: async () => { throw new Error('no'); } } as never;
    expect(await probeSigner(throws)).toBe(false);
  });

  test('NIP-55 goes through the module; a signature by another key is refused', async () => {
    const real = new LocalSigner(nodeCrypto.randomBytes(32));
    const other = new LocalSigner(nodeCrypto.randomBytes(32));
    let signWith = real;
    const port: Nip55Port = {
      signEvent: async (_pkg, json) => JSON.stringify(await signWith.signEvent(JSON.parse(json))),
      nip44Encrypt: async (_pkg, text, peer) => real.nip44Encrypt(peer, text),
      nip44Decrypt: async (_pkg, text, peer) => real.nip44Decrypt(peer, text),
      canActInBackground: async () => false,
    };
    const s = new Nip55Signer(port, 'com.example.signer', real.pubkey());
    expect((await s.signEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' })).pubkey).toBe(real.pubkey());
    expect(await probeSigner(s)).toBe(true);
    expect(await s.canActInBackground()).toBe(false);
    signWith = other;
    await expect(s.signEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' })).rejects.toThrow('another key');
  });

  test('an unanswered NIP-55 request fails after its wait, so the outbox can retry', async () => {
    const never: Nip55Port = { signEvent: () => new Promise(() => undefined), nip44Encrypt: () => new Promise(() => undefined), nip44Decrypt: () => new Promise(() => undefined), canActInBackground: async () => false };
    const s = new Nip55Signer(never, 'com.example.signer', PK, 20);
    await expect(s.signEvent({ kind: 24242, created_at: 1, tags: [], content: '' })).rejects.toBeInstanceOf(TimeoutError);
    await expect(s.nip44Encrypt(PK, 'x')).rejects.toBeInstanceOf(TimeoutError);
  });

  test('NIP-46 waits two minutes, then fails', async () => {
    const real = new LocalSigner(nodeCrypto.randomBytes(32));
    const silent: BunkerLike = { signEvent: () => new Promise(() => undefined), nip44Encrypt: (p, t) => real.nip44Encrypt(p, t), nip44Decrypt: (p, t) => real.nip44Decrypt(p, t), getPublicKey: async () => real.pubkey() };
    const s = new Nip46Signer(silent, real.pubkey(), 20);
    await expect(s.signEvent({ kind: 1, created_at: 1, tags: [], content: '' })).rejects.toBeInstanceOf(TimeoutError);
    expect(await probeSigner(s)).toBe(true);
  });

  test('bookmarks: 39701 d tags as https, r tags of 10003 and 30003, the user’s own, each once', () => {
    const ev = (kind: number, tags: string[][], pubkey = PK) => ({ kind, tags, pubkey, content: '', created_at: 1, id: '', sig: '' }) as NostrEvent;
    expect(bookmarkLinks([
      ev(39701, [['d', 'example.com/a']]),
      ev(10003, [['r', 'https://example.com/b'], ['e', 'abc'], ['r', 'https://example.com/a']]),
      ev(30003, [['d', 'reading'], ['r', 'https://example.org/c'], ['r', 'not a url']]),
      ev(10003, [['r', 'https://someone.else/x']], 'ff'.repeat(32)),
    ], PK)).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.org/c']);
  });
});
