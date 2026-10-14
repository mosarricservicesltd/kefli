// The protocol fixtures of contract section 9, beside the page and PDF fixtures: the keys, a text blob, items and the
// library key record, the connected-browsers record, a browser's save request, the pair-acks, both pair offers, a
// NIP-98 request, and the move and restore scenarios. Every key, nonce and signature's randomness comes from a seed
// named after its fixture, so the files come out byte for byte the same on every run. Signatures and NIP-44
// ciphertext still differ between implementations, so packages/protocol/test/fixtures.test.ts verifies and decrypts
// those and checks round trips (C§9); everything else must match exactly.
//   npx tsx shared/fixtures/build-protocol.ts           write shared/fixtures/protocol/*.json
//   npx tsx shared/fixtures/build-protocol.ts --check   exit 1 if a file differs from what this script makes (CI)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64 } from '@scure/base';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  LocalSigner, buildDeletions, buildDevicesEvent, buildItemEvent, buildLibraryKeyEvent, buildRelayList, buildServerList,
  countWords, derivePairCode, derivePhonePair, deviceProofTemplate, encryptText, httpAuth, itemHash, normaliseMarkdown, progressAt, savedD,
  releaseTemplate, sealOffer, sealPhoneOffer, secretKeyFromMnemonic, signStatement, textHash, wrapPairAck, wrapSaveRequest,
  type CryptoPort, type DevicesRecord, type Item, type NostrEvent, type PairAck, type PairOffer, type SaveRequest,
} from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'protocol');
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());

// One stream of bytes per fixture, from sha256(seed ‖ counter), for the CryptoPort and for the libraries' own
// randomness (noble and nostr-tools call globalThis.crypto.getRandomValues for nonces, aux and wrap keys).
let stream = { seed: '', n: 0, buf: new Uint8Array() };
function seed(name: string) {
  stream = { seed: `kefli fixture: ${name}`, n: 0, buf: new Uint8Array() };
}
function take(len: number): Uint8Array {
  while (stream.buf.length < len) {
    const next = sha256(`${stream.seed}/${stream.n++}`);
    stream.buf = new Uint8Array([...stream.buf, ...next]);
  }
  const b = stream.buf.slice(0, len);
  stream.buf = stream.buf.slice(len);
  return b;
}
Object.defineProperty(globalThis.crypto, 'getRandomValues', {
  configurable: true,
  value: <T extends ArrayBufferView | null>(a: T): T => {
    if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(take(a.byteLength));
    return a;
  },
});
const seeded: CryptoPort = { ...nodeCrypto, randomBytes: take };
const secretOf = (name: string) => sha256(`kefli fixture key: ${name}`);
const signerOf = (name: string) => new LocalSigner(secretOf(name));

const T0 = 1_791_000_000;
const DEFAULTS = {
  v: 1,
  operator: { relay: 'wss://relay.kefli.example', blossom: 'https://blossom.kefli.example', api: 'https://api.kefli.example' },
  relays: ['wss://relay-a.example', 'wss://relay-b.example'],
  indexer: ['wss://indexer.example'],
  mirrors: ['https://mirror.example'],
};
const SERVERS = [DEFAULTS.operator.blossom, DEFAULTS.mirrors[0]];
const WRITE = [DEFAULTS.operator.relay, ...DEFAULTS.relays];

function item(url: string, over: Partial<Item> = {}): Item {
  return {
    v: 1, url, canonical: null, title: null, site: new URL(url).hostname, byline: null, saved_at: T0, state: 'unread',
    progress: 0, words: null, lang: 'en', text: null, text_hash: null, hero: null, source_kind: 'web', audio_pref: null,
    ...over,
  };
}

type Text = { markdown: string; text_hash: string; sha256: string; key: string; nonce: string; blob: string };

/** An article's text as a share makes it: normalised, hashed and encrypted. */
async function text(markdown: string): Promise<Text> {
  const md = normaliseMarkdown(markdown);
  const enc = await encryptText(md, seeded);
  return { markdown: md, text_hash: textHash(md, nodeCrypto), ...enc.text, blob: base64.encode(enc.blob) };
}

