// Internal links (mobile spec 5.1, 7.1): the media session and Read now open kefli://reader/<hash>?word=<n>, and no
// other link reaches a screen. The hash must be 64 hex characters for a save on the phone and the word a
// non-negative integer; anything else opens Saves. The gates screen opens by link in the local stack's build only,
// where testing drives it over adb.

const READER = /^\/?reader\/([0-9a-f]{64})\/?$/;

/** The route a system link may open: the Reader for a save on the phone, the gates in a local build, else Saves. */
export function linkRoute(raw: string, has: (hash: string) => boolean, local: boolean): string {
  let path = raw;
  let query = '';
  try {
    const u = new URL(raw, 'kefli://app/');
    // kefli://reader/<hash> parses with reader as the host
    path = u.protocol === 'kefli:' && u.host && u.host !== 'app' ? `/${u.host}${u.pathname}` : u.pathname;
    query = u.search;
  } catch {
    return '/';
  }
  if (local && /^\/?gates\/?$/.test(path)) return '/gates';
  const m = path.match(READER);
  if (!m || !has(m[1])) return '/';
  const word = new URLSearchParams(query).get('word');
  return word !== null && /^\d{1,9}$/.test(word) ? `/reader/${m[1]}?word=${word}` : `/reader/${m[1]}`;
}
