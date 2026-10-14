// Package blossom is the operator's blob store (contract 5, backend spec 3.2): uploads authorised by a registered user
// or an authorised device key and held to the user's fair use, by default 50 MB kept and 20 MB of new bytes a day,
// device uploads kept as inbox blobs for 14 days, a blob kept until its last owner deletes it, served to anyone by
// hash, and nothing listed. Every blob is ciphertext.
package blossom

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
	"github.com/richardminton-glitch/Kefli/server/api/internal/limit"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// MaxBlob caps one upload (backend spec 3.2: 8 MB); a page's HTML is at most 2 MB before encryption (contract 4.4).
const MaxBlob = 8 << 20

// MaxRead is the most of a refused upload's body read before its refusal is answered (writeBeforeBody): MaxBlob and
// the megabyte more that Caddy in front lets through (9 MB).
const MaxRead = MaxBlob + 1<<20

// MaxInFlight is how many uploads one account may have going at once: each may write MaxBlob to the disk before it is
// counted against the quota, and the phone sends one at a time.
const MaxInFlight = 8

// MaxAddressCalls is how many signed requests, uploads, preflights and deletes, one address (an IPv6 /64) makes of the
// blob store a minute, counted before anything is read, verified or asked of the database. Nothing bounded them: any
// key may sign a preflight or a delete, and one client sending them as fast as it could held keflid's database
// connection for everyone. The phone sends one request at a time, each a round trip and a signature, so tens a second
// at the most, as when it deletes a whole library's texts in Delete my data. A blob's GET or HEAD is no address's call
// (MaxBlobSends).
const MaxAddressCalls = 6000

// MaxBlockCalls is the same a minute for one IPv6 /48, whose 65,536 /64s would otherwise each make MaxAddressCalls.
const MaxBlockCalls = 30_000

// MaxBlobSends is how many times one blob is sent an hour, a GET or a HEAD each, whoever asks. Anyone may fetch any
// blob by its hash, so one client asking for an 8 MB blob of its own again and again could take the server's whole
// link, which every user's uploads and every mirror's copies share. Counted by the address that asks instead, every
// user's texts would share the count of the one address a mirror fetches them from (contract 4.2, BUD-04), which an
// attacker could spend through the mirror itself, and everyone behind a carrier's shared address would share one. A
// blob is fetched once by each mirror that copies it, once by each phone that syncs or restores it and once by a
// move's check, so a few times in an hour at the most: sixteen sends of an 8 MB blob are 128 MB, and a library's 50 MB
// sent sixteen times an hour is 800 MB. A request for a blob whose file isn't on the disk costs a look at the disk
// alone, and counts against nothing.
const MaxBlobSends = 16

type Server struct {
	Dir  string
	Base string // public address blobs are served from, such as https://blossom.kefli.app
	// TrustProxy reads the client's address from X-Forwarded-For, set by Caddy in front.
	TrustProxy bool
	// MinFree is the space an upload must leave free on the blobs' disk, which the databases and the relay share: the
	// quotas are per account, so only this bounds what every account together can fill (F8). 0 sets no floor.
	MinFree int64
	// Free is the space free for dir's filesystem; the disk's, from statfs, unless a test says otherwise.
	Free func(dir string) (int64, error)
	// FreeFiles is how many files dir's filesystem has free and in all, from statfs unless a test says otherwise.
	FreeFiles func(dir string) (free, total int64, err error)
	st        *store.Store
	log       *slog.Logger
	// commitMu makes an upload's check of the limits, its rename and its owner row one step (F2), and an unlink's
	// check that no owner holds the blob and the file's removal another
	commitMu sync.Mutex
	// flightMu guards the uploads in flight: their bytes, which count against MinFree until they finish, and how many
	// each account has going, and their bytes
	flightMu sync.Mutex
	inflight int64
	flights  map[string]flight
	// calls and blockCalls count signed requests per address and per IPv6 /48, MaxAddressCalls and MaxBlockCalls a minute
	calls, blockCalls *limit.Limiter
	// sends counts each blob's GETs and HEADs, MaxBlobSends an hour
	sends *limit.Limiter
}

