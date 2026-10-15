// The background's work on a save, with the browser's parts played by fakes: the queue before a send (F23), Undo's window
// and its failures (F24, F40), the alarm after Disconnect (F10), oversized saves (F39), a capture the operator refuses
// (contract 1.12), the queue's lock (F41), Advanced's relays (F43) and the move and device-key hardening (F52).
import { hexToBytes } from '@noble/hashes/utils.js';
import { uploadBlob } from '../../../packages/protocol/src/blossom';
import { acceptSaveRequest, wrapPairAck, type PairAck, type SaveRequest } from '../../../packages/protocol/src/pairing';
import { LocalSigner, type NostrEvent } from '../../../packages/protocol/src/signer';
import { unwrap } from '../../../packages/protocol/src/wrap';
import { linkOnly, type Captured } from '../src/captured';
import { webCrypto } from '../src/crypto';
import { history } from '../src/debug';
import { relayRows, type Defaults } from '../src/defaults';
import { deviceSigner } from '../src/device';
import { PerSave } from '../src/lock';
import { applyMove, followMoves } from '../src/move';
import { ATTEMPTS_MAX, BLOB_KEEP_MAX, BLOBS_KEEP_MAX, changeQueue, dequeue, enqueue, ENTRIES_MAX, failed, flush, QUEUE_MAX, queued, settle, waiting } from '../src/queue';
import { ADDRESS_SURE_FIT_BYTES, AddressTooLongError, fetchNet, prepare, rumorBytes, timed, uploadTimeoutMs, WRAP_FRESH_FOR, type Net, type Pending } from '../src/save';
import { KEYS, memoryStore, type Pairing, type Store } from '../src/store';
import { toastCopy, type ToastState } from '../src/toastCopy';
import type { Found } from '../src/undo';
import { background, type Browser } from '../src/worker';

const DEFAULTS: Defaults = { v: 1, operator: { relay: 'wss://relay.example', blossom: 'https://blossom.example', api: 'https://api.example' }, relays: ['wss://a.example', 'wss://b.example'], mirrors: ['https://m.example'] };
const NOW = 1_791_600_000;
const user = new LocalSigner(hexToBytes('11'.repeat(32)));
const device = new LocalSigner(hexToBytes('22'.repeat(32)));
const PAIRING: Pairing = { v: 1, user_pubkey: user.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: ['https://blossom.example'], token: 'ab'.repeat(32), label: 'Chrome on a Mac', paired_at: NOW };
const PAGE: Captured = { url: 'https://example.com/a', canonical: null, hero: null, title: 'A page', site: null, byline: null, lang: 'en', html: '<p>Hello there</p>' };
const ctx = { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW };

/** A promise opened from outside, for a send held mid-flight. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
/** Lets every pending storage call and continuation run. */
const settled = () => new Promise((r) => setTimeout(r, 0));
/** Waits, a turn at a time, until a condition holds (encryption and storage take a few turns each). */
async function until(ok: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 500 && !(await ok()); i++) await settled();
}

/**
 * The network: publish answers OK unless told otherwise, and can be held until a gate opens. Uploads are taken, or, given
 * the operator's Blossom server as a fetch, answered by it through the real client (contract 5).
 */
function net(o: { publish?: 'ok' | 'down'; retract?: 'ok' | 'refused'; hold?: Promise<void>; blossom?: typeof fetch } = {}) {
  const published: NostrEvent[] = [];
  const asked = { n: 0, uploads: 0, removes: 0 };
  const n: Net = {
    async upload(server, blob, sha256, signer) {
      asked.uploads++;
      return o.blossom ? fetchNet(async () => undefined, o.blossom).upload(server, blob, sha256, signer) : { ok: true, url: 'u' };
    },
    async remove() {
      asked.removes++;
      return { ok: true, url: 'u' };
    },
    async publish(_relay, e) {
      if (e.kind === 5) {
        if (o.retract === 'refused') throw new Error('blocked: deletes only a gift wrap of its own that this relay holds');
        published.push(e);
        return;
      }
      asked.n++;
      await o.hold;
      if (o.publish === 'down') throw new Error('timeout');
      published.push(e);
    },
  };
  return { net: n, published, asked };
}

function harness(
  o: {
    paired?: boolean; pairing?: Pairing; online?: boolean; net?: Net; collected?: Found[]; store?: Store; session?: Store; alarmHold?: Promise<void>; toast?: Browser['toast'];
    checkMovesSoon?: Browser['checkMovesSoon'];
    /** The phone's deletions on the relay, by wrap and library, in place of the answers in `collected`. */
    found?: Browser['collected'];
  } = {},
) {
  const store = o.store ?? memoryStore();
  const session = o.session ?? memoryStore();
  const toasts: Omit<ToastState, 'shortcut'>[] = [];
  const alarm = { on: false, cleared: 0 };
  const opened = { n: 0 };
  const answers = [...(o.collected ?? [])];
  const clock = { now: NOW };
  const b: Browser = {
    store, session, net: o.net ?? net().net,
    now: () => clock.now,
    online: () => o.online ?? true,
    context: async () => ((o.paired ?? true) ? { ...ctx, pairing: o.pairing ?? ctx.pairing, now: clock.now } : null),
    openOptions: () => void opened.n++,
    toast: o.toast ?? (async (_w, s) => void toasts.push(s)),
    tick: async () => undefined,
    badge: async () => undefined,
    flushAlarm: async (on) => {
      // the first turning on can be held, as chrome.alarms takes a turn or two
      const hold = on ? o.alarmHold : undefined;
      if (hold) {
        o.alarmHold = undefined;
        await hold;
      }
      alarm.on = on;
      if (!on) alarm.cleared++;
    },
    checkMovesSoon: o.checkMovesSoon ?? (async () => undefined),
    // the relay's answers to Undo's looks for the phone's deletion, in turn; null is no answer, and past the last, not there
    collected: o.found ?? (async () => (answers.length ? answers.shift()! : false)),
    wait: async () => undefined,
  };
  return { store, session, toasts, alarm, opened, clock, work: background(b) };
}

const kinds = (t: { kind: string }[]) => t.map((x) => x.kind);

describe('a save is in the queue before it is sent (F23)', () => {
  test('while its send is held, the save is already stored, and a background started afresh sends it', async () => {
    const held = gate();
    const h = harness({ net: net({ hold: held.p }).net });
    void h.work.save(PAGE, 1, false);
    await until(() => h.alarm.on);
    const [e] = await queued(h.store);
    expect(e).toMatchObject({ why: 'sending', attempts: 0 });
    expect(h.alarm.on).toBe(true);
    expect(kinds(h.toasts)).toEqual(['saving']);
    // the worker is stopped here; the next one finds the save and sends it
    const n = net();
    const after = harness({ store: h.store, net: n.net });
    await after.work.flushQueue();
    expect(n.published.map((w) => w.id)).toEqual([e.id]);
    expect(await queued(h.store)).toEqual([]);
    expect(after.alarm.on).toBe(false);
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent from queue' });
  });

  test('a save sent at once leaves the queue, and the alarm goes', async () => {
    const h = harness();
    await h.work.save(PAGE, 1, false);
    expect(await queued(h.store)).toEqual([]);
    expect(h.alarm.on).toBe(false);
    expect(kinds(h.toasts)).toEqual(['saving', 'saved']);
  });

  test('one that couldn’t send waits, counts no attempt yet, and says why', async () => {
    const h = harness({ net: net({ publish: 'down' }).net });
    await h.work.save(PAGE, 1, false);
    expect(await queued(h.store)).toMatchObject([{ why: 'reach', attempts: 0, stopped: false }]);
    expect(h.alarm.on).toBe(true);
    expect(kinds(h.toasts)).toEqual(['saving', 'failed']);
  });

  test('a flush already going as a save goes in leaves it to the save’s own send, so it goes once', async () => {
    const n = net();
    const held = gate();
    const h = harness({ net: n.net, alarmHold: held.p });
    const saving = h.work.save(PAGE, 1, false);
    await until(async () => (await queued(h.store)).length > 0);
    // the alarm's flush reads the queue while the save waits on chrome.alarms
    await h.work.flushQueue();
    held.open();
    await saving;
    expect(n.asked.n).toBe(1);
    expect(kinds(h.toasts)).toEqual(['saving', 'saved']);
    expect((await history(h.store)).map((e) => e.outcome)).toEqual(['sent']);
  });

  test('after a restart, which keeps no alarm, a start-up flush that fails leaves the alarm on to try again', async () => {
    const h = harness({ net: net({ publish: 'down' }).net });
    await h.work.save(PAGE, 1, false);
    expect(await queued(h.store)).toMatchObject([{ why: 'reach' }]);
    h.alarm.on = false;
    await h.work.flushQueue();
    expect(await queued(h.store)).toMatchObject([{ why: 'reach', attempts: 1 }]);
    expect(h.alarm.on).toBe(true);
  });

  test('a ninth is still refused, while a save on its first send isn’t counted among the eight', async () => {
    const h = harness({ online: false });
    for (let i = 0; i < 8; i++) await h.work.save({ ...PAGE, url: `https://example.com/${i}` }, 1, false);
    await h.work.save({ ...PAGE, url: 'https://example.com/9' }, 1, false);
    expect(h.toasts.at(-1)!.kind).toBe('full');
    expect(await queued(h.store)).toHaveLength(8);
    // and one sent while eight wait still goes
    const online = harness({ store: h.store });
    await online.work.save({ ...PAGE, url: 'https://example.com/10' }, 1, false);
    expect(online.toasts.at(-1)!.kind).toBe('saved');
  }, 60_000);

  test('a stalled upload is given up, so the save waits rather than Saving… for ever', async () => {
    const never = ((_u: string, init: RequestInit) => new Promise((_ok, fail) => init.signal!.addEventListener('abort', () => fail(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(uploadBlob('https://blossom.example', new Uint8Array(8), 'ab'.repeat(32), device, timed(30, never))).rejects.toThrow();
    let signal: AbortSignal | undefined;
    const spy = (async (_u: string, init: RequestInit) => ((signal = init.signal ?? undefined), { ok: true, json: async () => ({ sha256: 'ab'.repeat(32) }) })) as unknown as typeof fetch;
    await fetchNet(async () => undefined, spy).upload('https://blossom.example', new Uint8Array(8), 'ab'.repeat(32), device);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(uploadTimeoutMs(0)).toBe(20_000);
    expect(uploadTimeoutMs(2_900_000)).toBeLessThan(120_000);
  });
});

describe('a save made offline (decision 30, extension spec 4)', () => {
  test('it waits however long the browser stays offline, the minute’s flushes counting no attempt, and goes once online', async () => {
    const h = harness({ online: false, net: net({ publish: 'down' }).net });
    await h.work.save(PAGE, 1, false);
    expect(kinds(h.toasts)).toEqual(['saving', 'offline']);
    // the alarm's flushes through a long flight, the laptop awake and its Wi-Fi off
    for (let i = 0; i <= ATTEMPTS_MAX; i++) await h.work.flushQueue();
    const q = await queued(h.store);
    expect(q).toMatchObject([{ why: 'offline', attempts: 0, stopped: false }]);
    expect([waiting(q), failed(q).length]).toEqual([1, 0]);
    expect(h.alarm.on).toBe(true);
    // the browser comes online, and the online event's flush sends it
    const n = net();
    const online = harness({ store: h.store, session: h.session, net: n.net });
    await online.work.flushQueue();
    expect(n.published).toHaveLength(1);
    expect(await queued(h.store)).toEqual([]);
  });
});

describe('Undo (F24, F40)', () => {
  test('Undo on a Saved toast that stayed up a long while, paused under the pointer, still retracts', async () => {
    const n = net();
    const h = harness({ net: n.net });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    h.clock.now += 120;
    await h.work.undo(id, 1);
    expect(h.toasts.at(-1)!.kind).toBe('undone');
    expect(n.published.filter((e) => e.kind === 5)).toHaveLength(1);
    expect(await h.session.get(`undo:${id}`)).toBeUndefined();
  });

  test('Undo while the queue is sending that save waits for the send, then retracts what went (F40 a)', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    const held = gate();
    const n = net({ hold: held.p });
    const online = harness({ store: h.store, session: h.session, net: n.net });
    const flushing = online.work.flushQueue();
    await until(() => n.asked.n === 1);
    const undoing = online.work.undo(id, 1);
    for (let i = 0; i < 20; i++) await settled();
    expect(online.toasts).toEqual([]);
    held.open();
    await Promise.all([flushing, undoing]);
    expect(kinds(online.toasts)).toEqual(['undone']);
    expect(n.published.map((e) => e.kind)).toEqual([1059, 5]);
    expect(n.published[1].tags).toContainEqual(['e', id]);
  });

  test('a save undone before its turn in a flush isn’t sent', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    await h.work.save({ ...PAGE, url: 'https://example.com/b' }, 1, false);
    const [first, second] = await queued(h.store);
    const held = gate();
    const sent: string[] = [];
    const tried: string[] = [];
    const pass = flush(h.store, async (p) => (tried.push(p.id), p.id === first.id && (await held.p), sent.push(p.id), 'sent'), true);
    await until(() => tried.length === 1);
    expect(await dequeue(h.store, second.id)).toBe(true);
    held.open();
    expect(await pass).toEqual([first.id]);
    expect(sent).toEqual([first.id]);
  });

  test('a retraction that fails, with the save not on the phone, says so and keeps the key to try again (F40 b)', async () => {
    const h = harness({ net: net({ retract: 'refused' }).net, collected: [false, false] });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    await h.work.undo(id, 1);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'undofailed', hash: h.toasts[0].hash });
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'undo: failed' });
    expect(await h.session.get(`undo:${id}`)).toBeDefined();
    expect(toastCopy({ ...h.toasts.at(-1)!, shortcut: null })).toMatchObject({ title: 'Couldn’t undo this save', mark: 'bad', timed: true });
  });

  test('looks the relay doesn’t answer whole can’t tell whether the phone has the save: Undo says it couldn’t, and keeps the key', async () => {
    const n = net();
    // the retraction went, but the relay, slow or gone, finished neither look with EOSE (relay.ts collected)
    const h = harness({ net: n.net, collected: [null, null] });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    await h.work.undo(id, 1);
    expect(n.published.filter((e) => e.kind === 5)).toHaveLength(1);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'undofailed', hash: h.toasts[0].hash });
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'undo: failed' });
    expect(await h.session.get(`undo:${id}`)).toBeDefined();
    // the second look is the one that counts: one answered whole after a first that wasn't says the save is removed
    const later = harness({ collected: [null, false] });
    await later.work.save(PAGE, 1, false);
    await later.work.undo(later.toasts[0].id!, 1);
    expect(later.toasts.at(-1)!.kind).toBe('undone');
  });

  test('a key the session no longer holds still finds a save on the phone, or says Undo couldn’t', async () => {
    const h = harness({ collected: [true] });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    await h.session.remove(`undo:${id}`);
    await h.work.undo(id, 1);
    expect(h.toasts.at(-1)!.kind).toBe('onphone');
    await h.work.undo(id, 1);
    expect(h.toasts.at(-1)!.kind).toBe('undofailed');
  });

  test('Undo on a waiting save whose send may have reached the relay retracts it too, or finds it on the phone', async () => {
    for (const onPhone of [false, true]) {
      const n = net({ publish: 'down' });
      const h = harness({ net: n.net, collected: [onPhone] });
      await h.work.save(PAGE, 1, false);
      // the answer timed out, though the relay may hold the wrap
      expect(await queued(h.store)).toMatchObject([{ why: 'reach' }]);
      const id = h.toasts[0].id!;
      await h.work.undo(id, 1);
      expect(await queued(h.store)).toEqual([]);
      expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags)).toEqual([[['e', id], ['k', '1059']]]);
      expect(h.toasts.at(-1)).toMatchObject({ kind: onPhone ? 'onphone' : 'unqueued' });
      expect(await h.session.get(`undo:${id}`)).toBeFalsy();
    }
  });

  test('Undo on a save that never left the browser only takes it off the queue', async () => {
    const n = net();
    const h = harness({ online: false, net: n.net });
    await h.work.save(PAGE, 1, false);
    await h.work.undo(h.toasts[0].id!, 1);
    expect(n.published).toEqual([]);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
  });

  test('Undo on a save still waiting takes it off the queue, and the alarm goes with the last one', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    await h.work.undo(h.toasts[0].id!, 1);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
    expect(await queued(h.store)).toEqual([]);
    expect(h.alarm.on).toBe(false);
  });
});

