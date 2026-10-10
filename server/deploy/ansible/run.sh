#!/bin/bash
# Runs a command in the Ansible image as the calling user, with the repository and ~/.ssh at the same paths as on this
# machine, so the inventory's host names and keys work as they do for ssh here. Used by deploy.sh and test.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
docker build -q -t kefli-ansible "$here" >/dev/null
args=(--rm -i --network host --user "$(id -u):$(id -g)" -e HOME="$HOME" -v /etc/passwd:/etc/passwd:ro
      -v "$repo:$repo" -w "$here")
[ -t 0 ] && args+=(-t)
[ -d "$HOME/.ssh" ] && args+=(-v "$HOME/.ssh:$HOME/.ssh:ro")
[ -n "${SSH_AUTH_SOCK:-}" ] && args+=(-v "$SSH_AUTH_SOCK:/ssh-agent" -e SSH_AUTH_SOCK=/ssh-agent)
[ -n "${KEFLI_DOCKER_SOCKET:-}" ] && args+=(-v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)")
exec docker run "${args[@]}" kefli-ansible "$@"
