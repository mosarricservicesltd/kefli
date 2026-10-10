# A stand-in for a fresh Debian 13 VPS, with systemd as its init, for test.sh.
FROM debian:trixie
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus python3 ca-certificates sudo \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty@.service serial-getty@.service console-getty.service getty.target systemd-sysctl.service
STOPSIGNAL SIGRTMIN+3
# Docker mounts the cgroup tree read-only outside --privileged; with a private cgroup namespace this makes only the
# container's own subtree writable, which systemd needs to start.
CMD ["sh", "-c", "mount -o remount,rw /sys/fs/cgroup && exec /sbin/init"]
