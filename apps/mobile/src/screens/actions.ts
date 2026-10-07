// The library actions the screens share (mobile spec 5.6, 4.3): each writes the row at once, raises its toast with
// Undo, and releases its held sends only when the toast closes without Undo.
import { commitDelete, deleteItem, hashInUseAfterDelete, setArchived } from '../data/library';
import { release } from '../data/outbox';
import { appState } from '../services/app';
import { removeAllFiles, runOutbox } from '../services/runner';
import { store } from '../services/store';
import { stopIfPlaying } from '../services/voice';
import { S } from '../ui/strings';
import { showToast } from '../ui/toast';

const now = () => Math.floor(Date.now() / 1000);
const send = () => runOutbox().catch(() => 0);

/** Archive, or Back to Unread, with its toast. onUndo runs after the row is put back (a Reader reopens itself). */
export function archive(hash: string, toArchived: boolean, onUndo?: () => void): void {
  const owner = appState()?.owner;
  if (!owner) return;
  const c = setArchived(store(), now(), owner, hash, toArchived);
  showToast({
    text: toArchived ? S.toast.archived : S.toast.unarchived,
    hash,
    undo: () => {
      c.revert();
      onUndo?.();
    },
    commit: () => {
      release(store(), c.held);
      send();
    },
  });
}

/** Delete, with its toast; the row and its files go when the toast closes without Undo. */
export function remove(hash: string, onUndo?: () => void): void {
  const owner = appState()?.owner;
  if (!owner) return;
  // Deleting the playing article stops it (FD 34).
  stopIfPlaying(hash);
  const c = deleteItem(store(), now(), owner, hash);
  showToast({
    text: S.toast.deleted,
    hash,
    undo: () => {
      c.revert();
      onUndo?.();
    },
    commit: () => {
      commitDelete(store(), owner, hash, c.held);
      if (!hashInUseAfterDelete(store(), hash)) removeAllFiles(hash);
      send();
    },
  });
}
