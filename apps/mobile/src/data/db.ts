// The synchronous SQL the data layer needs (mobile spec 4). expo-sqlite's sync API backs it on the phone
// (src/data/expoDb.ts) and node:sqlite in the tests, so the schema and the outbox run the same SQL in both.
export type Param = string | number | null | Uint8Array;

export interface SqlDb {
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowId: number };
  get<T>(sql: string, ...params: Param[]): T | undefined;
  all<T>(sql: string, ...params: Param[]): T[];
  /** Runs f in one transaction, rolled back if it throws. */
  tx<T>(f: () => T): T;
}

export function transaction<T>(db: Pick<SqlDb, 'exec'>, f: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = f();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
