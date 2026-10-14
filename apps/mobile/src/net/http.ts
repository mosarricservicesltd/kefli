// Reads from the open web (mobile spec 5.4, 5.6; F12, F27): one deadline over the headers and the whole body, a cap
// counted while the body streams, and no cookies either way. expo/fetch resolves on the headers and its OkHttp client
// has no timeouts of its own, so a deadline cleared there leaves the body to a server that may send a byte a minute,
// and a cap checked after arrayBuffer() comes too late for an endless one. expo/fetch also sends and keeps cookies
// unless told otherwise, in the jar the WebViews share, so a site would know every later fetch for the same person.

export class TimedOut extends Error {
  constructor() {
    super('timed out');
    this.name = 'TimedOut';
  }
}

export class TooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`over the cap at ${bytes} bytes`);
    this.name = 'TooLarge';
  }
}

/** A response whose body is still under the deadline it was asked for with. */
export type Opened = {
  res: Response;
  /** The body, at most maxBytes: TooLarge past it (declared or streamed), TimedOut at the deadline. Ends the deadline. */
  read: (maxBytes: number) => Promise<Uint8Array>;
  /** Ends the deadline without reading the body, and lets the request go. */
  done: () => void;
};

const noop = () => undefined;

/** Fetches url with no cookies, the deadline running from now until the body is read or done() is called. */
export async function open(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Opened> {
  const ctl = new AbortController();
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // the deadline is raced as well as signalled, so a fetch or a body that ignores the abort still lets go
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      late = true;
      ctl.abort();
      fail(new TimedOut());
    }, timeoutMs);
  });
  deadline.catch(noop);
  const end = () => clearTimeout(timer);
  const why = (e: unknown) => (late ? new TimedOut() : e);
  let res: Response;
  try {
    res = await Promise.race([f(url, { ...init, credentials: 'omit', signal: ctl.signal }), deadline]);
  } catch (e) {
    end();
    throw why(e);
  }
  const read = async (maxBytes: number): Promise<Uint8Array> => {
    try {
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new TooLarge(declared);
      return await Promise.race([body(res, maxBytes), deadline]);
    } catch (e) {
      ctl.abort();
      throw why(e);
    } finally {
      end();
    }
  };
  const done = () => {
    end();
    ctl.abort();
  };
  return { res, read, done };
}

/** The body chunk by chunk, refused as soon as it passes the cap; a fetch with no stream is read whole and then checked. */
async function body(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.length > maxBytes) throw new TooLarge(whole.length);
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) throw new TooLarge(n);
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(noop);
    throw e;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