describe('not paired (F10)', () => {
  test('the alarm and the browser coming online flush quietly: the alarm goes, and the options page stays shut', async () => {
    const h = harness({ paired: false });
    h.alarm.on = true;
    await h.work.flushQueue();
    expect(h.alarm.on).toBe(false);
    expect(h.opened.n).toBe(0);
  });

  test('a save or an Undo asked for opens the options page', async () => {
    const h = harness({ paired: false });
    await h.work.save(PAGE, 1, false);
    await h.work.undo('x', 1);
    expect(h.opened.n).toBe(2);
    expect(h.toasts).toEqual([]);
  });

  test('Disconnect with saves waiting clears the queue and the alarm', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    expect(h.alarm.on).toBe(true);
    await h.work.disconnected();
    expect(await queued(h.store)).toEqual([]);
    expect(h.alarm.on).toBe(false);
  });
});

describe('a save too large to wrap (F39)', () => {
  const long = (n: number) => `https://example.com/search?q=${'x'.repeat(n)}`;

  test('a long address keeps what fits: the hero and the page’s details go first', async () => {
    const c: Captured = { ...PAGE, url: long(2500), hero: `https://cdn.example/${'h'.repeat(1500)}.jpg`, byline: 'B', site: 'S' };
    const { pending } = await prepare(c, ctx);
    const req = JSON.parse((await unwrap(user, pending.wrap)).rumor.content) as SaveRequest;
    expect(req).toMatchObject({ url: c.url, hero: null, token: PAIRING.token });
    expect(pending.wrap.content.length).toBeLessThan(8192);
  });

  test('a page whose text won’t fit goes without it, and the phone fetches the page', async () => {
    const { pending } = await prepare({ ...PAGE, url: long(2400) }, ctx);
    const req = JSON.parse((await unwrap(user, pending.wrap)).rumor.content) as SaveRequest;
    expect(req.html).toBeNull();
    expect(pending).toMatchObject({ blob: null, sha256: null, host: 'example.com' });
  });

  test('its toast is the one for a save without text, and Copy debug info says it went with no text', async () => {
    const n = net();
    const h = harness({ net: n.net });
    await h.work.save({ ...PAGE, url: long(2400) }, 1, false);
    expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
    expect(toastCopy({ ...h.toasts[1], shortcut: null })).toMatchObject({ title: 'Saved to Kefli', sub: 'example.com · your phone will fetch the text' });
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent, no text', link: false });
    // nothing was uploaded for it, and the wrap that went names no text
    expect(n.asked.uploads).toBe(0);
    expect((JSON.parse((await unwrap(user, n.published[0])).rumor.content) as SaveRequest).html).toBeNull();
    // a page whose text fits is Saved as before
    const fits = harness();
    await fits.work.save(PAGE, 1, false);
    expect(kinds(fits.toasts)).toEqual(['saving', 'saved']);
    expect((await history(fits.store))[0]).toMatchObject({ outcome: 'sent' });
  });

  test('an address too long on its own is refused with a toast, and nothing is queued', async () => {
    await expect(prepare(linkOnly(long(6000)), ctx)).rejects.toBeInstanceOf(AddressTooLongError);
    const h = harness();
    await h.work.save(linkOnly(long(6000)), 1, true);
    expect(kinds(h.toasts)).toEqual(['toolong']);
    expect(toastCopy({ ...h.toasts[0], shortcut: null })).toMatchObject({ title: 'Can’t save this page', tile: 'alert', tone: 'bad', timed: true });
    expect(await queued(h.store)).toEqual([]);
  });

  test('a page with no web address the capture script could still read, such as a file, says it can’t be saved', async () => {
    const h = harness();
    await h.work.save({ ...PAGE, url: 'file:///home/a.html' }, 1, false);
    expect(kinds(h.toasts)).toEqual(['browserpage']);
  });
});

