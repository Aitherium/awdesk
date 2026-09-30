#!/bin/sh
# awdesk-awnix-open.sh -- what the Start-menu / taskbar launcher runs (via wslg.exe).
# Ensures the unit is up, then asks the running desk to show a surface. A second
# Electron process hands its argv to the first through the single-instance lock and
# quits, so this never leaves a stray desk outside systemd.
#   $1 (optional): --fleet | --console | --overlay | --desktop | --command
set -eu
systemctl start aither-awdesk.service
i=0
until systemctl is-active --quiet aither-awdesk.service; do
    i=$((i + 1)); [ "$i" -ge 30 ] && { echo "aither-awdesk.service did not start" >&2; exit 1; }
    sleep 1
done
sleep 2
exec /bin/sh /opt/aitheros/awdesk/scripts/awnix/awdesk-awnix-launch.sh "${1:---fleet}"
