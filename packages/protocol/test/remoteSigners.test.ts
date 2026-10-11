import {
  LocalSigner, Nip46Signer, Nip55Signer, TimeoutError, bookmarkLinks, failureOf, nip46Perms, nip55Permissions, probeSigner, readBunkerLink,
  type BunkerLike, type Nip55Port, type NostrEvent,
  BACKGROUND_KINDS, probeEvent,
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
      signInBackground: async () => false,
    };
    const s = new Nip55Signer(port, 'com.example.signer', real.pubkey());
    expect((await s.signEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' })).pubkey).toBe(real.pubkey());
    expect(await probeSigner(s)).toBe(true);
    expect(await s.canActInBackground()).toBe(false);
    signWith = other;
    await expect(s.signEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' })).rejects.toThrow('another key');
  });

  test('an unanswered NIP-55 request fails after its wait, so the outbox can retry', async () => {
    const never: Nip55Port = { signEvent: () => new Promise(() => undefined), nip44Encrypt: () => new Promise(() => undefined), nip44Decrypt: () => new Promise(() => undefined), canActInBackground: async () => false, signInBackground: async () => false };
    const s = new Nip55Signer(never, 'com.example.signer', PK, 20);
    await expect(s.signEvent({ kind: 24242, created_at: 1, tags: [], content: '' })).rejects.toBeInstanceOf(TimeoutError);
    await expect(s.nip44Encrypt(PK, 'x')).rejects.toBeInstanceOf(TimeoutError);
  });

  describe('saving without asking (decision 104)', () => {
    // Amber's 'Approve basic actions': its own list, which has the save, deletions, the relay list and both sign-ins,
    // but not the backup uploads, the server list or the seal
    const BASIC = new Set([30078, 5, 10002, 22242, 27235]);
    const amberBasic = (approved: Set<number>, real: LocalSigner, asked: string[]): Nip55Port => ({
      signEvent: async (_pkg, json) => {
        const e = JSON.parse(json);
        asked.push(`sign ${e.kind}`);
        approved.add(e.kind);
        return JSON.stringify(await real.signEvent(e));
      },
      nip44Encrypt: async (_pkg, text, peer) => (asked.push('encrypt'), real.nip44Encrypt(peer, text)),
      nip44Decrypt: async (_pkg, text, peer) => real.nip44Decrypt(peer, text),
      canActInBackground: async () => true,
      signInBackground: async (_pkg, json) => approved.has(JSON.parse(json).kind),
    });

    test('the check finds what a basic policy leaves out, in order', async () => {
      const real = new LocalSigner(nodeCrypto.randomBytes(32));
      const s = new Nip55Signer(amberBasic(new Set(BASIC), real, []), 'com.greenart7c3.nostrsigner', real.pubkey());
      expect(await s.missingInBackground()).toEqual([13, 10063, 24242]);
    });

    test('approving asks for each, one after another, and the check then passes', async () => {
      const real = new LocalSigner(nodeCrypto.randomBytes(32));
      const asked: string[] = [];
      const steps: number[] = [];
      const s = new Nip55Signer(amberBasic(new Set(BASIC), real, asked), 'com.greenart7c3.nostrsigner', real.pubkey());
      await s.approve(await s.missingInBackground(), (n) => steps.push(n));
      expect({ asked, steps }).toEqual({ asked: ['sign 13', 'sign 10063', 'sign 24242'], steps: [1, 2, 3] });
      expect(await s.missingInBackground()).toEqual([]);
    });

    test('encryption missing is asked for too, and a refusal stops the asking', async () => {
      const real = new LocalSigner(nodeCrypto.randomBytes(32));
      const asked: string[] = [];
      const port = { ...amberBasic(new Set(BASIC), real, asked), canActInBackground: async () => false };
      port.signEvent = async () => { throw new Error('rejected'); };
      const s = new Nip55Signer(port, 'pkg', real.pubkey());
      const missing = await s.missingInBackground();
      expect(missing).toEqual(['nip44', 13, 10063, 24242]);
      await expect(s.approve(missing, () => undefined)).rejects.toThrow('rejected');
      expect(asked).toEqual(['encrypt']);
    });

    test('the probe events are throwaways that never replace a real one', () => {
      for (const kind of BACKGROUND_KINDS) {
        const e = probeEvent(kind);
        expect({ created_at: e.created_at, content: e.content }).toEqual({ created_at: 1, content: '' });
      }
      expect(probeEvent(30078).tags).toEqual([['d', 'kefli/probe']]);
    });
  });

  test('a failure reads as unanswered for a timeout, NIP-55 or NIP-46, and as declined otherwise', () => {
    expect(failureOf(new TimeoutError())).toBe('timeout');
    expect(failureOf({ code: 'timeout' })).toBe('timeout');
    expect(failureOf(new Error('user rejected'))).toBe('declined');
    expect(failureOf(null)).toBe('declined');
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
