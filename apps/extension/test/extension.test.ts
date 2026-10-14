// The extension's modules against the protocol's own code: a user key plays the phone, fakes play the network.
import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import { itemHash } from '../../../packages/protocol/src/normalise';
import {
  acceptSaveRequest, checkOffer, derivePairCode, deviceProofTemplate, openOffer, proofHolds, statementHolds, wrapPairAck, type PairAck, type SaveRequest,
} from '../../../packages/protocol/src/pairing';
import { LocalSigner, type NostrEvent } from '../../../packages/protocol/src/signer';
import { decryptText } from '../../../packages/protocol/src/text';
import { unwrap } from '../../../packages/protocol/src/wrap';
import { GUARD_WORDS, HTML_MAX_BYTES, isWebAddress, keepHtml, linkOnly, pageUrl, type Captured } from '../src/captured';
import { webCrypto } from '../src/crypto';
import { loadDefaults, type Defaults } from '../src/defaults';
import { deviceSigner } from '../src/device';
import { ackFor, browserLabel, formatCode, newOffer, OFFER_LIFE, OFFER_REUSE_MIN, pairingFrom, postOffer, tryPairing, type Offer } from '../src/pair';
import { ATTEMPTS_MAX, BLOB_KEEP_MAX, dequeue, enqueue, failed, flush, QUEUE_MAX, queued, shown, waiting, whyNot } from '../src/queue';
import { deliver, prepare, retract, withoutText, type Delivered, type Net, type Pending } from '../src/save';
import { KEYS, memoryStore, type Pairing } from '../src/store';
import { applyMove, followMoves } from '../src/move';
import { SECOND_LOOK_MS, settleUndo } from '../src/undo';
import { markDelay, toastCopy } from '../src/toastCopy';
import { debugText, history, HISTORY_MAX, record } from '../src/debug';

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
    const o = await newOffer(device, DEFAULTS, 'Chrome on a Mac', webCrypto, NOW);
    expect(o.posted).toBe(false);
    await postOffer(device, DEFAULTS, o, webCrypto, get);
    expect(o.posted).toBe(true);
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

  test("the QR and the typed code's sealed offer both carry the device key's proof over the nonce, which the phone accepts", async () => {
    let sealed = '';
    const get = (async (_url: string, init: RequestInit) => ((sealed = JSON.parse(String(init.body)).offer), json({ v: 1 }))) as unknown as typeof fetch;
    const o = await newOffer(device, DEFAULTS, 'Chrome on a Mac', webCrypto, NOW);
    await postOffer(device, DEFAULTS, o, webCrypto, get);
    const typed = await openOffer(sealed, (await derivePairCode(o.code, webCrypto)).key, webCrypto);
    for (const offer of [JSON.parse(o.qr), typed]) {
      expect(offer.proof.created_at).toBe(NOW);
      expect(statementHolds(device.pubkey(), deviceProofTemplate(DEFAULTS.operator.api, o.offer.nonce, NOW), offer.proof.sig)).toBe(true);
      expect(checkOffer(offer, DEFAULTS.operator, NOW)).toBeNull();
    }
    // a fresh offer has a fresh nonce, and the old proof doesn't hold for it
    const next = await newOffer(device, DEFAULTS, 'Chrome on a Mac', webCrypto, NOW);
    expect(next.offer.nonce).not.toBe(o.offer.nonce);
    expect(proofHolds({ ...next.offer, proof: o.offer.proof }, DEFAULTS.operator.api)).toBe(false);
    // and a proof only the device key makes: the user's own key can't stand in for it
    const forged = await newOffer(user, DEFAULTS, 'x', webCrypto, NOW);
    expect(proofHolds({ ...forged.offer, device_pubkey: device.pubkey() }, DEFAULTS.operator.api)).toBe(false);
  });

  test('an operator that refuses the offer is an error the page shows as offline', async () => {
    const get = (async () => json({}, false)) as unknown as typeof fetch;
    const o = await newOffer(device, DEFAULTS, 'x', webCrypto, NOW);
    await expect(postOffer(device, DEFAULTS, o, webCrypto, get)).rejects.toThrow('500');
    expect(o.posted).toBe(false);
  });

  describe('trying again after trouble (F42)', () => {
    const attempt = (last: { offer: Offer | null }, relayUp: boolean, at = NOW) => {
      const calls: string[] = [];
      const run = tryPairing(
        last,
        () => (calls.push('make'), newOffer(device, DEFAULTS, 'x', webCrypto, at)),
        async () => {
          calls.push('listen');
          if (!relayUp) throw new Error('connection failed');
          return { stop: () => void calls.push('stop') };
        },
        async (o) => {
          calls.push('post');
          o.posted = true;
        },
        at,
      );
      return { run, calls };
    };

    test('a relay that can’t be reached posts nothing, and the next try shows the same code', async () => {
      const last = { offer: null as Offer | null };
      const all: string[] = [];
      // five minutes of tries every ten seconds, as the page makes them: the code is shown again until it has under a
      // minute left, and nothing reaches the operator's limit
      for (let i = 0; i < 30; i++) {
        const a = attempt(last, false, NOW + i * 10);
        await expect(a.run).rejects.toThrow('connection failed');
        all.push(...a.calls);
      }
      expect(all.filter((c) => c === 'post')).toHaveLength(0);
      expect(all.filter((c) => c === 'make')).toHaveLength(2);
      last.offer = await newOffer(device, DEFAULTS, 'x', webCrypto, NOW);
      const code = last.offer.code;
      const up = attempt(last, true, NOW + OFFER_LIFE - OFFER_REUSE_MIN + 1);
      // the offer is made fresh once it has under a minute left
      expect(up.calls[0]).toBe('make');
      const { offer } = await up.run;
      expect(up.calls).toEqual(['make', 'listen', 'post']);
      expect(offer.code).not.toBe(code);
    });

    test('an offer posted once isn’t posted again when the relay drops and the page tries again', async () => {
      const last = { offer: null as Offer | null };
      const first = await attempt(last, true).run;
      const again = attempt(last, true, NOW + 30);
      expect((await again.run).offer).toBe(first.offer);
      expect(again.calls).toEqual(['listen']);
    });

    test('a post that fails closes the wait, and the next try posts the same offer', async () => {
      const last = { offer: null as Offer | null };
      const calls: string[] = [];
      const failing = tryPairing(last, () => newOffer(device, DEFAULTS, 'x', webCrypto, NOW), async () => ({ stop: () => void calls.push('stop') }), async () => { throw new Error('pair-offers answered 429'); }, NOW);
      await expect(failing).rejects.toThrow('429');
      expect(calls).toEqual(['stop']);
      const a = attempt(last, true, NOW + 10);
      expect((await a.run).offer).toBe(last.offer);
      expect(a.calls).toEqual(['listen', 'post']);
    });
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

describe('a request sent again without its HTML (contract 4.4, v1.12)', () => {
  const ctx = { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW };
  const open = async (w: NostrEvent) => {
    const { rumor, seal } = await unwrap(user, w);
    return { rumor, seal, req: JSON.parse(rumor.content) as SaveRequest };
  };

  test('is the same save request, its uuid kept, with html null, under a new wrap and key, signed again by the device', async () => {
    const { pending, wrapKey } = await prepare(PAGE, ctx);
    const again = (await withoutText(pending, device, NOW + 60))!;
    expect(again.wrap.id).not.toBe(pending.wrap.id);
    expect(again.wrap.pubkey).not.toBe(pending.wrap.pubkey);
    expect(again.wrapKey).not.toEqual(wrapKey);
    expect(again.wrap.tags).toEqual([['p', user.pubkey()]]);
    const before = await open(pending.wrap);
    const after = await open(again.wrap);
    expect(after.rumor.tags).toEqual(before.rumor.tags);
    expect(before.req.html).not.toBeNull();
    expect(after.req).toEqual({ ...before.req, html: null });
    expect(after.rumor.created_at).toBe(NOW + 60);
    expect(after.seal.pubkey).toBe(device.pubkey());
    // the copy sealed to the device says the same, so a move wraps the request without its HTML too
    expect(JSON.parse(await device.nip44Decrypt(device.pubkey(), again.sealed))).toEqual({ uuid: before.rumor.tags[0][1].split('/').pop(), request: after.req });
    // and the phone takes it from a connected browser, a request without HTML naming no server
    const devices = { v: 1 as const, devices: [{ device_pubkey: device.pubkey(), label: 'x', token: PAIRING.token, connected_at: NOW, revoked_at: null }] };
    expect(acceptSaveRequest(after.rumor, after.seal, devices, DEFAULTS.operator.blossom)).toMatchObject({ ok: true, request: { html: null } });
  });

  test('can’t be made from a sealed copy that doesn’t open, or a wrap that names no recipient', async () => {
    const { pending } = await prepare(PAGE, ctx);
    expect(await withoutText({ ...pending, sealed: 'not a sealed request' }, device, NOW)).toBeNull();
    expect(await withoutText({ ...pending, wrap: { ...pending.wrap, tags: [] } }, device, NOW)).toBeNull();
    expect(await withoutText({ ...pending, wrap: { id: pending.id } as NostrEvent }, device, NOW)).toBeNull();
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
    async publish(_relay, e, as) {
      calls.push(`publish ${e.kind}${as ? ` as ${as.pubkey().slice(0, 4)}` : ''}`);
      published.push(e);
      if (o.publish === 'down') throw new Error('timeout');
      if (o.publish === 'blocked') throw new Error('blocked: not allowed');
    },
  };
  return { net, calls, published };
}

describe('delivery', () => {
  const ctx = { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW };
  /** The step before every publish, which notes only a refused upload among the network's calls. */
  const noting = (calls: string[]) => async (_p: Delivered, refused: boolean) => void (refused && calls.push('refused'));
  /** A delivery whose refusal, unless the test says otherwise, is only noted among the network's calls. */
  const send = async (o: Parameters<typeof fakeNet>[0], before?: (p: Delivered, refused: boolean) => Promise<void>) => {
    const { pending } = await prepare(PAGE, ctx);
    const f = fakeNet(o);
    return { d: await deliver(pending, 'b', 'r', device, f.net, before ?? noting(f.calls)), pending, ...f };
  };

  test('the blob goes up before the wrap, and is then dropped', async () => {
    const r = await send({});
    expect(r.d).toBe('sent');
    // the wrap goes on a connection AUTHed as the device (F9)
    expect(r.calls).toEqual(['upload', `publish 1059 as ${device.pubkey().slice(0, 4)}`]);
    expect(r.pending.blob).toBeNull();
  });
  test('the step before the publish runs after every upload that went or had nothing to send, and says whether it was refused', async () => {
    const seen: boolean[] = [];
    const before = async (_p: Delivered, refused: boolean) => void seen.push(refused);
    for (const upload of ['ok', 'refused', 'down'] as const) await send({ upload }, before);
    expect(seen).toEqual([false, true]);
    const f = fakeNet();
    await deliver((await prepare(linkOnly(PAGE.url), ctx)).pending, 'b', 'r', device, f.net, before);
    expect(seen).toEqual([false, true, false]);
  });
  test('an unreachable server leaves the save to wait, the blob kept', async () => {
    const r = await send({ upload: 'down' });
    expect(r.d).toBe('unreachable');
    expect(r.calls).toEqual(['upload']);
    expect(r.pending.blob).not.toBeNull();
  });
  test('a blob refused for good isn’t sent again, and the wrap that refused leaves in its place goes (v1.12)', async () => {
    const other = (await prepare(linkOnly(PAGE.url), ctx)).pending.wrap;
    const seen: string[] = [];
    const r = await send({ upload: 'refused' }, async (p, refused) => {
      seen.push(`refused ${refused}, blob ${p.blob === null ? 'gone' : 'kept'}`);
      p.wrap = other;
    });
    expect(r.d).toBe('sent');
    expect(seen).toEqual(['refused true, blob gone']);
    expect(r.calls).toEqual(['upload', `publish 1059 as ${device.pubkey().slice(0, 4)}`]);
    expect(r.published.map((w) => w.id)).toEqual([other.id]);
  });
  test('a save with no blob, or one already uploaded, is only published', async () => {
    const link = (await prepare(linkOnly(PAGE.url), ctx)).pending;
    const uploaded = { ...(await prepare(PAGE, ctx)).pending, blob: null };
    expect(uploaded.sha256).not.toBeNull();
    for (const p of [link, uploaded]) {
      const f = fakeNet({ upload: 'refused' });
      expect(await deliver(p, 'b', 'r', device, f.net, noting(f.calls))).toBe('sent');
      expect(f.calls).toEqual([`publish 1059 as ${device.pubkey().slice(0, 4)}`]);
      expect(f.published.map((w) => w.id)).toEqual([p.id]);
    }
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
  const p = (id: string, blob: string | null = null): Pending => ({ id, wrap: { id } as NostrEvent, sealed: '', blob, sha256: blob ? 's' : null, hash: 'h', title: 't', host: 'h', created_at: NOW, attempts: 0 });

  test('a waiting save keeps nothing that names its page in the clear, and shows it from the sealed request (F31)', async () => {
    const store = memoryStore();
    const { pending } = await prepare(PAGE, { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW });
    await enqueue(store, pending, 'reach');
    const raw = JSON.stringify(await store.get(KEYS.queue));
    for (const plain of ['A page', 'example.com', pending.hash]) expect(raw).not.toContain(plain);
    expect(await shown(await queued(store), device)).toMatchObject([{ id: pending.id, title: 'A page', host: 'example.com', hash: pending.hash }]);
    // an entry stored before, with them in the clear, loses them at the next write
    await store.set(KEYS.queue, [{ ...pending, why: 'reach', stopped: false }]);
    expect(Object.keys((await queued(store))[0])).not.toEqual(expect.arrayContaining(['title']));
  });

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
    expect(await flush(store, async () => 'sent', true, { all: true, only: 'other' })).toEqual([]);
    expect(await flush(store, async () => 'sent', true, { all: true, only: 'no' })).toEqual(['no']);
  });
});

describe('capture (contract 4.2 and 4.4)', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ') + '\n';
  test('the address loses its fragment', () => expect(pageUrl('https://a.example/x?y=1#z')).toBe('https://a.example/x?y=1'));
  test('only web addresses can be saved (decision 100)', () => {
    expect(['https://a.example/', 'HTTP://b.example/x.pdf'].every(isWebAddress)).toBe(true);
    expect(['chrome://settings/', 'about:blank', 'file:///tmp/a.html', 'chrome-extension://x/options.html'].some(isWebAddress)).toBe(false);
  });
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
    expect(toastCopy({ ...s, kind: 'browserpage' })).toMatchObject({ title: 'Can’t save this page', tile: 'alert', tone: 'bad', timed: true });
    expect(toastCopy({ ...s, kind: 'browserpage' }).action).toBeUndefined();
    expect(toastCopy({ ...s, kind: 'onphone' })).toMatchObject({ title: 'Already on your phone', sub: 'Remove it from your phone’s Saves.', cover: 'h', mark: 'ok', timed: true });
    expect(toastCopy({ ...s, kind: 'onphone' }).action).toBeUndefined();
  });
  test('the mark lands with the last leaf, never after a second', () => {
    expect(markDelay(1)).toBe(520);
    expect(markDelay(5)).toBe(656);
    expect(markDelay(40)).toBe(1000);
  });
});

describe('following a move (contract 4.4 and 4.8)', () => {
  const T = new LocalSigner(hexToBytes('33'.repeat(32)));
  const U = new LocalSigner(hexToBytes('44'.repeat(32)));
  const ackFor = (to: LocalSigner, from: string, token: string): PairAck => ({ v: 1, user_pubkey: to.pubkey(), write_relays: ['wss://t.example'], blossom_servers: ['https://bt.example'], token, moved_from: from });
  const wrapAck = async (sealer: LocalSigner, ack: PairAck, at: number) => (await wrapPairAck(sealer, device.pubkey(), ack, at)).wrap;

  test('a pair-ack from the current user, moving to another key, is followed', async () => {
    const w = await wrapAck(user, ackFor(T, user.pubkey(), 'a1'.repeat(32)), NOW);
    expect((await followMoves(device, [w], user.pubkey()))?.user_pubkey).toBe(T.pubkey());
  });
  test('a chain is followed step by step, whatever order the wraps came in', async () => {
    const st = await wrapAck(user, ackFor(T, user.pubkey(), 'a1'.repeat(32)), NOW);
    const tu = await wrapAck(T, ackFor(U, T.pubkey(), 'b1'.repeat(32)), NOW + 60);
    expect((await followMoves(device, [tu, st], user.pubkey()))).toMatchObject({ user_pubkey: U.pubkey(), token: 'b1'.repeat(32) });
  });
  test('a move sealed by anyone but the current user, or from another key, is ignored', async () => {
    const forged = await wrapAck(T, ackFor(T, user.pubkey(), 'a1'.repeat(32)), NOW);
    const other = await wrapAck(U, ackFor(T, U.pubkey(), 'a1'.repeat(32)), NOW);
    const firstPairing = await wrapAck(user, { ...ackFor(T, user.pubkey(), 'a1'.repeat(32)), moved_from: undefined, nonce: 'n' }, NOW);
    expect(await followMoves(device, [forged, other, firstPairing], user.pubkey())).toBeNull();
  });
  test('the pairing is replaced and a waiting save goes to the new key with its token', async () => {
    const store = memoryStore();
    await store.set(KEYS.pairing, PAIRING);
    const { pending } = await prepare(PAGE, { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW });
    await enqueue(store, pending, 'offline');
    const p = await applyMove(store, device, ackFor(T, user.pubkey(), 'c1'.repeat(32)), NOW + 10);
    expect(p).toMatchObject({ user_pubkey: T.pubkey(), token: 'c1'.repeat(32), label: PAIRING.label, paired_at: PAIRING.paired_at, write_relays: ['wss://t.example'] });
    const [moved] = await queued(store);
    expect(moved.id).not.toBe(pending.id);
    expect(moved.blob).toBe(pending.blob);
    const { rumor } = await unwrap(T, moved.wrap);
    const req = JSON.parse(rumor.content) as SaveRequest;
    expect(req).toMatchObject({ url: PAGE.url, token: 'c1'.repeat(32) });
    expect(rumor.tags).toEqual((await unwrap(user, pending.wrap)).rumor.tags);
    await expect(unwrap(user, moved.wrap)).rejects.toThrow();
    expect(await store.get(KEYS.pairing)).toEqual(p);
  });
});

describe('Undo (contract 4.4, decision 101)', () => {
  const run = async (answers: boolean[]) => {
    const calls: string[] = [];
    const out = await settleUndo(
      async () => void calls.push('retract'),
      async () => (calls.push('look'), answers.shift() ?? false),
      async (ms) => void calls.push(`wait ${ms}`),
    );
    return { out, calls };
  };
  test('a save the phone already collected is on the phone', async () => {
    expect(await run([true])).toEqual({ out: 'onphone', calls: ['retract', 'look'] });
  });
  test('one the phone was collecting as Undo was pressed is caught on the second look', async () => {
    expect(await run([false, true])).toEqual({ out: 'onphone', calls: ['retract', 'look', `wait ${SECOND_LOOK_MS}`, 'look'] });
  });
  test('otherwise it is removed', async () => {
    expect((await run([false, false])).out).toBe('undone');
  });
  test('a refused retraction still finds the save on the phone, and is reported if it isn’t there', async () => {
    const refusing = async () => { throw new Error('blocked: deletes only a gift wrap of its own that this relay holds'); };
    expect(await settleUndo(refusing, async () => true, async () => undefined)).toBe('onphone');
    await expect(settleUndo(refusing, async () => false, async () => undefined)).rejects.toThrow('blocked');
  });
});

describe('Copy debug info (extension spec 11, decision 108)', () => {
  const at = (i: number) => NOW + i * 60;

  test('keeps the last twenty outcomes, newest first, with the id cut to eight characters', async () => {
    const store = memoryStore();
    for (let i = 0; i < HISTORY_MAX + 5; i++) await record(store, at(i), `${String(i).padStart(2, '0')}${'f'.repeat(62)}`, 'sent', i % 2 === 1);
    const h = await history(store);
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0]).toEqual({ at: at(24), link: false, outcome: 'sent', id: `24${'f'.repeat(6)}` });
    expect(h.at(-1)!.id).toBe(`05${'f'.repeat(6)}`);
  });

  test('a later outcome takes link from the save’s earlier entry', async () => {
    const store = memoryStore();
    await record(store, at(0), 'ab'.repeat(32), 'waiting, offline', true);
    await record(store, at(1), 'ab'.repeat(32), 'sent from queue');
    await record(store, at(2), 'cd'.repeat(32), 'undo: retracted');
    expect((await history(store)).map((e) => [e.outcome, e.link])).toEqual([['undo: retracted', false], ['sent from queue', true], ['waiting, offline', true]]);
  });

  test('the text names the build, the connection and the outcomes, and never an address, a title or a private key', async () => {
    const store = memoryStore();
    const dev = await deviceSigner(store, webCrypto);
    const captured: Captured = { url: 'https://example.com/a-private-page', canonical: null, hero: null, title: 'A private title', site: null, byline: null, lang: null, html: null };
    const { pending } = await prepare(captured, { device: dev, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW });
    await enqueue(store, pending, 'reach');
    await record(store, at(1), pending.id, 'waiting, couldn’t reach', false);
    const text = debugText({
      version: '0.1.0', flavour: 'beta', commit: 'abc1234', browser: 'Chrome on a Mac', userAgent: 'UA', online: true, defaultsUrl: 'https://api.example/defaults.json',
      devicePubkey: dev.pubkey(), pairing: PAIRING, queue: await queued(store), movesChecked: null, history: await history(store), now: at(2),
    });
    expect(text).toContain('Kefli extension 0.1.0 (beta, abc1234)');
    expect(text).toContain(`Library key: ${PAIRING.user_pubkey.slice(0, 8)}…`);
    expect(text).toContain('Waiting: 1 (sending 0, offline 0, couldn’t reach 1, blocked 0, stopped 0; most attempts 0)');
    expect(text).toContain(`page  ${pending.id.slice(0, 8)}  waiting, couldn’t reach`);
    expect(text).toContain('Last look for a move: never');
    for (const secret of ['example.com', 'A private title', (await store.get<string>(KEYS.device))!, dev.pubkey(), PAIRING.user_pubkey, PAIRING.token]) expect(text).not.toContain(secret);
  });

  test('before pairing, and with nothing saved yet', () => {
    const text = debugText({ version: '0.1.0', flavour: 'dev', commit: 'unknown', browser: 'b', userAgent: 'u', online: false, defaultsUrl: 'd', devicePubkey: '00'.repeat(32), pairing: null, queue: [], movesChecked: NOW, history: [], now: NOW });
    expect(text).toContain('Connected: no');
    expect(text).toContain('Waiting: none');
    expect(text).toContain('  none yet');
    expect(text).toContain('Browser: b, offline');
  });
});
