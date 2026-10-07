import { countWords, normaliseMarkdown } from '@shelf/protocol';
import { articleBlocks, blockOfWord } from '../src/reader/blocks';

const MD = normaliseMarkdown(`# A title

The first paragraph has *emphasis*, **strong words**, \`code\` and [a link](https://e.com/x).

![A photo](https://e.com/p.jpg)

> A quoted line.

- One thing
- Another thing
  1. Nested first

\`\`\`
let saved = true;
\`\`\`

---

Last words here.`);

describe('the Reader blocks (mobile spec 6.7)', () => {
  test('blocks, spans and their first words', () => {
    const a = articleBlocks(MD);
    expect(a.words).toBe(countWords(MD));
    expect(a.blocks.map((b) => b.kind)).toEqual(['h', 'p', 'img', 'quote', 'li', 'li', 'li', 'code', 'hr', 'p']);
    const p = a.blocks[1] as { spans: { text: string; href?: string; em?: boolean }[] };
    expect(p.spans.map((x: { text: string }) => x.text).join('')).toBe('The first paragraph has emphasis, strong words, code and a link.');
    expect(p.spans.find((s) => s.href)).toEqual({ href: 'https://e.com/x', text: 'a link' });
    expect(p.spans.find((s) => s.em)?.text).toBe('emphasis');
    expect(a.blocks[2]).toMatchObject({ kind: 'img', src: 'https://e.com/p.jpg', alt: 'A photo' });
    expect(a.blocks[6]).toMatchObject({ kind: 'li', ordered: true, marker: '1.', depth: 1 });
    expect(a.blocks[0]).toMatchObject({ firstWord: 0, words: 2 });
    expect(a.blocks[1].firstWord).toBe(2);
    const last = a.blocks[a.blocks.length - 1];
    expect(last.firstWord + last.words).toBe(a.words);
    // the words of the blocks add up to the article's
    expect(a.blocks.reduce((s, b) => s + b.words, 0)).toBe(a.words);
  });

  test('a word finds its block', () => {
    const a = articleBlocks(MD);
    expect(blockOfWord(a.blocks, 0)).toBe(0);
    expect(blockOfWord(a.blocks, 2)).toBe(1);
    expect(blockOfWord(a.blocks, a.words - 1)).toBe(a.blocks.length - 1);
  });

  test('an empty article has no blocks', () => {
    expect(articleBlocks('\n')).toEqual({ blocks: [], words: 0 });
  });
});
