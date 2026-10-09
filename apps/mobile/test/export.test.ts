import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { exportHtml, exportRows } from '../src/data/export';
import { memoryDb } from './sqlite';

const h = (n: number) => n.toString(16).padStart(64, '0');
const NAMES = { unread: 'Unread', archive: 'Archive' };

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, 'a'.repeat(64), 'new', true);
  const add = (n: number, state: 'unread' | 'archived', title: string | null, extra = '') =>
    db.run(`INSERT INTO items (owner, hash, url, title, saved_at, state, text_state, origin${extra ? ', pending_delete_at' : ''}) VALUES (?, ?, ?, ?, ?, ?, 'cached', 'share'${extra ? ', 5' : ''})`,
      'a'.repeat(64), h(n), `https://e.com/${n}?a=1&b=2`, title, 100 + n, state);
  return { db, add };
}

describe('Export my saves (mobile spec 5.8, FD 89)', () => {
  test('one bookmark file: Unread then Archive, newest first, each save with its text', () => {
    const w = world();
    w.add(1, 'unread', 'First <one>');
    w.add(2, 'unread', 'Second');
    w.add(3, 'archived', null);
    w.add(4, 'unread', 'Going', 'deleted');
    const html = exportHtml(exportRows(w.db, 'a'.repeat(64)), (hash) => (hash === h(1) ? '# First\n\nSome "words" & more.' : null), NAMES);
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    const order = [...html.matchAll(/<H3>(\w+)<\/H3>|HREF="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    expect(order).toEqual(['Unread', 'https://e.com/2?a=1&amp;b=2', 'https://e.com/1?a=1&amp;b=2', 'Archive', 'https://e.com/3?a=1&amp;b=2']);
    expect(html).toContain('ADD_DATE="101">First &lt;one&gt;</A>\n<DD># First<br>\n<br>\nSome &quot;words&quot; &amp; more.');
    // no title: the address stands in; no text on the phone: the link alone
    expect(html).toContain('ADD_DATE="103">https://e.com/3?a=1&amp;b=2</A>\n</DL>');
    expect(html).not.toContain('e.com/4');
  });

  test('an empty library still makes a valid file', () => {
    const w = world();
    const html = exportHtml(exportRows(w.db, 'a'.repeat(64)), () => null, NAMES);
    expect(html).toContain('<DT><H3>Unread</H3>\n<DL><p>\n</DL><p>');
  });
});
