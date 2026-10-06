import { verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EventTooLargeError, KIND, LocalSigner, MAX_EVENT_BYTES, buildItemEvent, cleanMnemonic, decryptText,
  encryptText, newMnemonic, normaliseMarkdown, parseItem, readItemEvent, secretKeyFromMnemonic, signedSize, textHash,
} from '../src';
import { nodeCrypto } from '../src/node';

// NIP-06's own example.
const NIP06 = {
  mnemonic: 'leader monkey parrot ring guide accident before fence cannon height naive bean',
  sk: '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a',
  pk: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917',
};

describe('keys (C§2)', () => {
  test('the NIP-06 example derives its key', async () => {
    const sk = await secretKeyFromMnemonic(NIP06.mnemonic, nodeCrypto);
    expect(bytesToHex(sk)).toBe(NIP06.sk);
    expect(new LocalSigner(sk).pubkey()).toBe(NIP06.pk);
  });

  test('agrees with nostr-tools nip06 on fresh mnemonics', async () => {
    for (let i = 0; i < 3; i++) {
      const m = newMnemonic(nodeCrypto);
      expect(m.split(' ')).toHaveLength(12);
      expect(bytesToHex(await secretKeyFromMnemonic(m, nodeCrypto))).toBe(bytesToHex(privateKeyFromSeedWords(m)));
    }
  });

  test('typed words are cleaned, and bad ones refused', () => {
    expect(cleanMnemonic(`  ${NIP06.mnemonic.toUpperCase().replace(/ /g, '   ')}\n`)).toBe(NIP06.mnemonic);
    expect(cleanMnemonic(NIP06.mnemonic.replace('bean', 'beans'))).toBeNull();
    expect(cleanMnemonic(NIP06.mnemonic.replace('bean', 'leader'))).toBeNull(); // checksum
  });
});

describe('NIP-44 through LocalSigner', () => {
  // NIP-44's own v2 vectors (test/vectors/README.md).
  const vectors: { sec1: string; sec2: string; conversation_key: string; nonce: string; plaintext: string; payload: string }[] =
    JSON.parse(readFileSync(join(__dirname, 'vectors/nip44.vectors.json'), 'utf8')).v2.valid.encrypt_decrypt;

  test.each(vectors.map((v, i) => [i, v] as const))('official vector %i', async (_i, v) => {
    const one = new LocalSigner(hexToBytes(v.sec1));
    const two = new LocalSigner(hexToBytes(v.sec2));
    expect(bytesToHex(nip44.utils.getConversationKey(hexToBytes(v.sec1), two.pubkey()))).toBe(v.conversation_key);
    expect(nip44.encrypt(v.plaintext, hexToBytes(v.conversation_key), hexToBytes(v.nonce))).toBe(v.payload);
    expect(await two.nip44Decrypt(one.pubkey(), v.payload)).toBe(v.plaintext);
    expect(await one.nip44Decrypt(two.pubkey(), v.payload)).toBe(v.plaintext);
  });

  test('self-encryption round trips, and a zeroed signer refuses', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    const c = await s.nip44Encrypt(s.pubkey(), 'shelf-probe');
    expect(await s.nip44Decrypt(s.pubkey(), c)).toBe('shelf-probe');
    s.zero();
    await expect(s.nip44Decrypt(s.pubkey(), c)).rejects.toThrow('zeroed');
  });
});

