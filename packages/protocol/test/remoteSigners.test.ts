import {
  LocalSigner, Nip46Signer, Nip55Signer, TimeoutError, bookmarkLinks, failureOf, isSignerFailure, nip46Perms, nip55Permissions, probeSigner, readBunkerLink,
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

  test('a NIP-55 answer that is not the event asked for is refused, whatever the port checked (F46)', async () => {
    const real = new LocalSigner(nodeCrypto.randomBytes(32));
    let change: (e: NostrEvent) => NostrEvent = (e) => e;
    const port: Nip55Port = {
      signEvent: async (_pkg, json) => {
        const asked = JSON.parse(json);
        return JSON.stringify(change(await real.signEvent(asked)));
      },
      nip44Encrypt: async () => '', nip44Decrypt: async () => '', canActInBackground: async () => false, signInBackground: async () => false,
    };
    const s = new Nip55Signer(port, 'com.example.signer', real.pubkey());
    const asked = { kind: 30078, created_at: 5, tags: [['d', 'kefli/item/x']], content: 'mine' };
    await expect(s.signEvent(asked)).resolves.toMatchObject(asked);
    // another event, validly signed by the same key
    const other = await real.signEvent({ ...asked, content: 'theirs' });
    change = () => other;
    await expect(s.signEvent(asked)).rejects.toThrow('not the event asked for');
    await expect(s.outOfSight().signEvent(asked)).rejects.toThrow('not the event asked for');
    // the right event with a signature that doesn't verify
    change = (e) => ({ ...e, sig: e.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) });
    await expect(s.signEvent(asked)).rejects.toThrow('not the event asked for');
    // the verifier handed in is the one used
    const said: string[] = [];
    const checked = new Nip55Signer(port, 'pkg', real.pubkey(), 20, false, (sig) => (said.push(sig), true));
    change = (e) => e;
    await checked.withScreen().signEvent(asked);
    expect(said).toHaveLength(1);
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
      nip44Decrypt: async (_pkg, text, peer) => (asked.push('decrypt'), real.nip44Decrypt(peer, text)),
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
      // both directions, since sync and the inbox decrypt out of sight
      expect(asked).toEqual(['encrypt', 'decrypt']);
    });

    test('a signer out of sight never asks for the screen; withScreen does, and approving always does', async () => {
      const real = new LocalSigner(nodeCrypto.randomBytes(32));
      const screens: string[] = [];
      const port: Nip55Port = {
        signEvent: async (_pkg, json, _pk, screen) => (screens.push(`sign ${screen}`), JSON.stringify(await real.signEvent(JSON.parse(json)))),
        nip44Encrypt: async (_pkg, text, peer, _pk, screen) => (screens.push(`encrypt ${screen}`), real.nip44Encrypt(peer, text)),
        nip44Decrypt: async (_pkg, text, peer, _pk, screen) => (screens.push(`decrypt ${screen}`), real.nip44Decrypt(peer, text)),
        canActInBackground: async () => true,
        signInBackground: async () => false,
      };
      const quiet = new Nip55Signer(port, 'pkg', real.pubkey(), 20, false);
      await quiet.signEvent({ kind: 30078, created_at: 1, tags: [], content: '' });
      await quiet.nip44Decrypt(real.pubkey(), await quiet.nip44Encrypt(real.pubkey(), 'x'));
      await quiet.withScreen().signEvent({ kind: 5, created_at: 1, tags: [], content: '' });
      await quiet.approve([24242], () => undefined);
      await quiet.withScreen().outOfSight().signEvent({ kind: 5, created_at: 1, tags: [], content: '' });
      expect(screens).toEqual(['sign false', 'encrypt false', 'decrypt false', 'sign true', 'sign true', 'sign false']);
      expect(new Nip55Signer(port, 'pkg', real.pubkey()).screen).toBe(true); // a fresh signer, as at sign-in, may ask
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

  describe('a bunker’s answers', () => {
    const real = new LocalSigner(nodeCrypto.randomBytes(32));
    const bunker = (o: Partial<BunkerLike> = {}): BunkerLike => ({
      signEvent: (e) => real.signEvent(e), nip44Encrypt: (p, t) => real.nip44Encrypt(p, t), nip44Decrypt: (p, t) => real.nip44Decrypt(p, t),
      getPublicKey: async () => real.pubkey(), ...o,
    });
    const T = { kind: 30078, created_at: 5, tags: [['d', 'kefli/item/x']], content: 'c' };

    test('its refusal waits as the signer declining; its other errors stay answers (F14)', async () => {
      // BunkerSigner rejects with the NIP-46 answer's error string itself
      const says = (words: string) => new Nip46Signer(bunker({ nip44Decrypt: () => Promise.reject(words) }), real.pubkey(), 20);
      for (const words of ['User denied the request', 'rejected', 'Permission denied for nip44_decrypt', 'not authorized', 'Request cancelled'])
        await expect(says(words).nip44Decrypt(PK, 'x')).rejects.toMatchObject({ code: 'rejected' });
      const e = await says('invalid MAC').nip44Decrypt(PK, 'x').catch((x: unknown) => x);
      expect(isSignerFailure(e)).toBe(false);
      expect((e as Error).message).toBe('invalid MAC');
      expect(isSignerFailure(await says('user rejected').nip44Decrypt(PK, 'x').catch((x: unknown) => x))).toBe(true);
    });

    test('every relay of the bunker down, or the session closed, waits as unavailable', async () => {
      const down = new Nip46Signer(bunker({ signEvent: () => Promise.reject(new AggregateError([new Error('down')])) }), real.pubkey(), 20);
      await expect(down.signEvent(T)).rejects.toMatchObject({ code: 'unavailable' });
      const closed = new Nip46Signer(bunker({ nip44Encrypt: () => Promise.reject(new Error('this signer is not open anymore, create a new one')) }), real.pubkey(), 20);
      await expect(closed.nip44Encrypt(PK, 'x')).rejects.toMatchObject({ code: 'unavailable' });
    });

    test('a signed event is accepted only as asked, under the key, validly signed (F46)', async () => {
      const s = new Nip46Signer(bunker(), real.pubkey(), 20);
      expect((await s.signEvent(T)).tags).toEqual(T.tags);
      const other = (e: typeof T) => real.signEvent({ ...e, content: 'something else' });
      await expect(new Nip46Signer(bunker({ signEvent: other }), real.pubkey(), 20).signEvent(T)).rejects.toThrow('not the event asked for');
      const later = (e: typeof T) => real.signEvent({ ...e, created_at: e.created_at + 1 });
      await expect(new Nip46Signer(bunker({ signEvent: later }), real.pubkey(), 20).signEvent(T)).rejects.toThrow('not the event asked for');
      const forged = async (e: typeof T) => ({ ...(await real.signEvent(e)), sig: 'ab'.repeat(64) });
      await expect(new Nip46Signer(bunker({ signEvent: forged }), real.pubkey(), 20).signEvent(T)).rejects.toThrow('not the event asked for');
      // the verifier passed in is the one asked
      const asked: string[] = [];
      await new Nip46Signer(bunker(), real.pubkey(), 20, (sig) => (asked.push(sig), true)).signEvent(T);
      expect(asked).toHaveLength(1);
    });
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

  const ev = (tags: string[][]) => ({ kind: 10003, tags, pubkey: PK, content: '', created_at: 1, id: '', sig: '' }) as NostrEvent;

  test('bookmarks: only links normalise takes, and each save once, however its address is dressed', () => {
    expect(bookmarkLinks([ev([
      ['r', `https://${'a'.repeat(2000)}.example/x`], ['r', 'https://example.com/a?utm_source=feed'], ['r', 'https://example.com/a#top'],
      ['r', 'https://EXAMPLE.com/a/'], ['r', 'https://example.com/b'],
    ])], PK)).toEqual(['https://example.com/a?utm_source=feed', 'https://example.com/b']);
  });

  test("bookmarks on the phone's URL, which takes hosts normalise refuses", () => {
    const real = globalThis.URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    globalThis.URL = require('whatwg-url-minimum').URL;
    try {
      expect(bookmarkLinks([ev([['r', 'https://a‍b.example/'], ['r', 'https://aאb.example/'], ['r', 'https://example.org/c']])], PK)).toEqual(['https://example.org/c']);
    } finally {
      globalThis.URL = real;
    }
  });

  test('bookmarks: 20,000 links in a few seconds at most, each found in a set rather than a list', () => {
    const tags = Array.from({ length: 20_000 }, (_, i) => ['r', `https://example.com/page/${i}`]);
    const t = Date.now();
    expect(bookmarkLinks([ev(tags)], PK)).toHaveLength(20_000);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
});
