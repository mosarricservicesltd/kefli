import { migrate } from '../src/data/schema';
import { recordList } from '../src/data/lists';
import { initialOf, readProfile } from '../src/data/profile';
import { memoryDb } from './sqlite';

const PK = 'a'.repeat(64);
const put = (db: ReturnType<typeof memoryDb>, content: unknown) =>
  recordList(db, PK, 0, 'e1', 1, JSON.stringify({ kind: 0, pubkey: PK, content: typeof content === 'string' ? content : JSON.stringify(content) }));

describe("a nostr user's profile (FD 12, G12)", () => {
  test('the display name first, then the name; only an https picture', () => {
    const db = memoryDb();
    migrate(db);
    expect(readProfile(db, PK)).toBeNull();
    put(db, { name: 'rich', display_name: '  Richard   M ', picture: 'https://img.example/r.png' });
    expect(readProfile(db, PK)).toEqual({ name: 'Richard M', picture: 'https://img.example/r.png' });
    put(db, { name: 'rich', picture: 'http://img.example/r.png' });
    expect(readProfile(db, PK)).toEqual({ name: 'rich', picture: null });
    put(db, { name: '   ', picture: 'not a url' });
    expect(readProfile(db, PK)).toEqual({ name: null, picture: null });
    put(db, 'not json');
    expect(readProfile(db, PK)).toBeNull();
  });

  test('the initial', () => {
    expect(initialOf('richard')).toBe('R');
    expect(initialOf('Éva')).toBe('É');
  });
});
