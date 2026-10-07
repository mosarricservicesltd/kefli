// A save from a shared link (mobile spec 5.4, contract 4.1–4.3): fetch and parse on the phone, encrypt and
// stage the text, record the item, and queue its outbox rows held, to be released when the share sheet closes
// without Undo. The outbox sends them (send.ts, runner.ts).
import { base64 } from '@scure/base';
import { countWords, encryptText, itemHash, textHash } from '@shelf/protocol';
import { ShelfParser } from '../../modules/shelf-parser/src';
import { phoneCrypto } from '../crypto/port';
import { queueSave } from '../data/saves';
import { seedGeneratedLists } from '../data/lists';
import { loadDefaults } from './config';
import { ensureSigner } from './identity';
import { stageBlob } from './staging';
import { store } from './store';

const UA = 'Mozilla/5.0 (Linux; Android 17; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36';
const GUARD_WORDS = 120;

export type SaveStep = { step: string; ok: boolean; detail: string };
export type Queued = { hash: string; held: number[] };

export async function saveLink(url: string, report: (s: SaveStep) => void): Promise<Queued> {
  const say = (step: string, detail: string, ok = true) => report({ step, ok, detail });
  const now = () => Math.floor(Date.now() / 1000);
  const defaults = await loadDefaults();
  const signer = await ensureSigner();
  const db = store();
  seedGeneratedLists(db, signer.pubkey(), defaults);
  say('identity', `${signer.pubkey().slice(0, 12)}…`);

  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const finalUrl = res.url || url;
  say('fetch', `HTTP ${res.status}, ${Math.round(bytes.length / 1024)} KB`, res.ok);
  const parsed = await ShelfParser.parse(base64.encode(bytes), res.headers.get('content-type') ?? '', finalUrl);
  const words = parsed.ok ? countWords(parsed.markdown) : 0;
  // contract 4.2's guard: not readerable and under 120 spoken words is a failed parse.
  const good = parsed.ok && (parsed.readerable || words >= GUARD_WORDS);
  say('parse', good && parsed.ok ? `“${parsed.title}”, ${words} words` : `failed parse (${parsed.ok ? 'the guard' : parsed.reason})`);

  const canonical = parsed.ok ? parsed.canonical : null;
  const hash = itemHash(finalUrl, canonical);
  let staged: { sha256: string; size: number; path: string } | null = null;
  let text: { sha256: string; key: string; nonce: string } | null = null;
  let hashOfText: string | null = null;
  if (good && parsed.ok) {
    const enc = await encryptText(parsed.markdown, phoneCrypto);
    text = enc.text;
    hashOfText = textHash(parsed.markdown, phoneCrypto);
    staged = { sha256: enc.text.sha256, size: enc.blob.length, path: stageBlob(enc.text.sha256, enc.blob) };
    say('encrypt', `${enc.blob.length} bytes staged`);
  }
  const held = queueSave(db, now(), {
    owner: signer.pubkey(), hash, url: finalUrl, canonical,
    title: parsed.ok ? parsed.title : null, site: parsed.ok ? parsed.site : null, byline: parsed.ok ? parsed.byline : null,
    savedAt: now(), words: good ? words : null, lang: parsed.ok ? parsed.lang : null, hero: parsed.ok ? parsed.hero : null,
    text, textHash: hashOfText, textState: good ? 'cached' : 'failed', failReason: good ? null : 'not_readable',
    sharedUrl: url, origin: 'share',
  }, staged, {
    api: defaults.operator.api, blossom: defaults.operator.blossom, mirror: defaults.mirrors[0],
  });
  say('queued', `${held.length} rows held until the sheet closes`);
  return { hash, held };
}
