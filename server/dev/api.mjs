// A local stand-in for the operator HTTP API (contract section 6), enough for the phone's work: GET
// /defaults.json pointing at the local stack, POST /register, DELETE /account, POST and DELETE /devices, POST and GET
// /pair-offers and /phone-offers, with NIP-98 checked as the contract says, and GET /fixtures/… for the
// phone's fixture gate. Devices and offers live in memory. The real API is the backend's Go service (docs/specs/02-backend.md).
//   node server/dev/api.mjs   (from the repository root, so nostr-tools resolves)

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';

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

// device pubkey → { user }; lookup → { offer, expires }
const devices = new Map();
const offers = new Map();
const OFFER_LIFE = 300;
const now = () => Math.floor(Date.now() / 1000);

async function authed(req, res, path, { registeredOnly = true } = {}) {
  const body = Buffer.concat(await req.toArray());
  const auth = checkNip98(req.headers.authorization, `${BASE}${path}`, req.method, body);
  if (!auth.ok) return send(res, 401, { v: 1, error: auth.why }), null;
  if (registeredOnly && !registered().has(auth.pubkey)) return send(res, 403, { v: 1, error: 'not registered' }), null;
  let json = null;
  try {
    json = body.length ? JSON.parse(body.toString('utf8')) : null;
  } catch {
    return send(res, 400, { v: 1, error: 'unreadable body' }), null;
  }
  return { pubkey: auth.pubkey, json };
}

// ids of device proofs and releases used, as keflid's replay check holds them
const usedConsent = new Set();
const PROOF_LIFE = OFFER_LIFE + 60;

const HEX64 = /^[0-9a-f]{64}$/;
const outside = (at, before, after) => !Number.isSafeInteger(at) || at > now() + after || at < now() - before;

/** A statement as POST /devices carries it, its time and signature, checked against the event it stands for (contract 6). */
function statementHolds(pubkey, tags, s) {
  if (!HEX64.test(pubkey ?? '') || !/^[0-9a-f]{128}$/.test(s?.sig ?? '')) return null;
  const ev = { kind: 27235, pubkey, created_at: s.created_at, tags, content: '' };
  ev.id = getEventHash(ev);
  ev.sig = s.sig;
  return verifyEvent(ev) ? ev.id : null;
}

/** The device's proof from its offer, or the holder's release for a move, as keflid checks them (F44): stale when outside its time. */
function consent({ proof, release }, device, caller) {
  const head = [['u', `${BASE}/devices`], ['method', 'POST']];
  if (proof) {
    const id = statementHolds(device, [...head, ['nonce', String(proof.nonce ?? '')]], proof);
    return id ? { id, name: 'proof', stale: outside(proof.created_at, PROOF_LIFE, 60) } : { why: 'proof: signature' };
  }
  if (release) {
    const id = statementHolds(release.pubkey, [...head, ['device', device], ['to', caller]], release);
    return id ? { id, name: 'release', holder: release.pubkey, stale: outside(release.created_at, 60, 60) } : { why: 'release: signature' };
  }
  return { why: 'proof: missing', status: 400 };
}

/**
 * The answer when a checked consent can't move the device to caller, else null. A caller holding it already gets [200]
 * for any whose signature holds, and a proof in its life is used up all the same, so nobody else can take the device with it.
 */
function refusal(c, pk, caller) {
  const held = devices.get(pk)?.user;
  if (held === caller) {
    if (!c.stale) usedConsent.add(c.id);
    return [200];
  }
  if (c.stale) return [403, `${c.name}: stale`];
  if (c.holder && held !== c.holder) return [403, 'release: holder'];
  return usedConsent.has(c.id) ? [403, `${c.name}: replayed`] : null;
}

/** The answer to a POST /devices from caller: the device taken only with its consent (F44). */
function takeDevice(json, caller) {
  // a label from an older phone is ignored, as keflid ignores it (F30)
  const pk = String(json?.device_pubkey ?? '');
  if (!HEX64.test(pk) || pk === caller) return [400, 'device'];
  const c = consent(json, pk, caller);
  const no = c.why ? [c.status ?? 403, c.why] : refusal(c, pk, caller);
  if (no) return no;
  usedConsent.add(c.id);
  devices.set(pk, { user: caller });
  console.log(`device ${pk.slice(0, 12)}… for ${caller.slice(0, 12)}… on its ${c.name}`);
  return [200];
}

async function postDevice(req, res) {
  const a = await authed(req, res, '/devices');
  if (!a) return;
  const [status, error] = takeDevice(a.json, a.pubkey);
  send(res, status, error ? { v: 1, error } : { v: 1 });
}

async function deleteDevice(req, res, pk) {
  const a = await authed(req, res, `/devices/${pk}`);
  if (!a) return;
  if (devices.get(pk)?.user !== a.pubkey) return send(res, 404, { v: 1, error: 'not found' });
  devices.delete(pk);
  console.log(`device ${pk.slice(0, 12)}… let go`);
  send(res, 200, { v: 1 });
}

