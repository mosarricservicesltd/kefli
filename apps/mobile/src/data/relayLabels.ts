// The names Advanced gives its relay rows (flow decision 113): Kefli's relay is "Kefli", each of Kefli's default
// relays is "Backup 1", "Backup 2" and so on in the order shown, and only a relay the person added themselves is
// "Your relay". A default relay keeps its Backup name even when the person's own relay list carries it too, as a
// nostr user's often does, since what the name says is who stands behind the copy, not who listed it (Richard,
// 16 October 2026: primal and nos.lol read "Your relay" on his phone).

export type RelayName = { kind: 'operator' } | { kind: 'backup'; n: number } | { kind: 'yours' };

const sameRelay = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/** Names the rows in the order given; `defaults` is the operator's relay list, Kefli's own relay included or not. */
export function relayNames(urls: string[], operator: string | null, defaults: string[]): RelayName[] {
  let n = 0;
  return urls.map((url) => {
    if (operator && sameRelay(url, operator)) return { kind: 'operator' };
    if (defaults.some((d) => sameRelay(d, url))) return { kind: 'backup', n: ++n };
    return { kind: 'yours' };
  });
}
