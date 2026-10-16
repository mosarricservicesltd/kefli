// The notice over the original when a save has no clean copy (mobile spec 5.6): a PDF says what kind of PDF it
// was (flow decision 103); anything else gets the general notice. A save whose page https refused has no original
// to show either: its address goes to the browser instead (flow decision 119).
import { S } from '../ui/strings';

/**
 * Whether the Original view hands the save's address to the browser instead of opening: a page the fetch failed with
 * http (page.ts FailReason), refused over https, with no https at all, or a status the view would fail on too, so
 * the view would only show "This page won’t load here" (FD 119). Every other failure keeps the view.
 */
export function browserInstead(reason: string | null): boolean {
  return reason === 'http';
}

export function failNotice(reason: string | null): string {
  if (reason === 'pdf_no_text') return S.reader.pdfNoText;
  if (reason === 'pdf_locked') return S.reader.pdfLocked;
  return S.reader.errorNotice;
}