describe('a capture the operator refuses (contract 4.4 and 5, v1.12)', () => {
  const FIGURES = { quota: 52_428_800, used: 52_401_000, daily: 20_971_520, today: 18_000 };
  /** Kefli's Blossom server answering every upload as section 5 has it: the reason in X-Reason and the body. */
  const operator = (status: number, reason: string) =>
    (async () => new Response(JSON.stringify({ v: 1, error: reason, ...(status === 413 && reason !== 'too_large' ? FIGURES : {}) }), { status, headers: { 'X-Reason': reason } })) as unknown as typeof fetch;
  const open = async (w: NostrEvent) => {
    const { rumor, seal } = await unwrap(user, w);
    return { rumor, seal, req: JSON.parse(rumor.content) as SaveRequest };
  };
  const devices = { v: 1 as const, devices: [{ device_pubkey: device.pubkey(), label: 'x', token: PAIRING.token, connected_at: NOW, revoked_at: null }] };

  test.each([
    [413, 'quota'],
    [413, 'daily'],
    [413, 'too_large'],
    [400, 'bad request'],
    [403, 'not_authorised'],
    [404, 'not found'],
    [409, 'conflict'],
    [415, 'unsupported media type'],
  ])('a %i %s: the request goes at once without its HTML, rebuilt and signed again, under the toast for a save without text', async (status, reason) => {
    const n = net({ blossom: operator(status, reason) });
    const h = harness({ net: n.net });
    await h.work.save(PAGE, 1, false);
    expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
    const [saving, done] = h.toasts;
    // the upload isn't tried again, and the wrap that goes isn't the one built before it, which named the refused blob
    expect(n.asked.uploads).toBe(1);
    expect(n.published).toHaveLength(1);
    const [w] = n.published;
    expect(w.id).toBe(done.id);
    expect(w.id).not.toBe(saving.id);
    expect(done).toMatchObject({ hash: saving.hash, title: 'A page', host: 'example.com', link: false });
    const { rumor, seal, req } = await open(w);
    expect(req).toEqual({ v: 1, url: PAGE.url, canonical: null, title: 'A page', site: null, byline: null, lang: 'en', hero: null, captured_at: NOW, token: PAIRING.token, html: null });
    expect(rumor.tags[0][1]).toMatch(/^kefli\/save-request\/[0-9a-f]{32}$/);
    expect(seal.pubkey).toBe(device.pubkey());
    expect(acceptSaveRequest(rumor, seal, devices, DEFAULTS.operator.blossom).ok).toBe(true);
    expect(await queued(h.store)).toEqual([]);
    expect(await history(h.store)).toMatchObject([{ outcome: 'sent, no text', link: false, id: w.id.slice(0, 8) }]);
    // Undo's key follows the new wrap, with no inbox blob to delete, and the first wrap's id points to it (F40)
    expect(await h.session.get(`undo:${saving.id}`)).toEqual({ to: w.id });
    expect(await h.session.get(`undo:${w.id}`)).toMatchObject({ sha256: null, hash: saving.hash });
  });

  test('a 413 with no reason and no body, as a proxy in front of the server may send, is a refusal too', async () => {
    const bare = (async () => new Response('', { status: 413 })) as unknown as typeof fetch;
    const n = net({ blossom: bare });
    const h = harness({ net: n.net });
    await h.work.save(PAGE, 1, false);
    expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
    expect((await open(n.published[0])).req.html).toBeNull();
  });

  test('the toast is the one for a save without text: Saved to Kefli, the host, the phone fetching the text, and Undo', async () => {
    const h = harness({ net: net({ blossom: operator(413, 'quota') }).net });
    await h.work.save(PAGE, 1, false);
    expect(toastCopy({ ...h.toasts[1], shortcut: 'Alt+Shift+S' })).toEqual({
      cover: h.toasts[0].hash, mark: 'ok', title: 'Saved to Kefli', sub: 'example.com · your phone will fetch the text', wrap: true, action: 'Undo', timed: true,
      say: 'Saved to Kefli. Your phone will fetch the text. Press Alt+Shift+S again to reach Undo.',
    });
  });

  test.each([
    [401, 'unauthorised'],
    [429, 'rate limited'],
    [500, 'server error'],
    [503, 'unavailable'],
    [507, 'disk_full'],
  ])('a %i %s isn’t a refusal for good: the save waits with its blob, and goes with its text once the server takes it', async (status, reason) => {
    const n = net({ blossom: operator(status, reason) });
    const h = harness({ net: n.net });
    await h.work.save(PAGE, 1, false);
    expect(kinds(h.toasts)).toEqual(['saving', 'failed']);
    expect(n.published).toEqual([]);
    const [e] = await queued(h.store);
    expect(e).toMatchObject({ id: h.toasts[0].id, why: 'reach', attempts: 0 });
    expect(e.blob).not.toBeNull();
    const later = net();
    await harness({ store: h.store, net: later.net }).work.flushQueue();
    expect(later.asked.uploads).toBe(1);
    expect(later.published.map((x) => x.id)).toEqual([e.id]);
    expect((await open(later.published[0])).req.html).toMatchObject({ sha256: e.sha256, server: DEFAULTS.operator.blossom });
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent from queue' });
  });

  test('Undo after the request went without its HTML retracts the new wrap with its own key, and deletes no blob', async () => {
    const n = net({ blossom: operator(413, 'daily') });
    const h = harness({ net: n.net, collected: [false, false] });
    await h.work.save(PAGE, 1, false);
    const [w] = n.published;
    await h.work.undo(h.toasts[1].id!, 1);
    expect(h.toasts.at(-1)!.kind).toBe('undone');
    const [del] = n.published.filter((e) => e.kind === 5);
    expect(del).toMatchObject({ pubkey: w.pubkey, tags: [['e', w.id], ['k', '1059']] });
    expect(n.asked.removes).toBe(0);
  });

  test('Undo on the offline toast, after a flush sent the save without its HTML, retracts the wrap that went (F40)', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    expect(offline.kind).toBe('offline');
    // the browser is online again and the queue goes while that toast still shows, its Undo naming the first wrap
    const n = net({ blossom: operator(413, 'quota') });
    const online = harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] });
    await online.work.flushQueue();
    const [w] = n.published;
    expect(w.id).not.toBe(offline.id);
    await online.work.undo(offline.id!, 1);
    expect(kinds(online.toasts)).toEqual(['undone']);
    const [del] = n.published.filter((e) => e.kind === 5);
    expect(del).toMatchObject({ pubkey: w.pubkey, tags: [['e', w.id], ['k', '1059']] });
    expect(n.asked.removes).toBe(0);
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'undo: retracted', id: w.id.slice(0, 8) });
    expect(await h.session.get(`undo:${w.id}`)).toBeUndefined();
  });

  test('Undo pressed while the queue sends the save waits for it, and retracts the wrap that went without its HTML (F40 a)', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    const held = gate();
    const refusing = operator(413, 'daily');
    const slow = async (input: RequestInfo | URL, init?: RequestInit) => {
      await held.p;
      return refusing(input, init);
    };
    const n = net({ blossom: slow as typeof fetch });
    const online = harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] });
    const flushing = online.work.flushQueue();
    await until(() => n.asked.uploads === 1);
    const undoing = online.work.undo(id, 1);
    for (let i = 0; i < 20; i++) await settled();
    expect(online.toasts).toEqual([]);
    held.open();
    await Promise.all([flushing, undoing]);
    expect(kinds(online.toasts)).toEqual(['undone']);
    const [w, del] = n.published;
    expect(w.id).not.toBe(id);
    expect(del).toMatchObject({ kind: 5, pubkey: w.pubkey, tags: [['e', w.id], ['k', '1059']] });
  });

  test('Undo on the offline toast while the request, sent again without its HTML, waits for the relay takes it off the queue', async () => {
    for (const onPhone of [false, true]) {
      const h = harness({ online: false });
      await h.work.save(PAGE, 1, false);
      const offline = h.toasts.at(-1)!;
      const n = net({ blossom: operator(413, 'quota'), publish: 'down' });
      const online = harness({ store: h.store, session: h.session, net: n.net, collected: [onPhone] });
      await online.work.flushQueue();
      const [e] = await queued(h.store);
      expect(e.id).not.toBe(offline.id);
      await online.work.undo(offline.id!, 1);
      expect(await queued(h.store)).toEqual([]);
      // its send may have reached the relay all the same, so the new wrap is retracted too, with its own key
      expect(n.published.filter((x) => x.kind === 5).map((x) => [x.pubkey, x.tags])).toEqual([[e.wrap.pubkey, [['e', e.id], ['k', '1059']]]]);
      expect(online.toasts.at(-1)).toMatchObject({ kind: onPhone ? 'onphone' : 'unqueued' });
    }
  });

  test('a save waiting in the queue that is then refused goes from there without its HTML, under a new wrap', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const [waiting] = await queued(h.store);
    expect(waiting.blob).not.toBeNull();
    const n = net({ blossom: operator(413, 'quota') });
    const online = harness({ store: h.store, session: h.session, net: n.net });
    await online.work.flushQueue();
    expect(n.asked.uploads).toBe(1);
    const [w] = n.published;
    expect(w.id).not.toBe(waiting.id);
    expect((await open(w)).req).toMatchObject({ url: PAGE.url, title: 'A page', html: null });
    expect(await queued(h.store)).toEqual([]);
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent, no text', id: w.id.slice(0, 8) });
    expect(online.toasts).toEqual([]);
    expect(await h.session.get(`undo:${w.id}`)).toMatchObject({ sha256: null });
  });

  test.each([['', false], [', with storage.session slow to write', true]])('a move taken while the operator refuses the upload%s: the save still goes, and Undo on its toast reaches both its wraps', async (_name, slowSession) => {
    const T = new LocalSigner(hexToBytes('33'.repeat(32)));
    const ack: PairAck = { v: 1, user_pubkey: T.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: ['https://blossom.example'], token: 'cd'.repeat(32), moved_from: user.pubkey() };
    const held = gate();
    const refusing = operator(413, 'quota');
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await held.p;
      return refusing(input, init);
    }) as typeof fetch;
    const n = net({ blossom: slow });
    const session = memoryStore();
    const set = session.set.bind(session);
    if (slowSession) session.set = async (k, v) => (await new Promise((r) => setTimeout(r, 50)), set(k, v));
    const h = harness({ net: n.net, session, collected: [false, false] });
    const saving = h.work.save(PAGE, 1, false);
    await until(() => n.asked.uploads === 1);
    // the background finds the move while the upload waits on the operator, which then refuses it; with a slow session,
    // the refusal comes before Undo's key has followed the move
    await h.store.set(KEYS.pairing, PAIRING);
    const moving = applyMove(h.store, device, ack, NOW, h.session, h.work.follow);
    if (!slowSession) await moving;
    else await until(async () => (await queued(h.store))[0]?.wrap.tags[0][1] === T.pubkey());
    const [moved] = await queued(h.store);
    held.open();
    await Promise.all([saving, moving]);
    expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
    expect(n.published.filter((e) => e.kind === 1059)).toHaveLength(1);
    // Undo reaches the wrap that went and the one the move made, which would otherwise go to the new library later
    await h.work.undo(h.toasts.at(-1)!.id!, 1);
    expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags[0][1])).toContain(n.published[0].id);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
    expect(await queued(h.store)).toEqual([]);
    expect(moved.id).not.toBe(n.published[0].id);
    const later = net({ blossom: operator(413, 'quota') });
    await harness({ store: h.store, session: h.session, net: later.net }).work.flushQueue();
    expect(later.published).toEqual([]);
  });

  test('a flush that starts while a refused save goes again leaves it to that save, so it goes once, under its own toast', async () => {
    const held = gate();
    const n = net({ blossom: operator(413, 'quota'), hold: held.p });
    const h = harness({ net: n.net });
    const saving = h.work.save(PAGE, 1, false);
    // the new wrap is in the queue under its new id, and its publish is under way
    await until(() => n.asked.n === 1);
    const [e] = await queued(h.store);
    expect(e).toMatchObject({ blob: null, sha256: null, why: 'sending' });
    expect(e.id).not.toBe(h.toasts[0].id);
    const flushing = h.work.flushQueue();
    for (let i = 0; i < 50; i++) await settled();
    expect(n.asked.n).toBe(1);
    held.open();
    await Promise.all([saving, flushing]);
    expect(n.asked.n).toBe(1);
    expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
    expect((await history(h.store)).map((e) => e.outcome)).toEqual(['sent, no text']);
  });

  test('refused part way through a pass over the queue: the saves before keep their text, those after go without it', async () => {
    const h = harness({ online: false });
    for (const i of [1, 2, 3]) await h.work.save({ ...PAGE, url: `https://example.com/${i}` }, 1, false);
    const q = await queued(h.store);
    // the day's 20 MB runs out after the first upload
    let k = 0;
    const daily = operator(413, 'daily');
    const blossom = (async (input: RequestInfo | URL, init?: RequestInit) =>
      k++ === 0 ? new Response(JSON.stringify({ sha256: q[0].sha256 }), { status: 200 }) : daily(input, init)) as typeof fetch;
    const n = net({ blossom });
    await harness({ store: h.store, session: h.session, net: n.net }).work.flushQueue();
    expect(n.asked.uploads).toBe(3);
    const sent = await Promise.all(n.published.map(open));
    expect(sent.map((s) => [s.req.url, s.req.html === null])).toEqual([['https://example.com/1', false], ['https://example.com/2', true], ['https://example.com/3', true]]);
    expect(n.published[0].id).toBe(q[0].id);
    expect(await queued(h.store)).toEqual([]);
    expect((await history(h.store)).slice(0, 3).map((e) => e.outcome)).toEqual(['sent, no text', 'sent, no text', 'sent from queue']);
  });

  test('a move into a full library: a save waiting from before the move goes to the new library, with its token, without its HTML', async () => {
    const T = new LocalSigner(hexToBytes('33'.repeat(32)));
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    await h.store.set(KEYS.pairing, PAIRING);
    const ack: PairAck = { v: 1, user_pubkey: T.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: ['https://blossom.example'], token: 'cd'.repeat(32), moved_from: user.pubkey() };
    const moved = await applyMove(h.store, device, ack, NOW, h.session);
    const n = net({ blossom: operator(413, 'quota') });
    // the background reads the new library's pairing after the move
    await harness({ store: h.store, net: n.net, pairing: moved }).work.flushQueue();
    expect(n.asked.uploads).toBe(1);
    const [w] = n.published;
    expect(w.tags).toEqual([['p', T.pubkey()]]);
    const { rumor, seal } = await unwrap(T, w);
    const req = JSON.parse(rumor.content) as SaveRequest;
    expect(req).toMatchObject({ url: PAGE.url, token: 'cd'.repeat(32), html: null });
    expect(seal.pubkey).toBe(device.pubkey());
    expect(await queued(h.store)).toEqual([]);
  });

  test('one queued in an earlier browser session, its Undo key gone with that session, goes the same way', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const n = net({ blossom: operator(413, 'daily') });
    const later = harness({ store: h.store, net: n.net });
    await later.work.flushQueue();
    const [w] = n.published;
    expect((await open(w)).req.html).toBeNull();
    expect(await queued(h.store)).toEqual([]);
    expect(await later.session.get(`undo:${w.id}`)).toBeUndefined();
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent, no text', id: w.id.slice(0, 8) });
  });

  test('one whose request then can’t reach the relay waits under its new wrap, and goes later without uploading again', async () => {
    const down = net({ blossom: operator(413, 'quota'), publish: 'down' });
    const h = harness({ net: down.net });
    await h.work.save(PAGE, 1, false);
    expect(kinds(h.toasts)).toEqual(['saving', 'failed']);
    const [e] = await queued(h.store);
    expect(e).toMatchObject({ id: h.toasts[1].id, blob: null, sha256: null, why: 'reach' });
    expect(e.id).not.toBe(h.toasts[0].id);
    expect((await open(e.wrap)).req.html).toBeNull();
    // the relay is back: the same wrap goes, and the server isn't asked again
    const up = net({ blossom: operator(413, 'quota') });
    await harness({ store: h.store, net: up.net }).work.flushQueue();
    expect(up.asked.uploads).toBe(0);
    expect(up.published.map((x) => x.id)).toEqual([e.id]);
    expect(await queued(h.store)).toEqual([]);
  });

  test('sent later, by the same background or one started since, it is recorded as sent with no text', async () => {
    for (const same of [true, false]) {
      const o: Parameters<typeof net>[0] = { blossom: operator(413, 'daily'), publish: 'down' };
      const h = harness({ net: net(o).net });
      await h.work.save(PAGE, 1, false);
      // the queue keeps the mark, since the next minute's flush often runs in a new service worker
      const [e] = await queued(h.store);
      expect(e).toMatchObject({ textless: true, blob: null, sha256: null });
      o.publish = 'ok';
      await (same ? h : harness({ store: h.store, session: h.session })).work.flushQueue();
      expect(await queued(h.store)).toEqual([]);
      expect((await history(h.store)).map((x) => [x.id, x.outcome])).toEqual([[e.id.slice(0, 8), 'sent, no text'], [e.id.slice(0, 8), 'waiting, couldn’t reach']]);
    }
  });

  test('Retry learns whether its save went: under its new wrap when sent without its HTML, and not while it still waits', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    await h.work.save({ ...PAGE, url: 'https://example.com/b' }, 1, false);
    const [first, second] = await queued(h.store);
    // the relay is down: the first goes again without its HTML, and waits under its new wrap
    const o: Parameters<typeof net>[0] = { blossom: operator(413, 'quota'), publish: 'down' };
    const online = harness({ store: h.store, session: h.session, net: net(o).net });
    expect(await online.work.flushQueue(true, first.id)).toEqual([]);
    const waitingNow = (await queued(h.store)).find((e) => e.id !== second.id)!;
    expect(waitingNow).toMatchObject({ textless: true });
    expect(waitingNow.id).not.toBe(first.id);
    o.publish = 'ok';
    expect(await online.work.flushQueue(true, waitingNow.id)).toEqual([waitingNow.id]);
    expect((await queued(h.store)).map((e) => e.id)).toEqual([second.id]);
    // and a pass with nothing paired sends nothing
    expect(await harness({ paired: false, store: h.store }).work.flushQueue(true, second.id)).toEqual([]);
  });

  test('a save waiting with its HTML is recorded as sent from the queue, as before', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const [e] = await queued(h.store);
    expect(e.textless).toBeUndefined();
    await harness({ store: h.store }).work.flushQueue();
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent from queue', id: e.id.slice(0, 8) });
  });

  test('a waiting save whose sealed request can’t be read still goes as it was wrapped, and the phone fetches the page', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const q = await queued(h.store);
    q[0].sealed = 'from before requests were kept';
    await h.store.set(KEYS.queue, q);
    const n = net({ blossom: operator(413, 'too_large') });
    await harness({ store: h.store, net: n.net }).work.flushQueue();
    expect(n.published.map((w) => w.id)).toEqual([q[0].id]);
    expect(await queued(h.store)).toEqual([]);
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent, no text', id: q[0].id.slice(0, 8) });
  });

  describe('with the browser’s own storage letting it down', () => {
    test('a queue that won’t take the new wrap: the save goes under the wrap the queue still names, and nothing is left to go again', async () => {
      // the save goes into the queue, the write putting the new wrap in its place is refused, and the settle after it is taken
      const store = refusingWrites(KEYS.queue, (k) => k === 2);
      const n = net({ blossom: operator(413, 'quota') });
      const h = harness({ store, net: n.net, collected: [false, false] });
      expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
      expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
      const [saving, done] = h.toasts;
      // the wrap built before the upload goes, as one that can't be rebuilt does, and the phone fetches the page itself
      expect(n.published.map((w) => w.id)).toEqual([saving.id]);
      expect(done.id).toBe(saving.id);
      expect(await queued(store)).toEqual([]);
      expect((await history(store))[0]).toMatchObject({ outcome: 'sent, no text', id: saving.id!.slice(0, 8) });
      // Undo retracts the wrap that went, and no copy left in the queue sends the save again afterwards
      await h.work.undo(done.id!, 1);
      expect(h.toasts.at(-1)!.kind).toBe('undone');
      expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags)).toEqual([[['e', saving.id], ['k', '1059']]]);
      const later = net();
      await harness({ store, net: later.net }).work.flushQueue();
      expect(later.published).toEqual([]);
    });

    test('a queue that won’t keep the save before its send, which then can’t reach the relay, keeps it smaller with its mark', async () => {
      // the first write, the save going in with its text, is refused; the smaller one after the send is taken
      const store = refusing(KEYS.queue, 1);
      const h = harness({ store, net: net({ blossom: operator(413, 'daily'), publish: 'down' }).net });
      expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
      expect(kinds(h.toasts)).toEqual(['saving', 'failed']);
      const [e] = await queued(store);
      expect(e).toMatchObject({ id: h.toasts[1].id, textless: true, blob: null, sha256: null, why: 'reach' });
      expect(e.id).not.toBe(h.toasts[0].id);
      expect((await open(e.wrap)).req.html).toBeNull();
      // a background started since sends it, and Copy debug info says it went with no text
      const later = net();
      await harness({ store, net: later.net }).work.flushQueue();
      expect(later.published.map((w) => w.id)).toEqual([e.id]);
      expect((await history(store))[0]).toMatchObject({ outcome: 'sent, no text', id: e.id.slice(0, 8) });
    });

    test('a session that won’t keep the new wrap’s key doesn’t stop the save; Undo then says it couldn’t', async () => {
      // the save's own key is kept, and every write after it is refused
      const session = refusingWrites('undo:', (k) => k > 1);
      const n = net({ blossom: operator(413, 'quota') });
      const h = harness({ session, net: n.net, collected: [false, false] });
      expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
      expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
      const [w] = n.published;
      expect(w.id).toBe(h.toasts[1].id);
      expect((await open(w)).req.html).toBeNull();
      await h.work.undo(h.toasts[1].id!, 1);
      expect(h.toasts.at(-1)!.kind).toBe('undofailed');
    });

    test('a history storage won’t write doesn’t stop a refused save, sent at once or from the queue', async () => {
      const store = refusing(KEYS.history);
      const h = harness({ store, net: net({ blossom: operator(413, 'too_large') }).net });
      expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
      expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
      await harness({ store, online: false }).work.save({ ...PAGE, url: 'https://example.com/b' }, 1, false);
      const n = net({ blossom: operator(413, 'quota') });
      expect(await ends(harness({ store, net: n.net }).work.flushQueue())).toBe('ended');
      expect((await open(n.published[0])).req.html).toBeNull();
      expect(await queued(store)).toEqual([]);
    });
  });
});

