import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { chosen, languageOf, lastPlayedLang, named, sessionVoice, voicesFor } from '../src/voice/choice';
import { memoryDb } from './sqlite';

const V = [
  { id: 'en-GB-language', locale: 'en-GB', name: 'English (United Kingdom)' },
  { id: 'fr-FR-language', locale: 'fr-FR', name: 'French (France)' },
  { id: 'en-gb-x-gba-local', locale: 'en-GB', name: 'English (United Kingdom)' },
  { id: 'en-gb-x-rjs-local', locale: 'en-GB', name: 'English (United Kingdom)' },
  { id: 'en-us-x-sfg-local', locale: 'en-US', name: 'English (United States)' },
  { id: 'en-in-x-ene-local', locale: 'en-IN', name: 'English (India)' },
  { id: 'de-de-x-deb-local', locale: 'de-DE', name: 'German (Germany)' },
];
const SHORT = { 'en-GB': 'UK English', 'en-US': 'US English' };

describe('Voice choice (mobile spec 5.8, FD 24)', () => {
  test("the language's voices, named as the prototype names them", () => {
    const en = named(voicesFor(V, 'en'), SHORT);
    expect(en.map((v) => v.label)).toEqual(['UK English · voice 1', 'UK English · voice 2', 'English (India) · voice 1', 'US English · voice 1']);
    expect(voicesFor(V, 'de-AT').map((v) => v.id)).toEqual(['de-de-x-deb-local']);
    expect(voicesFor(V, null)).toEqual([]);
    expect(languageOf('en_GB')).toBe('en');
    // a locale's stand-in is kept only when it is the locale's one voice
    expect(voicesFor(V, 'fr').map((v) => v.id)).toEqual(['fr-FR-language']);
  });

  test('the chosen voice, or the first when it has gone', () => {
    const en = named(voicesFor(V, 'en'), SHORT);
    expect(chosen(en, 'en-us-x-sfg-local')?.label).toBe('US English · voice 1');
    expect(chosen(en, 'removed')?.id).toBe('en-gb-x-gba-local');
    expect(chosen([], null)).toBeNull();
  });

  test('a session uses the chosen voice only for an article in its language', () => {
    expect(sessionVoice(V, 'en-us-x-sfg-local', 'en')).toEqual({ voiceId: 'en-us-x-sfg-local', lang: 'en' });
    expect(sessionVoice(V, 'en-us-x-sfg-local', 'de')).toEqual({ voiceId: 'de-de-x-deb-local', lang: 'de' });
    expect(sessionVoice(V, 'en-us-x-sfg-local', null)).toEqual({ voiceId: 'en-us-x-sfg-local', lang: null });
    // nothing chosen: the first voice the screen lists, the phone's own locale first
    expect(sessionVoice(V, null, 'en', 'en-US')).toEqual({ voiceId: 'en-us-x-sfg-local', lang: 'en' });
    expect(sessionVoice(V, null, 'ja', 'en-US')).toEqual({ voiceId: null, lang: 'ja' });
  });

  test('the language of the last article played', () => {
    const db = memoryDb();
    migrate(db);
    const pk = 'a'.repeat(64);
    ensureIdentityRow(db, 1, pk, 'new', true);
    expect(lastPlayedLang(db, pk)).toBeNull();
    for (const [n, lang] of [[1, 'de'], [2, 'en']] as const) {
      db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, lang) VALUES (?, ?, 'https://e.com', 1, 'unread', 'cached', 'share', ?)", pk, String(n).repeat(64), lang);
    }
    db.run('INSERT INTO listen_history (item, last_played_at) VALUES (1, 50), (2, 20)');
    expect(lastPlayedLang(db, pk)).toBe('de');
  });
});
