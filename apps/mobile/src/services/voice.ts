// The listening session (mobile spec 5.7, 8.1) as the screens see it: one article at a time, its word, whether
// it plays, its rate. Word events set the article's one position directly (MS Signature 2); the position is
// published when the session pauses, ends or closes, and a sync follows the end of a session (4.5).
import { useSyncExternalStore } from 'react';
import type { Sentence } from '@kefli/protocol';
import { KefliVoice, type PhoneVoice, type VoiceState } from '../../modules/kefli-voice/src';
import { reconcileWords, rowByHash, setPosition, textLost, type LibRow } from '../data/library';
import { LISTEN_CUED, clearCued, playFrom, readyRow, recordPlayed, setCued } from '../data/listen';
import { getSetting, setSetting } from '../data/settings';
import { readRate, nextRate, snapRate, wpsFor, wpsKey } from '../voice/clock';
import { sessionVoice } from '../voice/choice';
import { appState } from './app';
import { runSync } from './runner';
import { store } from './store';
import { textFiles } from './textFiles';
import { artworkPath } from '../ui/artwork';

export type Session = {
  hash: string; title: string; playing: boolean; word: number; rate: number; wordTiming: boolean; wps: number;
  ended: boolean; totalWords: number; sentences: Sentence[]; sentence: number;
  /** Each sentence's first word, for the word meter (5.7). */
  firstWords: number[];
};

let session: Session | null = null;
const listeners = new Set<() => void>();
const set = (s: Session | null) => {
  session = s;
  listeners.forEach((l) => l());
};
const now = () => Math.floor(Date.now() / 1000);
// words a second are kept per voice and rate (5.7, FD 107); the phone's own voice for a language is 'default'
let voiceKey = 'default';
const wpsAt = (rate: number) => wpsFor((k) => getSetting(store(), k), voiceKey, rate);

export function useVoice(): Session | null {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => session);
}

export function voiceSession(): Session | null {
  return session;
}

/** Stores the position; publishes it (and syncs) when the session stops moving. */
function keep(word: number, publish: boolean) {
  const owner = appState()?.owner;
  if (!owner || !session) return;
  setPosition(store(), now(), owner, session.hash, word, publish);
  if (publish) runSync().catch(() => undefined);
}

let lastKept = 0;
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  KefliVoice.addListener('word', (e) => {
    if (!session || e.hash !== session.hash) return;
    set({ ...session, word: e.word });
    if (Date.now() - lastKept > 1000) {
      lastKept = Date.now();
      keep(e.word, false);
    }
  });
  KefliVoice.addListener('sentence', (e) => {
    if (session && e.hash === session.hash) set({ ...session, sentence: e.index });
  });
  KefliVoice.addListener('state', (e: VoiceState) => {
    if (!session || e.hash !== session.hash) return;
    const paused = session.playing && !e.playing;
    set({ ...session, playing: e.playing, word: e.word, rate: snapRate(e.rate), wordTiming: e.wordTiming, wps: e.wps });
    if (Math.abs(e.wps - wpsAt(e.rate)) > 0.05) setSetting(store(), wpsKey(voiceKey, e.rate), e.wps.toFixed(3));
    if (paused) keep(e.word, true);
  });
  KefliVoice.addListener('ended', (e) => {
    if (!session || e.hash !== session.hash) return;
    // The article was heard to its end: its position is the last word; the player shows it rewound and paused.
    keep(session.totalWords - 1, true);
    set({ ...session, playing: false, ended: true, word: 0 });
    // Play all moves to the next article of its snapshot, and stops after the last (FD 35)
    const next = queue.shift();
    if (next) playHash(next).catch(() => undefined);
  });
}

/** Warms the engine when a Reader opens, since the first word took about 2 s cold (T§2). */
export function warmVoice(): void {
  wire();
  KefliVoice.warmUp().catch(() => undefined);
}

