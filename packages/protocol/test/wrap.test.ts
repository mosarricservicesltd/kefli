import { verifyEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  acceptPairAck, EventTooLargeError, LocalSigner, UnwrapError, WRAP_BACKDATE_MAX, acceptSaveRequest, browserSavedAt,
  buildDevicesEvent, checkOffer, derivePairCode, giftWrap, mergeDevices, newPairCode, openOffer, readDevicesEvent,
  readPairCode, sealOffer, unwrap, wrapPairAck, wrapSaveRequest,
} from '../src';
import type { DevicesRecord, PairOffer, SaveRequest } from '../src';
import { nodeCrypto } from '../src/node';

const signer = () => new LocalSigner(nodeCrypto.randomBytes(32));
const NOW = 1_760_000_000;
const RELAY = 'wss://relay.kefli.example';
const BLOSSOM = 'https://blossom.kefli.example';

const request = (over: Partial<SaveRequest> = {}): SaveRequest => ({
  v: 1, url: 'https://example.com/a', canonical: null, title: 'A', site: 'example.com', byline: null, lang: 'en',
  hero: null, captured_at: NOW, token: 'aa'.repeat(32),
  html: { sha256: 'bb'.repeat(32), key: 'k', nonce: 'n', server: 'https://blossom.kefli.example' }, ...over,
});

describe('gift wraps (NIP-59, C§4.4)', () => {
  test('wrap and unwrap through Signer', async () => {
    const [device, user] = [signer(), signer()];
    const { wrap, wrapPubkey } = await wrapSaveRequest(device, user.pubkey(), 'u-1', request(), NOW, { now: NOW });
    expect(verifyEvent(wrap)).toBe(true);
    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).toBe(wrapPubkey);
    expect(wrap.tags).toEqual([['p', user.pubkey()]]);
    expect(wrap.created_at).toBeLessThanOrEqual(NOW);
    expect(wrap.created_at).toBeGreaterThan(NOW - WRAP_BACKDATE_MAX);
    const { rumor, seal } = await unwrap(user, wrap);
    expect(seal.pubkey).toBe(device.pubkey());
    expect(rumor.tags).toEqual([['d', 'kefli/save-request/u-1']]);
    expect(JSON.parse(rumor.content)).toEqual(request());
  });

  test('only the recipient can open it', async () => {
    const [device, user, other] = [signer(), signer(), signer()];
    const { wrap } = await wrapSaveRequest(device, user.pubkey(), 'u', request(), NOW);
    await expect(unwrap(other, wrap)).rejects.toThrow(UnwrapError);
  });

  test('a tampered wrap is refused', async () => {
    const [device, user] = [signer(), signer()];
    const { wrap } = await wrapSaveRequest(device, user.pubkey(), 'u', request(), NOW);
    await expect(unwrap(user, { ...wrap, content: wrap.content.slice(0, -4) + 'AAAA' })).rejects.toThrow(UnwrapError);
  });

  test('a rumor claiming another author is refused', async () => {
    const [device, user, impostor] = [signer(), signer(), signer()];
    // The seal is the device's, but the rumor inside says the impostor wrote it.
    const forged = await giftWrap(device, user.pubkey(), { kind: 30078, created_at: NOW, tags: [], content: '{}' });
    const seal = await unwrap(user, forged.wrap).then((r) => r.seal);
    const badRumor = { ...forged.rumor, pubkey: impostor.pubkey() };
    const badSeal = await device.signEvent({ kind: 13, created_at: seal.created_at, tags: [], content: await device.nip44Encrypt(user.pubkey(), JSON.stringify(badRumor)) });
    // Wrap the bad seal by hand, as an attacker would.
    const { finalizeEvent, generateSecretKey } = await import('nostr-tools/pure');
    const { v2 } = await import('nostr-tools/nip44');
    const k = generateSecretKey();
    const wrap = finalizeEvent({ kind: 1059, created_at: NOW, tags: [['p', user.pubkey()]], content: v2.encrypt(JSON.stringify(badSeal), v2.utils.getConversationKey(k, user.pubkey())) }, k);
    await expect(unwrap(user, wrap)).rejects.toThrow('rumor author');
  });

  test('a save request over 8 KB is refused', async () => {
    const [device, user] = [signer(), signer()];
    await expect(wrapSaveRequest(device, user.pubkey(), 'u', request({ title: 'x'.repeat(4000) }), NOW)).rejects.toThrow(EventTooLargeError);
  });

  test('pair-ack wraps to the device, sealed by the user', async () => {
    const [user, device] = [signer(), signer()];
    const ack = { v: 1 as const, user_pubkey: user.pubkey(), write_relays: [RELAY], blossom_servers: ['https://b'], token: 'cc'.repeat(32), nonce: 'n1' };
    const { wrap } = await wrapPairAck(user, device.pubkey(), ack, NOW);
    const { rumor, seal } = await unwrap(device, wrap);
    expect(seal.pubkey).toBe(user.pubkey());
    expect(rumor.tags).toEqual([['d', 'kefli/pair-ack']]);
    expect(JSON.parse(rumor.content)).toEqual(ack);
  });
});

