package app.kefli.parser

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class KefliParserModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }

  override fun definition() = ModuleDefinition {
    Name("KefliParser")

    // kefliParse: the page's bytes as fetched (base64), with their Content-Type. Resolves with JSON.
    AsyncFunction("parse") { body: String, contentType: String, url: String, promise: Promise ->
      Parser.submit(context, JSONObject().put("kind", "parse").put("body", body).put("contentType", contentType).put("url", url), promise)
    }

    // A page that turned Kefli's fetch away, loaded once in a browser engine: {ok, url, html} or {ok: false, reason}.
    AsyncFunction("render") { url: String, promise: Promise ->
      Renderer.render(context, url, promise)
    }

    // An Original view opened (true) or closed (false): a render's clear of the shared cookie jar waits while one is open.
    Function("holdJar") { on: Boolean ->
      Renderer.hold(on)
    }

    // kefliPdf: a PDF's bytes (base64) to its text runs, which packages/protocol lays out. Resolves with JSON.
    AsyncFunction("pdf") { body: String, promise: Promise ->
      Parser.submit(context, JSONObject().put("kind", "pdf").put("body", body), promise)
    }

    // kefliMarkdown: Readability's content HTML from an extension save.
    AsyncFunction("markdown") { html: String, url: String, promise: Promise ->
      Parser.submit(context, JSONObject().put("kind", "markdown").put("html", html).put("url", url), promise)
    }
  }
}
