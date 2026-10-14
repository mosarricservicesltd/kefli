// Ciphertext waiting for upload: Paths.document/kefli/staging/<sha256>.bin (mobile spec 4.2), kept while a save names
// the text: until the operator holds the blob, for good when it never will (a text over 8 MB, C§5), and for a move's
// new identity to upload again (C§4.8).
import { Directory, File, Paths } from 'expo-file-system';
import type { SqlDb } from '../data/db';
import { orphanBlobs } from '../data/saves';

const dir = () => new Directory(Paths.document, 'kefli', 'staging');

export function stageBlob(sha256: string, bytes: Uint8Array): string {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true });
  const f = new File(d, `${sha256}.bin`);
  f.write(bytes);
  return f.uri;
}

export async function readStaged(sha256: string): Promise<Uint8Array | null> {
  const f = new File(dir(), `${sha256}.bin`);
  return f.exists ? f.bytes() : null;
}

/**
 * The staged texts no save names any more go, with their rows (C§4.1, v1.12): a deleted save's waiting upload, or
 * one another phone's text replaced. Returns how many files went; one that can't be removed is left for the next.
 */
export function sweepStaged(db: SqlDb): number {
  let n = 0;
  for (const path of orphanBlobs(db)) {
    try {
      const f = new File(path);
      if (f.exists) f.delete();
      n++;
    } catch {
      // the row is gone; the file is named by nothing, and the next wipe takes it
    }
  }
  return n;
}