/** A store whose every call takes a while, as chrome.storage does, so changes that aren't locked interleave. */
function slowStore(): Store & { data: Map<string, unknown> } {
  const m = memoryStore();
  const later = <T>(f: () => Promise<T>, ms: number) => new Promise<T>((r) => setTimeout(() => void f().then(r), ms));
  return { data: m.data, get: (k) => later(() => m.get(k), 5), set: (k, v) => later(() => m.set(k, v), 5), remove: (k) => later(() => m.remove(k), 5) };
}

const entry = (id: string): Pending => ({ id, wrap: { id } as NostrEvent, sealed: '', blob: null, sha256: null, hash: 'h', title: 't', host: 'h', created_at: NOW, attempts: 0 });

describe('a wrap that waited (contract 4.4: the phone reads its inbox from two days and five minutes before its last look)', () => {
  const DAY = 86_400;
  /** Where the phone's next look at its inbox starts, after a look at lastLook (mobile services/inbox.ts, WRAP_LOOKBACK). */
  const phoneSince = (lastLook: number) => lastLook - 172_800 - 300;
  /** Both clocks at t: the background's, and the one giftWrap dates seals and wraps from. */
  const at = (h: { clock: { now: number } }, t: number) => {
    h.clock.now = t;
    jest.spyOn(Date, 'now').mockReturnValue(t * 1000);
  };
  afterEach(() => jest.restoreAllMocks());
  const open = async (w: NostrEvent) => {
    const { rumor } = await unwrap(user, w);
    return { tags: rumor.tags, req: JSON.parse(rumor.content) as SaveRequest };
  };

  test('a save that waited in the queue goes under a wrap made as it goes, which a phone that looked meanwhile finds', async () => {
    const h = harness({ online: false });
    at(h, NOW);
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    const [waited] = await queued(h.store);
    // three days on, the browser is online again; the phone last looked an hour ago, past the date the save was wrapped under
    const n = net();
    const online = harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] });
    at(online, NOW + 3 * DAY);
    await online.work.flushQueue();
    const [w] = n.published;
    expect(waited.wrap.created_at).toBeLessThan(phoneSince(NOW + 3 * DAY - 3600));
    expect(w.created_at).toBeGreaterThanOrEqual(phoneSince(NOW + 3 * DAY - 3600));
    expect(w.id).not.toBe(waited.id);
    // the same request, its uuid, HTML and token kept, and its blob uploaded once
    expect(await open(w)).toEqual(await open(waited.wrap));
    expect(n.asked.uploads).toBe(1);
    expect(await queued(h.store)).toEqual([]);
    // the offline toast's Undo follows it: the wrap that went is retracted with its own key, and the inbox blob deleted
    await online.work.undo(offline.id!, 1);
    expect(kinds(online.toasts)).toEqual(['undone']);
    expect(n.published.find((e) => e.kind === 5)).toMatchObject({ pubkey: w.pubkey, tags: [['e', w.id], ['k', '1059']] });
    expect(n.asked.removes).toBe(1);
  });

  test('a wrap made within the minute goes as it was', async () => {
    const h = harness({ online: false });
    at(h, NOW);
    await h.work.save(PAGE, 1, false);
    const [e] = await queued(h.store);
    expect(e.wrapped_at).toBe(NOW);
    const n = net();
    const online = harness({ store: h.store, net: n.net });
    at(online, NOW + WRAP_FRESH_FOR);
    await online.work.flushQueue();
    expect(n.published.map((x) => x.id)).toEqual([e.id]);
  });

  test('one whose send keeps failing is made again at each try, and the offline toast’s Undo still finds the last', async () => {
    const h = harness({ online: false });
    at(h, NOW);
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    const n = net({ publish: 'down' });
    const online = harness({ store: h.store, session: h.session, net: n.net, collected: [false] });
    at(online, NOW + 120);
    await online.work.flushQueue();
    const [first] = await queued(h.store);
    at(online, NOW + 240);
    await online.work.flushQueue();
    const [second] = await queued(h.store);
    expect(new Set([offline.id, first.id, second.id]).size).toBe(3);
    expect(second).toMatchObject({ attempts: 2, wrapped_at: NOW + 240, blob: null });
    await online.work.undo(offline.id!, 1);
    expect(await queued(h.store)).toEqual([]);
    // its send may have reached the relay all the same, so the last wrap is retracted, with its own key
    expect(n.published.filter((x) => x.kind === 5).map((x) => [x.pubkey, x.tags])).toEqual([[second.wrap.pubkey, [['e', second.id], ['k', '1059']]]]);
  });

  test('offline, a wrap that waited is left as it is, since its send fails anyway, and the try counts no attempt', async () => {
    const h = harness({ online: false });
    at(h, NOW);
    await h.work.save(linkOnly(PAGE.url), 1, true);
    const [e] = await queued(h.store);
    const still = harness({ store: h.store, online: false, net: net({ publish: 'down' }).net });
    at(still, NOW + DAY);
    await still.work.flushQueue();
    expect(await queued(h.store)).toMatchObject([{ id: e.id, wrapped_at: NOW, attempts: 0 }]);
  });

  test('a save queued by an earlier build, with no time for its wrap, counts as wrapped long ago', async () => {
    const h = harness({ online: false });
    at(h, NOW);
    await h.work.save(PAGE, 1, false);
    const q = await queued(h.store);
    delete q[0].wrapped_at;
    await h.store.set(KEYS.queue, q);
    const n = net();
    const online = harness({ store: h.store, net: n.net });
    at(online, NOW);
    await online.work.flushQueue();
    expect(n.published).toHaveLength(1);
    expect(n.published[0].id).not.toBe(q[0].id);
  });

  test('a save whose upload took more than a minute goes under a wrap made after it, which its toast and Undo name', async () => {
    let h: ReturnType<typeof harness> | null = null;
    const n = net();
    const slow: Net = { ...n.net, upload: async (...a) => ((h!.clock.now += 90), n.net.upload(...a)) };
    h = harness({ net: slow, collected: [false, false] });
    at(h, NOW);
    await h.work.save(PAGE, 1, false);
    const [saving, saved] = h.toasts;
    const [w] = n.published;
    expect(saved).toMatchObject({ kind: 'saved', id: w.id });
    expect(w.id).not.toBe(saving.id);
    await h.work.undo(saved.id!, 1);
    expect(n.published.find((e) => e.kind === 5)).toMatchObject({ pubkey: w.pubkey, tags: [['e', w.id], ['k', '1059']] });
  });

  test('one sent without its HTML that waited, then made again, is still recorded as sent with no text', async () => {
    const quota = (async () => new Response('{"v":1,"error":"quota"}', { status: 413, headers: { 'X-Reason': 'quota' } })) as unknown as typeof fetch;
    for (const same of [true, false]) {
      const o: Parameters<typeof net>[0] = { blossom: quota, publish: 'down' };
      const h = harness({ net: net(o).net });
      at(h, NOW);
      await h.work.save(PAGE, 1, false);
      const [e] = await queued(h.store);
      expect(e.textless).toBe(true);
      // ten minutes on the relay is back, and the wrap that waited is made again as it goes
      o.publish = 'ok';
      const flusher = same ? h : harness({ store: h.store, session: h.session, net: net(o).net });
      at(flusher, NOW + 600);
      await flusher.work.flushQueue();
      expect(await queued(h.store)).toEqual([]);
      const [last] = await history(h.store);
      expect(last.outcome).toBe('sent, no text');
      expect(last.id).not.toBe(e.id.slice(0, 8));
    }
  });

  test('a move wraps the queue again from the time of the move', async () => {
    const h = harness({ online: false });
    at(h, NOW);
    await h.work.save(PAGE, 1, false);
    await h.store.set(KEYS.pairing, PAIRING);
    const ack: PairAck = { v: 1, user_pubkey: user.pubkey(), write_relays: [], blossom_servers: [], token: 'cd'.repeat(32), moved_from: user.pubkey() };
    await applyMove(h.store, device, ack, NOW + 500, h.session);
    expect(await queued(h.store)).toMatchObject([{ wrapped_at: NOW + 500 }]);
  });
});

