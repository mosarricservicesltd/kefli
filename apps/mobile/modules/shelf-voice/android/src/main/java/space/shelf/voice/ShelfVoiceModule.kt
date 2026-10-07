package space.shelf.voice

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

@UnstableApi
class ShelfVoiceModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "no React context" }
  private val main = Handler(Looper.getMainLooper())

  private val forward: (VoiceEngine.Event) -> Unit = { e ->
    when (e) {
      is VoiceEngine.Event.Word -> sendEvent("word", mapOf("hash" to e.hash, "word" to e.word))
      is VoiceEngine.Event.State -> sendEvent("state", mapOf("hash" to e.hash, "playing" to e.playing, "word" to e.word, "rate" to e.rate))
      is VoiceEngine.Event.Ended -> sendEvent("ended", mapOf("hash" to e.hash))
      is VoiceEngine.Event.Error -> sendEvent("error", mapOf("hash" to e.hash, "code" to e.code))
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ShelfVoice")
    Events("word", "state", "ended", "error")

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
          )
          context.startService(Intent(context, VoiceService::class.java))
          VoiceEngine.play()
          promise.resolve(null)
        }
      }
    }

    Function("play") { main.post { VoiceEngine.play() } }
    Function("pause") { main.post { VoiceEngine.pause() } }
    Function("skip") { seconds: Int -> main.post { VoiceEngine.skip(seconds) } }
    Function("jumpToWord") { word: Int -> main.post { VoiceEngine.jumpTo(word) } }
    Function("setRate") { rate: Double -> main.post { VoiceEngine.setRate(rate.toFloat()) } }
    Function("close") {
      main.post {
        VoiceEngine.close()
        context.stopService(Intent(context, VoiceService::class.java))
      }
    }
    AsyncFunction("probeSynthesis") { text: String, promise: Promise ->
      main.post { VoiceEngine.probeSynthesis(context, text) { promise.resolve(it) } }
    }
    // Week-0 probe: play the probe's WAV in this process, to see whether Android then routes media buttons here.
    Function("playProbe") {
      main.post {
        val f = java.io.File(context.cacheDir, "probe.wav")
        if (f.length() > 44) runCatching { android.media.MediaPlayer().apply {
          setAudioAttributes(android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
          setDataSource(f.path)
          setOnCompletionListener { it.release() }
          prepare()
          start()
        } }
      }
    }
    Function("readLog") { VoiceLog.read(context) }
    Function("clearLog") { VoiceLog.clear(context) }
  }
}