describe('article text (C§4.2)', () => {
  test('normalised Markdown', () => {
    expect(normaliseMarkdown('# T\r\n\r\n\r\n\r\nPara  \t\nnext\n\n\n')).toBe('# T\n\nPara\nnext\n');
    expect(normaliseMarkdown('café')).toBe('café\n'); // NFC
    expect(normaliseMarkdown('a\n   \n\n\nb')).toBe('a\n\nb\n'); // a blank line of spaces joins the run
    expect(normaliseMarkdown('')).toBe('\n');
    // Only LF ends a line: spaces before a lone CR, U+2028 or U+2029 stay.
    expect(normaliseMarkdown('a \u2028b \rc')).toBe('a \u2028b \rc\n');
    const once = normaliseMarkdown(' x \r\n\r\n\r\ny ');
    expect(normaliseMarkdown(once)).toBe(once);
  });

  test('text_hash is the SHA-256 of the UTF-8', () => {
    const md = normaliseMarkdown('# Café\n');
    expect(textHash(md, nodeCrypto)).toBe(createHash('sha256').update(md, 'utf8').digest('hex'));
  });

  test('blob round trip, and tampering refused', async () => {
    const md = normaliseMarkdown('# Title\n\nSome text, with ünïcode.');
    const { blob, text } = await encryptText(md, nodeCrypto);
    expect(blob.length).toBe(utf8ToBytes(md).length + 16);
    expect(await decryptText(blob, text, nodeCrypto)).toBe(md);
    const bad = blob.slice();
    bad[0] ^= 1;
    await expect(decryptText(bad, text, nodeCrypto)).rejects.toThrow('sha256');
    await expect(decryptText(bad, { ...text, sha256: bytesToHex(nodeCrypto.sha256(bad)) }, nodeCrypto)).rejects.toThrow();
  });
});

const item = (over: Record<string, unknown> = {}) => parseItem(JSON.stringify({
  v: 1, url: 'https://example.com/a', canonical: null, title: 'A', site: 'example.com', byline: null,
  saved_at: 1757000000, state: 'unread', progress: 0, words: 10, lang: 'en', text: null, text_hash: null,
  hero: null, source_kind: 'web', audio_pref: null, ...over,
}));
const HASH = 'ab'.repeat(32);

describe('save events (C§4.1, C§3.3)', () => {
  test('a save verifies, carries exactly its two tags and reads back', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    const { event, overTarget } = await buildItemEvent(s, HASH, item(), 1757000001);
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(KIND.appData);
    expect(event.tags).toEqual([['d', `shelf/item/${HASH}`], ['t', 'shelf']]);
    expect(overTarget).toBe(false);
    const back = await readItemEvent(s, event);
    expect(back.hash).toBe(HASH);
    expect(back.item.item.url).toBe('https://example.com/a');
  });

  test('signedSize is exact', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    const { event } = await buildItemEvent(s, HASH, item({ title: 'Ünïcode títle' }), 1);
    const { id, pubkey, sig, ...template } = event;
    expect(signedSize(template)).toBe(utf8ToBytes(JSON.stringify(event)).length);
  });

  test('an item past 16 KB is refused before signing', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    const sign = jest.spyOn(s, 'signEvent');
    await expect(buildItemEvent(s, HASH, item({ later: 'x'.repeat(12_000) }), 1)).rejects.toThrow(EventTooLargeError);
    expect(sign).not.toHaveBeenCalled();
  });

  test('a 12 KB URL is refused on its own too', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    const url = `https://example.com/${'a'.repeat(12_000)}`;
    await expect(buildItemEvent(s, HASH, item({ url, canonical: url }), 1)).rejects.toThrow(EventTooLargeError);
  });

  test('over 4 KB is published with a warning', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    const built = await buildItemEvent(s, HASH, item({ later: 'x'.repeat(4_000) }), 1);
    expect(built.overTarget).toBe(true);
    expect(signedSize({ ...built.event })).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  });

  test('another identity’s event or a non-save is refused', async () => {
    const a = new LocalSigner(nodeCrypto.randomBytes(32));
    const b = new LocalSigner(nodeCrypto.randomBytes(32));
    const { event } = await buildItemEvent(a, HASH, item(), 1);
    await expect(readItemEvent(b, event)).rejects.toThrow('identity');
    const devices = await a.signEvent({ kind: 30078, created_at: 1, tags: [['d', 'shelf/devices']], content: '' });
    await expect(readItemEvent(a, devices)).rejects.toThrow('not a save');
  });
});
