import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  LocalSigner, buildItemEvent, encryptText, itemHash, normaliseMarkdown, parseItem, parseSecret, textHash, wrapPairAck,
} from '../src';
import { nodeCrypto } from '../src/node';
import { decryptCommand, unwrapCommand, verifyCommand } from '../tools/commands';

const WORDS = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const SK = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'kefli-tools-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parseSecret', () => {
  test('hex, nsec and words', async () => {
    const sk = await parseSecret(SK);
    expect(bytesToHex(sk)).toBe(SK);
    expect(bytesToHex(await parseSecret(nip19.nsecEncode(sk)))).toBe(SK);
    expect(bytesToHex(await parseSecret(WORDS, nodeCrypto))).toBe(SK);
  });
  test('refusals', async () => {
    await expect(parseSecret(undefined)).rejects.toThrow('KEFLI_SECRET');
    await expect(parseSecret(WORDS)).rejects.toThrow('64 hex'); // words need crypto
    await expect(parseSecret(nip19.npubEncode('ab'.repeat(32)))).rejects.toThrow();
  });
});

async function sample(withText: boolean) {
  const s = new LocalSigner(await parseSecret(SK));
  const md = normaliseMarkdown('# A title\n\nSome words here.');
  const { blob, text } = await encryptText(md, nodeCrypto);
  const item = parseItem(JSON.stringify({
    v: 1, url: 'https://example.com/a', canonical: null, title: 'A', site: null, byline: null, saved_at: 1, state: 'unread',
    progress: 0, words: 5, lang: 'en', text: withText ? { ...text, servers: ['https://blossom.test/'] } : null,
    text_hash: withText ? textHash(md, nodeCrypto) : null, hero: null, source_kind: 'web', audio_pref: null,
  }));
  const { event } = await buildItemEvent(s, itemHash('https://example.com/a'), item, 2);
  const eventPath = join(dir, `event-${withText}.json`);
  writeFileSync(eventPath, JSON.stringify(event));
  const blobPath = join(dir, 'blob.bin');
  writeFileSync(blobPath, blob);
  return { event, eventPath, blobPath, blob };
}

describe('npm run decrypt', () => {
  test('prints the item and passes a matching blob, from a file and from a server', async () => {
    const { eventPath, blobPath, blob } = await sample(true);
    const lines: string[] = [];
    const get = (async () => new Response(Buffer.from(blob))) as unknown as typeof fetch;
    expect(await decryptCommand([eventPath, '--blob', blobPath, '--fetch'], { KEFLI_SECRET: WORDS }, (l) => lines.push(l), get)).toBe(true);
    expect(JSON.parse(lines[0]).url).toBe('https://example.com/a');
    expect(lines.filter((l) => l.startsWith('ok'))).toHaveLength(2);
  });

  test('fails on a bad blob, a server error, a forged event and a missing argument', async () => {
    const { event, eventPath } = await sample(true);
    const bad = join(dir, 'bad.bin');
    writeFileSync(bad, 'nope');
    const log = () => {};
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await decryptCommand([eventPath, '--blob', bad], { KEFLI_SECRET: SK }, log)).toBe(false);
    expect(await decryptCommand([eventPath, '--fetch'], { KEFLI_SECRET: SK }, log, notFound)).toBe(false);
    const forged = join(dir, 'forged.json');
    writeFileSync(forged, JSON.stringify({ ...event, created_at: 3 }));
    expect(await decryptCommand([forged], { KEFLI_SECRET: SK }, log)).toBe(false);
    await expect(decryptCommand([], { KEFLI_SECRET: SK }, log)).rejects.toThrow('usage');
  });

  test('an item without text passes', async () => {
    const { eventPath } = await sample(false);
    const lines: string[] = [];
    expect(await decryptCommand([eventPath], { KEFLI_SECRET: SK }, (l) => lines.push(l))).toBe(true);
    expect(lines[1]).toMatch(/no text/);
  });
});

describe('npm run unwrap', () => {
  test('prints the seal signer and the parsed rumor', async () => {
    const user = new LocalSigner(nodeCrypto.randomBytes(32));
    const deviceSk = nodeCrypto.randomBytes(32);
    const device = new LocalSigner(deviceSk.slice());
    const ack = { v: 1 as const, user_pubkey: user.pubkey(), write_relays: [], blossom_servers: [], token: 'cc'.repeat(32), nonce: 'n' };
    const { wrap } = await wrapPairAck(user, device.pubkey(), ack, 1);
    const path = join(dir, 'wrap.json');
    writeFileSync(path, JSON.stringify(wrap));
    const lines: string[] = [];
    expect(await unwrapCommand([path], { KEFLI_SECRET: bytesToHex(deviceSk) }, (l) => lines.push(l))).toBe(true);
    const out = JSON.parse(lines[0]);
    expect(out.seal_signer).toBe(user.pubkey());
    expect(out.rumor.content).toEqual(ack);
    await expect(unwrapCommand([], {}, () => {})).rejects.toThrow('usage');
  });
});

describe('npm run verify', () => {
  test('checks the newest copy of every save across the relays, with its blob on each server', async () => {
    const { event, blob } = await sample(true);
    const { event: bare } = await sample(false);
    const s = new LocalSigner(await parseSecret(SK));
    const newer = (await buildItemEvent(s, itemHash('https://example.com/a'), (await import('../src')).parseItem(JSON.stringify({
      v: 1, url: 'https://example.com/a', canonical: null, title: 'A', site: null, byline: null, saved_at: 1, state: 'archived', progress: 0,
      words: 5, lang: 'en', text: null, text_hash: null, hero: null, source_kind: 'web', audio_pref: null,
    })), 3)).event;
    const record = { ...bare, tags: [['d', 'kefli/devices'], ['t', 'kefli']] };
    const relays: Record<string, unknown[]> = { 'ws://a': [event, record], 'ws://b': [event] };
    const lines: string[] = [];
    const get = (async () => new Response(Buffer.from(blob))) as unknown as typeof fetch;
    const query = async (r: string) => relays[r] as never;
    expect(await verifyCommand(['--relays', 'ws://a,ws://b'], { KEFLI_SECRET: SK }, (l) => lines.push(l), query, get)).toBe(true);
    expect(lines).toContain('ok   A (on 2/2 relays)');
    expect(lines).toContain('     kefli/devices (on 1/2 relays)');
    expect(lines.at(-1)).toBe('1 of 1 saves verify, decrypt and match their text');
    // a newer copy on one relay wins; a missing blob fails
    relays['ws://b'] = [newer];
    lines.length = 0;
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await verifyCommand(['--relays', 'ws://a,ws://b'], { KEFLI_SECRET: SK }, (l) => lines.push(l), query, notFound)).toBe(true);
    expect(lines[0]).toBe('ok   A [archived] [no text] (on 2/2 relays)');
    relays['ws://b'] = [];
    expect(await verifyCommand(['--relays', 'ws://a,ws://b'], { KEFLI_SECRET: SK }, () => {}, query, notFound)).toBe(false);
  });
});
