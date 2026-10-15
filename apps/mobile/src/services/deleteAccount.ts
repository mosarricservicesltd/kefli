// Delete my data (mobile spec 5.8, 7.2, contract 4.7, FD 14, FD 28, FD 91 (e)), in three steps and in this order,
// since the operator relay refuses an account's kind 5s once it is deleted:
//   1. the operator: kind 5s for every wrap the phone knows of, and for every save when the operator relay is in
//      the user's 10002; every blob on the operator Blossom server; then DELETE /account. Unreachable after a
//      minute of retries, or DELETE /account refused, and nothing else runs: the key stays, to try again.
//   2. every other server: each other write relay gets kind 5s for every save, on the phone or found on the relays,
//      the connected-browsers record included, and the generated identity's lists, deleted and then replaced by
//      empty ones (C§4.7: the indexer, which refuses kind 5, gets the empty lists alone); each other Blossom
//      server named in a save's text.servers, the mirror among them, gets a delete for every blob. A relay is
//      confirmed when it answered OK to every kind 5, a server when it answered 2xx or 404 to every delete; each
//      gets a minute.
//   3. the phone: the key file, Block Store, the database and the files.
// Each step's result is kept in a delete_account job, so a deletion cut short resumes where it stopped.
import {
  DEVICES_D, EventTooLargeError, ITEM_D_PREFIX, KIND, LIBRARY_KEY_D, T_TAG, buildDeletions, buildRelayList, buildServerList, deleteBlob, httpAuth,
  readItemEvent, signWithinCeiling, withoutTrailingSlashes, type CryptoPort, type NostrEvent, type Signer,
} from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { deletesOwed, itemAddresses, newestVersion } from '../data/libraryKey';
import { bare, indexerRelays, nextListTime, relayEntries, relayListTags, serverListTags } from '../data/lists';
import { SERVER_TIMEOUT_MS, serverFetch, serverHops } from '../net/http';
import type { RelayAnswer } from './send';
import { pageStream, takeNewerLists, type Filter } from './sync';

export type DelPorts = {
  db: SqlDb;
  now: () => number;
  signer: Signer;
  defaults: { operator: { relay: string; blossom: string; api: string }; indexer: string[] };
  publish: (relay: string, event: NostrEvent) => Promise<RelayAnswer>;
  /** The relays' saves and records, read before signing; without it, only what the phone holds is deleted. */
  query?: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  sleep: (ms: number) => Promise<void>;
  /** Step 3, on the phone's storage. */
  wipePhone: () => Promise<void>;
  /** Each server's minute (spec 7.2). */
  budgetMs?: number;
  /** The local stack's build (services/config.ts LOCAL_STACK), whose servers a redirect may reach on loopback. */
  localStack?: boolean;
};

/**
 * p's fetch for a server, Kefli's API or a blob server (net/http serverFetch): each redirect followed a hop at a time,
 * never into the phone's own network (on the local stack, loopback too), and each answer had within the API's 15 s.
 * Left to OkHttp, a redirect sent DELETE /account, or a blob's deletion, on to whatever answered at 192.168.1.1 (its
 * authorisation left behind, as OkHttp does at another host), whose 2xx the phone then took for the operator's; and an
 * API that took DELETE /account and never answered held the screen, which swallows Back while the deletion runs, for
 * good.
 */
function toServer(p: DelPorts): typeof fetch {
  return serverFetch(p.fetch, { hops: serverHops(p.localStack === true), timeoutMs: SERVER_TIMEOUT_MS });
}

/** What the screen hands deletePorts: the relay pool among them, which both publishes and reads. */
export type DelDeps = Omit<DelPorts, 'now' | 'publish' | 'query' | 'sleep'> & {
  pool: { publish: DelPorts['publish']; query: (relay: string, filters: never) => Promise<NostrEvent[]> };
};

/**
 * The Delete my data screen's ports: time in seconds, the pool's publish, and the pool's read, so every save on the
 * user's relays is named, not only those on the phone (C§4.7, F32).
 */
export function deletePorts({ pool, ...d }: DelDeps): DelPorts {
  return {
    ...d, now: () => Math.floor(Date.now() / 1000), sleep: (ms) => new Promise<void>((ok) => setTimeout(ok, ms)),
    publish: (url, e) => pool.publish(url, e),
    query: (url, filters) => pool.query(url, filters as never),
  };
}

