package app.kefli.keystore

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

// The key file (mobile spec 3.2): {v:1, identities:[{pubkey, provider, sk?, mnemonic?, …}]} encrypted under a
// Keystore AES-256-GCM key, StrongBox-backed where available, with no user-authentication or unlocked-device
// requirement so signing works in the background and behind the lock screen. Stored as IV ‖ ciphertext ‖ tag in
// noBackupFilesDir/kefli/identity.bin, written atomically. A lost key or an undecryptable file is no identity; any
// other failure, such as a Keystore not ready just after boot, throws, so launch neither wipes the database nor
// a share writes a new identity over the file (F21).
object KeyFile {
  private const val ALIAS = "kefli.identity.v1"
  private const val STORE = "AndroidKeyStore"
  private const val IV = 12
  private const val TAG = 16

  /** What JavaScript reads only one at a time, through readMnemonic and readSecret (3.2, 7.1). */
  private val SECRETS = listOf("mnemonic", "sk", "client")

  private fun file(context: Context) = File(context.noBackupFilesDir, "kefli/identity.bin")

  private fun keyStore() = KeyStore.getInstance(STORE).apply { load(null) }

  private fun storedKey(): SecretKey? = keyStore().getKey(ALIAS, null) as? SecretKey

  private fun key(): SecretKey {
    storedKey()?.let { return it }
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
    val k = storedKey() ?: return false
    val info = SecretKeyFactory.getInstance(k.algorithm, STORE).getKeySpec(k, KeyInfo::class.java) as KeyInfo
    return if (Build.VERSION.SDK_INT >= 31) info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX else false
  }

  /**
   * The whole record, secrets included, or null for no identity: no file, no Keystore key, or a file that key can't
   * open. Reading never makes a key, so a key missing for a moment can't leave the file unreadable for good.
   */
  private fun load(context: Context): JSONObject? {
    val f = file(context)
    if (!f.exists()) return null
    val key = storedKey() ?: return null
    val bytes = f.readBytes()
    if (bytes.size < IV + TAG) return null
    return try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes, 0, IV))
      JSONObject(String(cipher.doFinal(bytes, IV, bytes.size - IV), Charsets.UTF_8))
    } catch (e: AEADBadTagException) {
      null
    } catch (e: KeyPermanentlyInvalidatedException) {
      null
    } catch (e: JSONException) {
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

  private fun identity(context: Context, pubkey: String): JSONObject? =
    load(context)?.let { r -> identities(r).firstOrNull { it.optString("pubkey") == pubkey } }

  /** The record with every secret left out: the mnemonics, the local keys and the bunker client keys (3.2, 7.1). */
  fun read(context: Context): String? {
    val r = load(context) ?: return null
    val out = JSONArray()
    identities(r).forEach { out.put(JSONObject(it.toString()).apply { SECRETS.forEach { s -> remove(s) } }) }
    return JSONObject().put("v", r.optInt("v", 1)).put("identities", out).toString()
  }

  fun readMnemonic(context: Context, pubkey: String): String? =
    identity(context, pubkey)?.optString("mnemonic")?.takeIf { it.isNotEmpty() }

  /** The key a signer for this identity is built from: a local identity's own, a bunker identity's client key. */
  fun readSecret(context: Context, pubkey: String): String? =
    identity(context, pubkey)?.let { i -> i.optString(if (i.optString("provider") == "nip46") "client" else "sk").takeIf { it.isNotEmpty() } }

  /**
   * Writes the record; an identity written without a secret keeps the one already stored for its pubkey and
   * provider, since read never returns them. A file that can't be read for now throws in load, so nothing stored is
   * dropped.
   */
  fun write(context: Context, json: String) {
    val next = JSONObject(json)
    val stored = load(context)?.let { identities(it).associateBy { i -> i.optString("pubkey") } } ?: emptyMap()
    identities(next).forEach { i ->
      val old = stored[i.optString("pubkey")]?.takeIf { it.optString("provider") == i.optString("provider") } ?: return@forEach
      SECRETS.forEach { s -> if (!i.has(s)) old.optString(s).takeIf { it.isNotEmpty() }?.let { i.put(s, it) } }
    }
    save(context, next)
  }

  /** Removes one identity; removing the last deletes the file and the Keystore key. */
  fun wipe(context: Context, pubkey: String) {
    val r = load(context) ?: return
    val left = JSONArray()
    identities(r).filter { it.optString("pubkey") != pubkey }.forEach { left.put(it) }
    if (left.length() == 0) wipeAll(context) else save(context, r.put("identities", left))
  }

  /**
   * Every identity at once (Delete my data, Sign out): the file goes without being opened, so a Keystore failing for
   * now can't keep it. A key the Keystore won't delete is left behind, with nothing left for it to open.
   */
  fun wipeAll(context: Context) {
    val f = file(context)
    File(f.parentFile, "identity.bin.tmp").delete()
    if (f.exists() && !f.delete()) throw IllegalStateException("could not delete the key file")
    try {
      keyStore().deleteEntry(ALIAS)
    } catch (e: Exception) {
      // the file it encrypted is gone
    }
  }
}
