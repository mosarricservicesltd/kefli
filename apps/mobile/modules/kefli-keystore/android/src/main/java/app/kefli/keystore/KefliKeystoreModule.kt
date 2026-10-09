package app.kefli.keystore

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// mobile spec 8.3: the key file (3.2) and Block Store (3.3).
class KefliKeystoreModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }

  override fun definition() = ModuleDefinition {
    Name("KefliKeystore")
    AsyncFunction("read") { KeyFile.read(context) }
    AsyncFunction("readMnemonic") { pubkey: String -> KeyFile.readMnemonic(context, pubkey) }
    AsyncFunction("write") { json: String -> KeyFile.write(context, json) }
    AsyncFunction("wipe") { pubkey: String -> KeyFile.wipe(context, pubkey) }
    AsyncFunction("strongBox") { KeyFile.strongBox() }

    AsyncFunction("blockStoreGet") { promise: Promise -> BlockStore.get(context) { promise.settle(it) } }
    AsyncFunction("blockStoreSet") { mnemonic: String, promise: Promise -> BlockStore.set(context, mnemonic) { r -> promise.settle(r.map { mapOf("cloud" to it) }) } }
    AsyncFunction("blockStoreRemove") { promise: Promise -> BlockStore.remove(context) { promise.settle(it.map { null }) } }
    AsyncFunction("isE2EEAvailable") { promise: Promise -> BlockStore.isE2EEAvailable(context) { promise.settle(it) } }
  }
}

private fun <T> Promise.settle(r: Result<T>) {
  r.fold({ resolve(it) }, { reject(CodedException(it)) })
}
