import { verifyEvent } from 'nostr-tools/pure';
import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIND, LIBRARY_KEY_D, LocalSigner, acceptPairAck, acceptSaveRequest, buildDevicesEvent, buildItemEvent, checkOffer, proofHolds, releaseTemplate, statementHolds,
  decryptText, derivePairCode, derivePhonePair, httpAuth, isDeleted, itemHash, normaliseMarkdown, openOffer,
  openPhoneOffer, readDevicesEvent, readItemEvent, readLibraryKeyEvent, readPairCode, readPhoneQr, readRelayList,
  readServerList, readSix, savedD, sealOffer, sealPhoneOffer, secretKeyFromMnemonic, textHash, unwrap, wrapPairAck,
  wrapSaveRequest, type CryptoPort, type Item, type NostrEvent,
} from '../src';
import { nodeCrypto } from '../src/node';

// Contract section 9's protocol fixtures (shared/fixtures/protocol, made by shared/fixtures/build-protocol.ts). Each
// is checked as the contract says: exact where nothing is random, and otherwise by verifying and decrypting the
// fixture and by round trips, in which what this code makes must verify and open with the fixture's keys.
const dir = join(__dirname, '../../../shared/fixtures/protocol');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (name: string): any => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const signer = (hex: string) => new LocalSigner(hexToBytes(hex));
/** A CryptoPort whose randomness is the bytes given, so a seal can be made again with the fixture's IV. */
const replaying = (bytes: Uint8Array): CryptoPort => ({ ...nodeCrypto, randomBytes: (n) => bytes.slice(0, n) });

type Save = { hash: string; d: string; event: NostrEvent; item: Item };

describe('the keys (C§2, §9)', () => {
  test("the mnemonic gives its key at NIP-06's path", async () => {
    const f = load('keys.json');
    const sk = await secretKeyFromMnemonic(f.mnemonic, nodeCrypto);
    expect(bytesToHex(sk)).toBe(f.secret_key);
    expect(new LocalSigner(sk).pubkey()).toBe(f.pubkey);
    expect(f.path).toBe("m/44'/1237'/0'/0/0");
  });
});

describe('the text blob (C§4.2, §9)', () => {
  const f = load('text.json');

  test('normalised, hashed and encrypted exactly', async () => {
    expect(normaliseMarkdown(f.markdown)).toBe(f.normalised);
    expect(textHash(f.normalised, nodeCrypto)).toBe(f.text_hash);
    const blob = await nodeCrypto.aesGcmEncrypt(base64.decode(f.key), base64.decode(f.nonce), utf8ToBytes(f.normalised));
    expect(base64.encode(blob)).toBe(f.blob);
    expect(bytesToHex(nodeCrypto.sha256(blob))).toBe(f.sha256);
  });

  test('the blob decrypts to the normalised text', async () => {
    expect(await decryptText(base64.decode(f.blob), f, nodeCrypto)).toBe(f.normalised);
  });
});

describe('the items and the library key (C§4.1, §4.3, §9)', () => {
  const f = load('items.json');
  const s = signer(f.secret_key);
  const key = hexToBytes(f.library_key);

  test('the library key record verifies and holds the key', async () => {
    expect(verifyEvent(f.library_key_record)).toBe(true);
    expect(f.library_key_record.tags).toEqual([['d', LIBRARY_KEY_D], ['t', 'kefli']]);
    expect(bytesToHex(await readLibraryKeyEvent(s, f.library_key_record))).toBe(f.library_key);
  });

  test('each save verifies, is addressed by its keyed hash, and decrypts to its item', async () => {
    expect(f.items).toHaveLength(4);
    expect(f.items.filter((x: Save) => x.item.text === null)).toHaveLength(1);
    for (const x of f.items as Save[]) {
      expect(verifyEvent(x.event)).toBe(true);
      expect(x.hash).toBe(itemHash(x.item.url, x.item.canonical));
      expect(x.d).toBe(savedD(key, x.hash));
      expect(x.event.tags).toEqual([['d', x.d], ['t', 'kefli']]);
      const read = await readItemEvent(s, x.event);
      expect(read).toEqual({ hash: x.hash, d: x.d, item: { item: x.item, extra: {} } });
    }
  });

  test('a save made here from the same item reads back the same', async () => {
    for (const x of f.items as Save[]) {
      const { event } = await buildItemEvent(s, x.hash, { item: x.item, extra: {} }, x.event.created_at, key);
      expect(verifyEvent(event)).toBe(true);
      expect(event.tags).toEqual(x.event.tags);
      expect((await readItemEvent(s, event)).item.item).toEqual(x.item);
    }
  });
});

