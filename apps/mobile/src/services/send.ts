// Sends the outbox (mobile spec 4.3): one due row at a time, through ports so the tests can stand in for the
// network. It sends register, upload_blob, mirror_blob, publish_item, publish_lists, delete_item, delete_blob,
// post_device, pair_ack, delete_device, delete_wrap, copy_relay and publish_library_key.
import {
  KIND, buildDeletions, buildDevicesEvent, buildItemEvent, buildLibraryKeyEvent, buildRelayList, buildServerList, deleteBlob, httpAuth, mirrorBlob,
  savedD, uploadBlob, wrapPairAck,
} from '@kefli/protocol';
import type { CryptoPort, NostrEvent, Signer } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { hasDevices, localRecord, noteRecord, pairAcked, recordCreatedAt, type PairPayload } from '../data/devices';
import { getItem, itemJson, markPublished } from '../data/items';
import { markBacked } from '../data/backup';
import { keyPublished, libraryKey, libraryKeyPublished, madeHere, makeLibraryKey } from '../data/libraryKey';
import { indexerRelays, listServers, nextListTime, recordList, relayEntries, writeRelays } from '../data/lists';
import { begin, enqueue, finish, nextDue } from '../data/outbox';
import type { OutboxRow, OutboxTarget, TargetResult } from '../data/outbox';
import type { Defaults } from './config';
import { pageStream, streamFilter, type SyncPorts } from './sync';

export type RelayAnswer = { ok: true } | { ok: false; reason: string };

export type SendPorts = {
  db: SqlDb;
  now: () => number;
  signer: (pubkey: string) => Promise<Signer | null>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  defaults: () => Defaults;
  /** Publishes one event to one relay and returns its OK, or throws on a network failure. */
  publish: (relay: string, event: NostrEvent) => Promise<RelayAnswer>;
  /** The staged ciphertext for a blob, or null if it is gone. */
  readBlob: (sha256: string) => Promise<Uint8Array | null>;
  /** The events matching filters until EOSE, for copying the library to an added relay; throws when unreachable. */
  query?: SyncPorts['query'];
};

const DAY = 86_400;
const err = (e: unknown) => String((e as Error)?.message ?? e);

/** A relay's OK prefix decides the outcome (4.3). */
export function relayResult(target: string, a: RelayAnswer, eventId: string): TargetResult {
  if (a.ok) return { target, kind: 'ok', eventId };
  const reason = a.reason;
  if (/^duplicate:/.test(reason)) return { target, kind: 'ok', eventId };
  if (/^rate-limited:/.test(reason)) return { target, kind: 'retry', error: reason, waitSec: 60 };
  if (/^(invalid|blocked|pow|restricted|error):/.test(reason)) return { target, kind: 'rejected', error: reason };
  return { target, kind: 'retry', error: reason };
}

/** One signed call to the API (contract 6): ok, retried on 401, 429 and 5xx, otherwise refused. okStatus counts as done too. */
async function apiCall(p: SendPorts, signer: Signer, url: string, method: 'POST' | 'DELETE', body: string | null, okStatus?: number): Promise<TargetResult> {
  try {
    const headers: Record<string, string> = { Authorization: await httpAuth(signer, url, method, body ?? '', p.crypto) };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const res = await p.fetch(url, { method, headers, ...(body === null ? {} : { body }) });
    if (res.ok || res.status === okStatus) return { target: url, kind: 'ok' };
    if (res.status === 401 || res.status === 429 || res.status >= 500) return { target: url, kind: 'retry', error: `HTTP ${res.status}` };
    return { target: url, kind: 'rejected', error: `HTTP ${res.status}` };
  } catch (e) {
    return { target: url, kind: 'retry', error: err(e) };
  }
}

async function sendRegister(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const r = await apiCall(p, signer, t.target, 'POST', JSON.stringify({ v: 1 }));
  if (r.kind === 'ok') p.db.run('UPDATE identities SET registered_at = ? WHERE pubkey = ?', p.now(), row.signer);
  return [r];
}

