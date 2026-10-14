// THE ORACLE for normaliseMarkdown: src/text.ts's rule as it stood until 14 October 2026, copied unchanged, when each
// line's end was trimmed with /[ \t]+$/, which backtracks over every run of spaces inside a line (10 s for a run of
// 80,000). differential.test.ts holds the current one to it on inputs it takes in reasonable time; a run of combining
// marks past MAX_COMBINING_RUN, which the current one refuses, is left out.
export function normaliseMarkdown(markdown: string): string {
  return markdown
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    // Lines split on LF only, so a lone CR, U+2028 and U+2029 are not line ends here, as in a port that splits on \n.
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}
