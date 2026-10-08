import { LocalSigner, derivePhonePair, newMnemonic, newPhonePair, openPhoneOffer, readPhoneQr, readSix, sealPhoneOffer, secretKeyFromMnemonic } from '../src';
import { nodeCrypto } from '../src/node';
import { hkdfSync } from 'node:crypto';

describe('second-phone pairing (contract 2)', () => {
  test('the derivation is HKDF-SHA256 with the contract salt and the digits as info', () => {
    const secret = 'ab'.repeat(32);
    const ref = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'hex'), 'shelf/phone-pair/v1', '482913', 64));
    const { lookup, key } = derivePhonePair(secret, '482913');
    expect(lookup).toBe(ref.subarray(0, 32).toString('hex'));
    expect(Buffer.from(key).toString('hex')).toBe(ref.subarray(32).toString('hex'));
    expect(derivePhonePair(secret, '482914').lookup).not.toBe(lookup);
  });

  test('an offer round trips; the wrong digits or a tampered offer give nothing', async () => {
    const words = newMnemonic(nodeCrypto);
    const pk = new LocalSigner(await secretKeyFromMnemonic(words, nodeCrypto)).pubkey();
    const { qr, six } = newPhonePair(nodeCrypto, pk, 1000);
    expect(six).toMatch(/^\d{6}$/);
    expect(qr).toMatchObject({ v: 1, pubkey: pk, expires: 1300 });
    const sealed = await sealPhoneOffer(words, derivePhonePair(qr.secret, six).key, nodeCrypto);
    expect(await openPhoneOffer(sealed, derivePhonePair(qr.secret, six).key, nodeCrypto)).toBe(words);
    const other = six === '000000' ? '000001' : '000000';
    expect(await openPhoneOffer(sealed, derivePhonePair(qr.secret, other).key, nodeCrypto)).toBeNull();
    expect(await openPhoneOffer('nonsense', derivePhonePair(qr.secret, six).key, nodeCrypto)).toBeNull();
  });

  test('the QR is checked as the contract says, and the digits read leniently', () => {
    const pk = new LocalSigner(nodeCrypto.randomBytes(32)).pubkey();
    const qr = { v: 1, pubkey: pk, secret: 'cd'.repeat(32), expires: 1000 };
    expect(readPhoneQr(JSON.stringify(qr), 1000)).toEqual(qr);
    expect(readPhoneQr(JSON.stringify(qr), 1059)).toEqual(qr);
    expect(readPhoneQr(JSON.stringify(qr), 1061)).toBe('expired');
    expect(readPhoneQr(JSON.stringify({ ...qr, v: 2 }), 0)).toBe('invalid');
    expect(readPhoneQr(JSON.stringify({ ...qr, secret: 'xyz' }), 0)).toBe('invalid');
    expect(readPhoneQr('https://example.com', 0)).toBe('invalid');
    expect(readSix('482 913')).toBe('482913');
    expect(readSix('48291')).toBeNull();
    expect(readSix('48291a')).toBeNull();
  });

  test('the six digits spread over the whole range', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newPhonePair(nodeCrypto, 'ab'.repeat(32), 0).six[0]);
    expect(seen.size).toBe(10);
  });
});
