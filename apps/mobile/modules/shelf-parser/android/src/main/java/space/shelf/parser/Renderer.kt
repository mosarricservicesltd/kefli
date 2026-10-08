package space.shelf.parser

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.Promise
import org.json.JSONObject
import org.json.JSONTokener

// A page that turns Shelf's own fetch away (a bot check answering 403) is loaded once in a browser engine, as a person's
// browser would load it (mobile spec 8.2, 7.1), and its rendered HTML handed back for the usual parse. The WebView is
// attached to no window, holds no bridge, has no file or content access and opens no windows; it follows only http(s)
// navigations, loads no images, and goes as soon as it answers. RULED: the HTML handed back has no scripts, styles,
// SVG, frames or embeds, and no style, data-, aria-, event, srcset or sizes attributes, none of which the parse reads
// (class and id stay, which Readability scores by); a page's own scripts can build it past the 5 MB cap otherwise. A challenge page is waited out until the page itself
// arrives or the time runs out. One page at a time; others queue behind it.
object Renderer {
  private const val TIMEOUT_MS = 20_000L
  /** A challenge that reloads itself is given this long after each finished load to move on. */
  private const val SETTLE_MS = 1_500L
  private val main = Handler(Looper.getMainLooper())

  private const val READ = """(function(){
    var d = document, t = d.title || '';
    var challenge = /just a moment|attention required|checking your browser/i.test(t)
      || !!d.querySelector('#challenge-form, #cf-challenge-running, script[src*="challenges.cloudflare.com"]');
    if (challenge || !d.documentElement) return JSON.stringify({ challenge: challenge, url: location.href, html: '' });
    var c = d.documentElement.cloneNode(true);
    c.querySelectorAll('script, style, link, svg, iframe, template, object, embed').forEach(function (n) { n.remove(); });
    c.querySelectorAll('*').forEach(function (n) {
      for (var i = n.attributes.length - 1; i >= 0; i--) {
        var a = n.attributes[i].name;
        if (a === 'style' || a === 'srcset' || a === 'sizes' || a.indexOf('data-') === 0 || a.indexOf('aria-') === 0 || a.indexOf('on') === 0) n.removeAttribute(a);
      }
    });
    return JSON.stringify({ challenge: false, url: location.href, html: '<!doctype html>' + c.outerHTML });
  })()"""

  private class Load(val url: String, val promise: Promise) {
    var view: WebView? = null
    var done = false
  }

  private var current: Load? = null
  private val queue = java.util.ArrayDeque<Load>()
  private lateinit var app: Context

  fun render(context: Context, url: String, promise: Promise) {
    main.post {
      app = context.applicationContext
      queue.add(Load(url, promise))
      next()
    }
  }

  private fun next() {
    if (current != null) return
    val load = queue.poll() ?: return
    current = load
    start(app, load)
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun start(context: Context, load: Load) {
    val view = try {
      WebView(context)
    } catch (e: Exception) {
      return finish(load, JSONObject().put("ok", false).put("reason", "no_webview"))
    }
    load.view = view
    // a phone-sized layout, so the page renders as it would on screen
    view.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY))
    view.layout(0, 0, 1080, 2400)
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
      javaScriptCanOpenWindowsAutomatically = false
      loadsImagesAutomatically = false
      blockNetworkImage = true
      mediaPlaybackRequiresUserGesture = true
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
        val scheme = request.url.scheme?.lowercase()
        return scheme != "https" && scheme != "http"
      }

      override fun onPageStarted(v: WebView, url: String, favicon: Bitmap?) {
        main.removeCallbacksAndMessages(load)
      }

      override fun onPageFinished(v: WebView, url: String) {
        if (load.done) return
        // a challenge navigates on by itself; the page is read once loads have settled
        main.removeCallbacksAndMessages(load)
        main.postAtTime({ read(load) }, load, android.os.SystemClock.uptimeMillis() + SETTLE_MS)
      }
    }
    main.postDelayed({ if (!load.done) finish(load, JSONObject().put("ok", false).put("reason", "timeout")) }, TIMEOUT_MS)
    view.loadUrl(load.url)
  }

  private fun read(load: Load) {
    val view = load.view ?: return
    if (load.done) return
    view.evaluateJavascript(READ) { raw ->
      if (load.done) return@evaluateJavascript
      val page = try {
        JSONObject(JSONTokener(raw).nextValue() as String)
      } catch (e: Exception) {
        return@evaluateJavascript
      }
      // still on the challenge: wait for its next load, or the timeout
      if (page.optBoolean("challenge")) return@evaluateJavascript
      finish(load, JSONObject().put("ok", true).put("url", page.optString("url", load.url)).put("html", page.optString("html")))
    }
  }

  private fun finish(load: Load, result: JSONObject) {
    if (load.done) return
    load.done = true
    main.removeCallbacksAndMessages(load)
    load.view?.apply {
      stopLoading()
      destroy()
    }
    load.view = null
    if (current === load) current = null
    load.promise.resolve(result.toString())
    next()
  }
}
