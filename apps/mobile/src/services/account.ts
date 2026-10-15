// GET /account (contract 6, FD 117; mobile spec 5.8): the library's figures from Kefli's server, asked when Advanced
// opens while the phone is online, signed with NIP-98 by the identity's own signer as the phone's other API calls are.
// The answer is kept as the last the phone has (data/account.ts); a not_registered answer means Kefli's server keeps
// nothing for this library, whose figures then go and whose Backup space reads empty. A check offline, one that fails
// or takes too long, and a signer app that won't sign out of sight (FD 104) leave the last answer as it was. RULED: it
// asks whether or not this phone has registered the identity, since a library brought back here registers only with
// its next save, and the answer is what says whether Kefli's server knows it. Ports keep it testable.
import { httpAuth, type CryptoPort, type Signer } from '@kefli/protocol';
import { forgetFigures, recordFigures, type Check } from '../data/account';
import type { SqlDb } from '../data/db';
import { open, serverHops } from '../net/http';

export type AccountPorts = {
  db: SqlDb;
  now: () => number;
  owner: string;
  /** operator.api from defaults.json. */
  api: () => Promise<string>;
  /** The identity's signer; a signer app is reached out of sight only (FD 104). */
  signer: () => Promise<Signer | null>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  /** The local stack's build (services/config.ts LOCAL_STACK), whose API a redirect may reach on loopback. */
  localStack?: boolean;
};

/**
 * The longest a check takes before it counts as failed, from the ask, the signing included (a nostr app reached through
 * a bunker may take its two minutes), and the most of an answer read.
 */
export const ACCOUNT_TIMEOUT_MS = 15_000;
const MAX_BYTES = 4096;

type Answer = { status: number; body: unknown };

/** The identity's own signer, or a throw: another identity's would ask about the wrong library. */
async function signerFor(p: AccountPorts): Promise<Signer> {
  const s = await p.signer();
  if (!s || s.pubkey() !== p.owner) throw new Error('no signer for this library');
  return s;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The ask, its redirects followed only as far as a hop may go (net/http serverHops), never into the phone's own
 * network, and its NIP-98 header sent to no other origin; one that would go further fails the check.
 */
async function ask(p: AccountPorts, signer: Signer): Promise<Answer> {
  const url = `${await p.api()}/account`;
  const auth = await httpAuth(signer, url, 'GET', null, p.crypto, p.now());
  const o = await open(p.fetch, url, { method: 'GET', headers: { Authorization: auth } }, ACCOUNT_TIMEOUT_MS, serverHops(p.localStack === true));
  return { status: o.res.status, body: parse(new TextDecoder().decode(await o.read(MAX_BYTES))) };
}

/** 403 not_registered, as every route for registered users answers a key with no account (C§6). */
const unregistered = (a: Answer) => a.status === 403 && (a.body as { error?: unknown } | null)?.error === 'not_registered';

function forget(p: AccountPorts): Check {
  forgetFigures(p.db, p.owner);
  return 'unregistered';
}

/** 200 with the four figures keeps them; anything else leaves the last answer. */
const kept = (p: AccountPorts, a: Answer) => a.status === 200 && recordFigures(p.db, p.owner, a.body, p.now());

function settle(p: AccountPorts, a: Answer): Check {
  if (unregistered(a)) return forget(p);
  return kept(p, a) ? 'ok' : 'failed';
}

async function asked(p: AccountPorts): Promise<Check> {
  try {
    return settle(p, await ask(p, await signerFor(p)));
  } catch {
    return 'failed';
  }
}

/**
 * The check within its deadline: a signer or a server still busy past it counts as failed. An answer that comes after
 * all is still kept, being the server's own; the request itself is let go at its own deadline (net/http).
 */
async function attempt(p: AccountPorts): Promise<Check> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Check>((done) => {
    timer = setTimeout(() => done('failed'), ACCOUNT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([asked(p), late]);
  } finally {
    clearTimeout(timer);
  }
}

const running = new Map<string, Promise<Check>>();

/** Asks Kefli's server for the library's figures and keeps them; asks made while one is under way share it. */
export function checkAccount(p: AccountPorts): Promise<Check> {
  let run = running.get(p.owner);
  if (!run) {
    run = attempt(p).finally(() => running.delete(p.owner));
    running.set(p.owner, run);
  }
  return run;
}
