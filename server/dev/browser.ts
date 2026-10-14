// Plays the browser extension's side of pairing (contract 4.4) against the local stack, so Connect can be tried
// on the phone before the extension exists. It keeps a device key, shows an offer as a QR (in the terminal and in
// server/dev/data/pair.html) with its typed code, posts the sealed offer to /pair-offers, then waits on the
// operator relay for the pair-ack and checks it as the extension will. Once paired, save sends a page as the
// extension does (C§4.4): its HTML encrypted into an inbox blob on the operator Blossom server, then a save request
// wrapped to the user on the operator relay. Readability's content HTML and the page's metadata come from the
// parser bundle in headless Chrome, as the extension will read them from the live page.
//   npx tsx server/dev/browser.ts ["Chrome on a Linux laptop"]   (with the stack and api.mjs running)
//   npx tsx server/dev/browser.ts save <url> [--no-html]
// The device key and pairing land in server/dev/data/browser.json, which git ignores.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from 'nostr-tools/relay';
import { toQR } from 'toqr';
// @ts-expect-error: plain ES modules without types
import { launch } from '../../tools/design-qa/cdp.mjs';
// @ts-expect-error: plain ES modules without types
import { kefliBundle } from '../../shared/vendor/build-parser-bundle.mjs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  LocalSigner, acceptPairAck, derivePairCode, deviceProofTemplate, encryptText, httpAuth, newPairCode, sealOffer, signStatement, unwrap, uploadBlob,
  wrapSaveRequest,
  type NostrEvent, type PairOffer, type SaveRequest,
} from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';

const here = dirname(fileURLToPath(import.meta.url));
const statePath = join(here, 'data', 'browser.json');
const pagePath = join(here, 'data', 'pair.html');
const OFFER_LIFE = 300;

type State = { sk: string; paired?: { user_pubkey: string; token: string; write_relays: string[]; blossom_servers: string[] } };

function load(): State {
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8'));
  const s = { sk: bytesToHex(nodeCrypto.randomBytes(32)) };
  writeFileSync(statePath, JSON.stringify(s, null, 1));
  return s;
}

function modules(text: string): boolean[][] {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => m[y * n + x] === 1));
}

