// node:sqlite behind the app's SqlDb, for the tests: the same SQL the phone runs through expo-sqlite.
import { DatabaseSync } from 'node:sqlite';
import { transaction, type Param, type SqlDb } from '../src/data/db';

export function memoryDb(): SqlDb {
  const raw = new DatabaseSync(':memory:');
  const db: SqlDb = {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params: Param[]) => {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    get: <T,>(sql: string, ...params: Param[]) => raw.prepare(sql).get(...params) as T | undefined,
    all: <T,>(sql: string, ...params: Param[]) => raw.prepare(sql).all(...params) as T[],
    tx: <T,>(f: () => T) => (raw.isTransaction ? f() : transaction(db, f)),
  };
  return db;
}
