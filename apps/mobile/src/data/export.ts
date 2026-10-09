// Export my saves (mobile spec 5.8, FD 89): one HTML bookmark file, the Netscape format browsers and read-later apps
// import, with Unread and Archive as folders and each save's text under its link. Built from the phone alone, so it
// works offline; a save whose text isn't on the phone is exported as its link.
//
// RULED: the text goes in the entry's DD as escaped plain text, the Markdown left as written, with line breaks kept,
// so importers that read DD as a description still parse the file and a browser still shows it readably.
import type { SqlDb } from './db';

export const EXPORT_FILE = 'kefli-export.html';

export type ExportRow = { hash: string; url: string; title: string | null; saved_at: number; state: 'unread' | 'archived' };

export function exportRows(db: SqlDb, owner: string): ExportRow[] {
  return db.all<ExportRow>(
    'SELECT hash, url, title, saved_at, state FROM items WHERE owner = ? AND pending_delete_at IS NULL ORDER BY saved_at DESC, id DESC', owner);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function entry(r: ExportRow, text: string | null): string {
  const link = `<DT><A HREF="${esc(r.url)}" ADD_DATE="${r.saved_at}">${esc(r.title || r.url)}</A>`;
  const body = text?.trim();
  return body ? `${link}\n<DD>${esc(body).replace(/\r?\n/g, '<br>\n')}` : link;
}

function folder(name: string, rows: ExportRow[], textOf: (hash: string) => string | null): string {
  return [`<DT><H3>${name}</H3>`, '<DL><p>', ...rows.map((r) => entry(r, textOf(r.hash))), '</DL><p>'].join('\n');
}

/** The file's contents: unread saves, then archived ones, each newest first. */
export function exportHtml(rows: ExportRow[], textOf: (hash: string) => string | null, names: { unread: string; archive: string }): string {
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Kefli</TITLE>',
    '<H1>Kefli</H1>',
    '<DL><p>',
    folder(names.unread, rows.filter((r) => r.state === 'unread'), textOf),
    folder(names.archive, rows.filter((r) => r.state === 'archived'), textOf),
    '</DL><p>',
    '',
  ].join('\n');
}
