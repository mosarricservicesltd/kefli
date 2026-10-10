package main

import "testing"

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