/** own: one of the user's own servers, which only a nostr user has (FD 91 (e)). */
export type Target = { url: string; kind: 'relay' | 'server'; host: string; own: boolean };
export type Result = 'wait' | 'done' | 'fail';
export type Progress = { operator: Result; others: Record<string, Result>; phone: Result };
export type Outcome = 'done' | 'partial' | 'failed';
/** The screen's view of the deletion, told each step as it resolves. A named type, so the code gate reads deleteEverything whole. */
export type Report = (prog: Progress) => void;

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/**
 * The servers step 2 asks: other write relays in the 10002, and the other Blossom servers named in a save's
 * text.servers (C§4.7), the only ones that hold its text; a nostr user's own servers in their 10063 never do (F32).
 */
export function deleteTargets(db: SqlDb, owner: string, operator: { relay: string; blossom: string }): Target[] {
  const relays = db.all<{ url: string; source: string }>("SELECT url, source FROM relays WHERE owner = ? AND write = 1 AND source != 'indexer' ORDER BY rowid", owner)
    .filter((r) => bare(r.url) !== bare(operator.relay));
  const named = db.all<{ text_servers: string }>('SELECT text_servers FROM items WHERE owner = ? AND text_servers IS NOT NULL', owner)
    .flatMap((r) => JSON.parse(r.text_servers) as string[]);
  const ownServers = new Set(db.all<{ url: string }>("SELECT url FROM servers WHERE owner = ? AND role = 'user'", owner).map((s) => bare(s.url)));
  const servers = [...new Set(named.map(bare))].filter((u) => u !== bare(operator.blossom));
  const seen = new Set<string>();
  return [
    ...relays.filter((r) => !seen.has(r.url) && seen.add(r.url)).map((r) => ({ url: r.url, kind: 'relay' as const, host: host(r.url), own: r.source === 'user' })),
    ...servers.map((url) => ({ url, kind: 'server' as const, host: host(url), own: ownServers.has(url) })),
  ];
}

const JOB = 'delete_account';

export function progressOf(db: SqlDb): Progress | null {
  const r = db.get<{ data: string }>('SELECT data FROM jobs WHERE id = ?', JOB);
  return r ? (JSON.parse(r.data) as Progress) : null;
}

