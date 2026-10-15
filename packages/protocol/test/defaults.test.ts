import { apiBaseOk, validDefaults } from '../src';

const good = {
  v: 1,
  operator: { relay: 'wss://relay.kefli.app', blossom: 'https://blossom.kefli.app', api: 'https://api.kefli.app' },
  relays: ['wss://relay.damus.io', 'wss://nos.lol'],
  indexer: ['wss://purplepag.es'],
  mirrors: ['https://mirror.example'],
};
const withApi = (api: unknown) => ({ ...good, operator: { ...good.operator, api } });

describe('defaults.json (C§3.1)', () => {
  test('the shape the contract gives parses', () => {
    expect(validDefaults(good)).toBe(true);
    expect(validDefaults(withApi('http://localhost:8447'))).toBe(true);
  });

  test.each<[string, unknown]>([
    ['nothing', null],
    ['a string', '{}'],
    ['another version', { ...good, v: 2 }],
    ['no operator', { ...good, operator: undefined }],
    ['a relay over http', { ...good, operator: { ...good.operator, relay: 'https://relay.kefli.app' } }],
    ['a blob server over ws', { ...good, operator: { ...good.operator, blossom: 'wss://blossom.kefli.app' } }],
    ['one default relay', { ...good, relays: ['wss://relay.damus.io'] }],
    ['a relay that is no address', { ...good, relays: ['wss://relay.damus.io', 'relay.damus.io'] }],
    ['no indexer', { ...good, indexer: [] }],
    ['no mirror', { ...good, mirrors: [] }],
    ['a mirror over ws', { ...good, mirrors: ['wss://mirror.example'] }],
  ])('refused: %s', (_, d) => expect(validDefaults(d)).toBe(false));
});

describe('operator.api carries no trailing slash (C§6, decision 119)', () => {
  test.each([
    ['https://api.kefli.app', true],
    ['http://localhost:8447', true],
    ['https://api.kefli.app/v1', true],
    ['https://api.kefli.app/', false],
    ['https://api.kefli.app/v1/', false],
    ['wss://api.kefli.app', false],
    ['api.kefli.app', false],
    ['', false],
  ])('%s: %s', (api, want) => expect(apiBaseOk(api)).toBe(want));

  test('a copy with one is refused whole, so the last good copy stays in use', () => {
    expect(validDefaults(withApi('https://api.kefli.app/'))).toBe(false);
    expect(validDefaults(withApi(undefined))).toBe(false);
  });
});
