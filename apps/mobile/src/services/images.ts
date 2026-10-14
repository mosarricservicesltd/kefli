// Fetching article images (mobile spec 4.5 phase 6, 5.6): one at a time, http(s) only, at most 5 MB and 20 s with no
// cookies, through redirects followed by hand, each to a public address (net/http.ts), kept only if the bytes are an
// image the Reader can draw. The store stays within 200 MB by evicting archived articles' images first, and an image
// that won't fit beside the open article's own is left out.
// A page can name thousands, or images from servers that never answer: an article's first 500 are fetched, a run
// stops at three time-outs in a row or once it has fetched the store's budget, and an image already on its way isn't
// asked for twice. Ports, like sync, so this runs in tests.
import { isPublicWebUrl } from '@kefli/protocol';
import { articleBlocks } from '../reader/blocks';
import { LIMITS } from '../reader/limits';
import { drawable, imageKind, imageSize } from '../reader/imageSize';
import type { SqlDb } from '../data/db';
import { Blocked, open, TimedOut, TooLarge, WEB_HOPS } from '../net/http';
import {
  MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, evictions, forget, getImage, heldBytes, imagesOf, keptArticles, needsFetch, recordFailed, recordImage, wanted,
  type ImageRow,
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
  /** The store's budget in bytes: MAX_TOTAL_BYTES, unless a test sets less. */
  budget?: number;
};

/** An article's images fetched and shown at most; past them a figure is left out, as a failed one is (5.6). */
export const MAX_ARTICLE_IMAGES = LIMITS.images;

/** Images in a row that time out before a run stops, the rest waiting for the next, as pages do (pending.ts, F12). */
export const SLOW_RUN = 3;

/** An article's distinct image addresses, in reading order, the first MAX_ARTICLE_IMAGES of them. */
export function imageUrls(blocks: { kind: string; src?: string }[]): string[] {
  const seen = new Set<string>();
  for (const b of blocks) {
    if (seen.size >= MAX_ARTICLE_IMAGES) break;
    if (b.kind === 'img' && b.src) seen.add(b.src);
  }
  return [...seen];
}

/** The image addresses in an article, in reading order. */
export function articleImages(markdown: string): string[] {
  return imageUrls(articleBlocks(markdown).blocks);
}

/** The user agent page fetches use (5.4); some image servers refuse requests without a browser's. */
export const IMAGE_UA = 'Mozilla/5.0 (Linux; Android 17; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36';

/** A page's 20 s (5.4), over the headers and the whole body. */
export const IMAGE_TIMEOUT_MS = 20_000;

/**
 * The formats asked for: only those kept (imageKind). Naming AVIF first, as a browser does, had servers that choose
 * by what is asked for send AVIF, which the store then refused, so their images never showed.
 */
export const IMAGE_ACCEPT = 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5';

/** skipped: not fetched, as not this phone's to ask for, or on its way already. */
export type Fetched = 'ok' | 'failed' | 'offline' | 'skipped';
/** What a run counts: a failure by the deadline is slow, and a run of them ends it. */
type Counted = Fetched | 'slow';

// built from a string: the code gate's parser reads a regex literal's escaped slashes as a comment
const WEB = new RegExp('^https?://', 'i');

/** Addresses being fetched now: a second run for the same image (the Reader opened twice, a sync) passes it by. */
const inFlight = new Set<string>();

/** What to evict for incoming bytes of an article, or null when even evicting all it may won't make room. */
function room(p: ImagePorts, owner: string, incoming: number, hash: string): ImageRow[] | null {
  const budget = p.budget ?? MAX_TOTAL_BYTES;
  const out = evictions(p.db, owner, incoming, hash, budget);
  const freed = out.reduce((s, r) => s + (r.bytes ?? 0), 0);
  return heldBytes(p.db) + incoming - freed > budget ? null : out;
}

/**
 * The image's bytes, or how it failed: a redirect onto this phone's network is never followed, nor one ending there
 * kept (F26), and either is that image's failure, not the network's, so the images after it are still fetched.
 */
