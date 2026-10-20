#!/usr/bin/env bash
# Builds the website and puts it in /var/www/kefli on the operator's host, where Caddy serves it on the apex
# (server/deploy/README.md). The settings come from site.env, so a build here matches the one that is live.
#
#   apps/web/deploy.sh              test, build, upload, then check the live site serves this build
#   apps/web/deploy.sh --dry-run    test and build, and list what the upload would change
#   apps/web/deploy.sh --allow-dirty  deploy uncommitted changes (otherwise refused, so what is live is in git)
#
# KEFLI_SSH_HOST picks the host (default: the `kefli` alias in ~/.ssh/config).
# Files are compared by content, so an unchanged file is left alone. Nothing on the host is deleted: earlier
# hashed scripts and styles stay, so a page cached before this deploy still finds its own.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

host="${KEFLI_SSH_HOST:-kefli}"
dest="/var/www/kefli/"
dry_run=false
allow_dirty=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --allow-dirty) allow_dirty=true ;;
    *) echo "deploy.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

if ! $allow_dirty && [ -n "$(git status --porcelain -- .)" ]; then
  echo "deploy.sh: apps/web has uncommitted changes; commit them, or pass --allow-dirty" >&2
  git status --short -- . >&2
  exit 1
fi

[ -d node_modules ] || [ -d ../../node_modules ] || (cd ../.. && npm ci --no-audit --no-fund)

echo "== Tests and types"
npx jest
npx tsc --noEmit

echo "== Build"
npm run build

# A setting missing from site.env leaves its %VITE_…% placeholder in the page; never ship one.
if grep -rl '%VITE_[A-Z_]*%' dist --include='*.html'; then
  echo "deploy.sh: the pages above still hold a %VITE_…% placeholder; add the setting to site.env" >&2
  exit 1
fi

rsync_opts=(-rlcz --itemize-changes --chmod=D755,F644)

# Caddy tells browsers to keep /assets, /media and /fonts for a year without asking again (README, Serving it),
# and there is no cache on the server to clear: a file changed under one of those names would sit behind every
# visitor's old copy until next year. So a changed file there is refused; give it a new name (Vite does that for
# anything under src/, which is where the app images live). A new name or an identical file passes.
echo "== Check nothing changes under a name browsers keep"
# A note such as media/SOURCES.md is for people reading the folder, not something a page loads, so it may change in place.
stale=$(rsync "${rsync_opts[@]}" --dry-run dist/ "$host:$dest" | grep -E '^<fc[^ ]* (assets|media|fonts)/' | grep -v '\.md$' || true)
if [ -n "$stale" ]; then
  echo "deploy.sh: these files changed under names browsers hold for a year; rename them instead:" >&2
  echo "$stale" >&2
  exit 1
fi

if $dry_run; then
  echo "== What the upload would change on $host:$dest"
  rsync "${rsync_opts[@]}" --dry-run dist/ "$host:$dest"
  exit 0
fi

echo "== Upload to $host:$dest"
rsync "${rsync_opts[@]}" dist/ "$host:$dest"

# The address the page was built for, from its own canonical link.
site="$(sed -n 's/.*<link rel="canonical" href="\([^"]*\)".*/\1/p' dist/index.html | head -1)"
echo "== Check $site serves this build"
if curl -fsS --max-time 20 "$site" | cmp -s - dist/index.html; then
  echo "Live: $site is this build"
else
  echo "deploy.sh: $site does not match dist/index.html after the upload" >&2
  exit 1
fi
