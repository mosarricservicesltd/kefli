#!/bin/sh
# keflictl on the box: runs as keflid's user against its database, so `sudo keflictl disable <pubkey>` is all it takes.
exec runuser -u kefli -- /usr/local/lib/kefli/keflictl -db /var/lib/kefli/keflid.db "$@"