func New(dir, base string, st *store.Store, log *slog.Logger) *Server {
	return &Server{
		Dir: dir, Base: strings.TrimRight(base, "/"), Free: diskFree, FreeFiles: diskFiles, st: st, log: log, flights: map[string]flight{},
		calls:      limit.New(MaxAddressCalls, time.Minute, st.Now),
		blockCalls: limit.New(MaxBlockCalls, time.Minute, st.Now),
		sends:      limit.New(MaxBlobSends, time.Hour, st.Now),
	}
}

func statfs(dir string) (*syscall.Statfs_t, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func diskFree(dir string) (int64, error) {
	st, err := statfs(dir)
	if err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

func diskFiles(dir string) (int64, int64, error) {
	st, err := statfs(dir)
	if err != nil {
		return 0, 0, err
	}
	return int64(st.Ffree), int64(st.Files), nil
}

func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /upload", s.limited(s.upload))
	mux.HandleFunc("HEAD /upload", s.limited(s.preflight))
	mux.HandleFunc("GET /{blob}", s.get)
	mux.HandleFunc("HEAD /{blob}", s.get)
	mux.HandleFunc("DELETE /{blob}", s.limited(s.remove))
}

// limited counts a signed request against its IPv6 /48 and then its address, an IPv6 /64, before next reads or
// verifies anything, so a flood from one place costs a map lookup each; past either, the request gets 429 rate with
// Retry-After, which the phone and the extension send again later.
func (s *Server) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rf := s.callAllowed(r); rf.status != 0 {
			rf.write(w)
			return
		}
		next(w, r)
	}
}

func (s *Server) callAllowed(r *http.Request) refusal {
	ip := limit.ClientIP(r, s.TrustProxy)
	if block := limit.Block(ip); strings.Contains(block, ":") {
		if ok, retry := s.blockCalls.Allow(block); !ok {
			return refusal{status: http.StatusTooManyRequests, reason: "rate", retry: retry}
		}
	}
	if ok, retry := s.calls.Allow(limit.Addr(ip, 64)); !ok {
		return refusal{status: http.StatusTooManyRequests, reason: "rate", retry: retry}
	}
	return refusal{}
}

// refusal is an answer refusing a request: its status, the reason for X-Reason and the body, for the two limits'
// 413s the library's figures (contract 5), and for a 429 when to send again, ten seconds unless set. The zero refusal
// refuses nothing.
type refusal struct {
	status  int
	reason  string
	figures *store.Figures
	retry   time.Duration
}

var (
	serverFault   = refusal{status: http.StatusInternalServerError, reason: "server"}
	notRegistered = refusal{status: http.StatusUnauthorized, reason: "not_registered"}
	diskFull      = refusal{status: http.StatusInsufficientStorage, reason: "storage"}
	tooMany       = refusal{status: http.StatusTooManyRequests, reason: "rate"}
)

// refused is a refusal's body, {"v":1,"error":<reason>}, with quota, used, daily and today added for 413 quota and
// daily, as GET /account gives them (contract 5, 6).
type refused struct {
	V     int    `json:"v"`
	Error string `json:"error"`
	*store.Figures
}

// write answers the refusal: the status, and the reason in X-Reason, where clients read it (BUD-01), and in the body.
// A 429 also says when to send again, in whole seconds rounded up.
func (rf refusal) write(w http.ResponseWriter) {
	w.Header().Set("X-Reason", rf.reason)
	w.Header().Set("Content-Type", "application/json")
	if rf.status == http.StatusTooManyRequests {
		w.Header().Set("Retry-After", retryAfter(rf.retry))
	}
	w.WriteHeader(rf.status)
	_ = json.NewEncoder(w).Encode(refused{V: 1, Error: rf.reason, Figures: rf.figures})
}

