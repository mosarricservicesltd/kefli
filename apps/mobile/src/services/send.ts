// Sends the outbox (mobile spec 4.3): one due row at a time, through ports so the tests can stand in for the
// network. It sends register, upload_blob, mirror_blob, publish_item, publish_lists, delete_item, delete_blob,
// post_device, pair_ack, delete_device, delete_wrap, copy_relay and publish_library_key.
import {
  DEVICES_PATH, EventTooLargeError, KIND, buildDeletions, buildDevicesEvent, buildItemEvent, buildLibraryKeyEvent, deleteBlob, httpAuth,
  isSignerFailure, mirrorBlob, releaseTemplate, sameUrl, savedD, signStatement, signWithinCeiling, uploadBlob, wrapPairAck,
} from '@kefli/protocol';
import type { AccountFigures, BlossomOutcome, CryptoPort, NostrEvent, Signer, Statement } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { hasDevices, localRecord, noteRecord, pairAcked, recordCreatedAt, type DeviceProof, type PairPayload } from '../data/devices';
import { getItem, itemJson, markPublished, textServers, type ItemRow } from '../data/items';
import {
  heldFor, holdOn, holdUpload, holdUploads, markBacked, nextForRoom, noteFreed, releaseHold, roomLeft, type KnownFigures,
} from '../data/backup';
import { keyPublished, libraryKey, libraryKeyPublished, madeHere, makeLibraryKey } from '../data/libraryKey';
import {
  confirmedAbsent, indexerRelays, listEdits, listEditsSent, listServers, listsUnread, nextListTime, recordList, relayEntries, relayListTags,
  serverListTags, writeRelays,
} from '../data/lists';
import { backoff, begin, enqueue, finish, nextDue, nextWakeAt, releaseDependents, wake } from '../data/outbox';
import type { OutboxRow, OutboxTarget, TargetResult } from '../data/outbox';
import { fitSave, namesText, queueBlobDelete, withdrawText } from '../data/saves';
import type { Defaults } from './config';
import { notYet, pageStream, streamFilter, takeNewerLists, type SyncPorts } from './sync';

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
  /**
   * The library's last known figures (C§5, C§6; v1.12) and when they were had, from data/account.ts, for the room a
   * deletion the operator confirms leaves. Without them a text waiting for room waits for its day.
   */
  figures?: (owner: string) => KnownFigures | null;
  /** A 413 quota or daily brought the library's figures (C§5): kept as the last known, by data/account.ts recordFigures. */
  onFigures?: (owner: string, figures: AccountFigures) => void;
};

const DAY = 86_400;
/**
 * How often a publish held by a delete's Undo looks again. The window itself may run longer (the toast follows
 * Android's accessibility timeout and pauses while touched); the hold repeats until the save is gone or shown again.
 */
const UNDO_WAIT = 15;
const err = (e: unknown) => String((e as Error)?.message ?? e);

/**
 * An event dated past the relay's clock by more than it allows: strfry's "invalid: created_at too late" (15 minutes
 * ahead, for every strfry relay, Kefli's own among them), khatru's "event too much in the future", and nostr-rs-relay's
 * "invalid: The event created_at field is out of the acceptable range (+900sec) for this relay.", which it sends only
 * for a date ahead. It is the phone's clock running fast, not the event, so it is retried with the backoff until the
 * clock is right or the relay's has caught up; refused for good, every save made on such a phone missed every strfry
 * relay. A refusal as too early stays final: the library copied to a relay added in Advanced goes as already signed
 * (sendCopyRelay), and an event years old stays so however often it is sent.
 */
const CLOCK = new RegExp('created_at too late|too (?:much|far) in the future|created_at field is out of the acceptable range', 'i');

/** Whether a relay's words refuse an event as dated past its clock (CLOCK), which a later try may get past. */
export function pastItsClock(reason: string): boolean {
  return CLOCK.test(reason);
}

/**
 * A relay that holds the event already, or a newer version of its address: NIP-01's duplicate:, and strfry's
 * "replaced: have newer event", which it answers with OK false to an older version of a replaceable or addressable
 * event than the one it holds, as when another phone or app sent it a newer one. Either way there is nothing more to
 * send it. Read as a retry, as "replaced:" was, an event sent as already signed (the library's copy to an added relay)
 * went again at every backoff for ever, and one signed at each send (a save, the lists) went over the version that
 * replaced it once this phone's clock passed that version's date, which a sync would have kept (merge.ts mergeItem).
 */
