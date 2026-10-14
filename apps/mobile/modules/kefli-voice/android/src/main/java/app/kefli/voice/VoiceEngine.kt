package app.kefli.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
import java.io.File
import kotlin.math.roundToInt

// The phone's own voice reading an article (mobile spec 8.1, 5.7), in Kefli's own audio. The engine writes each
// sentence to a file a few ahead (synthesizeToFile), reporting each word's frame; Kefli plays the files through
// one AudioTrack in its own process, so Android routes media buttons, the car and Bluetooth to Kefli's session
// (week-0 gate), and the word is read from the playback head. An engine that reports no word ranges makes the
// sentence the unit (FD 91 (h)). Everything here runs on the main looper except the audio writes.
object VoiceEngine {
  class Sentence(val text: String, val wordStarts: IntArray, val firstWord: Int)

  sealed class Event {
    data class Word(val hash: String, val word: Int) : Event()
    data class SentenceStart(val hash: String, val index: Int) : Event()
    data class State(val hash: String, val playing: Boolean, val word: Int, val rate: Float, val wordTiming: Boolean, val wps: Float) : Event()
    data class Ended(val hash: String) : Event()
    data class Error(val hash: String, val code: String) : Event()
  }

  /**
   * Audio kept written ahead of the playback head. By time, not by sentences: each file costs the engine a fixed
   * start, so a run of one-word blocks ("Website", "Yes") written two at a time starved the track.
   */
  private const val AHEAD_MS = 10_000L
  private const val POLL_MS = 40L
  private val main = Handler(Looper.getMainLooper())
  private val listeners = mutableListOf<(Event) -> Unit>()

  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private val onReady = mutableListOf<() -> Unit>()
  private lateinit var app: Context

  var hash = ""; private set
  var title = ""; private set
  var site = ""; private set
  /** The 512 px cover the lock screen shows (6.4), as PNG bytes, or null. */
  var artwork: ByteArray? = null; private set
  private var sentences: List<Sentence> = emptyList()
  var totalWords = 0; private set
  var wps = 3.9f; private set
  var rate = 1f; private set
  var word = 0; private set
  var playing = false; private set
  var ended = false; private set
  var wordTiming = true; private set
  val loaded get() = sentences.isNotEmpty()

  // One run of audio from a start word: its generation, what's written, and the track playing it.
  @Volatile private var generation = 0
  private var track: AudioTrack? = null
  private val segments = ArrayList<Segment>()
  private var framesWritten = 0L
  private var nextSentence = 0
  /**
   * Where in nextSentence its next file starts: at the run's first word, in the run's first sentence; past the last
   * piece, in one written in pieces (Pieces); else 0.
   */
  private var nextOffset = 0
  private var synthesizing: Synth? = null
  /** Audio must be written again from `word` before it plays (after a pause, or a jump or a rate change). */
  private var stale = true
  private var lastSentenceEvent = -1
  private val order = RangeOrder()
  private val writerThread = HandlerThread("kefli-voice-audio").apply { start() }
  private val writer = Handler(writerThread.looper)
  private var resumeOnGain = false

  private class Synth(val id: String, val gen: Int, val sentence: Int, val offset: Int, val text: String, val file: File) {
    val ranges = ArrayList<IntArray>()
  }

  fun addListener(l: (Event) -> Unit) = listeners.add(l)
  fun removeListener(l: (Event) -> Unit) = listeners.remove(l)
  private fun emit(e: Event) = listeners.toList().forEach { it(e) }
  private fun emitState() = emit(Event.State(hash, playing, word, rate, wordTiming, wps))

  /**
   * The engine's rate for a speed step (FD 107). Google's voice doesn't scale with its rate: asked for 2 it read at
   * about 1.65 times its 1x speed, so 2x asks for 2.1, which the Pixel heard at 2x (11 October 2026). Asked for less
   * than 0.5 it reads no slower than about 0.6x, so 0.5x passes through as it is, with the other steps.
   */
  private fun speechRate(r: Float): Float = if (r >= 1.99f) SPEECH_RATE_2X else r
  private const val SPEECH_RATE_2X = 2.1f

  /** Seconds of reading at the current rate, by the app's clock (5.7). */
  fun durationMs(): Long = if (totalWords == 0) 0 else (totalWords / (wps * rate) * 1000).toLong()
  fun positionMs(): Long = (word / (wps * rate) * 1000).toLong()