describe('the queue’s lock (F41)', () => {
  test('a save queued while a send settles, or while a move wraps the queue again, is kept', async () => {
    const store = slowStore();
    await enqueue(store, entry('a'), 'reach');
    await Promise.all([settle(store, entry('a'), 'unreachable', true), enqueue(store, entry('b'), 'reach'), dequeue(store, 'none')]);
    expect((await queued(store)).map((e) => e.id).sort()).toEqual(['a', 'b']);
    await store.set(KEYS.pairing, PAIRING);
    const ack: PairAck = { v: 1, user_pubkey: user.pubkey(), write_relays: [], blossom_servers: [], token: 'cd'.repeat(32), moved_from: user.pubkey() };
    await Promise.all([applyMove(store, device, ack, NOW, memoryStore()), enqueue(store, entry('c'), 'offline')]);
    expect((await queued(store)).map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('a move found by two looks at once is taken once: each waiting save is wrapped again once, and its Undo key moved once', async () => {
    const T = new LocalSigner(hexToBytes('33'.repeat(32)));
    const ack: PairAck = { v: 1, user_pubkey: T.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: [], token: 'cd'.repeat(32), moved_from: user.pubkey() };
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    const [before] = await queued(h.store);
    await h.store.set(KEYS.pairing, PAIRING);
    // two saves made together, or a save as the half-hourly look runs, each look for a move (bg.ts checkMoves)
    const [a, b] = await Promise.all([applyMove(h.store, device, ack, NOW, h.session), applyMove(h.store, device, ack, NOW, h.session)]);
    expect(a).toEqual(b);
    const [moved] = await queued(h.store);
    expect(await h.session.get(`undo:${before.id}`)).toEqual({ to: moved.id });
    expect(await h.session.get(`undo:${moved.id}`)).toMatchObject({ hash: offline.hash });
    // and a later look that finds the same pair-ack again changes nothing
    await applyMove(h.store, device, ack, NOW + 60, h.session);
    expect((await queued(h.store)).map((e) => e.id)).toEqual([moved.id]);
  });

  test('a save given a new id mid-run is busy under it until that run ends, and a run under it waits (v1.12)', async () => {
    const saves = new PerSave();
    const held = gate();
    const order: string[] = [];
    const first = saves.run('old', async () => {
      saves.follow('old', 'new');
      await held.p;
      order.push('old');
    });
    // the run's work starts a turn later, and gives the save its new id there
    await settled();
    expect(saves.busy('new')).toBe(true);
    const next = saves.run('new', async () => void order.push('new'));
    await settled();
    expect(order).toEqual([]);
    held.open();
    await Promise.all([first, next]);
    expect(order).toEqual(['old', 'new']);
    await settled();
    expect([saves.busy('old'), saves.busy('new')]).toEqual([false, false]);
    // with nothing running under the old id, nothing is held
    saves.follow('idle', 'other');
    expect(saves.busy('other')).toBe(false);
  });

  test('a change that throws leaves the queue as it was, and the next still runs', async () => {
    const store = memoryStore();
    await enqueue(store, entry('a'), 'offline');
    await expect(changeQueue(store, (q) => { q.splice(0); throw new Error('no'); })).rejects.toThrow('no');
    expect(await queued(store)).toHaveLength(1);
    expect(await dequeue(store, 'a')).toBe(true);
  });
});

describe('Advanced’s relays (F43)', () => {
  test('a generated identity: Kefli’s relay, then the backups', () => {
    expect(relayRows(['wss://relay.example', 'wss://a.example', 'wss://b.example'], DEFAULTS)).toEqual([
      { url: 'wss://relay.example', label: 'Kefli', operator: true },
      { url: 'wss://a.example', label: 'Backup 1', operator: false },
      { url: 'wss://b.example', label: 'Backup 2', operator: false },
    ]);
  });
  test('a nostr user’s own relays come first in the list, yet Kefli’s is named by its address and listed first', () => {
    expect(relayRows(['wss://nos.lol', 'wss://their.relay', 'wss://a.example', 'wss://relay.example/'], DEFAULTS)).toEqual([
      { url: 'wss://relay.example/', label: 'Kefli', operator: true },
      { url: 'wss://nos.lol', label: 'Your relay', operator: false },
      { url: 'wss://their.relay', label: 'Your relay', operator: false },
      { url: 'wss://a.example', label: 'Backup 1', operator: false },
    ]);
  });
  test('with Keep backup copies off, Kefli’s relay is still shown, as the one this browser sends to', () => {
    expect(relayRows(['wss://nos.lol'], DEFAULTS)[0]).toEqual({ url: 'wss://relay.example', label: 'Kefli', operator: true });
  });
});

describe('hardening (F52)', () => {
  const T = new LocalSigner(hexToBytes('33'.repeat(32)));
  const ackTo = (to: LocalSigner, from: string, token: string): PairAck => ({ v: 1, user_pubkey: to.pubkey(), write_relays: ['wss://t.example'], blossom_servers: ['https://bt.example'], token, moved_from: from });

  test('a library that moved away and back is followed to where it ended, and the look ends', async () => {
    const st = (await wrapPairAck(user, device.pubkey(), ackTo(T, user.pubkey(), 'a1'.repeat(32)), NOW)).wrap;
    const ts = (await wrapPairAck(T, device.pubkey(), ackTo(user, T.pubkey(), 'b1'.repeat(32)), NOW + 60)).wrap;
    expect(await followMoves(device, [ts, st], user.pubkey())).toMatchObject({ user_pubkey: user.pubkey(), token: 'b1'.repeat(32) });
    expect(await followMoves(device, [st], T.pubkey())).toBeNull();
  });

  test('two pages making the device key at once end with one key', async () => {
    const store = slowStore();
    const [a, b] = await Promise.all([deviceSigner(store, webCrypto), deviceSigner(store, webCrypto)]);
    expect(a.pubkey()).toBe(b.pubkey());
    expect((await deviceSigner(store, webCrypto)).pubkey()).toBe(a.pubkey());
  });

  test('a move whose token comes as a list of one keeps it as a string, in the pairing and in the saves wrapped again for it', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    await h.store.set(KEYS.pairing, PAIRING);
    // the pair-ack's shape check reads the token through String(), so a list holding one token passes it
    const listed = { ...ackTo(T, user.pubkey(), 'cd'.repeat(32)), token: ['cd'.repeat(32)] as unknown as string };
    const ack = await followMoves(device, [(await wrapPairAck(user, device.pubkey(), listed, NOW)).wrap], user.pubkey());
    expect(ack?.token).toEqual(['cd'.repeat(32)]);
    const moved = await applyMove(h.store, device, ack!, NOW, h.session);
    expect(moved.token).toBe('cd'.repeat(32));
    expect((await h.store.get<Pairing>(KEYS.pairing))?.token).toBe('cd'.repeat(32));
    const [e] = await queued(h.store);
    expect((JSON.parse((await unwrap(T, e.wrap)).rumor.content) as SaveRequest).token).toBe('cd'.repeat(32));
  });
});

/** Whether a promise ends within ms, and how: the saves below otherwise never end, or end in a rejection nobody hears. */
function ends(p: Promise<unknown>, ms = 15_000): Promise<string> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((r) => (t = setTimeout(() => r('still pending'), ms)));
  return Promise.race([p.then(() => 'ended', (e: unknown) => `rejected: ${String(e)}`), late]).finally(() => clearTimeout(t));
}

/** A store whose writes to one key are refused, as chrome.storage refuses a write past its quota. */
function refusing(key: string, times = Infinity): Store & { data: Map<string, unknown> } {
  const store = memoryStore();
  const set = store.set.bind(store);
  let left = times;
  store.set = async (k, v) => {
    if (k === key && left-- > 0) throw new Error('QUOTA_BYTES quota exceeded');
    return set(k, v);
  };
  return store;
}

/** A store that refuses the writes `refused` names, counted from one among the writes to keys starting with `prefix`. */
function refusingWrites(prefix: string, refused: (n: number) => boolean): Store & { data: Map<string, unknown> } {
  const store = memoryStore();
  const set = store.set.bind(store);
  let n = 0;
  store.set = async (k, v) => {
    if (k.startsWith(prefix) && refused(++n)) throw new Error('QUOTA_BYTES quota exceeded');
    return set(k, v);
  };
  return store;
}

describe('a save the browser’s own parts let down', () => {
  test('a toast the page never lets show doesn’t hold the save: it is sent, and nothing is left at Saving…', async () => {
    const n = net();
    const h = harness({ net: n.net, toast: () => new Promise<void>(() => undefined) });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(n.published.map((e) => e.kind)).toEqual([1059]);
    expect(await queued(h.store)).toEqual([]);
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'sent' });
  });

  test('a toast slow to show still lands before the one that replaces it', async () => {
    const shown: string[] = [];
    const slow = gate();
    const h = harness({
      toast: async (_w, s) => {
        if (s.kind === 'saving') await slow.p;
        shown.push(s.kind);
      },
    });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    slow.open();
    await until(() => shown.length === 2);
    expect(shown).toEqual(['saving', 'saved']);
  });

  test('a look for a move that fails leaves the key as it was: the save and the queue’s flush still go', async () => {
    const n = net();
    const failing = async () => {
      throw new Error('storage gone');
    };
    const h = harness({ net: n.net, online: false, checkMovesSoon: failing });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'offline']);
    const online = harness({ store: h.store, net: n.net, checkMovesSoon: failing });
    expect(await ends(online.work.flushQueue())).toBe('ended');
    expect(n.published.map((e) => e.kind)).toEqual([1059]);
    expect(await queued(h.store)).toEqual([]);
  });

  test('a session that can’t keep the Undo key doesn’t stop the save; Undo then says it couldn’t', async () => {
    const session = refusing('undo:', 0);
    session.set = async () => {
      throw new Error('QUOTA_BYTES quota exceeded');
    };
    const h = harness({ session, collected: [false, false] });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'saved']);
    await h.work.undo(h.toasts[0].id!, 1);
    expect(h.toasts.at(-1)!.kind).toBe('undofailed');
  });

  test('a queue storage.local won’t write: the save is still sent, and one that can’t be sent is refused out loud', async () => {
    const n = net();
    const h = harness({ store: refusing(KEYS.queue), net: n.net });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'saved']);
    expect(n.published).toHaveLength(1);
    const down = harness({ store: refusing(KEYS.queue), net: net({ publish: 'down' }).net });
    expect(await ends(down.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(down.toasts)).toEqual(['saving', 'full']);
    expect((await history(down.store))[0]).toMatchObject({ outcome: 'queue full' });
  });

  test('a queue storage.local can’t read: the save still ends on its toast, Saved once sent, refused out loud when it can’t be', async () => {
    /** storage.local whose reads of the queue fail, as in a profile whose database is damaged. */
    const unreadable = () => {
      const store = memoryStore();
      const get = store.get.bind(store);
      store.get = (async (k: string) => {
        if (k === KEYS.queue) throw new Error('IO error: database corrupt');
        return get(k);
      }) as Store['get'];
      return store;
    };
    const n = net();
    const h = harness({ store: unreadable(), net: n.net, collected: [false, false] });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'saved']);
    expect(n.published).toHaveLength(1);
    // its Undo still retracts it, and says so
    expect(await ends(h.work.undo(h.toasts[1].id!, 1))).toBe('ended');
    expect(h.toasts.at(-1)!.kind).toBe('undone');
    expect(n.published.filter((e) => e.kind === 5)).toHaveLength(1);
    // one that can't be sent either isn't left at Saving…, and the alarm stays on for the next minute's look
    const down = harness({ store: unreadable(), online: false });
    expect(await ends(down.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(down.toasts)).toEqual(['saving', 'full']);
    expect(down.alarm.on).toBe(true);
  });

  test('a save refused by storage before its send, and not sent, is kept without its text when it can be', async () => {
    // the first write, the save going in with its text, is refused; the smaller one after the send is taken
    const store = refusing(KEYS.queue, 1);
    const h = harness({ store, net: net({ publish: 'down' }).net });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'failed']);
    expect(await queued(store)).toMatchObject([{ why: 'reach', blob: null, attempts: 0, stopped: false }]);
  });

  test('a history storage won’t write doesn’t stop a save, its toast or the queue’s flush', async () => {
    const store = refusing(KEYS.history);
    const h = harness({ store, online: false });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'offline']);
    const online = harness({ store });
    expect(await ends(online.work.flushQueue())).toBe('ended');
    expect(await queued(store)).toEqual([]);
  });

  test('a toast the page never lets show holds neither a save that waits nor its Undo', async () => {
    const h = harness({ online: false, toast: () => new Promise<void>(() => undefined) });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    const [e] = await queued(h.store);
    expect(e).toMatchObject({ why: 'offline' });
    expect(await ends(h.work.undo(e.id, 1))).toBe('ended');
    expect(await queued(h.store)).toEqual([]);
  });

  test('a session that can’t be read still lets Undo take a waiting save off the queue', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    // Undo looks first for a wrap that took the toast's place, then for the key
    h.session.get = async () => {
      throw new Error('storage gone');
    };
    expect(await ends(h.work.undo(h.toasts[0].id!, 1))).toBe('ended');
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
    expect(await queued(h.store)).toEqual([]);
  });

  test('a toast the page never lets show holds no Undo of a save that went, under the wrap it went by', async () => {
    const named: string[] = [];
    const n = net({ blossom: (async () => new Response('', { status: 413 })) as unknown as typeof fetch });
    const h = harness({ net: n.net, collected: [false, false], toast: (_w, s) => (named.push(s.id!), new Promise<void>(() => undefined)) });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    // only the Saving… toast reaches the page, naming the wrap built before the refused upload; a new one went
    const [w] = n.published;
    expect(w.id).not.toBe(named[0]);
    expect(await ends(h.work.undo(named[0], 1))).toBe('ended');
    expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags)).toEqual([[['e', w.id], ['k', '1059']]]);
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'undo: retracted' });
  });

  test('a page that can’t be saved isn’t held by a toast the page never lets show either', async () => {
    const h = harness({ toast: () => new Promise<void>(() => undefined) });
    expect(await ends(h.work.save({ ...PAGE, url: 'file:///home/a.html' }, 1, false))).toBe('ended');
    expect(await queued(h.store)).toEqual([]);
  });

  test('a settle storage won’t write leaves the save queued under the wrap it went by, for the next flush to send', async () => {
    // the save goes in, the new wrap its refused HTML gave it takes the old one's place, and the write settling it is refused
    const store = refusingWrites(KEYS.queue, (k) => k === 3);
    const n = net({ blossom: (async () => new Response('', { status: 413 })) as unknown as typeof fetch });
    const h = harness({ store, net: n.net });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'notext']);
    const [w] = n.published;
    expect(await queued(store)).toMatchObject([{ id: w.id, why: 'sending', blob: null, textless: true }]);
    // the next flush sends that wrap again, which the relay already holds, and the queue empties
    const later = net();
    await harness({ store, net: later.net }).work.flushQueue();
    expect(later.published.map((e) => e.id)).toEqual([w.id]);
    expect(await queued(store)).toEqual([]);
  });

  test('a save storage won’t keep before its send, which then goes, leaves nothing in the queue to go again', async () => {
    for (const blossom of [undefined, (async () => new Response('', { status: 413 })) as unknown as typeof fetch]) {
      // the first write, the save going in, is refused; every write after it is taken
      const store = refusing(KEYS.queue, 1);
      const h = harness({ store, net: net({ blossom }).net });
      expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
      expect(kinds(h.toasts)).toEqual(['saving', blossom ? 'notext' : 'saved']);
      expect(await queued(store)).toEqual([]);
      const later = net();
      await harness({ store, net: later.net }).work.flushQueue();
      expect(later.published).toEqual([]);
    }
  });

  test('a session that won’t let Undo’s keys go doesn’t stop Undo, whether the save is removed or found on the phone', async () => {
    const stuck = () => {
      const session = memoryStore();
      session.remove = async () => {
        throw new Error('storage gone');
      };
      return session;
    };
    // sent, then retracted; the key stays, and a second press says nothing over it
    const n = net();
    const sent = harness({ net: n.net, session: stuck(), collected: [false, false] });
    await sent.work.save(PAGE, 1, false);
    expect(await ends(sent.work.undo(sent.toasts[0].id!, 1))).toBe('ended');
    expect(await ends(sent.work.undo(sent.toasts[0].id!, 1))).toBe('ended');
    expect(kinds(sent.toasts)).toEqual(['saving', 'saved', 'undone']);
    expect(n.published.filter((e) => e.kind === 5)).toHaveLength(1);
    // sent, and already on the phone
    const collected = harness({ session: stuck(), collected: [true] });
    await collected.work.save(PAGE, 1, false);
    expect(await ends(collected.work.undo(collected.toasts[0].id!, 1))).toBe('ended');
    expect(collected.toasts.at(-1)!.kind).toBe('onphone');
    // waiting after a send that may have reached the relay, and found on the phone
    const reached = harness({ net: net({ publish: 'down' }).net, session: stuck(), collected: [true] });
    await reached.work.save(PAGE, 1, false);
    expect(await ends(reached.work.undo(reached.toasts[0].id!, 1))).toBe('ended');
    expect(reached.toasts.at(-1)!.kind).toBe('onphone');
    expect(await queued(reached.store)).toEqual([]);
    // waiting, never sent: off the queue
    const offline = harness({ online: false, session: stuck() });
    await offline.work.save(PAGE, 1, false);
    expect(await ends(offline.work.undo(offline.toasts[0].id!, 1))).toBe('ended');
    expect(offline.toasts.at(-1)!.kind).toBe('unqueued');
  });

  test('a history storage won’t write doesn’t stop Undo, of a save that went, one found on the phone or one still waiting', async () => {
    const went = harness({ store: refusing(KEYS.history), collected: [false, false] });
    await went.work.save(PAGE, 1, false);
    expect(await ends(went.work.undo(went.toasts[0].id!, 1))).toBe('ended');
    expect(went.toasts.at(-1)!.kind).toBe('undone');
    const onPhone = harness({ store: refusing(KEYS.history), net: net({ publish: 'down' }).net, collected: [true] });
    await onPhone.work.save(PAGE, 1, false);
    expect(await ends(onPhone.work.undo(onPhone.toasts[0].id!, 1))).toBe('ended');
    expect(onPhone.toasts.at(-1)!.kind).toBe('onphone');
    const waiting = harness({ store: refusing(KEYS.history), online: false });
    await waiting.work.save(PAGE, 1, false);
    expect(await ends(waiting.work.undo(waiting.toasts[0].id!, 1))).toBe('ended');
    expect(waiting.toasts.at(-1)!.kind).toBe('unqueued');
  });

  test('a history storage won’t write doesn’t stop a ninth save being refused, or a save stopping at its last try', async () => {
    const store = refusing(KEYS.history);
    for (let i = 0; i < QUEUE_MAX; i++) await enqueue(store, entry(`w${i}`), 'offline');
    const h = harness({ store, online: false });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(h.toasts.at(-1)!.kind).toBe('full');
    // one at its last try, sent again and not taken, stops
    await changeQueue(store, (q) => void q.splice(0, q.length, { ...q[0], attempts: ATTEMPTS_MAX - 1, why: 'reach' }));
    expect(await ends(harness({ store, net: net({ publish: 'down' }).net }).work.flushQueue())).toBe('ended');
    expect(await queued(store)).toMatchObject([{ stopped: true, attempts: ATTEMPTS_MAX }]);
  });
});