const HELD = new RegExp('^(?:duplicate|replaced):');

/** Whether a relay's words say it holds the event, or a newer version of it, already (HELD): as good as taking it. */
export function holdsAlready(reason: string): boolean {
  return HELD.test(reason);
}

/** A relay's OK prefix decides the outcome (4.3); an event refused as dated ahead of the relay's clock is tried again. */
export function relayResult(target: string, a: RelayAnswer, eventId: string): TargetResult {
  if (a.ok || holdsAlready(a.reason)) return { target, kind: 'ok', eventId };
  const reason = a.reason;
  if (/^rate-limited:/.test(reason)) return { target, kind: 'retry', error: reason, waitSec: 60 };
  if (pastItsClock(reason)) return { target, kind: 'retry', error: reason };
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

/**
 * POST /devices: the browser's key may upload against this identity's quota (C§4.4, 6). The API takes it only with the
 * device's own proof from the offer, or, in a move (C§4.8 step 4), with a release signed now by the source key S, the
 * library that holds the browser: S is always a key on this phone, and the browser can't be asked again.
 */
async function sendPostDevice(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  // the browser's label stays in the self-encrypted connected-browsers record, never with the operator (F30)
  const { device_pubkey, proof, moved_from } = JSON.parse(row.payload ?? '{}') as { device_pubkey: string; proof?: DeviceProof; moved_from?: string };
  let consent: { proof: DeviceProof } | { release: Statement & { pubkey: string } };
  if (moved_from) {
    const source = await p.signer(moved_from);
    if (!source) return [{ target: t.target, kind: 'retry', error: 'the source key is not on the phone' }];
    const api = t.target.slice(0, -DEVICES_PATH.length);
    consent = { release: { pubkey: moved_from, ...(await signStatement(source, releaseTemplate(api, device_pubkey, row.signer, p.now()))) } };
  } else if (proof) {
    consent = { proof };
  } else {
    // queued by a build before the proof: the API would refuse it, so the browser shows a new code instead
    return [{ target: t.target, kind: 'rejected', error: 'no proof from the browser' }];
  }
  return [await apiCall(p, signer, t.target, 'POST', JSON.stringify({ v: 1, device_pubkey, ...consent }))];
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

/** A Blossom server's refusal: rejected when it is final, otherwise retried. */
function httpResult(target: string, r: { status: number; reason: string }, final: boolean): TargetResult {
  const error = 'HTTP ' + r.status + ' ' + r.reason;
  return { target, kind: final ? 'rejected' : 'retry', error };
}

type Refusal = Extract<BlossomOutcome, { ok: false }>;

/** The operator's 413 reasons (C§5): room in the library, the day's uploads, and a blob over 8 MB. */
const ROOM = new Set(['quota', 'daily', 'too_large']);

/**
 * Why the operator refused an upload, as blobs.last_error keeps it (C§5, v1.12): quota, daily or too_large, and for
 * any other 4xx but 401 and 429, or a disk past its floor (507), http and the status. Null for an answer that is no
 * refusal (401, 429, any other 5xx, a descriptor naming another blob), which is retried as before.
 */
export function refusalOf(r: Pick<Refusal, 'status' | 'reason' | 'permanent'>): string | null {
  if (r.status === 413 && ROOM.has(r.reason)) return r.reason;
  return r.permanent || r.status === 507 ? `http ${r.status}` : null;
}

async function sendUpload(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const { sha256 } = JSON.parse(row.payload ?? '{}') as { sha256: string };
  // its save has gone, or took another phone's text, since this was queued: no save would name the blob (C§4.1)
  if (!namesText(p.db, row.signer, sha256)) return (withdrawText(p.db, row.signer, sha256), []);
  // a refusal for room or the day holds the library's texts until its retry: this one would be sent only to be refused
  const held = holdOn(p.db, row.signer, sha256, p.now(), t.target);
  if (held) {
    holdUpload(p.db, row.signer, row.id, sha256, held);
    return [{ target: t.target, kind: 'retry', error: `held: ${held.reason}`, waitSec: held.until - p.now() }];
  }
  const blob = await p.readBlob(sha256);
  // the staged text is gone, so it can never be sent: the save goes without it rather than with it (C§4.2)
  if (!blob) return (releaseDependents(p.db, row.id, 'publish_item'), [{ target: t.target, kind: 'rejected', error: 'staged blob missing' }]);
  try {
    const r = await uploadBlob(t.target, blob, sha256, signer, p.fetch);
    return r.ok ? uploaded(p, row.signer, t.target, sha256, blob.length) : refused(p, row, t.target, sha256, r);
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
}

/**
 * The operator took the text (4.3): its blob records it and its saves name the operator (textTaken). A save deleted
 * while the upload was under way has the blob deleted again from the operator (C§4.1). A text that waited for room
 * tries the next that fits, so the texts a deletion made room for go one after another until one is refused (C§5).
 */
function uploaded(p: SendPorts, owner: string, target: string, sha256: string, size: number): TargetResult[] {
  const waited = p.db.get<{ last_error: string | null }>('SELECT last_error FROM blobs WHERE sha256 = ? AND owner = ?', sha256, owner)?.last_error;
  p.db.run('UPDATE blobs SET operator_at = ?, last_error = NULL WHERE sha256 = ? AND owner = ?', p.now(), sha256, owner);
  // the operator has taken a text, so the library had the room and the day for it: no refusal holds the rest back. One
  // taken while a refusal for the day holds them was a text the operator holds already (holdOn), which says nothing of
  // the day, so the rest wait for its retry
  if (heldFor(p.db, owner, p.now())?.reason !== 'daily') releaseHold(p.db, owner);
  textTaken(p.db, p.now(), owner, sha256, target);
  if (!namesText(p.db, owner, sha256)) queueBlobDelete(p.db, p.now(), owner, sha256, [target], { sha256, size, up: p.now() });
  if (waited === 'quota') tryRoom(p, owner);
  return [{ target, kind: 'ok' }];
}

/**
 * Saves whose text the operator now holds (4.3). One whose events haven't named the text yet records the operator,
 * so a delete before its next publish still reaches it (F33). One whose newest event names the text on a mirror alone,
 * as a move's copy of a text backed up under the old identity does (C§4.8), names the operator too and goes out again
 * naming both, since a mirror already holds the blob.
 */
function textTaken(db: SqlDb, now: number, owner: string, sha256: string, operator: string): void {
  db.run('UPDATE items SET text_servers = ? WHERE owner = ? AND text_sha256 = ? AND text_servers IS NULL', JSON.stringify([operator]), owner, sha256);
  const onMirror = db.all<{ hash: string; text_servers: string }>(
    `SELECT hash, text_servers FROM items WHERE owner = ? AND text_sha256 = ? AND event_id IS NOT NULL AND pending_delete_at IS NULL
     AND text_servers IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(text_servers) WHERE value = ?)`, owner, sha256, operator);
  for (const r of onMirror) {
    db.run('UPDATE items SET text_servers = ? WHERE owner = ? AND hash = ?', JSON.stringify([operator, ...(JSON.parse(r.text_servers) as string[])]), owner, r.hash);
    enqueue(db, now, { op: 'publish_item', signer: owner, subject: r.hash, targets: writeRelays(db, owner) });
  }
}

/**
 * The operator refused the text (C§5, v1.12): its reason is kept on the blob, a refusal for room brings the library's
 * figures, and the save's publish goes now without the text, which stays on the phone (C§4.2). A text over 8 MB is never
 * sent again; one refused for room, the day's uploads or any other 4xx is tried again a day later, and a full disk
 * (507) as any server error is. A refusal for room or the day holds the library's other texts with it (roomRefused).
 */
function refused(p: SendPorts, row: OutboxRow, target: string, sha256: string, r: Refusal): TargetResult[] {
  const why = refusalOf(r);
  if (!why) return [httpResult(target, r, false)];
  // the save goes now, before anything else this refusal brings is kept (C§4.2)
  releaseDependents(p.db, row.id, 'publish_item');
  p.db.run('UPDATE blobs SET last_error = ? WHERE sha256 = ? AND owner = ?', why, sha256, row.signer);
  if (why === 'quota' || why === 'daily') roomRefused(p, row, target, why, r.figures);
  const error = `HTTP ${r.status} ${r.reason}`;
  if (why === 'too_large') return [{ target, kind: 'rejected', error }];
  return [{ target, kind: 'retry', error, ...(r.status === 507 ? {} : { waitSec: DAY }) }];
}

/**
 * A refusal for room or the day (C§5): its figures kept, and the library's other texts held until its retry a day
 * from now, or for room until a confirmed deletion wakes one (holdUploads), rather than each sent whole to be refused.
 * For the day, a text the operator holds already for another library on the phone still goes (holdOn).
 */
function roomRefused(p: SendPorts, row: OutboxRow, operator: string, why: 'quota' | 'daily', figures: AccountFigures | undefined): void {
  if (figures) quietly(() => p.onFigures?.(row.signer, figures));
  holdUploads(p.db, row.signer, { reason: why, until: p.now() + DAY }, row.id, operator);
}

/**
 * The library's figures, through data/account.ts's ports: they only reckon room early (C§5), so one that fails costs
 * that and never the send it follows, which the operator has already answered.
 */
function quietly(f: () => void): void {
  try {
    f();
  } catch {
    // the next refusal, or Advanced's check, brings the figures again
  }
}

/**
 * Room the operator made, by confirming a deletion, or that a text waiting for room found (C§5): the oldest text
 * waiting on quota that fits what the last known figures leave goes now, and the refusal's hold on the rest is lifted
 * for it. Its own success tries the next; a refusal stops there, holding the rest again, so a deletion asks for no
 * signing for texts that can't fit. While a refusal for the day's uploads holds the texts, they wait for its retry,
 * since deleting gives none of the day back.
 */
function tryRoom(p: SendPorts, owner: string): void {
  quietly(() => {
    if (heldFor(p.db, owner, p.now())?.reason === 'daily') return;
    const f = p.figures?.(owner);
    const next = f ? nextForRoom(p.db, owner, roomLeft(p.db, owner, f)) : null;
    if (next === null) return;
    releaseHold(p.db, owner);
    wake(p.db, next, p.now());
  });
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
      p.db.run('UPDATE blobs SET mirror_at = ?, mirror_url = ?, last_error = NULL WHERE sha256 = ? AND owner = ?', p.now(), t.target, sha256, row.signer);
      republishNaming(p.db, p.now(), row.signer, sha256, t.target, p.defaults().operator.blossom);
      // a save deleted while the mirror was copying: the copy goes too (C§4.1)
      if (!namesText(p.db, row.signer, sha256)) queueBlobDelete(p.db, p.now(), row.signer, sha256, [t.target], { sha256 });
      return [{ target: t.target, kind: 'ok' }];
    }
    // A mirror refuses with any 4xx but 401 and 429, a 413 included: move to the next entry, never dead.
    if (r.permanent) return [{ target: t.target, kind: 'retarget', error: `HTTP ${r.status} ${r.reason}`, ...nextMirror(p, t.target) }];
    return [{ target: t.target, kind: 'retry', error: `HTTP ${r.status} ${r.reason}` }];
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
}

/**
 * A mirror took the blob after its save went out naming another, as when the first mirror failed for a while and
 * then refused (F18), or naming no server at all, its text then waiting for the operator (C§4.2, v1.12): each such save
 * is published again naming the operator and this mirror (C§4.2), and counts as not backed up until it is. A save not
 * yet published names the mirror when it goes, from the blob's row.
 */
function republishNaming(db: SqlDb, now: number, owner: string, sha256: string, mirror: string, operator: string): void {
  const stale = db.all<{ hash: string }>(
    `SELECT hash FROM items WHERE owner = ? AND text_sha256 = ? AND event_id IS NOT NULL AND pending_delete_at IS NULL
     AND (NOT EXISTS (SELECT 1 FROM json_each(COALESCE(text_servers, '[]')) WHERE value = ?)
       OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(text_servers, '[]')) WHERE value = ?))`,
    owner, sha256, mirror, operator,
  );
  for (const { hash } of stale) enqueue(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: writeRelays(db, owner) });
}

/**
 * A blob no save names any more, on each server that held it; a 404 counts as done (4.3). The operator's confirmation
 * gives back room (C§5): it is noted with the blob's size, and a text waiting for room that now fits goes at once.
 */
async function sendDeleteBlob(p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget): Promise<TargetResult[]> {
  const { sha256, size, up } = JSON.parse(row.payload ?? '{}') as { sha256: string; size?: number; up?: number };
  try {
    const r = await deleteBlob(t.target, sha256, signer, p.fetch);
    if (!r.ok) return [httpResult(t.target, r, r.permanent)];
    if (sameUrl(t.target, p.defaults().operator.blossom)) {
      if (size) noteFreed(p.db, row.signer, { at: p.now(), size, up: up ?? null });
      tryRoom(p, row.signer);
    }
    return [{ target: t.target, kind: 'ok' }];
  } catch (e) {
    return [{ target: t.target, kind: 'retry', error: err(e) }];
  }
}

/** The same outcome for every target. */
function each(targets: OutboxTarget[], kind: 'retry' | 'rejected', error: string, waitSec?: number): TargetResult[] {
  return targets.map((t) => ({ target: t.target, kind, error, ...(waitSec ? { waitSec } : {}) }) as TargetResult);
}

/** One event to every target, each answer read as 4.3 says. */
function publishTo(p: SendPorts, targets: OutboxTarget[], event: NostrEvent): Promise<TargetResult[]> {
  return Promise.all(targets.map(async (t) => {
    try {
      return relayResult(t.target, await p.publish(t.target, event), event.id);
    } catch (e) {
      return { target: t.target, kind: 'retry', error: err(e) } as TargetResult;
    }
  }));
}

/**
 * A relay took the save's event: the row records it, with the servers it names, and its old address is retired. An
 * event without the text (servers null, C§4.2) leaves text_servers as it was: the servers known to hold the text, none
 * yet or the operator once it has it (F33), which the mirror's success then finds not named (republishNaming).
 */
function published(p: SendPorts, owner: string, item: ItemRow, event: NostrEvent, servers: string[] | null, d: string): void {
  markPublished(p.db, owner, item.hash, event.id, event.created_at);
  // the servers the event names, for a later delete (C§4.1) and for knowing which mirror it names (F18)
  if (item.text_sha256 && servers) p.db.run('UPDATE items SET text_servers = ? WHERE id = ?', JSON.stringify(servers), item.id);
  retireAddress(p.db, p.now(), owner, item.hash, item.remote_d, d, item.event_created_at ?? 0);
}

/**
 * A save's event, built at send time (4.3), created_at = max(now, last + 1), so a newer state always replaces the old
 * one. Its page's fields are fitted under the event ceiling (C§3.3) with the fitter a save made today has (data/saves
 * fitSave): a save made before that, its title or picture address too long, was refused by buildItemEvent at every
 * send and never left the phone. Null when even fitted it is over the ceiling, as with an address too long for any
 * event, which no later try changes: the save stays on the phone, counted as not backed up.
 */
async function saveEvent(p: SendPorts, signer: Signer, item: ItemRow, servers: string[] | null, key: Uint8Array): Promise<NostrEvent | null> {
  const fitted = fitSave(item);
  if (!fitted) return null;
  const createdAt = Math.max(p.now(), (item.event_created_at ?? 0) + 1);
  try {
    return (await buildItemEvent(signer, item.hash, itemJson(fitted, servers), createdAt, key)).event;
  } catch (e) {
    if (e instanceof EventTooLargeError) return null;
    throw e;
  }
}

/**
 * The library key a save's address is keyed by (F5), or why the save waits for it: an identity made here makes its
 * key now; any other waits until sync has learnt it. The key's record reaches a relay before any save it addresses,
 * so another phone finding the saves finds the key.
 */
async function addressKey(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<Uint8Array | string> {
  const key = libraryKey(p.db, row.signer) ?? (madeHere(p.db, row.signer) ? makeLibraryKey(p.db, p.now(), row.signer, p.crypto.randomBytes) : null);
  if (!key) return 'library key not known yet';
  if (!keyPublished(p.db, row.signer) && !(await sendLibraryKey(p, row, signer, targets)).some((r) => r.kind === 'ok')) return 'library key record not sent yet';
  return key;
}

async function sendPublish(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<TargetResult[]> {
  const item = getItem(p.db, row.signer, row.subject);
  if (!item) return each(targets, 'rejected', 'item gone');
  // a save waiting on its delete's Undo isn't published: one that went out after its kind 5 would bring it back (F38)
  if (item.pending_delete_at !== null) return each(targets, 'retry', 'waiting on a delete', UNDO_WAIT);
  const key = await addressKey(p, row, signer, targets);
  if (typeof key === 'string') return each(targets, 'retry', key);
  // text.servers never lists the operator alone (contract 4.2), and names no server while the operator lacks the text
  const servers = textServers(p.db, item, p.defaults().operator.blossom, p.defaults().mirrors[0]);
  const event = await saveEvent(p, signer, item, servers, key);
  if (!event) return each(targets, 'rejected', 'too large for its event');
  const results = await publishTo(p, targets, event);
  if (results.some((r) => r.kind === 'ok')) published(p, row.signer, item, event, servers, savedD(key, item.hash));
  // backed up once a relay the operator doesn't run holds it (FD 93)
  if (results.some((r) => r.kind === 'ok' && r.target !== p.defaults().operator.relay)) markBacked(p.db, event.id);
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
  const results = await publishTo(p, targets, event);
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
  return Promise.all(targets.map((t) => publishEach(p, t.target, events)));
}

/**
 * The newest 10002 and 10063 on the indexer, the default relays (as a sign-in reads them) and the identity's relays,
 * taken in as sync takes them, just before the lists are built: one another app published since the last sync joins
 * this phone's rather than being overwritten. A relay that doesn't answer adds nothing. A copy dated more than a day
 * past this phone's clock waits for its time, as sync's read leaves it: taken here, it froze the lists, every list
 * sent from here being dated after it and every later one from another app being older. Returns the relays that
 * answered, for whether a list not held is confirmed absent (C§3.1).
 */
async function readNewerLists(p: SendPorts, owner: string): Promise<Set<string>> {
  const answered = new Set<string>();
  const query = p.query;
  if (!query) return answered;
  const d = p.defaults();
  const relays = [...new Set([...indexerRelays(p.db, owner), ...d.indexer, ...d.relays, ...relayEntries(p.db, owner).map((r) => r.url)])];
  const kinds = [KIND.relayList, KIND.serverList];
  const ask = (r: string) => query(r, [{ kinds, authors: [owner] }]).then((e) => (answered.add(r), e), (): NostrEvent[] => []);
  takeNewerLists(p.db, owner, (await Promise.all(relays.map(ask))).flat(), kinds, p.now());
  return answered;
}

/**
 * A list, signed, or null when it can't be one event within the ceiling (C§3.3), as a nostr user's list of hundreds
 * of relays from another app can't: RULED, it is then left as it is held, since a list Kefli could send would be
 * missing some of its entries, and Kefli's own changes stay in its tables, where the saves' sends read them.
 */
async function signList(signer: Signer, kind: number, tags: string[][], createdAt: number): Promise<NostrEvent | null> {
  try {
    return await signWithinCeiling(signer, { kind, created_at: createdAt, tags, content: '' });
  } catch (e) {
    if (e instanceof EventTooLargeError) return null;
    throw e;
  }
}

/** Events to one relay in turn, each answer read as 4.3 says, stopping at the first that isn't ok; with none, ok. */
async function publishEach(p: SendPorts, target: string, events: NostrEvent[]): Promise<TargetResult> {
  let last: TargetResult = { target, kind: 'ok' };
  try {
    for (const e of events) {
      last = relayResult(target, await p.publish(target, e), e.id);
      if (last.kind !== 'ok') return last;
    }
    return last;
  } catch (e) {
    return { target, kind: 'retry', error: err(e) };
  }
}

type Lists = { relayList: NostrEvent | null; serverList: NostrEvent | null; record: NostrEvent | null; edits: string[] };

/** The lists went out: each kept as the newest held (F36), the edits they showed done with, the record noted. */
function listsSent(db: SqlDb, owner: string, l: Lists): void {
  if (l.relayList) recordList(db, owner, l.relayList.kind, l.relayList.id, l.relayList.created_at, JSON.stringify(l.relayList));
  if (l.relayList) listEditsSent(db, owner, l.edits);
  if (l.serverList) recordList(db, owner, l.serverList.kind, l.serverList.id, l.serverList.created_at, JSON.stringify(l.serverList));
  if (l.record) noteRecord(db, owner, l.record.id, l.record.created_at);
}

/**
 * The 10002 to every target; the 10063 and the connected-browsers record (C§4.9) to the write relays only (4.3).
 * The lists are those held, entry for entry, with Kefli's changes (relayListTags, serverListTags), built at send time
 * after any newer list on the relays is taken in. A person's own list not read since sign-in waits for a read, unless
 * the read confirms it gone from every relay (C§3.1), when the tables are all there is of it. The record goes only
 * once there is a browser in it.
 */
async function sendLists(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<TargetResult[]> {
  const answered = await readNewerLists(p, row.signer);
  if (listsUnread(p.db, row.signer) && !confirmedAbsent(p.defaults(), answered)) return each(targets, 'retry', 'their lists not read yet');
  // after the lists already held, so a phone whose clock is behind doesn't publish lists older than its own (F36)
  const now = nextListTime(p.db, row.signer, p.now());
  const l: Lists = {
    edits: listEdits(p.db, row.signer),
    relayList: await signList(signer, KIND.relayList, relayListTags(p.db, row.signer), now),
    serverList: await signList(signer, KIND.serverList, serverListTags(p.db, row.signer), now),
    record: hasDevices(p.db, row.signer)
      ? await buildDevicesEvent(signer, localRecord(p.db, row.signer), Math.max(now, recordCreatedAt(p.db, row.signer) + 1))
      : null,
  };
  const indexerOnly = new Set(indexerRelays(p.db, row.signer).filter((u) => !relayEntries(p.db, row.signer).some((e) => e.url === u)));
  const sent = (t: OutboxTarget) => (indexerOnly.has(t.target) ? [l.relayList] : [l.relayList, l.serverList, l.record]).filter((e): e is NostrEvent => !!e);
  const results = await Promise.all(targets.map((t) => publishEach(p, t.target, sent(t))));
  if (results.some((r) => r.kind === 'ok')) listsSent(p.db, row.signer, l);
  return results;
}

/**
 * A relay added in Advanced gets the library as already signed (FD 113, C§3.1): the newest event of each save and
 * every deletion that the other write relays hold, paged in full and published to it unchanged, so nothing is
 * re-signed from this phone's state (F16) and a deleted save's old event can't come back through it (F35). Retried
 * until at least one other relay answers; done once the relay has answered every event, whatever it refused, and has
 * taken each it refused only as dated ahead of its clock (copyEvents).
 */
async function sendCopyRelay(p: SendPorts, row: OutboxRow, t: OutboxTarget): Promise<TargetResult[]> {
  if (!p.query) return [{ target: t.target, kind: 'retry', error: 'no relay reads' }];
  const events = await heldLibrary(p.db, p.query, row.signer, t.target);
  if (!events) return [{ target: t.target, kind: 'retry', error: 'no other relay answered' }];
  return [await copyEvents(p, t, events)];
}

/**
 * The library as the identity's other write relays hold it: the newest event of each save, then every deletion. Null
 * when none of them answered.
 */
async function heldLibrary(db: SqlDb, query: NonNullable<SendPorts['query']>, owner: string, target: string): Promise<NostrEvent[] | null> {
  const sources = writeRelays(db, owner).filter((u) => u !== target);
  const read = await Promise.all(sources.map(async (u) => {
    try {
      const [items, deletions] = await Promise.all((['items', 'deletions'] as const).map((s) => pageStream(query, u, streamFilter(s, owner, null))));
      return [...items, ...deletions];
    } catch {
      return null;
    }
  }));
  if (!read.some((r) => r !== null)) return null;
  const mine = read.flat().filter((e): e is NostrEvent => !!e && e.pubkey === owner);
  const deletions = new Map(mine.filter((e) => e.kind === KIND.deletion).map((e) => [e.id, e]));
  return [...newestOfEach(mine.filter((e) => e.kind !== KIND.deletion)), ...deletions.values()];
}

/** Of a save's events, by d, the newest. */
function newestOfEach(saves: NostrEvent[]): NostrEvent[] {
  const byD = new Map<string, NostrEvent>();
  for (const e of saves) {
    const d = e.tags.find((x) => x[0] === 'd')?.[1] ?? '';
    const held = byD.get(d);
    if (!held || e.created_at > held.created_at) byD.set(d, e);
  }
  return [...byD.values()];
}

/**
 * The events to the added relay in turn, as already signed. A refusal stops nothing, nor does an event the relay holds
 * a newer version of (holdsAlready), and nor does one refused as dated ahead of the relay's clock (pastItsClock), as
 * one signed on a phone running fast is: the rest still go, and the copy is tried again once that event's time has
 * come, for it to go too, the relay answering duplicate for the rest.
 * Stopping there, as any other retry does, one save dated ahead kept every save after it from the relay, for good
 * when it was dated a year ahead. One dated more than a day past this phone's clock is passed over, as sync leaves it
 * unread (notYet), since a try within a day changes nothing. Any other answer to retry (a relay asking to slow down,
 * a network failure) stops the copy there, to be tried again whole.
 */
async function copyEvents(p: SendPorts, t: OutboxTarget, events: NostrEvent[]): Promise<TargetResult> {
  // the latest date of those refused as ahead, and the relay's words for it
  let aheadAt = 0;
  let aheadError = '';
  try {
    for (const e of events) {
      const answer = await p.publish(t.target, e);
      const r = relayResult(t.target, answer, e.id);
      if (r.kind !== 'retry') continue;
      if (answer.ok || !pastItsClock(answer.reason)) return r;
      if (notYet(e, p.now())) continue;
      aheadAt = Math.max(aheadAt, e.created_at);
      aheadError = answer.reason;
    }
  } catch (e) {
    return { target: t.target, kind: 'retry', error: err(e) };
  }
  if (!aheadError) return { target: t.target, kind: 'ok' };
  return { target: t.target, kind: 'retry', error: aheadError, waitSec: Math.max(backoff(t.attempts + 1), aheadAt - p.now()) };
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

type Sender = (p: SendPorts, row: OutboxRow, signer: Signer, t: OutboxTarget) => Promise<TargetResult[]>;

/** The ops sent one target at a time. */
const PER_TARGET: Record<string, Sender> = {
  register: sendRegister, upload_blob: sendUpload, mirror_blob: sendMirror, delete_blob: sendDeleteBlob,
  post_device: sendPostDevice, delete_device: sendDeleteDevice, pair_ack: sendPairAck, delete_wrap: sendDeleteWrap,
};

async function dispatch(p: SendPorts, row: OutboxRow, signer: Signer, targets: OutboxTarget[]): Promise<TargetResult[]> {
  if (row.op === 'publish_item') return sendPublish(p, row, signer, targets);
  if (row.op === 'publish_lists') return sendLists(p, row, signer, targets);
  if (row.op === 'delete_item') return sendDeleteItem(p, row, signer, targets);
  if (row.op === 'publish_library_key') return sendLibraryKey(p, row, signer, targets);
  if (row.op === 'copy_relay') return (await Promise.all(targets.map((t) => sendCopyRelay(p, row, t)))).flat();
  const one = PER_TARGET[row.op];
  if (!one) return each(targets, 'rejected', 'unknown op ' + row.op);
  return (await Promise.all(targets.map((t) => one(p, row, signer, t)))).flat();
}

/** The shortest wait after a signer that didn't answer (out of sight, timed out, declined, zeroed), in seconds. */
const SIGNER_WAIT = 60;

/**
 * A lookup or send that threw (a Keystore not ready, a signer refusing out of sight or timing out, a zeroed key):
 * every target is retried with its backoff, longer for a signer, so the row goes back to the queue where the drain and
 * the retry timer see it, rather than staying 'sending' until the next start.
 */
function threw(targets: OutboxTarget[], e: unknown): TargetResult[] {
  const signer = isSignerFailure(e);
  return targets.map((t) => {
    const waitSec = signer ? Math.max(SIGNER_WAIT, backoff(t.attempts + 1)) : backoff(t.attempts + 1);
    return { target: t.target, kind: 'retry', error: err(e), waitSec };
  });
}

/** Sends the next due row, if any. Returns whether it did anything. */
export async function sendOne(p: SendPorts): Promise<boolean> {
  const due = nextDue(p.db, p.now());
  if (!due) return false;
  const { row, targets } = due;
  begin(p.db, row.id);
  let results: TargetResult[];
  try {
    const signer = await p.signer(row.signer);
    results = signer ? await dispatch(p, row, signer, targets) : each(targets, 'retry', 'signer unavailable');
  } catch (e) {
    results = threw(targets, e);
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

/** The foreground retry timer's longest wait; it re-arms after each drain, so a longer wait is reached in steps. */
const MAX_WAKE = 3600;

export type WakePorts = { db: () => SqlDb; now: () => number; active: () => boolean; run: () => void };

/**
 * The foreground retry (4.3, F11): after each drain, one timer to when the outbox next has something due, which
 * drains again; nothing is armed while Kefli isn't in front. arm replaces any earlier timer; stop clears it.
 */
export function outboxWaker(p: WakePorts): { arm: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    stop();
    if (!p.active()) return;
    const at = nextWakeAt(p.db());
    if (at === null) return;
    const wait = Math.min(MAX_WAKE, Math.max(1, at - p.now()));
    timer = setTimeout(() => {
      timer = null;
      p.run();
    }, wait * 1000);
  };
  return { arm, stop };
}
