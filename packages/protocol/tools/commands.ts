// The Node tools' logic, kept apart from their entry points so the tests can run it.

import { readFileSync } from 'node:fs';
import { verifyEvent } from 'nostr-tools/pure';
import { LocalSigner, decryptText, parseSecret, readItemEvent, textHash, unwrap } from '../src';
import type { ItemText, NostrEvent } from '../src';
import { nodeCrypto } from '../src/node';

type Log = (line: string) => void;

const readJson = (source: string) => JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8'));

function argAfter(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/** The first argument that is neither a flag nor a flag's value. */
function source(argv: string[]): string | undefined {
  return argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--blob');
}

async function checkBlob(log: Log, label: string, blob: Uint8Array, text: ItemText, expectHash: string | null): Promise<boolean> {
  try {
    const md = await decryptText(blob, text, nodeCrypto);
    const ok = expectHash === null || textHash(md, nodeCrypto) === expectHash;
    log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${blob.length} bytes, ${md.length} characters${ok ? '' : ', text_hash differs'}`);
    return ok;
  } catch (e) {
    log(`FAIL ${label}: ${(e as Error).message}`);
    return false;
  }
}

async function fetchBlob(log: Log, server: string, text: ItemText, expectHash: string | null, get: typeof fetch): Promise<boolean> {
  const url = `${server.replace(/\/$/, '')}/${text.sha256}`;
  try {
    const res = await get(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await checkBlob(log, url, new Uint8Array(await res.arrayBuffer()), text, expectHash);
  } catch (e) {
    log(`FAIL ${url}: ${(e as Error).message}`);
    return false;
  }
}

/** npm run decrypt: true when the event verifies and decrypts and every blob checked matches. */
export async function decryptCommand(argv: string[], env: { SHELF_SECRET?: string }, log: Log, get: typeof fetch = fetch): Promise<boolean> {
  const from = source(argv);
  if (!from) throw new Error('usage: decrypt <event.json | -> [--blob <file>] [--fetch]');
  const event = readJson(from) as NostrEvent;
  if (!verifyEvent(event)) {
    log('FAIL the event’s id or signature does not verify');
    return false;
  }
  const signer = new LocalSigner(await parseSecret(env.SHELF_SECRET, nodeCrypto));
  const { hash, item } = await readItemEvent(signer, event);
  log(JSON.stringify({ d: `shelf/item/${hash}`, created_at: event.created_at, ...item.extra, ...item.item }, null, 2));
  const text = item.item.text;
  if (!text) {
    log('no text: a failed parse, which opens the original page');
    return true;
  }
  const checks: Promise<boolean>[] = [];
  const blobFile = argAfter(argv, '--blob');
  if (blobFile) checks.push(checkBlob(log, blobFile, new Uint8Array(readFileSync(blobFile)), text, item.item.text_hash));
  if (argv.includes('--fetch')) for (const s of text.servers) checks.push(fetchBlob(log, s, text, item.item.text_hash, get));
  return (await Promise.all(checks)).every(Boolean);
}

/** npm run unwrap: prints the seal's signer and the rumor, its content parsed when it is JSON. */
export async function unwrapCommand(argv: string[], env: { SHELF_SECRET?: string }, log: Log): Promise<boolean> {
  if (!argv[0]) throw new Error('usage: unwrap <wrap.json | ->');
  const wrap = readJson(argv[0]) as NostrEvent;
  const { rumor, seal } = await unwrap(new LocalSigner(await parseSecret(env.SHELF_SECRET)), wrap);
  let content: unknown = rumor.content;
  try {
    content = JSON.parse(rumor.content);
  } catch {}
  log(JSON.stringify({ wrap_id: wrap.id, seal_signer: seal.pubkey, rumor: { ...rumor, content } }, null, 2));
  return true;
}

/** Shared entry: exit 0 on success, 1 on a failed check or an error, with the message on stderr. */
export function run(command: (argv: string[], env: NodeJS.ProcessEnv, log: Log) => Promise<boolean>): void {
  command(process.argv.slice(2), process.env, (l) => console.log(l)).then(
    (ok) => process.exit(ok ? 0 : 1),
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
