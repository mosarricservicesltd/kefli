// A sentence longer than the system voice takes at a time (mobile spec 8.1): Android's engine speaks at most
// getMaxSpeechInputLength (4,000) characters a call. Node can't run the Kotlin: the tests after the first read its
// source, standing in for the check on the phone listed in HANDOVER.
import { deriveArticle } from '../src/reader/blocks';
import { kotlinSource, member } from './kotlin';

/** The most kefli-voice hands the engine in one call: getMaxSpeechInputLength() - 1. */
const ENGINE_CHARS = 3_999;

const voiceSource = (file: string) => kotlinSource('kefli-voice', 'voice', file);

describe('a sentence longer than the engine takes (8.1)', () => {
  test('the Reader can still hand the voice one: a word the splitter keeps whole, as a paragraph of Chinese is', () => {
    const chinese = '这是一个很长的段落，没有空格。'.repeat(400);
    const token = 'x'.repeat(10_000);
    for (const md of [`${chinese}\n`, `Before.\n\n${token}\n\nAfter.\n`]) {
      const long = deriveArticle(md).sentences.filter((s) => s.text.length > ENGINE_CHARS);
      expect(long.length).toBe(1);
      expect(long[0].wordStarts).toEqual([0]);
    }
  });

  test('kefli-voice writes such a sentence a piece at a time, each a segment from its own offset, instead of cutting it', () => {
    const engine = voiceSource('VoiceEngine.kt');
    // the rest of the sentence past the limit was dropped unheard
    expect(engine).not.toMatch(/substring\(0, max\)/);
    const piece = member(engine, 'nextPiece');
    expect(piece).toContain('Pieces.end(whole, offset, TextToSpeech.getMaxSpeechInputLength() - 1)');
    expect(piece).toContain('whole.substring(offset, end)');
    // the next sentence only once this one's last piece is written; each piece its own utterance and file
    expect(piece).toMatch(/nextOffset = Pieces\.next\(whole, end\)\s+if \(nextOffset >= whole\.length\) \{\s+nextSentence = si \+ 1\s+nextOffset = 0/);
    expect(piece).toContain('val id = "$hash:$generation:$si:$offset"');
    expect(piece).toContain('"$generation-$si-$offset.wav"');
    expect(member(engine, 'writeAhead')).toContain('val synth = nextPiece()');
    expect(member(engine, 'current')).toContain('it.id == id');
    expect(member(engine, 'startFrom')).toMatch(/nextOffset = s\.wordStarts\[/);
    const pieces = voiceSource('VoiceAudio.kt');
    expect(pieces).toContain('object Pieces {');
    expect(member(pieces, 'end')).toMatch(/for \(k in limit - 1 downTo from \+ max \/ 2\) if \(breaksAfter\(text\[k\]\)\) return k \+ 1/);
    expect(member(pieces, 'end')).toContain('isHighSurrogate()');
  });

  test("a piece inside one long word, which holds no word start, leaves the engine's word timing on", () => {
    // any file with no word ranges turned the highlight to whole sentences, for every article after it
    const engine = voiceSource('VoiceEngine.kt');
    const written = member(engine, 'written');
    expect(written).not.toContain('wordTiming = false');
    expect(written).toContain('noteTiming(s, ranges)');
    expect(member(engine, 'noteTiming')).toContain('if (ranges.isEmpty() && Timing.showsNoRanges(sentences[s.sentence].wordStarts, s.offset, s.text)) wordTiming = false');
    const audio = voiceSource('VoiceAudio.kt');
    expect(member(audio, 'showsNoRanges')).toContain('startsWithin(wordStarts, offset, offset + text.length) &&');
    expect(member(audio, 'startsWithin')).toMatch(/lastAtOrBelow\(xs, until - 1\)\s+return k >= 0 && xs\[k\] >= from/);
  });

  test("a sentence with nothing said as a word, a rule between sections, leaves the engine's word timing on", () => {
    // the Reader hands the voice such sentences, which an engine may say as silence with no word ranges
    const said = deriveArticle('Before.\n\n—\n\n\\* \\* \\*\n\n🙂\n\nAfter.\n').sentences.map((s) => s.text);
    expect(said).toEqual(['Before.', '—', '* * *', '🙂', 'After.']);
    // only a file holding a letter or a digit shows the engine reports no ranges
    expect(member(voiceSource('VoiceAudio.kt'), 'showsNoRanges')).toContain('&& text.codePoints().anyMatch(Character::isLetterOrDigit)');
  });
});