/** POST /devices: the browser's key may upload against this identity's quota (C§4.4, 6). */
async function sendPostDevice(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  // the browser's label stays in the self-encrypted connected-browsers record, never with the operator (F30)
  const { device_pubkey } = JSON.parse(row.payload ?? '{}') as { device_pubkey: string };
  return [await apiCall(p, signer, t.target, 'POST', JSON.stringify({ v: 1, device_pubkey }))];
}

/** DELETE /devices/<pk>; a 404 means the API no longer holds it, which is the point. */
async function sendDeleteDevice(p: SendPorts, _row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  return [await apiCall(p, signer, t.target, 'DELETE', null, 404)];
}

/** The pair-ack wrap to the device on the offer's relay (C§4.4); taken, the browser joins the record. */
async function sendPairAck(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const pair = JSON.parse(row.payload ?? '{}') as PairPayload & { moved_from?: string };
  // a move's pair-ack (C§4.8 step 4) carries T but is sealed by S, the key the browser knows, with moved_from for the nonce
  const sealer = pair.moved_from ? await p.signer(pair.moved_from) : signer;
  if (!sealer) return [{ target: t.target, kind: 'retry', error: 'the source key is not on the phone' }];
  const ack = {
    v: 1 as const, user_pubkey: row.signer, write_relays: writeRelays(p.db, row.signer), blossom_servers: listServers(p.db, row.signer), token: pair.token,
    ...(pair.moved_from ? { moved_from: pair.moved_from } : { nonce: pair.nonce }),
  };
  const { wrap } = await wrapPairAck(sealer, pair.device_pubkey, ack, p.now(), { now: p.now(), random: p.crypto.randomBytes });
  let r: TargetResult;
  try {
    r = relayResult(t.target, await p.publish(t.target, wrap), wrap.id);
  } catch (e) {
    r = { target: t.target, kind: 'retry', error: err(e) };
  }
  if (r.kind === 'ok') pairAcked(p.db, p.now(), row.signer, pair);
  return [r];
}

