// The backend's contract tests (backend spec 7, contract v1.5 sections 3.2, 5 and 6), against a running stack: the
// operator relay with its write policy and keflid. Fresh keys each run, so it can run against staging repeatedly.
//   npx tsx server/staging/contract.ts [http://localhost:8447]
import { Relay } from 'nostr-tools/relay';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { LocalSigner, encryptText, httpAuth, uploadBlob, deleteBlob, giftWrap, type NostrEvent } from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';

const API = process.argv[2] ?? 'http://localhost:8447';
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
};

const key = () => new LocalSigner(generateSecretKey());
const now = () => Math.floor(Date.now() / 1000);

async function api(signer: LocalSigner, method: 'GET' | 'POST' | 'DELETE', path: string, body?: object) {
  const raw = body ? JSON.stringify(body) : null;
  const url = `${API}${path}`;
  const res = await fetch(url, { method, body: raw ?? undefined, headers: { Authorization: await httpAuth(signer, url, method, raw, nodeCrypto), 'Content-Type': 'application/json' } });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function publish(relay: Relay, ev: NostrEvent): Promise<string> {
  try {
    await relay.publish(ev);
    return 'ok';
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

const event = (sk: Uint8Array, kind: number, tags: string[][], content = '') => finalizeEvent({ kind, created_at: now(), tags, content }, sk) as NostrEvent;

/** The kind 1059s addressed to signer, read with NIP-42 AUTH as the relay requires. */
async function wrapsFor(url: string, signer: LocalSigner, ids: string[]): Promise<string[]> {
  const relay = await Relay.connect(url);
  const sign = (e: Parameters<LocalSigner['signEvent']>[0]) => signer.signEvent(e) as never;
  relay.onauth = sign;
  const got: string[] = [];
  await new Promise<void>((done) => {
    const ask = () => relay.subscribe([{ kinds: [1059], '#p': [signer.pubkey()], ids }], {
      onevent: (e) => void got.push(e.id),
      oneose: () => done(),
      onclose: (r) => (r.includes('auth-required') ? relay.auth(sign).then(ask, () => done()) : done()),
    });
    ask();
    setTimeout(done, 5000);
  });
  relay.close();
  return got;
}

async function main() {
  const defaults = await (await fetch(`${API}/defaults.json`)).json();
  const { relay: relayUrl, blossom } = defaults.operator;
  check('defaults.json is v1 and names the operator', defaults.v === 1 && !!relayUrl && !!blossom);

  const user = key(), device = key(), stranger = key();
  const reg = await api(user, 'POST', '/register', { v: 1 });
  check('POST /register', reg.status === 200 && reg.body?.v === 1, JSON.stringify(reg));
  const dev = await api(user, 'POST', '/devices', { v: 1, device_pubkey: device.pubkey(), label: 'Contract test browser' });
  check('POST /devices authorises a device key', dev.status === 200, JSON.stringify(dev));
  check('POST /devices refused to an unregistered key', (await api(stranger, 'POST', '/devices', { v: 1, device_pubkey: device.pubkey(), label: 'x' })).status === 403);

  const relay = await Relay.connect(relayUrl);
  // kind 30078: allowlisted by author, no AUTH needed to write (contract 3.2)
  const item = await user.signEvent({ kind: 30078, created_at: now(), tags: [['d', 'kefli/item/contract'], ['t', 'kefli']], content: 'ciphertext' });
  check('kind 30078 straight after registering is accepted (no wait for the allowlist)', (await publish(relay, item as NostrEvent)) === 'ok');
  const strangers = await stranger.signEvent({ kind: 30078, created_at: now(), tags: [['d', 'kefli/item/x']], content: 'x' });
  const refused = await publish(relay, strangers as NostrEvent);
  check('kind 30078 from an unregistered author is refused', refused.startsWith('blocked'), refused);
  const big = await user.signEvent({ kind: 30078, created_at: now(), tags: [['d', 'kefli/item/big']], content: 'x'.repeat(17_000) });
  const tooBig = await publish(relay, big as NostrEvent);
  check('kind 30078 over 16 KB is refused', tooBig.startsWith('invalid'), tooBig);
  const list = await user.signEvent({ kind: 10002, created_at: now(), tags: [['r', relayUrl]], content: '' });
  check('another kind from a registered author is accepted', (await publish(relay, list as NostrEvent)) === 'ok');

  // gift wraps: to a registered user, to an authorised device, not to a stranger (contract 3.2)
  const toUser = await giftWrap(device, user.pubkey(), { kind: 30078, created_at: now(), tags: [['d', 'kefli/save-request/c1']], content: '{}' });
  check('a wrap to a registered user is accepted', (await publish(relay, toUser.wrap as NostrEvent)) === 'ok');
  const toDevice = await giftWrap(user, device.pubkey(), { kind: 30078, created_at: now(), tags: [['d', 'kefli/pair-ack']], content: '{}' });
  check('a wrap to an authorised device is accepted', (await publish(relay, toDevice.wrap as NostrEvent)) === 'ok');
  const toStranger = await giftWrap(device, stranger.pubkey(), { kind: 30078, created_at: now(), tags: [['d', 'x']], content: '{}' });
  check('a wrap to an unregistered key is refused', (await publish(relay, toStranger.wrap as NostrEvent)).startsWith('blocked'));

  // reads of wraps need AUTH and go only to the recipient
  check('the recipient reads its wrap after AUTH', (await wrapsFor(relayUrl, user, [toUser.wrap.id])).includes(toUser.wrap.id));
  check('nobody else reads it', !(await wrapsFor(relayUrl, stranger, [toUser.wrap.id])).length);

  // the extension's Undo: its own held wrap, by the wrap key
  const undo = event(toUser.wrapKey, 5, [['e', toUser.wrap.id], ['k', '1059']]);
  check("Undo's kind 5 by the wrap key is accepted", (await publish(relay, undo)) === 'ok');
  await new Promise((r) => setTimeout(r, 500));
  check('and the wrap is gone', !(await wrapsFor(relayUrl, user, [toUser.wrap.id])).length);
  const late = event(toUser.wrapKey, 5, [['e', toUser.wrap.id], ['k', '1059']], 'again'); // a new event, not a duplicate of the Undo
  const lateAnswer = await publish(relay, late);
  check('a kind 5 for a wrap no longer held is refused', lateAnswer.startsWith('blocked'), lateAnswer);
  const forged = event(generateSecretKey(), 5, [['e', toDevice.wrap.id]]);
  check("a kind 5 for someone else's wrap is refused", (await publish(relay, forged)).startsWith('blocked'));

  // the recipient deleting a wrap it consumed (contract 3.2), which plain NIP-09 wouldn't allow
  const second = await giftWrap(device, user.pubkey(), { kind: 30078, created_at: now(), tags: [['d', 'kefli/save-request/c2']], content: '{}' });
  await publish(relay, second.wrap as NostrEvent);
  const consumed = await user.signEvent({ kind: 5, created_at: now(), tags: [['e', second.wrap.id], ['k', '1059']], content: '' });
  check("the recipient's kind 5 is accepted", (await publish(relay, consumed as NostrEvent)) === 'ok');
  await new Promise((r) => setTimeout(r, 1500));
  check('and the relay removes the wrap it names', !(await wrapsFor(relayUrl, user, [second.wrap.id])).length);
  relay.close();

  // Blossom: a user's blob, a device's inbox blob, refused to a stranger, deleted by its owner
  const own = await encryptText('a saved article', nodeCrypto);
  const up = await uploadBlob(blossom, own.blob, own.text.sha256, user);
  check('a registered user uploads', up.ok, JSON.stringify(up));
  const got = await fetch(`${blossom}/${own.text.sha256}`);
  check('and anyone can fetch it by hash', got.status === 200 && (await got.arrayBuffer()).byteLength === own.blob.length);
  const inbox = await encryptText('<p>a captured page</p>', nodeCrypto);
  const devUp = await uploadBlob(blossom, inbox.blob, inbox.text.sha256, device);
  check('an authorised device uploads an inbox blob', devUp.ok, JSON.stringify(devUp));
  const strangerUp = await uploadBlob(blossom, inbox.blob, inbox.text.sha256, stranger);
  check('an unregistered key may not upload', !strangerUp.ok && strangerUp.status === 401, JSON.stringify(strangerUp));
  check('the owner deletes its blob', (await deleteBlob(blossom, own.text.sha256, user)).ok);
  check('and it is no longer served', (await fetch(`${blossom}/${own.text.sha256}`)).status === 404);

  // DELETE /account: the user, its devices and their blobs go, and the relay stops taking their events
  const del = await api(user, 'DELETE', '/account');
  check('DELETE /account', del.status === 200, JSON.stringify(del));
  check('the inbox blob went with the account', (await fetch(`${blossom}/${inbox.text.sha256}`)).status === 404);
  await new Promise((r) => setTimeout(r, 6000));
  const after = await Relay.connect(relayUrl);
  const gone = await user.signEvent({ kind: 30078, created_at: now(), tags: [['d', 'kefli/item/after']], content: 'x' });
  check('the relay refuses a deleted account', (await publish(after, gone as NostrEvent)).startsWith('blocked'));
  const toGone = await giftWrap(device, user.pubkey(), { kind: 30078, created_at: now(), tags: [['d', 'x']], content: '{}' });
  check('and wraps addressed to it', (await publish(after, toGone.wrap as NostrEvent)).startsWith('blocked'));
  after.close();
  check('DELETE /account again still answers 200', (await api(user, 'DELETE', '/account')).status === 200);

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
