// Voice choice (mobile spec 5.8, FD 24, FD 89, FD 109), platform-free: the phone's offline voices, one choice per
// language, named as the prototype names them ("UK English · voice 1"); the languages Voice offers are the phone's own
// and those among the saves; an article is read in its language's chosen voice, else that language's first.
import type { SqlDb } from '../data/db';
import type { PhoneVoice } from '../../modules/kefli-voice/src';

/** The single choice before FD 109; it still counts for its own voice's language until a choice is made there. */
export const VOICE_ID = 'voice.id';

/** A language's choice: "voice.id.ar". */
export const voiceKeyFor = (lang: string) => `${VOICE_ID}.${languageOf(lang)}`;

/** The language subtag, lower case: "en" for "en-GB". */
export const languageOf = (tag: string | null | undefined) => (tag ?? '').split(/[-_]/)[0].toLowerCase();

/** The languages among the saves, most saves first: ["en", "ar"]. */
export function libraryLangs(db: SqlDb, owner: string): string[] {
  const n = new Map<string, number>();
  for (const r of db.all<{ lang: string; n: number }>(
    'SELECT lang, COUNT(*) AS n FROM items WHERE owner = ? AND lang IS NOT NULL AND pending_delete_at IS NULL GROUP BY lang', owner)) {
    const l = languageOf(r.lang);
    if (l) n.set(l, (n.get(l) ?? 0) + r.n);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l);
}

/** The most recently played article in a language, for a sample in its words. */
export function lastPlayedIn(db: SqlDb, owner: string, lang: string): string | null {
  const l = languageOf(lang);
  return db.all<{ hash: string; lang: string }>(
    `SELECT i.hash, i.lang FROM listen_history h JOIN items i ON i.id = h.item WHERE i.owner = ? AND i.lang IS NOT NULL
     ORDER BY h.last_played_at DESC`, owner).find((r) => languageOf(r.lang) === l)?.hash ?? null;
}

/**
 * The languages Voice offers (FD 109): the phone's own first, then those among the saves, each only when the phone
 * has a voice for it. RULED: only these, not every language the engine speaks; Google's offers more than fifty.
 */
export function voiceLangs(voices: PhoneVoice[], phoneLocale: string | null, library: string[]): string[] {
  const out: string[] = [];
  for (const l of [languageOf(phoneLocale), ...library]) {
    if (l && !out.includes(l) && voices.some((v) => languageOf(v.locale) === l)) out.push(l);
  }
  return out;
}

/** A language's name for its chip: the phone's name for one of its voices, without the country ("Arabic"). */
export function langName(voices: PhoneVoice[], lang: string): string {
  const v = voices.find((x) => languageOf(x.locale) === languageOf(lang));
  return v ? v.name.replace(/\s*\(.*\)\s*$/, '') : lang;
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

type Get = (key: string) => string | null;

/**
 * The voice chosen for a language: its own setting, else the old single choice when that voice speaks the language
 * (FD 109 moves it there without a write), else null.
 */
export function choiceFor(get: Get, voices: PhoneVoice[], lang: string | null): string | null {
  const l = languageOf(lang);
  const own = l ? get(voiceKeyFor(l)) : null;
  if (own && voices.some((v) => v.id === own)) return own;
  const old = voices.find((v) => v.id === get(VOICE_ID));
  return old && (!l || languageOf(old.locale) === l) ? old.id : null;
}

/**
 * What a session starts with: the voice chosen for the article's language (the phone's, for an article with none);
 * otherwise the first the Voice screen lists for it, so the screen and the session agree; with no voices, the
 * article's language alone.
 */
export function sessionVoice(voices: PhoneVoice[], get: Get, articleLang: string | null, phoneLocale: string | null = null): { voiceId: string | null; lang: string | null } {
  const lang = articleLang ?? phoneLocale;
  const id = choiceFor(get, voices, lang);
  if (id) return { voiceId: id, lang: articleLang };
  const first = voicesFor(voices, lang, phoneLocale)[0];
  return { voiceId: first?.id ?? null, lang: articleLang };
}