describe('accepting a save request (C§4.4)', () => {
  const setup = async () => {
    const [device, user] = [signer(), signer()];
    const devices: DevicesRecord = { v: 1, devices: [{ device_pubkey: device.pubkey(), label: 'Chrome on a laptop', token: 'aa'.repeat(32), connected_at: NOW - 10, revoked_at: null }] };
    return { device, user, devices };
  };

  test('accepted from a connected browser', async () => {
    const { device, user, devices } = await setup();
    const { rumor, seal } = await unwrap(user, (await wrapSaveRequest(device, user.pubkey(), 'u', request(), NOW)).wrap);
    const v = acceptSaveRequest(rumor, seal, devices, BLOSSOM);
    expect(v.ok && v.request.url).toBe('https://example.com/a');
  });

  test('refused for a revoked or unknown token, the wrong device, or a newer version', async () => {
    const { device, user, devices } = await setup();
    const open = async (dev: LocalSigner, r: SaveRequest) => unwrap(user, (await wrapSaveRequest(dev, user.pubkey(), 'u', r, NOW)).wrap);
    let o = await open(device, request());
    const revoked = { v: 1 as const, devices: devices.devices.map((e) => ({ ...e, revoked_at: NOW })) };
    expect(acceptSaveRequest(o.rumor, o.seal, revoked, BLOSSOM)).toEqual({ ok: false, reason: 'token' });
    o = await open(device, request({ token: 'dd'.repeat(32) }));
    expect(acceptSaveRequest(o.rumor, o.seal, devices, BLOSSOM)).toEqual({ ok: false, reason: 'token' });
    o = await open(signer(), request());
    expect(acceptSaveRequest(o.rumor, o.seal, devices, BLOSSOM)).toEqual({ ok: false, reason: 'device' });
    o = await open(device, { ...request(), v: 2 } as unknown as SaveRequest);
    expect(acceptSaveRequest(o.rumor, o.seal, devices, BLOSSOM)).toEqual({ ok: false, reason: 'version' });
  });

  test('refused when the HTML is on another server; accepted with no HTML', async () => {
    const { device, user, devices } = await setup();
    const open = async (r: SaveRequest) => unwrap(user, (await wrapSaveRequest(device, user.pubkey(), 'u', r, NOW)).wrap);
    let o = await open(request({ html: { sha256: 'bb'.repeat(32), key: 'k', nonce: 'n', server: 'https://evil.example' } }));
    expect(acceptSaveRequest(o.rumor, o.seal, devices, BLOSSOM)).toEqual({ ok: false, reason: 'server' });
    o = await open(request({ html: null }));
    expect(acceptSaveRequest(o.rumor, o.seal, devices, BLOSSOM).ok).toBe(true);
  });

  test('another app’s message is left alone', async () => {
    const { device, user, devices } = await setup();
    const { wrap } = await giftWrap(device, user.pubkey(), { kind: 14, created_at: NOW, tags: [], content: 'hi' });
    const { rumor, seal } = await unwrap(user, wrap);
    expect(acceptSaveRequest(rumor, seal, devices, BLOSSOM)).toEqual({ ok: false, reason: 'other' });
  });

  test('saved_at is captured_at, never later than now', () => {
    expect(browserSavedAt(NOW - 5, NOW)).toBe(NOW - 5);
    expect(browserSavedAt(NOW + 500, NOW)).toBe(NOW);
  });
});

