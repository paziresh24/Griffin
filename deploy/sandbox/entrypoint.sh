#!/bin/sh
# Keys live in /keys (host dir): the host key, and a client key only the broker uses to log in.
set -e
mkdir -p /keys /root/.ssh
[ -f /keys/host_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f /keys/host_ed25519
[ -f /keys/client ] || ssh-keygen -q -t ed25519 -N '' -C griffin-broker -f /keys/client
chown "${BROKER_UID:-1000}" /keys/client && chmod 600 /keys/client
install -m 600 /keys/client.pub /root/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e -p 2222 -h /keys/host_ed25519 \
  -o PasswordAuthentication=no -o PermitRootLogin=prohibit-password -o AllowTcpForwarding=no