async function download(p: ImagePorts, url: string): Promise<Uint8Array | Exclude<Counted, 'ok'>> {
  try {
    const o = await open(p.fetch, url, { headers: { 'User-Agent': IMAGE_UA, Accept: IMAGE_ACCEPT } }, IMAGE_TIMEOUT_MS, WEB_HOPS);
    if (!o.res.ok) {
      o.done();
      return 'failed';
    }
    return await o.read(MAX_IMAGE_BYTES);
  } catch (e) {
    // a host too slow or too big is that image's failure, tried again in a day, so it can't hold up every sync (F12)
    if (e instanceof TimedOut) return 'slow';
    return e instanceof TooLarge || e instanceof Blocked ? 'failed' : 'offline';
  }
}

/** One image fetched and kept, when it is an image the Reader can draw and the store has room for it. */
async function fetchOne(p: ImagePorts, owner: string, url: string, hash: string): Promise<Counted> {
  const fail = (why: 'failed' | 'slow' = 'failed') => {
    recordFailed(p.db, url, hash, p.now());
    return why;
  };
  // the store already full of the open article's own images: nothing is downloaded only to be thrown away
  if (!room(p, owner, 1, hash)) return fail();
  const bytes = await download(p, url);
  if (!(bytes instanceof Uint8Array)) return bytes === 'offline' ? bytes : fail(bytes as 'failed' | 'slow');
  const size = imageSize(bytes);
  const out = imageKind(bytes) && drawable(size) ? room(p, owner, bytes.length, hash) : null;
  if (!out) return fail();
  removeRows(p, out);
  const path = p.files.write(p.nameOf(url), bytes);
  recordImage(p.db, url, hash, path, bytes.length, size?.w ?? null, size?.h ?? null, p.now());
  return 'ok';
}

async function fetchCounted(p: ImagePorts, owner: string, url: string, hash: string): Promise<Counted> {
  // a page's image may name any address: only public web ones are fetched, never this phone's network (F26)
  if (!WEB.test(url) || !isPublicWebUrl(url) || inFlight.has(url)) return 'skipped';
  inFlight.add(url);
  try {
    return await fetchOne(p, owner, url, hash);
  } finally {
    inFlight.delete(url);
  }
}

export async function fetchImage(p: ImagePorts, owner: string, url: string, hash: string): Promise<Fetched> {
  const r = await fetchCounted(p, owner, url, hash);
  return r === 'slow' ? 'failed' : r;
}

/** Fetches the list in order until the network goes, SLOW_RUN time out in a row, or the run has fetched the budget. */
async function fetchAll(p: ImagePorts, owner: string, list: { url: string; hash: string }[]): Promise<number> {
  let n = 0;
  let slow = 0;
  let fetched = 0;
  for (const { url, hash } of list) {
    const r = await fetchCounted(p, owner, url, hash);
    slow = r === 'slow' ? slow + 1 : 0;
    if (r === 'offline' || slow >= SLOW_RUN) break;
    if (r !== 'ok') continue;
    n++;
    // a run that has fetched a whole store's worth stops: the next run carries on, the network spared the churn
    fetched += getImage(p.db, url)?.bytes ?? 0;
    if (fetched >= (p.budget ?? MAX_TOTAL_BYTES)) break;
  }
  return n;
}

const urlsOf = (p: ImagePorts) => (hash: string) => imageUrls(p.readArticle(hash)?.blocks ?? []);

/** The article being opened: its images now, on any network (4.5: on metered networks, when an article opens). */
export function fetchArticleImages(p: ImagePorts, owner: string, hash: string): Promise<number> {
  return fetchAll(p, owner, wanted(p.db, [hash], urlsOf(p), p.now()));
}

/** Phase 6 on an unmetered network: the newest 50 unread articles' images. */
export function syncImages(p: ImagePorts, owner: string): Promise<number> {
  return fetchAll(p, owner, wanted(p.db, keptArticles(p.db, owner), urlsOf(p), p.now()));
}

/** Images let go: their files, then their rows. */
function removeRows(p: Pick<ImagePorts, 'db' | 'files'>, rows: ImageRow[]): void {
  for (const r of rows) if (r.path) p.files.remove(r.path);
  forget(p.db, rows.map((r) => r.url));
}

/** An article's images go with it. */
export function removeImages(p: Pick<ImagePorts, 'db' | 'files'>, hash: string): void {
  removeRows(p, imagesOf(p.db, hash));
}

/** Whether an image is on the phone, waiting, or not coming (failed within the last day). */
export function imageState(db: SqlDb, url: string, now: number): 'here' | 'waiting' | 'failed' {
  const r = getImage(db, url);
  if (r?.path) return 'here';
  return needsFetch(r, now) ? 'waiting' : 'failed';
}
