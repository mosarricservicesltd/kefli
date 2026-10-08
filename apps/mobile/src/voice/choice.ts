// Voice choice (mobile spec 5.8, FD 24, FD 89), platform-free: the phone's offline voices for the language of the last
// article played, named as the prototype names them ("UK English · voice 1"); the row in You only when there is more
// than one; the chosen voice used for articles in its language.
//
// RULED: before any article has been played, the language is the phone's own voice's. RULED: voice.id is one setting;
// an article in another language is read by the phone's own voice for that language.
import type { SqlDb } from '../data/db';
import type { PhoneVoice } from '../../modules/shelf-voice/src';

export const VOICE_ID = 'voice.id';

/** The language subtag, lower case: "en" for "en-GB". */
export const languageOf = (tag: string | null | undefined) => (tag ?? '').split(/[-_]/)[0].toLowerCase();

/** The language of the last article played, or null when none has been. */
export function lastPlayedLang(db: SqlDb, owner: string): string | null {
  return db.get<{ lang: string | null }>(
    `SELECT i.lang FROM listen_history h JOIN items i ON i.id = h.item WHERE i.owner = ? AND i.lang IS NOT NULL
     ORDER BY h.last_played_at DESC LIMIT 1`, owner)?.lang ?? null;
}

/**
 * The offline voices for a language, grouped by locale, the phone's own locale (first) leading. RULED: a locale's "<locale>-language" voice is dropped when the
 * locale has named voices, since Google's engine lists it as a stand-in for one of them and it would be a duplicate.
 */
export function voicesFor(voices: PhoneVoice[], lang: string | null, first: string | null = null): PhoneVoice[] {
  const l = languageOf(lang);
  if (!l) return [];
  const mine = voices.filter((v) => languageOf(v.locale) === l);
  const alias = (v: PhoneVoice) => /-language$/i.test(v.id);
  return mine
    .filter((v) => !alias(v) || !mine.some((o) => o.locale === v.locale && !alias(o)))
    .sort((a, b) => Number(b.locale === first) - Number(a.locale === first) || a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id));
}

export type Named = PhoneVoice & { label: string; place: string };

/**
 * Each voice's label: the locale's short name where the prototype has one, else the phone's name for it, then
 * "voice N", numbered within its locale.
 */
export function named(voices: PhoneVoice[], short: Record<string, string>): Named[] {
  const seen = new Map<string, number>();
  return voices.map((v) => {
    const n = (seen.get(v.locale) ?? 0) + 1;
    seen.set(v.locale, n);
    const place = short[v.locale] ?? v.name;
    return { ...v, place, label: `${place} · voice ${n}` };
  });
}

/** The chosen voice when it's among these, else the first. */
export function chosen(voices: Named[], id: string | null): Named | null {
  return voices.find((v) => v.id === id) ?? voices[0] ?? null;
}

/**
 * What a session starts with: the chosen voice for an article in its language; otherwise the voice the Voice screen
 * shows as chosen for that language (the first listed), so the screen and the session agree; with no voices, the
 * article's language alone.
 */
export function sessionVoice(voices: PhoneVoice[], id: string | null, articleLang: string | null, phoneLocale: string | null = null): { voiceId: string | null; lang: string | null } {
  const v = voices.find((x) => x.id === id);
  if (v && (!articleLang || languageOf(v.locale) === languageOf(articleLang))) return { voiceId: v.id, lang: articleLang };
  const first = voicesFor(voices, articleLang ?? phoneLocale, phoneLocale)[0];
  return { voiceId: first?.id ?? null, lang: articleLang };
}
