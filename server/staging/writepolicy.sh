#!/bin/sh
# strfry runs this as relay.writePolicy.plugin; the plugin reads keflid's database read-only.
exec /kefli/kefli-writepolicy -db /data/keflid.db -wraps /data/wraps.db -strfry /app/strfry -config /etc/strfry.conf
