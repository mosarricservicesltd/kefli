// The app's SqlDb on expo-sqlite's synchronous API (mobile spec 4.1).
import { openDatabaseSync } from 'expo-sqlite';
import type { Param, SqlDb } from './db';

export function openExpoDb(name: string): SqlDb {
  const raw = openDatabaseSync(name, { enableChangeListener: true });
  let depth = 0;
  const db: SqlDb = {
    exec: (sql) => raw.execSync(sql),
    run: (sql, ...params: Param[]) => {
      const r = raw.runSync(sql, ...params);
      return { changes: r.changes, lastInsertRowId: r.lastInsertRowId };
    },
    get: <T,>(sql: string, ...params: Param[]) => raw.getFirstSync<T>(sql, ...params) ?? undefined,
    all: <T,>(sql: string, ...params: Param[]) => raw.getAllSync<T>(sql, ...params),
    tx: <T,>(f: () => T) => {
      if (depth > 0) return f();
      let out: T;
      depth++;
      try {
        raw.withTransactionSync(() => {
          out = f();
        });
      } finally {
        depth--;
      }
      return out!;
    },
  };
  return db;
}
