// keflictl is the operator's hand on keflid's database (backend spec 5):
//
//	keflictl -db keflid.db register <pubkey>…        add users, as POST /register does
//	keflictl -db keflid.db disable <pubkey>          take a key off the allowlist and freeze its blobs, keeping them
//	keflictl -db keflid.db enable <pubkey>
//	keflictl -db keflid.db quota <pubkey|npub> <MB>  set one library's quota, in whole megabytes of 1,048,576 bytes
//	keflictl -db keflid.db gone <days> [<since>]     keys deleted at least that many days ago, one a line, for the relay's
//	                                                 sweep; with since, a Unix time, only those whose days ran out since then
package main

import (
	"context"
	"errors"
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

var errUsage = errors.New("usage: keflictl -db <file> register|disable|enable <pubkey>… | quota <pubkey|npub> <MB> | gone <days> [<since>]")

// perKey are the commands that take one key or more.
var perKey = map[string]func(context.Context, *store.Store, string) error{
	"register": func(ctx context.Context, st *store.Store, k string) error { return st.Register(ctx, k) },
	"disable":  func(ctx context.Context, st *store.Store, k string) error { return st.SetDisabled(ctx, k, true) },
	"enable":   func(ctx context.Context, st *store.Store, k string) error { return st.SetDisabled(ctx, k, false) },
}

func run(path string, args []string, out io.Writer) error {
	switch {
	case len(args) >= 2 && args[0] == "gone":
		return gone(path, args[1:], out)
	case len(args) == 3 && args[0] == "quota":
		return quota(path, args[1], args[2], out)
	case len(args) < 2 || perKey[args[0]] == nil:
		return errUsage
	}
	return eachKey(path, args[0], args[1:], out)
}

// eachKey runs a per-key command for each key, once every one of them reads as a hex pubkey.
func eachKey(path, command string, keys []string, out io.Writer) error {
	for _, k := range keys {
		if !auth.IsHex64(k) {
			return fmt.Errorf("%q isn't a hex pubkey", k)
		}
	}
	st, err := store.Open(path)
	if err != nil {
		return err
	}
	defer st.Close()
	for _, k := range keys {
		if err := perKey[command](context.Background(), st, k); err != nil {
			return err
		}
		fmt.Fprintf(out, "%s %s\n", command, k[:12])
	}
	return nil
}

// quota sets one library's quota (flow decision 117), which it keeps from then on. A library left above it keeps its
// blobs and takes no new one until deleting brings it back within it (contract 5).
func quota(path, who, mb string, out io.Writer) error {
	pubkey, err := pubkeyArg(who)
	if err != nil {
		return err
	}
	bytes, err := megabytes(mb)
	if err != nil {
		return err
	}
	st, err := store.Open(path)
	if err != nil {
		return err
	}
	defer st.Close()
	found, err := st.SetQuota(context.Background(), pubkey, bytes)
	if err == nil && !found {
		err = fmt.Errorf("%s has no account", pubkey[:12])
	}
	if err == nil {
		fmt.Fprintf(out, "quota %s %d MB\n", pubkey[:12], bytes>>20)
	}
	return err
}

// gone prints the keys deleted at least days ago and, given since, a Unix time, only those whose days ran out at or
// after it: the relay's sweep asks for those whose time came since its last run (relay-sweep).
func gone(path string, args []string, out io.Writer) error {
	days, since, err := goneArgs(args)
	if err != nil {
		return err
	}
	st, err := store.Open(path)
	if err != nil {
		return err
	}
	defer st.Close()
	keys, err := st.GoneFor(context.Background(), time.Duration(days)*24*time.Hour, since)
	for _, k := range keys {
		fmt.Fprintln(out, k)
	}
	return err
}

// maxDays is the most days gone takes, a century, which keeps its arithmetic far from overflowing.
const maxDays = 36_500

// goneArgs reads gone's days and its since, 0 when it isn't given.
func goneArgs(args []string) (days int, since int64, err error) {
	if len(args) > 2 {
		return 0, 0, errUsage
	}
	if days, err = strconv.Atoi(args[0]); err != nil || days < 0 || days > maxDays {
		return 0, 0, fmt.Errorf("%q isn't a number of days", args[0])
	}
	if len(args) == 2 {
		if since, err = strconv.ParseInt(args[1], 10, 64); err != nil || since < 0 {
			return 0, 0, fmt.Errorf("%q isn't a time in seconds since 1970", args[1])
		}
	}
	return days, since, nil
}