/** A save as the phone publishes it: the item under the library key's address, with its hash inside. */
async function save(signer: LocalSigner, key: Uint8Array | null, i: Item, t: Text | null, servers: string[], at: number) {
  const hash = itemHash(i.url, i.canonical);
  // progress sits on a word of the spoken projection, and is 0 without one (C§4.1)
  const n = t ? countWords(t.markdown) : null;
  const full: Item = t
    ? { ...i, text: { sha256: t.sha256, key: t.key, nonce: t.nonce, servers }, text_hash: t.text_hash, words: n, progress: progressAt(Math.round(i.progress * n!), n) }
    : { ...i, progress: 0 };
  const { event } = await buildItemEvent(signer, hash, { item: full, extra: {} }, at, key ?? undefined);
  if (!key) {
    // a save from before v1.10: unkeyed, and no hash inside (C§4.1); rebuilt so its content carries none
    const content = await signer.nip44Encrypt(signer.pubkey(), JSON.stringify(full));
    const bare = await signer.signEvent({ kind: event.kind, created_at: at, tags: event.tags, content });
    return { hash, d: event.tags[0][1], event: bare, item: full };
  }
  return { hash, d: savedD(key, hash), event, item: { ...full, hash } };
}

async function keys() {
  seed('keys');
  const mnemonic = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
  const sk = await secretKeyFromMnemonic(mnemonic, nodeCrypto);
  return {
    about: "NIP-06's own example (C§2): the twelve words, the path and the key they give. Exact.",
    mnemonic, path: "m/44'/1237'/0'/0/0", secret_key: bytesToHex(sk), pubkey: new LocalSigner(sk).pubkey(),
  };
}

async function textBlob() {
  seed('text');
  const raw = '# Reading later\r\n\r\nA quiet article, saved to read offline.   \r\n\r\n\r\n\r\nIt keeps its place.\t\r\n';
  const t = await text(raw);
  return {
    about: 'One text blob (C§4.2): the Markdown as parsed, its normalised form, text_hash, and the AES-256-GCM blob under the key and nonce. Exact.',
    markdown: raw, normalised: t.markdown, text_hash: t.text_hash, key: t.key, nonce: t.nonce, sha256: t.sha256, blob: t.blob,
  };
}

async function items() {
  seed('items');
  const s = signerOf('library');
  const key = take(32);
  const record = await buildLibraryKeyEvent(s, key, T0);
  const saves = [
    await save(s, key, item('https://example.com/reading', { title: 'On reading later', byline: 'A. Writer', progress: 0.25 }), await text('# On reading later\n\nWords to keep for a quiet evening, saved from a phone.'), SERVERS, T0 + 10),
    await save(s, key, item('https://news.example/story?id=7', { title: 'A story', state: 'archived', progress: 1, saved_at: T0 - 86_400 }), await text('A story told in three short sentences. It ends well. The reader finished it.'), SERVERS, T0 + 20),
    await save(s, key, item('https://blog.example/post', { title: 'A post', canonical: 'https://blog.example/post', hero: 'https://blog.example/hero.jpg' }), await text('## A post\n\n- one point\n- another point'), SERVERS, T0 + 30),
    await save(s, key, item('https://example.org/unreadable', { title: 'A page that could not be read' }), null, SERVERS, T0 + 40),
  ];
  return {
    about: "Four kind 30078 saves (C§4.1) under one library's key, the fourth with text null, and the library key record (C§4.3). Each event verifies, its d is the HMAC of its hash under library_key, and it decrypts to item.",
    secret_key: bytesToHex(secretOf('library')), pubkey: s.pubkey(), library_key: bytesToHex(key), library_key_record: record, items: saves,
  };
}

async function devices() {
  seed('devices');
  const s = signerOf('library');
  const record: DevicesRecord = {
    v: 1,
    devices: [
      { device_pubkey: signerOf('browser').pubkey(), label: 'Chrome on a Windows laptop', token: bytesToHex(take(32)), connected_at: T0, revoked_at: null },
      { device_pubkey: signerOf('old browser').pubkey(), label: 'Firefox on a Mac', token: bytesToHex(take(32)), connected_at: T0 - 3_600, revoked_at: T0 - 60 },
    ],
  };
  return {
    about: 'One connected-browsers record (C§4.9): the event verifies and decrypts to record.',
    secret_key: bytesToHex(secretOf('library')), pubkey: s.pubkey(), event: await buildDevicesEvent(s, record, T0 + 50), record,
  };
}

