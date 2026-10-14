package app.kefli.parser

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
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
// A PDF job (contract 4.2, PDFs) asks for pdf.js through KefliHost.asset, so it loads only when a PDF comes.
//
// A hostile page can stop the WebView where a time limit alone can't: Readability over a pathological page, or a
// regular expression a page drives into backtracking, holds the renderer's one thread for minutes after the job's
// time is up, and every WebView in the app shares that renderer, so every later parse timed out behind it; a page or
// a PDF can use up the renderer's memory, and a renderer that goes without onRenderProcessGone handled takes the app
// with it, at every sync while the save waits. So: a renderer that goes answers its job and the rest get a new
// WebView; a job past its time leaves its WebView, and a WebView that then doesn't answer a trivial script has its
// renderer ended (Android 10 and later); a WebView that never loads the bundle answers the jobs waiting on it.
object Parser {
  private const val BASE_URL = "https://parser.kefli.invalid/"
  private const val IDLE_MS = 30_000L
  private const val JOB_MS = 30_000L
  private const val PDF_JOB_MS = 90_000L
  /** How long a new WebView has to load the bundle before the jobs waiting on it are answered, to be tried again. */
  private const val READY_MS = 20_000L
  /** How long a WebView whose job ran out of time has to answer a trivial script before its renderer is taken as stuck. */
  private const val PROBE_MS = 2_000L
  /** How long a renderer being ended has to report itself gone before the next WebView is made anyway. */
  private const val END_MS = 3_000L

  private class Job(val id: String, val input: String, val promise: Promise, val timeoutMs: Long)

  private val main = Handler(Looper.getMainLooper())
  private val queue = ArrayDeque<Job>()
  private val inputs = ConcurrentHashMap<String, String>()
  private var current: Job? = null
  private var web: WebView? = null
  private var ready = false
  /** The WebView whose renderer is being ended after its job ran out of time; the next waits until it has gone. */
  private var ending: WebView? = null
  private val teardown = Runnable { destroy() }
  private val notReady = Runnable { if (web != null && !ready) neverLoaded() }
  private var app: Context? = null
  private var assets: android.content.res.AssetManager? = null
  private val pdfAssets = ConcurrentHashMap<String, String>()

  fun submit(context: Context, input: JSONObject, promise: Promise) {
    app = context.applicationContext
    assets = context.applicationContext.assets
    val timeout = if (input.optString("kind") == "pdf") PDF_JOB_MS else JOB_MS
    val job = Job(UUID.randomUUID().toString(), input.toString(), promise, timeout)
    main.post {
      queue.add(job)
      main.removeCallbacks(teardown)
      if (ensureWebView()) pump()
    }
  }

  private fun fail(job: Job, reason: String, message: String? = null) {
    val r = JSONObject().put("ok", false).put("reason", reason)
    if (message != null) r.put("message", message)
    job.promise.resolve(r.toString())
  }

  private fun failQueued(reason: String, message: String?) {
    while (queue.isNotEmpty()) fail(queue.poll()!!, reason, message)
  }

  /** False, with every queued job answered no_webview, when the phone has no WebView provider. */
  @SuppressLint("SetJavaScriptEnabled")
  private fun ensureWebView(): Boolean {
    if (web != null) return true
    val context = app ?: return false
    val view = try {
      WebView(context)
    } catch (e: Exception) {
      failQueued("no_webview", e.message)
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
          failQueued("error", "parser bundle does not match its sha256")
          destroy()
          return
        }
        v.evaluateJavascript(bundle) {
          if (v !== web) return@evaluateJavascript
          main.removeCallbacks(notReady)
          ready = true
          pump()
        }
      }

