#!/bin/bash
# Builds the Go binaries and runs the Ansible playbook (ansible/site.yml) against the operator VPS in
# ansible/inventory/production.yml. Arguments go to ansible-playbook:
#   server/deploy/deploy.sh                    everything: the host, keflid, the relay, Caddy and backups
#   server/deploy/deploy.sh --tags deploy      keflid, the relay's write policy and sweep, and the configuration only
#   server/deploy/deploy.sh --check --diff     what a run would change, changing nothing
# Running it again is safe. It needs only Docker here and SSH to the host.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
make -C "$here/../api" build
exec "$here/ansible/run.sh" ansible-playbook site.yml "$@"
