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
import { changeQueue, dequeue, enqueue, flush, queued, settle } from '../src/queue';
import { AddressTooLongError, fetchNet, prepare, timed, uploadTimeoutMs, WRAP_FRESH_FOR, type Net, type Pending } from '../src/save';
import { KEYS, memoryStore, type Pairing, type Store } from '../src/store';
import { toastCopy, type ToastState } from '../src/toastCopy';
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

function harness(o: { paired?: boolean; pairing?: Pairing; online?: boolean; net?: Net; collected?: boolean[]; store?: Store; session?: Store; alarmHold?: Promise<void> } = {}) {
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
    toast: async (_w, s) => void toasts.push(s),
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
    checkMovesSoon: async () => undefined,
    collected: async () => answers.shift() ?? false,
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
    const moved = await applyMove(h.store, device, ack, NOW);
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

  test('offline, a wrap that waited is left as it is, since its send fails anyway', async () => {
    const h = harness({ online: false });
    at(h, NOW);
    await h.work.save(linkOnly(PAGE.url), 1, true);
    const [e] = await queued(h.store);
    const still = harness({ store: h.store, online: false, net: net({ publish: 'down' }).net });
    at(still, NOW + DAY);
    await still.work.flushQueue();
    expect(await queued(h.store)).toMatchObject([{ id: e.id, wrapped_at: NOW, attempts: 1 }]);
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
    await applyMove(h.store, device, ack, NOW + 500);
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
    await Promise.all([applyMove(store, device, ack, NOW), enqueue(store, entry('c'), 'offline')]);
    expect((await queued(store)).map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
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
});
