// Writes src/gates/expected.json: what Node computes for the projection, words, sentences and text_hash
// of a few samples, so the week-0 gates can check that Hermes gets the same (mobile spec 2.6, 11.2).
//   npx tsx apps/mobile/scripts/gate-expectations.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseMarkdown, project, sentences, textHash } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';

const SAMPLES = [
  '# A heading\r\n\r\n\r\nSome *emphasis* and [a link](https://example.com).  \nNext line.\n\n- one\n- two!\n',
  'Fish &amp; chips &#169; &nbsp;end. Mr. Smith met Dr. Jones. J. R. R. Tolkien wrote it. It cost 3.50 pounds.\n\n> quoted\n> more',
  'Café crème — naïve résumé. ÉCOLE in capitals? “Quoted.” Then 2024 began…\n\n```\ncode block();\n```\n\nUse <b> for bold.',
  'Ελληνικά κείμενα. Русский текст. 日本語のテキスト。 Emoji 🙂 here.\n\n1. first\n2. second\n',
];

const out = SAMPLES.map((raw) => {
  const md = normaliseMarkdown(raw);
  const p = project(md);
  return {
    raw,
    markdown: md,
    textHash: textHash(md, nodeCrypto),
    text: p.text,
    offsets: p.offsets,
    wordStarts: p.wordStarts,
    sentences: sentences(p).map((s) => [s.firstWord, s.text]),
  };
});
const path = join(__dirname, '..', 'src', 'gates', 'expected.json');
writeFileSync(path, `${JSON.stringify(out)}\n`);
console.log(`wrote ${path}: ${out.length} samples`);
