package blossom

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// Blossom counted no request: any key may sign a preflight or a delete and anyone may ask for a blob, so one client
// sending them as fast as it could held keflid's one database connection for everyone (probe preflights: one
// library's preflights, from 32 connections, took another user's uploads from 12 ms to 4.6 s at the median). Now an
// address (an IPv6 /64) makes MaxAddressCalls a minute of the blob store and an IPv6 /48 MaxBlockCalls, counted before
// anything is read or verified, as the API's calls are; past them every request gets 429 rate with Retry-After, which
// the phone and the extension send again later.
func TestCallsPerAddress(t *testing.T) {
	_, _, clock, mux := testServer(t)
	// an unsigned delete: answered 401 at its authorisation, before the database, unless the limit answers first
	call := func(from string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("DELETE", "/"+fmt.Sprintf("%064x", 1), nil)
		req.Header.Set("X-Forwarded-For", from)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	for i := 0; i < MaxAddressCalls; i++ {
		if rec := call("198.51.100.9"); rec.Code != http.StatusUnauthorized {
			t.Fatalf("call %d: %d", i, rec.Code)
		}
	}
	rec := call("198.51.100.9")
	if wait, _ := strconv.Atoi(rec.Header().Get("Retry-After")); rec.Code != http.StatusTooManyRequests || rec.Header().Get("X-Reason") != "rate" || wait < 1 || wait > 60 {
		t.Fatalf("past the address's calls: %d %q, Retry-After %q", rec.Code, rec.Header().Get("X-Reason"), rec.Header().Get("Retry-After"))
	}
	if rec := call("198.51.100.10"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("another address: %d", rec.Code)
	}
	*clock = clock.Add(time.Minute)
	if rec := call("198.51.100.9"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a minute later: %d", rec.Code)
	}
	// a /48 is 65,536 /64s, and makes MaxBlockCalls a minute between them; an IPv4 /24 isn't one site, and has no such limit
	for i := 0; i < MaxBlockCalls; i++ {
		if rec := call(fmt.Sprintf("2001:db8:77:%x::1", i/(MaxAddressCalls/2))); rec.Code != http.StatusUnauthorized {
			t.Fatalf("block call %d: %d", i, rec.Code)
		}
	}
	if rec := call("2001:db8:77:ffff::1"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("past the block's calls: %d", rec.Code)
	}
	if rec := call("2001:db8:78::1"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("the next /48: %d", rec.Code)
	}
	for i := 0; i <= MaxBlockCalls/MaxAddressCalls; i++ {
		for j := 0; j < MaxAddressCalls; j++ {
			if rec := call(fmt.Sprintf("192.0.2.%d", i+1)); rec.Code != http.StatusUnauthorized {
				t.Fatalf("an IPv4 address in a busy /24, call %d: %d", j, rec.Code)
			}
		}
	}
}
