package app.kefli.share

import android.text.Spanned
import android.text.style.URLSpan

// A share's text as the spool keeps it (mobile spec 8.5): plain text as it was sent, and styled text as plain text
// with what only its styling held of the link. The sheet reads an address from the text alone (pickup.ts firstLink).
object ShareText {
  /** The most link addresses taken from styled text, the last: as many as the sheet tries (pickup.ts SHARE_MAX_TRIES). */
  const val LINKS = 16

  /** U+FFFC, the mark a picture in styled text leaves in its plain text. */
  private const val PICTURE = '\uFFFC'

  /**
   * The text as plain text. Styled text that shows no address of its own gives its links' addresses after it, a line
   * each, in the order they appear, so the sheet takes the last as it would had they been written out: an app sharing
   * HTML through ShareCompat's setHtmlText sends `<a href=…>A story</a>` as the text "A story", its address only in
   * the link, and the sheet said That wasn't a link. Text that shows an address is left as it is, so no share that
   * saved before saves anything else now. A picture's mark reads as a space, so one beside an address isn't taken for
   * part of it.
   */
  fun of(cs: CharSequence): String {
    if (cs !is Spanned) return cs.toString()
    val text = cs.toString().replace(PICTURE, ' ')
    if (text.contains("http://") || text.contains("https://")) return text
    val links = linksOf(cs)
    return if (links.isEmpty()) text else (listOf(text) + links).joinToString("\n")
  }

  /** The web addresses of the text's links, each once, in the order they appear: the last LINKS of them. */
  private fun linksOf(s: Spanned): List<String> =
    s.getSpans(0, s.length, URLSpan::class.java)
      .sortedBy { s.getSpanStart(it) }
      .mapNotNull { it.url }
      .filter { it.startsWith("http://") || it.startsWith("https://") }
      .distinct()
      .takeLast(LINKS)
}
