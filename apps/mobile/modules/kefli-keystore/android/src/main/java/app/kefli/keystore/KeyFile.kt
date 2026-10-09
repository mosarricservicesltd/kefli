package app.kefli.keystore

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

// The key file (mobile spec 3.2): {v:1, identities:[{pubkey, provider, sk?, mnemonic?, …}]} encrypted under a
// Keystore AES-256-GCM key, StrongBox-backed where available, with no user-authentication or unlocked-device
// requirement so signing works in the background and behind the lock screen. Stored as IV ‖ ciphertext ‖ tag in
// noBackupFilesDir/kefli/identity.bin, written atomically. A lost key or an undecryptable file is no identity.
object KeyFile {
  private const val ALIAS = "kefli.identity.v1"
  private const val STORE = "AndroidKeyStore"

  private fun file(context: Context) = File(context.noBackupFilesDir, "kefli/identity.bin")

  private fun keyStore() = KeyStore.getInstance(STORE).apply { load(null) }

  private fun key(): SecretKey {
    (keyStore().getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return try {
      generate(strongBox = Build.VERSION.SDK_INT >= 28)
    } catch (e: StrongBoxUnavailableException) {
      generate(strongBox = false)
    }
  }

  private fun generate(strongBox: Boolean): SecretKey {
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(false)
      .apply { if (Build.VERSION.SDK_INT >= 28) { setUnlockedDeviceRequired(false); setIsStrongBoxBacked(strongBox) } }
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE).apply { init(spec) }.generateKey()
  }

  fun strongBox(): Boolean {
    val k = (keyStore().getKey(ALIAS, null) as? SecretKey) ?: return false
    val info = SecretKeyFactory.getInstance(k.algorithm, STORE).getKeySpec(k, KeyInfo::class.java) as KeyInfo
    return if (Build.VERSION.SDK_INT >= 31) info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX else false
  }

  /** The whole record, mnemonics included, or null for no identity. */
  private fun load(context: Context): JSONObject? {
    val f = file(context)
    if (!f.exists()) return null
    return try {
      val bytes = f.readBytes()
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
      JSONObject(String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8))
    } catch (e: Exception) {
      null
    }
  }

  private fun save(context: Context, record: JSONObject) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val body = cipher.iv + cipher.doFinal(record.toString().toByteArray(Charsets.UTF_8))
    val f = file(context)
    f.parentFile?.mkdirs()
    val tmp = File(f.parentFile, "identity.bin.tmp")
    tmp.writeBytes(body)
    if (!tmp.renameTo(f)) throw IllegalStateException("could not write the key file")
  }

  private fun identities(r: JSONObject): List<JSONObject> = r.optJSONArray("identities")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) } } ?: emptyList()

  /** The record with every mnemonic left out: only readMnemonic returns one (3.2). */
  fun read(context: Context): String? {
    val r = load(context) ?: return null
    val out = JSONArray()
    identities(r).forEach { out.put(JSONObject(it.toString()).apply { remove("mnemonic") }) }
    return JSONObject().put("v", r.optInt("v", 1)).put("identities", out).toString()
  }

  fun readMnemonic(context: Context, pubkey: String): String? =
    load(context)?.let { r -> identities(r).firstOrNull { it.optString("pubkey") == pubkey }?.optString("mnemonic")?.takeIf { it.isNotEmpty() } }

  /** Writes the record; an identity written without a mnemonic keeps the one already stored for its pubkey. */
  fun write(context: Context, json: String) {
    val next = JSONObject(json)
    val stored = load(context)?.let { identities(it).associateBy { i -> i.optString("pubkey") } } ?: emptyMap()
    identities(next).forEach { i ->
      if (!i.has("mnemonic")) stored[i.optString("pubkey")]?.optString("mnemonic")?.takeIf { it.isNotEmpty() }?.let { i.put("mnemonic", it) }
    }
    save(context, next)
  }

  /** Removes one identity; removing the last deletes the file and the Keystore key. */
  fun wipe(context: Context, pubkey: String) {
    val r = load(context) ?: return
    val left = JSONArray()
    identities(r).filter { it.optString("pubkey") != pubkey }.forEach { left.put(it) }
    if (left.length() == 0) {
      file(context).delete()
      keyStore().deleteEntry(ALIAS)
    } else {
      save(context, r.put("identities", left))
    }
  }
}
