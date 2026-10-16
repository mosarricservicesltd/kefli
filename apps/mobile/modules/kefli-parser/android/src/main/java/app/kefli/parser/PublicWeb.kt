package app.kefli.parser

// The public-address rule of the phone's own fetches (mobile spec 7.1), for the render WebView, so the engine asks no
// address a hop of Kefli's fetch couldn't go to (apps/mobile/src/net/http.ts publicWeb): packages/protocol's
// isPublicWebUrl (src/publicUrl.ts), ported a function at a time, with expo/fetch's stand-in for the phone's files
// (fromFiles) among what it refuses. Apart from the WebView, so it runs on the JVM; apps/mobile/test/render.test.ts
// holds it to the protocol's names, blocks and prefixes.
//
// RULED: the address checked is the engine's own, which Chromium has written in the URL Standard's form before any
// callback sees it (a host in lower-case ASCII, a name in another script in punycode, an IPv4 address in four decimal
// parts, an IPv6 address compressed in brackets), so its host is read as written there, as the address Chromium
// connects to. The protocol reads a host with whatwg-url, which Kotlin doesn't have, so a host in no such form (a
// percent sign, a letter outside ASCII, a backslash, a space or a control, a number written any other way, as 0x7f.1,
// 127.1 and 2130706433 are, or a port past 65535) is refused rather than read: Chromium never hands one over, and
// read as written it could pass for a name.
object PublicWeb {
  /** The longest host and port read, normalise's MAX_HOST_CHARS: the protocol refuses a longer one unparsed. */
  private const val MAX_HOST_CHARS = 1024
  /** expo/fetch's stand-in host for file: URLs, which with every host that only begins with it reads the phone's files. */
  private const val FILES_HOST = "filesystem.local"

  private val LOCAL_NAMES = Regex("(^|\\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\\.arpa)$", RegexOption.IGNORE_CASE)
  private val DOTTED = Regex("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})")
  private val TAIL = Regex("(.*:)(\\d+\\.\\d+\\.\\d+\\.\\d+)")
  private val PIECE = Regex("[0-9a-f]{1,4}")
  /** An http(s) address's authority, up to its path, query or fragment. */
  private val AUTHORITY = Regex("^https?://([^/?#]*)", RegexOption.IGNORE_CASE)
  /** A host, an IPv6 address in brackets or anything without a colon, and its port's digits if it has one. */
  private val HOST_PORT = Regex("(\\[[^\\]]*\\]|[^:]*)(?::(\\d*))?")
  /** The URL Standard's "ends in a number": a last part of digits, or 0x and hex digits, makes a host an IPv4 address. */
  private val NUMBER = Regex("\\d+|0[xX][0-9a-fA-F]*")
  /** An IPv4 address as Chromium writes one: four decimal parts, none with a leading zero. */
  private val DECIMAL = Regex("(0|[1-9]\\d{0,2})(\\.(0|[1-9]\\d{0,2})){3}")

  /**
   * The IPv6 prefixes, each a /96 written as its first six pieces, whose addresses reach the IPv4 address in their last
   * 32 bits: such an address is as private as that IPv4 address.
   */
  private val CARRIERS = listOf(
    intArrayOf(0, 0, 0, 0, 0, 0xffff), // mapped, ::ffff:a.b.c.d
    intArrayOf(0, 0, 0, 0, 0xffff, 0), // translated, ::ffff:0:a.b.c.d (RFC 2765)
    intArrayOf(0, 0, 0, 0, 0, 0), // compatible, ::a.b.c.d, as written before RFC 4291 retired it
    intArrayOf(0x64, 0xff9b, 0, 0, 0, 0), // NAT64's well-known prefix, 64:ff9b::/96 (RFC 6052)
  )

  /**
   * NAT64's prefix for a network's own use, 64:ff9b:1::/48 (RFC 8215), as its first three pieces: it reaches an IPv4
   * address its network chooses, at a place in the address its network chooses, so none of it is public.
   */
  private val LOCAL_NAT64 = intArrayOf(0x64, 0xff9b, 1)

  /**
   * True for an http(s) URL whose host is neither local by name nor a private, loopback or link-local address, nor
   * one the phone's fetch reads from its own files.
   */
  fun isPublicWebUrl(url: String): Boolean {
    val hostname = hostname(url) ?: return false
    val host = hostname.removeSuffix(".")
    if (localName(host) || fromFiles(url, host)) return false
    if (host.startsWith("[") || host.contains(':')) return !privateV6(host)
    val v4 = ipv4(host)
    return if (v4 != null) !privateV4(v4) else true
  }

  /**
   * The host of an http(s) address as the engine wrote it (the protocol's urlParts hostname): after any user info,
   * without the port, its ASCII letters in lower case; null for any other address, a host and port past
   * MAX_HOST_CHARS, or a host or port in no form the engine writes.
   */
  fun hostname(url: String): String? {
    val authority = AUTHORITY.find(url)?.groupValues?.get(1) ?: return null
    val written = authority.substring(authority.lastIndexOf('@') + 1)
    if (written.length > MAX_HOST_CHARS) return null
    val m = HOST_PORT.matchEntire(written) ?: return null
    val host = m.groupValues[1]
    return if (asWritten(host) && port(m.groupValues[2])) host.lowercase() else null
  }

