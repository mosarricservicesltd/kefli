// The week-0 gates that run in JavaScript on the phone (mobile spec 12): quick-crypto on a release build,
// Schnorr and NIP-44 timing, and the hash- and count-critical protocol code on Hermes against values Node
// computed. Each gate returns a result; the screen logs every result to logcat under [shelf-gates].

import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  LocalSigner, NotALinkError, derivePairCode, normalise, normaliseMarkdown, project, secretKeyFromMnemonic, sentences, textHash,
} from '@shelf/protocol';
import { phoneCrypto } from '../crypto/port';

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
    id: 'schnorr-timing',
    title: 'Schnorr timing: verify median ≤ 10 ms, 1,000-item restore ≤ 20 s (spec 11.3)',
    async run() {
      const signer = new LocalSigner(generateSecretKey());
      const peer = getPublicKey(generateSecretKey());
      // 50 real saves, each copied 20 times as plain JSON, so verifyEvent can't use its cache of events it signed.
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
        if (!verifyEvent(e)) fail('a fresh copy failed to verify');
        one.push(now() - t);
      }
      one.sort((x, y) => x - y);
      const median = one[25];
      const t1 = now();
      for (let i = 0; i < 1000; i++) {
        const e = JSON.parse(signed[i % 50]);
        if (!verifyEvent(e)) fail('restore verify');
        JSON.parse(await signer.nip44Decrypt(signer.pubkey(), e.content));
      }
      const restore = now() - t1;
      const convo = await timed(20, () => nip44.utils.getConversationKey(generateSecretKey(), peer));
      const verdict = median <= 10 && restore <= 20_000;
      const detail = `verify median ${ms(median)}, 1,000-item restore ${(restore / 1000).toFixed(1)} s, sign ${ms(sign)}, ECDH ${ms(convo)}`;
      if (!verdict) fail(`over the bar: ${detail}`);
      return detail;
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

export async function runGate(g: Gate): Promise<GateResult> {
  const t = now();
  try {
    const detail = await g.run();
    return { id: g.id, ok: true, detail, ms: Math.round(now() - t) };
  } catch (e) {
    return { id: g.id, ok: false, detail: (e as Error).message ?? String(e), ms: Math.round(now() - t) };
  }
}
