// kefli-writepolicy is the operator relay's write policy (contract 3.2), launched by strfry as relay.writePolicy.plugin.
// It reads the allowlist and the authorised devices from keflid's database, read-only; keeps its own record of the gift
// wraps the relay holds, for the deletion rules; and removes with strfry delete the wraps a recipient deletes, which
// strfry's own NIP-09 handling wouldn't. The rules and the record are internal/policy's. With -min-free-mb, every new
// event waits while the disk under -room has less than that free, so the relay never fills the disk it shares with
// keflid's database.
//
//	kefli-writepolicy -db /data/keflid.db -wraps /data/wraps.db -strfry /app/strfry -config /etc/strfry.conf \
//	    -room /data/db -min-free-mb 2048
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
	room := fs.String("room", ".", "a directory on the disk strfry's database is on, whose free space -min-free-mb counts")
	minFree := fs.Int64("min-free-mb", 0, "free space below which every new event waits, in MB; 0 sets no floor")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *minFree < 0 {
		return errors.New("-min-free-mb isn't a number of megabytes")
	}
	keflid, err := sql.Open("sqlite", "file:"+*dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	wraps, err := policy.OpenWraps(*wrapsPath)
	if err != nil {
		return err
	}
	prune(wraps, keflid)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go pruneEvery(ctx, wraps, keflid, policy.PruneEvery)
	p := policy.New(policy.NewDB(keflid, wraps), time.Now)
	if *minFree > 0 {
		p.Full = policy.Floor(*room, *minFree<<20, policy.DiskFree, time.Now)
	}
	return policy.Serve(in, out, p, wraps, func(ids []string) { deleteWraps(*strfry, *config, ids) })
}

// prune keeps the wrap record to what the relay holds (F45).
func prune(wraps, keflid *sql.DB) {
	if err := policy.PruneWraps(wraps, keflid, time.Now()); err != nil {
		log.Printf("prune: %v", err)
	}
}

// pruneEvery prunes every so often until ctx ends; strfry keeps the plugin running for as long as it runs.
func pruneEvery(ctx context.Context, wraps, keflid *sql.DB, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			prune(wraps, keflid)
		}
	}
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
