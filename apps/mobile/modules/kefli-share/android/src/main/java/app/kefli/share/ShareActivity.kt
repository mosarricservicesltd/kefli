package app.kefli.share

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import java.lang.ref.WeakReference

// The share sheet's target (mobile spec 8.5). onCreate spools the share to a file before any JavaScript runs,
// so process death never loses it, then renders the "share" surface on the app's one ReactHost with the
// spool's id. It ends with no transition, back in the sender's task (flow decision 39).
class ShareActivity : ReactActivity() {
  private var spoolId: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    spoolId = savedInstanceState?.getString(SPOOL_KEY) ?: Spool.write(this, intent, referrer?.toString())
    spoolId?.let { live[it] = WeakReference(this) }
    super.onCreate(null)
  }

  override fun onDestroy() {
    spoolId?.let { if (live[it]?.get() === this) live.remove(it) }
    super.onDestroy()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putString(SPOOL_KEY, spoolId)
  }

  override fun getMainComponentName(): String = "share"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
      override fun getLaunchOptions(): Bundle = Bundle().apply { putString("spoolId", spoolId) }
    }

  /** Back to the sender with no transition; with a hash, open the Reader in Shelf as well. */
  fun close(readHash: String?) {
    if (readHash != null) {
      val open = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("kefli://reader/$readHash"))
        .setPackage(packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      startActivity(open)
    }
    finish()
    noTransition(this)
  }

  companion object {
    private const val SPOOL_KEY = "kefli.spoolId"

    /** The open sheets by spool id: several can be up at once, each in its own task, and each closes its own. */
    val live = mutableMapOf<String, WeakReference<ShareActivity>>()

    fun noTransition(activity: Activity) {
      if (Build.VERSION.SDK_INT >= 34) {
        activity.overrideActivityTransition(Activity.OVERRIDE_TRANSITION_CLOSE, 0, 0)
      } else {
        @Suppress("DEPRECATION")
        activity.overridePendingTransition(0, 0)
      }
    }
  }
}
