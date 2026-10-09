package app.kefli.share

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KefliShareModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }

  override fun definition() = ModuleDefinition {
    Name("KefliShare")

    Function("readSpool") { id: String -> Spool.read(context, id) }
    Function("deleteSpool") { id: String -> Spool.delete(context, id) }
    Function("listSpools") { Spool.list(context) }

    // finish('host') or finish('read', hash), from the share surface (mobile spec 8.5): the sheet of that spool,
    // or the current activity when it is a share sheet.
    Function("finish") { mode: String, hash: String?, spoolId: String? ->
      val activity = spoolId?.let { ShareActivity.live[it]?.get() } ?: appContext.currentActivity as? ShareActivity ?: return@Function false
      activity.runOnUiThread { activity.close(if (mode == "read") hash else null) }
      true
    }
  }
}
