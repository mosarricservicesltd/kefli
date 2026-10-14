package app.kefli.keystore

import android.content.Context
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import com.google.android.gms.tasks.Task

// Block Store (mobile spec 3.3): one entry, kefli.mnemonic.v1, holding the active local identity's
// mnemonic. Written for device-to-device restore always, and with shouldBackupToCloud only while
// end-to-end encryption is available, checked at each write and, through check, at each launch (F22).
// Adapted from expo-block-store 1.0.0 (MIT, © its authors): the client calls and their bridging, cut to
// the one entry Kefli keeps.
object BlockStore {
  const val KEY = "kefli.mnemonic.v1"

  private fun client(context: Context) = Blockstore.getClient(context)

  fun get(context: Context, done: (Result<String?>) -> Unit) {
    val request = RetrieveBytesRequest.Builder().setKeys(listOf(KEY)).build()
    client(context).retrieveBytes(request).bridge(done) { r -> r.blockstoreDataMap[KEY]?.bytes?.toString(Charsets.UTF_8) }
  }

  fun isE2EEAvailable(context: Context, done: (Result<Boolean>) -> Unit) {
    client(context).isEndToEndEncryptionAvailable.bridge(done) { it == true }
  }

  /** Stores the mnemonic; returns whether it may also go to the cloud backup. */
  fun set(context: Context, mnemonic: String, done: (Result<Boolean>) -> Unit) {
    isE2EEAvailable(context) { e2ee ->
      val cloud = e2ee.getOrDefault(false)
      val data = StoreBytesData.Builder().setKey(KEY).setBytes(mnemonic.toByteArray(Charsets.UTF_8)).setShouldBackupToCloud(cloud).build()
      client(context).storeBytes(data).bridge(done) { cloud }
    }
  }

  /**
   * How the entry stands against a mnemonic, without the words reaching JavaScript: entry is "empty", "same" or
   * "other", or null when the read failed; e2ee is null when that check failed.
   */
  fun check(context: Context, mnemonic: String, done: (Map<String, Any?>) -> Unit) {
    get(context) { entry ->
      val state = entry.fold({ if (it == null) "empty" else if (it == mnemonic) "same" else "other" }, { null })
      isE2EEAvailable(context) { e2ee -> done(mapOf("entry" to state, "e2ee" to e2ee.getOrNull())) }
    }
  }

  fun remove(context: Context, done: (Result<Boolean>) -> Unit) {
    val request = DeleteBytesRequest.Builder().setKeys(listOf(KEY)).build()
    client(context).deleteBytes(request).bridge(done) { it == true }
  }

  private fun <T, R> Task<T>.bridge(done: (Result<R>) -> Unit, map: (T) -> R) {
    addOnSuccessListener { done(runCatching { map(it) }) }
    addOnFailureListener { done(Result.failure(it)) }
  }
}
