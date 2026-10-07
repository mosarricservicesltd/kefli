package space.shelf.voice

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// For the week-0 locked-on-battery gate: every 30 s while the service runs, one line with the word reached,
// whether it is speaking, the screen, Doze and the battery. Written to the app's external files, so it can be
// read after the phone has been unplugged.
object VoiceLog {
  private val main = Handler(Looper.getMainLooper())
  private var file: File? = null
  private lateinit var app: Context
  private val time = SimpleDateFormat("HH:mm:ss", Locale.UK)
  private val tick = object : Runnable {
    override fun run() {
      line("tick")
      main.postDelayed(this, 30_000)
    }
  }
  private val onEvent: (VoiceEngine.Event) -> Unit = { e -> if (e !is VoiceEngine.Event.Word) line(e.toString()) }

  fun start(context: Context) {
    app = context.applicationContext
    file = File(app.getExternalFilesDir(null), "shelf-voice.log")
    VoiceEngine.addListener(onEvent)
    line("service started")
    main.removeCallbacks(tick)
    main.postDelayed(tick, 30_000)
  }

  fun stop() {
    line("service stopped")
    VoiceEngine.removeListener(onEvent)
    main.removeCallbacks(tick)
  }

  fun read(context: Context): String = File(context.getExternalFilesDir(null), "shelf-voice.log").takeIf { it.exists() }?.readText() ?: ""

  fun clear(context: Context) {
    File(context.getExternalFilesDir(null), "shelf-voice.log").delete()
  }

  private fun line(what: String) {
    val f = file ?: return
    val power = app.getSystemService(PowerManager::class.java)
    val battery = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
    val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val e = VoiceEngine
    f.appendText(
      "${time.format(Date())} $what word=${e.word}/${e.totalWords} playing=${e.playing} screen=${if (power.isInteractive) "on" else "off"} " +
        "doze=${power.isDeviceIdleMode} plugged=$plugged battery=$level%\n",
    )
  }
}
