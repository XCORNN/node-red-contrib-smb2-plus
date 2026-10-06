#!/usr/bin/env bash
# Creates a local Samba server for the integration tests (Debian/Ubuntu, needs root).
#   share:  \\127.0.0.1\TestShare  ->  /srv/smb-test
#   user:   testuser / Test-Passw0rd
# Usage: sudo bash test/setup-samba.sh
set -euo pipefail

SHARE_DIR="${SMB_TEST_ROOT:-/srv/smb-test}"
SMB_USER="${SMB_TEST_USER:-testuser}"
SMB_PASS="${SMB_TEST_PASS:-Test-Passw0rd}"
# files written through Samba belong to this local user, so the tests can verify and clean them
FORCE_USER="${SMB_FORCE_USER:-${SUDO_USER:-root}}"

if ! command -v smbd >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba >/dev/null
fi

mkdir -p "$SHARE_DIR"
chown "$FORCE_USER" "$SHARE_DIR"
chmod 0777 "$SHARE_DIR"
id "$SMB_USER" >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin "$SMB_USER"

cat > /etc/samba/smb.conf <<CONF
[global]
  workgroup = WORKGROUP
  server role = standalone server
  server min protocol = SMB2_02
  map to guest = never
  log file = /var/log/samba/%m.log
  deadtime = 0
[TestShare]
  path = $SHARE_DIR
  read only = no
  valid users = $SMB_USER
  force user = $FORCE_USER
CONF

printf '%s\n%s\n' "$SMB_PASS" "$SMB_PASS" | smbpasswd -s -a "$SMB_USER" >/dev/null

# (re)start smbd, with or without systemd
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    systemctl restart smbd
else
    pkill -x smbd 2>/dev/null || true
    sleep 1
    smbd -D
fi

for i in $(seq 1 20); do
    (exec 3<>/dev/tcp/127.0.0.1/445) 2>/dev/null && { echo "Samba ready: \\\\127.0.0.1\\TestShare -> $SHARE_DIR"; exit 0; }
    sleep 0.5
done
echo "Samba did not start" >&2
exit 1