describe('the connected-browsers record (C§4.9, §9)', () => {
  const f = load('devices.json');
  const s = signer(f.secret_key);

  test('verifies and decrypts to its record, and a record made here round-trips', async () => {
    expect(verifyEvent(f.event)).toBe(true);
    expect(await readDevicesEvent(s, f.event)).toEqual(f.record);
    const mine = await buildDevicesEvent(s, f.record, f.event.created_at);
    expect(verifyEvent(mine)).toBe(true);
    expect(mine.tags).toEqual(f.event.tags);
    expect(await readDevicesEvent(s, mine)).toEqual(f.record);
  });
});

describe('the save request (C§4.4, §9)', () => {
  const f = load('save-request.json');
  const user = signer(f.user.secret_key);
  const device = signer(f.device.secret_key);

  test("the wrap opens with the user's key to its rumor, sealed by the device, and is accepted", async () => {
    expect(verifyEvent(f.wrap)).toBe(true);
    expect(f.wrap.tags).toEqual([['p', f.user.pubkey]]);
    const { rumor, seal } = await unwrap(user, f.wrap);
    expect(rumor).toEqual(f.rumor);
    expect(seal.pubkey).toBe(f.device.pubkey);
    expect(JSON.parse(rumor.content)).toEqual(f.request);
    expect(acceptSaveRequest(rumor, seal, f.devices, f.operator_blossom)).toMatchObject({ ok: true, request: f.request });
    expect(utf8ToBytes(JSON.stringify(f.wrap)).length).toBeLessThan(8_192);
  });

  test('the inbox blob is exact and decrypts to the HTML the request names', async () => {
    const b = f.inbox_blob;
    expect(f.request.html).toEqual({ sha256: b.sha256, key: b.key, nonce: b.nonce, server: f.operator_blossom });
    const blob = await nodeCrypto.aesGcmEncrypt(base64.decode(b.key), base64.decode(b.nonce), utf8ToBytes(b.html));
    expect(base64.encode(blob)).toBe(b.blob);
    expect(await decryptText(blob, b, nodeCrypto)).toBe(b.html);
  });

  test('a request wrapped here opens with the fixture keys and is accepted', async () => {
    const uuid = f.rumor.tags[0][1].slice('kefli/save-request/'.length);
    const { wrap } = await wrapSaveRequest(device, f.user.pubkey, uuid, f.request, f.rumor.created_at);
    const { rumor, seal } = await unwrap(user, wrap);
    expect(acceptSaveRequest(rumor, seal, f.devices, f.operator_blossom)).toMatchObject({ ok: true });
  });
});

describe('the pair-acks (C§4.4, §4.8, §9)', () => {
  const f = load('pair-acks.json');
  const device = signer(f.device.secret_key);
  const user = signer(f.user.secret_key);

  test('the pair-ack opens with the device key and is accepted with its offer nonce', async () => {
    expect(verifyEvent(f.pair.wrap)).toBe(true);
    const { rumor, seal } = await unwrap(device, f.pair.wrap);
    expect(rumor).toEqual(f.pair.rumor);
    expect(acceptPairAck(rumor, seal, { offerNonce: f.pair.offer_nonce, pairedUser: null })).toEqual({ ok: true, ack: f.pair.ack, move: false });
  });

  test('the move pair-ack is accepted while paired to the user it moves from', async () => {
    expect(verifyEvent(f.move.wrap)).toBe(true);
    const { rumor, seal } = await unwrap(device, f.move.wrap);
    expect(rumor).toEqual(f.move.rumor);
    expect(f.move.ack).toMatchObject({ user_pubkey: f.move.target_pubkey, moved_from: f.user.pubkey });
    expect(acceptPairAck(rumor, seal, { offerNonce: null, pairedUser: f.user.pubkey })).toEqual({ ok: true, ack: f.move.ack, move: true });
  });

  test('pair-acks made here are accepted by the same rules', async () => {
    for (const [ack, state, move] of [
      [f.pair.ack, { offerNonce: f.pair.offer_nonce, pairedUser: null }, false],
      [f.move.ack, { offerNonce: null, pairedUser: f.user.pubkey }, true],
    ] as const) {
      const { wrap } = await wrapPairAck(user, f.device.pubkey, ack, f.pair.rumor.created_at);
      const { rumor, seal } = await unwrap(device, wrap);
      expect(acceptPairAck(rumor, seal, state)).toEqual({ ok: true, ack, move });
    }
  });
});

