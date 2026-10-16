package main

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
)

// npubOf encodes a key as an npub (NIP-19, BIP-173), the other way from npub, to check it against.
func npubOf(key []byte) string {
	values := fiveBits(key)
	chk := polymod(append(append(hrpExpand("npub"), values...), 0, 0, 0, 0, 0, 0)) ^ 1
	for i := 0; i < 6; i++ {
		values = append(values, byte(chk>>(5*(5-i)))&31)
	}
	var b strings.Builder
	b.WriteString("npub1")
	for _, v := range values {
		b.WriteByte(bech32[v])
	}
	return b.String()
}

// fiveBits regroups bytes as 5-bit values, padding the last with zeros.
func fiveBits(data []byte) []byte {
	var acc, bits uint
	var out []byte
	for _, d := range data {
		acc = acc<<8 | uint(d)
		bits += 8
		for bits >= 5 {
			bits -= 5
			out = append(out, byte(acc>>bits)&31)
		}
	}
	if bits > 0 {
		out = append(out, byte(acc<<(5-bits))&31)
	}
	return out
}

// The vectors are NIP-19's own and nostr-tools' npubEncode.
var vectors = map[string]string{
	"npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg": "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e",
	"npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqujme": strings.Repeat("0", 64),
	"npub1lllllllllllllllllllllllllllllllllllllllllllllllllllsq7lrjw": strings.Repeat("f", 64),
	"npub1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygse4sl3h": strings.Repeat("1", 64),
}

func TestNpub(t *testing.T) {
	for in, want := range vectors {
		for _, form := range []string{in, strings.ToUpper(in)} {
			if got, ok := npub(form); !ok || got != want {
				t.Fatalf("npub(%s) = %q %v, want %s", form, got, ok, want)
			}
		}
		key, _ := hex.DecodeString(want)
		if npubOf(key) != in {
			t.Fatalf("the test's encoder gives %s for %s", npubOf(key), want)
		}
	}
	good := "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg"
	// the key's last character carries four bits of padding, which must be zero: one with a padding bit set, its
	// checksum made right, still isn't an npub
	values := fiveBits(make([]byte, 32))
	values[len(values)-1] |= 1
	chk := polymod(append(append(hrpExpand("npub"), values...), 0, 0, 0, 0, 0, 0)) ^ 1
	var padded strings.Builder
	padded.WriteString("npub1")
	for _, v := range values {
		padded.WriteByte(bech32[v])
	}
	for i := 0; i < 6; i++ {
		padded.WriteByte(bech32[byte(chk>>(5*(5-i)))&31])
	}
	for name, bad := range map[string]string{
		"a changed character":  good[:20] + "q" + good[21:],
		"a changed checksum":   good[:62] + "h",
		"mixed case":           "N" + good[1:],
		"another prefix":       "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz",
		"too short":            good[:62],
		"too long":             good + "q",
		"outside the alphabet": good[:10] + "b" + good[11:],
		"padding bits set":     padded.String(),
		"a hex key":            vectors[good],
		"empty":                "",
	} {
		if got, ok := npub(bad); ok {
			t.Fatalf("%s: npub(%q) = %s", name, bad, got)
		}
	}
	if pk, err := pubkeyArg(vectors[good]); err != nil || pk != vectors[good] {
		t.Fatalf("a hex key: %q %v", pk, err)
	}
	if _, err := pubkeyArg(strings.ToUpper(vectors[good])); err == nil {
		t.Fatal("took upper-case hex, which the API never sees")
	}
}

func TestMegabytes(t *testing.T) {
	for in, want := range map[string]int64{"0": 0, "50": 52_428_800, "200": 209_715_200, "8796093022207": 8796093022207 << 20} {
		if got, err := megabytes(in); err != nil || got != want {
			t.Fatalf("megabytes(%s) = %d %v, want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "-1", "1.5", "50MB", "8796093022208", "99999999999999999999"} {
		if _, err := megabytes(bad); err == nil {
			t.Fatalf("megabytes(%q) took it", bad)
		}
	}
}

// Whatever the operator types, pubkeyArg gives a key the API would take, or an error: a hex key is itself, and an
// npub decodes to the key that encodes back to it.
func FuzzPubkeyArg(f *testing.F) {
	for in, key := range vectors {
		f.Add(in)
		f.Add(strings.ToUpper(in))
		f.Add(key)
		f.Add(in[:len(in)-1] + "q")
	}
	f.Add("npub1")
	f.Add("")
	f.Fuzz(func(t *testing.T, in string) {
		pk, err := pubkeyArg(in)
		if err != nil {
			return
		}
		if !auth.IsHex64(pk) {
			t.Fatalf("pubkeyArg(%q) = %q, not a hex key", in, pk)
		}
		if pk == in {
			return
		}
		key, _ := hex.DecodeString(pk)
		if npubOf(key) != strings.ToLower(in) {
			t.Fatalf("pubkeyArg(%q) = %s, which encodes as %s", in, pk, npubOf(key))
		}
	})
}

// Every key round-trips through its npub.
func FuzzNpubRoundTrip(f *testing.F) {
	f.Add(make([]byte, 32))
	f.Add([]byte(strings.Repeat("\xff", 32)))
	f.Add([]byte("a key of thirty-two bytes, fuzzed"))
	f.Fuzz(func(t *testing.T, key []byte) {
		key = append(key, make([]byte, 32)...)[:32]
		got, ok := npub(npubOf(key))
		if !ok || got != hex.EncodeToString(key) {
			t.Fatalf("%x came back as %q %v", key, got, ok)
		}
	})
}

// Whatever the operator types as megabytes, megabytes gives a whole number of them in bytes that fits, or an error.
func FuzzMegabytes(f *testing.F) {
	for _, s := range []string{"0", "50", "-1", "1.5", "8796093022207", "8796093022208", "+7", "007"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		n, err := megabytes(in)
		if err == nil && (n < 0 || n%(1<<20) != 0) {
			t.Fatalf("megabytes(%q) = %d", in, n)
		}
	})
}