/** Starts the article at a word (5.7): its sentences from the spoken projection, at the stored rate and wps. */
export async function listen(row: Pick<LibRow, 'hash' | 'title' | 'site' | 'url'>, fromWord: number): Promise<void> {
  wire();
  // the sentences were derived once with the article's blocks (6.7); starting only reads them
  const article = textFiles.readArticle(row.hash);
  if (!article) return;
  const list = article.sentences;
  const totalWords = article.words;
  if (!totalWords) return;
  const owner = appState()?.owner;
  if (owner) reconcileWords(store(), now(), owner, row.hash, totalWords);
  // anything starting ends the card's choice from a row's body (FD 115)
  clearCued(store());
  if (session && session.hash !== row.hash) keep(session.word, true);
  const rate = readRate(getSetting(store(), 'voice.speed'));
  const lang = store().get<{ lang: string | null }>('SELECT lang FROM items WHERE hash = ? AND lang IS NOT NULL LIMIT 1', row.hash)?.lang ?? null;
  const phone = await listPhoneVoices();
  const voice = sessionVoice(phone.voices, (k) => getSetting(store(), k), lang, phone.defaultLocale);
  voiceKey = voice.voiceId ?? 'default';
  const wps = wpsAt(rate);
  const word = Math.max(0, Math.min(fromWord, totalWords - 1));
  const title = row.title ?? row.url;
  if (owner) recordPlayed(store(), owner, row.hash, Math.floor(Date.now() / 1000));
  set({ hash: row.hash, title, playing: true, word, rate, wordTiming: true, wps, ended: false, totalWords, sentences: list, sentence: 0, firstWords: list.map((x) => x.firstWord) });
  let art: string | null = null;
  try {
    art = artworkPath(row.hash);
  } catch {
    art = null; // the card shows without artwork rather than not at all
  }
  await KefliVoice.start({ hash: row.hash, title, site: row.site ?? '', sentences: list, startWord: word, totalWords, rate, wps, artworkPath: art, ...voice });
}

// Play all's snapshot of Listen's list, the articles still to come (FD 35).
let queue: string[] = [];

async function playHash(hash: string): Promise<void> {
  const owner = appState()?.owner;
  const row = owner ? rowByHash(store(), owner, hash) : undefined;
  if (row) await listen(row, playFrom(row));
}

/** Play all: Listen's list as it stands, Unread with text (FD 111), from the top to the end, then stop (FD 35). */
export function playAll(hashes: string[]): void {
  queue = hashes.slice(1);
  if (hashes[0]) playHash(hashes[0]).catch(() => undefined);
}

/** Listen from the Reader: a different article ends Play all (FD 35). */
export function startListening(row: Pick<LibRow, 'hash' | 'title' | 'site' | 'url'>, fromWord: number): Promise<void> {
  if (session?.hash !== row.hash) queue = [];
  return listen(row, fromWord);
}

/** A Listen row's cover, or Play on the ready card: plays or pauses its article; starting a different article ends Play all (FD 35). */
export function toggleRow(row: LibRow): void {
  if (session?.hash === row.hash && !session.ended) return toggle();
  queue = [];
  listen(row, playFrom(row)).catch(() => undefined);
}

/** Double-tap a word in the Reader (FD 107): the voice moves to it and plays, or the article starts there. */
export function listenFrom(row: Pick<LibRow, 'hash' | 'title' | 'site' | 'url'>, word: number): Promise<void> {
  if (session?.hash !== row.hash || session.ended) return startListening(row, word);
  KefliVoice.jumpToWord(word);
  if (!session.playing) KefliVoice.play();
  return Promise.resolve();
}

export function toggle(): void {
  if (!session) return;
  if (session.playing) KefliVoice.pause();
  else KefliVoice.play();
}

/** Opening Speed read pauses the voice (FD 21). */
export function pauseVoice(): void {
  if (session?.playing) KefliVoice.pause();
}

export function skip(seconds: 15 | -15): void {
  KefliVoice.skip(seconds);
}

export function jumpTo(word: number): void {
  KefliVoice.jumpToWord(word);
}

/** The speed pill: the next rate, kept for every article (O-13); on Listen's ready card, with no session (FD 111). */
export function cycleRate(): void {
  const r = nextRate(session?.rate ?? readRate(getSetting(store(), 'voice.speed')));
  setSetting(store(), 'voice.speed', String(r));
  if (!session) return;
  const wps = wpsAt(r);
  set({ ...session, rate: r, wps });
  KefliVoice.setRate(r, wps);
}

/** You → Voice → Default speed: the one speed value (FD 36), applied to a session under way too. */
export function setDefaultRate(r: number): void {
  setSetting(store(), 'voice.speed', String(r));
  if (!session) return;
  const wps = wpsAt(r);
  set({ ...session, rate: r, wps });
  KefliVoice.setRate(r, wps);
}

let voices: Promise<{ voices: PhoneVoice[]; defaultLocale: string | null }> | null = null;

