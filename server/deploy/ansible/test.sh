#!/bin/bash
# Tests the playbook without a VPS: lints it, then runs it twice against a fresh Debian 13 container with systemd (the
# second run must change nothing) and checks that the services answer through Caddy and the write policy reads
# keflid's database. The container is removed afterwards; KEEP=1 leaves it for a look inside.
#   server/deploy/ansible/test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=kefli-ansible-test
run() { KEFLI_DOCKER_SOCKET=1 "$here/run.sh" "$@"; }
box() { docker exec "$name" "$@"; }

make -s -C "$here/../../api" build
run ansible-lint --offline site.yml
run ansible-playbook --syntax-check site.yml

docker rm -f "$name" >/dev/null 2>&1 || true
[ -n "${KEEP:-}" ] || trap 'docker rm -f "$name" >/dev/null' EXIT
docker build -q -t kefli-ansible-host -f "$here/test.Dockerfile" "$here" >/dev/null
# Not --privileged: that hands the container the host's consoles, and its getty on tty1 took the desktop session down.
# SYS_ADMIN lets the image remount its own cgroup subtree for systemd; NET_ADMIN is what the firewall role needs, and
# stays inside the container's network namespace. Neither gives it any host device.
docker run -d --name "$name" --hostname kefli-test --cgroupns=private --cap-add SYS_ADMIN --cap-add NET_ADMIN \
  --security-opt apparmor=unconfined \
  --tmpfs /run --tmpfs /run/lock kefli-ansible-host >/dev/null
for _ in $(seq 60); do
  box systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || { docker logs "$name" >&2; exit 1; }
  sleep 1
done

run ansible-playbook -i inventory/test.yml site.yml
second=$(run ansible-playbook -i inventory/test.yml site.yml | tee /dev/stderr | grep -E '^kefli-test')
grep -q 'changed=0 ' <<<"$second" || { echo "the second run changed something" >&2; exit 1; }

failures=0
# Each check searches a command's captured output: grep stops at its first match, and in a pipe under pipefail
# the writer it leaves behind dies of SIGPIPE, which failed checks at random.
check() {
  if eval "$2" >/dev/null 2>&1; then echo "✓ $1"; else echo "✗ $1"; failures=$((failures + 1)); fi
}
via() { box curl -sfk --resolve "$1:443:127.0.0.1" "${@:2}"; }
check 'keflid, strfry and Caddy are running' 'box systemctl is-active keflid strfry caddy'
check 'the sweep and backup timers are on' 'box systemctl is-active relay-sweep.timer kefli-backup.timer'
check 'the mail forwarder waits for its secrets' '[ "$(box systemctl show -p ConditionResult --value kefli-mailfwd)" = no ]'
check 'defaults.json through Caddy names the operator' \
  'via api.kefli.app https://api.kefli.app/defaults.json | jq -e ".operator.relay == \"wss://relay.kefli.app\""'
check "the operator's NIP-05 through Caddy" \
  'via kefli.app "https://kefli.app/.well-known/nostr.json?name=_" | jq -e ".names._ | test(\"^[0-9a-f]{64}$\")"'
check "the relay's NIP-11 through Caddy" \
  'via relay.kefli.app -H "Accept: application/nostr+json" https://relay.kefli.app/ | jq -e ".name == \"Kefli\""'
check 'Blossom answers 404 for a blob it lacks' \
  '[ "$(box curl -sk -o /dev/null -w %{http_code} --resolve blossom.kefli.app:443:127.0.0.1 https://blossom.kefli.app/$(printf %064d 0))" = 404 ]'
box sh -c 'echo x > /var/www/kefli/downloads/t.xpi && echo x > /var/www/kefli/downloads/t.apk'
check 'downloads are served as an add-on and an Android package' \
  'grep -qi "content-type: application/x-xpinstall" <<<"$(via kefli.app -I https://kefli.app/downloads/t.xpi)" && grep -qi "content-type: application/vnd.android.package-archive" <<<"$(via kefli.app -I https://kefli.app/downloads/t.apk)"'