async function postOffer(req, res) {
  const a = await authed(req, res, '/pair-offers', { registeredOnly: false });
  if (!a) return;
  const { lookup, offer } = a.json ?? {};
  if (!/^[0-9a-f]{64}$/.test(lookup ?? '') || typeof offer !== 'string') return send(res, 400, { v: 1, error: 'bad offer' });
  const held = offers.get(lookup);
  if (held && held.expires > now()) return send(res, 409, { v: 1, error: 'lookup taken' });
  offers.set(lookup, { offer, expires: now() + OFFER_LIFE });
  send(res, 200, { v: 1 });
}

async function getOffer(req, res, lookup) {
  const a = await authed(req, res, `/pair-offers/${lookup}`);
  if (!a) return;
  const held = offers.get(lookup);
  if (!held || held.expires <= now()) return send(res, 404, { v: 1, error: 'not found' });
  send(res, 200, { v: 1, offer: held.offer });
}

// shared/fixtures for the phone's fixture gate (mobile spec 11.2), as bytes, so the pages stay out of the app bundle.
const fixtures = join(here, '..', '..', 'shared', 'fixtures');
function fixture(res, path) {
  const file = join(fixtures, path);
  if (!/^[a-z0-9/._-]+$/.test(path) || path.includes('..') || !existsSync(file)) return send(res, 404, { v: 1, error: 'not found' });
  res.writeHead(200, { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  res.end(readFileSync(file));
}

// lookup → { offer, expires }: second-phone pairing (contract 2, 6), fetched once
const phoneOffers = new Map();

async function postPhoneOffer(req, res) {
  const a = await authed(req, res, '/phone-offers');
  if (!a) return;
  const { lookup, offer } = a.json ?? {};
  if (!/^[0-9a-f]{64}$/.test(lookup ?? '') || typeof offer !== 'string') return send(res, 400, { v: 1, error: 'bad offer' });
  const held = phoneOffers.get(lookup);
  if (held && held.expires > now()) return send(res, 409, { v: 1, error: 'lookup taken' });
  phoneOffers.set(lookup, { offer, expires: now() + OFFER_LIFE });
  send(res, 200, { v: 1 });
}

async function getPhoneOffer(req, res, lookup) {
  // any key may sign: the phone fetching it has no identity yet
  const a = await authed(req, res, `/phone-offers/${lookup}`, { registeredOnly: false });
  if (!a) return;
  const held = phoneOffers.get(lookup);
  if (!held || held.expires <= now()) return send(res, 404, { v: 1, error: 'not found' });
  phoneOffers.delete(lookup);
  send(res, 200, { v: 1, offer: held.offer });
}

async function deleteAccount(req, res) {
  const a = await authed(req, res, '/account', { registeredOnly: false });
  if (!a) return;
  const keys = registered();
  keys.delete(a.pubkey);
  writeFileSync(registeredPath, JSON.stringify([...keys], null, 1));
  for (const [pk, d] of devices) if (d.user === a.pubkey) devices.delete(pk);
  console.log(`account ${a.pubkey.slice(0, 12)}… deleted`);
  send(res, 200, { v: 1 });
}

// CORS on every answer, so the browser extension can call the API without host permissions (extension spec,
// ruling of 9 October 2026): NIP-98 rides in Authorization, so a request that carries it is preflighted.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600' };

function route(req, res) {
  const u = req.url ?? '';
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  if (req.method === 'GET' && u.startsWith('/fixtures/')) return fixture(res, u.slice('/fixtures/'.length));
  if (req.method === 'GET' && u === '/defaults.json') return send(res, 200, DEFAULTS);
  if (req.method === 'POST' && u === '/register') return register(req, res);
  if (req.method === 'DELETE' && u === '/account') return deleteAccount(req, res);
  if (req.method === 'POST' && u === '/devices') return postDevice(req, res);
  if (req.method === 'POST' && u === '/pair-offers') return postOffer(req, res);
  if (req.method === 'POST' && u === '/phone-offers') return postPhoneOffer(req, res);
  const po = /^\/phone-offers\/([0-9a-f]{64})$/.exec(u);
  if (req.method === 'GET' && po) return getPhoneOffer(req, res, po[1]);
  let m = /^\/devices\/([0-9a-f]{64})$/.exec(u);
  if (req.method === 'DELETE' && m) return deleteDevice(req, res, m[1]);
  m = /^\/pair-offers\/([0-9a-f]{64})$/.exec(u);
  if (req.method === 'GET' && m) return getOffer(req, res, m[1]);
  send(res, 404, { v: 1, error: 'not found' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);
    route(req, res);
  }).listen(PORT, () => console.log(`Kefli local API on ${BASE}`));
}
