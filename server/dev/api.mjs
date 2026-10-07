// A local stand-in for the operator HTTP API (contract section 6), enough for week 1's phone work:
// GET /defaults.json pointing at the local stack, and POST /register with NIP-98 checked as the contract
// says. The real API is the backend's Go service (docs/specs/02-backend.md).
//   node server/dev/api.mjs   (from the repository root, so nostr-tools resolves)

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvent } from 'nostr-tools/pure';

const PORT = Number(process.env.PORT ?? 8447);
const BASE = `http://localhost:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const registeredPath = join(here, 'data', 'registered.json');

// contract 3.1's schema; ws:// and http:// are for this local stack only.
export const DEFAULTS = {
  v: 1,
  operator: { relay: 'ws://localhost:7447', blossom: 'http://localhost:3447', api: BASE },
  relays: ['ws://localhost:7448', 'ws://localhost:7449'],
  indexer: ['ws://localhost:7448'],
  mirrors: ['http://localhost:3448'],
};

function registered() {
  try {
    return new Set(JSON.parse(readFileSync(registeredPath, 'utf8')));
  } catch {
    return new Set();
  }
}

/** NIP-98 as contract 6 requires it: kind 27235, exact u, method, created_at within 60 s, payload on bodies. */
export function checkNip98(header, url, method, body, now = Math.floor(Date.now() / 1000)) {
  const m = /^Nostr (.+)$/.exec(header ?? '');
  if (!m) return { ok: false, why: 'no Nostr authorisation' };
  let ev;
  try {
    ev = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return { ok: false, why: 'unreadable authorisation' };
  }
  const tag = (k) => ev.tags?.find((t) => t[0] === k)?.[1];
  if (ev.kind !== 27235) return { ok: false, why: 'not kind 27235' };
  if (!verifyEvent(ev)) return { ok: false, why: 'bad signature' };
  if (tag('u') !== url) return { ok: false, why: `u is not ${url}` };
  if (tag('method') !== method) return { ok: false, why: 'wrong method' };
  if (Math.abs(now - ev.created_at) > 60) return { ok: false, why: 'created_at out of range' };
  if (method !== 'GET' && tag('payload') !== createHash('sha256').update(body).digest('hex')) return { ok: false, why: 'payload mismatch' };
  return { ok: true, pubkey: ev.pubkey };
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function register(req, res) {
  const body = Buffer.concat(await req.toArray());
  const auth = checkNip98(req.headers.authorization, `${BASE}/register`, 'POST', body);
  if (!auth.ok) return send(res, 401, { v: 1, error: auth.why });
  const keys = registered();
  keys.add(auth.pubkey);
  mkdirSync(dirname(registeredPath), { recursive: true });
  writeFileSync(registeredPath, JSON.stringify([...keys], null, 1));
  console.log(`registered ${auth.pubkey}`);
  send(res, 200, { v: 1 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/defaults.json') return send(res, 200, DEFAULTS);
    if (req.method === 'POST' && req.url === '/register') return register(req, res);
    send(res, 404, { v: 1, error: 'not found' });
  }).listen(PORT, () => console.log(`Shelf local API on ${BASE}`));
}