describe('typed pair code (C§4.4)', () => {
  // The reference lookup under v1.5's salt, from Node's scrypt. Under v1.4's salt the Android test build recorded
  // 8a0b73e6…, which this derivation also reproduces with that salt.
  test('K7QM4XPD gives the reference lookup', async () => {
    const { lookup, key } = await derivePairCode('K7QM4XPD', nodeCrypto);
    expect(lookup).toBe('2ca73b673edb4f51cfdb460599a6411f580992cf1fbe823f2e49a74b8e25695e');
    expect(key).toHaveLength(32);
  });

  test('read leniently', () => {
    expect(readPairCode('k7qm-4xpd')).toBe('K7QM4XPD');
    expect(readPairCode(' K7QM 4XPD ')).toBe('K7QM4XPD');
    expect(readPairCode('OIL0-0000')).toBe('01100000');
    expect(readPairCode('K7QM4XP')).toBeNull();
    expect(readPairCode('K7QM4XPU')).toBeNull(); // U is not in the alphabet
  });

  test('new codes are eight valid characters', () => {
    for (let i = 0; i < 50; i++) expect(readPairCode(newPairCode(nodeCrypto))).not.toBeNull();
  });

  test('an offer round trips, and the wrong code gives null', async () => {
    const offer: PairOffer = { v: 1, device_pubkey: signer().pubkey(), relay: RELAY, nonce: 'n', expires: NOW + 300, label: 'Firefox on a Mac' };
    const { key } = await derivePairCode('K7QM4XPD', nodeCrypto);
    const sealed = await sealOffer(offer, key, nodeCrypto);
    expect(await openOffer(sealed, key, nodeCrypto)).toEqual(offer);
    const other = await derivePairCode('K7QM4XPE', nodeCrypto);
    expect(await openOffer(sealed, other.key, nodeCrypto)).toBeNull();
  });
});

describe('offer checks (C§4.4)', () => {
  const good = (): PairOffer => ({ v: 1, device_pubkey: signer().pubkey(), relay: RELAY, nonce: 'n', expires: NOW + 300, label: 'Chrome on a Windows laptop' });
  test.each([
    ['valid', {}, null],
    ['within the skew', { expires: NOW - 60 }, null],
    ['expired', { expires: NOW - 61 }, 'expired'],
    ['wrong version', { v: 2 }, 'version'],
    ['not a point', { device_pubkey: 'ff'.repeat(32) }, 'device_pubkey'],
    ['upper-case hex', { device_pubkey: 'AB'.repeat(32) }, 'device_pubkey'],
    ['label too long', { label: 'x'.repeat(64) }, 'label'],
    ['label with a newline', { label: 'a\nb' }, 'label'],
    ['another relay', { relay: 'wss://evil.example' }, 'relay'],
    ['no nonce', { nonce: '' }, 'nonce'],
  ] as const)('%s', (_n, over, want) => {
    expect(checkOffer({ ...good(), ...over } as PairOffer, RELAY, NOW)).toBe(want);
  });
});

