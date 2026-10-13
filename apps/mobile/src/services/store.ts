// The one database, opened and migrated once per process (mobile spec 4.1). Held outbox rows left by a
// process death are queued at the next start (4.3), and the deletes it cut short are carried out (F38).
import { openExpoDb } from '../data/expoDb';
import { commitOrphans } from '../data/library';
import { releaseOrphans } from '../data/outbox';
import { migrate } from '../data/schema';
import type { SqlDb } from '../data/db';
import { removeImages } from './images';
import { imageFiles, textFiles } from './textFiles';

let db: SqlDb | null = null;

/** Each deleted save's text, blocks and images (4.5); a file left behind is named by no row, and the start goes on. */
function removeFiles(opened: SqlDb, hashes: string[]): void {
  for (const hash of hashes) {
    try {
      textFiles.removeAll(hash);
      removeImages({ db: opened, files: imageFiles }, hash);
    } catch {
      // the next
    }
  }
}

export function store(): SqlDb {
  if (db) return db;
  db = openExpoDb('kefli.db');
  migrate(db);
  releaseOrphans(db);
  removeFiles(db, commitOrphans(db));
  return db;
}
