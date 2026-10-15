// A server that answers a request by sending it on into the phone's own network, as a hostile or broken one may (7.1):
// for the tests of every call the phone makes to a server, the outbox's, Delete my data's, the move's, Connect's and
// pairing a phone's. The fetch they stand in for follows a redirect itself, as OkHttp's own following did, unless asked
// for redirect: 'manual' (net/http open), when the 3xx comes back for the phone to check before anything is asked.

/** A router's address on the phone's own network, where the redirects below send what they catch. */
export const INSIDE = 'http://192.168.1.1';

/** What a matching request is sent to: the same path on the phone's own network. */
const inside = (url: string) => `${INSIDE}${new URL(url).pathname}`;

/** Which requests the server sends on, by their method and address. */
export type Sends = (method: string, url: string) => boolean;

/**
 * f behind a server that sends each request sends picks into the phone's own network with a 307. Followed (no
 * redirect: 'manual'), the address inside is asked, recorded in asked, and answers as f would have; with
 * redirect: 'manual' the 307 itself comes back, the address inside unasked.
 */
export function inward(f: typeof fetch, sends: Sends): { f: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const g = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (!sends(method, String(url))) return f(url, init);
    if (init.redirect === 'manual') return new Response('', { status: 307, headers: { location: inside(String(url)) } });
    asked.push(`${method} ${inside(String(url))}`);
    return f(url, init);
  }) as unknown as typeof fetch;
  return { f: g, asked };
}

/** A fetch that never answers and pays its abort signal no heed, as a server that takes the connection and stalls. */
export const silent = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

/** What became of a promise watched while fake time passes (jest.useFakeTimers, advanceTimersByTimeAsync). */
export type Watched<T> = { settled: boolean; value?: T; error?: unknown };

/** p, watched: settled once it resolves (value) or rejects (error). */
export function watch<T>(p: Promise<T>): Watched<T> {
  const w: Watched<T> = { settled: false };
  p.then((value) => Object.assign(w, { settled: true, value }), (error: unknown) => Object.assign(w, { settled: true, error }));
  return w;
}
