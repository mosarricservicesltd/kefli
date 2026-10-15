// app.config.js decides whether a build may use cleartext: only KEFLI_VARIANT=local, and only to localhost.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require('../app.config.js') as (a: { config: Record<string, unknown> }) => { plugins: unknown[]; extra: { kefli: unknown } };

const base = { name: 'Kefli', plugins: ['expo-router'], extra: { other: 1 } };
const withEnv = (env: Record<string, string | undefined>, f: () => void) => {
  const saved = { v: process.env.KEFLI_VARIANT, u: process.env.KEFLI_DEFAULTS_URL };
  process.env.KEFLI_VARIANT = env.KEFLI_VARIANT;
  process.env.KEFLI_DEFAULTS_URL = env.KEFLI_DEFAULTS_URL;
  if (env.KEFLI_VARIANT === undefined) delete process.env.KEFLI_VARIANT;
  if (env.KEFLI_DEFAULTS_URL === undefined) delete process.env.KEFLI_DEFAULTS_URL;
  try {
    f();
  } finally {
    if (saved.v === undefined) delete process.env.KEFLI_VARIANT; else process.env.KEFLI_VARIANT = saved.v;
    if (saved.u === undefined) delete process.env.KEFLI_DEFAULTS_URL; else process.env.KEFLI_DEFAULTS_URL = saved.u;
  }
};

describe('app.config.js', () => {
  test('the local variant points at the local stack and adds the localhost-only cleartext plugin', () => {
    withEnv({ KEFLI_VARIANT: 'local' }, () => {
      const c = appConfig({ config: base });
      expect(c.extra).toEqual({ other: 1, kefli: { variant: 'local', defaultsUrl: 'http://localhost:8447/defaults.json', baked: expect.objectContaining({ v: 1 }) } });
      expect((c.extra.kefli as { baked: { operator: { api: string } } }).baked.operator.api).toBe('http://localhost:8447');
      expect(c.plugins).toEqual(['expo-router', './plugins/with-local-cleartext']);
    });
  });

  test('a release build takes an https defaults URL, bakes in its copy of defaults.json and allows no cleartext', () => {
    withEnv({ KEFLI_DEFAULTS_URL: 'https://api.kefli.app/defaults.json' }, () => {
      const c = appConfig({ config: base });
      expect(c.extra.kefli).toEqual({
        variant: 'release', defaultsUrl: 'https://api.kefli.app/defaults.json',
        baked: expect.objectContaining({ operator: { relay: 'wss://relay.kefli.app', blossom: 'https://blossom.kefli.app', api: 'https://api.kefli.app' } }),
      });
      expect(c.plugins).toEqual(['expo-router']);
    });
  });

  test('a release build refuses a baked copy that names another API (F1)', () => {
    withEnv({ KEFLI_DEFAULTS_URL: 'https://api.example/defaults.json' }, () => expect(() => appConfig({ config: base })).toThrow('names the API'));
  });

  test('a release build refuses a baked copy whose operator.api carries a trailing slash (contract 6, FD 119)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kefli-defaults-'));
    const file = path.join(dir, 'defaults.json');
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'defaults.release.json'), 'utf8')) as { operator: { api: string } };
    fs.writeFileSync(file, JSON.stringify({ ...d, operator: { ...d.operator, api: `${d.operator.api}/` } }));
    const saved = process.env.KEFLI_DEFAULTS_FILE;
    process.env.KEFLI_DEFAULTS_FILE = file;
    try {
      withEnv({ KEFLI_DEFAULTS_URL: `${d.operator.api}/defaults.json` }, () => expect(() => appConfig({ config: base })).toThrow('trailing slash'));
    } finally {
      if (saved === undefined) delete process.env.KEFLI_DEFAULTS_FILE; else process.env.KEFLI_DEFAULTS_FILE = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a release build refuses an http URL or none', () => {
    withEnv({ KEFLI_DEFAULTS_URL: 'http://api.example/defaults.json' }, () => expect(() => appConfig({ config: base })).toThrow('KEFLI_VARIANT'));
    withEnv({}, () => expect(() => appConfig({ config: base })).toThrow('KEFLI_VARIANT'));
  });
});
