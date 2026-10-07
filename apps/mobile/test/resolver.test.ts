import { resolveLaunch, resolveShare, type LaunchFacts } from '../src/data/resolver';

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
  test('no identity but Block Store holds a shelf: adopt it, Saves with the restore card (FD 79)', () => {
    expect(resolveLaunch({ ...base, blockStore: 'words' })).toEqual({ wipeDb: false, route: 'saves', restoreCard: true, adoptBlockStore: true });
    expect(resolveLaunch({ ...base, blockStore: 'words', dbHasData: true })).toMatchObject({ wipeDb: true, adoptBlockStore: true });
  });
  test('a failed Block Store read is not a shelf', () => {
    expect(resolveLaunch({ ...base, blockStore: undefined })).toMatchObject({ route: 'welcome', adoptBlockStore: false });
  });
});

describe('share (mobile spec 3.1)', () => {
  test('an existing identity is used', () => {
    expect(resolveShare({ identity: { pubkey: 'p' }, blockStore: 'words' })).toEqual({ use: 'existing' });
  });
  test('Block Store’s shelf is adopted before minting', () => {
    expect(resolveShare({ identity: null, blockStore: 'words' })).toEqual({ use: 'block_store' });
  });
  test('a minted key goes to Block Store only when the entry was read empty', () => {
    expect(resolveShare({ identity: null, blockStore: null })).toEqual({ use: 'mint', writeBlockStore: true });
    expect(resolveShare({ identity: null, blockStore: undefined })).toEqual({ use: 'mint', writeBlockStore: false });
  });
});
