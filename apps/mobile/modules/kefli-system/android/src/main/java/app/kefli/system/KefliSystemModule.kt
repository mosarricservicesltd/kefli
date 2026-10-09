package app.kefli.system

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.MediaStore
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import com.facebook.react.ReactActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KefliSystemModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KefliSystem")

    // On target SDK 36, ReactActivity keeps a back callback enabled at all times, so Android never shows its
    // back-to-home preview. With the JS stack at a root screen and nothing open over it, the callback is
    // switched off and the system's preview plays (mobile spec 5, predictive back). React Native keeps the
    // callback private, so it is found by its type. Returns false if it can't be found.
    Function("setRootBack") { atRoot: Boolean ->
      val activity = appContext.currentActivity as? ReactActivity ?: return@Function false
      val callback = reactBackCallback(activity) ?: return@Function false
      activity.runOnUiThread { callback.isEnabled = !atRoot }
      true
    }

    // FLAG_SECURE while the recovery code or a pairing QR is on screen (7.1): no screenshots, recordings or
    // Recents thumbnail of the words.
    Function("setSecure") { on: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      true
    }

    // Export my saves (8.6, 5.8): the file in Downloads. From API 29 through MediaStore, replacing the export Shelf
    // wrote before (MediaStore only shows an app the files it made, so another app's file of that name is left and
    // the new one is numbered); on 26 to 28, through the system's save dialog, which needs no storage permission.
    AsyncFunction("exportToDownloads") { fileName: String, contents: String, promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.reject(CodedException("no context"))
      if (Build.VERSION.SDK_INT >= 29) {
        try {
          promise.resolve(mapOf("uri" to writeDownload(context, fileName, contents.toByteArray()).toString()))
        } catch (e: Exception) {
          promise.reject(CodedException("export failed: ${e.message}"))
        }
        return@AsyncFunction
      }
      val activity = appContext.currentActivity ?: return@AsyncFunction promise.reject(CodedException("no activity"))
      pendingExport = PendingExport(contents.toByteArray(), promise)
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("text/html").putExtra(Intent.EXTRA_TITLE, fileName)
      activity.startActivityForResult(intent, EXPORT_REQUEST)
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != EXPORT_REQUEST) return@OnActivityResult
      val pending = pendingExport ?: return@OnActivityResult
      pendingExport = null
      val uri = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || uri == null) return@OnActivityResult pending.promise.reject(CodedException("export cancelled"))
      try {
        appContext.reactContext!!.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(pending.bytes) }
        pending.promise.resolve(mapOf("uri" to uri.toString()))
      } catch (e: Exception) {
        pending.promise.reject(CodedException("export failed: ${e.message}"))
      }
    }

    // Copies text marked sensitive (7.1), so Android hides it from the clipboard preview and keyboard suggestions:
    // ClipDescription.EXTRA_IS_SENSITIVE from API 33, its string key before.
    Function("copySensitive") { label: String, text: String ->
      val context = appContext.reactContext ?: return@Function false
      val clip = ClipData.newPlainText(label, text)
      clip.description.extras = PersistableBundle().apply {
        val key = if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
        putBoolean(key, true)
      }
      (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
      true
    }
  }

  private class PendingExport(val bytes: ByteArray, val promise: Promise)
  private var pendingExport: PendingExport? = null

  @androidx.annotation.RequiresApi(29)
  private fun writeDownload(context: Context, fileName: String, bytes: ByteArray): Uri {
    val resolver = context.contentResolver
    val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
    val existing = resolver.query(
      collection, arrayOf(MediaStore.Downloads._ID),
      "${MediaStore.Downloads.DISPLAY_NAME} = ? AND ${MediaStore.Downloads.RELATIVE_PATH} = ?", arrayOf(fileName, "Download/"), null,
    )?.use { c -> if (c.moveToFirst()) Uri.withAppendedPath(collection, c.getLong(0).toString()) else null }
    if (existing != null) {
      resolver.openOutputStream(existing, "wt")!!.use { it.write(bytes) }
      return existing
    }
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, fileName)
      put(MediaStore.Downloads.MIME_TYPE, "text/html")
      put(MediaStore.Downloads.RELATIVE_PATH, "Download/")
      put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val uri = resolver.insert(collection, values) ?: throw IllegalStateException("MediaStore refused the file")
    try {
      resolver.openOutputStream(uri, "w")!!.use { it.write(bytes) }
    } catch (e: Exception) {
      resolver.delete(uri, null, null)
      throw e
    }
    resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    return uri
  }

  private companion object {
    const val EXPORT_REQUEST = 0x5E1F
  }

  private fun reactBackCallback(activity: ReactActivity): OnBackPressedCallback? =
    ReactActivity::class.java.declaredFields
      .firstOrNull { OnBackPressedCallback::class.java.isAssignableFrom(it.type) }
      ?.apply { isAccessible = true }
      ?.get(activity) as? OnBackPressedCallback
}