async function saveRequest() {
  seed('save request');
  const user = signerOf('library');
  const device = signerOf('browser');
  const token = bytesToHex(take(32));
  const record: DevicesRecord = { v: 1, devices: [{ device_pubkey: device.pubkey(), label: 'Chrome on a Windows laptop', token, connected_at: T0, revoked_at: null }] };
  const html = '<div><h1>A page</h1><p>Captured in the browser, read on the phone.</p></div>';
  const enc = await encryptText(html, seeded);
  const request: SaveRequest = {
    v: 1, url: 'https://example.com/captured', canonical: null, title: 'A page', site: 'example.com', byline: null, lang: 'en',
    hero: null, captured_at: T0 + 60, token, html: { ...enc.text, server: DEFAULTS.operator.blossom },
  };
  const { wrap, rumor } = await wrapSaveRequest(device, user.pubkey(), '7c1f6f5e-3a2b-4c8d-9e0f-1a2b3c4d5e6f', request, T0 + 60, { now: T0 + 60, random: take });
  return {
    about: "One kind 1059 save request (C§4.4) from a connected browser: the wrap opens with the user's key to rumor, sealed by the device; the phone accepts it against devices; the inbox blob decrypts to html. The blob is exact; the wrap verifies.",
    user: { secret_key: bytesToHex(secretOf('library')), pubkey: user.pubkey() },
    device: { secret_key: bytesToHex(secretOf('browser')), pubkey: device.pubkey() },
    operator_blossom: DEFAULTS.operator.blossom, devices: record, wrap, rumor, request,
    inbox_blob: { html, sha256: enc.text.sha256, key: enc.text.key, nonce: enc.text.nonce, blob: base64.encode(enc.blob) },
  };
}

async function pairAcks() {
  seed('pair-acks');
  const user = signerOf('library');
  const target = signerOf('move target');
  const device = signerOf('browser');
  const nonce = bytesToHex(take(16));
  const ack: PairAck = { v: 1, user_pubkey: user.pubkey(), write_relays: WRITE, blossom_servers: SERVERS, token: bytesToHex(take(32)), nonce };
  const pair = await wrapPairAck(user, device.pubkey(), ack, T0 + 70, { now: T0 + 70, random: take });
  const moved: PairAck = { v: 1, user_pubkey: target.pubkey(), write_relays: WRITE, blossom_servers: SERVERS, token: bytesToHex(take(32)), moved_from: user.pubkey() };
  const move = await wrapPairAck(user, device.pubkey(), moved, T0 + 80, { now: T0 + 80, random: take });
  return {
    about: "A pair-ack and a move pair-ack (C§4.4, C§4.8), both sealed by the user's key S to the device. Each wrap opens with the device key; the first is accepted with offer_nonce while unpaired, the second while paired to S.",
    device: { secret_key: bytesToHex(secretOf('browser')), pubkey: device.pubkey() },
    user: { secret_key: bytesToHex(secretOf('library')), pubkey: user.pubkey() },
    pair: { offer_nonce: nonce, wrap: pair.wrap, rumor: pair.rumor, ack },
    move: { target_pubkey: target.pubkey(), wrap: move.wrap, rumor: move.rumor, ack: moved },
  };
}

async function pairOffer() {
  seed('pair offer');
  const code = '7K3MZQ2D';
  const { lookup, key } = await derivePairCode(code, nodeCrypto);
  const device = signerOf('browser');
  const nonce = bytesToHex(take(16));
  const proof = await signStatement(device, deviceProofTemplate(DEFAULTS.operator.api, nonce, T0));
  const offer: PairOffer = { v: 1, device_pubkey: device.pubkey(), relay: DEFAULTS.operator.relay, nonce, expires: T0 + 300, label: 'Chrome on a Windows laptop', proof };
  const [source, target] = [signerOf('library'), signerOf('move target')];
  const release = await signStatement(source, releaseTemplate(DEFAULTS.operator.api, device.pubkey(), target.pubkey(), T0 + 120));
  return {
    about: "One typed-code pair offer (C§4.4): typed is read leniently to code; scrypt gives lookup and key; sealed is base64(IV ‖ ciphertext ‖ tag) and opens to offer, whose proof is the device key's signature over the kind 27235 for POST api/devices with its nonce, made at proof.created_at. post is the POST /devices body a phone sends for it, and move_post the body a move's target sends for the same device (C§4.8 step 4), its release signed by the source. The signatures are verified, not matched; the rest is exact.",
    typed: '7k3m-zq2d', code, lookup, key: bytesToHex(key), sealed: await sealOffer(offer, key, seeded), offer,
    api: DEFAULTS.operator.api,
    post: { v: 1, device_pubkey: device.pubkey(), proof: { nonce, ...proof } },
    move_post: { source_pubkey: source.pubkey(), target_pubkey: target.pubkey(), body: { v: 1, device_pubkey: device.pubkey(), release: { pubkey: source.pubkey(), ...release } } },
  };
}

