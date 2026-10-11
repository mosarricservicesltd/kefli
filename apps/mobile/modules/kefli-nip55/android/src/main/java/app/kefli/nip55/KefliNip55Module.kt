package app.kefli.nip55

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

// NIP-55 signer apps (mobile spec 8.4): Amber and compatible. Each call tries the signer's content resolver first,
// which answers without showing anything once the user has allowed the permission, and falls back to the
// nostrsigner: intent, which shows the signer's own screen. Errors: rejected, not_installed, timeout, unavailable.
// Payloads (events, plaintext, ciphertext) are never logged.
class KefliNip55Module : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }
  private val next = AtomicInteger(5500)
  private val pending = mutableMapOf<Int, Pair<String, Promise>>()

  private class Nip55Error(code: String) : CodedException(code, code, null)

  /** content://<pkg>.<TYPE>: the result column, or null when the signer wants its own screen; rejected throws. */
  private fun resolve(pkg: String, type: String, args: Array<String>): Pair<String?, String?>? {
    val r = resolveOnce(pkg, type, args)
    // the type and the route only: never a payload (8.4)
    Log.i("KefliNip55", "$type resolver ${if (r == null) "declined to answer" else "answered"}")
    return r
  }

  private fun resolveOnce(pkg: String, type: String, args: Array<String>): Pair<String?, String?>? {
    return try {
      val cursor = context.contentResolver.query(Uri.parse("content://$pkg.$type"), args, null, null, null)
      if (cursor == null) Log.i("KefliNip55", "$type resolver: no cursor")
      cursor?.use { c ->
        if (!c.moveToFirst() && c.getColumnIndex("rejected") < 0) Log.i("KefliNip55", "$type resolver: empty, columns ${c.columnNames.joinToString()}")
        if (c.getColumnIndex("rejected") >= 0) throw Nip55Error("rejected")
        if (!c.moveToFirst()) return null
        val r = c.getColumnIndex("result").takeIf { it >= 0 }?.let { c.getString(it) }
        val e = c.getColumnIndex("event").takeIf { it >= 0 }?.let { c.getString(it) }
        r to e
      }
    } catch (e: Nip55Error) {
      throw e
    } catch (e: Exception) {
      Log.i("KefliNip55", "$type resolver: ${e.javaClass.simpleName}")
      null
    }
  }

  private fun launch(promise: Promise, want: String, intent: Intent) {
    val activity = appContext.currentActivity
    Log.i("KefliNip55", "$want via the signer's screen${if (activity == null) ": no activity" else ""}")
    if (activity == null) return promise.reject(Nip55Error("unavailable"))
    val code = next.incrementAndGet()
    pending[code] = want to promise
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    try {
      activity.startActivityForResult(intent, code)
    } catch (e: Exception) {
      pending.remove(code)
      promise.reject(Nip55Error("not_installed"))
    }
  }

  private fun signerIntent(pkg: String?, content: String, type: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:${Uri.encode(content)}")).apply {
      pkg?.let { setPackage(it) }
      putExtra("type", type)
    }

  override fun definition() = ModuleDefinition {
    Name("KefliNip55")

    // Every app on the phone that answers nostrsigner:, by label.
    AsyncFunction("listSigners") {
      val pm = context.packageManager
      val found = pm.queryIntentActivities(Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:")), 0)
      found.map { mapOf("package" to it.activityInfo.packageName, "label" to it.loadLabel(pm).toString()) }.distinctBy { it["package"] }
    }

    // get_public_key with the standing permissions, through the signer's screen (Android's chooser when pkg is null).
    AsyncFunction("getPublicKey") { pkg: String?, permissions: String, promise: Promise ->
      val intent = signerIntent(pkg, "", "get_public_key").putExtra("permissions", permissions)
      launch(promise, "login", intent)
    }

    // the resolver takes the user's key as hex, the signer's screen as an npub (NIP-55)
    AsyncFunction("signEvent") { pkg: String, eventJson: String, hex: String, npub: String, promise: Promise ->
      val kind = try { JSONObject(eventJson).optInt("kind", -1) } catch (e: Exception) { -1 }
      Log.i("KefliNip55", "sign_event kind $kind")
      try {
        val r = resolve(pkg, "SIGN_EVENT", arrayOf(eventJson, "", hex))
        if (r?.second != null) return@AsyncFunction promise.resolve(r.second)
      } catch (e: Nip55Error) {
        return@AsyncFunction promise.reject(e)
      }
      launch(promise, "event", signerIntent(pkg, eventJson, "sign_event").putExtra("id", "kefli").putExtra("current_user", npub))
    }

    // Decision 104: whether the signer signs this event through its resolver alone, never its screen. The event is a
    // throwaway the caller never sends; only the answer matters.
    AsyncFunction("signInBackground") { pkg: String, eventJson: String, hex: String ->
      try {
        resolve(pkg, "SIGN_EVENT", arrayOf(eventJson, "", hex))?.second != null
      } catch (e: Exception) {
        false
      }
    }

    AsyncFunction("nip44Encrypt") { pkg: String, plaintext: String, peer: String, hex: String, npub: String, promise: Promise ->
      crypt(pkg, "NIP44_ENCRYPT", "nip44_encrypt", plaintext, peer, hex, npub, promise)
    }

    AsyncFunction("nip44Decrypt") { pkg: String, ciphertext: String, peer: String, hex: String, npub: String, promise: Promise ->
      crypt(pkg, "NIP44_DECRYPT", "nip44_decrypt", ciphertext, peer, hex, npub, promise)
    }

    // Whether the signer answers through its resolver, without its screen: then background drains can run (4.7).
    AsyncFunction("canActInBackground") { pkg: String, peer: String, hex: String ->
      try {
        resolve(pkg, "NIP44_ENCRYPT", arrayOf("kefli-probe", peer, hex))?.first != null
      } catch (e: Exception) {
        false
      }
    }

    OnActivityResult { _: Activity, payload ->
      val (want, promise) = pending.remove(payload.requestCode) ?: return@OnActivityResult
      Log.i("KefliNip55", "$want answered: ${if (payload.resultCode == Activity.RESULT_OK) "ok" else "not ok"}")
      val data = payload.data
      if (payload.resultCode != Activity.RESULT_OK || data == null) return@OnActivityResult promise.reject(Nip55Error("rejected"))
      when (want) {
        "login" -> {
          val pk = data.getStringExtra("result") ?: data.getStringExtra("signature")
          val pkg = data.getStringExtra("package")
          if (pk == null || pkg == null) promise.reject(Nip55Error("rejected"))
          else promise.resolve(mapOf("pubkey" to pk, "package" to pkg))
        }
        "event" -> data.getStringExtra("event")?.let { promise.resolve(it) } ?: promise.reject(Nip55Error("rejected"))
        else -> data.getStringExtra("result")?.let { promise.resolve(it) } ?: promise.reject(Nip55Error("rejected"))
      }
    }
  }

  private fun crypt(pkg: String, type: String, intentType: String, text: String, peer: String, hex: String, npub: String, promise: Promise) {
    try {
      val r = resolve(pkg, type, arrayOf(text, peer, hex))
      if (r?.first != null) return promise.resolve(r.first)
    } catch (e: Nip55Error) {
      return promise.reject(e)
    }
    launch(promise, "result", signerIntent(pkg, text, intentType).putExtra("pubkey", peer).putExtra("id", "kefli").putExtra("current_user", npub))
  }
}
