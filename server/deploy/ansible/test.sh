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
key=$(printf 'a%.0s' {1..64})
check 'keflictl registers a key' "box keflictl register $key"
line='{"type":"new","event":{"id":"'$(printf 'b%.0s' {1..64})'","pubkey":"%s","kind":30078,"tags":[],"content":"x","created_at":1,"sig":""},"receivedAt":1,"sourceType":"IP4","sourceInfo":"192.0.2.1"}'
policy() { printf "$line\n" "$1" | docker exec -i "$name" runuser -u strfry -- /usr/local/lib/kefli/relay-write-policy | jq -r .action; }
check 'the write policy, as strfry, accepts the registered key' '[ "$(policy $key)" = accept ]'
check 'and refuses another' '[ "$(policy $(printf "c%.0s" {1..64}))" = reject ]'
check 'the sweep runs' 'box systemctl start relay-sweep'
check 'the access log holds no address' '! box grep -q 127.0.0.1 /var/log/caddy/access.log'
# F6: a WebSocket connection to the relay, and a request with a query to a stopped upstream (Caddy's error log), leave
# no address, query or key in the journal, which keeps seven days
# (HTTP/1.1: a WebSocket upgrade can't ride HTTP/2). The journal's own listen addresses and Caddy's admin reloads on
# localhost aren't clients, so the checks look for what a client leaves: strfry's connection lines, and an address or
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

echo "${failures} failed"
exit $((failures > 0))