// retryAfter is Retry-After's whole seconds for a wait, rounded up, and ten when none is known.
func retryAfter(d time.Duration) string {
	if d <= 0 {
		return "10"
	}
	return strconv.Itoa(int((d + time.Second - 1) / time.Second))
}

// refuse answers a Blossom error with no figures.
func refuse(w http.ResponseWriter, status int, reason string) {
	refusal{status: status, reason: reason}.write(w)
}

// actedOn is whether the client must read this refusal to act on it (contract 4.2, 5): 413 for room or size and 507
// for a full disk, after which the phone sends the save without its text. To any other it answers as to a network
// failure, by trying again.
func (rf refusal) actedOn() bool {
	return rf.status == http.StatusRequestEntityTooLarge || rf.status == http.StatusInsufficientStorage
}

// writeBeforeBody answers a refusal reached before the upload's body is read. One the client acts on waits for the
// rest of the body, up to MaxRead: a client that sends its whole body before it reads, as the phone's HTTP client
// (OkHttp 4.9.2) does, otherwise meets a connection the server closes under it once more than 256 KB is left unread,
// and gets a reset in place of the answer. A client that asked to be told first (Expect: 100-continue) hasn't sent its
// body, and is answered at once.
func writeBeforeBody(w http.ResponseWriter, r *http.Request, rf refusal) {
	if rf.actedOn() && !strings.EqualFold(r.Header.Get("Expect"), "100-continue") {
		_, _ = io.CopyN(io.Discard, r.Body, MaxRead)
	}
	rf.write(w)
}

func (s *Server) path(sha string) string {
	return filepath.Join(s.Dir, sha[:2], sha)
}

// Unlink removes a blob's file once no owner holds it. It checks again under the upload lock, so a blob an upload has
// just renamed into place and recorded, between the caller's delete and this, keeps its file.
func (s *Server) Unlink(sha string) {
	if !auth.IsHex64(sha) {
		return
	}
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	s.unlinkLocked(sha)
}

// unlinkLocked is Unlink for a caller holding commitMu.
func (s *Server) unlinkLocked(sha string) {
	if held, err := s.st.Stored(context.Background(), sha); err != nil || held {
		return
	}
	if err := os.Remove(s.path(sha)); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.log.Error("unlink", "err", err)
	}
}

// uploader is who an upload counts against: a registered user for their own blobs, or the user a device key uploads
// for, as an inbox blob.
type uploader struct {
	signer, account string
	inbox           bool
}

func (s *Server) whoUploads(r *http.Request, signer string) (*uploader, error) {
	if _, ok, err := s.st.Account(r.Context(), signer); err != nil || ok {
		return &uploader{signer: signer, account: signer}, err
	}
	user, ok, err := s.st.DeviceUser(r.Context(), signer)
	if err != nil || !ok {
		return nil, err
	}
	return &uploader{signer: signer, account: user, inbox: true}, nil
}

// allowed checks one upload before its body is read: the authorisation, the uploader, the size and the library's
// limits. It is BUD-06's preflight and the upload's first step; the zero refusal lets the upload go ahead.
func (s *Server) allowed(r *http.Request, sha string, size int64) (*uploader, refusal) {
	ev, err := auth.Blossom(r.Header.Get("Authorization"), "upload", sha, s.st.Now())
	if err != nil {
		return nil, refusal{status: http.StatusUnauthorized, reason: "auth: " + err.Error()}
	}
	up, err := s.whoUploads(r, ev.PubKey)
	if err != nil {
		return nil, serverFault
	}
	if up == nil {
		return nil, notRegistered
	}
	if size > MaxBlob {
		return nil, refusal{status: http.StatusRequestEntityTooLarge, reason: "too_large"}
	}
	if rf := s.room(size); rf.status != 0 {
		return nil, rf
	}
	return up, s.limits(r.Context(), up, sha, size)
}