/** chrome.storage.local's 10 MB (QUOTA_BYTES), counted as Chrome counts it: a write that would go past it is refused. */
function quotaStore(quota = 10_485_760): Store & { bytes(): number } {
  const kept = new Map<string, string>();
  const bytes = () => [...kept].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    async get<T>(k: string) {
      const v = kept.get(k);
      return v === undefined ? undefined : (JSON.parse(v) as T);
    },
    async set(k, v) {
      const s = JSON.stringify(v);
      if (bytes() - (kept.has(k) ? k.length + kept.get(k)!.length : 0) + k.length + s.length > quota) throw new Error('QUOTA_BYTES quota exceeded');
      kept.set(k, s);
    },
    async remove(k) {
      kept.delete(k);
    },
    bytes,
  };
}

describe('the queue in storage.local’s 10 MB', () => {
  const blobbed = (id: string, chars: number): Pending => ({ ...entry(id), blob: 'b'.repeat(chars), sha256: 's' });

  test('blobs are kept only while there is room for them: eight of the largest', async () => {
    const store = memoryStore();
    for (let i = 0; i < QUEUE_MAX; i++) await enqueue(store, blobbed(`w${i}`, BLOB_KEEP_MAX), 'offline');
    await enqueue(store, blobbed('first send', BLOB_KEEP_MAX), 'sending');
    const q = await queued(store);
    expect(q.map((e) => e.blob === null)).toEqual([...Array(QUEUE_MAX).fill(false), true]);
    expect(q.reduce((n, e) => n + (e.blob?.length ?? 0), 0)).toBeLessThanOrEqual(BLOBS_KEEP_MAX);
  });

  test('a save on its first send past ENTRIES_MAX isn’t kept first', async () => {
    const store = memoryStore();
    for (let i = 0; i < ENTRIES_MAX; i++) expect(await enqueue(store, entry(`s${i}`), 'sending')).toBe('queued');
    expect(await enqueue(store, entry('one more'), 'sending')).toBe('full');
  });

  test('a dozen big pages on their first send at once are all kept as they send, with room left for the rest', async () => {
    const store = quotaStore();
    // a big page's blob, under BLOB_KEEP_MAX: twelve of them are over the 10 MB
    const sends = Array.from({ length: 12 }, (_, i) => ({ ...blobbed(`big${i}`, 893_000), wrap: { id: `big${i}`, content: 'w'.repeat(8_000) } as NostrEvent, sealed: 's'.repeat(6_000) }));
    for (const p of sends) expect(await enqueue(store, p, 'sending')).toBe('queued');
    // every one is in storage while it sends, so a worker stopped now loses none (F23), and the pairing, the defaults
    // and the history still have room
    expect(await queued(store)).toHaveLength(12);
    await expect(store.set('room', 'r'.repeat(1_000_000))).resolves.toBeUndefined();
    await store.remove('room');
    // none could send: eight wait, with what room there is for their blobs, and four are refused as ninths (decision 31)
    const settled = [];
    for (const p of sends) settled.push(await settle(store, p, 'unreachable', true, true));
    expect(settled.sort()).toEqual([...Array(4).fill('full'), ...Array(8).fill('queued')]);
    expect(await queued(store)).toHaveLength(QUEUE_MAX);
    expect(store.bytes()).toBeLessThan(BLOBS_KEEP_MAX + 1_000_000);
  });

  test('a queue storage holds that no version wrote is read as empty, and saves go on', async () => {
    const store = memoryStore();
    await store.set(KEYS.queue, { not: 'a list' });
    expect(await queued(store)).toEqual([]);
    await store.set(KEYS.queue, [null, 7, { id: 'kept', wrap: {}, sealed: '', why: 'offline', stopped: false, attempts: 0 }]);
    expect((await queued(store)).map((e) => e.id)).toEqual(['kept']);
    await store.set(KEYS.queue, 'junk');
    const h = harness({ store });
    expect(await ends(h.work.save(PAGE, 1, false))).toBe('ended');
    expect(kinds(h.toasts)).toEqual(['saving', 'saved']);
  });
});

