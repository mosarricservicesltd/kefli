// The one database, opened and migrated once per process (mobile spec 4.1). Held outbox rows left by a
// process death are queued at the next start (4.3).
import { openExpoDb } from '../data/expoDb';
import { releaseOrphans } from '../data/outbox';
import { migrate } from '../data/schema';
import type { SqlDb } from '../data/db';

let db: SqlDb | null = null;

export function store(): SqlDb {
  if (db) return db;
  db = openExpoDb('shelf.db');
  migrate(db);
  releaseOrphans(db);
  return db;
}