// room refuses an upload that would leave less than MinFree on the disk with 507, which clients retry later, as backend
// spec 7's disk-full drill expects; and so one that would leave less than a tenth of the disk's files free, since every
// blob is a file: each library's blobs count as a disk block at least (store.Cost), which bounds the files one library
// holds, and this bounds what every library together can take of the inodes every writer on the disk needs. The bytes
// of uploads in flight count as used.
func (s *Server) room(size int64) refusal {
	s.flightMu.Lock()
	defer s.flightMu.Unlock()
	return s.roomLocked(size)
}

// roomLocked is room for a caller holding flightMu.
func (s *Server) roomLocked(size int64) refusal {
	if s.MinFree <= 0 {
		return refusal{}
	}
	free, err := s.Free(s.Dir)
	if err != nil {
		s.log.Error("free space", "err", err)
		return serverFault
	}
	if free-s.inflight-size < s.MinFree {
		s.log.Error("uploads held: the disk is nearly full", "free", free, "in_flight", s.inflight, "floor", s.MinFree)
		return diskFull
	}
	return s.roomForFile()
}

// roomForFile keeps a tenth of the disk's files free, on a filesystem that counts them.
func (s *Server) roomForFile() refusal {
	files, total, err := s.FreeFiles(s.Dir)
	if err != nil {
		s.log.Error("free files", "err", err)
		return serverFault
	}
	if total > 0 && files-1 < total/10 {
		s.log.Error("uploads held: the disk's files are nearly used up", "free", files, "total", total)
		return diskFull
	}
	return refusal{}
}

// flight is an account's uploads in flight: how many, and the bytes they said they would send.
type flight struct {
	n     int
	bytes int64
}

// takeOff counts an upload as in flight, once its account has fewer than MaxInFlight going and no more than a day's
// uploads in bytes with it (429 otherwise), and the disk has room for it beside the others in flight (507), in one
// step so uploads at once can't each pass alone; land, deferred, ends it. Each in flight holds its size against the
// floor until it lands, and of a library's uploads at most a day's can be taken, so the rest would only hold the
// floor: eight slow 8 MB bodies held 64 MB of it for each library, for as long as they took to arrive.
func (s *Server) takeOff(account string, size int64) refusal {
	s.flightMu.Lock()
	defer s.flightMu.Unlock()
	f := s.flights[account]
	if f.n >= MaxInFlight || f.bytes+size > store.DailyLimit {
		return tooMany
	}
	if rf := s.roomLocked(size); rf.status != 0 {
		return rf
	}
	s.inflight += size
	s.flights[account] = flight{n: f.n + 1, bytes: f.bytes + size}
	return refusal{}
}

func (s *Server) land(account string, size int64) {
	s.flightMu.Lock()
	defer s.flightMu.Unlock()
	s.inflight -= size
	f := s.flights[account]
	if f.n <= 1 {
		delete(s.flights, account)
		return
	}
	s.flights[account] = flight{n: f.n - 1, bytes: f.bytes - size}
}

// limits holds an upload to its library's fair use (contract 5, flow decision 117). It costs its size, and never less
// than a disk block (store.Cost), since its file takes one however small it is. Against the quota it costs that
// unless the library holds the blob already, each blob counting once whichever of the library's keys uploaded it;
// against the day, unless the server stores the blob already, for this library or any other, as after a move. Past the
// quota it gets 413 quota, which also answers an upload past both, and past the day 413 daily, each with the library's
// figures. A library above its quota, as one lowered from 200 MB may be, keeps every blob it holds and takes no new one
// until deleting brings it back within its quota.
func (s *Server) limits(ctx context.Context, up *uploader, sha string, size int64) refusal {
	f, ok, err := s.st.Figures(ctx, up.account)
	if err != nil {
		return serverFault
	}
	if !ok {
		return notRegistered // the account went while its upload was on its way
	}
	held, stored, err := s.costs(ctx, up.account, sha)
	if err != nil {
		return serverFault
	}
	cost := store.Cost(size)
	switch {
	case !held && f.Used+cost > f.Quota:
		return refusal{status: http.StatusRequestEntityTooLarge, reason: "quota", figures: &f}
	case !stored && f.Today+cost > f.Daily:
		return refusal{status: http.StatusRequestEntityTooLarge, reason: "daily", figures: &f}
	}
	return refusal{}
}

