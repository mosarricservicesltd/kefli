// The connected-browsers record (C§4.9): kind 30078, d kefli/devices, self-encrypted like a save.

import { DEVICES_D, KIND, MAX_EVENT_BYTES, T_TAG } from './constants';
import { EventTooLargeError, eventBytes, overCeiling, signedSize, signWithinCeiling } from './events';
import type { NostrEvent, Signer } from './signer';

export interface DeviceEntry {
  device_pubkey: string;
  label: string;
  /** New for every connection; entries are keyed by it. */
  token: string;
  connected_at: number;
  revoked_at: number | null;
}

export interface DevicesRecord {
  v: 1;
  devices: DeviceEntry[];
}

const earlier = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** Merge two copies by token: an entry in either is kept, and a revocation in either stays, at the earlier time. */
export function mergeDevices(a: DevicesRecord, b: DevicesRecord): DevicesRecord {
  const byToken = new Map<string, DeviceEntry>();
  for (const e of [...a.devices, ...b.devices]) {
    const seen = byToken.get(e.token);
    byToken.set(e.token, seen ? { ...seen, revoked_at: earlier(seen.revoked_at, e.revoked_at) } : { ...e });
  }
  // A stable order, so two phones merging the same copies publish the same record.
  const devices = [...byToken.values()].sort((x, y) => x.connected_at - y.connected_at || (x.token < y.token ? -1 : 1));
  return { v: 1, devices };
}

/** The entry a save request's token names, if it is still connected. */
export function connectedEntry(record: DevicesRecord, token: string): DeviceEntry | null {
  return record.devices.find((e) => e.token === token && e.revoked_at === null) ?? null;
}

/** Self-encrypt and sign the record, dropping revoked entries, earliest revoked_at first, only while it is over the ceiling. */
export async function buildDevicesEvent(signer: Signer, record: DevicesRecord, createdAt: number): Promise<NostrEvent> {
  const devices = [...record.devices];
  const revoked = devices.filter((e) => e.revoked_at !== null).sort((x, y) => x.revoked_at! - y.revoked_at!);
  for (;;) {
    const content = await signer.nip44Encrypt(signer.pubkey(), JSON.stringify({ v: 1, devices }));
    const template = { kind: KIND.appData, created_at: createdAt, tags: [['d', DEVICES_D], ['t', T_TAG]], content };
    const next = revoked.shift();
    if (signedSize(template) <= MAX_EVENT_BYTES || !next) return signWithinCeiling(signer, template);
    devices.splice(devices.indexOf(next), 1);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * An entry as C§4.9 gives it, holding only its own fields; null for any other (null, a number, a token that isn't
 * 64 hex, a time that isn't a number), which another client's copy may carry and the merge, the table and the
 * republish couldn't hold. Leaving one out loses nothing: a request can only name a token a seal's key matches.
 */
function entryOf(e: unknown): DeviceEntry | null {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  const { device_pubkey, label, token, connected_at, revoked_at } = o;
  if (typeof device_pubkey !== 'string' || !HEX64.test(device_pubkey) || typeof token !== 'string' || !HEX64.test(token)) return null;
  if (typeof label !== 'string' || !isTime(connected_at) || !(revoked_at === null || isTime(revoked_at))) return null;
  return { device_pubkey, label, token, connected_at, revoked_at };
}

/**
 * This identity's record, its well-formed entries only (entryOf). One over the 16 KB ceiling (C§3.3) isn't one Kefli
 * made, and is refused before it is decrypted, as one of a version this client doesn't read is.
 */
export async function readDevicesEvent(signer: Signer, event: NostrEvent): Promise<DevicesRecord> {
  if (event.kind !== KIND.appData || event.pubkey !== signer.pubkey()) throw new Error('not this identity’s record');
  if (event.tags.find((t) => t[0] === 'd')?.[1] !== DEVICES_D) throw new Error('not the devices record');
  if (overCeiling(event)) throw new EventTooLargeError(eventBytes(event));
  const r = JSON.parse(await signer.nip44Decrypt(signer.pubkey(), event.content));
  if (r?.v !== 1 || !Array.isArray(r.devices)) throw new Error('devices record version not understood');
  return { v: 1, devices: (r.devices as unknown[]).map(entryOf).filter((e): e is DeviceEntry => e !== null) };
}
