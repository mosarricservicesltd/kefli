// Hermes has no SharedArrayBuffer, so nothing the protocol loads may touch it at load time (the gates
// build first crashed on whatwg-url's URL class, which does).

test('the protocol loads and runs without SharedArrayBuffer', () => {
  const saved = (globalThis as Record<string, unknown>).SharedArrayBuffer;
  delete (globalThis as Record<string, unknown>).SharedArrayBuffer;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = require('../src');
      expect(p.normalise('https://Bücher.example/a/?utm_source=x&b=1#c')).toBe('https://xn--bcher-kva.example/a?b=1');
      expect(p.countWords('# Hi\n\nTwo words.\n')).toBe(3);
      expect(p.isXPost('https://x.com/a/status/1')).toBe(true);
    });
  } finally {
    (globalThis as Record<string, unknown>).SharedArrayBuffer = saved;
  }
});
