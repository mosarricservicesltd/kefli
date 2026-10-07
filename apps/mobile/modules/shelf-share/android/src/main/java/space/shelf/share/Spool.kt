package space.shelf.share

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.io.File
import java.util.UUID

// Shares waiting for JavaScript: filesDir/share-spool/<uuid>.json, written atomically (mobile spec 8.5).
object Spool {
  fun dir(context: Context): File = File(context.filesDir, "share-spool").apply { mkdirs() }

  /** Writes the share and returns its id. Text and subject are kept as sent; nothing is parsed here. */
  fun write(context: Context, intent: Intent, referrer: String?): String {
    val id = UUID.randomUUID().toString()
    val body = JSONObject()
      .put("v", 1)
      .put("id", id)
      .put("text", intent.getStringExtra(Intent.EXTRA_TEXT) ?: JSONObject.NULL)
      .put("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: JSONObject.NULL)
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
