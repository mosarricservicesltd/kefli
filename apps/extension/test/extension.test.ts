// The extension's modules against the protocol's own code: a user key plays the phone, fakes play the network.
import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import { itemHash } from '../../../packages/protocol/src/normalise';
import { acceptSaveRequest, derivePairCode, openOffer, wrapPairAck, type PairAck, type SaveRequest } from '../../../packages/protocol/src/pairing';
import { LocalSigner, type NostrEvent } from '../../../packages/protocol/src/signer';
import { decryptText } from '../../../packages/protocol/src/text';
import { unwrap } from '../../../packages/protocol/src/wrap';
import { GUARD_WORDS, HTML_MAX_BYTES, keepHtml, linkOnly, pageUrl, type Captured } from '../src/captured';
import { webCrypto } from '../src/crypto';
import { loadDefaults, type Defaults } from '../src/defaults';
import { deviceSigner } from '../src/device';
import { ackFor, browserLabel, formatCode, OFFER_LIFE, pairingFrom, postOffer } from '../src/pair';
import { ATTEMPTS_MAX, BLOB_KEEP_MAX, dequeue, enqueue, failed, flush, QUEUE_MAX, queued, waiting, whyNot } from '../src/queue';
import { deliver, prepare, retract, type Net, type Pending } from '../src/save';
import { KEYS, memoryStore, type Pairing } from '../src/store';
import { toastCopy } from '../src/toastCopy';
import { markDelay } from '../src/toast';

const DEFAULTS: Defaults = { v: 1, operator: { relay: 'wss://relay.example', blossom: 'https://blossom.example', api: 'https://api.example' }, relays: ['wss://a.example'], mirrors: ['https://m.example'] };
const NOW = 1_791_600_000;
const user = new LocalSigner(hexToBytes('11'.repeat(32)));
const device = new LocalSigner(hexToBytes('22'.repeat(32)));
const PAIRING: Pairing = { v: 1, user_pubkey: user.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: ['https://blossom.example'], token: 'ab'.repeat(32), label: 'Chrome on a Mac', paired_at: NOW };

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

describe('the browser label (contract 4.4)', () => {
  test.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36', [], 'Chrome on a Mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0', [], 'Edge on a Windows PC'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', [], 'Firefox on a Linux PC'],
    ['Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0', ['Brave', 'Chromium'], 'Brave on a Linux PC'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/141.0', [], 'Chrome on a Chromebook'],
    ['Something else', [], 'This browser on a computer'],
  ])('%s', (ua, brands, label) => {
    expect(browserLabel(ua, brands)).toBe(label);
    expect(label.length).toBeLessThan(64);
  });
});

