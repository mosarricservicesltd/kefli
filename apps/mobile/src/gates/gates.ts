// The week-0 gates that run in JavaScript on the phone (mobile spec 12): quick-crypto on a release build,
// Schnorr and NIP-44 timing, and the hash- and count-critical protocol code on Hermes against values Node
// computed. Each gate returns a result; the screen logs every result to logcat under [shelf-gates].

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import {
  LocalSigner, NotALinkError, checkSecp, countWords, conversationKey, nobleSecp, verifyEventWith, derivePairCode, normalise, normaliseMarkdown, project, secretKeyFromMnemonic, sentences, textHash,
} from '@shelf/protocol';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import { ShelfParser } from '../../modules/shelf-parser/src';
import { runLive, type LiveUrl } from './live';
import type { Bip340Vector, SecpPort } from '@shelf/protocol';

/* eslint-disable @typescript-eslint/no-require-imports */
const NORMALISE = require('../../../../shared/normalise.fixtures.json') as { cases: { name: string; url: string; canonical?: string; expect: string | null }[] };
const NIP44 = require('../../../../packages/protocol/test/vectors/nip44.vectors.json').v2.valid.encrypt_decrypt as {
  sec1: string; sec2: string; conversation_key: string; nonce: string; plaintext: string; payload: string;
}[];
const COVER_FIXTURES = require('../../../../shared/cover/fixtures.json');
const ShelfCover = require('../../../../shared/cover/cover-v1.js');
const EXPECTED = require('./expected.json') as {
  raw: string; markdown: string; textHash: string; text: string; offsets: number[]; wordStarts: number[]; sentences: [number, string][];
}[];
const BIP340 = require('./bip340.json') as Bip340Vector[];
/* eslint-enable @typescript-eslint/no-require-imports */

export type GateResult = { id: string; ok: boolean; detail: string; ms: number };
type Gate = { id: string; title: string; run: () => Promise<string> };

