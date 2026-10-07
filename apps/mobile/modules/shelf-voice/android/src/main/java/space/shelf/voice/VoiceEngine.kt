package space.shelf.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlin.math.roundToInt

// The phone's own voice reading an article (mobile spec 8.1, 5.7). One process-wide TextToSpeech; sentences
// are queued a few ahead, each utterance id "<index>:<character offset>", and onRangeStart becomes a word by
// binary search over the sentence's word starts. Everything here runs on the main looper.
object VoiceEngine {
  class Sentence(val text: String, val wordStarts: IntArray, val firstWord: Int)

  sealed class Event {
    data class Word(val hash: String, val word: Int) : Event()
    data class State(val hash: String, val playing: Boolean, val word: Int, val rate: Float) : Event()
    data class Ended(val hash: String) : Event()
    data class Error(val hash: String, val code: String) : Event()
  }

  private const val AHEAD = 2
  private val main = Handler(Looper.getMainLooper())
  private val listeners = mutableListOf<(Event) -> Unit>()

  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private val onReady = mutableListOf<() -> Unit>()
  private lateinit var app: Context

  var hash = ""; private set
  var title = ""; private set
  var site = ""; private set
  private var sentences: List<Sentence> = emptyList()
  var totalWords = 0; private set
  var wps = 3.9f; private set
  var rate = 1f; private set
  var word = 0; private set
  var playing = false; private set
  var ended = false; private set
  val loaded get() = sentences.isNotEmpty()

  // Sentences handed to the engine: [queuedFrom, queuedTo].
  private var queuedTo = -1
  private var generation = 0
  private var resumeOnGain = false

  fun addListener(l: (Event) -> Unit) = listeners.add(l)
  fun removeListener(l: (Event) -> Unit) = listeners.remove(l)
  private fun emit(e: Event) = listeners.toList().forEach { it(e) }
  private fun emitState() = emit(Event.State(hash, playing, word, rate))

  /** Seconds of reading at the current rate, by the app's clock (5.7). */
  fun durationMs(): Long = if (totalWords == 0) 0 else (totalWords / (wps * rate) * 1000).toLong()
  fun positionMs(): Long = (word / (wps * rate) * 1000).toLong()

  fun warmUp(context: Context, then: () -> Unit) {
    app = context.applicationContext
    if (ttsReady) return then()
    onReady.add(then)
    if (tts != null) return
    tts = TextToSpeech(app) { status ->
      main.post {
        ttsReady = status == TextToSpeech.SUCCESS
        if (!ttsReady) emit(Event.Error(hash, "tts_init"))
        configure()
        onReady.toList().forEach { it() }
        onReady.clear()
      }
    }
  }

