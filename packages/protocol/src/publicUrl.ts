// Inbox-driven fetches refuse private, loopback and link-local addresses (mobile spec 7.1): a browser's save request
// names a URL the phone then fetches, which must not reach into the phone's own network.
//
// RULED: the host as written is checked (names that are local by convention, and IP literals in every form the URL
// parser accepts); names aren't resolved, and a redirect isn't followed up, since the phone's fetch doesn't expose
// either. That stops a request naming such an address outright, which is what the control is for.

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

function ipv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function privateV6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::' || h === '::1') return true;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(ipv4(mapped[1]) ?? [0]);
  // ::ffff:7f00:1 and the like, as the URL parser writes mapped addresses
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    return privateV4([hi >> 8, hi & 255]);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h);
}

/** True for an http(s) URL whose host is neither local by name nor a private, loopback or link-local address. */
export function isPublicWebUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.replace(/\.$/, '');
  if (!host || LOCAL_NAMES.test(host) || !host.includes('.') && !host.includes(':')) return false;
  if (host.startsWith('[') || host.includes(':')) return !privateV6(host);
  const v4 = ipv4(host);
  return v4 ? !privateV4(v4) : true;
}
