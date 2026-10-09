// Plays "your other phone" for Scan from my other phone (mobile spec 5.3, contract 2): it makes a throwaway shelf
// with a few saves (as library.ts does), posts its mnemonic as a phone offer, and shows the QR in the terminal and in
// server/dev/data/pair.html with the six digits under it. Scan it with the phone, type the digits, and the phone
// restores the throwaway shelf. The words are a test identity's and are never printed.
//   npx tsx server/dev/otherphone.ts   (with the stack and api.mjs running)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toQR } from 'toqr';
import { LocalSigner, derivePhonePair, httpAuth, newPhonePair, sealPhoneOffer, secretKeyFromMnemonic } from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';

function terminalQR(text: string): string {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  const at = (x: number, y: number) => y >= 0 && y < n && x >= 0 && x < n && m[y * n + x] === 1;
  const lines: string[] = [];
  for (let y = -2; y < n + 2; y += 2) {
    let line = '';
    for (let x = -2; x < n + 2; x++) line += at(x, y) && at(x, y + 1) ? ' ' : at(x, y) ? '▄' : at(x, y + 1) ? '▀' : '█';
    lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

function page(text: string, six: string): string {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y * n + x]) d += `M${x} ${y}h1v1h-1z`;
  return `<!doctype html><meta charset="utf-8"><title>Your other phone</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;font:600 34px/1.4 system-ui">
<div style="text-align:center"><svg viewBox="-4 -4 ${n + 8} ${n + 8}" width="380" height="380" shape-rendering="crispEdges"><path d="${d}"/></svg>
<div style="letter-spacing:.2em">${six.slice(0, 3)} ${six.slice(3)}</div><div style="font:400 15px system-ui;color:#555">expires in five minutes</div></div></body>`;
}

async function main() {
  // a throwaway library to hand over: library.ts makes it and prints its words, which stay in this process
  const out = execFileSync('npx', ['tsx', join(__dirname, 'library.ts'), '4'], { encoding: 'utf8' });
  const words = /Its twelve test words: (.+)/.exec(out)?.[1]?.trim();
  if (!words) throw new Error('library.ts gave no words');
  const signer = new LocalSigner(await secretKeyFromMnemonic(words, nodeCrypto));
  const defaults = await (await fetch('http://localhost:8447/defaults.json')).json();
  const { qr, six } = newPhonePair(nodeCrypto, signer.pubkey(), Math.floor(Date.now() / 1000));
  const { lookup, key } = derivePhonePair(qr.secret, six);
  const url = `${defaults.operator.api}/phone-offers`;
  const body = JSON.stringify({ v: 1, lookup, offer: await sealPhoneOffer(words, key, nodeCrypto) });
  const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: await httpAuth(signer, url, 'POST', body, nodeCrypto) } });
  if (!r.ok) throw new Error(`phone-offers: ${r.status}`);
  const text = JSON.stringify(qr);
  writeFileSync(join(__dirname, 'data', 'pair.html'), page(text, six));
  console.log(`\n${terminalQR(text)}\n`);
  console.log(`  Six digits: ${six.slice(0, 3)} ${six.slice(3)}   (a throwaway shelf of 4 saves, pubkey ${signer.pubkey().slice(0, 12)}…)`);
  console.log(`  The same QR, larger: ${join(__dirname, 'data', 'pair.html')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
