// Article text on the phone (mobile spec 4.1): Paths.document/shelf/text/<hash>.md, and the Reader's blocks
// beside it. Per hash, so a file goes only when no row holds the hash.
import { Directory, File, Paths } from 'expo-file-system';

const dir = () => new Directory(Paths.document, 'shelf', 'text');

function remove(name: string) {
  const f = new File(dir(), name);
  if (f.exists) f.delete();
}

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
