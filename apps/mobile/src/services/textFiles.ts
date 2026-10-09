// Article text on the phone (mobile spec 4.1): Paths.document/kefli/text/<hash>.md, and the Reader's blocks
// beside it. Per hash, so a file goes only when no row holds the hash.
import { Directory, File, Paths } from 'expo-file-system';
import { DERIVED_VERSION, deriveArticle, type Derived } from '../reader/blocks';

const dir = () => new Directory(Paths.document, 'kefli', 'text');

function remove(name: string) {
  const f = new File(dir(), name);
  if (f.exists) f.delete();
}

function writeDerived(hash: string, derived: Derived) {
  const { spoken: _spoken, ...kept } = derived;
  new File(dir(), `${hash}.blocks.json`).write(JSON.stringify(kept));
}

const imgDir = () => new Directory(Paths.document, 'kefli', 'img');

/** Article images: Paths.document/kefli/img/<sha256 of the image's address> (4.1), app storage, kept offline. */
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
  /** The text, and what was derived from it once (blocks, words, sentences), so opening and listening only read. */
  writeText(hash: string, markdown: string, derived?: Derived): void {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true });
    new File(d, `${hash}.md`).write(markdown);
    remove(`${hash}.blocks.json`);
    if (derived) writeDerived(hash, derived);
  },
  /** The article's blocks and sentences: from its file, or derived from the text once and kept (6.7). */
  readArticle(hash: string): Omit<Derived, 'spoken'> | null {
    const f = new File(dir(), `${hash}.blocks.json`);
    if (f.exists) {
      try {
        const a = JSON.parse(f.textSync()) as Omit<Derived, 'spoken'>;
        if (a.v === DERIVED_VERSION) return a;
      } catch {
        // derived again below
      }
    }
    const md = textFiles.readText(hash);
    if (md === null) return null;
    const derived = deriveArticle(md);
    writeDerived(hash, derived);
    return derived;
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
