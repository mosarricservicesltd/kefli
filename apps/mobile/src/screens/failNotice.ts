// The notice over the original when a save has no clean copy (mobile spec 5.6): a PDF says what kind of PDF it
// was (flow decision 103); anything else gets the general notice.
import { S } from '../ui/strings';

export function failNotice(reason: string | null): string {
  if (reason === 'pdf_no_text') return S.reader.pdfNoText;
  if (reason === 'pdf_locked') return S.reader.pdfLocked;
  return S.reader.errorNotice;
}
