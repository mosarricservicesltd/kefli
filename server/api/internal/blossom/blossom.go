// Package blossom is the operator's blob store (contract 5, backend spec 3.2): uploads authorised by a registered user
// or an authorised device key and counted against the user's 200 MB, device uploads kept as inbox blobs for 14 days,
// a blob kept until its last owner deletes it, served to anyone by hash, and nothing listed. Every blob is ciphertext.
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

type Server struct {
	Dir  string
	Base string // public address blobs are served from, such as https://blossom.kefli.app
	// MinFree is the space an upload must leave free on the blobs' disk, which the databases and the relay share: the
	// quotas are per account, so only this bounds what every account together can fill (F8). 0 sets no floor.
	MinFree int64
	// Free is the space free for dir's filesystem; the disk's, from statfs, unless a test says otherwise.
	Free func(dir string) (int64, error)
	// FreeFiles is how many files dir's filesystem has free and in all, from statfs unless a test says otherwise.
	FreeFiles func(dir string) (free, total int64, err error)
	st   *store.Store
	log  *slog.Logger
	// commitMu makes an upload's quota check, rename and owner row one step (F2)
	commitMu sync.Mutex
}

func New(dir, base string, st *store.Store, log *slog.Logger) *Server {
	return &Server{Dir: dir, Base: strings.TrimRight(base, "/"), Free: diskFree, FreeFiles: diskFiles, st: st, log: log}
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
	mux.HandleFunc("PUT /upload", s.upload)
	mux.HandleFunc("HEAD /upload", s.preflight)
	mux.HandleFunc("GET /{blob}", s.get)
	mux.HandleFunc("HEAD /{blob}", s.get)
	mux.HandleFunc("DELETE /{blob}", s.remove)
}

// refuse answers a Blossom error: the status, and the reason in X-Reason, where clients read it (BUD-01).
func refuse(w http.ResponseWriter, status int, reason string) {
	w.Header().Set("X-Reason", reason)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"v": 1, "error": reason})
}

func (s *Server) path(sha string) string {
	return filepath.Join(s.Dir, sha[:2], sha)
}

// Unlink removes a blob's file once no owner holds it.
func (s *Server) Unlink(sha string) {
	if !auth.IsHex64(sha) {
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
	quota           int64
}

func (s *Server) whoUploads(r *http.Request, signer string) (*uploader, error) {
	if quota, ok, err := s.st.Account(r.Context(), signer); err != nil || ok {
		return &uploader{signer: signer, account: signer, quota: quota}, err
	}
	user, ok, err := s.st.DeviceUser(r.Context(), signer)
	if err != nil || !ok {
		return nil, err
	}
	quota, _, err := s.st.Account(r.Context(), user)
	return &uploader{signer: signer, account: user, inbox: true, quota: quota}, err
}

// allowed checks one upload before its body is read: the authorisation, the uploader and the size against the quota.
// It is BUD-06's preflight and the upload's first step; it returns the status and reason to refuse with, or 0.
func (s *Server) allowed(r *http.Request, sha string, size int64) (*uploader, int, string) {
	ev, err := auth.Blossom(r.Header.Get("Authorization"), "upload", sha, s.st.Now())
	if err != nil {
		return nil, http.StatusUnauthorized, "auth: " + err.Error()
	}
	up, err := s.whoUploads(r, ev.PubKey)
	if err != nil {
		return nil, http.StatusInternalServerError, "server"
	}
	if up == nil {
		return nil, http.StatusUnauthorized, "not_registered"
	}
	if size > MaxBlob {
		return nil, http.StatusRequestEntityTooLarge, "too_large"
	}
	if status, reason := s.room(size); status != 0 {
		return nil, status, reason
	}
	return s.withinQuota(r, up, sha, size)
}

// room refuses an upload that would leave less than MinFree on the disk with 507, which clients retry later, as backend
// spec 7's disk-full drill expects; and so one that would leave less than a tenth of the disk's files free, since every
// blob is a file and the quota counts only bytes, so tiny blobs could use up the inodes every writer on the disk needs.
func (s *Server) room(size int64) (int, string) {
	if s.MinFree <= 0 {
		return 0, ""
	}
	free, err := s.Free(s.Dir)
	if err != nil {
		s.log.Error("free space", "err", err)
		return http.StatusInternalServerError, "server"
	}
	if free-size < s.MinFree {
		s.log.Error("uploads held: the disk is nearly full", "free", free, "floor", s.MinFree)
		return http.StatusInsufficientStorage, "storage"
	}
	return s.roomForFile()
}

// roomForFile keeps a tenth of the disk's files free, on a filesystem that counts them.
func (s *Server) roomForFile() (int, string) {
	files, total, err := s.FreeFiles(s.Dir)
	if err != nil {
		s.log.Error("free files", "err", err)
		return http.StatusInternalServerError, "server"
	}
	if total > 0 && files-1 < total/10 {
		s.log.Error("uploads held: the disk's files are nearly used up", "free", files, "total", total)
		return http.StatusInsufficientStorage, "storage"
	}
	return 0, ""
}

func (s *Server) withinQuota(r *http.Request, up *uploader, sha string, size int64) (*uploader, int, string) {
	held, err := s.st.Holds(r.Context(), up.account, sha)
	if err != nil {
		return nil, http.StatusInternalServerError, "server"
	}
	used, err := s.st.Used(r.Context(), up.account)
	if err != nil {
		return nil, http.StatusInternalServerError, "server"
	}
	if !held && used+size > up.quota {
		return nil, http.StatusRequestEntityTooLarge, "quota"
	}
	return up, 0, ""
}

// preflight is BUD-06: may this upload go ahead, without sending it.
func (s *Server) preflight(w http.ResponseWriter, r *http.Request) {
	sha := strings.ToLower(r.Header.Get("X-SHA-256"))
	size, _ := strconv.ParseInt(r.Header.Get("X-Content-Length"), 10, 64)
	if !auth.IsHex64(sha) {
		refuse(w, http.StatusBadRequest, "sha256")
		return
	}
	if _, status, reason := s.allowed(r, sha, size); status != 0 {
		refuse(w, status, reason)
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
	// a body of unknown length can't be checked against the quota before it is read (F2)
	if r.ContentLength < 0 {
		refuse(w, http.StatusLengthRequired, "length")
		return
	}
	up, status, reason := s.allowed(r, sha, r.ContentLength)
	if status != 0 {
		refuse(w, status, reason)
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
	if status, reason := s.commit(r, up, sha, size, tmp); status != 0 {
		refuse(w, status, reason)
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

// commit checks the real size against the quota, renames the received file into place, so a reader never sees half
// a blob, and records the owner. One at a time, so concurrent uploads can't each pass the check and together
// overshoot the quota (F2); keflid is a single process. A blob already stored is replaced by identical bytes.
func (s *Server) commit(r *http.Request, up *uploader, sha string, size int64, tmp string) (int, string) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if _, status, reason := s.withinQuota(r, up, sha, size); status != 0 {
		return status, reason
	}
	if err := os.Rename(tmp, s.path(sha)); err != nil {
		s.log.Error("store blob", "err", err)
		return http.StatusInternalServerError, "server"
	}
	if err := s.st.AddOwner(r.Context(), sha, up.signer, up.account, size, up.inbox); err != nil {
		return http.StatusInternalServerError, "server"
	}
	return 0, ""
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

// remove is BUD-02's DELETE: the caller's ownership goes, and the file with it once no owner remains.
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
