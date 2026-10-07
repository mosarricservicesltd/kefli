package space.shelf.voice

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
import java.io.File
import kotlin.math.roundToInt

// The phone's own voice reading an article (mobile spec 8.1, 5.7), in Shelf's own audio. The engine writes each
// sentence to a file a few ahead (synthesizeToFile), reporting each word's frame; Shelf plays the files through
// one AudioTrack in its own process, so Android routes media buttons, the car and Bluetooth to Shelf's session
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
  private var firstOffset = 0
  private var firstSentence = 0
  private var synthesizing: Synth? = null
  /** Audio must be written again from `word` before it plays (after a jump or a rate change while paused). */
  private var stale = true
  private var lastSentenceEvent = -1
  private val order = RangeOrder()
  private val writerThread = HandlerThread("shelf-voice-audio").apply { start() }
  private val writer = Handler(writerThread.looper)
  private var resumeOnGain = false

  private class Synth(val gen: Int, val sentence: Int, val offset: Int, val text: String, val file: File) {
    val ranges = ArrayList<IntArray>()
  }

  fun addListener(l: (Event) -> Unit) = listeners.add(l)
  fun removeListener(l: (Event) -> Unit) = listeners.remove(l)
  private fun emit(e: Event) = listeners.toList().forEach { it(e) }
  private fun emitState() = emit(Event.State(hash, playing, word, rate, wordTiming, wps))

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
    t.setSpeechRate(rate)
    t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(id: String) {}
      override fun onDone(id: String) { main.post { written(id) } }
      @Deprecated("Deprecated in Java")
      override fun onError(id: String) { main.post { failed(id) } }
      override fun onError(id: String, code: Int) { main.post { failed(id) } }
      override fun onRangeStart(id: String, a: Int, b: Int, c: Int) { main.post { range(id, a, b, c) } }
    })
  }

  fun load(h: String, t: String, s: String, list: List<Sentence>, startWord: Int, total: Int, r: Float, wordsPerSecond: Float, art: ByteArray? = null) {
    reset()
    hash = h; title = t; site = s; sentences = list; totalWords = total; rate = r; wps = wordsPerSecond; artwork = art
    tts?.setSpeechRate(r)
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

  fun pause() {
    if (!playing) return
    playing = false
    track?.pause()
    main.removeCallbacks(poll)
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

  /** A new rate is written fresh from the word reached; the voice keeps its pitch. */
  fun setRate(r: Float) {
    rate = r
    tts?.setSpeechRate(r)
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
    firstSentence = si
    firstOffset = s.wordStarts[(w - s.firstWord).coerceIn(0, s.wordStarts.size - 1)]
    nextSentence = si
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
    if (synthesizing != null || nextSentence >= sentences.size) return
    val rate = segments.lastOrNull()?.sampleRate ?: 0
    if (rate > 0 && (framesWritten - head()) * 1000 / rate >= AHEAD_MS) return
    val si = nextSentence++
    val offset = if (si == firstSentence) firstOffset else 0
    val max = TextToSpeech.getMaxSpeechInputLength() - 1
    val text = sentences[si].text.substring(offset).let { if (it.length > max) it.substring(0, max) else it }
    val file = File(voiceDir(), "$generation-$si.wav")
    val synth = Synth(generation, si, offset, text, file)
    synthesizing = synth
    val id = "$hash:$generation:$si"
    if (tts?.synthesizeToFile(text, Bundle(), file, id) != TextToSpeech.SUCCESS) {
      synthesizing = null
      emit(Event.Error(hash, "tts_synthesize"))
    }
  }

  private fun current(id: String): Synth? = synthesizing?.takeIf { "$hash:${it.gen}:${it.sentence}" == id && it.gen == generation }

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
    if (ranges.isEmpty()) wordTiming = false
    learn(ranges, pcm)
    segments.add(Segment(s.sentence, s.offset, framesWritten, pcm.frames.toLong(), pcm.sampleRate, ranges))
    framesWritten += pcm.frames
    val gen = generation
    writer.post {
      var at = 0
      while (at < pcm.data.size && gen == generation) {
        val n = t.write(pcm.data, at, minOf(16_384, pcm.data.size - at))
        if (n <= 0) break
        at += n
      }
    }
    if (playing && t.playState != AudioTrack.PLAYSTATE_PLAYING) t.play()
    writeAhead()
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