/** Half blocks, light on dark terminals and dark on light alike: the code is drawn as spaces on a white ground. */
function terminalQR(rows: boolean[][]): string {
  const n = rows.length;
  const at = (x: number, y: number) => y >= 0 && y < n && x >= 0 && x < n && rows[y][x];
  const lines: string[] = [];
  for (let y = -2; y < n + 2; y += 2) {
    let line = '';
    for (let x = -2; x < n + 2; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

function page(rows: boolean[][], code: string, label: string): string {
  const n = rows.length;
  const rects = rows.flatMap((r, y) => r.map((on, x) => (on ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ''))).join('');
  return `<!doctype html><meta charset="utf-8"><title>Connect ${label}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;font:600 28px/1.4 system-ui">
<div style="text-align:center"><svg viewBox="-4 -4 ${n + 8} ${n + 8}" width="360" height="360" shape-rendering="crispEdges">${rects}</svg>
<div style="letter-spacing:.15em">${code.slice(0, 4)}-${code.slice(4)}</div>
<div style="font:400 15px system-ui;color:#555">${label} · expires in five minutes</div></div></body>`;
}

async function save(url: string, withHtml: boolean) {
  const defaults = await (await fetch('http://localhost:8447/defaults.json')).json();
  const state = load();
  if (!state.paired) throw new Error('not paired: run without arguments first and connect from the phone');
  const device = new LocalSigner(hexToBytes(state.sk));
  let html: SaveRequest['html'] = null;
  let title: string | null = null;
  let meta = { site: new URL(url).hostname as string | null, byline: null as string | null, lang: null as string | null, canonical: null as string | null, hero: null as string | null };
  if (withHtml) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0' } });
    const bytes = Buffer.from(await res.arrayBuffer());
    // Readability's content HTML, as the extension sends it, from the parser bundle in headless Chrome
    const chrome = await launch();
    let article: { ok: boolean; content?: string };
    let parsed: { title?: string | null; site?: string | null; byline?: string | null; lang?: string | null; canonical?: string | null; hero?: string | null };
    try {
      await chrome.eval(kefliBundle());
      const args = `${JSON.stringify(bytes.toString('base64'))}, ${JSON.stringify(res.headers.get('content-type') ?? 'text/html')}, ${JSON.stringify(res.url || url)}`;
      article = await chrome.eval(`kefliArticle(${args})`);
      parsed = await chrome.eval(`kefliParse(${args})`);
    } finally {
      chrome.close();
      chrome.proc.kill();
    }
    if (!article.ok) throw new Error('Readability found no article on that page; send it with --no-html');
    title = parsed.title ?? null;
    meta = { site: parsed.site ?? null, byline: parsed.byline ?? null, lang: parsed.lang ?? null, canonical: parsed.canonical ?? null, hero: parsed.hero ?? null };
    const enc = await encryptText(article.content!, nodeCrypto);
    const up = await uploadBlob(defaults.operator.blossom, enc.blob, enc.text.sha256, device);
    if (!up.ok) throw new Error(`upload: ${up.status} ${up.reason}`);
    html = { ...enc.text, server: defaults.operator.blossom };
    console.log(`  uploaded ${enc.blob.length} bytes of HTML as an inbox blob`);
  }
  const request: SaveRequest = {
    v: 1, url, title, ...meta,
    captured_at: Math.floor(Date.now() / 1000), token: state.paired.token, html,
  };
  const { wrap } = await wrapSaveRequest(device, state.paired.user_pubkey, bytesToHex(nodeCrypto.randomBytes(16)), request, Math.floor(Date.now() / 1000));
  const relay = await Relay.connect(defaults.operator.relay);
  await relay.publish(wrap);
  relay.close();
  console.log(`  sent ${url} to ${state.paired.user_pubkey.slice(0, 12)}… (wrap ${wrap.id.slice(0, 12)}…)`);
  process.exit(0);
}

async function main() {
  if (process.argv[2] === 'save') return save(process.argv[3], !process.argv.includes('--no-html'));
  const label = process.argv[2] ?? 'Chrome on a Linux laptop';
  const defaults = await (await fetch('http://localhost:8447/defaults.json')).json();
  const state = load();
  const device = new LocalSigner(hexToBytes(state.sk));
  const now = Math.floor(Date.now() / 1000);
  const nonce = bytesToHex(nodeCrypto.randomBytes(16));
  // the device key's proof over the nonce, as the extension signs it (contract 4.4)
  const proof = await signStatement(device, deviceProofTemplate(defaults.operator.api, nonce, now));
  const offer: PairOffer = { v: 1, device_pubkey: device.pubkey(), relay: defaults.operator.relay, nonce, expires: now + OFFER_LIFE, label, proof };

  const code = newPairCode(nodeCrypto);
  const { lookup, key } = await derivePairCode(code, nodeCrypto);
  const url = `${defaults.operator.api}/pair-offers`;
  const body = JSON.stringify({ v: 1, lookup, offer: await sealOffer(offer, key, nodeCrypto) });
  const r = await fetch(url, { method: 'POST', body, headers: { Authorization: await httpAuth(device, url, 'POST', body, nodeCrypto), 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`pair-offers: ${r.status} ${await r.text()}`);

  const rows = modules(JSON.stringify(offer));
  writeFileSync(pagePath, page(rows, code, label));
  console.log(`\n${terminalQR(rows)}\n`);
  console.log(`  Code: ${code.slice(0, 4)}-${code.slice(4)}   (${label}, device ${device.pubkey().slice(0, 12)}…)`);
  console.log(`  The same QR, larger: ${pagePath}`);
  if (state.paired) console.log(`  Paired before with ${state.paired.user_pubkey.slice(0, 12)}…; a new pair-ack replaces it.`);
  console.log('  Waiting for the phone…');

  const relay = await Relay.connect(defaults.operator.relay);
  const sign = (evt: Parameters<typeof device.signEvent>[0]) => device.signEvent(evt) as never;
  relay.onauth = sign;
  const done = new Promise<void>((resolve) => {
    const onevent = async (wrap: NostrEvent) => {
      let opened;
      try {
        opened = await unwrap(device, wrap);
      } catch {
        return;
      }
      const v = acceptPairAck(opened.rumor, opened.seal, { offerNonce: offer.nonce, pairedUser: null });
      if (!v.ok) {
        if (v.reason !== 'nonce') console.log(`  ignored a pair-ack: ${v.reason}`);
        return;
      }
      state.paired = { user_pubkey: v.ack.user_pubkey, token: v.ack.token, write_relays: v.ack.write_relays, blossom_servers: v.ack.blossom_servers };
      writeFileSync(statePath, JSON.stringify(state, null, 1));
      console.log(`  Connected to ${v.ack.user_pubkey.slice(0, 12)}… (token ${v.ack.token.slice(0, 8)}…, ${v.ack.write_relays.length} relays)`);
      resolve();
    };
    // Gift wraps are read only after AUTH (NIP-42) by the key they name: a refused subscription authenticates and asks again.
    const subscribe = () =>
      relay.subscribe([{ kinds: [1059], '#p': [device.pubkey()], since: now - 172_800 - 300 }], {
        onevent: (e) => void onevent(e as NostrEvent),
        onclose: (reason) => {
          if (reason.includes('closed by us')) return;
          if (!reason.includes('auth-required')) return void console.log(`  the relay closed the subscription: ${reason}`);
          relay.auth(sign).then(subscribe, (e) => console.log(`  AUTH failed: ${e}`));
        },
      });
    subscribe();
  });
  const timeout = new Promise<void>((resolve) => setTimeout(() => (console.log('  The offer expired.'), resolve()), (OFFER_LIFE + 60) * 1000));
  await Promise.race([done, timeout]);
  relay.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
