package app.kefli.voice

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

// The pure parts of kefli-voice's file synthesis (mobile spec 8.1): reading the WAV the engine writes, telling
// which order the engine passed a word range's numbers in, finding the word at a frame of a sentence's audio, and
// cutting a sentence longer than the engine takes at a time into pieces.

/** A sentence's audio as the engine wrote it: 16-bit (or 8-bit) PCM at its rate. */
class Pcm(val sampleRate: Int, val channels: Int, val bits: Int, val data: ByteArray) {
  val frameBytes get() = channels * bits / 8
  val frames get() = if (frameBytes > 0) data.size / frameBytes else 0
}

object Wav {
  /** Reads a RIFF WAV's fmt and data chunks; a data size the engine left unfilled runs to the end of the file. */
  fun read(f: File): Pcm? {
    val b = runCatching { f.readBytes() }.getOrNull() ?: return null
    if (b.size < 12 || String(b, 0, 4) != "RIFF" || String(b, 8, 4) != "WAVE") return null
    val le = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
    var at = 12
    var rate = 0
    var channels = 0
    var bits = 0
    while (at + 8 <= b.size) {
      val id = String(b, at, 4)
      val size = le.getInt(at + 4)
      val body = at + 8
      if (id == "fmt " && body + 16 <= b.size) {
        channels = le.getShort(body + 2).toInt()
        rate = le.getInt(body + 4)
        bits = le.getShort(body + 14).toInt()
      }
      if (id == "data") {
        val end = if (size <= 0 || body + size > b.size) b.size else body + size
        return if (rate > 0 && channels > 0 && bits > 0) Pcm(rate, channels, bits, b.copyOfRange(body, end)) else null
      }
      at = body + maxOf(0, size) + (size and 1)
    }
    return null
  }
}

/**
 * onRangeStart's numbers, read by value: speaking passes (start, end, frame), and Google's engine writing a file
 * passes (frame, start, end) (week-0 gate). Characters fit the text with end past start; a frame grows past the
 * text's length after the first word. When both readings fit, the order learned from an earlier word wins.
 */
class RangeOrder {
  private var frameFirst: Boolean? = null

  /** The word's first character and its frame, or null when neither reading fits. */
  fun read(a: Int, b: Int, c: Int, textLength: Int): Pair<Int, Int>? {
    val documented = a >= 0 && b > a && b <= textLength
    val permuted = b >= 0 && c > b && c <= textLength
    val useFrameFirst = when {
      permuted && !documented -> true
      documented && !permuted -> false
      documented && permuted -> frameFirst ?: false
      else -> return null
    }
    if (documented != permuted) frameFirst = useFrameFirst
    return if (useFrameFirst) Pair(b, a) else Pair(a, c)
  }
}

/** A sentence's audio in the stream: where it starts, how long it is, and each word's frame within it. */
class Segment(val sentence: Int, val offset: Int, val startFrame: Long, val frames: Long, val sampleRate: Int, val ranges: List<IntArray>)

object Timing {
  /** The last index in sorted xs at or below v, or -1. */
  fun lastAtOrBelow(xs: IntArray, v: Int): Int {
    var lo = 0
    var hi = xs.size - 1
    var best = -1
    while (lo <= hi) {
      val mid = (lo + hi) ushr 1
      if (xs[mid] <= v) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    return best
  }

  /**
   * The word a segment is on at a frame within it: the last range whose frame has passed, its character mapped to a
   * word by the sentence's word starts. With no ranges (an engine without word timing) it is the segment's first word.
   */
  fun wordAt(seg: Segment, frameIn: Long, wordStarts: IntArray, firstWord: Int): Int {
    val startWord = maxOf(0, lastAtOrBelow(wordStarts, seg.offset))
    var char = -1
    for (r in seg.ranges) if (r[1] <= frameIn) char = r[0] else break
    if (char < 0) return firstWord + startWord
    return firstWord + maxOf(startWord, lastAtOrBelow(wordStarts, seg.offset + char))
  }
}

/**
 * A sentence in pieces the engine takes: it speaks at most getMaxSpeechInputLength characters a call, and a sentence
 * the splitter couldn't cut (one word longer than that, as a paragraph of Chinese or Japanese is, written without
 * spaces) lost the rest unheard. A piece ends after the last space or punctuation mark in the second half of its
 * window, where the voice pauses anyway, else at the limit, and never between the two halves of a surrogate pair.
 */
object Pieces {
  /** Where the piece of text starting at from ends, at most max characters on. */
  fun end(text: String, from: Int, max: Int): Int {
    if (text.length - from <= max) return text.length
    val limit = from + max
    for (k in limit - 1 downTo from + max / 2) if (breaksAfter(text[k])) return k + 1
    return if (max > 1 && text[limit - 1].isHighSurrogate()) limit - 1 else limit
  }

  /** Where the piece after one ending at end starts: past any spaces there. */
  fun next(text: String, end: Int): Int {
    var k = end
    while (k < text.length && text[k].isWhitespace()) k++
    return k
  }

  private fun breaksAfter(c: Char): Boolean =
    c.isWhitespace() || c.category == CharCategory.OTHER_PUNCTUATION || c.category == CharCategory.DASH_PUNCTUATION
}