describe('the typed-code pair offer (C§4.4, §9)', () => {
  const f = load('pair-offer.json');

  test('the code, its lookup and key, and the sealed offer are exact', async () => {
    expect(readPairCode(f.typed)).toBe(f.code);
    const { lookup, key } = await derivePairCode(f.code, nodeCrypto);
    expect(lookup).toBe(f.lookup);
    expect(bytesToHex(key)).toBe(f.key);
    expect(await openOffer(f.sealed, key, nodeCrypto)).toEqual(f.offer);
    expect(await sealOffer(f.offer, key, replaying(base64.decode(f.sealed)))).toBe(f.sealed);
    expect(checkOffer(f.offer, { relay: f.offer.relay, api: f.api }, f.offer.expires)).toBeNull();
  });

  test("the offer's proof and a move's release verify, and the POST /devices bodies carry them (C§4.4, 4.8, 6)", () => {
    const { offer, post, move_post: move } = f;
    expect(proofHolds(offer, f.api)).toBe(true);
    expect(post).toEqual({ v: 1, device_pubkey: offer.device_pubkey, proof: { nonce: offer.nonce, ...offer.proof } });
    const r = move.body.release;
    expect(r.pubkey).toBe(move.source_pubkey);
    expect(statementHolds(r.pubkey, releaseTemplate(f.api, move.body.device_pubkey, move.target_pubkey, r.created_at), r.sig)).toBe(true);
    expect(statementHolds(r.pubkey, releaseTemplate(f.api, move.body.device_pubkey, r.pubkey, r.created_at), r.sig)).toBe(false);
  });
});

describe('the phone-pair offer (C§2, §9)', () => {
  const f = load('phone-pair.json');

  test('the QR, the six digits, the lookup and key, and the sealed mnemonic are exact', async () => {
    expect(readPhoneQr(f.qr_text, f.qr.expires)).toEqual(f.qr);
    expect(readSix(f.six)).toBe(f.six);
    const { lookup, key } = derivePhonePair(f.qr.secret, f.six);
    expect(lookup).toBe(f.lookup);
    expect(bytesToHex(key)).toBe(f.key);
    expect(await openPhoneOffer(f.sealed, key, nodeCrypto)).toBe(f.payload.mnemonic);
    expect(await sealPhoneOffer(f.payload.mnemonic, key, replaying(base64.decode(f.sealed)))).toBe(f.sealed);
    expect(new LocalSigner(await secretKeyFromMnemonic(f.payload.mnemonic, nodeCrypto)).pubkey()).toBe(f.qr.pubkey);
  });
});

describe('the NIP-98 request (C§6, §9)', () => {
  const f = load('nip98.json');
  const tags = (e: NostrEvent) => Object.fromEntries(e.tags.map((t) => [t[0], t[1]]));

  test('its header carries a kind 27235 for the url, method and body, and the event verifies', () => {
    expect(f.header).toBe(`Nostr ${base64.encode(utf8ToBytes(JSON.stringify(f.event)))}`);
    expect(verifyEvent(f.event)).toBe(true);
    expect(f.event).toMatchObject({ kind: KIND.httpAuth, pubkey: f.pubkey, content: '' });
    expect(tags(f.event)).toEqual({ u: f.url, method: f.method, payload: bytesToHex(nodeCrypto.sha256(utf8ToBytes(f.body))) });
  });

  test('a header made here carries the same tags', async () => {
    const h = await httpAuth(signer(f.secret_key), f.url, f.method, f.body, nodeCrypto, f.event.created_at);
    const e = JSON.parse(new TextDecoder().decode(base64.decode(h.slice('Nostr '.length))));
    expect(verifyEvent(e)).toBe(true);
    expect(tags(e)).toEqual(tags(f.event));
  });
});

