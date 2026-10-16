#!/usr/bin/env bash
# Publishes a Kefli release to Zapstore in two phases, following the 0.0.5 and 0.0.7 runs (reference memory, 11 and
# 13 October 2026): zsp builds the events for the Kefli account unsigned, every file goes to Zapstore's Blossom server
# under a kind 24242 Amber signs through the repository's bunker connection, and Amber then signs the events, which
# go to wss://relay.zapstore.dev. The app event (kind 32267) goes too, since the screenshots changed; it names the
# icon and screenshots by the addresses the server gives back, which re-encodes images to a new hash.
#
#   apps/mobile/scripts/zapstore-publish.sh prepare <channel>   zsp, the uploads, the events fixed up; nothing published
#   apps/mobile/scripts/zapstore-publish.sh publish             signs the prepared events and sends them
#
# Open Amber in the foreground on the phone first: a bunker request it doesn't see times out silently. Never run this
# with a placeholder value: a signed event with a wrong address is published for good. Work files go to
# apps/mobile/dist/zap<version>/.
set -euo pipefail
cd "$(dirname "$0")/../../.."
npub=npub1gltmgu8m23txy5sxragwgek7wv4shvgxnezy4zw3npc98sgey3dsfwgf2r
pk=47d7b470fb54566252061f50e466de732b0bb1069e444a89d1987053c119245b
relay=wss://relay.zapstore.dev
cdn=https://cdn.zapstore.dev
version=$(node -p "require('./apps/mobile/app.json').expo.version")
work="apps/mobile/dist/zap${version//./}"
phase=${1:-}

sign() { # signs the event JSON on stdin through the bunker; prints the signed event, or nothing if Amber didn't answer
  NOSTR_SECRET_KEY="$(git config nostr.bunker-uri)" NOSTR_CLIENT_KEY="$(git config nostr.bunker-app-key)" nak event "$@" 2>/dev/null
}

case "$phase" in
prepare)
  channel=${2:?usage: prepare <main|beta>}
  mkdir -p "$work"
  apk=$(grep -o 'release_source: .*' zapstore.yaml | cut -d' ' -f2)
  [ -f "$apk" ] || { echo "no APK at $apk (zapstore.yaml release_source)" >&2; exit 1; }
  echo "Release $version from $apk, channel $channel, work files in $work"

  # 1. zsp builds the events unsigned and lists every file to upload (stderr), the app event included.
  SIGN_WITH=$npub zsp publish zapstore.yaml --offline --channel "$channel" -q --skip-preview > "$work/unsigned.jsonl" 2> "$work/zsp.err" || true
  grep -c '"kind"' "$work/unsigned.jsonl" | xargs -I{} echo "{} unsigned events"
  grep -E '"kind":(32267|3063|30063)' "$work/unsigned.jsonl" >/dev/null || { echo "zsp made no events; see $work/zsp.err" >&2; exit 1; }

  # 2. Every file zsp names goes to the Blossom server, each under its own kind 24242 (one Amber approval each unless
  #    Amber auto-approves them), skipped when the server already holds the hash. The reply's sha256 and url are kept:
  #    images come back re-encoded under a new hash.
  : > "$work/uploads.tsv"
  grep -E '^\s+Path:' "$work/zsp.err" | awk '{print $2}' | while read -r f; do
    sha=$(sha256sum "$f" | cut -d' ' -f1)
    if [ "$(curl -s -o /dev/null -w '%{http_code}' -I "$cdn/$sha")" = 200 ]; then
      echo "  held already: $(basename "$f")"; printf '%s\t%s\t%s\n' "$sha" "$sha" "$cdn/$sha" >> "$work/uploads.tsv"; continue
    fi
    exp=$(( $(date +%s) + 3600 ))
    auth=$(sign -k 24242 -c "upload $(basename "$f")" -t t=upload -t "x=$sha" -t "expiration=$exp")
    [ -n "$auth" ] || { echo "Amber didn't answer for $(basename "$f"); run prepare again" >&2; exit 1; }
    reply=$(curl -sS -X PUT "$cdn/upload" -H "Authorization: Nostr $(printf '%s' "$auth" | base64 -w0)" \
      -H "Content-Digest: $sha" -H "Content-Type: $(file -b --mime-type "$f")" --data-binary "@$f")
    got=$(printf '%s' "$reply" | jq -r '.sha256 // empty'); url=$(printf '%s' "$reply" | jq -r '.url // empty')
    [ -n "$got" ] || { echo "upload of $(basename "$f") failed: $reply" >&2; exit 1; }
    echo "  uploaded: $(basename "$f") → $got"
    printf '%s\t%s\t%s\n' "$sha" "$got" "$url" >> "$work/uploads.tsv"
  done

  # 3. The events as they will be signed: 3063 unchanged (its id must stay, 30063 names it); 30063 with the a tag that
  #    links the release to the app's page; 32267 with each image address replaced by the server's.
  python3 - "$work" "$pk" <<'PYEOF'
import json, sys
work, pk = sys.argv[1], sys.argv[2]
ups = {}
for line in open(f"{work}/uploads.tsv"):
    local, got, url = line.rstrip("\n").split("\t"); ups[local] = (got, url)
events = [json.loads(l) for l in open(f"{work}/unsigned.jsonl") if l.strip() and l.strip() != "null"]
out = {}
for e in events:
    e.pop("id", None); e.pop("sig", None)
    if e["kind"] == 30063 and not any(t[0] == "a" for t in e["tags"]):
        e["tags"].append(["a", f"32267:{pk}:app.kefli"])
    if e["kind"] == 32267:
        for t in e["tags"]:
            if t[0] in ("icon", "image") and len(t) > 1:
                sha = t[1].rsplit("/", 1)[-1].split(".")[0]
                if sha in ups: t[1] = ups[sha][1]
    out[e["kind"]] = e
for kind in (3063, 30063, 32267):
    if kind in out:
        json.dump(out[kind], open(f"{work}/{kind}.json", "w"), separators=(",", ":"))
        print(f"  {kind}.json ready: {len(out[kind]['tags'])} tags")
    else:
        print(f"  no kind {kind} from zsp")
PYEOF
  echo "Prepared. Read $work/32267.json, 3063.json and 30063.json, then run: $0 publish"
  ;;
publish)
  for k in 3063 30063 32267; do [ -f "$work/$k.json" ] || { echo "no $work/$k.json: run prepare first" >&2; exit 1; }; done
  # 3063 first, since 30063's e tag names its id, which signing unchanged keeps; then 30063; then the app event.
  for k in 3063 30063 32267; do
    signed=$(sign "$relay" < "$work/$k.json")
    [ -n "$signed" ] || { echo "Amber didn't answer for kind $k; run publish again (events already sent stay sent)" >&2; exit 1; }
    printf '%s\n' "$signed" > "$work/$k.signed.json"
    echo "  kind $k signed and sent: $(printf '%s' "$signed" | jq -r .id | cut -c1-12)…"
  done
  echo "Published. Check: https://zapstore.dev/apps/app.kefli"
  ;;
*) echo "usage: $0 prepare <main|beta> | publish" >&2; exit 2 ;;
esac
