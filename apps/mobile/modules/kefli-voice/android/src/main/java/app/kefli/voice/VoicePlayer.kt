package app.kefli.voice

import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

// The engine as media3 sees it (mobile spec 8.1). Duration and position are the app's clock (5.7), sent with
// playback speed 1 so Android's extrapolation doesn't count the rate twice; there is no seek-in-item command,
// so the system bar moves by itself but can't be dragged (FD 48). Previous and next are ±15 too.
@UnstableApi
class VoicePlayer : SimpleBasePlayer(Looper.getMainLooper()) {
  private val listener: (VoiceEngine.Event) -> Unit = { e -> if (e !is VoiceEngine.Event.Word) invalidateState() }
  private var loadedHash = ""
  private var loads = 0

  init {
    VoiceEngine.addListener(listener)
  }

  override fun getState(): State {
    val e = VoiceEngine
    val commands = Player.Commands.Builder().addAll(
      Player.COMMAND_PLAY_PAUSE, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_STOP, Player.COMMAND_RELEASE,
      Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA,
    ).build()
    val builder = State.Builder()
      .setAvailableCommands(commands)
      .setPlayWhenReady(e.playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setSeekBackIncrementMs(15_000)
      .setSeekForwardIncrementMs(15_000)
    if (!e.loaded) return builder.setPlaybackState(Player.STATE_IDLE).build()
    val meta = MediaMetadata.Builder().setTitle(e.title).setArtist(e.site)
      .apply { e.artwork?.let { setArtworkData(it, MediaMetadata.PICTURE_TYPE_FRONT_COVER) } }
      .build()
    // the item's id is a number for this load, never the save's hash, which would name the article to any controller (F29)
    if (e.hash != loadedHash) {
      loadedHash = e.hash
      loads++
    }
    val id = "kefli-$loads"
    val item = MediaItemData.Builder(id)
      .setMediaItem(MediaItem.Builder().setMediaId(id).setMediaMetadata(meta).build())
      .setMediaMetadata(meta)
      .setDurationUs(e.durationMs() * 1000)
      .setIsSeekable(true)
      .build()
    return builder
      .setPlaybackState(if (e.ended) Player.STATE_ENDED else Player.STATE_READY)
      .setPlaylist(listOf(item))
      .setContentPositionMs(e.positionMs())
      .build()
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    if (playWhenReady) VoiceEngine.play() else VoiceEngine.pause()
    return Futures.immediateVoidFuture()
  }

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_TO_PREVIOUS -> VoiceEngine.skip(-15)
      Player.COMMAND_SEEK_FORWARD, Player.COMMAND_SEEK_TO_NEXT -> VoiceEngine.skip(15)
    }
    return Futures.immediateVoidFuture()
  }

  override fun handleStop(): ListenableFuture<*> {
    VoiceEngine.pause()
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> {
    VoiceEngine.removeListener(listener)
    return Futures.immediateVoidFuture()
  }
}
