// Export my saves on the phone (mobile spec 5.8, 8.6): the file built from the database and the texts on the phone,
// then written to Downloads by kefli-system.
import { KefliSystem } from '../../modules/kefli-system/src';
import { EXPORT_FILE, exportHtml, exportRows } from '../data/export';
import { S } from '../ui/strings';
import { store } from './store';
import { textFiles } from './textFiles';

export async function exportSaves(owner: string): Promise<void> {
  const html = exportHtml(exportRows(store(), owner), (hash) => textFiles.readText(hash), { unread: S.saves.unread, archive: S.saves.archive });
  await KefliSystem.exportToDownloads(EXPORT_FILE, html);
}
