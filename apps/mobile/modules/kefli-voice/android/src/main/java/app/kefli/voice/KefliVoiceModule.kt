package app.kefli.voice

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

@UnstableApi
class KefliVoiceModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }
  private val main = Handler(Looper.getMainLooper())

  private val forward: (VoiceEngine.Event) -> Unit = { e ->
    when (e) {
      is VoiceEngine.Event.Word -> sendEvent("word", mapOf("hash" to e.hash, "word" to e.word))
      is VoiceEngine.Event.SentenceStart -> sendEvent("sentence", mapOf("hash" to e.hash, "index" to e.index))
      // the rate to two places: as a Float widened to a double, 1.2 reached JS as 1.2000000476837158 (FD 107)
      is VoiceEngine.Event.State -> sendEvent("state", mapOf("hash" to e.hash, "playing" to e.playing, "word" to e.word, "rate" to Math.round(e.rate * 100) / 100.0, "wordTiming" to e.wordTiming, "wps" to e.wps))
      is VoiceEngine.Event.Ended -> sendEvent("ended", mapOf("hash" to e.hash))
      is VoiceEngine.Event.Error -> sendEvent("error", mapOf("hash" to e.hash, "code" to e.code))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("KefliVoice")
    Events("word", "sentence", "state", "ended", "error")

    OnCreate { VoiceEngine.addListener(forward) }
    OnDestroy { VoiceEngine.removeListener(forward) }

    AsyncFunction("warmUp") { promise: Promise ->
      main.post { VoiceEngine.warmUp(context) { promise.resolve(null) } }
    }

    // The session as JSON: {hash, title, site, sentences: [{text, wordStarts, firstWord}], startWord, totalWords, rate, wps}.
    AsyncFunction("start") { json: String, promise: Promise ->
      main.post {
        val o = JSONObject(json)
        val arr = o.getJSONArray("sentences")
        val sentences = (0 until arr.length()).map { i ->
          val s = arr.getJSONObject(i)
          val starts = s.getJSONArray("wordStarts")
          VoiceEngine.Sentence(s.getString("text"), IntArray(starts.length()) { starts.getInt(it) }, s.getInt("firstWord"))
        }
        VoiceEngine.warmUp(context) {
          VoiceEngine.load(
            o.getString("hash"), o.getString("title"), o.optString("site"), sentences,
            o.getInt("startWord"), o.getInt("totalWords"), o.getDouble("rate").toFloat(), o.getDouble("wps").toFloat(),
            o.optString("artworkPath").takeIf { it.isNotEmpty() }?.let { path ->
              runCatching { java.io.File(android.net.Uri.parse(path).path ?: path).readBytes() }.getOrNull()
            },
            o.optString("voiceId").takeIf { it.isNotEmpty() },
            o.optString("lang").takeIf { it.isNotEmpty() },
          )
          context.startService(Intent(context, VoiceService::class.java))
          VoiceEngine.play()
          promise.resolve(null)
        }
      }
    }

    // The installed offline voices (FD 24, 8.1), and the engine's own voice's locale.
    AsyncFunction("listVoices") { promise: Promise ->
      main.post {
        VoiceEngine.warmUp(context) {
          val voices = VoiceEngine.voices().map {
            mapOf("id" to it.name, "locale" to it.locale.toLanguageTag(), "name" to it.locale.getDisplayName(java.util.Locale.getDefault()))
          }
          promise.resolve(mapOf("voices" to voices, "defaultLocale" to VoiceEngine.defaultLocale()))
        }
      }
    }

    // A short sample in one voice, resolved when it has been spoken or stopped.
    AsyncFunction("sample") { voiceId: String, text: String, promise: Promise ->
      main.post { VoiceEngine.warmUp(context) { VoiceEngine.sample(voiceId, text) { promise.resolve(null) } } }
    }

    Function("play") { main.post { VoiceEngine.play() } }
    Function("pause") { main.post { VoiceEngine.pause() } }
    Function("skip") { seconds: Int -> main.post { VoiceEngine.skip(seconds) } }
    Function("jumpToWord") { word: Int -> main.post { VoiceEngine.jumpTo(word) } }
    Function("setRate") { rate: Double, wps: Double -> main.post { VoiceEngine.setRate(rate.toFloat(), wps.toFloat()) } }
    Function("close") {
      main.post {
        VoiceEngine.close()
        context.stopService(Intent(context, VoiceService::class.java))
      }
    }
    Function("readLog") { VoiceLog.read(context) }
    Function("clearLog") { VoiceLog.clear(context) }
  }
}
