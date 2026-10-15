// What the Reader derives from a text once and keeps beside it (mobile spec 6.7; services/textFiles.ts): a file that
// another version of the derive wrote is derived again, so a change to what it holds reaches texts already on the
// phone. expo-file-system is a map in memory here.
import { normaliseMarkdown } from '@kefli/protocol';
import { DERIVED_VERSION, blockOfWord, deriveArticle } from '../src/reader/blocks';

const mockFiles = new Map<string, string>();

jest.mock('expo-file-system', () => {
  class Entry {
    readonly uri: string;
    constructor(parent: Entry | string, ...names: string[]) {
      this.uri = [typeof parent === 'string' ? parent : parent.uri, ...names].join('/');
    }
    get exists() {
      return [...mockFiles.keys()].some((k) => k === this.uri || k.startsWith(`${this.uri}/`));
    }
    create() {}
    write(text: string) {
      mockFiles.set(this.uri, text);
    }
    textSync() {
      return mockFiles.get(this.uri)!;
    }
    delete() {
      mockFiles.delete(this.uri);
    }
  }
  return { Directory: Entry, File: Entry, Paths: { document: 'file:///doc' } };
}, { virtual: true });

// required after the mock, which its module reads
const { textFiles } = require('../src/services/textFiles') as typeof import('../src/services/textFiles');

const FENCE = String.fromCharCode(96).repeat(3);
// a list item whose first block is code, as Turndown writes one: its marker, then the fence
const MD = normaliseMarkdown(`Para one here.\n\n1.  ${FENCE}\n    let x = 1;\n    ${FENCE}\n2.  next step\n`);
const HASH = 'ab'.repeat(32);
const FILE = `file:///doc/kefli/text/${HASH}.blocks.json`;
const shape = (blocks: { kind: string; firstWord: number; words: number }[]) => blocks.map((b) => [b.kind, b.firstWord, b.words]);

beforeEach(() => mockFiles.clear());

describe("the Reader's derived file (6.7)", () => {
  test("a code block's words are its own: its first is the block's, not the paragraph's before it", () => {
    const d = deriveArticle(MD);
    expect(shape(d.blocks)).toEqual([['p', 0, 3], ['code', 3, 4], ['li', 7, 2]]);
    // the voice on "let" scrolls to and lights the code
    expect(blockOfWord(d.blocks, 3)).toBe(1);
  });

  test('a file derived by version 3, before code blocks mapped right, is derived again and kept at this version', () => {
    textFiles.writeText(HASH, MD);
    // what version 3 wrote: its projection looked for the fence at the start of the line, took the item's code for
    // indented code and mapped it a line early, so "let" fell before the block and counted in the paragraph
    const { spoken: _spoken, ...now } = deriveArticle(MD);
    const [p, code, li] = now.blocks;
    mockFiles.set(FILE, JSON.stringify({ ...now, v: 3, blocks: [{ ...p, words: 4 }, { ...code, firstWord: 4, words: 3 }, li] }));
    expect(shape(textFiles.readArticle(HASH)!.blocks)).toEqual([['p', 0, 3], ['code', 3, 4], ['li', 7, 2]]);
    expect(JSON.parse(mockFiles.get(FILE)!)).toMatchObject({ v: DERIVED_VERSION, blocks: now.blocks });
  });

  test('a file of this version is read as it is, without deriving the text again', () => {
    textFiles.writeText(HASH, MD);
    const { spoken: _spoken, ...now } = deriveArticle(MD);
    mockFiles.set(FILE, JSON.stringify({ ...now, words: 99 }));
    expect(textFiles.readArticle(HASH)!.words).toBe(99);
  });
});
