// Live queries (mobile spec 4): a screen reads SQLite synchronously and reads again when any table it names
// changes, coalesced to one read per frame, so a sync writing a hundred rows re-renders once.
import { useEffect, useRef, useState } from 'react';
import { addDatabaseChangeListener } from 'expo-sqlite';

export function useLive<T>(read: () => T, tables: string[], deps: unknown[] = []): T {
  const [value, setValue] = useState(read);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    setValue(readRef.current());
    let frame: number | null = null;
    const sub = addDatabaseChangeListener((e) => {
      if (!tables.includes(e.tableName) || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setValue(readRef.current());
      });
    });
    return () => {
      sub.remove();
      if (frame !== null) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
