// kefli-writepolicy is the operator relay's write policy (contract 3.2), launched by strfry as relay.writePolicy.plugin.
// It reads the allowlist and the authorised devices from keflid's database, read-only; keeps its own record of the gift
// wraps the relay holds, for the deletion rules; and removes with strfry delete the wraps a recipient deletes, which
// strfry's own NIP-09 handling wouldn't. The rules and the record are internal/policy's.
//
//	kefli-writepolicy -db /data/keflid.db -wraps /data/wraps.db -strfry /app/strfry -config /etc/strfry.conf
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"io"
	"log"
	"os"
	"os/exec"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/policy"
	_ "modernc.org/sqlite"
)

func main() {
	log.SetPrefix("kefli-writepolicy: ")
	log.SetFlags(0)
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}

func run(args []string, in io.Reader, out io.Writer) error {
	fs := flag.NewFlagSet("kefli-writepolicy", flag.ContinueOnError)
	dbPath := fs.String("db", "keflid.db", "keflid's SQLite database, opened read-only")
	wrapsPath := fs.String("wraps", "wraps.db", "the plugin's record of the gift wraps the relay holds")
	strfry := fs.String("strfry", "/app/strfry", "the strfry binary, for deleting wraps a recipient deletes")
	config := fs.String("config", "/etc/strfry.conf", "strfry's configuration")
	if err := fs.Parse(args); err != nil {
		return err
	}
	keflid, err := sql.Open("sqlite", "file:"+*dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	wraps, err := policy.OpenWraps(*wrapsPath)
	if err != nil {
		return err
	}
	p := policy.New(policy.NewDB(keflid, wraps), time.Now)
	return policy.Serve(in, out, p, wraps, func(ids []string) { deleteWraps(*strfry, *config, ids) })
}

// deleteWraps removes wraps from the relay's database with strfry's own command.
func deleteWraps(strfry, config string, ids []string) {
	filter, _ := json.Marshal(map[string]any{"ids": ids, "kinds": []int{policy.KindWrap}})
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if out, err := exec.CommandContext(ctx, strfry, "--config="+config, "delete", "--filter="+string(filter)).CombinedOutput(); err != nil {
		log.Printf("strfry delete: %v: %s", err, out)
	}
}
