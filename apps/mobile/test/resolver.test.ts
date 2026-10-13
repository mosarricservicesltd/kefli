import { blockStoreRewrite, resolveFailedLaunch, resolveLaunch, resolveShare, type LaunchFacts } from '../src/data/resolver';

const base: LaunchFacts = { identity: null, dbHasData: false, welcomeAnswered: false, blockStore: null, restoreRunning: false };
const id = (origin: LaunchFacts['identity'] extends infer T ? T extends { origin: infer O } ? O : never : never) => ({ pubkey: 'p', origin });

describe('launch (mobile spec 3.1)', () => {
  test('nothing at all: Welcome', () => {
    expect(resolveLaunch(base)).toEqual({ wipeDb: false, route: 'welcome', restoreCard: false, adoptBlockStore: false });
  });
  test('a database with no readable key file is wiped (7.1)', () => {
    expect(resolveLaunch({ ...base, dbHasData: true })).toMatchObject({ wipeDb: true, route: 'welcome' });
  });
  test('an early-share identity before Welcome is answered: welcome-early', () => {
    expect(resolveLaunch({ ...base, identity: id('early_share') })).toMatchObject({ route: 'welcome-early' });
    expect(resolveLaunch({ ...base, identity: id('early_share'), welcomeAnswered: true })).toMatchObject({ route: 'saves' });
  });
  test('any other identity: Saves, with the restore card while a restore runs', () => {
    expect(resolveLaunch({ ...base, identity: id('new'), dbHasData: true })).toEqual({ wipeDb: false, route: 'saves', restoreCard: false, adoptBlockStore: false });
    expect(resolveLaunch({ ...base, identity: id('recovery_code'), restoreRunning: true })).toMatchObject({ route: 'saves', restoreCard: true });
  });
  test('no identity but Block Store holds a key: adopt it, Saves with the restore card (FD 79)', () => {
    expect(resolveLaunch({ ...base, blockStore: 'words' })).toEqual({ wipeDb: false, route: 'saves', restoreCard: true, adoptBlockStore: true });
    expect(resolveLaunch({ ...base, blockStore: 'words', dbHasData: true })).toMatchObject({ wipeDb: true, adoptBlockStore: true });
  });
  test('a failed Block Store read is not a key', () => {
    expect(resolveLaunch({ ...base, blockStore: undefined })).toMatchObject({ route: 'welcome', adoptBlockStore: false });
  });
  test("a key file that can't be read for now routes on the database's identity, never as no identity (F21)", () => {
    expect(resolveFailedLaunch({ identity: { origin: 'new' }, welcomeAnswered: true })).toBe('saves');
    expect(resolveFailedLaunch({ identity: { origin: 'nostr_signin' }, welcomeAnswered: false })).toBe('saves');
    expect(resolveFailedLaunch({ identity: { origin: 'early_share' }, welcomeAnswered: false })).toBe('welcome-early');
    expect(resolveFailedLaunch({ identity: { origin: 'early_share' }, welcomeAnswered: true })).toBe('saves');
    expect(resolveFailedLaunch({ identity: null, welcomeAnswered: false })).toBe('welcome');
  });
});

describe('share (mobile spec 3.1)', () => {
  test('an existing identity is used', () => {
    expect(resolveShare({ identity: { pubkey: 'p' }, blockStore: 'words' })).toEqual({ use: 'existing' });
  });
  test('Block Store’s key is adopted before minting', () => {
    expect(resolveShare({ identity: null, blockStore: 'words' })).toEqual({ use: 'block_store' });
  });
  test('a minted key goes to Block Store only when the entry was read empty', () => {
    expect(resolveShare({ identity: null, blockStore: null })).toEqual({ use: 'mint', writeBlockStore: true });
    expect(resolveShare({ identity: null, blockStore: undefined })).toEqual({ use: 'mint', writeBlockStore: false });
  });
});

describe('Block Store at each launch (mobile spec 3.3, contract 2, F22)', () => {
  test('a missing entry is written again: a write that failed is retried', () => {
    expect(blockStoreRewrite({ entry: 'empty', e2ee: true, written: null })).toBe(true);
    expect(blockStoreRewrite({ entry: 'empty', e2ee: null, written: true })).toBe(true);
  });
  test('an entry written before end-to-end encryption came, or after it went, is written again', () => {
    expect(blockStoreRewrite({ entry: 'same', e2ee: true, written: false })).toBe(true);
    expect(blockStoreRewrite({ entry: 'same', e2ee: false, written: true })).toBe(true);
    expect(blockStoreRewrite({ entry: 'same', e2ee: true, written: null })).toBe(true);
  });
  test('an entry that still matches stays', () => {
    expect(blockStoreRewrite({ entry: 'same', e2ee: true, written: true })).toBe(false);
    expect(blockStoreRewrite({ entry: 'same', e2ee: false, written: false })).toBe(false);
    expect(blockStoreRewrite({ entry: 'same', e2ee: null, written: false })).toBe(false);
  });
  test('never over another key’s entry, nor after a failed read', () => {
    expect(blockStoreRewrite({ entry: 'other', e2ee: true, written: null })).toBe(false);
    expect(blockStoreRewrite({ entry: null, e2ee: true, written: null })).toBe(false);
  });
});
