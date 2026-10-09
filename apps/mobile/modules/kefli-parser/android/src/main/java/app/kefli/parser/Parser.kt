package app.kefli.parser

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.Promise
import org.json.JSONObject
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// The canonical parse in a WebView attached to no window (mobile spec 8.2), so it works the same from
// MainActivity, the share activity and a headless task. One job at a time; the WebView goes after 30 s idle.
object Parser {
  private const val BASE_URL = "https://parser.kefli.invalid/"
  private const val IDLE_MS = 30_000L
  private const val JOB_MS = 30_000L

  private class Job(val id: String, val input: String, val promise: Promise)

  private val main = Handler(Looper.getMainLooper())
  private val queue = ArrayDeque<Job>()
  private val inputs = ConcurrentHashMap<String, String>()
  private var current: Job? = null
  private var web: WebView? = null
  private var ready = false
  private val teardown = Runnable { destroy() }

  fun submit(context: Context, input: JSONObject, promise: Promise) {
    val job = Job(UUID.randomUUID().toString(), input.toString(), promise)
    main.post {
      queue.add(job)
      main.removeCallbacks(teardown)
      if (ensureWebView(context.applicationContext)) pump()
    }
  }

  private fun fail(job: Job, reason: String, message: String? = null) {
    val r = JSONObject().put("ok", false).put("reason", reason)
    if (message != null) r.put("message", message)
    job.promise.resolve(r.toString())
  }

  /** False, with every queued job answered no_webview, when the phone has no WebView provider. */
  @SuppressLint("SetJavaScriptEnabled")
  private fun ensureWebView(context: Context): Boolean {
    if (web != null) return true
    val view = try {
      WebView(context)
    } catch (e: Exception) {
      while (queue.isNotEmpty()) fail(queue.poll()!!, "no_webview", e.message)
      return false
    }
    view.settings.javaScriptEnabled = true
    view.settings.blockNetworkLoads = true
    view.settings.allowFileAccess = false
    view.settings.allowContentAccess = false
    view.addJavascriptInterface(Host, "KefliHost")
    view.webViewClient = object : WebViewClient() {
      override fun onPageFinished(v: WebView, url: String) {
        if (ready || v !== web) return
        val bundle = context.assets.open(ParserBundle.ASSET).bufferedReader().use { it.readText() }
        if (sha256(bundle) != ParserBundle.SHA256) {
          while (queue.isNotEmpty()) fail(queue.poll()!!, "error", "parser bundle does not match its sha256")
          destroy()
          return
        }
        v.evaluateJavascript(bundle) {
          ready = true
          pump()
        }
      }
    }
    web = view
    view.loadDataWithBaseURL(BASE_URL, "<!doctype html><meta charset=\"utf-8\"><title>parser</title>", "text/html", "utf-8", null)
    return true
  }

  private fun pump() {
    val view = web ?: return
    if (!ready || current != null) return
    val job = queue.poll() ?: run {
      main.postDelayed(teardown, IDLE_MS)
      return
    }
    current = job
    inputs[job.id] = job.input
    view.evaluateJavascript("kefliRun(${JSONObject.quote(job.id)})", null)
    main.postDelayed({ if (current === job) finish(job.id, null) }, JOB_MS)
  }

  private fun finish(id: String, output: String?) {
    val job = current ?: return
    if (job.id != id) return
    inputs.remove(id)
    current = null
    if (output == null) fail(job, "error", "parse timed out") else job.promise.resolve(output)
    pump()
  }

  private fun destroy() {
    web?.destroy()
    web = null
    ready = false
  }

  private fun sha256(s: String): String =
    MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

  // Called by the bundle on the WebView's binder thread.
  private object Host {
    @JavascriptInterface
    fun input(id: String): String = inputs[id] ?: "{}"

    @JavascriptInterface
    fun output(id: String, json: String) {
      main.post { finish(id, json) }
    }
  }
}
