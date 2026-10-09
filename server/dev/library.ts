// A throwaway library on the local stack, for testing a restore on the phone (mobile spec 5.3, contract 8): a new
// identity, registered, with its relay and server lists and N saves taken from the fixture pages' Markdown, each
// text encrypted, uploaded to the operator Blossom server and mirrored, and the save published to every relay.
// It prints the identity's twelve words. They belong to this test identity only and are printed so a restore can
// be typed in; never use the script's words for anything real.
//   npx tsx server/dev/library.ts [N]   (default 6, at most 18; with the stack and api.mjs running)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Relay } from 'nostr-tools/relay';
import {
  LocalSigner, buildItemEvent, buildRelayList, buildServerList, encryptText, httpAuth, itemHash, mirrorBlob, newMnemonic, parseItem,
  secretKeyFromMnemonic, textHash, uploadBlob, type NostrEvent,
} from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';

type Expected = { id: string; ok: boolean; title: string | null; site: string | null; lang: string | null; markdown?: string; words: number | null };

async function main() {
  const n = Math.min(18, Number(process.argv[2] ?? 6));
  const defaults = await (await fetch('http://localhost:8447/defaults.json')).json();
  const words = newMnemonic(nodeCrypto);
  const signer = new LocalSigner(await secretKeyFromMnemonic(words, nodeCrypto));
  const now = Math.floor(Date.now() / 1000);

  const reg = `${defaults.operator.api}/register`;
  const body = JSON.stringify({ v: 1 });
  const r = await fetch(reg, { method: 'POST', body, headers: { Authorization: await httpAuth(signer, reg, 'POST', body, nodeCrypto), 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`register: ${r.status}`);

  const relays: string[] = [defaults.operator.relay, ...defaults.relays];
  const servers = [defaults.operator.blossom, defaults.mirrors[0]];
  const events: NostrEvent[] = [
    await buildRelayList(signer, relays.map((url) => ({ url, read: true, write: true })), now),
    await buildServerList(signer, servers, now),
  ];

  const pages = (JSON.parse(readFileSync(join(__dirname, '../../shared/fixtures/expected.json'), 'utf8')).pages as Expected[])
    .filter((p) => p.ok && p.markdown && (p.words ?? 0) > 150)
    .slice(0, n);
  for (const [k, p] of pages.entries()) {
    const md = p.markdown!;
    const { blob, text } = await encryptText(md, nodeCrypto);
    const up = await uploadBlob(defaults.operator.blossom, blob, text.sha256, signer);
    if (!up.ok) throw new Error(`upload: ${up.status}`);
    const mi = await mirrorBlob(defaults.mirrors[0], up.url, text.sha256, signer);
    if (!mi.ok) throw new Error(`mirror: ${mi.status}`);
    const url = `https://fixtures.example.org/${p.id}`;
    const item = parseItem(JSON.stringify({
      v: 1, url, canonical: null, title: p.title, site: p.site, byline: null, saved_at: now - k * 3600, state: k === pages.length - 1 ? 'archived' : 'unread',
      progress: 0, words: p.words, lang: p.lang, text: { ...text, servers }, text_hash: textHash(md, nodeCrypto), hero: null, source_kind: 'web', audio_pref: null,
    }));
    events.push((await buildItemEvent(signer, itemHash(url), item, now)).event);
  }
  for (const u of [...relays, ...defaults.indexer]) {
    const relay = await Relay.connect(u);
    for (const e of events) await relay.publish(e).catch(() => undefined);
    relay.close();
  }
  console.log(`A throwaway library, ${pages.length} saves (the last archived), pubkey ${signer.pubkey().slice(0, 12)}…`);
  console.log(`Its twelve test words: ${words}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
