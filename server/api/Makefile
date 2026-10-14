# keflid and the relay's write policy (backend spec, contract v1.5 sections 3.2, 5 and 6). Go runs in Docker's official
# image, so the host needs nothing but Docker; the module and build caches are named volumes. The whole repository is
# mounted, read from server/api, since the tests read the shared fixtures in shared/fixtures (F50).
GO_IMAGE = golang:1.26-bookworm
REPO = $$(cd "$(CURDIR)/../.." && pwd)
CACHES = -v kefli-gomod:/gomod -v kefli-gocache:/gocache
# Docker makes a fresh named volume root's, and Go runs as the calling user: the caches' roots are handed to that user
# first, as on a CI runner that has never built here
OWN = docker run --rm $(CACHES) $(GO_IMAGE) chown $$(id -u):$$(id -g) /gomod /gocache
GO = $(OWN) && docker run --rm -u $$(id -u):$$(id -g) -e HOME=/tmp -e GOPATH=/tmp/gopath -e GOMODCACHE=/gomod -e GOCACHE=/gocache -e "GOFLAGS=-mod=mod -buildvcs=false" -e CGO_ENABLED=0 \
	$(CACHES) -v "$(REPO)":/repo -w /repo/server/api $(GO_IMAGE) go

.PHONY: test build tidy cover
test:
	$(GO) test ./...
build:
	mkdir -p bin && $(GO) build -trimpath -o bin/ ./cmd/...
tidy:
	$(GO) mod tidy
cover:
	$(GO) test -coverpkg=./... -coverprofile=coverage.out ./...
