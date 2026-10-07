// app.config.js decides whether a build may use cleartext: only SHELF_VARIANT=local, and only to localhost.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require('../app.config.js') as (a: { config: Record<string, unknown> }) => { plugins: unknown[]; extra: { shelf: unknown } };

const base = { name: 'Shelf', plugins: ['expo-router'], extra: { other: 1 } };
const withEnv = (env: Record<string, string | undefined>, f: () => void) => {
  const saved = { v: process.env.SHELF_VARIANT, u: process.env.SHELF_DEFAULTS_URL };
  process.env.SHELF_VARIANT = env.SHELF_VARIANT;
  process.env.SHELF_DEFAULTS_URL = env.SHELF_DEFAULTS_URL;
  if (env.SHELF_VARIANT === undefined) delete process.env.SHELF_VARIANT;
  if (env.SHELF_DEFAULTS_URL === undefined) delete process.env.SHELF_DEFAULTS_URL;
  try {
    f();
  } finally {
    if (saved.v === undefined) delete process.env.SHELF_VARIANT; else process.env.SHELF_VARIANT = saved.v;
    if (saved.u === undefined) delete process.env.SHELF_DEFAULTS_URL; else process.env.SHELF_DEFAULTS_URL = saved.u;
  }
};

describe('app.config.js', () => {
  test('the local variant points at the local stack and adds the localhost-only cleartext plugin', () => {
    withEnv({ SHELF_VARIANT: 'local' }, () => {
      const c = appConfig({ config: base });
      expect(c.extra).toEqual({ other: 1, shelf: { variant: 'local', defaultsUrl: 'http://localhost:8447/defaults.json' } });
      expect(c.plugins).toEqual(['expo-router', './plugins/with-local-cleartext']);
    });
  });

  test('a release build takes an https defaults URL and allows no cleartext', () => {
    withEnv({ SHELF_DEFAULTS_URL: 'https://api.example/defaults.json' }, () => {
      const c = appConfig({ config: base });
      expect(c.extra.shelf).toEqual({ variant: 'release', defaultsUrl: 'https://api.example/defaults.json' });
      expect(c.plugins).toEqual(['expo-router']);
    });
  });

  test('a release build refuses an http URL or none', () => {
    withEnv({ SHELF_DEFAULTS_URL: 'http://api.example/defaults.json' }, () => expect(() => appConfig({ config: base })).toThrow('SHELF_VARIANT'));
    withEnv({}, () => expect(() => appConfig({ config: base })).toThrow('SHELF_VARIANT'));
  });
});