const now = () => performance.now();
const fail = (msg: string): never => {
  throw new Error(msg);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = (s: string) => bytesToHex(phoneCrypto.sha256(utf8ToBytes(s)));
const timed = async (n: number, f: () => unknown) => {
  const t = now();
  for (let i = 0; i < n; i++) await f();
  return (now() - t) / n;
};
const ms = (x: number) => `${x < 10 ? x.toFixed(2) : Math.round(x)} ms`;

export const GATES: Gate[] = [
  {
    id: 'crypto-global',
    title: 'quick-crypto as globalThis.crypto',
    async run() {
      const b = globalThis.crypto?.getRandomValues?.(new Uint8Array(32));
      if (!b || b.every((x) => x === 0)) fail('getRandomValues missing or returned zeros');
      return 'getRandomValues works, installed before nostr-tools loads';
    },
  },
  {
    id: 'aes-gcm',
    title: 'AES-256-GCM (NIST case 14 and a round trip)',
    async run() {
      const blob = await phoneCrypto.aesGcmEncrypt(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16));
      if (bytesToHex(blob) !== 'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919') fail(`vector gave ${bytesToHex(blob)}`);
      const key = phoneCrypto.randomBytes(32), iv = phoneCrypto.randomBytes(12);
      const text = utf8ToBytes('x'.repeat(84_000));
      const t = now();
      const enc = await phoneCrypto.aesGcmEncrypt(key, iv, text);
      const dec = await phoneCrypto.aesGcmDecrypt(key, iv, enc);
      const took = now() - t;
      if (bytesToHex(dec) !== bytesToHex(text)) fail('round trip differs');
      enc[0] ^= 1;
      const refused = await phoneCrypto.aesGcmDecrypt(key, iv, enc).then(() => false, () => true);
      if (!refused) fail('a tampered blob decrypted');
      return `vector matches; 84 KB round trip ${ms(took)}; tampering refused`;
    },
  },
  {
    id: 'scrypt',
    title: 'Typed-code scrypt through quick-crypto',
    async run() {
      const t = now();
      const { lookup } = await derivePairCode('K7QM4XPD', phoneCrypto);
      const took = now() - t;
      if (lookup !== '8a0b73e641602ecd6e49f3c64dee51f053f79edfdea90594c8df40de02202d76') fail(`lookup ${lookup}`);
      return `lookup matches in ${ms(took)} (2,600 ms in JavaScript)`;
    },
  },
  {
    id: 'nip06',
    title: 'Recovery-code key (PBKDF2 through quick-crypto)',
    async run() {
      const t = now();
      const sk = await secretKeyFromMnemonic('leader monkey parrot ring guide accident before fence cannon height naive bean', phoneCrypto);
      const took = now() - t;
      if (bytesToHex(sk) !== '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a') fail('NIP-06 example key differs');
      return `NIP-06 example matches in ${ms(took)}`;
    },
  },
  {
    id: 'nostr',
    title: 'finalizeEvent and nip44.v2 on a release build',
    async run() {
      const sk = generateSecretKey();
      const ev = finalizeEvent({ kind: 30078, created_at: 1, tags: [['d', 'shelf/item/x']], content: 'hi' }, sk);
      if (!verifyEvent(ev)) fail('signed event does not verify');
      let n = 0;
      for (const v of NIP44) {
        const key = nip44.utils.getConversationKey(hexToBytes(v.sec1), getPublicKey(hexToBytes(v.sec2)));
        if (bytesToHex(key) !== v.conversation_key) fail(`vector ${n} conversation key`);
        if (nip44.encrypt(v.plaintext, key, hexToBytes(v.nonce)) !== v.payload) fail(`vector ${n} payload`);
        if (nip44.decrypt(v.payload, key) !== v.plaintext) fail(`vector ${n} decrypt`);
        n++;
      }
      const s = new LocalSigner(generateSecretKey());
      const c = await s.nip44Encrypt(s.pubkey(), 'shelf-probe');
      if ((await s.nip44Decrypt(s.pubkey(), c)) !== 'shelf-probe') fail('self-encryption round trip');
      return `signs and verifies; all ${n} NIP-44 vectors pass; self-encryption round trips`;
    },
  },
  {
    id: 'secp-native',
    title: 'shelf-secp: BIP-340 vectors through libsecp256k1',
    async run() {
      const bad = checkSecp(nativeSecp, BIP340);
      if (bad.length) fail(bad.join(', '));
      const sk = generateSecretKey();
      const peer = getPublicKey(generateSecretKey());
      if (bytesToHex(conversationKey(nativeSecp, sk, peer)) !== bytesToHex(nip44.utils.getConversationKey(sk, peer))) fail('NIP-44 conversation key differs from noble');
      const ev = new LocalSigner(sk, nativeSecp);
      const signed = await ev.signEvent({ kind: 1, created_at: 1, tags: [], content: 'x' });
      if (!verifyEvent(JSON.parse(JSON.stringify(signed))) || !verifyEventWith(nobleSecp, signed)) fail('noble refuses a native signature');
      return `all ${BIP340.length} vectors pass; conversation key matches noble; native signatures verify in noble`;
    },
  },
  {
    id: 'schnorr-timing',
    title: 'Schnorr timing with shelf-secp: verify median ≤ 10 ms, 1,000-item restore ≤ 20 s (spec 11.3)',
    run: () => schnorrTiming(nativeSecp),
  },
  {
    id: 'schnorr-timing-noble',
    title: 'For comparison: the same with noble in JavaScript',
    run: () => schnorrTiming(nobleSecp, false),
  },
  {
    id: 'parser',
    title: 'The twenty fixture pages: desktop Chrome’s parse, text_hash and words on the phone',
    async run() {
      // shared/fixtures (contract 9), served by server/dev/api.mjs over adb reverse, so the pages stay out of the bundle.
      const base = 'http://localhost:8447/fixtures';
      const index = (await (await fetch(`${base}/pages/pages.json`)).json()) as { id: string; url: string; contentType: string }[];
      const expected = (await (await fetch(`${base}/expected.json`)).json()) as { chrome: string; pages: Record<string, unknown>[] };
      const bad: string[] = [];
      const times: number[] = [];
      for (const p of index) {
        const want = expected.pages.find((e) => e.id === p.id)!;
        const bytes = new Uint8Array(await (await fetch(`${base}/pages/${p.id}.html`)).arrayBuffer());
        const t = now();
        const got = (await ShelfParser.parse(base64.encode(bytes), p.contentType, p.url)) as Record<string, unknown>;
        times.push(now() - t);
        for (const k of ['ok', 'title', 'byline', 'site', 'lang', 'hero', 'canonical', 'readerable', 'markdown', 'reason']) {
          if (!same(got[k], want[k])) bad.push(`${p.id}: ${k}`);
        }
        const md = typeof got.markdown === 'string' ? got.markdown : null;
        if (md !== null && textHash(md, phoneCrypto) !== want.text_hash) bad.push(`${p.id}: text_hash`);
        if (md !== null && (project(md).text !== want.spoken || countWords(md) !== want.words)) bad.push(`${p.id}: spoken or words`);
      }
      const matched = index.length - new Set(bad.map((b) => b.split(':')[0])).size;
      if (bad.length) fail(`${matched}/${index.length} match ${expected.chrome}; differ: ${bad.slice(0, 6).join('; ')}`);
      return `${matched}/${index.length} pages match ${expected.chrome}: every field, the Markdown, text_hash, the spoken text and words; first ${ms(times[0])} (WebView start), then ${ms(Math.max(...times.slice(1)))} at most`;
    },
  },
  {
    id: 'parser-live',
    title: 'shelf-parser on a live page, fetched as bytes',
    async run() {
      const url = 'https://en.wikipedia.org/wiki/Bookmark_(digital)';
      const t = now();
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 17; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36', Accept: 'text/html' } });
      if (res.status !== 200) return fail(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const fetched = now() - t;
      const t2 = now();
      const r = await ShelfParser.parse(base64.encode(bytes), res.headers.get('content-type') ?? '', res.url || url);
      const parsed = now() - t2;
      if (!r.ok) return fail(`${r.reason} ${r.message ?? ''}`);
      const words = countWords(r.markdown);
      if (words < 200 || !r.title) return fail(`not an article: ${words} words, title ${r.title}`);
      return `${Math.round(bytes.length / 1024)} KB fetched in ${ms(fetched)}, parsed in ${ms(parsed)}: “${r.title}”, ${words} words, canonical ${r.canonical ? 'found' : 'none'}`;
    },
  },
  {
    id: 'live-list',
    title: 'The live list of thirty addresses through the share’s own path (stage 1: 20/30)',
    async run() {
      const list = ((await (await fetch('http://localhost:8447/fixtures/live-urls.json')).json()) as { urls: LiveUrl[] }).urls;
      const results = await runLive({ fetch, parse: (b, t, u) => ShelfParser.parse(b, t, u) as never }, { fetch }, list, now);
      for (const r of results) console.log(`[shelf-live] ${JSON.stringify(r)}`);
      const passed = results.filter((r) => r.pass).length;
      const misses = results.filter((r) => !r.pass).map((r) => `${r.kind}: ${r.got} for ${r.expect}`);
      const line = `${passed}/${results.length} as expected${misses.length ? `; misses: ${misses.join('; ')}` : ''}`;
      if (passed < 20) fail(line);
      return line;
    },
  },
  {
    id: 'cleartext',
    title: 'Cleartext only to localhost (the local build)',
    async run() {
      const local = await fetch('http://localhost:8447/defaults.json').then((r) => r.status, (e) => `refused: ${(e as Error).message}`);
      if (local !== 200) fail(`localhost: ${local}`);
      const outside = await fetch('http://neverssl.com/').then((r) => `allowed, HTTP ${r.status}`, () => 'refused');
      if (outside !== 'refused') fail(`a public http:// host was ${outside}`);
      return 'http://localhost answers; http://neverssl.com is refused';
    },
  },
  {
    id: 'normalise',
    title: 'normalise fixtures on Hermes (whatwg-url, tr46)',
    async run() {
      const bad: string[] = [];
      for (const c of NORMALISE.cases) {
        let got: string | null;
        try {
          got = normalise(c.url, c.canonical);
        } catch (e) {
          if (!(e instanceof NotALinkError)) bad.push(`${c.name}: threw ${(e as Error).message}`);
          got = null;
        }
        if (got !== c.expect) bad.push(`${c.name}: ${got}`);
      }
      if (bad.length) fail(`${bad.length} of ${NORMALISE.cases.length} differ: ${bad.slice(0, 3).join('; ')}`);
      return `all ${NORMALISE.cases.length} cases match`;
    },
  },
  {
    id: 'unicode',
    title: 'Hermes Unicode: NFC and \\p{…} regexes',
    async run() {
      if ('café'.normalize('NFC') !== 'café') fail('normalize NFC');
      if ('ﬁ'.normalize('NFC') !== 'ﬁ') fail('NFC changed a compatibility ligature');
      if (!/^\p{Lu}$/u.test('É') || /^\p{Lu}$/u.test('é') || !/^\p{Nd}$/u.test('٣')) fail('\\p{} property escapes');
      return 'NFC and Unicode property escapes behave as on V8';
    },
  },
  {
    id: 'projection',
    title: 'text_hash, projection, offsets and sentences against Node',
    async run() {
      const bad: string[] = [];
      EXPECTED.forEach((e, n) => {
        const md = normaliseMarkdown(e.raw);
        if (md !== e.markdown) bad.push(`${n} markdown`);
        if (textHash(md, phoneCrypto) !== e.textHash) bad.push(`${n} text_hash`);
        const p = project(md);
        if (p.text !== e.text) bad.push(`${n} text`);
        if (!same(p.offsets, e.offsets)) bad.push(`${n} offsets`);
        if (!same(p.wordStarts, e.wordStarts)) bad.push(`${n} words`);
        if (!same(sentences(p).map((s) => [s.firstWord, s.text]), e.sentences)) bad.push(`${n} sentences`);
      });
      if (bad.length) fail(bad.join(', '));
      return `all ${EXPECTED.length} samples match Node exactly`;
    },
  },
  {
    id: 'cover-fixtures',
    title: 'Cover v1 fixtures on Hermes',
    async run() {
      const F = COVER_FIXTURES;
      const C = ShelfCover;
      if (C.version !== F.version) fail('cover version');
      const leaf = (l: Record<string, unknown>) => ({ x: l.x, y: l.y, s: l.s, d: l.d, mod: l.mod, rot: l.rot, bg: l.bg, fg: l.fg });
      const bad: string[] = [];
      const t = now();
      for (const c of F.cases) {
        const h = c.hash;
        const P = C.palette(h), N = C.night(h);
        const got: Record<string, unknown> = {
          palette: { ground: P.ground, deep: P.deep, soft: P.soft, signal: P.signal, hue: P.hue, scheme: P.scheme, dark: P.dark },
          night: { bg: N.bg, text: N.text, muted: N.muted, line: N.line, hl: N.hl },
        };
        for (const d of ['1', '2', '3']) if (!same(C.leaves(h, { depth: Number(d) }).map(leaf), c.leaves[d])) bad.push(`${c.id} leaves ${d}`);
        if (C.svg(h, F.svg.variants.size64depth2) !== c.svg.size64depth2) bad.push(`${c.id} svg`);
        for (const k of Object.keys(F.svg.variants)) if (sha(C.svg(h, F.svg.variants[k])) !== c.svg.sha256[k]) bad.push(`${c.id} svg ${k}`);
        const ink: Record<string, string> = {};
        for (const k of Object.keys(F.surfaces)) ink[k] = C.lineInk(h, F.surfaces[k].bg, F.surfaces[k].text);
        ink.readerNight = N.line;
        const hl: Record<string, string> = {};
        for (const k of Object.keys(F.reading)) if (typeof F.reading[k] === 'object') hl[k] = C.highlight(h, F.reading[k]);
        hl.night = N.hl;
        for (const [k, v] of Object.entries({ ...got, lineInk: ink, highlight: hl })) if (!same(v, c[k])) bad.push(`${c.id} ${k}`);
      }
      const took = now() - t;
      if (bad.length) fail(`${bad.length} differ: ${bad.slice(0, 4).join(', ')}`);
      return `all ${F.cases.length} cases match, every value, in ${ms(took)}`;
    },
  },
];

async function schnorrTiming(secp: SecpPort, enforce = true): Promise<string> {
  const signer = new LocalSigner(generateSecretKey(), secp);
  const peer = getPublicKey(generateSecretKey());
  // 50 real saves, each copied 20 times as plain JSON, so no verified flag is cached on them.
  const item = JSON.stringify({ v: 1, url: 'https://example.com/a', title: 'A title of ordinary length', words: 2450, text: null });
  const signed: string[] = [];
  const t0 = now();
  for (let i = 0; i < 50; i++) {
    const content = await signer.nip44Encrypt(signer.pubkey(), item);
    signed.push(JSON.stringify(await signer.signEvent({ kind: 30078, created_at: i, tags: [['d', `shelf/item/${i}`], ['t', 'shelf']], content })));
  }
  const sign = (now() - t0) / 50;
  const one: number[] = [];
  for (let i = 0; i < 50; i++) {
    const e = JSON.parse(signed[i]);
    const t = now();
    if (!verifyEventWith(secp, e)) fail('a fresh copy failed to verify');
    one.push(now() - t);
  }
  one.sort((x, y) => x - y);
  const median = one[25];
  const t1 = now();
  for (let i = 0; i < 1000; i++) {
    const e = JSON.parse(signed[i % 50]);
    if (!verifyEventWith(secp, e)) fail('restore verify');
    JSON.parse(await signer.nip44Decrypt(signer.pubkey(), e.content));
  }
  const restore = now() - t1;
  const ecdh = await timed(20, () => conversationKey(secp, generateSecretKey(), peer));
  const detail = `verify median ${ms(median)}, 1,000-item restore ${(restore / 1000).toFixed(1)} s, sign ${ms(sign)}, ECDH ${ms(ecdh)}`;
  if (enforce && (median > 10 || restore > 20_000)) fail(`over the bar: ${detail}`);
  return detail;
}

export async function runGate(g: Gate): Promise<GateResult> {
  const t = now();
  try {
    const detail = await g.run();
    return { id: g.id, ok: true, detail, ms: Math.round(now() - t) };
  } catch (e) {
    return { id: g.id, ok: false, detail: (e as Error).message ?? String(e), ms: Math.round(now() - t) };
  }
}