async function phonePair() {
  seed('phone pair');
  const mnemonic = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
  const pubkey = new LocalSigner(await secretKeyFromMnemonic(mnemonic, nodeCrypto)).pubkey();
  const qr = { v: 1 as const, pubkey, secret: bytesToHex(take(32)), expires: T0 + 300 };
  const six = '042917';
  const { lookup, key } = derivePhonePair(qr.secret, six);
  return {
    about: "One phone-pair offer (C§2): the QR's text, the six digits, the HKDF lookup and key, and sealed, which opens to payload, whose mnemonic gives the QR's pubkey. Exact.",
    qr, qr_text: JSON.stringify(qr), six, lookup, key: bytesToHex(key), sealed: await sealPhoneOffer(mnemonic, key, seeded), payload: { v: 1, mnemonic },
  };
}

async function nip98() {
  seed('nip98');
  const s = signerOf('library');
  const url = `${DEFAULTS.operator.api}/devices`;
  const body = JSON.stringify({ device_pubkey: signerOf('browser').pubkey() });
  const header = await httpAuth(s, url, 'POST', body, nodeCrypto, T0 + 90);
  return {
    about: "A NIP-98 signed request (C§6): header is 'Nostr ' and the base64 of event, a kind 27235 for url, method and the sha256 of body. The event verifies.",
    secret_key: bytesToHex(secretOf('library')), pubkey: s.pubkey(), url, method: 'POST', body, header,
    event: JSON.parse(new TextDecoder().decode(base64.decode(header.slice('Nostr '.length)))) as NostrEvent,
  };
}

/** An identity's lists as a generated identity publishes them (C§3.1). */
async function lists(s: LocalSigner, servers: string[], at: number) {
  return {
    relayList: await buildRelayList(s, WRITE.map((url) => ({ url, read: true, write: true })), at),
    serverList: await buildServerList(s, servers, at),
  };
}

async function move() {
  seed('move');
  const S = signerOf('move source');
  const T = signerOf('move target');
  const sKey = take(32);
  const tKey = take(32);
  const shared = 'https://shared.example/both';
  const tA = await text('# First\n\nThe first early share, with its text.');
  const tB = await text('# Both\n\nSaved on this phone early, and before that in the library.');
  const a = await save(S, sKey, item('https://example.com/first', { title: 'First', saved_at: T0 + 1 }), tA, SERVERS, T0 + 100);
  const b = await save(S, sKey, item(shared, { title: 'Both, as S saved it', saved_at: T0 + 2 }), tB, SERVERS, T0 + 101);
  const c = await save(S, sKey, item('https://example.com/no-text', { title: 'No text', saved_at: T0 + 3 }), null, SERVERS, T0 + 102);
  const tb = await save(T, tKey, item(shared, { title: 'Both, as T has it', state: 'archived', saved_at: T0 - 86_400 }), null, SERVERS, T0 - 86_000);
  return {
    about: "A move (C§4.8): three saves under S, one of whose hashes T already holds (archived on T, unread on S), and T's items expected after it: S's two others with text.servers listing T's servers, and T's own copy kept and only un-archived. Every event verifies and decrypts; a platform's move is checked by decrypting what it published under T.",
    defaults: DEFAULTS,
    source: { secret_key: bytesToHex(secretOf('move source')), pubkey: S.pubkey(), library_key: bytesToHex(sKey), library_key_record: await buildLibraryKeyEvent(S, sKey, T0 + 99), items: [a, b, c] },
    target: { secret_key: bytesToHex(secretOf('move target')), pubkey: T.pubkey(), library_key: bytesToHex(tKey), library_key_record: await buildLibraryKeyEvent(T, tKey, T0 - 86_100), items: [tb] },
    blobs: { [tA.sha256]: tA.blob, [tB.sha256]: tB.blob },
    expected: [
      { hash: a.hash, item: a.item },
      { hash: b.hash, item: { ...tb.item, state: 'unread' } },
      { hash: c.hash, item: c.item },
    ],
  };
}

