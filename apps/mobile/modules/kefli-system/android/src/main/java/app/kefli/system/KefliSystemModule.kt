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
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewDatabase
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import com.facebook.react.ReactActivity
import com.facebook.react.uimanager.RootView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
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

    // Export my saves (8.6, 5.8): the file in Downloads. From API 29 through MediaStore, replacing the export Kefli
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

    // Delete my data and Sign out (7.2, F28): the app's one WebView profile, which the Original view and the parser
    // share, loses its cookies, its sites' storage (localStorage, IndexedDB and the rest) and its cache, so the next
    // library on the phone inherits no logins and no pages. Resolves once the cookies are gone and written out.
    AsyncFunction("clearWebData") { promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.reject(CodedException("no context"))
      WebStorage.getInstance().deleteAllData()
      WebViewDatabase.getInstance(context).clearHttpAuthUsernamePassword()
      WebView(context).run {
        clearCache(true)
        destroy()
      }
      val cookies = CookieManager.getInstance()
      cookies.removeAllCookies {
        cookies.flush()
        promise.resolve(null)
      }
    }.runOnQueue(Queues.MAIN)

    // The character under a point in the Reader (FD 107: double-tap a word to play from it). React Native reports
    // where a Text was pressed but not which character, so the text view under the point, in React Native's
    // page coordinates, is asked for its offset there; the text comes back with it, for the word to be counted.
    // Null where no text lies under the point.
    AsyncFunction("textOffsetAt") { pageX: Double, pageY: Double ->
      val activity = appContext.currentActivity ?: return@AsyncFunction null
      val root = findRoot(activity.window.decorView) ?: return@AsyncFunction null
      val at = IntArray(2).also { root.getLocationInWindow(it) }
      val density = activity.resources.displayMetrics.density
      val x = at[0] + (pageX * density).toFloat()
      val y = at[1] + (pageY * density).toFloat()
      val text = textViewAt(root, x, y) ?: return@AsyncFunction null
      val own = IntArray(2).also { text.getLocationInWindow(it) }
      val offset = text.getOffsetForPosition(x - own[0], y - own[1])
      if (offset < 0) null else mapOf("offset" to offset, "text" to text.text.toString())
    }.runOnQueue(Queues.MAIN)
  }

  private fun findRoot(v: View): View? {
    if (v is RootView) return v
    if (v !is ViewGroup) return null
    for (i in 0 until v.childCount) findRoot(v.getChildAt(i))?.let { return it }
    return null
  }

  /** The topmost shown text view whose box holds the point, in window coordinates. */
  private fun textViewAt(v: View, x: Float, y: Float): TextView? {
    if (!v.isShown) return null
    val at = IntArray(2).also { v.getLocationInWindow(it) }
    if (x < at[0] || x >= at[0] + v.width || y < at[1] || y >= at[1] + v.height) return null
    if (v is ViewGroup) for (i in v.childCount - 1 downTo 0) textViewAt(v.getChildAt(i), x, y)?.let { return it }
    return v as? TextView
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
