import { verifyEvent } from 'nostr-tools/pure';
import {
  EventTooLargeError, LIST_MAX, LocalSigner, buildRelayList, buildServerList, newest, readRelayList, readServerList, withBackupRelays, withBackupServers,
} from '../src';
import { nodeCrypto } from '../src/node';

const signer = () => new LocalSigner(nodeCrypto.randomBytes(32));

describe('relay and server lists (contract 3.1, mobile spec 4.6)', () => {
  test('a generated identity’s 10002: three relays, read and write', async () => {
    const e = await buildRelayList(signer(), ['wss://op', 'wss://a', 'wss://b'].map((url) => ({ url, read: true, write: true })), 5);
    expect(verifyEvent(e)).toBe(true);
    expect(e.kind).toBe(10002);
    expect(e.tags).toEqual([['r', 'wss://op'], ['r', 'wss://a'], ['r', 'wss://b']]);
    expect(readRelayList(e)).toEqual(['wss://op', 'wss://a', 'wss://b'].map((url) => ({ url, read: true, write: true })));
  });

  test('markers round trip, and an entry with neither is dropped', async () => {
    const entries = [{ url: 'wss://r', read: true, write: false }, { url: 'wss://w', read: false, write: true }, { url: 'wss://none', read: false, write: false }];
    const e = await buildRelayList(signer(), entries, 1);
    expect(e.tags).toEqual([['r', 'wss://r', 'read'], ['r', 'wss://w', 'write']]);
    expect(readRelayList(e)).toEqual(entries.slice(0, 2));
  });

  test('Keep backup copies adds only what is missing, keeping every entry and marker in place', () => {
    const theirs = [{ url: 'wss://theirs', read: true, write: false }, { url: 'wss://op/', read: false, write: true }];
    const { entries, added } = withBackupRelays(theirs, ['wss://op', 'wss://a']);
    expect(added).toEqual(['wss://a']);
    expect(entries).toEqual([...theirs, { url: 'wss://a', read: true, write: true }]);
    expect(withBackupRelays(entries, ['wss://op', 'wss://a']).added).toEqual([]);
  });

  test('the 10063 lists servers in order; backup servers are added once', async () => {
    const e = await buildServerList(signer(), ['https://op', 'https://mirror'], 1);
    expect(e.kind).toBe(10063);
    expect(readServerList(e)).toEqual(['https://op', 'https://mirror']);
    expect(withBackupServers(['https://mine', 'https://op/'], ['https://op', 'https://mirror'])).toEqual({ servers: ['https://mine', 'https://op/', 'https://mirror'], added: ['https://mirror'] });
  });

  test('readers ignore tags they don’t understand', () => {
    expect(readRelayList({ tags: [['r'], ['x', 'wss://a'], ['r', 'wss://b']] })).toEqual([{ url: 'wss://b', read: true, write: true }]);
    expect(readServerList({ tags: [['server'], ['server', 'https://s'], ['r', 'https://t']] })).toEqual(['https://s']);
  });

  test('a list of 10,000 reads as its first LIST_MAX usable entries; other schemes, credentials and repeats are left out', () => {
    const relays = Array.from({ length: 10_000 }, (_, i) => ['r', `wss://r${i}.example`]);
    expect(readRelayList({ tags: relays })).toHaveLength(LIST_MAX);
    expect(readRelayList({ tags: relays })[LIST_MAX - 1].url).toBe(`wss://r${LIST_MAX - 1}.example`);
    const odd = [['r', 'javascript:alert(1)'], ['r', 'https://r.example'], ['r', 'wss://user:pw@r.example'], ['r', 'wss://'], ['r', 'wss://a b'],
      ['r', `wss://${'x'.repeat(3000)}.example`], ['r', 'wss://ok.example'], ['r', 'wss://ok.example/'], ['r', 'ws://localhost:4869']];
    expect(readRelayList({ tags: odd }).map((e) => e.url)).toEqual(['wss://ok.example', 'ws://localhost:4869']);
    const servers = [...Array.from({ length: 10_000 }, (_, i) => ['server', `https://s${i}.example`])];
    expect(readServerList({ tags: servers })).toHaveLength(LIST_MAX);
    expect(readServerList({ tags: [['server', 'file:///etc'], ['server', 'content://x'], ['server', 'http://192.168.1.2:3000'], ['server', 'https://s/']] }))
      .toEqual(['http://192.168.1.2:3000', 'https://s/']);
  });

  test('an edit starts from the newest copy seen', () => {
    expect(newest([{ id: 'b', created_at: 5 }, { id: 'a', created_at: 7 }, { id: 'c', created_at: 7 }])?.id).toBe('a');
    expect(newest([])).toBeNull();
  });

  test('a 10002 with many relays is refused past 16 KB', async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ url: `wss://relay-number-${i}.example.com`, read: true, write: true }));
    await expect(buildRelayList(signer(), many, 1)).rejects.toThrow(EventTooLargeError);
  });
});