describe('connected-browsers record (C§4.9)', () => {
  const e = (token: string, revoked_at: number | null = null, connected_at = 1) => ({ device_pubkey: 'p', label: 'l', token, connected_at, revoked_at });

  test('merge keeps every entry and the earlier revocation', () => {
    const a: DevicesRecord = { v: 1, devices: [e('t1'), e('t2', 50), e('t3', null, 3)] };
    const b: DevicesRecord = { v: 1, devices: [e('t1', 70), e('t2', 40), e('t4', null, 0)] };
    const m = mergeDevices(a, b);
    expect(m.devices.map((x) => [x.token, x.revoked_at])).toEqual([['t4', null], ['t1', 70], ['t2', 40], ['t3', null]]);
    expect(mergeDevices(b, a)).toEqual(m);
    expect(mergeDevices(m, m)).toEqual(m);
  });

  test('round trips, and revoked entries go earliest first only past the ceiling', async () => {
    const s = signer();
    const small: DevicesRecord = { v: 1, devices: [e('t1', 5), e('t2')] };
    expect(await readDevicesEvent(s, await buildDevicesEvent(s, small, NOW))).toEqual(small);
    const big: DevicesRecord = { v: 1, devices: Array.from({ length: 120 }, (_, i) => ({ ...e(bytesToHex(nodeCrypto.randomBytes(32)), i < 100 ? 1000 - i : null), label: 'x'.repeat(40) })) };
    const back = await readDevicesEvent(s, await buildDevicesEvent(s, big, NOW));
    expect(back.devices.length).toBeLessThan(120);
    expect(back.devices.filter((x) => x.revoked_at === null)).toHaveLength(20);
    const kept = back.devices.filter((x) => x.revoked_at !== null).map((x) => x.revoked_at!);
    const dropped = big.devices.filter((x) => x.revoked_at !== null && !kept.includes(x.revoked_at)).map((x) => x.revoked_at!);
    expect(Math.max(...dropped)).toBeLessThan(Math.min(...kept));
  });
});

describe('accepting a pair-ack (C§4.4, C§4.8)', () => {
  const ack = (user: LocalSigner, over: Record<string, unknown> = {}) => ({
    v: 1 as const, user_pubkey: user.pubkey(), write_relays: [RELAY], blossom_servers: [BLOSSOM], token: 'cc'.repeat(32), nonce: 'n1', ...over,
  });
  const open = async (sealer: LocalSigner, device: LocalSigner, body: object) =>
    unwrap(device, (await wrapPairAck(sealer, device.pubkey(), body as never, NOW)).wrap);

  test('a first pairing needs the offer’s nonce and the named user’s seal', async () => {
    const [user, device, other] = [signer(), signer(), signer()];
    let o = await open(user, device, ack(user));
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: 'n1', pairedUser: null })).toMatchObject({ ok: true, move: false });
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: 'n2', pairedUser: null })).toEqual({ ok: false, reason: 'nonce' });
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: null, pairedUser: null })).toEqual({ ok: false, reason: 'nonce' });
    o = await open(other, device, ack(user));
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: 'n1', pairedUser: null })).toEqual({ ok: false, reason: 'signer' });
  });

  test('once paired, only a move sealed by the current user is taken', async () => {
    const [current, next, device, other] = [signer(), signer(), signer(), signer()];
    const move = ack(next, { nonce: undefined, moved_from: current.pubkey() });
    let o = await open(current, device, move);
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: null, pairedUser: current.pubkey() })).toMatchObject({ ok: true, move: true });
    o = await open(other, device, move);
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: null, pairedUser: current.pubkey() })).toEqual({ ok: false, reason: 'signer' });
    o = await open(next, device, ack(next));
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: 'n1', pairedUser: current.pubkey() })).toEqual({ ok: false, reason: 'ignored' });
  });

  test('a malformed ack is refused', async () => {
    const [user, device] = [signer(), signer()];
    const o = await open(user, device, ack(user, { token: 'short' }));
    expect(acceptPairAck(o.rumor, o.seal, { offerNonce: 'n1', pairedUser: null })).toEqual({ ok: false, reason: 'version' });
  });
});

test('the save request limit is strict: a wrap exactly at it is refused', async () => {
  const [device, user] = [signer(), signer()];
  const { wrap } = await wrapSaveRequest(device, user.pubkey(), 'u', request(), NOW, { maxBytes: 1e9 });
  const bytes = Buffer.byteLength(JSON.stringify(wrap));
  await expect(wrapSaveRequest(device, user.pubkey(), 'u', request(), NOW, { maxBytes: bytes })).rejects.toThrow(EventTooLargeError);
  await expect(wrapSaveRequest(device, user.pubkey(), 'u', request(), NOW, { maxBytes: bytes + 1 })).resolves.toBeDefined();
});
