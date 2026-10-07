package space.shelf.system

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import com.facebook.react.ReactActivity
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ShelfSystemModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShelfSystem")

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

  private fun reactBackCallback(activity: ReactActivity): OnBackPressedCallback? =
    ReactActivity::class.java.declaredFields
      .firstOrNull { OnBackPressedCallback::class.java.isAssignableFrom(it.type) }
      ?.apply { isAccessible = true }
      ?.get(activity) as? OnBackPressedCallback
}