// costs is whether the library holds the blob already, so it costs nothing against the quota, and whether the server
// stores it, for anyone, so it costs nothing against the day.
func (s *Server) costs(ctx context.Context, account, sha string) (held, stored bool, err error) {
	if held, err = s.st.Holds(ctx, account, sha); err != nil || held {
		return held, held, err
	}
	stored, err = s.st.Stored(ctx, sha)
	return false, stored, err
}

// preflight is BUD-06: may this upload go ahead, without sending it.
func (s *Server) preflight(w http.ResponseWriter, r *http.Request) {
	sha := strings.ToLower(r.Header.Get("X-SHA-256"))
	size, _ := strconv.ParseInt(r.Header.Get("X-Content-Length"), 10, 64)
	if !auth.IsHex64(sha) {
		refuse(w, http.StatusBadRequest, "sha256")
		return
	}
	if _, rf := s.allowed(r, sha, size); rf.status != 0 {
		rf.write(w)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// upload is BUD-02's PUT /upload: the body's hash must be the one authorised.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	sha := strings.ToLower(r.Header.Get("X-SHA-256"))
	if !auth.IsHex64(sha) {
		refuse(w, http.StatusBadRequest, "sha256")
		return
	}
	// a body of unknown length can't be checked against the limits before it is read (F2)
	if r.ContentLength < 0 {
		refuse(w, http.StatusLengthRequired, "length")
		return
	}
	up, rf := s.allowed(r, sha, r.ContentLength)
	if rf.status == 0 {
		rf = s.takeOff(up.account, r.ContentLength)
	}
	if rf.status != 0 {
		writeBeforeBody(w, r, rf)
		return
	}
	defer s.land(up.account, r.ContentLength)
	tmp, size, err := s.receive(r.Body, sha, s.onDisk(r.Context(), sha))
	if tmp != "" {
		defer os.Remove(tmp) // gone once renamed; otherwise a refused upload leaves nothing behind (F2)
	}
	if err != nil {
		s.refuseWrite(w, err)
		return
	}
	if rf := s.commit(r, up, sha, size, tmp); rf.status != 0 {
		rf.write(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"url": s.Base + "/" + sha, "sha256": sha, "size": size, "type": "application/octet-stream", "uploaded": s.st.Now().Unix()})
}

var (
	errTooLarge = errors.New("too_large")
	errHash     = errors.New("hash")
)

func (s *Server) refuseWrite(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errTooLarge):
		refuse(w, http.StatusRequestEntityTooLarge, "too_large")
	case errors.Is(err, errHash):
		refuse(w, http.StatusBadRequest, "hash")
	default:
		s.log.Error("write blob", "err", err)
		refuse(w, http.StatusInternalServerError, "server")
	}
}

// receive reads the body into a temporary file beside where the blob will live, and returns its path (for the caller
// to remove) and size. The body's hash must be sha.
func (s *Server) receive(body io.Reader, sha string, onDisk bool) (string, int64, error) {
	if onDisk {
		n, err := copyChecked(io.Discard, body, sha)
		return "", n, err
	}
	dir := filepath.Dir(s.path(sha))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", 0, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return "", 0, err
	}
	n, err := copyChecked(tmp, body, sha)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return tmp.Name(), 0, err
	}
	return tmp.Name(), n, nil
}

// copyChecked copies a body of at most MaxBlob to w and checks that it hashes to sha.
func copyChecked(w io.Writer, body io.Reader, sha string) (int64, error) {
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(body, MaxBlob+1))
	switch {
	case err != nil:
		return 0, err
	case n > MaxBlob:
		return 0, errTooLarge
	case hex.EncodeToString(h.Sum(nil)) != sha:
		return 0, errHash
	}
	return n, nil
}