async function restore() {
  seed('restore');
  const mnemonic = entropyToMnemonic(take(16), wordlist);
  const s = new LocalSigner(await secretKeyFromMnemonic(mnemonic, nodeCrypto));
  const key = take(32);
  const record = await buildLibraryKeyEvent(s, key, T0 + 1);
  const own = 'https://blossom.own.example';
  const { relayList, serverList } = await lists(s, [...SERVERS, own], T0 + 2);
  const tA = await text('# Kept\n\nA save that comes back with its text from the mirror.');
  const tB = await text('# Finished\n\nRead to the end and archived on another phone.');
  const tD = await text('# Elsewhere\n\nA text only a server in the 10063 still holds.');
  const A = await save(s, key, item('https://example.com/kept', { title: 'Kept', saved_at: T0 + 10 }), tA, SERVERS, T0 + 10);
  const bOld = await save(s, key, item('https://example.com/finished', { title: 'Finished', saved_at: T0 + 11 }), tB, SERVERS, T0 + 11);
  const B = await save(s, key, item('https://example.com/finished', { title: 'Finished', saved_at: T0 + 11, state: 'archived', progress: 1 }), tB, SERVERS, T0 + 500);
  const C = await save(s, key, item('https://example.com/removed', { title: 'Removed', saved_at: T0 + 12 }), null, SERVERS, T0 + 12);
  const D = await save(s, key, item('https://example.com/elsewhere', { title: 'Elsewhere', saved_at: T0 + 13 }), tD, [DEFAULTS.operator.blossom, 'https://mirror-gone.example'], T0 + 13);
  const E = await save(s, null, item('https://example.com/before-keys', { title: 'Saved before v1.10', saved_at: T0 - 1_000 }), null, SERVERS, T0 - 1_000);
  const [deletion] = await buildDeletions(s, [C.d], T0 + 600);
  const library = [record, relayList, serverList, A.event, B.event, C.event, D.event, E.event, deletion];
  return {
    about: "A restore with the operator absent (C§8): only the recovery code and the baked defaults. The operator's relay and Blossom server are off; the indexer and the two default relays hold the lists and the library (relay-a still holds an older copy of one save), a kind 5 removes one save, the mirror holds two texts and a server named only in the 10063 holds the third. expected is the library afterwards.",
    mnemonic, pubkey: s.pubkey(), library_key: bytesToHex(key), defaults: DEFAULTS,
    relays: {
      [DEFAULTS.indexer[0]]: [relayList],
      [DEFAULTS.relays[0]]: [...library.filter((e) => e !== B.event), bOld.event],
      [DEFAULTS.relays[1]]: library,
    },
    servers: {
      [DEFAULTS.mirrors[0]]: { [tA.sha256]: tA.blob, [tB.sha256]: tB.blob },
      [own]: { [tD.sha256]: tD.blob },
    },
    expected: {
      saves: [
        { hash: A.hash, title: 'Kept', state: 'unread', markdown: tA.markdown },
        { hash: B.hash, title: 'Finished', state: 'archived', markdown: tB.markdown },
        { hash: D.hash, title: 'Elsewhere', state: 'unread', markdown: tD.markdown },
        { hash: E.hash, title: 'Saved before v1.10', state: 'unread', markdown: null },
      ],
      deleted: [C.hash],
    },
  };
}

/** JSON with two-space indents, but an array of plain values (a tag, a list of relays) on one line. */
function pretty(v: unknown, pad = ''): string {
  const inner = `${pad}  `;
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return JSON.stringify(v).replace(/","/g, '", "');
    return v.length ? `[\n${v.map((x) => inner + pretty(x, inner)).join(',\n')}\n${pad}]` : '[]';
  }
  if (v && typeof v === 'object') {
    const e = Object.entries(v);
    return e.length ? `{\n${e.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pretty(x, inner)}`).join(',\n')}\n${pad}}` : '{}';
  }
  return JSON.stringify(v);
}

async function main() {
  const files: Record<string, unknown> = {
    'keys.json': await keys(),
    'text.json': await textBlob(),
    'items.json': await items(),
    'devices.json': await devices(),
    'save-request.json': await saveRequest(),
    'pair-acks.json': await pairAcks(),
    'pair-offer.json': await pairOffer(),
    'phone-pair.json': await phonePair(),
    'nip98.json': await nip98(),
    'move.json': await move(),
    'restore.json': await restore(),
  };
  const check = process.argv.includes('--check');
  let stale = 0;
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const json = `${pretty(body)}\n`;
    const path = join(out, name);
    if (!check) writeFileSync(path, json);
    else if ((() => { try { return readFileSync(path, 'utf8'); } catch { return null; } })() !== json) {
      console.error(`${name} is stale`);
      stale++;
    }
  }
  if (stale) {
    console.error('run: npx tsx shared/fixtures/build-protocol.ts');
    process.exit(1);
  }
  console.log(`${Object.keys(files).length} protocol fixtures${check ? ', current' : ` written to ${out}`}`);
}

void main();
