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
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// MaxBlob caps one upload (backend spec 3.2: 8 MB); a page's HTML is at most 2 MB before encryption (contract 4.4).
const MaxBlob = 8 << 20

// MaxRead is the most of a refused upload's body read before its refusal is answered (writeBeforeBody): MaxBlob and
// the megabyte more that Caddy in front lets through (9 MB).
const MaxRead = MaxBlob + 1<<20

type Server struct {
	Dir  string
	Base string // public address blobs are served from, such as https://blossom.kefli.app
	// MinFree is the space an upload must leave free on the blobs' disk, which the databases and the relay share: the
	// quotas are per account, so only this bounds what every account together can fill (F8). 0 sets no floor.
	MinFree int64
	// Free is the space free for dir's filesystem; the disk's, from statfs, unless a test says otherwise.
	Free func(dir string) (int64, error)
	st   *store.Store
	log  *slog.Logger
	// commitMu makes an upload's check of the limits, its rename and its owner row one step (F2), and an unlink's
	// check that no owner holds the blob and the file's removal another
	commitMu sync.Mutex
}

func New(dir, base string, st *store.Store, log *slog.Logger) *Server {
	return &Server{Dir: dir, Base: strings.TrimRight(base, "/"), Free: diskFree, st: st, log: log}
}

func diskFree(dir string) (int64, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return 0, err
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("PUT /upload", s.upload)
	mux.HandleFunc("HEAD /upload", s.preflight)
	mux.HandleFunc("GET /{blob}", s.get)
	mux.HandleFunc("HEAD /{blob}", s.get)
	mux.HandleFunc("DELETE /{blob}", s.remove)
}

// refusal is an answer refusing a request: its status, the reason for X-Reason and the body, and for the two limits'
// 413s the library's figures (contract 5). The zero refusal refuses nothing.
type refusal struct {
	status  int
	reason  string
	figures *store.Figures
}

var (
	serverFault   = refusal{status: http.StatusInternalServerError, reason: "server"}
	notRegistered = refusal{status: http.StatusUnauthorized, reason: "not_registered"}
)

// refused is a refusal's body, {"v":1,"error":<reason>}, with quota, used, daily and today added for 413 quota and
// daily, as GET /account gives them (contract 5, 6).
type refused struct {
	V     int    `json:"v"`
	Error string `json:"error"`
	*store.Figures
}

// write answers the refusal: the status, and the reason in X-Reason, where clients read it (BUD-01), and in the body.
func (rf refusal) write(w http.ResponseWriter) {
	w.Header().Set("X-Reason", rf.reason)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(rf.status)
	_ = json.NewEncoder(w).Encode(refused{V: 1, Error: rf.reason, Figures: rf.figures})
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
// spec 7's disk-full drill expects.
func (s *Server) room(size int64) refusal {
	if s.MinFree <= 0 {
		return refusal{}
	}
	free, err := s.Free(s.Dir)
	if err != nil {
		s.log.Error("free space", "err", err)
		return serverFault
	}
	if free-size < s.MinFree {
		s.log.Error("uploads held: the disk is nearly full", "free", free, "floor", s.MinFree)
		return refusal{status: http.StatusInsufficientStorage, reason: "storage"}
	}
	return refusal{}
}

// limits holds an upload to its library's fair use (contract 5, flow decision 117). Against the quota it costs its
// size unless the library holds the blob already, each blob counting once whichever of the library's keys uploaded
// it; against the day it costs its size unless the server stores the blob already, for this library or any other, as
// after a move. Past the quota it gets 413 quota, which also answers an upload past both, and past the day 413 daily,
// each with the library's figures. A library above its quota, as one lowered from 200 MB may be, keeps every blob it
// holds and takes no new one until deleting brings it back within its quota.
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
	switch {
	case !held && f.Used+size > f.Quota:
		return refusal{status: http.StatusRequestEntityTooLarge, reason: "quota", figures: &f}
	case !stored && f.Today+size > f.Daily:
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
	if rf.status != 0 {
		writeBeforeBody(w, r, rf)
		return
	}
	tmp, size, err := s.receive(r.Body, sha)
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
func (s *Server) receive(body io.Reader, sha string) (string, int64, error) {
	dir := filepath.Dir(s.path(sha))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", 0, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(body, MaxBlob+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	switch {
	case err != nil:
		return tmp.Name(), 0, err
	case n > MaxBlob:
		return tmp.Name(), 0, errTooLarge
	case hex.EncodeToString(h.Sum(nil)) != sha:
		return tmp.Name(), 0, errHash
	}
	return tmp.Name(), n, nil
}

// commit checks the real size against the library's limits again, renames the received file into place, so a reader
// never sees half a blob, and records the owner, with the upload in the day's log when the blob is new to the disk.
// One at a time, so concurrent uploads can't each pass the checks and together overshoot the quota or the day (F2);
// keflid is a single process. A blob already stored is replaced by identical bytes.
func (s *Server) commit(r *http.Request, up *uploader, sha string, size int64, tmp string) refusal {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if rf := s.limits(r.Context(), up, sha, size); rf.status != 0 {
		return rf
	}
	if err := os.Rename(tmp, s.path(sha)); err != nil {
		s.log.Error("store blob", "err", err)
		return serverFault
	}
	if err := s.st.Upload(r.Context(), sha, up.signer, up.account, size, up.inbox); err != nil {
		s.log.Error("record blob", "err", err)
		return serverFault
	}
	return refusal{}
}

// SweepFiles removes blob files no owner holds and upload temporaries, each once older than an hour so an upload
// still between its rename and its owner row is left alone: what a refused upload left before F2's fix, or a
// crash mid-upload. Returns how many it removed.
func (s *Server) SweepFiles(ctx context.Context, now time.Time) (int, error) {
	removed := 0
	err := filepath.WalkDir(s.Dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || ctx.Err() != nil {
			return ctx.Err()
		}
		info, err := d.Info()
		if err != nil || now.Sub(info.ModTime()) < time.Hour {
			return nil
		}
		name := d.Name()
		if !strings.HasPrefix(name, ".upload-") {
			if !auth.IsHex64(name) {
				return nil
			}
			held, err := s.st.Exists(ctx, name)
			if err != nil || held {
				return err
			}
		}
		if os.Remove(p) == nil {
			removed++
		}
		return nil
	})
	return removed, err
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
	sha := blobHash(r)
	if sha == "" {
		refuse(w, http.StatusNotFound, "not_found")
		return
	}
	ok, err := s.st.Exists(r.Context(), sha)
	if err != nil || !ok {
		refuse(w, http.StatusNotFound, "not_found")
		return
	}
	f, err := os.Open(s.path(sha))
	if err != nil {
		refuse(w, http.StatusNotFound, "not_found")
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, "", time.Time{}, f)
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