describe('the move scenario (C§4.8, §9)', () => {
  const f = load('move.json');

  test("every event verifies and decrypts under its own library's key", async () => {
    for (const side of [f.source, f.target]) {
      const s = signer(side.secret_key);
      expect(bytesToHex(await readLibraryKeyEvent(s, side.library_key_record))).toBe(side.library_key);
      for (const x of side.items as Save[]) {
        expect(verifyEvent(x.event)).toBe(true);
        expect(x.d).toBe(savedD(hexToBytes(side.library_key), x.hash));
        expect((await readItemEvent(s, x.event)).item.item).toEqual(x.item);
      }
    }
  });

  test('expected follows step 3: S\'s saves copied, and a hash T holds keeps T\'s item, un-archived as S\'s is unread', () => {
    const t = new Map((f.target.items as Save[]).map((x) => [x.hash, x.item]));
    const want = (f.source.items as Save[]).map((x) => {
      const held = t.get(x.hash);
      if (!held) return { hash: x.hash, item: x.item };
      return { hash: x.hash, item: x.item.state === 'unread' && held.state === 'archived' ? { ...held, state: 'unread' } : held };
    });
    expect(f.expected).toEqual(want);
    expect(f.source.items.filter((x: Save) => t.has(x.hash))).toHaveLength(1);
  });

  test('the blobs are the texts the saves name', async () => {
    for (const x of f.source.items as Save[]) {
      if (!x.item.text) continue;
      const md = await decryptText(base64.decode(f.blobs[x.item.text.sha256]), x.item.text, nodeCrypto);
      expect(textHash(md, nodeCrypto)).toBe(x.item.text_hash);
    }
  });
});

describe('the restore scenario (C§8, §9)', () => {
  const f = load('restore.json');
  const all = (): NostrEvent[] => Object.values(f.relays as Record<string, NostrEvent[]>).flat();

  test('nothing is held by the operator, and every event verifies', () => {
    expect(Object.keys(f.relays)).not.toContain(f.defaults.operator.relay);
    expect(Object.keys(f.servers)).not.toContain(f.defaults.operator.blossom);
    for (const e of all()) expect(verifyEvent(e)).toBe(true);
  });

  test('read as section 8 reads it, the library is the expected one', async () => {
    const s = new LocalSigner(await secretKeyFromMnemonic(f.mnemonic, nodeCrypto));
    expect(s.pubkey()).toBe(f.pubkey);
    const mine = all().filter((e) => e.pubkey === f.pubkey);
    const lists = mine.filter((e) => e.kind === KIND.relayList);
    expect(lists.length).toBeGreaterThan(0);
    expect(f.relays[f.defaults.indexer[0]].some((e: NostrEvent) => e.kind === KIND.relayList)).toBe(true);
    const relays = readRelayList(lists[0]).map((r) => r.url);
    const record = mine.find((e) => e.tags.some((t) => t[0] === 'd' && t[1] === LIBRARY_KEY_D))!;
    expect(bytesToHex(await readLibraryKeyEvent(s, record))).toBe(f.library_key);
    const servers = readServerList(mine.find((e) => e.kind === KIND.serverList)!);
    // the newest event per d, less any a kind 5 names at or after it
    const newest = new Map<string, NostrEvent>();
    for (const e of mine.filter((x) => x.kind === KIND.appData && x.tags.some((t) => t[0] === 'd' && /^kefli\/item\//.test(t[1])))) {
      const d = e.tags[0][1];
      if ((newest.get(d)?.created_at ?? -1) < e.created_at) newest.set(d, e);
    }
    const deletions = mine.filter((e) => e.kind === KIND.deletion);
    const kept = [...newest].filter(([d, e]) => !isDeleted(e, d, deletions));
    const saves = [];
    const deleted = [];
    for (const [d, e] of newest) if (isDeleted(e, d, deletions)) deleted.push((await readItemEvent(s, e)).hash);
    for (const [, e] of kept) {
      const { hash, item } = await readItemEvent(s, e);
      let markdown: string | null = null;
      if (item.item.text) {
        // from any server the item names or the 10063 lists, none of them the operator's
        for (const server of [...item.item.text.servers, ...servers]) {
          const b64 = f.servers[server]?.[item.item.text.sha256];
          if (b64) markdown = await decryptText(base64.decode(b64), item.item.text, nodeCrypto);
        }
        expect(markdown).not.toBeNull();
      }
      saves.push({ hash, title: item.item.title, state: item.item.state, markdown });
    }
    const byHash = (a: { hash: string }, b: { hash: string }) => (a.hash < b.hash ? -1 : 1);
    expect(saves.sort(byHash)).toEqual([...f.expected.saves].sort(byHash));
    expect(deleted).toEqual(f.expected.deleted);
    expect(relays).toEqual(expect.arrayContaining(f.defaults.relays));
  });
});
