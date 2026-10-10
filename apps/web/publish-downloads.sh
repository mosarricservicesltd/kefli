#!/usr/bin/env bash
# Puts release files in /var/www/kefli/downloads on the operator's host, where Caddy serves them as
# https://kefli.app/downloads/ (server/deploy/README.md, "Caddy"). Each file goes up under its own, versioned name and
# under the stable name the website links to, so a link never changes and every release stays downloadable. A Firefox
# .xpi also writes firefox-updates.json, from which installed copies update themselves.
#
#   apps/web/publish-downloads.sh --apk apps/mobile/dist/kefli-0.0.1.apk
#   apps/web/publish-downloads.sh --chrome kefli-chrome-0.1.0.zip --firefox kefli-firefox-0.1.0.xpi
#   apps/web/publish-downloads.sh --dry-run --apk …     list what would change
#
# KEFLI_SSH_HOST picks the host (default: the `kefli` alias in ~/.ssh/config). Nothing on the host is deleted.
set -euo pipefail

host="${KEFLI_SSH_HOST:-kefli}"
dest="/var/www/kefli/downloads"
declare -A stable=([--apk]=kefli.apk [--chrome]=kefli-chrome.zip [--firefox]=kefli-firefox.xpi)
dry=()
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# The manifest a self-hosted Firefox add-on checks for updates (its update_url, apps/extension/build.mjs).
firefox_updates() {
  local m id version
  m=$(unzip -p "$1" manifest.json)
  id=$(jq -r .browser_specific_settings.gecko.id <<<"$m")
  version=$(jq -r .version <<<"$m")
  jq -n --arg id "$id" --arg v "$version" --arg link "https://kefli.app/downloads/$(basename "$1")" \
    --arg hash "sha256:$(sha256sum < "$1" | cut -d' ' -f1)" \
    '{addons: {($id): {updates: [{version: $v, update_link: $link, update_hash: $hash}]}}}' > "$stage/firefox-updates.json"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=(--dry-run); shift ;;
    --apk|--chrome|--firefox)
      [ -f "${2:-}" ] || { echo "publish-downloads.sh: $1 needs a file" >&2; exit 2; }
      cp "$2" "$stage/$(basename "$2")"
      cp "$2" "$stage/${stable[$1]}"
      [ "$1" = --firefox ] && firefox_updates "$2"
      shift 2 ;;
    *) echo "publish-downloads.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$(ls -A "$stage")" ] || { echo "publish-downloads.sh: nothing to publish" >&2; exit 2; }

rsync -rlcz --itemize-changes --chmod=F644 "${dry[@]}" "$stage/" "$host:$dest/"
[ ${#dry[@]} -gt 0 ] && exit 0
for f in "$stage"/*; do
  name=$(basename "$f")
  got=$(curl -sfL "https://kefli.app/downloads/$name" | sha256sum | cut -d' ' -f1)
  [ "$got" = "$(sha256sum < "$f" | cut -d' ' -f1)" ] || { echo "https://kefli.app/downloads/$name doesn't match" >&2; exit 1; }
  echo "https://kefli.app/downloads/$name  sha256 $got"
done
