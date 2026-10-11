// Copy debug info (extension spec 11, flow decision 108): the last twenty things that became of a save, and the text the
// options page puts on the clipboard for a bug report. Neither holds a page's address or title, or any private key: a
// save is its time, whether it was a page or a link, what became of it and the first eight characters of its wrap's id,
// which is enough to find it on the operator's relay.
import type { Queued } from './queue';
import { KEYS, type Pairing, type Store } from './store';

export const HISTORY_MAX = 20;

/**
 * What became of a save: sent at once (with or without its text), queued and why, refused as the ninth, sent later from
 * the queue, stopped after 200 attempts, or undone (taken off the queue, retracted, or already on the phone).
 */
export type Outcome = 'sent' | 'sent, no text' | 'waiting, offline' | 'waiting, couldn’t reach' | 'waiting, blocked' | 'queue full' | 'sent from queue' | 'stopped' | 'undo: off the queue' | 'undo: retracted' | 'undo: on the phone';

export interface HistoryEntry {
  at: number;
  link: boolean;
  outcome: Outcome;
  id: string;
}

export async function history(store: Store): Promise<HistoryEntry[]> {
  return (await store.get<HistoryEntry[]>(KEYS.history)) ?? [];
}

/**
 * Adds an outcome, newest first, keeping twenty. A later outcome for the same save (sent from the queue, undone) may leave
 * out whether it was a link, and takes it from the save's earlier entry.
 */
export async function record(store: Store, at: number, id: string, outcome: Outcome, link?: boolean): Promise<void> {
  const h = await history(store);
  const tag = id.slice(0, 8);
  const entry: HistoryEntry = { at, link: link ?? h.find((e) => e.id === tag)?.link ?? false, outcome, id: tag };
  await store.set(KEYS.history, [entry, ...h].slice(0, HISTORY_MAX));
}

export interface DebugInfo {
  version: string;
  flavour: string;
  commit: string;
  browser: string;
  userAgent: string;
  online: boolean;
  defaultsUrl: string;
  devicePubkey: string;
  pairing: Pairing | null;
  queue: Queued[];
  movesChecked: number | null;
  history: HistoryEntry[];
  now: number;
}

const when = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const short = (hex: string) => hex.slice(0, 8);

function pairingLines(p: Pairing | null): string[] {
  if (!p) return ['Connected: no'];
  return [
    `Connected: since ${when(p.paired_at)}, shown on the phone as “${p.label}”`,
    `Library key: ${short(p.user_pubkey)}…`,
    `Relays: ${p.write_relays.join(', ')}`,
    `Blob servers: ${p.blossom_servers.join(', ')}`,
  ];
}

function queueLine(q: Queued[]): string {
  if (!q.length) return 'Waiting: none';
  const count = (why: Queued['why']) => q.filter((e) => e.why === why).length;
  const stopped = q.filter((e) => e.stopped).length;
  return `Waiting: ${q.length} (offline ${count('offline')}, couldn’t reach ${count('reach')}, blocked ${count('blocked')}, stopped ${stopped}; most attempts ${Math.max(...q.map((e) => e.attempts))})`;
}

/** The plain text Copy debug info puts on the clipboard. */
export function debugText(d: DebugInfo): string {
  const saves = d.history.length ? d.history.map((h) => `  ${when(h.at)}  ${h.link ? 'link' : 'page'}  ${h.id}  ${h.outcome}`) : ['  none yet'];
  return [
    `Kefli extension ${d.version} (${d.flavour}, ${d.commit})`,
    `Browser: ${d.browser}, ${d.online ? 'online' : 'offline'}`,
    `User agent: ${d.userAgent}`,
    `Settings from: ${d.defaultsUrl}`,
    `Browser key: ${short(d.devicePubkey)}…`,
    ...pairingLines(d.pairing),
    queueLine(d.queue),
    `Last look for a move: ${d.movesChecked ? when(d.movesChecked) : 'never'}`,
    `Copied: ${when(d.now)}`,
    `Last ${HISTORY_MAX} saves, newest first:`,
    ...saves,
  ].join('\n');
}
