// The words the voice lights in a block (mobile spec 6.7: only the playing paragraph splits), as pieces of each
// span: the lit words alone, everything around them whole. Words are counted across the spans as the spoken
// projection counts them, a word running on from one span into the next counting once, so word k lit here is word k
// spoken. Splitting every word of the block into its own piece cost a Text per word at each word the voice reached:
// 20,000 for a block of 64 KB, several times a second.

/** The words lit: from and to, as indices of the block's whitespace-separated words (one, or a whole sentence). */
export type Lit = { from: number; to: number };

/** A piece of a span's text, lit or not. */
export type LitPiece = { text: string; on: boolean };

/** Each span's pieces: a lit word on its own, and the text between lit words (spaces included) whole. */
export function litPieces(spans: { text: string }[], lit: Lit): LitPiece[][] {
  let k = -1;
  let wasSpace = true;
  return spans.map(({ text }) => {
    const out: LitPiece[] = [];
    let off = 0;
    const re = /\S+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // a word at the span's start runs on from the last span's unless that ended in a space
      if (m.index > 0 || wasSpace) k++;
      wasSpace = false;
      if (k < lit.from || k > lit.to) continue;
      if (m.index > off) out.push({ text: text.slice(off, m.index), on: false });
      out.push({ text: m[0], on: true });
      off = m.index + m[0].length;
    }
    if (off < text.length) out.push({ text: text.slice(off), on: false });
    if (text) wasSpace = /\s$/.test(text);
    return out;
  });
}
