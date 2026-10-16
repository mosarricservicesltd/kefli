package main

import (
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
)

// pubkeyArg reads a key as the operator gives it: 64 lower-case hex characters, or an npub (NIP-19).
func pubkeyArg(s string) (string, error) {
	if auth.IsHex64(s) {
		return s, nil
	}
	if pk, ok := npub(s); ok {
		return pk, nil
	}
	return "", fmt.Errorf("%q isn't a hex pubkey or an npub", s)
}

// megabytes reads a quota given in whole megabytes of 1,048,576 bytes, as the server counts them, as bytes.
func megabytes(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || n > math.MaxInt64>>20 {
		return 0, fmt.Errorf("%q isn't a whole number of megabytes", s)
	}
	return n << 20, nil
}

// bech32 is BIP-173's alphabet, in which NIP-19 writes keys.
const bech32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

// npubLen is an npub's length: "npub1", then 52 characters for the key's 256 bits and 6 for the checksum.
const npubLen = 63

// npub decodes an npub (NIP-19) to its key in hex: the prefix npub, 32 bytes and a bech32 checksum that holds
// (BIP-173), written all in lower case or all in upper. go-nostr's nip19 would need a module this one doesn't have.
func npub(s string) (string, bool) {
	if len(s) != npubLen || (s != strings.ToLower(s) && s != strings.ToUpper(s)) {
		return "", false
	}
	s = strings.ToLower(s)
	if !strings.HasPrefix(s, "npub1") {
		return "", false
	}
	values := make([]byte, 0, npubLen-5)
	for _, c := range s[5:] {
		i := strings.IndexRune(bech32, c)
		if i < 0 {
			return "", false
		}
		values = append(values, byte(i))
	}
	if polymod(append(hrpExpand("npub"), values...)) != 1 {
		return "", false
	}
	key, ok := eightBits(values[:len(values)-6])
	return hex.EncodeToString(key), ok
}

// hrpExpand is BIP-173's expansion of a prefix for the checksum.
func hrpExpand(hrp string) []byte {
	out := make([]byte, 0, 2*len(hrp)+1)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]>>5)
	}
	out = append(out, 0)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]&31)
	}
	return out
}

// polymod is BIP-173's checksum over 5-bit values; a bech32 string's, prefix expanded, is 1.
func polymod(values []byte) uint32 {
	gen := [5]uint32{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk := uint32(1)
	for _, v := range values {
		top := chk >> 25
		chk = (chk&0x1ffffff)<<5 ^ uint32(v)
		for i := range gen {
			if (top>>i)&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}

// eightBits regroups 5-bit values as bytes. The bits left over must be fewer than five and all zero, as BIP-173 asks
// of data without padding.
func eightBits(values []byte) ([]byte, bool) {
	var acc, bits uint
	out := make([]byte, 0, len(values)*5/8)
	for _, v := range values {
		acc = (acc<<5 | uint(v)) & 0xfff
		bits += 5
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(acc>>bits))
		}
	}
	return out, bits < 5 && acc&(1<<bits-1) == 0
}
