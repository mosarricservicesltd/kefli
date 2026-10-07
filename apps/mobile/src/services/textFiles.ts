// Article text on the phone (mobile spec 4.1): Paths.document/shelf/text/<hash>.md, and the Reader's blocks
// beside it. Per hash, so a file goes only when no row holds the hash.
import { Directory, File, Paths } from 'expo-file-system';

const dir = () => new Directory(Paths.document, 'shelf', 'text');

function remove(name: string) {
  const f = new File(dir(), name);
  if (f.exists) f.delete();
}

const imgDir = () => new Directory(Paths.document, 'shelf', 'img');

/** Article images: Paths.document/shelf/img/<sha256 of the image's address> (4.1), app storage, kept offline. */
export const imageFiles = {
  write(name: string, bytes: Uint8Array): string {
    const d = imgDir();
    if (!d.exists) d.create({ intermediates: true });
    const f = new File(d, name);
    f.write(bytes);
    return f.uri;
  },
  remove(path: string): void {
    const f = new File(path);
    if (f.exists) f.delete();
  },
};

export const textFiles = {
  writeText(hash: string, markdown: string): void {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true });
    new File(d, `${hash}.md`).write(markdown);
    remove(`${hash}.blocks.json`);
  },
  readText(hash: string): string | null {
    const f = new File(dir(), `${hash}.md`);
    return f.exists ? f.textSync() : null;
  },
  removeText(hash: string): void {
    remove(`${hash}.md`);
    remove(`${hash}.blocks.json`);
  },
  /** Everything held for the hash. Images join this when the image cache arrives (4.5, phase 6). */
  removeAll(hash: string): void {
    textFiles.removeText(hash);
  },
};
