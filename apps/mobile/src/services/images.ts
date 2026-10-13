// Fetching article images (mobile spec 4.5 phase 6, 5.6): one at a time, http(s) only, at most 5 MB and 20 s with no
// cookies (net/http.ts), kept only if the bytes are an image the Reader can draw. The store stays within 200 MB by
// evicting archived articles' images first. Ports, like sync, so this runs in tests.
import { isPublicWebUrl } from '@kefli/protocol';
import { articleBlocks } from '../reader/blocks';
import { imageKind, imageSize } from '../reader/imageSize';
import type { SqlDb } from '../data/db';
import { open, TimedOut, TooLarge } from '../net/http';
import {
  MAX_IMAGE_BYTES, evictions, forget, getImage, imagesOf, keptArticles, needsFetch, recordFailed, recordImage, wanted,
} from '../data/images';

export type ImagePorts = {
  db: SqlDb;
  now: () => number;
  fetch: typeof fetch;
  /** The file name an image is kept under: the sha256 of its address (4.1). */
  nameOf: (url: string) => string;
  files: { write: (name: string, bytes: Uint8Array) => string; remove: (path: string) => void };
  /** The article's derived blocks (textFiles.readArticle), so finding its images never re-parses its text. */
  readArticle: (hash: string) => { blocks: { kind: string; src?: string }[] } | null;
};

/** The image addresses in an article, in reading order. */
export function articleImages(markdown: string): string[] {
  const out: string[] = [];
  for (const b of articleBlocks(markdown).blocks) if (b.kind === 'img' && !out.includes(b.src)) out.push(b.src);
  return out;
}

/** The user agent page fetches use (5.4); some image servers refuse requests without a browser's. */
export const IMAGE_UA = 'Mozilla/5.0 (Linux; Android 17; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36';

/** A page's 20 s (5.4), over the headers and the whole body. */
export const IMAGE_TIMEOUT_MS = 20_000;

export type Fetched = 'ok' | 'failed' | 'offline' | 'skipped';

export async function fetchImage(p: ImagePorts, owner: string, url: string, hash: string): Promise<Fetched> {
  // a page's image may name any address: only public web ones are fetched, never this phone's network (F26)
  if (!/^https?:\/\//i.test(url) || !isPublicWebUrl(url)) return 'skipped';
  const fail = () => {
    recordFailed(p.db, url, hash, p.now());
    return 'failed' as const;
  };
  let bytes: Uint8Array;
  try {
    const o = await open(p.fetch, url, { headers: { 'User-Agent': IMAGE_UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' } }, IMAGE_TIMEOUT_MS);
    if (!o.res.ok) {
      o.done();
      return fail();
    }
    bytes = await o.read(MAX_IMAGE_BYTES);
  } catch (e) {
    // a host too slow or too big is that image's failure, tried again in a day, so it can't hold up every sync (F12)
    return e instanceof TimedOut || e instanceof TooLarge ? fail() : 'offline';
  }
  if (!imageKind(bytes)) return fail();
  for (const r of evictions(p.db, owner, bytes.length, hash)) {
    if (r.path) p.files.remove(r.path);
    forget(p.db, [r.url]);
  }
  const size = imageSize(bytes);
  const path = p.files.write(p.nameOf(url), bytes);
  recordImage(p.db, url, hash, path, bytes.length, size?.w ?? null, size?.h ?? null, p.now());
  return 'ok';
}

async function fetchAll(p: ImagePorts, owner: string, list: { url: string; hash: string }[]): Promise<number> {
  let n = 0;
  for (const { url, hash } of list) {
    const r = await fetchImage(p, owner, url, hash);
    if (r === 'offline') break;
    if (r === 'ok') n++;
  }
  return n;
}

const urlsOf = (p: ImagePorts) => (hash: string) => {
  const out: string[] = [];
  for (const b of p.readArticle(hash)?.blocks ?? []) if (b.kind === 'img' && b.src && !out.includes(b.src)) out.push(b.src);
  return out;
};

/** The article being opened: its images now, on any network (4.5: on metered networks, when an article opens). */
export function fetchArticleImages(p: ImagePorts, owner: string, hash: string): Promise<number> {
  return fetchAll(p, owner, wanted(p.db, [hash], urlsOf(p), p.now()));
}

/** Phase 6 on an unmetered network: the newest 50 unread articles' images. */
export function syncImages(p: ImagePorts, owner: string): Promise<number> {
  return fetchAll(p, owner, wanted(p.db, keptArticles(p.db, owner), urlsOf(p), p.now()));
}

/** An article's images go with it. */
export function removeImages(p: Pick<ImagePorts, 'db' | 'files'>, hash: string): void {
  const rows = imagesOf(p.db, hash);
  for (const r of rows) if (r.path) p.files.remove(r.path);
  forget(p.db, rows.map((r) => r.url));
}

/** Whether an image is on the phone, waiting, or not coming (failed within the last day). */
export function imageState(db: SqlDb, url: string, now: number): 'here' | 'waiting' | 'failed' {
  const r = getImage(db, url);
  if (r?.path) return 'here';
  return needsFetch(r, now) ? 'waiting' : 'failed';
}
