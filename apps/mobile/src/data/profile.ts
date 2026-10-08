// A nostr user's profile for You (FD 12, FD 25, G12): the name and picture from their newest kind 0, which sync keeps
// in lists beside their 10002 and 10063. Only a name of some substance and an https picture are used.
import type { SqlDb } from './db';

export type Profile = { name: string | null; picture: string | null };

export function readProfile(db: SqlDb, owner: string): Profile | null {
  const raw = db.get<{ raw: string }>("SELECT raw FROM lists WHERE owner = ? AND kind = 0 AND d = ''", owner)?.raw;
  if (!raw) return null;
  let c: Record<string, unknown>;
  try {
    c = JSON.parse((JSON.parse(raw) as { content: string }).content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 64) : null);
  const name = text(c.display_name) ?? text(c.name);
  let picture: string | null = null;
  try {
    picture = typeof c.picture === 'string' && new URL(c.picture).protocol === 'https:' ? c.picture : null;
  } catch {
    picture = null;
  }
  return { name, picture };
}

/** The initial in the circle when there's no picture: the name's first letter, as a whole grapheme where it can be. */
export function initialOf(name: string): string {
  return (Array.from(name)[0] ?? '').toUpperCase();
}
