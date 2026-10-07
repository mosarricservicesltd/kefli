package space.shelf.secp

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import fr.acinq.secp256k1.Secp256k1

// Schnorr (BIP-340) and ECDH on libsecp256k1, for nostr signing, verifying and NIP-44 (mobile spec 8).
// Keys, hashes and signatures cross the bridge as lowercase hex; every function is synchronous, since
// each call takes well under a millisecond and JavaScript needs the answer inline.
class ShelfSecpModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShelfSecp")

    // The x-only public key: 32 bytes, the x coordinate of the point.
    Function("publicKey") { secretKey: String ->
      hex(xOnly(Secp256k1.pubkeyCreate(bytes(secretKey, 32))))
    }

    // BIP-340 signature of a 32-byte hash, with 32 bytes of auxiliary randomness from JavaScript.
    Function("sign") { hash: String, secretKey: String, aux: String ->
      hex(Secp256k1.signSchnorr(bytes(hash, 32), bytes(secretKey, 32), bytes(aux, 32)))
    }

    // False for anything malformed as well as for a bad signature, as nostr-tools' verifyEvent is.
    Function("verify") { signature: String, hash: String, publicKey: String ->
      try {
        Secp256k1.verifySchnorr(bytes(signature, 64), bytes(hash, 32), bytes(publicKey, 32))
      } catch (e: Exception) {
        false
      }
    }

    // The shared x coordinate NIP-44 extracts its conversation key from: x of (secretKey · P), where P is
    // the even-y point with the peer's x. libsecp256k1's own ecdh hashes the point, so this tweaks instead.
    Function("sharedX") { secretKey: String, publicKey: String ->
      val point = byteArrayOf(2) + bytes(publicKey, 32)
      hex(xOnly(Secp256k1.pubKeyTweakMul(point, bytes(secretKey, 32))))
    }
  }

  // A serialised point (33 bytes compressed or 65 uncompressed) to its x coordinate.
  private fun xOnly(point: ByteArray): ByteArray = point.copyOfRange(1, 33)

  private fun bytes(h: String, length: Int): ByteArray {
    require(h.length == length * 2) { "expected $length bytes of hex" }
    return ByteArray(length) { i -> h.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
  }

  private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
}
