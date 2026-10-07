import { requireNativeModule, type EventSubscription } from 'expo-modules-core';
import type { Sentence } from '@shelf/protocol';

export type VoiceSession = {
  hash: string; title: string; site: string; sentences: Sentence[];
  startWord: number; totalWords: number; rate: number; wps: number;
};

type Events = {
  word: (e: { hash: string; word: number }) => void;
  state: (e: { hash: string; playing: boolean; word: number; rate: number }) => void;
  ended: (e: { hash: string }) => void;
  error: (e: { hash: string; code: string }) => void;
};

interface Native {
  warmUp(): Promise<void>;
  start(json: string): Promise<void>;
  play(): void; pause(): void; skip(seconds: 15 | -15): void; jumpToWord(word: number): void;
  setRate(rate: number): void; close(): void;
  readLog(): string; clearLog(): void;
  probeSynthesis(text: string): Promise<string>;
  playProbe(): void;
  addListener<K extends keyof Events>(name: K, listener: Events[K]): EventSubscription;
}

const native = requireNativeModule<Native>('ShelfVoice');

/** mobile spec 8.1 (listVoices and sample come later). */
export const ShelfVoice = {
  ...native,
  addListener: native.addListener.bind(native),
  start: (s: VoiceSession) => native.start(JSON.stringify(s)),
};