  /**
   * Whether a host is in a form the engine writes: ASCII, with no space, control, percent sign or backslash, and a
   * number only as four decimal parts with no leading zeros.
   */
  private fun asWritten(host: String): Boolean {
    if (host.any { it <= ' ' || it >= '\u007f' || it == '%' || it == '\\' }) return false
    if (host.startsWith("[")) return true
    val bare = host.removeSuffix(".")
    return !NUMBER.matches(bare.substringAfterLast('.')) || (DECIMAL.matches(bare) && ipv4(bare) != null)
  }

  /** Whether a port's digits, none for no port, are one the URL Standard takes: 65535 at most. */
  private fun port(digits: String): Boolean {
    val n = digits.trimStart('0')
    return n.length < 5 || n.length == 5 && n.toInt() <= 65535
  }

  /** Whether a host, without its trailing dot, is local by name: none, a single label, or one of LOCAL_NAMES. */
  private fun localName(host: String): Boolean {
    return host.isEmpty() || LOCAL_NAMES.containsMatchIn(host) || (!host.contains('.') && !host.contains(':'))
  }

  /**
   * Whether the phone's fetch reads an address from its own files rather than the web: expo/fetch turns any address
   * whose text begins http://filesystem.local into a file: URL. Over https the stand-in itself is a local name.
   */
  private fun fromFiles(url: String, host: String): Boolean {
    return url.startsWith("http:", ignoreCase = true) && host.startsWith(FILES_HOST)
  }

  /** An IPv4 address in four decimal parts as its numbers, or null. */
  private fun ipv4(host: String): IntArray? {
    val m = DOTTED.matchEntire(host) ?: return null
    val parts = IntArray(4) { m.groupValues[it + 1].toInt() }
    return if (parts.all { it <= 255 }) parts else null
  }

  private fun privateV4(p: IntArray): Boolean {
    val a = p[0]
    return a == 0 || a == 10 || a == 127 || a >= 224 || privateBlock(a, p[1])
  }

  /** Link-local 169.254/16, private 172.16/12 and 192.168/16, shared 100.64/10. */
  private fun privateBlock(a: Int, b: Int): Boolean {
    return (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127)
  }

  /** An IPv6 address as its eight 16-bit pieces, or null; a dotted IPv4 tail counts as the last two. */
  private fun pieces(h: String): IntArray? {
    val text = hexTail(h) ?: return null
    val halves = text.split("::")
    if (halves.size > 2) return null
    val head = side(halves[0])
    val rest = if (halves.size == 2) side(halves[1]) else emptyList()
    val fill = 8 - head.size - rest.size
    if (if (halves.size == 1) head.size != 8 else fill < 0) return null
    val all = head + List(if (halves.size == 2) fill else 0) { 0 } + rest
    return if (all.any { it < 0 }) null else all.toIntArray()
  }

  /** h with a dotted IPv4 tail written as its last two pieces, or as it is; null when that tail is no IPv4 address. */
  private fun hexTail(h: String): String? {
    val tail = TAIL.matchEntire(h) ?: return h
    val v4 = ipv4(tail.groupValues[2]) ?: return null
    return tail.groupValues[1] + ((v4[0] shl 8) or v4[1]).toString(16) + ":" + ((v4[2] shl 8) or v4[3]).toString(16)
  }

  /** One side of an IPv6 address's ::, as its pieces; -1 for one that isn't 1 to 4 hex digits. */
  private fun side(s: String): List<Int> {
    return if (s == "") emptyList() else s.split(':').map { if (PIECE.matches(it)) it.toInt(16) else -1 }
  }

  /** The IPv4 address in the last 32 bits. */
  private fun v4Of(p: IntArray): IntArray {
    return intArrayOf(p[6] shr 8, p[6] and 255, p[7] shr 8, p[7] and 255)
  }

  /** Whether an IPv6 address's first n pieces are all zero. */
  private fun zeros(p: IntArray, n: Int): Boolean {
    return (0 until n).all { p[it] == 0 }
  }

  /** Whether an IPv6 address begins with these pieces. */
  private fun begins(p: IntArray, head: IntArray): Boolean {
    return head.indices.all { p[it] == head[it] }
  }

  /** The IPv4 address an IPv6 one reaches (CARRIERS), or null. */
  private fun carried(p: IntArray): IntArray? {
    return if (CARRIERS.any { begins(p, it) }) v4Of(p) else null
  }

  private fun privateV6(host: String): Boolean {
    val p = pieces(host.removePrefix("[").removeSuffix("]").lowercase()) ?: return true
    // :: and ::1
    if (zeros(p, 7) && p[7] <= 1) return true
    val v4 = carried(p)
    if (v4 != null) return privateV4(v4)
    if (begins(p, LOCAL_NAT64)) return true
    // unique local fc00::/7, link-local fe80::/10, multicast ff00::/8
    return (p[0] and 0xfe00) == 0xfc00 || (p[0] and 0xffc0) == 0xfe80 || (p[0] and 0xff00) == 0xff00
  }
}
