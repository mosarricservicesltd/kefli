// Fetching article images (mobile spec 4.5 phase 6, 5.6): one at a time, http(s) only, at most 5 MB, kept only if
// the bytes are an image the Reader can draw. The store stays within 200 MB by evicting archived articles' images
// first. Ports, like sync, so this runs in tests.
import { articleBlocks } from '../reader/blocks';
import { imageKind, imageSize } from '../reader/imageSize';
import type { SqlDb } from '../data/db';
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
  readText: (hash: string) => string | null;
};

/** The image addresses in an article, in reading order. */
export function articleImages(markdown: string): string[] {
  const out: string[] = [];
  for (const b of articleBlocks(markdown).blocks) if (b.kind === 'img' && !out.includes(b.src)) out.push(b.src);
  return out;
}

/** The user agent page fetches use (5.4); some image servers refuse requests without a browser's. */
export const IMAGE_UA = 'Mozilla/5.0 (Linux; Android 17; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36';

export type Fetched = 'ok' | 'failed' | 'offline' | 'skipped';

export async function fetchImage(p: ImagePorts, owner: string, url: string, hash: string): Promise<Fetched> {
  if (!/^https?:\/\//i.test(url)) return 'skipped';
  let res: Response;
  try {
    res = await p.fetch(url, { headers: { 'User-Agent': IMAGE_UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' } });
  } catch {
    return 'offline';
  }
  const fail = () => {
    recordFailed(p.db, url, hash, p.now());
    return 'failed' as const;
  };
  if (!res.ok || Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return fail();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return 'offline';
  }
  if (bytes.length > MAX_IMAGE_BYTES || !imageKind(bytes)) return fail();
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
  const md = p.readText(hash);
  return md ? articleImages(md) : [];
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
