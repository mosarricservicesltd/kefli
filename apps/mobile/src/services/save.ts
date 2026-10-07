// A save from a shared link (mobile spec 5.4, contract 4.1–4.3): fetch and parse on the phone, encrypt and
// stage the text, record the item, and queue its outbox rows held, to be released when the share sheet closes
// without Undo. The outbox sends them (send.ts, runner.ts).
import { encryptText, isXPost, itemHash, textHash } from '@shelf/protocol';
import { ShelfParser } from '../../modules/shelf-parser/src';
import { phoneCrypto } from '../crypto/port';
import { getItem } from '../data/items';
import { queueSave } from '../data/saves';
import { indexText } from '../data/sync';
import { seedGeneratedLists } from '../data/lists';
import { loadDefaults } from './config';
import { ensureSigner } from './identity';
import { stageBlob } from './staging';
import { textFiles } from './textFiles';
import { fetchPage, type ParserResult } from './page';
import { checkXPost } from './xpost';
import { store } from './store';


export type SaveStep = { step: string; ok: boolean; detail: string };
/** hash null: nothing was saved (an X post with no article in it, share-noarticle). */
export type Queued = { hash: string | null; held: number[] };

export async function saveLink(url: string, report: (s: SaveStep) => void): Promise<Queued> {
  const say = (step: string, detail: string, ok = true) => report({ step, ok, detail });
  const now = () => Math.floor(Date.now() / 1000);
  const defaults = await loadDefaults();
  const signer = await ensureSigner();
  const db = store();
  seedGeneratedLists(db, signer.pubkey(), defaults);
  say('identity', `${signer.pubkey().slice(0, 12)}…`);
  const targets = { api: defaults.operator.api, blossom: defaults.operator.blossom, mirror: defaults.mirrors[0] };

  // A shared X post is never saved as itself (5.4, FD 78): nothing is written while it is checked; with no
  // article in it nothing is saved; offline, or with X's service failing, the post waits as a pending save (G3).
  let target = url;
  if (isXPost(url)) {
    say('x', 'checking the post');
    const x = await checkXPost({ fetch }, url);
    if (x.kind === 'none') {
      say('x', x.why === 'article' ? 'an X Article: nothing saved' : 'no article in that post: nothing saved', false);
      return { hash: null, held: [] };
    }
    if (x.kind !== 'article') {
      say('x', x.kind === 'offline' ? 'offline: the post waits' : 'X is not answering: the post waits');
      const hash = itemHash(url);
      const held = queueSave(db, now(), {
        owner: signer.pubkey(), hash, url, canonical: null, title: null, site: null, byline: null, savedAt: now(), words: null, lang: null,
        hero: null, text: null, textHash: null, textState: 'queued', sharedUrl: url, origin: 'share', xState: 'pending',
      }, null, { api: defaults.operator.api, blossom: defaults.operator.blossom, mirror: defaults.mirrors[0] });
      return { hash, held };
    }
    say('x', `the post links to ${new URL(x.url).hostname}`);
    target = x.url;
  }
  const outcome = await fetchPage({ fetch, parse: (b, t, u) => ShelfParser.parse(b, t, u) as Promise<ParserResult> }, target);
  const base = { owner: signer.pubkey(), canonical: null, title: null, site: null, byline: null, savedAt: now(), words: null, lang: null, hero: null, text: null, textHash: null, sharedUrl: url, origin: 'share' };
  if (outcome.kind !== 'parsed') {
    // Offline, the save waits on the phone keyed by the shared address, to be parsed when online (share-offline);
    // a page that can't be read is saved without text, and its row opens the original.
    say('parse', outcome.kind === 'offline' ? 'offline: saved, waiting to fetch' : `failed (${outcome.reason})`, outcome.kind === 'offline');
    const hash = itemHash(outcome.kind === 'offline' ? target : outcome.finalUrl);
    const held = queueSave(db, now(), {
      ...base, hash, url: outcome.kind === 'offline' ? target : outcome.finalUrl,
      textState: outcome.kind === 'offline' ? 'queued' : 'failed', failReason: outcome.kind === 'offline' ? null : outcome.reason,
    }, null, targets);
    return { hash, held };
  }
  const { result: parsed, finalUrl, words } = outcome;
  say('parse', `“${parsed.title}”, ${words} words`);
  const hash = itemHash(finalUrl, parsed.canonical);
  const enc = await encryptText(parsed.markdown, phoneCrypto);
  const staged = { sha256: enc.text.sha256, size: enc.blob.length, path: stageBlob(enc.text.sha256, enc.blob) };
  say('encrypt', `${enc.blob.length} bytes staged`);
  const held = queueSave(db, now(), {
    ...base, hash, url: finalUrl, canonical: parsed.canonical, title: parsed.title, site: parsed.site, byline: parsed.byline,
    words, lang: parsed.lang, hero: parsed.hero, text: enc.text, textHash: textHash(parsed.markdown, phoneCrypto), textState: 'cached',
  }, staged, targets);
  // The text is on the phone from the start, and searchable (4.1, 4.9); a repeat save keeps the text it had.
  const row = getItem(db, signer.pubkey(), hash);
  if (row && row.text_sha256 === enc.text.sha256) {
    textFiles.writeText(hash, parsed.markdown, outcome.derived);
    indexText(db, row, outcome.spoken);
  }
  say('queued', `${held.length} rows held until the sheet closes`);
  return { hash, held };
}
