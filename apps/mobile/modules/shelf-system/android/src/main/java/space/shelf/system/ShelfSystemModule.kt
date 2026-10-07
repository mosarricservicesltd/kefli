package space.shelf.system

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
  }

  private fun reactBackCallback(activity: ReactActivity): OnBackPressedCallback? =
    ReactActivity::class.java.declaredFields
      .firstOrNull { OnBackPressedCallback::class.java.isAssignableFrom(it.type) }
      ?.apply { isAccessible = true }
      ?.get(activity) as? OnBackPressedCallback
}
