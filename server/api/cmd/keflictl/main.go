// keflictl is the operator's hand on keflid's database (backend spec 5):
//
//	keflictl -db keflid.db register <pubkey>…        add users, as POST /register does
//	keflictl -db keflid.db disable <pubkey>          take a key off the allowlist and freeze its blobs, keeping them
//	keflictl -db keflid.db enable <pubkey>
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func main() {
	db := flag.String("db", "keflid.db", "keflid's SQLite database")
	flag.Parse()
	if err := run(*db, flag.Args()); err != nil {
		fmt.Fprintln(os.Stderr, "keflictl:", err)
		os.Exit(1)
	}
}

func run(path string, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: keflictl -db <file> register|disable|enable <pubkey>…")
	}
	for _, k := range args[1:] {
		if !auth.IsHex64(k) {
			return fmt.Errorf("%q isn't a hex pubkey", k)
		}
	}
	st, err := store.Open(path)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	for _, k := range args[1:] {
		switch args[0] {
		case "register":
			err = st.Register(ctx, k)
		case "disable", "enable":
			err = st.SetDisabled(ctx, k, args[0] == "disable")
		default:
			return fmt.Errorf("unknown command %q", args[0])
		}
		if err != nil {
			return err
		}
		fmt.Printf("%s %s\n", args[0], k[:12])
	}
	return nil
}
