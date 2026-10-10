// keflictl is the operator's hand on keflid's database (backend spec 5):
//
//	keflictl -db keflid.db register <pubkey>…        add users, as POST /register does
//	keflictl -db keflid.db disable <pubkey>          take a key off the allowlist and freeze its blobs, keeping them
//	keflictl -db keflid.db enable <pubkey>
//	keflictl -db keflid.db gone <days>               keys deleted at least that many days ago, one a line, for the relay's sweep
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func main() {
	db := flag.String("db", "keflid.db", "keflid's SQLite database")
	flag.Parse()
	if err := run(*db, flag.Args(), os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "keflictl:", err)
		os.Exit(1)
	}
}

func run(path string, args []string, out io.Writer) error {
	if len(args) == 2 && args[0] == "gone" {
		return gone(path, args[1], out)
	}
	if len(args) < 2 {
		return fmt.Errorf("usage: keflictl -db <file> register|disable|enable <pubkey>… | gone <days>")
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
		fmt.Fprintf(out, "%s %s\n", args[0], k[:12])
	}
	return nil
}

// gone prints the keys deleted at least days ago.
func gone(path, days string, out io.Writer) error {
	n, err := strconv.Atoi(days)
	if err != nil || n < 0 {
		return fmt.Errorf("%q isn't a number of days", days)
	}
	st, err := store.Open(path)
	if err != nil {
		return err
	}
	defer st.Close()
	keys, err := st.GoneFor(context.Background(), time.Duration(n)*24*time.Hour)
	for _, k := range keys {
		fmt.Fprintln(out, k)
	}
	return err
}