// onDisk is whether the blob's file is on the disk for an owner already, as for a repeat upload, a move's or a
// browser's copy of a blob its library holds: its body is then checked against the hash and not written again. A
// copy costs no fair use, and each was written whole and renamed over identical bytes, so one address could keep the
// disk writing at the link's rate, 8 MB a request.
func (s *Server) onDisk(ctx context.Context, sha string) bool {
	if held, err := s.st.Stored(ctx, sha); err != nil || !held {
		return false
	}
	_, err := os.Stat(s.path(sha))
	return err == nil
}

// commit checks the real size against the library's limits again, renames the received file into place, so a reader
// never sees half a blob, and records the owner, with the upload in the day's log when the blob is new to the disk.
// One at a time, so concurrent uploads can't each pass the checks and together overshoot the quota or the day (F2);
// keflid is a single process. A blob already stored is replaced by identical bytes.
//
// Who sent it is asked again first, since a browser can be disconnected or an account deleted while its body arrives;
// and the owner row is written only while that account (and browser) still stands (store.Upload), so a deletion
// between the two leaves no blob behind it either: a record refused takes back the file it put in place unless
// another owner holds it.
func (s *Server) commit(r *http.Request, up *uploader, sha string, size int64, tmp string) refusal {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	now, err := s.whoUploads(r, up.signer)
	switch {
	case err != nil:
		return serverFault
	case now == nil || now.account != up.account:
		return notRegistered
	}
	if rf := s.limits(r.Context(), now, sha, size); rf.status != 0 {
		return rf
	}
	if rf := s.place(sha, tmp); rf.status != 0 {
		return rf
	}
	err = s.st.Upload(r.Context(), sha, now.signer, now.account, size, now.inbox)
	if err == nil {
		return refusal{}
	}
	s.unlinkLocked(sha)
	if errors.Is(err, store.ErrNoAccount) {
		return notRegistered
	}
	s.log.Error("record blob", "err", err)
	return serverFault
}

// place puts a received blob where it is served, for a caller holding commitMu: its file renamed into place, so a reader
// never sees half a blob, or, for a body that wasn't written (onDisk), the file found there still. One that went while
// the body arrived, its last owner having deleted it, answers 500, which the client sends again, and then it is
// written.
func (s *Server) place(sha, tmp string) refusal {
	if tmp == "" {
		if _, err := os.Stat(s.path(sha)); err != nil {
			s.log.Info("a stored blob's file went as a copy of it arrived", "err", err)
			return serverFault
		}
		return refusal{}
	}
	if err := os.Rename(tmp, s.path(sha)); err != nil {
		s.log.Error("store blob", "err", err)
		return serverFault
	}
	return refusal{}
}

// SweepFiles removes blob files no owner holds and upload temporaries, each once older than an hour so an upload
// still between its rename and its owner row is left alone: what a refused upload left before F2's fix, a crash
// mid-upload, or a capture its library's figures let go of once it expired. Returns how many it removed.
func (s *Server) SweepFiles(ctx context.Context, now time.Time) (int, error) {
	removed := 0
	err := filepath.WalkDir(s.Dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || ctx.Err() != nil {
			return ctx.Err()
		}
		gone, err := s.sweepFile(ctx, p, d, now)
		if gone {
			removed++
		}
		return err
	})
	return removed, err
}

// sweepFile removes one file the sweep finds when it is an hour old and an upload's temporary, or a blob's file no
// owner holds.
func (s *Server) sweepFile(ctx context.Context, p string, d fs.DirEntry, now time.Time) (bool, error) {
	info, err := d.Info()
	if err != nil || now.Sub(info.ModTime()) < time.Hour {
		return false, nil
	}
	name := d.Name()
	if strings.HasPrefix(name, ".upload-") {
		return os.Remove(p) == nil, nil
	}
	if !auth.IsHex64(name) {
		return false, nil
	}
	if held, err := s.st.Exists(ctx, name); err != nil || held {
		return false, err
	}
	return s.removeUnheld(ctx, name, p)
}

