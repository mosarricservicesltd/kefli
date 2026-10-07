// An end-to-end save against the local stack, from Node with the protocol's own code: register (NIP-98),
// encrypt, upload to the operator Blossom server, mirror, publish the kind 30078 to every relay, then read it
// back from another relay and check it as npm run decrypt --fetch does.
//   npx tsx server/dev/smoke.ts   (with the stack and api.mjs running)

import { Relay } from 'nostr-tools/relay';
import {
  LocalSigner, buildItemEvent, encryptText, httpAuth, itemHash, mirrorBlob, newMnemonic, normaliseMarkdown, parseItem,
  secretKeyFromMnemonic, textHash, uploadBlob, countWords,
} from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';
import { decryptCommand } from '../../packages/protocol/tools/commands';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const step = (s: string) => console.log(`· ${s}`);

async function main() {
  const defaults = await (await fetch('http://localhost:8447/defaults.json')).json();
  const words = newMnemonic(nodeCrypto);
  const signer = new LocalSigner(await secretKeyFromMnemonic(words, nodeCrypto));
  step(`new identity ${signer.pubkey().slice(0, 12)}…`);

  const reg = `${defaults.operator.api}/register`;
  const body = JSON.stringify({ v: 1 });
  const r = await fetch(reg, { method: 'POST', body, headers: { Authorization: await httpAuth(signer, reg, 'POST', body, nodeCrypto), 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`register: ${r.status} ${await r.text()}`);
  step('registered');

  const md = normaliseMarkdown('# A local save\n\nA saved article waits quietly until there is time for it. It travels encrypted, and only its owner can read it.');
  const { blob, text } = await encryptText(md, nodeCrypto);
  const up = await uploadBlob(defaults.operator.blossom, blob, text.sha256, signer);
  if (!up.ok) throw new Error(`upload: ${up.status} ${up.reason}`);
  step(`uploaded ${blob.length} bytes to ${up.url}`);
  const mi = await mirrorBlob(defaults.mirrors[0], up.url, text.sha256, signer);
  if (!mi.ok) throw new Error(`mirror: ${mi.status} ${mi.reason}`);
  step(`mirrored to ${mi.url}`);

  const url = 'https://example.com/local-save';
  const item = parseItem(JSON.stringify({
    v: 1, url, canonical: null, title: 'A local save', site: 'example.com', byline: null, saved_at: Math.floor(Date.now() / 1000),
    state: 'unread', progress: 0, words: countWords(md), lang: 'en', text: { ...text, servers: [defaults.operator.blossom, defaults.mirrors[0]] },
    text_hash: textHash(md, nodeCrypto), hero: null, source_kind: 'web', audio_pref: null,
  }));
  const { event } = await buildItemEvent(signer, itemHash(url), item, Math.floor(Date.now() / 1000));
  const relays = [defaults.operator.relay, ...defaults.relays];
  for (const u of relays) {
    const relay = await Relay.connect(u);
    await relay.publish(event);
    relay.close();
    step(`published to ${u}`);
  }

  const back = await Relay.connect(defaults.relays[1]);
  const got = await new Promise<typeof event | null>((ok) => {
    let found: typeof event | null = null;
    const sub = back.subscribe([{ kinds: [30078], authors: [signer.pubkey()], '#t': ['shelf'] }], {
      onevent: (e) => { found = e as typeof event; },
      oneose: () => { sub.close(); ok(found); },
    });
  });
  back.close();
  if (!got) throw new Error('the save did not come back');
  step(`read back from ${defaults.relays[1]}`);
  const dir = mkdtempSync(join(tmpdir(), 'shelf-smoke-'));
  writeFileSync(join(dir, 'event.json'), JSON.stringify(got));
  const lines: string[] = [];
  const ok = await decryptCommand([join(dir, 'event.json'), '--fetch'], { SHELF_SECRET: words }, (l) => lines.push(l));
  for (const l of lines.filter((x) => /^(ok|FAIL)/.test(x))) step(l);
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`SMOKE FAIL: ${(e as Error).message}`);
  process.exit(1);
});