  private val attributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  private fun configure() {
    val t = tts ?: return
    t.setAudioAttributes(attributes)
    t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(id: String) {}
      override fun onDone(id: String) { main.post { if (id.startsWith("probe")) probeDone() else done(id) } }
      @Deprecated("Deprecated in Java")
      override fun onError(id: String) { main.post { emit(Event.Error(hash, "tts_error")) } }
      override fun onRangeStart(id: String, start: Int, end: Int, frame: Int) {
        main.post { if (id.startsWith("probe")) probeRange(start, end, frame) else range(id, start) }
      }
    })
  }

  fun load(h: String, t: String, s: String, list: List<Sentence>, startWord: Int, total: Int, r: Float, wordsPerSecond: Float) {
    stopSpeech()
    hash = h; title = t; site = s; sentences = list; totalWords = total; rate = r; wps = wordsPerSecond
    word = startWord.coerceIn(0, maxOf(0, total - 1))
    ended = false
    playing = false
    emitState()
  }

  fun play() {
    if (!loaded || !ttsReady) return
    if (ended) { word = 0; ended = false }
    if (!requestFocus()) return
    playing = true
    registerNoisy()
    speakFrom(word)
    emitState()
  }

  fun pause() {
    if (!playing) return
    playing = false
    stopSpeech()
    unregisterNoisy()
    emitState()
  }

  /** ±15 s moves round(15 × wps × rate) words and restarts speech there, clamped at both ends (5.7). */
  fun skip(seconds: Int) = jumpTo(word + (seconds * wps * rate).roundToInt())

  fun jumpTo(target: Int) {
    if (!loaded) return
    word = target.coerceIn(0, totalWords - 1)
    ended = false
    if (playing) speakFrom(word)
    emit(Event.Word(hash, word))
    emitState()
  }

  fun setRate(r: Float) {
    rate = r
    tts?.setSpeechRate(r)
    if (playing) speakFrom(word)
    emitState()
  }

  fun close() {
    playing = false
    stopSpeech()
    unregisterNoisy()
    abandonFocus()
    sentences = emptyList()
    totalWords = 0
    emitState()
  }

  /** Called a minute after the last session closes: no second TextToSpeech ever competes (8.1). */
  fun release() {
    tts?.shutdown()
    tts = null
    ttsReady = false
  }

  private fun sentenceOf(w: Int): Int {
    var lo = 0
    var hi = sentences.size - 1
    while (lo < hi) {
      val mid = (lo + hi + 1) / 2
      if (sentences[mid].firstWord <= w) lo = mid else hi = mid - 1
    }
    return lo
  }

  private fun stopSpeech() {
    generation++
    tts?.stop()
    queuedTo = -1
  }

  private fun speakFrom(w: Int) {
    stopSpeech()
    val si = sentenceOf(w)
    val s = sentences[si]
    val offset = s.wordStarts[(w - s.firstWord).coerceIn(0, s.wordStarts.size - 1)]
    enqueue(si, offset, TextToSpeech.QUEUE_FLUSH)
    for (i in 1..AHEAD) if (si + i < sentences.size) enqueue(si + i, 0, TextToSpeech.QUEUE_ADD)
  }

  private fun enqueue(si: Int, offset: Int, mode: Int) {
    val text = sentences[si].text.substring(offset)
    tts?.speak(text, mode, Bundle(), "$generation:$si:$offset")
    queuedTo = si
  }

  private fun parse(id: String): Triple<Int, Int, Int>? =
    id.split(':').takeIf { it.size == 3 }?.let { Triple(it[0].toInt(), it[1].toInt(), it[2].toInt()) }

  private fun range(id: String, start: Int) {
    val (gen, si, offset) = parse(id) ?: return
    if (gen != generation || !playing || si >= sentences.size) return
    val s = sentences[si]
    val char = offset + start
    var k = s.wordStarts.indexOfLast { it <= char }
    if (k < 0) k = 0
    val w = s.firstWord + k
    if (w != word) {
      word = w
      emit(Event.Word(hash, w))
    }
  }

  private fun done(id: String) {
    val (gen, si, _) = parse(id) ?: return
    if (gen != generation || !playing) return
    if (si >= sentences.size - 1) {
      playing = false
      ended = true
      word = 0
      unregisterNoisy()
      abandonFocus()
      emit(Event.Ended(hash))
      emitState()
      return
    }
    val next = queuedTo + 1
    if (next < sentences.size) enqueue(next, 0, TextToSpeech.QUEUE_ADD)
  }

  // Audio focus, manual (8.1): a loss or becoming noisy pauses; a transient loss resumes on regain.
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    main.post {
      when (change) {
        AudioManager.AUDIOFOCUS_LOSS -> { resumeOnGain = false; pause() }
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
          resumeOnGain = playing
          pause()
        }
        AudioManager.AUDIOFOCUS_GAIN -> if (resumeOnGain) { resumeOnGain = false; play() }
      }
    }
  }
  private var focusRequest: AudioFocusRequest? = null

  private fun requestFocus(): Boolean {
    val am = app.getSystemService(AudioManager::class.java)
    val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(attributes)
      .setOnAudioFocusChangeListener(focusListener, main)
      .build().also { focusRequest = it }
    return am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() {
    focusRequest?.let { app.getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
  }

  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { pause() }
  }
  private var noisyRegistered = false

  private fun registerNoisy() {
    if (noisyRegistered) return
    app.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), Context.RECEIVER_NOT_EXPORTED)
    noisyRegistered = true
  }

  private fun unregisterNoisy() {
    if (!noisyRegistered) return
    app.unregisterReceiver(noisy)
    noisyRegistered = false
  }

  // The week-0 probe: does the engine report word positions when it writes speech to a file, rather than
  // speaking it? If so, Shelf can play the audio itself, which Android needs before it routes headphone and
  // car buttons to Shelf's session (08-week0-gates.md).
  private var probe: ((String) -> Unit)? = null
  private var probeStarted = 0L
  private var probeFile: java.io.File? = null
  private val probeRanges = org.json.JSONArray()

  fun probeSynthesis(context: Context, text: String, then: (String) -> Unit) {
    warmUp(context) {
      val file = java.io.File(app.cacheDir, "probe.wav").apply { delete() }
      probe = then
      probeFile = file
      while (probeRanges.length() > 0) probeRanges.remove(0)
      probeStarted = android.os.SystemClock.elapsedRealtime()
      tts?.synthesizeToFile(text, Bundle(), file, "probe")
    }
  }

  private fun probeRange(start: Int, end: Int, frame: Int) {
    probeRanges.put(org.json.JSONObject().put("start", start).put("end", end).put("frame", frame)
      .put("ms", android.os.SystemClock.elapsedRealtime() - probeStarted))
  }

  private fun probeDone() {
    val f = probeFile ?: return
    val bytes = f.length()
    // A canonical WAV header: sample rate at byte 24, bits per sample at 34, channels at 22.
    val head = ByteArray(44).also { b -> f.inputStream().use { it.read(b) } }
    fun le(i: Int, n: Int) = (0 until n).fold(0) { acc, k -> acc or ((head[i + k].toInt() and 0xff) shl (8 * k)) }
    val rate = le(24, 4)
    val bits = le(34, 2)
    val channels = le(22, 2)
    val audioMs = if (rate > 0 && bits > 0 && channels > 0) (bytes - 44) * 1000 / (rate.toLong() * channels * bits / 8) else -1
    val out = org.json.JSONObject()
      .put("synthMs", android.os.SystemClock.elapsedRealtime() - probeStarted)
      .put("bytes", bytes).put("sampleRate", rate).put("bits", bits).put("channels", channels).put("audioMs", audioMs)
      .put("ranges", probeRanges)
    probe?.invoke(out.toString())
    probe = null
  }
}
