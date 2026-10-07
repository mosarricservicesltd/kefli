package space.shelf.voice

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

// The media session and its foreground service (mobile spec 8.1). The card's side slots hold ±15 (Android 13
// and later fill them only from media button preferences); tapping the card opens the Reader on the article.
// Everything is released when the task is removed, since a leftover card restarted playback in the test build.
@UnstableApi
class VoiceService : MediaSessionService() {
  private var session: MediaSession? = null
  private val listener: (VoiceEngine.Event) -> Unit = { e ->
    if (e is VoiceEngine.Event.State && VoiceEngine.loaded) session?.setSessionActivity(readerIntent(VoiceEngine.hash))
  }

  override fun onCreate() {
    super.onCreate()
    val back = CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
      .setPlayerCommand(Player.COMMAND_SEEK_BACK)
      .setSlots(CommandButton.SLOT_BACK)
      .setDisplayName("Back 15 seconds")
      .build()
    val forward = CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_15)
      .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
      .setSlots(CommandButton.SLOT_FORWARD)
      .setDisplayName("Forward 15 seconds")
      .build()
    session = MediaSession.Builder(this, VoicePlayer())
      .setMediaButtonPreferences(listOf(back, forward))
      .setSessionActivity(readerIntent(VoiceEngine.hash))
      .build()
      // Nothing connects a MediaController to this service, so the session is registered here; without it
      // media3 never posts the card, the service never goes to the foreground, and Android freezes the app
      // a minute after the screen locks (week-0 gate, first run).
      .also { addSession(it) }
    VoiceEngine.addListener(listener)
    VoiceLog.start(this)
  }

  private fun readerIntent(hash: String): PendingIntent {
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("shelf://reader/$hash")).setPackage(packageName)
    return PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    VoiceEngine.close()
    pauseAllPlayersAndStopSelf()
  }

  override fun onDestroy() {
    VoiceEngine.removeListener(listener)
    VoiceLog.stop()
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }
}
