import { LocalSigner } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, interimRelays, queueSave } from '../src/data/saves';
import { addRelay, listsSettled, writeRelays } from '../src/data/lists';
import { KEEP_COPIES, setSetting } from '../src/data/settings';
import { settleUserLists } from '../src/services/nostrSignIn';
import { memoryDb } from './sqlite';

const D = { operator: { relay: 'wss://op', blossom: 'https://blossom' }, relays: ['wss://a', 'wss://b'], indexer: ['wss://idx'], mirrors: ['https://m1'] };
const T = { api: 'https://api', blossom: 'https://blossom', mirror: 'https://m1', interim: interimRelays(D) };

function world(provider: 'local' | 'nip55' = 'nip55') {
  const db = memoryDb();
  migrate(db);
  const s = new LocalSigner(nodeCrypto.randomBytes(32));
  ensureIdentityRow(db, 1, s.pubkey(), 'nostr_signin', provider === 'local', provider);
  return { db, pk: s.pubkey() };
}

function share(db: ReturnType<typeof memoryDb>, owner: string, hash: string) {
  return queueSave(db, 10, {
    owner, hash, url: `https://example.com/${hash}`, canonical: null, title: 'Title', site: 'example.com', byline: null, savedAt: 10,
    words: 2, lang: 'en', hero: null, text: null, textHash: null, textState: 'failed', origin: 'share',
  }, null, T);
}

const targets = (db: ReturnType<typeof memoryDb>, op: string, subject: string) =>
  db.all<{ target: string }>('SELECT t.target FROM outbox_targets t JOIN outbox o ON o.id = t.outbox_id WHERE o.op = ? AND o.subject = ? ORDER BY t.target', op, subject).map((r) => r.target);

describe('a nostr user whose lists aren’t known yet (mobile spec 4.6, F4)', () => {
  test('a share goes to the interim relays with Keep backup copies on, and no list is published', () => {
    const w = world();
    expect(listsSettled(w.db, w.pk)).toBe(false);
    share(w.db, w.pk, 'h1');
    expect(targets(w.db, 'publish_item', 'h1')).toEqual(['wss://a', 'wss://op']);
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'publish_lists'")).toBeUndefined();
    expect(w.db.get('SELECT 1 FROM relays')).toBeUndefined();
  });

  test('with the switch off it waits, then takes their relays once the lists are known', () => {
    const w = world();
    setSetting(w.db, KEEP_COPIES, '0');
    share(w.db, w.pk, 'h1');
    expect(targets(w.db, 'publish_item', 'h1')).toEqual([]);
    settleUserLists(w.db, 20, w.pk, D, { known: true, relays: [{ url: 'wss://theirs', read: true, write: true }], servers: ['https://their.blossom'] }, false);
    expect(listsSettled(w.db, w.pk)).toBe(true);
    expect(writeRelays(w.db, w.pk)).toEqual(['wss://theirs']);
    expect(targets(w.db, 'publish_item', 'h1')).toEqual(['wss://theirs']);
  });

  test('saves already sent to the interim relays are copied to their own once the lists are known', () => {
    const w = world();
    share(w.db, w.pk, 'h1');
    w.db.run("UPDATE items SET published = 1 WHERE hash = 'h1'");
    w.db.run("DELETE FROM outbox WHERE op = 'publish_item'");
    settleUserLists(w.db, 20, w.pk, D, { known: true, relays: [{ url: 'wss://theirs', read: true, write: true }], servers: [] }, true);
    expect(targets(w.db, 'copy_relay', 'wss://theirs')).toEqual(['wss://theirs']);
  });

  test('a relay can’t be added before the lists are known', () => {
    const w = world();
    expect(addRelay(w.db, 10, w.pk, 'wss://mine', D)).toBe(false);
    expect(w.db.get('SELECT 1 FROM relays')).toBeUndefined();
  });

  test('Kefli’s own identity is always settled', () => {
    const w = world('local');
    expect(listsSettled(w.db, w.pk)).toBe(true);
  });
});
