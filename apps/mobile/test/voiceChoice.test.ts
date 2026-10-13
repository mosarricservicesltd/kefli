import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { choiceFor, chosen, langName, languageOf, lastPlayedIn, libraryLangs, named, sessionVoice, voiceLangs, voicesFor } from '../src/voice/choice';
import { memoryDb } from './sqlite';

const V = [
  { id: 'en-GB-language', locale: 'en-GB', name: 'English (United Kingdom)' },
  { id: 'fr-FR-language', locale: 'fr-FR', name: 'French (France)' },
  { id: 'en-gb-x-gba-local', locale: 'en-GB', name: 'English (United Kingdom)' },
  { id: 'en-gb-x-rjs-local', locale: 'en-GB', name: 'English (United Kingdom)' },
  { id: 'en-us-x-sfg-local', locale: 'en-US', name: 'English (United States)' },
  { id: 'en-in-x-ene-local', locale: 'en-IN', name: 'English (India)' },
  { id: 'de-de-x-deb-local', locale: 'de-DE', name: 'German (Germany)' },
  { id: 'ar-xa-x-arc-local', locale: 'ar-XA', name: 'Arabic' },
  { id: 'ar-xa-x-arz-local', locale: 'ar-XA', name: 'Arabic' },
];
const settings = (m: Record<string, string>) => (k: string) => m[k] ?? null;
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

  test('a session uses the voice chosen for its language (FD 109)', () => {
    const get = settings({ 'voice.id.en': 'en-us-x-sfg-local', 'voice.id.ar': 'ar-xa-x-arz-local' });
    expect(sessionVoice(V, get, 'en')).toEqual({ voiceId: 'en-us-x-sfg-local', lang: 'en' });
    expect(sessionVoice(V, get, 'ar')).toEqual({ voiceId: 'ar-xa-x-arz-local', lang: 'ar' });
    // no choice for German: its first voice
    expect(sessionVoice(V, get, 'de')).toEqual({ voiceId: 'de-de-x-deb-local', lang: 'de' });
    // an article with no language takes the phone language's choice
    expect(sessionVoice(V, get, null, 'en-GB')).toEqual({ voiceId: 'en-us-x-sfg-local', lang: null });
    // nothing chosen: the first voice the screen lists, the phone's own locale first
    expect(sessionVoice(V, settings({}), 'en', 'en-US')).toEqual({ voiceId: 'en-us-x-sfg-local', lang: 'en' });
    expect(sessionVoice(V, settings({}), 'ja', 'en-US')).toEqual({ voiceId: null, lang: 'ja' });
  });

  test('choosing an Arabic voice leaves English alone (the BBC Arabic report)', () => {
    // before FD 109 picking the Arabic voice replaced the one choice; now it is Arabic's alone
    const get = settings({ 'voice.id': 'en-gb-x-rjs-local', 'voice.id.ar': 'ar-xa-x-arc-local' });
    expect(choiceFor(get, V, 'en')).toBe('en-gb-x-rjs-local');
    expect(choiceFor(get, V, 'ar')).toBe('ar-xa-x-arc-local');
  });

  test("the old single choice counts for its own voice's language only", () => {
    const get = settings({ 'voice.id': 'ar-xa-x-arz-local' });
    expect(choiceFor(get, V, 'ar')).toBe('ar-xa-x-arz-local');
    expect(choiceFor(get, V, 'en')).toBeNull();
    // a language's own choice wins; one naming a voice the phone no longer has doesn't count
    expect(choiceFor(settings({ 'voice.id': 'en-gb-x-rjs-local', 'voice.id.en': 'en-us-x-sfg-local' }), V, 'en')).toBe('en-us-x-sfg-local');
    expect(choiceFor(settings({ 'voice.id.en': 'removed' }), V, 'en')).toBeNull();
  });

  test("Voice's languages: the phone's first, then the saves', each with a voice", () => {
    expect(voiceLangs(V, 'en-GB', ['ar', 'en', 'ja'])).toEqual(['en', 'ar']);
    expect(voiceLangs(V, 'en-GB', [])).toEqual(['en']);
    expect(voiceLangs(V, null, ['de'])).toEqual(['de']);
    expect(langName(V, 'en')).toBe('English');
    expect(langName(V, 'ar')).toBe('Arabic');
  });

  test('the languages among the saves, most first, and the last played in one', () => {
    const db = memoryDb();
    migrate(db);
    const pk = 'a'.repeat(64);
    ensureIdentityRow(db, 1, pk, 'new', true);
    expect(libraryLangs(db, pk)).toEqual([]);
    for (const [n, lang] of [[1, 'de'], [2, 'en-GB'], [3, 'en'], [4, 'ar']] as const) {
      db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, lang) VALUES (?, ?, 'https://e.com', 1, 'unread', 'cached', 'share', ?)", pk, String(n).repeat(64), lang);
    }
    expect(libraryLangs(db, pk)).toEqual(['en', 'ar', 'de']);
    db.run('INSERT INTO listen_history (item, last_played_at) VALUES (1, 50), (2, 20), (3, 10)');
    expect(lastPlayedIn(db, pk, 'en-US')).toBe('2'.repeat(64));
    expect(lastPlayedIn(db, pk, 'de')).toBe('1'.repeat(64));
    expect(lastPlayedIn(db, pk, 'ar')).toBeNull();
  });
});
