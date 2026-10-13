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
    AsyncFunction("readSecret") { pubkey: String -> KeyFile.readSecret(context, pubkey) }
    AsyncFunction("write") { json: String -> KeyFile.write(context, json) }
    AsyncFunction("wipe") { pubkey: String -> KeyFile.wipe(context, pubkey) }
    AsyncFunction("wipeAll") { KeyFile.wipeAll(context) }
    AsyncFunction("strongBox") { KeyFile.strongBox() }

    AsyncFunction("blockStoreGet") { promise: Promise -> BlockStore.get(context) { promise.settle(it) } }
    AsyncFunction("blockStoreSet") { mnemonic: String, promise: Promise -> BlockStore.set(context, mnemonic) { r -> promise.settle(r.map { mapOf("cloud" to it) }) } }
    // The launch check and rewrite (3.3, F22) take an identity's words from the key file, so they stay out of
    // JavaScript; an identity with no words checks as null and writes nothing.
    AsyncFunction("blockStoreCheck") { pubkey: String, promise: Promise ->
      val words = KeyFile.readMnemonic(context, pubkey) ?: return@AsyncFunction promise.resolve(null)
      BlockStore.check(context, words) { promise.resolve(it) }
    }
    AsyncFunction("blockStoreSetFrom") { pubkey: String, promise: Promise ->
      val words = KeyFile.readMnemonic(context, pubkey) ?: return@AsyncFunction promise.reject(CodedException("no words for this identity"))
      BlockStore.set(context, words) { r -> promise.settle(r.map { mapOf("cloud" to it) }) }
    }
    AsyncFunction("blockStoreRemove") { promise: Promise -> BlockStore.remove(context) { promise.settle(it.map { null }) } }
    AsyncFunction("isE2EEAvailable") { promise: Promise -> BlockStore.isE2EEAvailable(context) { promise.settle(it) } }
  }
}

private fun <T> Promise.settle(r: Result<T>) {
  r.fold({ resolve(it) }, { reject(CodedException(it)) })
}
