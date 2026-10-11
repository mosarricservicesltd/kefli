// The recovery code and the key (contract section 2): BIP-39 English, 128 bits of entropy, the seed by
// PBKDF2-HMAC-SHA512 with 2,048 rounds and an empty passphrase, NIP-06 account 0 at m/44'/1237'/0'/0/0.
// PBKDF2 runs through CryptoPort (OpenSSL on the phone), since noble's would be slow on Hermes.

import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { CryptoPort } from './ports';

export const NIP06_PATH = "m/44'/1237'/0'/0/0";

/** Twelve words from 128 random bits. */
export function newMnemonic(crypto: CryptoPort): string {
  return entropyToMnemonic(crypto.randomBytes(16), wordlist);
}

/** Words as typed: lower case, single spaces. Returns null when they aren't a valid BIP-39 English mnemonic. */
export function cleanMnemonic(input: string): string | null {
  const words = input.trim().toLowerCase().split(/\s+/).join(' ');
  return validateMnemonic(words, wordlist) ? words : null;
}

/** The 32-byte secret key for a mnemonic. The English list is ASCII, so NFKD changes nothing and isn't applied. */
export async function secretKeyFromMnemonic(mnemonic: string, crypto: CryptoPort): Promise<Uint8Array> {
  const words = cleanMnemonic(mnemonic);
  if (!words) throw new Error('not a valid recovery code');
  const seed = await crypto.pbkdf2Sha512(utf8ToBytes(words), utf8ToBytes('mnemonic'), 2048, 64);
  const key = HDKey.fromMasterSeed(seed).derive(NIP06_PATH).privateKey;
  seed.fill(0);
  if (!key) throw new Error('derivation gave no key');
  return key;
}

const WORDS = new Set(wordlist);

/** Whether a typed word is on the BIP-39 English list (the recovery code field's check, mobile spec 5.3). */
export function isRecoveryWord(word: string): boolean {
  return WORDS.has(word.trim().toLowerCase());
}

/** Up to n words from the list starting with what has been typed, for the field's suggestions. */
export function suggestWords(prefix: string, n = 3): string[] {
  const p = prefix.trim().toLowerCase();
  if (!p || WORDS.has(p)) return [];
  const out: string[] = [];
  for (const w of wordlist) {
    if (w.startsWith(p)) out.push(w);
    if (out.length === n) break;
  }
  return out;
}

/** A word typed so far could still become one on the list. */
export function couldBeRecoveryWord(prefix: string): boolean {
  const p = prefix.trim().toLowerCase();
  return !p || wordlist.some((w) => w.startsWith(p));
}

/**
 * The one word a start fits (decision 106), or null while it fits none or several. A whole word that begins no other
 * ("zoo") is settled too, so it moves on without a space; one that begins others ("act") waits for the space.
 */
export function settledWord(prefix: string): string | null {
  const p = prefix.trim().toLowerCase();
  if (!p) return null;
  let found: string | null = null;
  for (const w of wordlist) {
    if (!w.startsWith(p)) continue;
    if (found) return null;
    found = w;
  }
  return found;
}

/**
 * The recovery code as it's typed: the twelve fields, the one to focus (null to let the keyboard go), and the rest of a
 * word that filled itself in, still to be swallowed in the field after it.
 */
export type CodeEntry = { words: string[]; focus: number | null; spill: { at: number; rest: string; typed: string } | null };

export const CODE_WORDS = 12;

export function emptyCodeEntry(): CodeEntry {
  return { words: Array.from({ length: CODE_WORDS }, () => ''), focus: 0, spill: null };
}

/**
 * The rest of the word before, typed on after it filled itself in (decision 106): swallowed while it matches, dropped
 * at the space. Returns the field's text once the typing departs from it, or null while it is being swallowed.
 */
function swallow(s: CodeEntry, i: number, text: string): { text: string | null; spill: CodeEntry['spill'] } {
  const sp = s.spill;
  if (!sp || sp.at !== i) return { text, spill: null };
  const typed = (sp.typed + text).toLowerCase();
  const done = /\s$/.test(typed);
  if (sp.rest.startsWith(typed.trimEnd()) && (!done || typed.trim() === sp.rest)) {
    return { text: null, spill: done ? null : { ...sp, typed } };
  }
  return { text: typed.slice(sp.typed.length).trimStart(), spill: null };
}

/** Words with spaces or commas fill from field i on; a whole code pasted fills all twelve and lets the keyboard go. */
function fillFrom(s: CodeEntry, i: number, parts: string[]): CodeEntry {
  const words = [...s.words];
  if (parts.length >= CODE_WORDS) {
    parts.slice(0, CODE_WORDS).forEach((w, k) => (words[k] = w));
    return { words, focus: null, spill: null };
  }
  parts.forEach((w, k) => i + k < CODE_WORDS && (words[i + k] = w));
  return { words, focus: Math.min(CODE_WORDS - 1, i + Math.max(1, parts.length)), spill: null };
}

/**
 * Field i's text changed (decisions 23 and 106). Several words, or one with a space after it, fill on and move along;
 * one word stays, unless its letters fit only one word, which fills in and hands over to the next field. Deleting
 * never fills a word.
 */
export function typeIntoCode(s: CodeEntry, i: number, raw: string): CodeEntry {
  const sw = swallow(s, i, raw);
  if (sw.text === null) return { ...s, words: s.words.map((w, k) => (k === i ? '' : w)), focus: i, spill: sw.spill };
  const text = sw.text;
  const parts = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (parts.length > 1 || /\s$/.test(text)) return fillFrom(s, i, parts);
  const v = text.trim().toLowerCase();
  const settled = v.length > s.words[i].length ? settledWord(v) : null;
  const words = s.words.map((w, k) => (k === i ? settled ?? v : w));
  if (!settled || i === CODE_WORDS - 1) return { words, focus: i, spill: null };
  return { words, focus: i + 1, spill: { at: i + 1, rest: settled.slice(v.length), typed: '' } };
}