      override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (v === ending) ended() else if (v === web) gone(detail.didCrash())
        return true
      }
    }
    web = view
    main.postDelayed(notReady, READY_MS)
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
    main.postDelayed({ if (current === job) timedOut(job) }, job.timeoutMs)
  }

  private fun finish(id: String, output: String?) {
    val job = current ?: return
    if (job.id != id) return
    inputs.remove(id)
    current = null
    if (output == null) fail(job, "error", "parse timed out") else job.promise.resolve(output)
    pump()
  }

  /**
   * A job past its time, answered as one that timed out (a page that can't be read). Nothing more runs on its
   * WebView, which goes once it has had PROBE_MS to answer a trivial script: one that doesn't is still held by the
   * page, and so is the renderer every WebView shares, which is ended so the next WebView gets a new one.
   */
  private fun timedOut(job: Job) {
    val view = web
    ready = false
    finish(job.id, null)
    if (view == null) return
    var answered = false
    view.evaluateJavascript("1") { answered = true }
    main.postDelayed({
      if (web !== view) {
        // already gone: its renderer went, and the jobs behind it have a new WebView
      } else if (answered || !end(view)) {
        renew()
      } else {
        // the next WebView is made once the renderer has reported itself gone, so it doesn't land on the one being
        // ended; END_MS is the most that is waited
        ending = view
        main.postDelayed({ if (ending === view) ended() }, END_MS)
      }
    }, PROBE_MS)
  }

  /**
   * Ends a renderer held by a page, true when it could: Android 10 and later, and a WebView in its own process. On
   * earlier versions it can't be ended, and its WebView just goes.
   */
  private fun end(view: WebView): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && view.webViewRenderProcess?.terminate() == true

  /** The renderer being ended has gone, or has had its time: the WebView goes, and a new one takes the queue. */
  private fun ended() {
    ending = null
    renew()
  }

  /** The WebView goes, and a new one is made for any job still waiting. */
  private fun renew() {
    destroy()
    if (queue.isNotEmpty() && ensureWebView()) pump()
  }

  /**
   * The renderer went. A crash is most likely the page's doing, and its job fails as a page that can't be read; a
   * renderer the system killed (for memory, often with Kefli in the background) leaves its job to be tried again later,
   * as a page that timed out is. The jobs behind it get a new WebView, unless this one went before it had loaded the
   * bundle: then they are answered to be tried again later, rather than WebViews being made and lost without end.
   */
  private fun gone(crashed: Boolean) {
    val job = current
    val loaded = ready
    current = null
    if (job != null) {
      inputs.remove(job.id)
      if (crashed) fail(job, "error", "the parser's renderer crashed") else fail(job, "renderer_gone")
    }
    if (loaded) {
      renew()
    } else {
      failQueued("renderer_gone", "the parser's renderer went before it loaded")
      destroy()
    }
  }

  /**
   * The bundle never loaded: the jobs waiting on this WebView are answered, to be tried again, and it goes. Its
   * renderer is left alone: one held by a page is ended by whichever WebView's time ran out with that page in it.
   */
  private fun neverLoaded() {
    failQueued("renderer_gone", "the parser did not load")
    destroy()
  }

  private fun destroy() {
    main.removeCallbacks(notReady)
    web?.destroy()
    web = null
    ready = false
    pdfAssets.clear()
  }

  private fun sha256(s: String): String =
    MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

  // Called by the bundle on the WebView's binder thread.
  private object Host {
    @JavascriptInterface
    fun input(id: String): String = inputs[id] ?: "{}"

    /** One of the PDF modules, read once and checked against its sha256; "" for any other name or a mismatch. */
    @JavascriptInterface
    fun asset(name: String): String {
      val want = ParserBundle.PDF_ASSETS[name] ?: return ""
      pdfAssets[name]?.let { return it }
      val body = assets?.open(name)?.bufferedReader()?.use { it.readText() } ?: return ""
      if (sha256(body) != want) return ""
      pdfAssets[name] = body
      return body
    }

    @JavascriptInterface
    fun output(id: String, json: String) {
      main.post { finish(id, json) }
    }
  }
}