/** The phone's offline voices, asked once and again whenever You opens (FD 24: a voice installed later appears). */
export function listPhoneVoices(fresh = false): Promise<{ voices: PhoneVoice[]; defaultLocale: string | null }> {
  if (fresh || !voices) {
    wire();
    voices = KefliVoice.listVoices().catch(() => ({ voices: [], defaultLocale: null }));
  }
  return voices;
}

/** A voice's sample (5.8), resolved when it has been spoken. */
export function playSample(voiceId: string, text: string): Promise<void> {
  return KefliVoice.sample(voiceId, text);
}

/**
 * Listen's ready card (FD 111): the article as a paused session would show it, at the place it would play from, so
 * the card draws its clock, ruler and word meter the same way. Null when its text can't be read.
 */
export function readySession(row: LibRow): Session | null {
  const article = textFiles.readArticle(row.hash);
  if (!article?.words) return null;
  const rate = readRate(getSetting(store(), 'voice.speed'));
  const list = article.sentences;
  return {
    hash: row.hash, title: row.title ?? row.url, playing: false, word: Math.min(playFrom(row), article.words - 1), rate, wordTiming: true,
    wps: wpsAt(rate), ended: false, totalWords: article.words, sentences: list, sentence: 0, firstWords: list.map((x) => x.firstWord),
  };
}

/**
 * The card's ruler with a session (FD 115): the voice moves to the word, playing on if it plays; paused or heard to
 * its end it stays paused, and the place is stored at once, since no word events follow to keep it. The word moved to.
 */
export function seekTo(word: number): number | null {
  if (!session) return null;
  const w = Math.max(0, Math.min(word, session.totalWords - 1));
  KefliVoice.jumpToWord(w);
  if (!session.playing) {
    set({ ...session, word: w, ended: false });
    keep(w, true);
  }
  return w;
}

/**
 * The ready card's ruler (FD 115): the stored position moves and nothing starts, as its ±15 do. RULED: it stops short
 * of the last word, which would read as heard through and play from the top. The word stored.
 */
export function seekStored(row: LibRow, word: number, words: number): number | null {
  const owner = appState()?.owner;
  if (!owner) return null;
  const w = Math.max(0, Math.min(word, words - 2));
  setPosition(store(), now(), owner, row.hash, w, false);
  return w;
}

/**
 * A Listen row's body (FD 115): the card takes the article, ready at its stored position. A session under way stops
 * where it is, its place kept and published as ✕ leaves it, and Play all stops with it. False, changing nothing, when
 * the card already holds the article, or when the article's text can't be read (unplayable heals that row).
 */
export function putInPlayer(row: Pick<LibRow, 'hash'>): boolean {
  const owner = appState()?.owner;
  if (!owner) return false;
  const held = session ? session.hash : readyRow(store(), owner)?.row.hash;
  if (held === row.hash) return false;
  if (!textFiles.readArticle(row.hash)?.words) {
    unplayable(row.hash);
    return false;
  }
  queue = [];
  // chosen first, so the card drawn once the session closes is already the new article
  setCued(store(), row.hash);
  closeVoice();
  return true;
}

/**
 * An article Listen can't play, its text gone or with no spoken words: it is no longer the card's choice, and text
 * marked on the phone but missing goes back to be fetched, as the Reader does (textLost), so the card moves on.
 */
export function unplayable(hash: string): void {
  const owner = appState()?.owner;
  if (!owner) return;
  if (getSetting(store(), LISTEN_CUED) === hash) clearCued(store());
  if (textFiles.readArticle(hash) === null) textLost(store(), owner, hash);
}

/** ±15 on the ready card: the stored position moves by the words 15 s would speak, and nothing starts (FD 111). */
export function skipStored(row: LibRow, seconds: 15 | -15): void {
  const owner = appState()?.owner;
  if (!owner) return;
  const rate = readRate(getSetting(store(), 'voice.speed'));
  setPosition(store(), now(), owner, row.hash, playFrom(row) + Math.sign(seconds) * Math.round(15 * wpsAt(rate) * rate), false);
}

/** ✕: ends the session everywhere (5.7). */
export function closeVoice(): void {
  if (!session) return;
  if (!session.ended) keep(session.word, true);
  KefliVoice.close();
  set(null);
}

/** Deleting the playing article stops it (FD 34). */
export function stopIfPlaying(hash: string): void {
  if (session?.hash === hash) closeVoice();
}
