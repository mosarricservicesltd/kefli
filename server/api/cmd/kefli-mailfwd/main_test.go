package main

import (
	"bufio"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// A webhook's body sent a byte at a time held its connection for ever: the server had a header timeout only. Now the
// whole request has ReadTimeout; here a shorter one, so the test needn't wait 30 seconds.
func TestServerDropsASlowBody(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := server(l.Addr().String(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 1<<10)
		for {
			if _, err := r.Body.Read(buf); err != nil {
				return
			}
		}
	}))
	if s.ReadTimeout == 0 || s.WriteTimeout == 0 || s.MaxHeaderBytes > 64<<10 {
		t.Fatalf("read %s, write %s, headers %d", s.ReadTimeout, s.WriteTimeout, s.MaxHeaderBytes)
	}
	s.ReadTimeout = 300 * time.Millisecond
	go s.Serve(l)
	defer s.Close()
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write([]byte("POST /hooks/resend HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\n\r\n"))
	start := time.Now()
	for time.Since(start) < 3*time.Second {
		if _, err := c.Write([]byte("x")); err != nil {
			return
		}
		_ = c.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		if _, err := bufio.NewReader(c).ReadByte(); err != nil && !strings.Contains(err.Error(), "timeout") {
			return // closed by the server
		}
	}
	t.Fatal("a body sent a byte at a time held its connection past the read timeout")
}

func TestConfig(t *testing.T) {
	full := map[string]string{
		"RESEND_API_KEY": "re_x", "RESEND_WEBHOOK_SECRET": "whsec_eA==", "KEFLI_MAILFWD_ADDR": "127.0.0.1:8449",
		"KEFLI_MAILFWD_ACCEPT": " privacy@kefli.app, ,legal@kefli.app", "KEFLI_MAILFWD_FROM": "privacy@kefli.app",
		"KEFLI_MAILFWD_TO": "inbox@example.com",
	}
	cfg, addr, err := config(func(k string) string { return full[k] })
	if err != nil || addr != "127.0.0.1:8449" || len(cfg.Accept) != 2 || cfg.Accept[1] != "legal@kefli.app" {
		t.Fatalf("config = %+v, %q, %v", cfg.Accept, addr, err)
	}
	delete(full, "KEFLI_MAILFWD_TO")
	if _, _, err := config(func(k string) string { return full[k] }); err == nil {
		t.Fatal("a missing setting passed")
	}
}
