package app.kefli.share

import android.content.Context
import android.content.Intent
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Shares waiting for JavaScript: filesDir/share-spool/<uuid>.json, written atomically and synced (mobile spec 8.5).
object Spool {
  fun dir(context: Context): File = File(context.filesDir, "share-spool").apply { mkdirs() }

  /**
   * Shares whose spool couldn't be written (a full disk), held for their own sheet in this process, which saves them
   * or says That didn't save, as for any share. The failure used to close the app, the share with it.
   */
  private val unwritten = ConcurrentHashMap<String, String>()

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
      .toString()
    try {
      writeSynced(dir(context), "$id.json", body)
    } catch (e: IOException) {
      Log.w("KefliShare", "spool not written: ${e.javaClass.simpleName}")
      unwritten[id] = body
    }
    return id
  }

  /**
   * The file whole or not at all, whenever the power goes: written beside its name, synced to the disk, then renamed,
   * and the folder synced so the rename holds too. Renamed before its bytes were on the disk, a spool could come back
   * from a power cut empty or cut short, which the start-up pickup reads as no share and deletes.
   */
  private fun writeSynced(dir: File, name: String, body: String) {
    val tmp = File(dir, "$name.tmp")
    try {
      FileOutputStream(tmp).use { out ->
        out.write(body.toByteArray(Charsets.UTF_8))
        out.fd.sync()
      }
      if (!tmp.renameTo(File(dir, name))) throw IOException("rename failed")
    } catch (e: IOException) {
      tmp.delete()
      throw e
    }
    syncFolder(dir)
  }

  /** The folder's entries to the disk. The spool is already whole under its name, so a failure here is only logged. */
  private fun syncFolder(dir: File) {
    try {
      val fd = Os.open(dir.path, OsConstants.O_RDONLY, 0)
      try {
        Os.fsync(fd)
      } finally {
        Os.close(fd)
      }
    } catch (e: ErrnoException) {
      Log.w("KefliShare", "spool folder not synced: errno ${e.errno}")
    }
  }

  fun read(context: Context, id: String): String? = File(dir(context), "$id.json").takeIf { it.exists() }?.readText() ?: unwritten[id]

  fun delete(context: Context, id: String): Boolean {
    val held = unwritten.remove(id) != null
    return File(dir(context), "$id.json").delete() || held
  }

  /** Spools left by a share that never finished, oldest first. */
  fun list(context: Context): List<String> =
    dir(context).listFiles { f -> f.name.endsWith(".json") }.orEmpty().sortedBy { it.lastModified() }.map { it.name.removeSuffix(".json") }
}
