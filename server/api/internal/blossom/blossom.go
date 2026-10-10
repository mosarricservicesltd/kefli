// Package blossom is the operator's blob store (contract 5, backend spec 3.2): uploads authorised by a registered user
// or an authorised device key and counted against the user's 200 MB, device uploads kept as inbox blobs for 14 days,
// a blob kept until its last owner deletes it, served to anyone by hash, and nothing listed. Every blob is ciphertext.
package blossom

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// MaxBlob caps one upload (backend spec 3.2: 8 MB); a page's HTML is at most 2 MB before encryption (contract 4.4).
const MaxBlob = 8 << 20

type Server struct {
	Dir  string
	Base string // public address blobs are served from, such as https://blossom.kefli.app
	st   *store.Store
	log  *slog.Logger
}

func New(dir, base string, st *store.Store, log *slog.Logger) *Server {
	return &Server{Dir: dir, Base: strings.TrimRight(base, "/"), st: st, log: log}
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
	return s.withinQuota(r, up, sha, size)
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
	up, status, reason := s.allowed(r, sha, r.ContentLength)
	if status != 0 {
		refuse(w, status, reason)
		return
	}
	size, err := s.write(r.Body, sha)
	if err != nil {
		s.refuseWrite(w, err)
		return
	}
	if _, status, reason := s.withinQuota(r, up, sha, size); status != 0 {
		refuse(w, status, reason)
		return
	}
	if err := s.st.AddOwner(r.Context(), sha, up.signer, up.account, size, up.inbox); err != nil {
		refuse(w, http.StatusInternalServerError, "server")
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

// write stores the body under its hash, through a temporary file renamed into place, so a reader never sees half a blob.
// The body's hash must be sha; a blob already stored is kept as it is.
func (s *Server) write(body io.Reader, sha string) (int64, error) {
	dir := filepath.Dir(s.path(sha))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(body, MaxBlob+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	switch {
	case err != nil:
		return 0, err
	case n > MaxBlob:
		return 0, errTooLarge
	case hex.EncodeToString(h.Sum(nil)) != sha:
		return 0, errHash
	}
	return n, os.Rename(tmp.Name(), s.path(sha))
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