describe('Undo pressed twice (a double click, Enter twice on the toast’s button)', () => {
  test('a sent save is retracted once, and the second press says nothing over Removed from Kefli', async () => {
    const n = net();
    const h = harness({ net: n.net });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    await Promise.all([h.work.undo(id, 1), h.work.undo(id, 1)]);
    expect(kinds(h.toasts)).toEqual(['saving', 'saved', 'undone']);
    expect(n.published.filter((e) => e.kind === 5)).toHaveLength(1);
    expect((await history(h.store)).map((e) => e.outcome)).toEqual(['undo: retracted', 'sent']);
  });

  test('a waiting save comes off the queue once, and the second press says nothing over it', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    await Promise.all([h.work.undo(id, 1), h.work.undo(id, 1)]);
    expect(kinds(h.toasts)).toEqual(['saving', 'offline', 'unqueued']);
  });

  test('an Undo that couldn’t retract can still be pressed again', async () => {
    const h = harness({ net: net({ retract: 'refused' }).net, collected: [false, false, false, false] });
    await h.work.save(PAGE, 1, false);
    const id = h.toasts[0].id!;
    await h.work.undo(id, 1);
    await h.work.undo(id, 1);
    expect(kinds(h.toasts)).toEqual(['saving', 'saved', 'undofailed', 'undofailed']);
  });

  test('on the offline toast of a save that went since under a new wrap, the second press says nothing over it either', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    // the queue sends it without the HTML the operator refused, under a new wrap, while the offline toast still shows
    const n = net({ blossom: (async () => new Response('', { status: 413 })) as unknown as typeof fetch });
    const online = harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] });
    await online.work.flushQueue();
    const [w] = n.published;
    await Promise.all([online.work.undo(offline.id!, 1), online.work.undo(offline.id!, 1)]);
    expect(kinds(online.toasts)).toEqual(['undone']);
    expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags)).toEqual([[['e', w.id], ['k', '1059']]]);
  });
});