  private val attributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  fun warmUp(context: Context, then: () -> Unit) {
    app = context.applicationContext
    main.removeCallbacks(idleRelease)
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

  private fun configure() {
    val t = tts ?: return
    t.setSpeechRate(speechRate(rate))
    t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(id: String) {}
      override fun onDone(id: String) { main.post { if (id.startsWith(SAMPLE)) sampleEnded(id) else written(id) } }
      @Deprecated("Deprecated in Java")
      override fun onError(id: String) { main.post { if (id.startsWith(SAMPLE)) sampleEnded(id) else failed(id) } }
      override fun onError(id: String, code: Int) { main.post { if (id.startsWith(SAMPLE)) sampleEnded(id) else failed(id) } }
      override fun onStop(id: String, interrupted: Boolean) { main.post { if (id.startsWith(SAMPLE)) sampleEnded(id) } }
      override fun onRangeStart(id: String, a: Int, b: Int, c: Int) { main.post { range(id, a, b, c) } }
    })
  }

  fun load(h: String, t: String, s: String, list: List<Sentence>, startWord: Int, total: Int, r: Float, wordsPerSecond: Float, art: ByteArray? = null, voiceId: String? = null, lang: String? = null) {
    reset()
    hash = h; title = t; site = s; sentences = list; totalWords = total; rate = r; wps = wordsPerSecond; artwork = art
    useVoice(voiceId, lang)
    tts?.setSpeechRate(speechRate(r))
    word = startWord.coerceIn(0, maxOf(0, total - 1))
    ended = false
    playing = false
    stale = true
    emitState()
  }

  fun play() {
    if (!loaded || !ttsReady) return
    if (ended) { word = 0; ended = false; stale = true }
    if (!requestFocus()) return
    playing = true
    registerNoisy()
    if (stale) startFrom(word) else track?.play()
    main.removeCallbacks(poll)
    main.post(poll)
    emitState()
  }

  /**
   * Pausing drops the audio, and play writes it again from the word reached, as a skip does. A paused track cuts
   * the writer's blocking write short, so the rest of that sentence was lost while counted as written; the engine
   * then wrote nothing more, and Android never restarts a resumed stream track whose buffer isn't full, so play
   * after pause stayed silent (the rename's device checks, 9 October 2026).
   */
  fun pause() {
    if (!playing) return
    playing = false
    reset()
    stale = true
    unregisterNoisy()
    emitState()
  }

  /** ±15 s moves round(15 × wps × rate) words and restarts the audio there, clamped at both ends (5.7). */
  fun skip(seconds: Int) = jumpTo(word + (seconds * wps * rate).roundToInt())

  fun jumpTo(target: Int) {
    if (!loaded) return
    word = target.coerceIn(0, totalWords - 1)
    ended = false
    if (playing) startFrom(word) else { reset(); stale = true }
    emit(Event.Word(hash, word))
    emitState()
  }

  /**
   * A new rate is written fresh from the word reached; the voice keeps its pitch. The words a second come with it,
   * since a voice's speed doesn't scale with the rate (FD 107: Google's voice reads 2× at about 1.65× and 0.5× at
   * about 0.65×), so each rate keeps its own measure.
   */
  fun setRate(r: Float, wordsPerSecond: Float) {
    rate = r
    wps = wordsPerSecond
    tts?.setSpeechRate(speechRate(r))
    if (playing) startFrom(word) else { reset(); stale = true }
    emitState()
  }

  fun close() {
    playing = false
    reset()
    unregisterNoisy()
    abandonFocus()
    sentences = emptyList()
    totalWords = 0
    emitState()
    main.removeCallbacks(idleRelease)
    main.postDelayed(idleRelease, 60_000)
  }

  /** The phone's voices that work offline and are installed (FD 24): id, BCP 47 locale, and the locale's name. */
  fun voices(): List<Voice> = runCatching { tts?.voices?.toList() }.getOrNull().orEmpty()
    .filter { !it.isNetworkConnectionRequired && TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features }
    .sortedBy { it.name }

  /** The engine's own voice, whose language stands in before any article has been played. */
  fun defaultLocale(): String? = runCatching { tts?.defaultVoice?.locale?.toLanguageTag() }.getOrNull()

  /** The chosen voice when it is installed, else the phone's voice for the article's language. */
  private fun useVoice(voiceId: String?, lang: String?) {
    val t = tts ?: return
    val v = voiceId?.let { id -> voices().firstOrNull { it.name == id } }
    if (v != null) {
      t.voice = v
      android.util.Log.i("KefliVoice", "voice ${v.name}")
      return
    }
    val l = lang?.takeIf { it.isNotBlank() }?.let { Locale.forLanguageTag(it) } ?: return
    if (t.voice?.locale?.language != l.language) t.language = l
    android.util.Log.i("KefliVoice", "voice for ${l.toLanguageTag()}: ${t.voice?.name}")
  }

  private const val SAMPLE = "sample:"
  private var sampleDone: (() -> Unit)? = null
  private var sessionVoice: Voice? = null

  /**
   * A voice's sample, outside the session (5.8). RULED: it pauses an article that is playing, since one engine
   * speaks at a time; the article's audio is written again from its word when it next plays.
   */
  fun sample(voiceId: String, text: String, done: () -> Unit) {
    val t = tts ?: return done()
    val v = voices().firstOrNull { it.name == voiceId } ?: return done()
    sampleDone?.invoke()
    pause()
    if (sessionVoice == null) sessionVoice = t.voice
    sampleDone = done
    t.voice = v
    t.setSpeechRate(1f)
    val id = "$SAMPLE${System.nanoTime()}"
    if (t.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id) != TextToSpeech.SUCCESS) sampleEnded(id)
  }

  private fun sampleEnded(@Suppress("UNUSED_PARAMETER") id: String) {
    val t = tts
    sessionVoice?.let { t?.voice = it }
    sessionVoice = null
    t?.setSpeechRate(speechRate(rate))
    val d = sampleDone
    sampleDone = null
    d?.invoke()
  }

  /** A minute after the last session closes the engine goes, so no second TextToSpeech ever competes (8.1). */
  private val idleRelease = Runnable { release() }

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

  /** Drops the audio written so far and anything being written. */
  private fun reset() {
    generation++
    tts?.stop()
    synthesizing?.file?.delete()
    synthesizing = null
    track?.let { t -> runCatching { t.pause(); t.flush(); t.release() } }
    track = null
    segments.clear()
    framesWritten = 0
    lastSentenceEvent = -1
    main.removeCallbacks(poll)
    voiceDir().listFiles()?.forEach { it.delete() }
  }

  private fun voiceDir() = File(app.cacheDir, "voice").apply { mkdirs() }

  private fun startFrom(w: Int) {
    reset()
    stale = false
    val si = sentenceOf(w)
    val s = sentences[si]
    nextSentence = si
    nextOffset = s.wordStarts[(w - s.firstWord).coerceIn(0, s.wordStarts.size - 1)]
    writeAhead()
    // reset() stopped the word's clock along with the old audio; a skip or a rate change while playing restarts it
    // here, or the word would stop following the voice (the battery hour, 7 October 2026)
    if (playing) {
      main.removeCallbacks(poll)
      main.post(poll)
    }
  }

  /** The segment playing now, by the track's head; -1 before the first is written. */
  private fun playingSegment(head: Long): Int {
    for (i in segments.indices.reversed()) if (segments[i].startFrame <= head) return i
    return -1
  }

  private fun head(): Long = track?.playbackHeadPosition?.toLong()?.and(0xFFFFFFFFL) ?: 0L

  private fun writeAhead() {
    if (synthesizing != null || nextSentence >= sentences.size || aheadEnough()) return
    val synth = nextPiece()
    synthesizing = synth
    if (tts?.synthesizeToFile(synth.text, Bundle(), synth.file, synth.id) != TextToSpeech.SUCCESS) {
      synthesizing = null
      emit(Event.Error(hash, "tts_synthesize"))
    }
  }

  /** Whether AHEAD_MS of audio is already written past the playback head. */
  private fun aheadEnough(): Boolean {
    val rate = segments.lastOrNull()?.sampleRate ?: 0
    return rate > 0 && (framesWritten - head()) * 1000 / rate >= AHEAD_MS
  }

  /**
   * The next file to write: the next sentence, from the run's first word in the first. One longer than the engine takes
   * at a time goes a piece at a time (Pieces), each a segment of the sentence from its own offset, so the voice speaks
   * all of it and the word still follows; the rest past the limit was dropped unheard.
   */
  private fun nextPiece(): Synth {
    val si = nextSentence
    val whole = sentences[si].text
    val offset = nextOffset.coerceIn(0, whole.length)
    val end = Pieces.end(whole, offset, TextToSpeech.getMaxSpeechInputLength() - 1)
    nextOffset = Pieces.next(whole, end)
    if (nextOffset >= whole.length) {
      nextSentence = si + 1
      nextOffset = 0
    }
    val id = "$hash:$generation:$si:$offset"
    return Synth(id, generation, si, offset, whole.substring(offset, end), File(voiceDir(), "$generation-$si-$offset.wav"))
  }

  private fun current(id: String): Synth? = synthesizing?.takeIf { it.id == id && it.gen == generation }

  private fun range(id: String, a: Int, b: Int, c: Int) {
    val s = current(id) ?: return
    val (char, frame) = order.read(a, b, c, s.text.length) ?: return
    s.ranges.add(intArrayOf(char, frame))
  }

  private fun failed(id: String) {
    val s = current(id) ?: return
    synthesizing = null
    s.file.delete()
    emit(Event.Error(hash, "tts_error"))
    writeAhead()
  }

  private fun written(id: String) {
    val s = current(id) ?: return
    synthesizing = null
    val pcm = Wav.read(s.file)
    s.file.delete()
    if (pcm == null || pcm.frames == 0) return writeAhead()
    val t = track ?: newTrack(pcm) ?: return emit(Event.Error(hash, "audio_track"))
    val ranges = s.ranges.sortedBy { it[1] }
    noteTiming(s, ranges)
    learn(ranges, pcm)
    segments.add(Segment(s.sentence, s.offset, framesWritten, pcm.frames.toLong(), pcm.sampleRate, ranges))
    framesWritten += pcm.frames
    feed(t, pcm)
    if (playing && t.playState != AudioTrack.PLAYSTATE_PLAYING) t.play()
    writeAhead()
  }

  /**
   * An engine that reports no word ranges makes the sentence the unit (FD 91 (h)), from then on. A piece inside one
   * long word (Pieces) holds no word start for the engine to report, so its having none says nothing of the engine.
   */
  private fun noteTiming(s: Synth, ranges: List<IntArray>) {
    val holdsAWordStart = Timing.startsWithin(sentences[s.sentence].wordStarts, s.offset, s.offset + s.text.length)
    if (ranges.isEmpty() && holdsAWordStart) wordTiming = false
  }

  /** A file's audio to the track, on the writer's thread, until it is all written or a newer run has begun. */
  private fun feed(t: AudioTrack, pcm: Pcm) {
    val gen = generation
    writer.post {
      var at = 0
      while (at < pcm.data.size && gen == generation) {
        val n = t.write(pcm.data, at, minOf(16_384, pcm.data.size - at))
        if (n <= 0) break
        at += n
      }
    }
  }

  private fun newTrack(pcm: Pcm): AudioTrack? {
    val channelMask = if (pcm.channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
    val encoding = if (pcm.bits == 8) AudioFormat.ENCODING_PCM_8BIT else AudioFormat.ENCODING_PCM_16BIT
    val min = AudioTrack.getMinBufferSize(pcm.sampleRate, channelMask, encoding)
    val t = runCatching {
      AudioTrack.Builder()
        .setAudioAttributes(attributes)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(pcm.sampleRate).setChannelMask(channelMask).setEncoding(encoding).build())
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(maxOf(min, pcm.sampleRate * pcm.frameBytes / 2))
        .build()
    }.getOrNull()
    track = t
    return t
  }

  /**
   * Words a second at rate 1 for this voice (5.7), as a moving average, measured between the first and last word's
   * frames: each file carries silence at both ends, which over a run of one-word blocks halved the estimate.
   */
  private fun learn(ranges: List<IntArray>, pcm: Pcm) {
    if (ranges.size < 5) return
    val seconds = (ranges.last()[1] - ranges.first()[1]).toFloat() / pcm.sampleRate
    if (seconds < 1f) return
    val measured = (ranges.size - 1) / seconds / rate
    if (measured in 1f..8f) wps = wps * 0.8f + measured * 0.2f
  }

  // While playing, the word follows the playback head; the article ends when the last sentence has played out.
  private val poll = object : Runnable {
    override fun run() {
      if (!playing) return
      val head = head()
      val i = playingSegment(head)
      if (i >= 0) {
        val seg = segments[i]
        val s = sentences[seg.sentence]
        val w = Timing.wordAt(seg, head - seg.startFrame, s.wordStarts, s.firstWord)
        if (seg.sentence != lastSentenceEvent) {
          lastSentenceEvent = seg.sentence
          emit(Event.SentenceStart(hash, seg.sentence))
        }
        if (w != word) {
          word = w
          emit(Event.Word(hash, w))
        }
        val allWritten = nextSentence >= sentences.size && synthesizing == null
        if (allWritten && head >= framesWritten) return finish()
      }
      writeAhead()
      main.postDelayed(this, POLL_MS)
    }
  }

  private fun finish() {
    playing = false
    ended = true
    word = 0
    reset()
    stale = true
    unregisterNoisy()
    abandonFocus()
    emit(Event.Ended(hash))
    emitState()
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
}