async function sendUpload(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const { sha256 } = JSON.parse(row.payload ?? '{}') as { sha256: string };
  const blob = await p.readBlob(sha256);
  if (!blob) return [{ target: t.target, kind: 'rejected', error: 'staged blob missing' }];
  try {
    const r = await uploadBlob(t.target, blob, sha256, signer, p.fetch);
    if (r.ok) {
      p.db.run('UPDATE blobs SET operator_at = ?, last_error = NULL WHERE sha256 = ?', p.now(), sha256);
      return [{ target: t.target, kind: 'ok' }];
    }
    // A 413 from the operator is a full quota: the text stays on the phone and the upload retries daily (G5).
    if (r.status === 413) return [{ target: t.target, kind: 'retry', error: r.reason, waitSec: DAY }];
    return [r.permanent && r.status !== 401 ? { target: t.target, kind: 'rejected', error: `HTTP ${r.status} ${r.reason}` } : { target: t.target, kind: 'retry', error: `HTTP ${r.status} ${r.reason}` }];
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
}

/** The mirror after this one in defaults, or the first again after a day once every entry has refused (4.2). */
function nextMirror(p: SendPorts, current: string): { next: string; delaySec: number } {
  const mirrors = p.defaults().mirrors;
  const i = mirrors.indexOf(current);
  if (i >= 0 && i + 1 < mirrors.length) return { next: mirrors[i + 1], delaySec: 0 };
  return { next: mirrors[0], delaySec: DAY };
}

async function sendMirror(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const { sha256 } = JSON.parse(row.payload ?? '{}') as { sha256: string };
  const from = `${p.defaults().operator.blossom.replace(/\/+$/, '')}/${sha256}`;
  try {
    const r = await mirrorBlob(t.target, from, sha256, signer, p.fetch);
    if (r.ok) {
      p.db.run('UPDATE blobs SET mirror_at = ?, mirror_url = ?, last_error = NULL WHERE sha256 = ?', p.now(), t.target, sha256);
      return [{ target: t.target, kind: 'ok' }];
    }
    // A mirror refuses with any 4xx but 401 and 429, a 413 included: move to the next entry, never dead.
    if (r.permanent) return [{ target: t.target, kind: 'retarget', error: `HTTP ${r.status} ${r.reason}`, ...nextMirror(p, t.target) }];
    return [{ target: t.target, kind: 'retry', error: `HTTP ${r.status} ${r.reason}` }];
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
}

/** A blob no save names any more, on each server that held it; a 404 counts as done (4.3). */
async function sendDeleteBlob(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const { sha256 } = JSON.parse(row.payload ?? '{}') as { sha256: string };
  try {
    const r = await deleteBlob(t.target, sha256, signer, p.fetch);
    if (r.ok) return [{ target: t.target, kind: 'ok' }];
    return [r.permanent ? { target: t.target, kind: 'rejected', error: `HTTP ${r.status} ${r.reason}` } : { target: t.target, kind: 'retry', error: `HTTP ${r.status} ${r.reason}` }];
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
}

async function sendPublish(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<TargetResult[]> {
  const item = getItem(p.db, row.signer, row.subject);
  if (!item) return targets.map((t) => ({ target: t.target, kind: 'rejected' as const, error: 'item gone' }));
  const blob = item.text_sha256 ? p.db.get<{ mirror_url: string | null }>('SELECT mirror_url FROM blobs WHERE sha256 = ?', item.text_sha256) : null;
  const d = p.defaults();
  // text.servers never lists the operator alone (contract 4.2): the mirror that holds it, else the one being tried.
  const servers = [d.operator.blossom, blob?.mirror_url ?? d.mirrors[0]];
  // the address is keyed (F5): an identity made here makes its key now; any other waits until sync has learnt it
  const key = libraryKey(p.db, row.signer) ?? (madeHere(p.db, row.signer) ? makeLibraryKey(p.db, p.now(), row.signer, p.crypto.randomBytes) : null);
  if (!key) return targets.map((t) => ({ target: t.target, kind: 'retry' as const, error: 'library key not known yet' }));
  // the key's record reaches a relay before any save it addresses, so another phone finding the saves finds the key
  if (!keyPublished(p.db, row.signer) && !(await sendLibraryKey(p, row, signer, targets)).some((r) => r.kind === 'ok')) {
    return targets.map((t) => ({ target: t.target, kind: 'retry' as const, error: 'library key record not sent yet' }));
  }
  // Built at send time, created_at = max(now, last + 1), so a newer state always replaces the old one.
  const createdAt = Math.max(p.now(), (item.event_created_at ?? 0) + 1);
  const { event } = await buildItemEvent(signer, item.hash, itemJson(item, servers), createdAt, key);
  const results = await Promise.all(
    targets.map(async (t) => {
      try {
        return relayResult(t.target, await p.publish(t.target, event), event.id);
      } catch (e) {
        return { target: t.target, kind: 'retry', error: err(e) } as TargetResult;
      }
    }),
  );
  if (results.some((r) => r.kind === 'ok')) {
    markPublished(p.db, row.signer, item.hash, event.id, createdAt);
    retireAddress(p.db, p.now(), row.signer, item.hash, item.remote_d, savedD(key, item.hash), item.event_created_at ?? 0);
  }
  // backed up once a relay the operator doesn't run holds it (FD 93)
  if (results.some((r) => r.kind === 'ok' && r.target !== d.operator.relay)) markBacked(p.db, event.id);
  return results;
}

/**
 * A save now published at its keyed address (F5): the address it was at before, unkeyed or under another key, is
 * retired with a kind 5 dated past its last version there, and the new one remembered.
 */
function retireAddress(db: SqlDb, now: number, owner: string, hash: string, old: string | null, d: string, oldAt: number): void {
  db.run('UPDATE items SET remote_d = ? WHERE owner = ? AND hash = ?', d, owner, hash);
  if (!old || old === d) return;
  enqueue(db, now, { op: 'delete_item', signer: owner, subject: `retire:${old}`, payload: { ds: [old], after: oldAt }, targets: writeRelays(db, owner), lane: 'bulk' });
}

/** The library key's record (F5) to every target, ahead of the saves it addresses. */
async function sendLibraryKey(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<TargetResult[]> {
  const key = libraryKey(p.db, row.signer);
  if (!key) return targets.map((t) => ({ target: t.target, kind: 'rejected' as const, error: 'no library key' }));
  const event = await buildLibraryKeyEvent(signer, key, p.now());
  const results = await Promise.all(targets.map(async (t) => {
    try {
      return relayResult(t.target, await p.publish(t.target, event), event.id);
    } catch (e) {
      return { target: t.target, kind: 'retry', error: err(e) } as TargetResult;
    }
  }));
  if (results.some((r) => r.kind === 'ok')) libraryKeyPublished(p.db, row.signer, event.created_at);
  return results;
}

/**
 * Kind 5s for the payload's d tags, up to 50 addresses each, to every write relay (4.3). A save's own deletion names
 * its address under the library key too, worked out now, since the key may have come after the delete (F5).
 */
async function sendDeleteItem(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<TargetResult[]> {
  const payload = JSON.parse(row.payload ?? '{}') as { ds: string[]; after?: number; hash?: string };
  const key = libraryKey(p.db, row.signer);
  const ds = [...new Set([...payload.ds, ...(payload.hash && key ? [savedD(key, payload.hash)] : [])])];
  const after = payload.after;
  // dated after the newest version of the save it names, whatever this phone's clock says (F36)
  const events = await buildDeletions(signer, ds, Math.max(p.now(), (after ?? 0) + 1));
  return Promise.all(
    targets.map(async (t) => {
      try {
        let last: TargetResult = { target: t.target, kind: 'ok' };
        for (const e of events) {
          last = relayResult(t.target, await p.publish(t.target, e), e.id);
          if (last.kind !== 'ok') return last;
        }
        return last;
      } catch (e) {
        return { target: t.target, kind: 'retry', error: err(e) } as TargetResult;
      }
    }),
  );
}

/**
 * The 10002 to every target; the 10063 and the connected-browsers record (C§4.9) to the write relays only (4.3).
 * All are built from the tables at send time; the record only once there is a browser in it.
 */
async function sendLists(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<TargetResult[]> {
  // after the lists already held, so a phone whose clock is behind doesn't publish lists older than its own (F36)
  const now = nextListTime(p.db, row.signer, p.now());
  const relayList = await buildRelayList(signer, relayEntries(p.db, row.signer), now);
  const serverList = await buildServerList(signer, listServers(p.db, row.signer), now);
  const record = hasDevices(p.db, row.signer)
    ? await buildDevicesEvent(signer, localRecord(p.db, row.signer), Math.max(now, recordCreatedAt(p.db, row.signer) + 1))
    : null;
  const indexerOnly = new Set(indexerRelays(p.db, row.signer).filter((u) => !relayEntries(p.db, row.signer).some((e) => e.url === u)));
  const results = await Promise.all(
    targets.map(async (t) => {
      try {
        let a = relayResult(t.target, await p.publish(t.target, relayList), relayList.id);
        if (a.kind !== 'ok' || indexerOnly.has(t.target)) return a;
        a = relayResult(t.target, await p.publish(t.target, serverList), serverList.id);
        if (a.kind !== 'ok' || !record) return a;
        return relayResult(t.target, await p.publish(t.target, record), record.id);
      } catch (e) {
        return { target: t.target, kind: 'retry', error: err(e) } as TargetResult;
      }
    }),
  );
  if (results.some((r) => r.kind === 'ok')) {
    recordList(p.db, row.signer, relayList.kind, relayList.id, now, JSON.stringify(relayList));
    recordList(p.db, row.signer, serverList.kind, serverList.id, now, JSON.stringify(serverList));
    if (record) noteRecord(p.db, row.signer, record.id, record.created_at);
  }
  return results;
}

/**
 * A relay added in Advanced gets the library as already signed (FD 113, C§3.1): the newest event of each save and
 * every deletion that the other write relays hold, paged in full and published to it unchanged, so nothing is
 * re-signed from this phone's state (F16) and a deleted save's old event can't come back through it (F35). Retried
 * until at least one other relay answers; done once the relay has answered every event, whatever it refused.
 */
async function sendCopyRelay(p: SendPorts, row: OutboxRow, t: OutboxTarget): Promise<TargetResult[]> {
  if (!p.query) return [{ target: t.target, kind: 'retry', error: 'no relay reads' }];
  const sources = writeRelays(p.db, row.signer).filter((u) => u !== t.target);
  const read = await Promise.all(sources.map(async (u) => {
    try {
      const [items, deletions] = await Promise.all((['items', 'deletions'] as const).map((s) => pageStream(p.query!, u, streamFilter(s, row.signer, null))));
      return [...items, ...deletions];
    } catch {
      return null;
    }
  }));
  if (!read.some((r) => r !== null)) return [{ target: t.target, kind: 'retry', error: 'no other relay answered' }];
  const mine = read.flat().filter((e): e is NostrEvent => !!e && e.pubkey === row.signer);
  const saves = mine.filter((e) => e.kind !== KIND.deletion);
  const byD = new Map<string, NostrEvent>();
  for (const e of saves) {
    const d = e.tags.find((x) => x[0] === 'd')?.[1] ?? '';
    const held = byD.get(d);
    if (!held || e.created_at > held.created_at) byD.set(d, e);
  }
  const deletions = [...new Map(mine.filter((e) => e.kind === KIND.deletion).map((e) => [e.id, e])).values()];
  try {
    for (const e of [...byD.values(), ...deletions]) {
      const a = relayResult(t.target, await p.publish(t.target, e), e.id);
      if (a.kind === 'retry') return [a];
    }
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
  return [{ target: t.target, kind: 'ok' }];
}

/** A consumed inbox wrap, deleted with a kind 5 naming it (["e", id], ["k", "1059"]) on the operator relay (C§4.4). */
async function sendDeleteWrap(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const { id } = JSON.parse(row.payload ?? '{}') as { id: string };
  const event = await signer.signEvent({ kind: 5, created_at: p.now(), tags: [['e', id], ['k', '1059']], content: '' });
  try {
    return [relayResult(t.target, await p.publish(t.target, event), event.id)];
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
}

/** Sends the next due row, if any. Returns whether it did anything. */
export async function sendOne(p: SendPorts): Promise<boolean> {
  const due = nextDue(p.db, p.now());
  if (!due) return false;
  const { row, targets } = due;
  begin(p.db, row.id);
  const signer = await p.signer(row.signer);
  let results: TargetResult[];
  if (!signer) {
    results = targets.map((t) => ({ target: t.target, kind: 'retry', error: 'signer unavailable' }));
  } else if (row.op === 'publish_item') {
    results = await sendPublish(p, row, signer, targets);
  } else if (row.op === 'publish_lists') {
    results = await sendLists(p, row, signer, targets);
  } else if (row.op === 'delete_item') {
    results = await sendDeleteItem(p, row, signer, targets);
  } else if (row.op === 'publish_library_key') {
    results = await sendLibraryKey(p, row, signer, targets);
  } else if (row.op === 'copy_relay') {
    results = (await Promise.all(targets.map((t) => sendCopyRelay(p, row, t)))).flat();
  } else {
    const one = {
      register: sendRegister, upload_blob: sendUpload, mirror_blob: sendMirror, delete_blob: sendDeleteBlob,
      post_device: sendPostDevice, delete_device: sendDeleteDevice, pair_ack: sendPairAck, delete_wrap: sendDeleteWrap,
    }[row.op];
    results = one ? (await Promise.all(targets.map((t) => one(p, row, signer, t)))).flat() : targets.map((t) => ({ target: t.target, kind: 'rejected', error: `unknown op ${row.op}` }));
  }
  finish(p.db, p.now(), row.id, results);
  return true;
}

/** Sends until nothing is due or the budget runs out. */
export async function drain(p: SendPorts, maxRows = 100): Promise<number> {
  let n = 0;
  while (n < maxRows && (await sendOne(p))) n++;
  return n;
}
