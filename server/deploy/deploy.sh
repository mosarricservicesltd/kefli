#!/bin/bash
# Puts keflid, the mail forwarder, the relay's write policy and sweep, and the Caddy and strfry configuration from this
# directory onto the operator VPS, then restarts them. Run from anywhere: server/deploy/deploy.sh. It builds the Go binaries first
# (make -C server/api build) and needs the `kefli` host in ~/.ssh/config. Running it again is safe.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
api="$here/../api"
host=${KEFLI_HOST:-kefli}

make -C "$api" build
stage=$(ssh "$host" mktemp -d)
scp -q "$api"/bin/{keflid,keflictl,kefli-writepolicy,kefli-mailfwd} \
    "$here"/kefli/{keflid.service,keflid.env,keflictl.sh,defaults.json,kefli-mailfwd.service,kefli-mailfwd.env} \
    "$here"/strfry/{strfry.conf,strfry.service,relay-write-policy,relay-sweep,relay-sweep.service,relay-sweep.timer} \
    "$here"/caddy/Caddyfile "$host:$stage/"

ssh "$host" sudo bash -s "$stage" <<'REMOTE'
set -euo pipefail
cd "$1"
python3 -m json.tool defaults.json >/dev/null
caddy validate --config Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "the Caddyfile doesn't validate" >&2; exit 1; }
# Validating as root opens the access log as root; give it back to Caddy.
chown -R caddy:caddy /var/log/caddy

getent passwd kefli >/dev/null || useradd --system --home-dir /var/lib/kefli --no-create-home --shell /usr/sbin/nologin kefli
id -nG strfry | grep -qw kefli || usermod -aG kefli strfry

install -d -m 755 /usr/local/lib/kefli /etc/kefli
install -m 755 keflid /usr/local/bin/keflid
install -m 755 kefli-mailfwd /usr/local/bin/kefli-mailfwd
install -m 755 keflictl kefli-writepolicy relay-write-policy relay-sweep /usr/local/lib/kefli/
install -m 755 keflictl.sh /usr/local/bin/keflictl
install -m 644 keflid.env defaults.json kefli-mailfwd.env /etc/kefli/
install -m 644 strfry.conf /etc/strfry.conf
install -m 644 keflid.service kefli-mailfwd.service strfry.service relay-sweep.service relay-sweep.timer /etc/systemd/system/
install -m 644 Caddyfile /etc/caddy/Caddyfile
rm -f /etc/kefli/relay-allowlist   # the stand-in policy's list, which keflid's database replaces

systemctl daemon-reload
systemctl enable --now keflid relay-sweep.timer
systemctl restart keflid
# The forwarder starts only once its Resend secrets are on the box (the unit's ConditionPathExists).
systemctl enable kefli-mailfwd && systemctl restart kefli-mailfwd
# The write policy opens keflid's database, so strfry starts once keflid has made it.
for _ in $(seq 20); do [ -e /var/lib/kefli/keflid.db ] && break; sleep 0.5; done
systemctl restart strfry
systemctl reload caddy
cd / && rm -rf "$1"
systemctl --no-pager --lines=0 status keflid strfry caddy | grep -E '^●|Active:'
REMOTE
