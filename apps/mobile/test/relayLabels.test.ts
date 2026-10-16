import { relayNames } from '../src/data/relayLabels';

const op = 'wss://relay.kefli.app';
const defaults = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io'];

describe('relay names in Advanced (decision 113)', () => {
  it('names Kefli first, the defaults Backup 1 and 2 in order, and the rest Your relay', () => {
    expect(relayNames([op, 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.example.org'], op, defaults)).toEqual([
      { kind: 'operator' },
      { kind: 'backup', n: 1 },
      { kind: 'backup', n: 2 },
      { kind: 'yours' },
    ]);
  });

  it('keeps a default relay as a Backup even when it also came from the person’s own relay list', () => {
    // A nostr user's 10002 listing primal and nos.lol stores them as theirs; the name still says Backup.
    expect(relayNames(['wss://nos.lol', op], op, defaults)).toEqual([{ kind: 'backup', n: 1 }, { kind: 'operator' }]);
  });

  it('matches addresses regardless of a trailing slash or case', () => {
    expect(relayNames(['wss://NOS.lol/', 'wss://relay.kefli.app/'], op, defaults)).toEqual([{ kind: 'backup', n: 1 }, { kind: 'operator' }]);
  });

  it('numbers only the defaults, skipping the person’s own relays between them', () => {
    expect(relayNames(['wss://relay.primal.net', 'wss://mine.example', 'wss://relay.damus.io'], op, defaults)).toEqual([
      { kind: 'backup', n: 1 },
      { kind: 'yours' },
      { kind: 'backup', n: 2 },
    ]);
  });

  it('with no defaults known yet, names nothing a Backup', () => {
    expect(relayNames(['wss://nos.lol'], null, [])).toEqual([{ kind: 'yours' }]);
  });
});
