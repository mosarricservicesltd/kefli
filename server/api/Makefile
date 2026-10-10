# keflid and the relay's write policy (backend spec, contract v1.5 sections 3.2, 5 and 6). Go runs in Docker's official
# image, so the host needs nothing but Docker; the module cache is a named volume.
GO_IMAGE = golang:1.26-bookworm
GO = docker run --rm -u $$(id -u):$$(id -g) -e HOME=/tmp -e GOPATH=/tmp/gopath -e GOMODCACHE=/gomod -e GOCACHE=/gocache -e GOFLAGS=-mod=mod -e CGO_ENABLED=0 \
	-v kefli-gomod:/gomod -v kefli-gocache:/gocache -v "$(CURDIR)":/src -w /src $(GO_IMAGE) go

.PHONY: test build tidy cover
test:
	$(GO) test ./...
build:
	mkdir -p bin && $(GO) build -trimpath -o bin/ ./cmd/...
tidy:
	$(GO) mod tidy
cover:
	$(GO) test -coverpkg=./... -coverprofile=coverage.out ./...