// removeUnheld removes a blob's file once no owner holds it, checked again under the upload lock, as Unlink is: an
// upload of the same blob may have renamed its file into place and recorded its owner since the sweep looked, and
// removing the file then would leave a blob recorded, and counted, that nobody can be served.
func (s *Server) removeUnheld(ctx context.Context, name, p string) (bool, error) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if held, err := s.st.Exists(ctx, name); err != nil || held {
		return false, err
	}
	return os.Remove(p) == nil, nil
}

// blobHash reads /<sha256> with any file extension (BUD-01).
func blobHash(r *http.Request) string {
	name := r.PathValue("blob")
	if i := strings.IndexByte(name, '.'); i >= 0 {
		name = name[:i]
	}
	if !auth.IsHex64(name) {
		return ""
	}
	return name
}

// get serves a blob to anyone who knows its hash, with byte ranges; ciphertext, so never a type a browser would run.
func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	f, rf := s.openBlob(r)
	if rf.status != 0 {
		rf.write(w)
		return
	}
	defer f.Close()
	// one range at most: each range of many is a part of its own, and 20,000 one-byte ranges of a 1 MB blob cost three
	// and a half seconds; no client asks for more than one, and the whole blob is anyone's for the asking anyway
	if strings.Contains(r.Header.Get("Range"), ",") {
		r.Header.Del("Range")
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, "", time.Time{}, f)
}

var notFound = refusal{status: http.StatusNotFound, reason: "not_found"}

// openBlob opens the blob a GET or HEAD names, once its file is on the disk, it has a send left this hour and an owner
// holds it, in that order: a request for a blob whose file isn't there is answered from the disk alone, so it costs no
// database lookup and fills no count, and one for a blob that is there asks the database at most MaxBlobSends times an
// hour. A 404 tells the phone a browser's capture is gone, so it fetches the page itself (contract 4.4, v1.12): a
// fault here is a 500, which it tries again, and a blob past its sends a 429, never a 404.
func (s *Server) openBlob(r *http.Request) (*os.File, refusal) {
	sha := blobHash(r)
	if sha == "" {
		return nil, notFound
	}
	f, err := os.Open(s.path(sha))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, notFound
	}
	if err != nil {
		return nil, serverFault
	}
	if rf := s.servable(r.Context(), sha); rf.status != 0 {
		f.Close()
		return nil, rf
	}
	return f, refusal{}
}

// servable counts a send of a blob whose file is on the disk against its MaxBlobSends an hour, the whole blob even for
// a range, and asks whether an owner holds it, as an expired capture's file still on the disk isn't held: past its
// sends a blob gets 429 rate with Retry-After from every address alike, before the database is asked.
func (s *Server) servable(ctx context.Context, sha string) refusal {
	if ok, retry := s.sends.Allow(sha); !ok {
		return refusal{status: http.StatusTooManyRequests, reason: "rate", retry: retry}
	}
	held, err := s.st.Exists(ctx, sha)
	if err != nil {
		return serverFault
	}
	if !held {
		return notFound
	}
	return refusal{}
}

// remove is BUD-02's DELETE: the caller's ownership goes, a user's taking every upload of the blob counted against
// them, their browsers' included (contract 5), and the file with it once no owner remains.
func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	sha := blobHash(r)
	ev, err := auth.Blossom(r.Header.Get("Authorization"), "delete", sha, s.st.Now())
	if sha == "" || err != nil {
		refuse(w, http.StatusUnauthorized, "auth")
		return
	}
	found, orphaned, err := s.st.RemoveOwner(r.Context(), sha, ev.PubKey)
	if err != nil {
		refuse(w, http.StatusInternalServerError, "server")
		return
	}
	if !found {
		refuse(w, http.StatusNotFound, "not_found")
		return
	}
	for _, o := range orphaned {
		s.Unlink(o)
	}
	w.WriteHeader(http.StatusOK)
}
