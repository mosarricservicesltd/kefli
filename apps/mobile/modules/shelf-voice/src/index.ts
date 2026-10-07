import { requireNativeModule, type EventSubscription } from 'expo-modules-core';
import type { Sentence } from '@shelf/protocol';

export type VoiceSession = {
  hash: string; title: string; site: string; sentences: Sentence[];
  /** The 512 px cover PNG the lock screen shows (6.4). */
  artworkPath?: string | null;
  startWord: number; totalWords: number; rate: number; wps: number;
};

export type VoiceState = { hash: string; playing: boolean; word: number; rate: number; wordTiming: boolean; wps: number };

type Events = {
  word: (e: { hash: string; word: number }) => void;
  sentence: (e: { hash: string; index: number }) => void;
  state: (e: VoiceState) => void;
  ended: (e: { hash: string }) => void;
  error: (e: { hash: string; code: string }) => void;
};

interface Native {
  warmUp(): Promise<void>;
  start(json: string): Promise<void>;
  play(): void; pause(): void; skip(seconds: 15 | -15): void; jumpToWord(word: number): void;
  setRate(rate: number): void; close(): void;
  readLog(): string; clearLog(): void;
  addListener<K extends keyof Events>(name: K, listener: Events[K]): EventSubscription;
}

const native = requireNativeModule<Native>('ShelfVoice');

/** mobile spec 8.1: the phone's voice in Shelf's own audio (listVoices and sample come with the Voice screen). */
export const ShelfVoice = {
  ...native,
  addListener: native.addListener.bind(native),
  start: (s: VoiceSession) => native.start(JSON.stringify(s)),
};
