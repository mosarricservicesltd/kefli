package app.kefli.share

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.io.File
import java.util.UUID

// Shares waiting for JavaScript: filesDir/share-spool/<uuid>.json, written atomically (mobile spec 8.5).
object Spool {
  fun dir(context: Context): File = File(context.filesDir, "share-spool").apply { mkdirs() }

  /**
   * An extra as text. An app sharing styled text passes a CharSequence, which getStringExtra reads as null, so the
   * sheet said That wasn't a link; read as a CharSequence, plain and styled text both arrive. Extras that can't be
   * read at all (a class only the sender has) are no text, rather than a crash before the sheet rises.
   */
  private fun textExtra(intent: Intent, name: String): String? =
    try {
      intent.getCharSequenceExtra(name)?.toString()
    } catch (e: RuntimeException) {
      null
    }

  /** Writes the share and returns its id. Text and subject are kept as sent; nothing is parsed here. */
  fun write(context: Context, intent: Intent, referrer: String?): String {
    val id = UUID.randomUUID().toString()
    val body = JSONObject()
      .put("v", 1)
      .put("id", id)
      .put("text", textExtra(intent, Intent.EXTRA_TEXT) ?: JSONObject.NULL)
      .put("subject", textExtra(intent, Intent.EXTRA_SUBJECT) ?: JSONObject.NULL)
      .put("referrer", referrer ?: JSONObject.NULL)
      .put("receivedAt", System.currentTimeMillis())
    val tmp = File(dir(context), "$id.json.tmp")
    tmp.writeText(body.toString())
    tmp.renameTo(File(dir(context), "$id.json"))
    return id
  }

  fun read(context: Context, id: String): String? = File(dir(context), "$id.json").takeIf { it.exists() }?.readText()

  fun delete(context: Context, id: String): Boolean = File(dir(context), "$id.json").delete()

  /** Spools left by a share that never finished, oldest first. */
  fun list(context: Context): List<String> =
    dir(context).listFiles { f -> f.name.endsWith(".json") }.orEmpty().sortedBy { it.lastModified() }.map { it.name.removeSuffix(".json") }
}
