package space.shelf.share

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ShelfShareModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }

  override fun definition() = ModuleDefinition {
    Name("ShelfShare")

    Function("readSpool") { id: String -> Spool.read(context, id) }
    Function("deleteSpool") { id: String -> Spool.delete(context, id) }
    Function("listSpools") { Spool.list(context) }

    // finish('host') or finish('read', hash), from the share surface (mobile spec 8.5).
    Function("finish") { mode: String, hash: String? ->
      val activity = appContext.currentActivity as? ShareActivity ?: return@Function false
      activity.runOnUiThread { activity.close(if (mode == "read") hash else null) }
      true
    }
  }
}