function save(p: DelPorts, prog: Progress): void {
  p.db.run(
    `INSERT INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'delete_account', 'running', 0, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    JOB, JSON.stringify(prog), p.now(), p.now(),
  );
}

/** One try at a step's work: whether it went through. A named type, so the code gate's parser reads withinMinute whole. */
type Attempt = () => Promise<boolean>;

/** Tries until it succeeds or the minute is spent: 2 s, then doubling. */
async function withinMinute(p: DelPorts, attempt: Attempt): Promise<boolean> {
  const budget = p.budgetMs ?? 60_000;
  let spent = 0;
  for (let wait = 2000; ; wait *= 2) {
    if (await attempt().catch(() => false)) return true;
    if (spent + wait > budget) return false;
    await p.sleep(wait);
    spent += wait;
  }
}

/**
 * Every d this identity holds: each save at every address it is at (itemAddresses, which names an unkeyed address
 * only where a save was published there, F5, and saves deleted here whose kind 5s haven't all gone out, F32), saves
 * from a newer Kefli, the connected-browsers record and the library key's record.
 */
function allDs(db: SqlDb, owner: string): string[] {
  const future = db.all<{ d: string }>('SELECT d FROM items_future WHERE owner = ?', owner).map((r) => r.d);
  return [...new Set([...itemAddresses(db, owner), ...future, DEVICES_D, LIBRARY_KEY_D])];
}

/** The texts' blobs: the phone's saves', and those of saves deleted here whose blob deletes are still to go. */
function blobs(db: SqlDb, owner: string): string[] {
  const held = db.all<{ s: string }>('SELECT DISTINCT text_sha256 AS s FROM items WHERE owner = ? AND text_sha256 IS NOT NULL', owner).map((r) => r.s);
  return [...new Set([...held, ...deletesOwed(db, owner).blobs])];
}

type OnRelays = { ds: string[]; blobs: string[]; newest: number };

/**
 * Every kind 30078 with #t kefli on the user's relays, whatever its v (C§4.7 step 2), so a save another device made
 * since this phone last synced is deleted too (F32). A save the phone doesn't hold is opened for its text's blob,
 * which goes with the rest; one that doesn't open still gets its kind 5. A relay that doesn't answer adds nothing.
 * newest: the newest event's time, which the kind 5s are dated past (F36).
 */
async function onRelays(p: DelPorts, owner: string, held: Set<string>): Promise<OnRelays> {
  const query = p.query;
  if (!query) return { ds: [], blobs: [], newest: 0 };
  const filter: Filter = { kinds: [KIND.appData], authors: [owner], '#t': [T_TAG] };
  const relays = [...new Set([p.defaults.operator.relay, ...relayEntries(p.db, owner).map((r) => r.url)])];
  const found = new Map<string, NostrEvent>();
  await Promise.all(relays.map(async (relay) => {
    for (const e of await pageStream(query, relay, filter).catch(() => [])) {
      const d = e.tags.find((t) => t[0] === 'd')?.[1];
      if (e.pubkey !== owner || !d) continue;
      const had = found.get(d);
      if (!had || had.created_at < e.created_at) found.set(d, e);
    }
  }));
  const shas: string[] = [];
  for (const [d, e] of found) {
    if (held.has(d) || !d.startsWith(ITEM_D_PREFIX)) continue;
    try {
      const sha = (await readItemEvent(p.signer, e)).item.item.text?.sha256;
      if (typeof sha === 'string') shas.push(sha);
    } catch {
      // not one that opens: its kind 5 goes all the same
    }
  }
  return { ds: [...found.keys()], blobs: shas, newest: Math.max(0, ...[...found.values()].map((e) => e.created_at)) };
}

async function wrapDeletions(p: DelPorts, owner: string): Promise<NostrEvent[]> {
  const ids = p.db.all<{ wrap_id: string }>('SELECT wrap_id FROM inbox_seen WHERE owner = ?', owner).map((r) => r.wrap_id);
  const out: NostrEvent[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const tags = [...ids.slice(i, i + 50).map((id) => ['e', id]), ['k', String(KIND.giftWrap)]];
    out.push(await p.signer.signEvent({ kind: KIND.deletion, created_at: p.now(), tags, content: '' }));
  }
  return out;
}

/**
 * The generated identity's lists (C§4.7): the a tags the contract gives, and, RULED, an e tag for each list event the
 * phone sent or saw, since some relays (strfry among them) honour an a tag only for addressable kinds.
 */
async function listDeletion(p: DelPorts): Promise<NostrEvent> {
  const pk = p.signer.pubkey();
  const ids = p.db.all<{ event_id: string }>("SELECT event_id FROM lists WHERE owner = ? AND kind IN (?, ?) AND d = '' AND event_id IS NOT NULL", pk, KIND.relayList, KIND.serverList)
    .map((r) => ['e', r.event_id]);
  return p.signer.signEvent({
    kind: KIND.deletion, created_at: p.now(), content: '',
    tags: [['a', `${KIND.relayList}:${pk}:`], ['a', `${KIND.serverList}:${pk}:`], ...ids, ['k', String(KIND.relayList)], ['k', String(KIND.serverList)]],
  });
}

/**
 * A list's tags without the entries of name the operator's url or a row Kefli added (kefli) names: everything else as
 * the list is sent from here, tag for tag (data/lists relayListTags, serverListTags).
 */
function without(tags: string[][], name: string, operator: string, kefli: Set<string>): string[][] {
  return tags.filter((t) => t[0] !== name || (bare(t[1] ?? '') !== bare(operator) && !kefli.has(bare(t[1] ?? ''))));
}

/** One rewritten list, signed, or null when nothing of theirs is left in it, or it is too long for one event (C§3.3). */
async function rewritten(p: DelPorts, kind: number, tags: string[][], name: string, at: number): Promise<NostrEvent | null> {
  if (!tags.some((t) => t[0] === name)) return null;
  try {
    return await signWithinCeiling(p.signer, { kind, created_at: at, tags, content: '' });
  } catch (e) {
    if (e instanceof EventTooLargeError) return null;
    throw e;
  }
}

/**
 * A nostr user's newest 10002 and 10063 on the indexer and their relays, taken in as the list send takes them just
 * before it builds its own (C§3.1, send.ts readNewerLists), so the deletion's rewrite starts from them: from the lists
 * held alone, a relay or server they added in another app since this phone last synced went from the lists their other
 * apps share. Read before the saves are, so a relay they read from now is read for saves too. A relay that doesn't
 * answer adds nothing, and with none answering the lists held are rewritten.
 */
async function takeNewestLists(p: DelPorts, owner: string): Promise<void> {
  const query = p.query;
  if (!query) return;
  const relays = [...new Set([...p.defaults.indexer, ...indexerRelays(p.db, owner), ...relayEntries(p.db, owner).map((r) => r.url)])];
  const kinds = [KIND.relayList, KIND.serverList];
  const copies = await Promise.all(relays.map((r) => query(r, [{ kinds, authors: [owner] }]).catch((): NostrEvent[] => [])));
  takeNewerLists(p.db, owner, copies.flat(), kinds, p.now());
}

/**
 * A nostr user's lists (C§4.7): never deleted, since their other apps share them, but republished without the
 * operator's relay and Blossom server, even where they listed these themselves (F32), and without any default this
 * phone added (its rows added_by_app). Each starts from the list as Kefli sends it, the list held entry for entry with
 * Kefli's changes (relayListTags, serverListTags), so every entry of theirs stays in its place with its marker, those
 * past the LIST_MAX Kefli uses and the tags it doesn't read among them; rebuilt from the tables, as it was, a list of
 * theirs was cut to what Kefli used. It is dated after the lists it replaces, whatever this phone's clock says (C§3.1).
 * RULED: a list with nothing of theirs left in it (Kefli made it, finding none) is left as it is, neither emptied nor
 * deleted; and so is one too long for one event, as the list sends leave it (send.ts signList), since one cut to fit
 * would lose some of their entries.
 */
async function listRewrites(p: DelPorts): Promise<NostrEvent[]> {
  const pk = p.signer.pubkey();
  const op = p.defaults.operator;
  const relays = new Set(p.db.all<{ url: string }>("SELECT url FROM relays WHERE owner = ? AND source != 'indexer' AND added_by_app = 1", pk).map((r) => bare(r.url)));
  const servers = new Set(p.db.all<{ url: string }>('SELECT url FROM servers WHERE owner = ? AND added_by_app = 1', pk).map((r) => bare(r.url)));
  const at = nextListTime(p.db, pk, p.now());
  const lists = [
    await rewritten(p, KIND.relayList, without(relayListTags(p.db, pk), 'r', op.relay, relays), 'r', at),
    await rewritten(p, KIND.serverList, without(serverListTags(p.db, pk), 'server', op.blossom, servers), 'server', at),
  ];
  return lists.filter((e): e is NostrEvent => e !== null);
}

/**
 * The generated identity's lists emptied (C§4.7, v1.8): a newer kind 10002 and 10063 with no entries, a second after the
 * kind 5, take the old lists' place on a relay that refuses or ignores the kind 5, the indexer among them.
 */
async function emptyLists(p: DelPorts, deletion: NostrEvent): Promise<NostrEvent[]> {
  const at = deletion.created_at + 1;
  return [await buildRelayList(p.signer, [], at), await buildServerList(p.signer, [], at)];
}

/**
 * Everything the deletion publishes, signed before anything is sent: for a nostr user, the approval in their app.
 * empties: a generated identity's emptied lists, sent after the kind 5s and not counted towards a relay's confirmation.
 * blobs: the texts of saves found only on the relays, deleted with the phone's.
 */
export type Signed = { wraps: NostrEvent[]; items: NostrEvent[]; lists: NostrEvent[]; empties?: NostrEvent[]; blobs?: string[]; nostr: boolean };

export async function signDeletion(p: DelPorts): Promise<Signed> {
  const owner = p.signer.pubkey();
  const nostr = (p.db.get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider ?? 'local') !== 'local';
  if (nostr) await takeNewestLists(p, owner);
  const held = allDs(p.db, owner);
  const remote = await onRelays(p, owner, new Set(held));
  const wraps = await wrapDeletions(p, owner);
  // dated past the newest version of anything they name, whatever this phone's clock says (F36)
  const newest = Math.max(remote.newest, newestVersion(p.db, owner));
  const items = await buildDeletions(p.signer, [...new Set([...held, ...remote.ds])], Math.max(p.now(), newest + 1));
  const extra = { blobs: remote.blobs, nostr };
  if (nostr) return { wraps, items, lists: await listRewrites(p), ...extra };
  const deletion = await listDeletion(p);
  return { wraps, items, lists: [deletion], empties: await emptyLists(p, deletion), ...extra };
}

/** Sends every event to a relay; true when it answered OK to each (a relay that refuses one hasn't confirmed). */
async function sendAll(p: DelPorts, relay: string, events: NostrEvent[]): Promise<boolean> {
  for (const e of events) {
    const a = await p.publish(relay, e);
    if (!a.ok && !/^duplicate:/.test(a.reason)) return false;
  }
  return true;
}

async function deleteBlobs(p: DelPorts, server: string, shas: string[]): Promise<boolean> {
  const get = toServer(p);
  for (const s of shas) if (!(await deleteBlob(server, s, p.signer, get)).ok) return false;
  return true;
}

const allBlobs = (p: DelPorts, owner: string, signed: Signed) => [...new Set([...blobs(p.db, owner), ...(signed.blobs ?? [])])];

async function stepOperator(p: DelPorts, owner: string, signed: Signed): Promise<boolean> {
  const op = p.defaults.operator;
  const inList = !!p.db.get("SELECT 1 FROM relays WHERE owner = ? AND url = ? AND source != 'indexer'", owner, op.relay);
  // in the 10002, it gets everything step 2 sends the other relays: the saves' deletions and the lists'
  const events = [...signed.wraps, ...(inList ? [...signed.items, ...signed.lists, ...(signed.empties ?? [])] : [])];
  // the relay answering at all is what this step needs; a kind 5 it refuses doesn't stop the account's deletion
  const reached = await withinMinute(p, async () => {
    for (const e of events) await p.publish(op.relay, e);
    return true;
  });
  const shas = allBlobs(p, owner, signed);
  const cleared = reached && (await withinMinute(p, () => deleteBlobs(p, op.blossom, shas)));
  if (!cleared) return false;
  const url = `${withoutTrailingSlashes(op.api)}/account`;
  const get = toServer(p);
  return withinMinute(p, async () => {
    const res = await get(url, { method: 'DELETE', headers: { Authorization: await httpAuth(p.signer, url, 'DELETE', null, p.crypto) } });
    return res.ok || res.status === 404;
  });
}

async function stepOther(p: DelPorts, owner: string, t: Target, signed: Signed): Promise<boolean> {
  if (t.kind === 'server') return withinMinute(p, () => deleteBlobs(p, t.url, allBlobs(p, owner, signed)));
  const confirmed = await withinMinute(p, () => sendAll(p, t.url, [...signed.items, ...signed.lists]));
  await Promise.all((signed.empties ?? []).map((e) => p.publish(t.url, e).catch(() => undefined)));
  return confirmed;
}

/** Step 1, unless a run cut short has done it: false when the operator failed, the job then gone, to start afresh. */
async function operatorStep(p: DelPorts, owner: string, signed: Signed, prog: Progress, report: Report): Promise<boolean> {
  if (prog.operator === 'done') return true;
  prog.operator = (await stepOperator(p, owner, signed)) ? 'done' : 'fail';
  report({ ...prog });
  if (prog.operator === 'fail') {
    p.db.run('DELETE FROM jobs WHERE id = ?', JOB);
    return false;
  }
  save(p, prog);
  return true;
}

/**
 * The lists to the indexer as well, unreported: it holds nothing else of this identity. It refuses kind 5, so a
 * generated identity's lists are emptied there rather than deleted (C§4.7).
 */
async function listsToIndexer(p: DelPorts, signed: Signed): Promise<void> {
  const forIndexer = signed.nostr ? signed.lists : signed.empties ?? [];
  await Promise.all(p.defaults.indexer.flatMap((r) => forIndexer.map((e) => p.publish(r, e).catch(() => undefined))));
}

/** Step 2: every other server still waiting, each saved and reported as it resolves. */
async function othersStep(p: DelPorts, owner: string, targets: Target[], signed: Signed, prog: Progress, report: Report): Promise<void> {
  await Promise.all(targets.filter((t) => prog.others[t.url] === 'wait').map(async (t) => {
    prog.others[t.url] = (await stepOther(p, owner, t, signed)) ? 'done' : 'fail';
    save(p, prog);
    report({ ...prog, others: { ...prog.others } });
  }));
}

/**
 * Runs or resumes the deletion, reporting each step as it resolves. failed: the operator couldn't be reached or
 * refused, and nothing else ran. partial: some other server didn't confirm; the phone is wiped all the same.
 */
export async function deleteEverything(p: DelPorts, report: Report, presigned?: Signed): Promise<Outcome> {
  const owner = p.signer.pubkey();
  const signed = presigned ?? (await signDeletion(p));
  const targets = deleteTargets(p.db, owner, p.defaults.operator);
  const prog: Progress = progressOf(p.db) ?? { operator: 'wait', others: Object.fromEntries(targets.map((t) => [t.url, 'wait'])), phone: 'wait' };
  report(prog);
  if (!(await operatorStep(p, owner, signed, prog, report))) return 'failed';
  await listsToIndexer(p, signed);
  await othersStep(p, owner, targets, signed, prog, report);
  await p.wipePhone();
  prog.phone = 'done';
  report({ ...prog });
  return Object.values(prog.others).some((r) => r === 'fail') ? 'partial' : 'done';
}
