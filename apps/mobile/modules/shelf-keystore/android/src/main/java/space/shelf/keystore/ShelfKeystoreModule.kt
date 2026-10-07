package space.shelf.keystore

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// mobile spec 8.3: the key file now; Block Store (3.3) comes next.
class ShelfKeystoreModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }

  override fun definition() = ModuleDefinition {
    Name("ShelfKeystore")
    AsyncFunction("read") { KeyFile.read(context) }
    AsyncFunction("readMnemonic") { pubkey: String -> KeyFile.readMnemonic(context, pubkey) }
    AsyncFunction("write") { json: String -> KeyFile.write(context, json) }
    AsyncFunction("wipe") { pubkey: String -> KeyFile.wipe(context, pubkey) }
    AsyncFunction("strongBox") { KeyFile.strongBox() }
  }
}
