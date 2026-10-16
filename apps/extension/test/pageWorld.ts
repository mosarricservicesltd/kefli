// What the extension's pages find in a browser and jsdom lacks, put in place before any module that reads it at import
// (nostr-tools reads TextDecoder as it loads): the build's defines, text encoding, WebCrypto with randomness from a counter,
// so keys, nonces and signatures, and the pairing code drawn from them, are the same every run, and AbortSignal.timeout.
import { webcrypto } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';

const g = globalThis as Record<string, unknown>;
Object.assign(g, { KEFLI_DEFAULTS_URL: 'https://api.example/defaults.json', KEFLI_FLAVOUR: 'store', KEFLI_BROWSER: 'chrome', KEFLI_COMMIT: 'abc1234', TextEncoder, TextDecoder });

let seed = 7;
/** Back to the first value, so each test's randomness starts where the last one's did. */
export function resetSeed(): void {
  seed = 7;
}
function seeded<T extends ArrayBufferView | null>(a: T): T {
  if (!a) return a;
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < b.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    b[i] = (seed >>> 16) & 0xff;
  }
  return a;
}
Object.defineProperty(globalThis, 'crypto', { value: { subtle: webcrypto.subtle, getRandomValues: seeded }, configurable: true });

if (!('timeout' in AbortSignal)) {
  (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new Error('timeout')), ms);
    return c.signal;
  };
}