describe('pairing (contract 4.4)', () => {
  test('the offer is posted sealed under its typed code, signed by the device key', async () => {
    let posted: { url: string; init: RequestInit } | null = null;
    const get = (async (url: string, init: RequestInit) => ((posted = { url, init }), json({ v: 1 }))) as unknown as typeof fetch;
    const o = await postOffer(device, DEFAULTS, 'Chrome on a Mac', webCrypto, NOW, get);
    expect(o.offer).toMatchObject({ v: 1, device_pubkey: device.pubkey(), relay: DEFAULTS.operator.relay, expires: NOW + OFFER_LIFE, label: 'Chrome on a Mac' });
    expect(JSON.parse(o.qr)).toEqual(o.offer);
    expect(o.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(formatCode(o.code)).toBe(`${o.code.slice(0, 4)}-${o.code.slice(4)}`);
    expect(posted!.url).toBe('https://api.example/pair-offers');
    expect(String((posted!.init.headers as Record<string, string>).Authorization)).toMatch(/^Nostr /);
    const body = JSON.parse(String(posted!.init.body));
    const { lookup, key } = await derivePairCode(o.code, webCrypto);
    expect(body.lookup).toBe(lookup);
    expect(await openOffer(body.offer, key, webCrypto)).toEqual(o.offer);
  });

  test('an operator that refuses the offer is an error the page shows as offline', async () => {
    const get = (async () => json({}, false)) as unknown as typeof fetch;
    await expect(postOffer(device, DEFAULTS, 'x', webCrypto, NOW, get)).rejects.toThrow('500');
  });

  test("only this offer's pair-ack is accepted, and it becomes the pairing record", async () => {
    const ack: PairAck = { v: 1, user_pubkey: user.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: ['https://blossom.example'], token: 'cd'.repeat(32), nonce: 'n1' };
    const { wrap } = await wrapPairAck(user, device.pubkey(), ack, NOW);
    expect(await ackFor(device, wrap, 'n1')).toEqual(ack);
    expect(await ackFor(device, wrap, 'other')).toBeNull();
    expect(await ackFor(user, wrap, 'n1')).toBeNull();
    expect(pairingFrom(ack, 'Chrome on a Mac', NOW)).toEqual({ v: 1, user_pubkey: user.pubkey(), write_relays: ack.write_relays, blossom_servers: ack.blossom_servers, token: ack.token, label: 'Chrome on a Mac', paired_at: NOW });
  });

  test('the device key is made once and kept', async () => {
    const store = memoryStore();
    const a = await deviceSigner(store, webCrypto);
    const b = await deviceSigner(store, webCrypto);
    expect(a.pubkey()).toBe(b.pubkey());
    expect(store.data.get(KEYS.device)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('defaults.json', () => {
  test('the fresh copy is kept, and stands in when the operator is out of reach', async () => {
    const store = memoryStore();
    expect(await loadDefaults(store, 'u', (async () => json(DEFAULTS)) as unknown as typeof fetch)).toEqual(DEFAULTS);
    expect(await loadDefaults(store, 'u', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual(DEFAULTS);
    expect(await loadDefaults(memoryStore(), 'u', (async () => json({ v: 2 })) as unknown as typeof fetch)).toBeNull();
  });
});

const PAGE: Captured = { url: 'https://example.com/a?utm_source=x', canonical: 'https://example.com/a', hero: null, title: 'A page', site: 'Example', byline: null, lang: 'en', html: '<p>Hello there</p>' };

describe('a save (contract 4.4)', () => {
  const ctx = { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW };

  test('the phone can open the request, and the inbox blob decrypts to the HTML', async () => {
    const { pending, wrapKey } = await prepare(PAGE, ctx);
    const { rumor, seal } = await unwrap(user, pending.wrap);
    const req = JSON.parse(rumor.content) as SaveRequest;
    expect(req).toMatchObject({ v: 1, url: PAGE.url, canonical: PAGE.canonical, title: 'A page', token: PAIRING.token, captured_at: NOW });
    expect(req.html!.server).toBe(DEFAULTS.operator.blossom);
    expect(req.html!.sha256).toBe(pending.sha256);
    expect(await decryptText(base64.decode(pending.blob!), req.html!, webCrypto)).toBe(PAGE.html);
    expect(pending.hash).toBe(itemHash(PAGE.url, PAGE.canonical));
    expect(pending.host).toBe('example.com');
    expect(pending.wrap.pubkey).not.toBe(device.pubkey());
    expect(wrapKey).toHaveLength(32);
    // the phone's own check accepts it from a connected device with this token
    const devices = { v: 1 as const, devices: [{ device_pubkey: device.pubkey(), label: 'x', token: PAIRING.token, connected_at: NOW, revoked_at: null }] };
    expect(acceptSaveRequest(rumor, seal, devices, DEFAULTS.operator.blossom).ok).toBe(true);
  });

  test('a link save carries no HTML and is named by its host', async () => {
    const { pending } = await prepare(linkOnly('https://www.example.org/b#top'), ctx);
    const req = JSON.parse((await unwrap(user, pending.wrap)).rumor.content) as SaveRequest;
    expect(req.html).toBeNull();
    expect(pending).toMatchObject({ blob: null, sha256: null, title: 'example.org', host: 'example.org' });
  });
});

function fakeNet(o: { upload?: 'ok' | 'down' | 'refused'; publish?: 'ok' | 'down' | 'blocked' } = {}) {
  const calls: string[] = [];
  const published: NostrEvent[] = [];
  const net: Net = {
    async upload() {
      calls.push('upload');
      if (o.upload === 'down') throw new Error('fetch failed');
      return o.upload === 'refused' ? { ok: false, status: 413, permanent: true, reason: 'too big' } : { ok: true, url: 'u' };
    },
    async remove() {
      calls.push('remove');
      return { ok: true, url: 'u' };
    },
    async publish(_relay, e) {
      calls.push(`publish ${e.kind}`);
      published.push(e);
      if (o.publish === 'down') throw new Error('timeout');
      if (o.publish === 'blocked') throw new Error('blocked: not allowed');
    },
  };
  return { net, calls, published };
}

describe('delivery', () => {
  const ctx = { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW };
  const send = async (o: Parameters<typeof fakeNet>[0]) => {
    const { pending } = await prepare(PAGE, ctx);
    const f = fakeNet(o);
    return { d: await deliver(pending, 'b', 'r', device, f.net), pending, ...f };
  };

  test('the blob goes up before the wrap, and is then dropped', async () => {
    const r = await send({});
    expect(r.d).toBe('sent');
    expect(r.calls).toEqual(['upload', 'publish 1059']);
    expect(r.pending.blob).toBeNull();
  });
  test('an unreachable server leaves the save to wait, the blob kept', async () => {
    const r = await send({ upload: 'down' });
    expect(r.d).toBe('unreachable');
    expect(r.calls).toEqual(['upload']);
    expect(r.pending.blob).not.toBeNull();
  });
  test('a blob refused for good is dropped and the request still goes, for the phone to fetch the page', async () => {
    expect((await send({ upload: 'refused' })).d).toBe('sent');
  });
  test("a relay that times out, and one that refuses", async () => {
    expect((await send({ publish: 'down' })).d).toBe('unreachable');
    expect((await send({ publish: 'blocked' })).d).toBe('blocked');
  });
  test('Undo is a kind 5 by the wrap key, and the inbox blob goes', async () => {
    const { pending, wrapKey } = await prepare(PAGE, ctx);
    const f = fakeNet();
    await retract(pending, wrapKey, 'b', 'r', device, f.net, NOW);
    const del = f.published[0];
    expect(del).toMatchObject({ kind: 5, pubkey: pending.wrap.pubkey, tags: [['e', pending.id], ['k', '1059']] });
    expect(verifyEvent(del as never)).toBe(true);
    expect(f.calls).toEqual(['publish 5', 'remove']);
  });
});

describe('the queue (extension spec 4, decisions 30, 31 and 60)', () => {
  const p = (id: string, blob: string | null = null): Pending => ({ id, wrap: { id } as NostrEvent, blob, sha256: blob ? 's' : null, hash: 'h', title: 't', host: 'h', created_at: NOW, attempts: 0 });

  test('eight wait; a ninth is refused', async () => {
    const store = memoryStore();
    for (let i = 0; i < QUEUE_MAX; i++) expect(await enqueue(store, p(`w${i}`), 'offline')).toBe('queued');
    expect(await enqueue(store, p('w9'), 'offline')).toBe('full');
    expect(waiting(await queued(store))).toBe(QUEUE_MAX);
  });
  test('a blob too large to keep offline is dropped', async () => {
    const store = memoryStore();
    await enqueue(store, p('big', 'x'.repeat(BLOB_KEEP_MAX + 1)), 'offline');
    await enqueue(store, p('small', 'x'), 'offline');
    expect((await queued(store)).map((e) => e.blob)).toEqual([null, 'x']);
  });
  test('Undo takes a waiting save out', async () => {
    const store = memoryStore();
    await enqueue(store, p('a'), 'offline');
    expect(await dequeue(store, 'a')).toBe(true);
    expect(await dequeue(store, 'a')).toBe(false);
  });
  test('offline saves wait; the rest are listed as Couldn’t send', async () => {
    const store = memoryStore();
    await enqueue(store, p('a'), 'offline');
    await enqueue(store, p('b'), 'reach');
    await enqueue(store, p('c'), 'blocked');
    const q = await queued(store);
    expect(waiting(q)).toBe(1);
    expect(failed(q).map((e) => e.id)).toEqual(['b', 'c']);
    expect([whyNot('blocked', true), whyNot('unreachable', true), whyNot('unreachable', false)]).toEqual(['blocked', 'reach', 'offline']);
  });
  test('a pass sends what it can, counts attempts, and stops at 200', async () => {
    const store = memoryStore();
    await enqueue(store, p('ok'), 'offline');
    await enqueue(store, p('no'), 'offline');
    const q = await queued(store);
    q[1].attempts = ATTEMPTS_MAX - 1;
    await store.set(KEYS.queue, q);
    const sent = await flush(store, async (e) => (e.id === 'ok' ? 'sent' : 'unreachable'), true);
    expect(sent).toEqual(['ok']);
    const left = await queued(store);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: 'no', attempts: ATTEMPTS_MAX, stopped: true, why: 'reach' });
    expect(await flush(store, async () => 'sent', true)).toEqual([]);
    expect(await flush(store, async () => 'sent', true, true)).toEqual(['no']);
  });
});

describe('capture (contract 4.2 and 4.4)', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ') + '\n';
  test('the address loses its fragment', () => expect(pageUrl('https://a.example/x?y=1#z')).toBe('https://a.example/x?y=1'));
  test('the guard: readerable, or enough spoken words', () => {
    expect(keepHtml({ ok: true, readerable: true, markdown: words(3) }, '<p>x</p>')).toBe('<p>x</p>');
    expect(keepHtml({ ok: true, readerable: false, markdown: words(GUARD_WORDS) }, '<p>x</p>')).toBe('<p>x</p>');
    expect(keepHtml({ ok: true, readerable: false, markdown: words(GUARD_WORDS - 1) }, '<p>x</p>')).toBeNull();
    expect(keepHtml({ ok: false }, '<p>x</p>')).toBeNull();
    expect(keepHtml({ ok: true, readerable: true, markdown: 'x\n' }, undefined)).toBeNull();
  });
  test('over 2 MB, the phone fetches the page itself', () => {
    expect(keepHtml({ ok: true, readerable: true, markdown: 'x\n' }, 'a'.repeat(HTML_MAX_BYTES))).not.toBeNull();
    expect(keepHtml({ ok: true, readerable: true, markdown: 'x\n' }, 'a'.repeat(HTML_MAX_BYTES + 1))).toBeNull();
  });
});

describe('the toast', () => {
  const s = { id: 'w', hash: 'h', title: 'A page', host: 'example.com', link: false, shortcut: 'Alt+Shift+S' };
  test('Saved names the page and tells keyboard users how to reach Undo', () => {
    expect(toastCopy({ ...s, kind: 'saved' })).toMatchObject({ title: 'Saved to Kefli', sub: 'A page', action: 'Undo', mark: 'ok', timed: true, say: 'Saved to Kefli. Press Alt+Shift+S again to reach Undo.' });
    expect(toastCopy({ ...s, kind: 'saved', shortcut: null }).say).toBe('Saved to Kefli');
  });
  test('a link save names its host; Saving… has no countdown', () => {
    expect(toastCopy({ ...s, kind: 'saving', link: true })).toMatchObject({ sub: 'example.com', timed: false });
  });
  test('the refusal and the failures', () => {
    expect(toastCopy({ ...s, kind: 'full' }).title).toBe(`Not saved: ${QUEUE_MAX} are already waiting`);
    expect(toastCopy({ ...s, kind: 'failed' })).toMatchObject({ mark: 'bad', action: 'Options' });
    expect(toastCopy({ ...s, kind: 'offline' }).mark).toBe('off');
    expect(toastCopy({ ...s, kind: 'notext' }).sub).toBe('example.com · your phone will fetch the text');
    expect(toastCopy({ ...s, kind: 'undone' }).tile).toBe('undo');
    expect(toastCopy({ ...s, kind: 'unqueued' }).sub).toBe('A page');
  });
  test('the mark lands with the last leaf, never after a second', () => {
    expect(markDelay(1)).toBe(520);
    expect(markDelay(5)).toBe(656);
    expect(markDelay(40)).toBe(1000);
  });
});
