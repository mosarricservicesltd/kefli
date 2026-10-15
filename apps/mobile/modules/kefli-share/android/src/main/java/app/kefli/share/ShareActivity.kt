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
// spool's id. Recreated, it opens on the same spool while that is still there, and spools the share again from
// its intent when it isn't. It ends with no transition, back in the sender's task (flow decision 39).
class ShareActivity : ReactActivity() {
  private var spoolId: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    spoolId = spool(savedInstanceState?.getString(SPOOL_KEY))
    spoolId?.let { live[it] = WeakReference(this) }
    super.onCreate(null)
  }

  /**
   * The spool this sheet opens on: the one it had before it was recreated, while that is still on disk or held in
   * memory, and otherwise the share spooled again from the intent, which the system keeps with its text. A share held
   * in memory for want of room to write it went with its process, and one the start-up pickup saved meanwhile is gone
   * from the disk: a sheet brought back after either opened on nothing and said That didn't save. Spooled again, the
   * first is saved, and the second is Already saved.
   */
  private fun spool(kept: String?): String =
    kept?.takeIf { Spool.has(this, it) } ?: Spool.write(this, intent, referrer?.toString())

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

  /** Back to the sender with no transition; with a hash, open the Reader in Kefli as well. */
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