describe('a field no wrap could ever hold (F39, faster)', () => {
  test('is left out at once, and the page’s other details stay', async () => {
    const started = Date.now();
    const { pending } = await prepare({ ...PAGE, title: 'T'.repeat(1_000_000), byline: 'A writer', site: `S${'😀'.repeat(300_000)}` }, ctx);
    const req = JSON.parse((await unwrap(user, pending.wrap)).rumor.content) as SaveRequest;
    expect(req).toMatchObject({ title: null, site: null, byline: 'A writer', lang: 'en' });
    expect(req.html).not.toBeNull();
    expect(pending.title).toBe('example.com');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  /** An address with a query of n letters. */
  const at = (n: number) => `https://example.com/?q=${'x'.repeat(n)}`;

  test('an address no wrap could hold is refused at once: its text isn’t encrypted, and one wrap at most is tried', async () => {
    // the work is counted rather than timed, so a busy machine can't fail it. The device key signs one seal a wrap.
    // An address of 2,600 characters, which no wrap holds, was refused only after its 2 MB of text was encrypted and a
    // wrap tried for each field the request could spare, eight in all; now 2 MB and 6,000 characters are refused by
    // their length, and 2,600 after the one try the spare loop would have ended with, the address and token alone
    const seals = jest.spyOn(device, 'signEvent');
    const crypto = { ...webCrypto, aesGcmEncrypt: jest.fn(webCrypto.aesGcmEncrypt) };
    const html = `<p>${'Words of an article. '.repeat(99_000)}</p>`;
    try {
      for (const [n, wraps] of [[2_000_000, 0], [6_000, 0], [2_600, 1]] as const) {
        seals.mockClear();
        await expect(prepare({ ...linkOnly(at(n)), html }, { ...ctx, crypto })).rejects.toBeInstanceOf(AddressTooLongError);
        expect(seals).toHaveBeenCalledTimes(wraps);
      }
      expect(crypto.aesGcmEncrypt).not.toHaveBeenCalled();
    } finally {
      seals.mockRestore();
    }
  });

  test('one that only just fits alone is still saved, keeping what fits', async () => {
    const { pending } = await prepare({ ...PAGE, url: at(2_500), byline: 'A writer' }, ctx);
    const req = JSON.parse((await unwrap(user, pending.wrap)).rumor.content) as SaveRequest;
    expect(req).toEqual({ v: 1, url: at(2_500), canonical: null, title: null, site: null, byline: null, lang: null, hero: null, captured_at: NOW, token: PAIRING.token, html: null });
  });

  test.each([
    ['letters', 'x'], ['backslashes', '\\'], ['quotes', '"'], ['control characters', '\u0001'], ['accents', 'é'], ['emoji', '😀'],
  ])('an address of %s taking up to ADDRESS_SURE_FIT_BYTES of the rumor is wrapped without a try alone first', async (_name, unit) => {
    let url = 'https://example.com/?q=';
    while (rumorBytes(url + unit) <= ADDRESS_SURE_FIT_BYTES) url += unit;
    const seals = jest.spyOn(device, 'signEvent');
    try {
      const { pending } = await prepare(linkOnly(url), ctx);
      expect(JSON.parse((await unwrap(user, pending.wrap)).rumor.content)).toMatchObject({ url });
      expect(seals).toHaveBeenCalledTimes(1);
    } finally {
      seals.mockRestore();
    }
  });
});

describe('a move while saves wait, their toasts still showing (contract 4.4 and 4.8)', () => {
  const T = new LocalSigner(hexToBytes('33'.repeat(32)));
  const ack: PairAck = { v: 1, user_pubkey: T.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: ['https://blossom.example'], token: 'cd'.repeat(32), moved_from: user.pubkey() };
  /** A save made offline, its toast, and the queue wrapped again for T by a move. */
  async function savedThenMoved(o: Parameters<typeof net>[0] = {}) {
    const n = net(o);
    const h = harness({ online: false, net: n.net, collected: [false, false] });
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    await h.store.set(KEYS.pairing, PAIRING);
    await applyMove(h.store, device, ack, NOW, h.session);
    const [moved] = await queued(h.store);
    return { h, n, offline, moved };
  }

  test('Undo on the offline toast of a save the move wrapped again takes it off the queue', async () => {
    // the relay refuses a retraction of a wrap it doesn't hold, as Kefli's does (contract 3.2)
    const { h, n, offline, moved } = await savedThenMoved({ retract: 'refused' });
    expect(offline.kind).toBe('offline');
    expect(moved.id).not.toBe(offline.id);
    expect(moved.wrap.tags).toEqual([['p', T.pubkey()]]);
    await h.work.undo(offline.id!, 1);
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
    expect(await queued(h.store)).toEqual([]);
    expect(n.published).toEqual([]);
    expect((await history(h.store))[0]).toMatchObject({ outcome: 'undo: off the queue', id: moved.id.slice(0, 8) });
  });

  test('Undo’s key follows the new wrap, with the save’s cover and inbox blob, and the old wrap points to it', async () => {
    const { h, offline, moved } = await savedThenMoved();
    expect(moved.sha256).not.toBeNull();
    expect(await h.session.get(`undo:${offline.id}`)).toEqual({ to: moved.id });
    expect(await h.session.get(`undo:${moved.id}`)).toMatchObject({ hash: offline.hash, sha256: moved.sha256 });
  });

  test('one tried since, whose send may have reached the relay, has that wrap retracted with its own key, and its new one taken off the queue', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    // online again, the queue's try times out while the offline toast still shows: the relay may hold that wrap
    await harness({ store: h.store, session: h.session, net: net({ publish: 'down' }).net }).work.flushQueue();
    const [tried] = await queued(h.store);
    expect(tried).toMatchObject({ id: offline.id, why: 'reach', attempts: 1 });
    await h.store.set(KEYS.pairing, PAIRING);
    await applyMove(h.store, device, ack, NOW, h.session);
    const [moved] = await queued(h.store);
    expect(await h.session.get(`undo:${moved.id}`)).toMatchObject({ earlier: [{ id: tried.id, user: user.pubkey() }] });
    const n = net();
    const after = harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] });
    await after.work.undo(offline.id!, 1);
    expect(await queued(h.store)).toEqual([]);
    // the wrap the try sent, to the library that moved away, whose phone's last look at its inbox would take the save, and
    // the new one, which no send has tried, as Undo retracts any waiting save that was tried
    expect(n.published.filter((e) => e.kind === 5).map((e) => [e.pubkey, e.tags])).toEqual([
      [tried.wrap.pubkey, [['e', tried.id], ['k', '1059']]],
      [moved.wrap.pubkey, [['e', moved.id], ['k', '1059']]],
    ]);
    expect(after.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
  });

  test('one tried since that the phone took in its last look at the old library’s inbox is on the phone', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    await harness({ store: h.store, session: h.session, net: net({ publish: 'down' }).net }).work.flushQueue();
    await h.store.set(KEYS.pairing, PAIRING);
    await applyMove(h.store, device, ack, NOW, h.session);
    // the phone deleted the wrap as the library it went to, the one that moved away (contract 4.8, step 5)
    const found: Browser['collected'] = async (_relay, wrapId, by) => wrapId === offline.id && by === user.pubkey();
    const after = harness({ store: h.store, session: h.session, net: net({ retract: 'refused' }).net, found });
    await after.work.undo(offline.id!, 1);
    expect(after.toasts.at(-1)).toMatchObject({ kind: 'onphone', hash: offline.hash });
    expect(await queued(h.store)).toEqual([]);
  });

  test('a wrap from before the move stays with the save when its new wrap is made again, and Undo still retracts it', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const offline = h.toasts.at(-1)!;
    await harness({ store: h.store, session: h.session, net: net({ publish: 'down' }).net }).work.flushQueue();
    await h.store.set(KEYS.pairing, PAIRING);
    await applyMove(h.store, device, ack, NOW, h.session);
    // two minutes on, the new wrap is made again as it goes, and that try times out too
    const later = harness({ store: h.store, session: h.session, net: net({ publish: 'down' }).net, pairing: { ...PAIRING, user_pubkey: T.pubkey() } });
    later.clock.now = NOW + 120;
    await later.work.flushQueue();
    const [last] = await queued(h.store);
    expect(await h.session.get(`undo:${last.id}`)).toMatchObject({ earlier: [{ id: offline.id }] });
    const n = net();
    await harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] }).work.undo(offline.id!, 1);
    expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags[0][1])).toEqual([offline.id, last.id]);
    expect(await queued(h.store)).toEqual([]);
  });

  test('a save whose request can’t be read isn’t wrapped again, and keeps the key it had', async () => {
    const h = harness({ online: false });
    await h.work.save(PAGE, 1, false);
    const q = await queued(h.store);
    q[0].sealed = 'from before requests were kept';
    await h.store.set(KEYS.queue, q);
    const before = await h.session.get(`undo:${q[0].id}`);
    await h.store.set(KEYS.pairing, PAIRING);
    await applyMove(h.store, device, ack, NOW, h.session);
    expect((await queued(h.store))[0].id).toBe(q[0].id);
    expect(await h.session.get(`undo:${q[0].id}`)).toEqual(before);
  });

  test('a session that won’t take the new key doesn’t stop the move: the queue still goes to the new library', async () => {
    const session = memoryStore();
    const h = harness({ online: false, session });
    await h.work.save(PAGE, 1, false);
    session.set = async () => {
      throw new Error('QUOTA_BYTES quota exceeded');
    };
    await h.store.set(KEYS.pairing, PAIRING);
    expect(await ends(applyMove(h.store, device, ack, NOW, session))).toBe('ended');
    expect((await queued(h.store))[0].wrap.tags).toEqual([['p', T.pubkey()]]);
    expect((await h.store.get<Pairing>(KEYS.pairing))?.user_pubkey).toBe(T.pubkey());
  });

  describe('found while a save’s first send is under way', () => {
    /** A save whose first send is held at the relay, and the move the background finds meanwhile (bg.ts checkMoves). */
    async function movedMidSend(o: Parameters<typeof net>[0], found?: Browser['collected']) {
      const held = gate();
      const n = net({ ...o, hold: held.p });
      const h = harness({ net: n.net, collected: [false, false], found });
      const saving = h.work.save(PAGE, 1, false);
      await until(() => n.asked.n === 1);
      await h.store.set(KEYS.pairing, PAIRING);
      await applyMove(h.store, device, ack, NOW, h.session, h.work.follow);
      const [moved] = await queued(h.store);
      return { h, n, held, saving, moved };
    }

    test('one that went: Undo on its Saved toast retracts the wrap that went, with its own key, and takes the new one off the queue', async () => {
      const { h, n, held, saving, moved } = await movedMidSend({});
      held.open();
      await saving;
      const saved = h.toasts.at(-1)!;
      expect(saved.kind).toBe('saved');
      const [went] = n.published;
      expect(went.id).toBe(saved.id);
      await h.work.undo(saved.id!, 1);
      // the phone's last look at the old library's inbox would otherwise bring it into the new one (contract 4.8, step 5)
      expect(n.published.filter((e) => e.kind === 5).map((e) => [e.pubkey, e.tags[0]])).toEqual([[went.pubkey, ['e', went.id]], [moved.wrap.pubkey, ['e', moved.id]]]);
      expect(h.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
      expect(await queued(h.store)).toEqual([]);
      const later = net();
      await harness({ store: h.store, session: h.session, net: later.net }).work.flushQueue();
      expect(later.published).toEqual([]);
    });

    test('one that went, which the phone then took in its last look at the old library’s inbox, is on the phone', async () => {
      const took = { id: '' };
      // the phone's deletion of the wrap is the old library's, the inbox it read it from
      const found: Browser['collected'] = async (_relay, wrapId, by) => wrapId === took.id && by === user.pubkey();
      const { h, held, saving } = await movedMidSend({}, found);
      took.id = h.toasts[0].id!;
      held.open();
      await saving;
      await h.work.undo(h.toasts.at(-1)!.id!, 1);
      expect(h.toasts.at(-1)).toMatchObject({ kind: 'onphone', hash: h.toasts[0].hash });
      expect(await queued(h.store)).toEqual([]);
    });

    test('one whose send ends while the move wraps the queue again, before Undo’s key follows, still waits under its new wrap', async () => {
      const held = gate();
      const n = net({ publish: 'down', hold: held.p });
      // storage.session takes a while to write, so the move's queue is written well before Undo's key moves
      const session = memoryStore();
      const set = session.set.bind(session);
      session.set = async (k, v) => {
        await new Promise((r) => setTimeout(r, 50));
        return set(k, v);
      };
      const h = harness({ net: n.net, session, collected: [false, false] });
      const saving = h.work.save(PAGE, 1, false);
      await until(() => n.asked.n === 1);
      await h.store.set(KEYS.pairing, PAIRING);
      // the send's answer comes as the move holds the queue, so its settle runs as soon as the move has written it
      const moving = applyMove(h.store, device, ack, NOW, h.session, h.work.follow);
      held.open();
      await Promise.all([saving, moving]);
      const [moved] = await queued(h.store);
      expect(kinds(h.toasts)).toEqual(['saving', 'failed']);
      expect(moved).toMatchObject({ why: 'reach', attempts: 0 });
      expect(moved.wrap.tags).toEqual([['p', T.pubkey()]]);
      // and its toast's Undo takes it off the queue once the key has followed
      await h.work.undo(h.toasts.at(-1)!.id!, 1);
      expect(await queued(h.store)).toEqual([]);
      expect(h.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
    });

    test('one that then can’t reach the relay waits under its new wrap and says so, rather than Removed from Kefli', async () => {
      const { h, held, saving, moved } = await movedMidSend({ publish: 'down' });
      held.open();
      await saving;
      expect(kinds(h.toasts)).toEqual(['saving', 'failed']);
      expect(await queued(h.store)).toMatchObject([{ id: moved.id, why: 'reach', attempts: 0, stopped: false }]);
      expect((await history(h.store))[0]).toMatchObject({ outcome: 'waiting, couldn’t reach' });
      // and it goes to the new library from the queue
      const later = net();
      await harness({ store: h.store, session: h.session, net: later.net }).work.flushQueue();
      expect(later.published.map((w) => [w.id, w.tags])).toEqual([[moved.id, [['p', T.pubkey()]]]]);
    });

    test('a flush meanwhile leaves the new wrap to the send under way, so it isn’t sent beside it', async () => {
      const { h, n, held, saving, moved } = await movedMidSend({ publish: 'down' });
      expect(await ends(h.work.flushQueue(), 2000)).toBe('ended');
      expect(n.asked.n).toBe(1);
      held.open();
      await saving;
      expect(await queued(h.store)).toMatchObject([{ id: moved.id, why: 'reach' }]);
    });

    test('a flush sending a save that waited offline when the move lands: Undo on the offline toast retracts the wrap that went', async () => {
      const h = harness({ online: false });
      await h.work.save(PAGE, 1, false);
      const offline = h.toasts.at(-1)!;
      const held = gate();
      const n = net({ hold: held.p });
      const online = harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] });
      const flushing = online.work.flushQueue();
      await until(() => n.asked.n === 1);
      // a save that waited offline counts no try until its send ends, so only the send under way says its wrap may go
      expect(await queued(h.store)).toMatchObject([{ id: offline.id, why: 'offline', attempts: 0 }]);
      await h.store.set(KEYS.pairing, PAIRING);
      await applyMove(h.store, device, ack, NOW, h.session, online.work.follow);
      held.open();
      await flushing;
      expect(n.published.map((e) => e.id)).toEqual([offline.id]);
      await online.work.undo(offline.id!, 1);
      expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags[0][1])).toContain(offline.id);
      expect(online.toasts.at(-1)).toMatchObject({ kind: 'unqueued', title: 'A page' });
      expect(await queued(h.store)).toEqual([]);
    });

    test('one that went, to the library that moved away, is Saved, and its new wrap still goes to the new library', async () => {
      const { h, n, held, saving, moved } = await movedMidSend({});
      held.open();
      await saving;
      expect(kinds(h.toasts)).toEqual(['saving', 'saved']);
      expect(n.published.map((w) => w.tags)).toEqual([[['p', user.pubkey()]]]);
      // the phone may have read the old library for the last time already, so the save isn't left to it
      const later = net();
      await harness({ store: h.store, session: h.session, net: later.net }).work.flushQueue();
      expect(later.published.map((w) => [w.id, w.tags])).toEqual([[moved.id, [['p', T.pubkey()]]]]);
      expect(await queued(h.store)).toEqual([]);
    });
  });

  describe('taken while a save is made, after the save read the pairing', () => {
    const moved: Pairing = { ...PAIRING, user_pubkey: T.pubkey(), token: String(ack.token) };
    const tokenOf = async (w: NostrEvent) => (JSON.parse((await unwrap(T, w)).rumor.content) as SaveRequest).token;

    test('one that joins the queue after the move wrapped it again goes to the new library with its token, and Undo follows it', async () => {
      const n = net();
      const toasts: Omit<ToastState, 'shortcut'>[] = [];
      let moving: Promise<Pairing> | undefined;
      // the half-hourly look (bg.ts checkMoves) takes the move while Saving… shows, the save's own look skipped
      const h: ReturnType<typeof harness> = harness({
        net: n.net, collected: [false, false],
        toast: async (_w, s) => {
          toasts.push(s);
          if (s.kind === 'saving') await (moving ??= applyMove(h.store, device, ack, NOW, h.session, h.work.follow));
        },
      });
      await h.store.set(KEYS.pairing, PAIRING);
      await h.work.save(PAGE, 1, false);
      const [w] = n.published;
      expect(w.tags).toEqual([['p', T.pubkey()]]);
      expect(await tokenOf(w)).toBe(ack.token);
      expect(await queued(h.store)).toEqual([]);
      expect(toasts.map((t) => t.kind)).toEqual(['saving', 'saved']);
      expect(toasts[1].id).toBe(w.id);
      await h.work.undo(w.id, 1);
      expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags[0])).toEqual([['e', w.id]]);
    });

    test('one left in the queue wrapped for the library that moved away goes to the new one at its next try; Undo retracts both', async () => {
      // its first try went to the old library, whose relay refused it, as Kefli's refuses wraps for a deleted account
      const refusing: Net = { ...net().net, publish: async () => Promise.reject(new Error('blocked: gift wraps here are for Kefli users and their browsers')) };
      const h = harness({ net: refusing });
      await h.work.save(PAGE, 1, false);
      const failedToast = h.toasts.at(-1)!;
      const [left] = await queued(h.store);
      expect(left).toMatchObject({ why: 'blocked', wrap: { tags: [['p', user.pubkey()]] } });
      // the move was written before this save joined the queue, or a worker stopped between its two writes
      await h.store.set(KEYS.pairing, moved);
      const n = net();
      const later = harness({ store: h.store, session: h.session, net: n.net, collected: [false, false] });
      await later.work.flushQueue();
      const [w] = n.published;
      expect(w.tags).toEqual([['p', T.pubkey()]]);
      expect(await tokenOf(w)).toBe(ack.token);
      expect(await queued(h.store)).toEqual([]);
      // the wrap the old library may hold is retracted too, with its own key
      await later.work.undo(failedToast.id!, 1);
      expect(n.published.filter((e) => e.kind === 5).map((e) => e.tags[0][1])).toEqual([left.id, w.id]);
    });

    test('a move written whole leaves a save already wrapped for the new pairing as it is', async () => {
      const h = harness({ online: false });
      await h.store.set(KEYS.pairing, moved);
      await harness({ store: h.store, session: h.session, online: false, pairing: moved }).work.save(PAGE, 1, false);
      const [before] = await queued(h.store);
      await applyMove(h.store, device, { ...ack, token: 'ef'.repeat(32) }, NOW, h.session);
      const [after] = await queued(h.store);
      expect(after.id).not.toBe(before.id);
      expect(await tokenOf(after.wrap)).toBe('ef'.repeat(32));
      // and one the pairing already names is left alone
      await h.store.set(KEYS.queue, [before]);
      await h.store.set(KEYS.pairing, PAIRING);
      await applyMove(h.store, device, ack, NOW, h.session);
      expect((await queued(h.store)).map((e) => e.id)).toEqual([before.id]);
    });
  });
});