check 'HSTS is set' 'grep -qi strict-transport-security <<<"$(via api.kefli.app -I https://api.kefli.app/defaults.json)"'
# F49: Caddy's admin API is on a socket only caddy (and root) can open, never on localhost:2019, and reloads use it.
admin() { box runuser -u "$1" -- curl -s -m 2 -o /dev/null -w '%{http_code}' --unix-socket /run/caddy/admin.sock http://localhost/config/; }
check "Caddy's admin API isn't on localhost:2019" '! box curl -s -m 2 -o /dev/null http://localhost:2019/config/'
check 'its socket answers caddy and nobody else' \
  '[ "$(admin caddy)" = 200 ] && ! admin strfry && ! admin kefli && [ "$(box stat -c %U:%a /run/caddy/admin.sock)" = caddy:660 ]'
check 'a reload goes through the socket' 'box systemctl reload caddy'
# r5: a request whose body never finished arriving waited two minutes in keflid when no route read the body, and
# nothing bounded a request's body in Caddy. keflid now refuses such a body at once and lets the connection go (its
# guard), and Caddy, as it runs, holds every request's body on 443 to 20 minutes.
early() {
  box bash -c 'exec 3<>/dev/tcp/127.0.0.1/8447 && printf "GET /defaults.json HTTP/1.1\r\nHost: api\r\nContent-Length: 100\r\n\r\n0123456789" >&3 &&
    timeout 3 cat <&3 >/tmp/early && head -1 /tmp/early'
}
check 'keflid refuses at once a body no route reads, and lets it go' '[[ "$(early)" == "HTTP/1.1 400 Bad Request"* ]]'
check "Caddy holds a request's body to 20 minutes" \
  'jq -e "[.[] | select(.listen | index(\":443\")) | .read_timeout] == [1200000000000]" <<<"$(box runuser -u caddy -- curl -s --unix-socket /run/caddy/admin.sock http://localhost/config/apps/http/servers)"'
key=$(printf 'a%.0s' {1..64})
check 'keflictl registers a key' "box keflictl register $key"
line='{"type":"new","event":{"id":"'$(printf 'b%.0s' {1..64})'","pubkey":"%s","kind":30078,"tags":[],"content":"x","created_at":1,"sig":""},"receivedAt":1,"sourceType":"IP4","sourceInfo":"192.0.2.1"}'
policy() { printf "$line\n" "$1" | docker exec -i "$name" runuser -u strfry -- /usr/local/lib/kefli/relay-write-policy | jq -r .action; }
check 'the write policy, as strfry, accepts the registered key' '[ "$(policy $key)" = accept ]'
check 'and refuses another' '[ "$(policy $(printf "c%.0s" {1..64}))" = reject ]'
# The relay's floor: the wrapper names the disk and the floor, and with a floor above any disk's size the policy holds
# the registered key's event, rate-limited.
full() { printf "$line\n" "$1" | docker exec -i "$name" runuser -u strfry -- /usr/local/lib/kefli/kefli-writepolicy -db /var/lib/kefli/keflid.db \
  -wraps /tmp/floor-wraps.db -room /var/lib/strfry/db -min-free-mb 1000000000 | jq -r .msg; }
check "the write policy keeps the relay's floor" \
  'grep -qF -- "-room /var/lib/strfry/db -min-free-mb 2048" <<<"$(box cat /usr/local/lib/kefli/relay-write-policy)" && [[ "$(full $key)" == rate-limited:* ]]'
check 'strfry keeps no compression window per connection' 'grep -qx " *slidingWindow = false" <<<"$(box cat /etc/strfry.conf)"'
# The phone's inbox takes an answer of fewer than 500 wraps as the whole window: the configuration sets the 500 rather
# than leaving it to strfry's default, and the relay's NIP-11 shows the figure strfry read.
check 'strfry answers a filter with up to 500 events, as set' \
  'grep -qx " *maxFilterLimit = 500" <<<"$(box cat /etc/strfry.conf)" && jq -e ".limitation.max_limit == 500" <<<"$(via relay.kefli.app -H "Accept: application/nostr+json" https://relay.kefli.app/)"'
# strfry passes over a key in the wrong block without a word, and its own default is the same 500, so neither the line
# nor the relay's figure shows that strfry reads the line where it is: the deployed file, with that figure alone
# changed, run on a port and a database of its own and without the write policy, must report the new figure.
read_limit() {
  box sh -c 'install -d -o strfry -g strfry /tmp/limit/db && sed -e "s/^\( *maxFilterLimit = \)[0-9]*\$/\1499/" \
    -e "s/^\( *port = \)[0-9]*\$/\17778/" -e "s|^db = .*|db = \"/tmp/limit/db/\"|" -e "s|^\( *plugin = \).*|\1\"\"|" \
    /etc/strfry.conf > /tmp/limit/strfry.conf'
  box systemd-run -q --collect --unit=strfry-limit --uid=strfry --gid=strfry \
    /usr/local/bin/strfry --verbosity=WARNING --config=/tmp/limit/strfry.conf relay
  local got=''
  for _ in $(seq 20); do got=$(box curl -sf -H 'Accept: application/nostr+json' http://127.0.0.1:7778/) && break; sleep 0.5; done
  box systemctl stop strfry-limit
  box rm -rf /tmp/limit
  jq -r .limitation.max_limit <<<"$got"
}
check 'and strfry reads that figure where the configuration sets it' '[ "$(read_limit)" = 499 ]'
check 'the mail forwarder is held to 768 MB' '[ "$(box systemctl show -p MemoryMax --value kefli-mailfwd)" = 805306368 ]'
check 'the sweep runs' 'box systemctl start relay-sweep'
# The sweep keeps when its last full run began, and sweeps for the keys whose time came since then, less two days,
# where it swept for every key on the 60 days' list each night (F45). Counted by strfry's deletes: 120 keys removed 40
# days ago take three for their wraps and three for their events, beside the one for wraps past 30 days, on a run with
# nothing kept, and none on the next; a key removed since takes one, for its wraps.
sql() { box runuser -u kefli -- sqlite3 /var/lib/kefli/keflid.db "$1"; }
swept() { box journalctl -u relay-sweep --no-pager -o cat | grep -c 'Deleting' || true; }
deletes() { local before; before=$(swept); box systemctl start relay-sweep; sleep 1; echo $(( $(swept) - before )); }
sql "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
  INSERT INTO gone(pubkey, at) SELECT printf('%064x', i), unixepoch() - 40 * 86400 FROM n"
box rm -f /var/lib/strfry/relay-sweep.last
check 'a sweep with nothing kept sweeps for every removed key' '[ "$(deletes)" = 7 ]'
check 'and keeps when it began' '(( $(box cat /var/lib/strfry/relay-sweep.last) > $(box date +%s) - 60 ))'
check 'the next sweeps for none of them again' '[ "$(deletes)" = 1 ]'
sql "INSERT INTO gone(pubkey, at) VALUES(printf('%064x', 121), unixepoch())"
check 'and one removed since has its wraps dropped' '[ "$(deletes)" = 2 ]'
# A clock put back after a sweep leaves the time it kept ahead of the keys removed since: with the last start kept six
# hours ahead, a key removed now still has its wraps dropped, beside the one removed a moment ago, in one delete.
box sh -c "echo $(( $(box date +%s) + 6 * 3600 )) > /var/lib/strfry/relay-sweep.last"
sql "INSERT INTO gone(pubkey, at) VALUES(printf('%064x', 122), unixepoch())"
check 'and so does one removed after the clock was put back' '[ "$(deletes)" = 2 ]'
check 'the access log holds no address' '! box grep -q 127.0.0.1 /var/log/caddy/access.log'
# F6: a WebSocket connection to the relay, and a request with a query to a stopped upstream (Caddy's error log), leave
# no address, query or key in the journal, which keeps seven days
# (HTTP/1.1: a WebSocket upgrade can't ride HTTP/2). The journal's own listen addresses and Caddy's admin reloads
# aren't clients, so the checks look for what a client leaves: strfry's connection lines, and an address or
# query in Caddy's request logs.
via relay.kefli.app --http1.1 --max-time 2 -o /dev/null -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://relay.kefli.app/ || true
box systemctl stop keflid
via api.kefli.app -o /dev/null 'https://api.kefli.app/defaults.json?probe=kefli-secret-query' || true
box systemctl start keflid
check "the journal holds no relay connection's address or key" \
  '! grep -qiE "connect from|authed as" <<<"$(box journalctl -u strfry --no-pager)"'
check "the journal holds no request's address or query" \
  '! grep -qE "remote_ip|client_ip|kefli-secret-query" <<<"$(grep -E "\"logger\":\"http\.log" <<<"$(box journalctl -u caddy --no-pager)")"'
check 'the journal keeps seven days' 'grep -qx "MaxRetentionSec=7day" <<<"$(box cat /etc/systemd/journald.conf.d/10-kefli.conf)"'
check 'SSH takes keys only' 'grep -qx "passwordauthentication no" <<<"$(box sshd -T)"'
check 'the firewall is loaded' 'grep -qF 198.51.100.7 <<<"$(box nft list set inet filter ssh_allow4)"'
# The firewall's limit on web connections one client holds: from outside the container, at its bridge address (the
# rules let loopback through first), 520 connections at once open 512 and the rest are reset, and once they are let go
# a request from outside is answered.
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
held() {
  local open=0 fds=() fd
  for _ in $(seq "$1"); do
    if exec {fd}<>"/dev/tcp/$ip/443"; then fds+=("$fd"); open=$((open + 1)); fi
  done 2>/dev/null
  for fd in "${fds[@]}"; do exec {fd}>&-; done
  echo "$open"
}
check 'one client holds at most 512 web connections at once' '[ "$(held 520)" = 512 ]'
check 'and a request from outside is answered once they are let go' \
  'sleep 1; curl -sfk --max-time 5 --resolve "api.kefli.app:443:$ip" https://api.kefli.app/defaults.json'

echo "${failures} failed"
exit $((failures > 0))
